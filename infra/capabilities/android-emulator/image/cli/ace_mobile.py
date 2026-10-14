#!/usr/bin/env python3
"""ace-mobile: the CLI on ACE's android-emulator capability machine.

canopy-web runs it over SSM (`POST /api/capabilities/leases/{id}/exec`, argv[0]
must be `ace-mobile`). It is the port of ace-web's
``apps/mobile/controller.py`` shell builders: the same adb / Maestro / aapt
invocations, run locally beside the emulator instead of composed into SSM
command strings by a web process.

Contract, every subcommand:
  * prints EXACTLY ONE JSON object on stdout, as one line: ``{"ok": bool, ...}``.
    Everything else (progress, subprocess chatter) goes to stderr.
  * exits 0 when ``ok`` is true, 1 when the operation ran and failed, 2 on a
    usage error. A failure carries ``error`` (a stable kebab-case code) and
    ``message`` (human-readable).
  * writes artifacts under ``--out s3://...`` when the subcommand produces any.

The second entry point, ``boot_main``, is the image's boot hook
(``/usr/local/sbin/ace-capability-boot``): it reads the lease's user-data,
arms the max-lifetime halt, cold-boots the AVD for ``params.state`` and writes
``s3://<bucket>/vm/<aws:userid>/ready.json``, where ``aws:userid`` is
``<instance-role-id>:<instance-id>``: the only prefix the stack's instance role
may write under ``vm/`` (canopy's template; the broker reads it there via the
stack's ``InstanceRoleId`` output). It is deliberately NOT a
subcommand, so canopy-web's exec allowlist cannot reach it.

Python 3 stdlib only; the awscli v2 binary does the S3 transfers.
"""
from __future__ import annotations

import argparse
import base64
import datetime as _dt
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

CLI_VERSION = "1.0.0"

# ── In-VM paths. Must agree with image/scripts/* and image/files/*. ──────────
ANDROID_SDK_ROOT = "/opt/android-sdk"
ADB = f"{ANDROID_SDK_ROOT}/platform-tools/adb"
MAESTRO = "/usr/local/bin/maestro"
AAPT = "/usr/local/bin/aapt"
# The Maestro client jar bundles the on-device driver APKs. Pinned to where
# image/scripts/30-maestro.sh unzips the distribution; a glob fallback covers a
# Maestro release that renames the jar.
MAESTRO_JAR_PATH = "/opt/maestro/maestro/lib/maestro-client.jar"
MAESTRO_LIB_DIR = "/opt/maestro/maestro/lib"
MAESTRO_DRIVER_CACHE_ROOT = "/var/cache/ace-mobile/driver-apks"
STATES_YAML_PATH = "/opt/ace/states.yaml"
RUN_DIR = "/run/ace-mobile"
READY_MARKER = f"{RUN_DIR}/ready"
ACTIVE_STATE_PATH = f"{RUN_DIR}/active-state"
REQUESTED_STATE_PATH = f"{RUN_DIR}/requested-state"
LAUNCH_TIMINGS_PATH = f"{RUN_DIR}/launch-timings"
LEASE_PATH = f"{RUN_DIR}/lease.json"
RUNNER_UNIT = "ace-mobile-runner.service"
RUNNER_LOG = "/var/log/ace-mobile/runner.log"
EMULATOR_LOG = "/var/log/ace-mobile/emulator.log"
WORK_ROOT = "/var/tmp/ace-mobile"
DEVICE_USER = "ubuntu"
# The UI dump path the LOCAL backend verified live: on API 34 Pixel AVDs the
# shell user cannot read back /sdcard/ (FUSE), /data/local/tmp/ works
# (turmeric-20260429-2330; mcp/mobile/backends/avd.ts captureUiDump).
UI_DUMP_DEVICE_PATH = "/data/local/tmp/window_dump.xml"

# Per-call timeouts, carried over from controller.py's SSM classes.
PROBE_TIMEOUT_S = 30
OP_TIMEOUT_S = 300
RECIPE_TIMEOUT_S = 1800

# What a result JSON may inline. SSM shows only the first 24,000 characters of
# stdout inline, so canopy-web's `stdout_tail` can be cut; the full stdout is at
# its `stdout_url`, and run-recipe also writes result.json under --out.
LOG_TAIL_CHARS = 8000

# Defaults mirror mcp/mobile/backends/avd.ts DEFAULT_MOCK_LOCATION.
DEFAULT_ALTITUDE = 480.0
DEFAULT_SATELLITES = 12

PACKAGE_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_.]*$")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
RECIPE_BASENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.ya?ml$")
DIGITS_RE = re.compile(r"^[0-9]+$")
E164_RE = re.compile(r"^\+[0-9]+$")


class CliError(Exception):
    """An operation failure: becomes ``{"ok": false, "error": code, ...}``."""

    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra


class UsageError(Exception):
    """Bad arguments: exit 2."""


# ── Host: the one seam tests replace ────────────────────────────────────────


@dataclass
class Proc:
    code: int
    stdout: Any  # str, or bytes when binary=True
    stderr: str
    timed_out: bool = False


class Host:
    """Runs processes and touches the filesystem/clock. Tests subclass it."""

    def run(
        self,
        argv: list[str],
        *,
        timeout: float = OP_TIMEOUT_S,
        as_device_user: bool = True,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        binary: bool = False,
        input_bytes: bytes | None = None,
    ) -> Proc:
        full = list(argv)
        if as_device_user and os.geteuid() == 0 and _user_exists(DEVICE_USER):
            # SSM runs as root. adb's console auth token, Maestro's ~/.maestro
            # and the adb server all belong to `ubuntu`, which runs the emulator.
            extra_env = [f"{k}={v}" for k, v in (env or {}).items()]
            full = [
                "sudo", "-u", DEVICE_USER, "-H", "--", "env",
                f"ANDROID_SDK_ROOT={ANDROID_SDK_ROOT}",
                f"ANDROID_HOME={ANDROID_SDK_ROOT}",
                f"PATH={_device_path()}",
                *extra_env,
                *argv,
            ]
            run_env = None
        else:
            run_env = {**os.environ, **(env or {})}
        try:
            cp = subprocess.run(
                full,
                cwd=cwd,
                env=run_env,
                input=input_bytes,
                capture_output=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            out = e.stdout or b""
            err = e.stderr or b""
            return Proc(
                124,
                out if binary else _dec(out),
                _dec(err),
                timed_out=True,
            )
        except FileNotFoundError as e:
            return Proc(127, b"" if binary else "", str(e))
        return Proc(
            cp.returncode,
            cp.stdout if binary else _dec(cp.stdout),
            _dec(cp.stderr),
        )

    def now(self) -> float:
        return time.time()

    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, s: float) -> None:
        time.sleep(s)

    def chown_tree(self, path: str) -> None:
        if os.geteuid() != 0 or not _user_exists(DEVICE_USER):
            return
        pw = pwd.getpwnam(DEVICE_USER)
        for root, dirs, files in os.walk(path):
            os.chown(root, pw.pw_uid, pw.pw_gid)
            for n in dirs + files:
                try:
                    os.chown(os.path.join(root, n), pw.pw_uid, pw.pw_gid, follow_symlinks=False)
                except OSError:
                    pass

    def http_get(self, url: str, dest: str, timeout: float = OP_TIMEOUT_S) -> None:
        with urllib.request.urlopen(url, timeout=timeout) as r, open(dest, "wb") as f:  # noqa: S310 (https checked by caller)
            shutil.copyfileobj(r, f)


def _dec(b: bytes | None) -> str:
    return (b or b"").decode("utf-8", errors="replace")


def _user_exists(name: str) -> bool:
    try:
        pwd.getpwnam(name)
        return True
    except KeyError:
        return False


def _device_path() -> str:
    return (
        "/usr/local/bin:/usr/bin:/bin:"
        f"{ANDROID_SDK_ROOT}/platform-tools:{ANDROID_SDK_ROOT}/emulator:"
        f"{ANDROID_SDK_ROOT}/cmdline-tools/latest/bin"
    )


def _iso_now(host: Host) -> str:
    return _dt.datetime.fromtimestamp(host.now(), tz=_dt.timezone.utc).isoformat()


def _tail(text: str, n: int = LOG_TAIL_CHARS) -> str:
    text = text or ""
    return text if len(text) <= n else text[-n:]


# ── S3 helpers (awscli; the instance role supplies credentials) ─────────────


def parse_s3_uri(uri: str, *, what: str = "--out") -> tuple[str, str]:
    m = re.match(r"^s3://([a-z0-9][a-z0-9.\-]{1,61}[a-z0-9])(?:/(.*))?$", uri or "")
    if not m:
        raise UsageError(f"{what} must be an s3://bucket/prefix URI, got {uri!r}")
    return m.group(1), (m.group(2) or "").strip("/")


def join_s3(uri: str, *parts: str) -> str:
    base = uri.rstrip("/")
    rest = "/".join(p.strip("/") for p in parts if p)
    return f"{base}/{rest}" if rest else base


def s3_get(host: Host, uri: str, dest: str) -> None:
    parse_s3_uri(uri, what="input")
    p = host.run(
        ["aws", "s3", "cp", "--only-show-errors", uri, dest],
        as_device_user=False, timeout=OP_TIMEOUT_S,
    )
    if p.code != 0:
        raise CliError("s3-download-failed", f"aws s3 cp {uri} failed: {_tail(p.stderr, 500)}")


def s3_put_file(host: Host, src: str, uri: str) -> None:
    p = host.run(
        ["aws", "s3", "cp", "--only-show-errors", src, uri],
        as_device_user=False, timeout=OP_TIMEOUT_S,
    )
    if p.code != 0:
        raise CliError("s3-upload-failed", f"aws s3 cp to {uri} failed: {_tail(p.stderr, 500)}")


def s3_put_dir(host: Host, src_dir: str, uri: str) -> None:
    p = host.run(
        ["aws", "s3", "cp", "--only-show-errors", "--recursive", src_dir, uri.rstrip("/") + "/"],
        as_device_user=False, timeout=OP_TIMEOUT_S,
    )
    if p.code != 0:
        raise CliError("s3-upload-failed", f"aws s3 cp --recursive to {uri} failed: {_tail(p.stderr, 500)}")


def fetch_input(host: Host, src: str, dest: str, *, allow_https: bool = False) -> None:
    """Fetch an s3:// (or, where allowed, https://) input to a local file."""
    if src.startswith("s3://"):
        s3_get(host, src, dest)
    elif allow_https and src.startswith("https://"):
        try:
            host.http_get(src, dest)
        except Exception as e:  # noqa: BLE001
            raise CliError("download-failed", f"GET {src} failed: {e}") from e
    else:
        allowed = "s3:// or https://" if allow_https else "s3://"
        raise UsageError(f"input must be {allowed}, got {src!r}")


# ── Content types (from controller.py, plus what the image now emits) ───────

_CONTENT_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "xml": "application/xml",
    "json": "application/json",
    "txt": "text/plain",
    "log": "text/plain",
    "yaml": "application/yaml",
    "yml": "application/yaml",
    "html": "text/html",
    "mp4": "video/mp4",
}


def guess_content_type(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return _CONTENT_TYPES.get(ext, "application/octet-stream")


def list_artifacts(local_dir: str, out_uri: str) -> list[dict[str, Any]]:
    """Every file under ``local_dir`` as the artifact rows run-recipe reports.

    ``name`` is the basename (what ace-web's ``Artifact.name`` was, and what
    cloud.ts saves the file as); ``key`` is the path relative to ``--out``,
    which is what canopy-web's ``/artifacts?prefix=`` lists.
    """
    rows: list[dict[str, Any]] = []
    root = Path(local_dir)
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        rows.append(
            {
                "name": p.name,
                "key": rel,
                "uri": join_s3(out_uri, rel),
                "content_type": guess_content_type(p.name),
                "bytes": p.stat().st_size,
            }
        )
    return rows


# ── Parsers (ported from controller.py; pure, unit-tested) ──────────────────


def parse_adb_devices(text: str) -> list[dict[str, str]]:
    devices: list[dict[str, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("List of devices") or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        devices.append({"serial": parts[0], "state": parts[1]})
    return devices


def parse_states_yaml(text: str) -> dict[str, Any]:
    """Parse /opt/ace/states.yaml (written only by image/scripts/50-states.sh).

    Same hand parser as controller.py's ``_parse_states_yaml``: the file's
    shape is fixed and the image has no PyYAML.
    """
    default = ""
    states: list[dict[str, str]] = []
    current: dict[str, str] = {}

    def flush() -> None:
        nonlocal current
        if current.get("name"):
            states.append(
                {
                    "name": current.get("name", ""),
                    "snapshot": current.get("snapshot", ""),
                    "commcare_version": current.get("commcare_version", ""),
                    "apk_path": current.get("apk_path", ""),
                    "description": current.get("description", ""),
                }
            )
        current = {}

    for raw in (text or "").splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        stripped = line.lstrip()
        if line.startswith("default:"):
            default = line.split(":", 1)[1].strip().strip('"')
            continue
        if line.startswith("states:"):
            continue
        if stripped.startswith("- name:"):
            flush()
            current["name"] = stripped.split(":", 1)[1].strip().strip('"')
            continue
        if ":" in stripped and current:
            k, _, v = stripped.partition(":")
            current[k.strip()] = v.strip().strip('"')
    flush()
    return {"default": default, "states": states}


_UI_NODE_RE = re.compile(r"<node\s+([^>]*?)/?>")


def parse_ui_elements(xml: str) -> list[dict[str, str]]:
    """Same extraction as avd.ts ``parseHierarchy`` (id/text/class/bounds)."""
    out: list[dict[str, str]] = []
    for m in _UI_NODE_RE.finditer(xml or ""):
        attrs = m.group(1)

        def get(k: str) -> str | None:
            am = re.search(rf'{re.escape(k)}="([^"]*)"', attrs)
            return am.group(1) if am and am.group(1) else None

        el = {
            "id": get("resource-id"),
            "text": get("text"),
            "class": get("class"),
            "bounds": get("bounds"),
        }
        out.append({k: v for k, v in el.items() if v is not None})
    return out


def detect_ui_dump_failure(dump_code: int, dump_out: str, cat_out: str, cat_code: int) -> bool:
    """Port of avd.ts ``detectUiDumpFailure`` (ace#1155)."""
    if dump_code != 0 or cat_code != 0:
        return True
    if re.search(r"No such file or directory", cat_out or "", re.I):
        return True
    if re.search(
        r"UiAutomation\.connectWithTimeout|registerUiTestAutomationServiceLocked|ERROR:\s*could not get idle state",
        dump_out or "",
        re.I,
    ):
        return True
    return False


def console_ok(code: int, output: str) -> bool:
    """Did an ``adb emu`` console command succeed? Exit 0 is not enough.

    The console answers ``OK`` or ``KO: <reason>`` and adb exits 0 either way;
    a ``-read-only`` instance answers ``KO: Snapshot save is disabled``. Port of
    avd.ts ``snapshotSaveSucceeded`` (ace#2545), shared with ``geo fix``.
    """
    if code != 0:
        return False
    if re.search(r"^\s*KO\b", output or "", re.M):
        return False
    return not re.search(r"error", output or "", re.I)


def parse_aapt_badging(text: str) -> dict[str, Any]:
    m = re.search(
        r"package: name='([^']*)'(?:\s+versionCode='([^']*)')?(?:\s+versionName='([^']*)')?",
        text or "",
    )
    if not m:
        return {"package_name": "", "version": "", "version_code": 0}
    try:
        code = int(m.group(2) or 0)
    except ValueError:
        code = 0
    return {"package_name": m.group(1), "version": m.group(3) or "", "version_code": code}


# Maestro statuses → the normalized set cloud.ts accepts (pass|fail|skipped|
# unknown). Anything else is 'unknown', so a new Maestro status cannot crash a
# parse. WARNED (an `optional: true` command that failed) is left 'unknown', as
# controller.py left it.
_STEP_STATUS_MAP = {
    "COMPLETED": "pass",
    "PASS": "pass",
    "PASSED": "pass",
    "SUCCESS": "pass",
    "OK": "pass",
    "FAILED": "fail",
    "FAIL": "fail",
    "ERROR": "fail",
    "SKIPPED": "skipped",
    "SKIP": "skipped",
    "PENDING": "skipped",
}

_LABEL_KEYS = ("text", "textRegex", "id", "idRegex", "name", "label", "value", "path", "appId", "code")


def _find_label_arg(arg: Any, depth: int = 0) -> str | None:
    if isinstance(arg, str):
        return arg
    if not isinstance(arg, dict) or depth > 2:
        return None
    for k in _LABEL_KEYS:
        v = arg.get(k)
        if isinstance(v, str) and v:
            return v
    # Real Maestro 2.x nests the target: tapOnElement.selector.idRegex,
    # assertConditionCommand.condition.visible.idRegex.
    for k in ("selector", "condition", "visible", "notVisible"):
        found = _find_label_arg(arg.get(k), depth + 1)
        if found:
            return found
    return None


def maestro_command_label(command: Any) -> str | None:
    if not isinstance(command, dict) or not command:
        return None
    action = next(iter(command.keys()), None)
    if not action:
        return None
    found = _find_label_arg(command[action])
    return f"{action}: {found}" if found else action


def lift_maestro_steps(data: Any) -> list[dict[str, Any]]:
    """Maestro's ``commands-*.json`` → step rows (cloud.ts ``CloudStep``).

    Accepts a top-level list or a flow object with ``commands``. Real Maestro
    2.x output (test/fixtures in this dir are recorded runs) puts ``status``,
    ``duration`` and ``error`` under ``metadata`` and does NOT write the list in
    execution order, so rows are sorted by ``metadata.sequenceNumber`` when
    every row has one. A ``takeScreenshotCommand`` row reports its evaluated
    path as ``<path>.png``, the file Maestro wrote.
    """
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict) and isinstance(data.get("commands"), list):
        items = data["commands"]
    else:
        return []
    items = [it for it in items if isinstance(it, dict)]

    def seq(it: dict) -> Any:
        meta = it.get("metadata")
        return meta.get("sequenceNumber") if isinstance(meta, dict) else None

    if items and all(isinstance(seq(it), int) for it in items):
        items = sorted(items, key=seq)

    out: list[dict[str, Any]] = []
    for i, item in enumerate(items):
        meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        status_raw = item.get("status") or meta.get("status")
        status = _STEP_STATUS_MAP.get(str(status_raw or "").upper(), "unknown")
        command = item.get("command")
        name = maestro_command_label(command)
        duration = meta.get("duration") or meta.get("durationMs") or item.get("duration")
        try:
            duration_ms = int(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration_ms = None
        screenshot = item.get("screenshot") or meta.get("screenshot")
        if not isinstance(screenshot, str):
            screenshot = _screenshot_from_command(meta.get("evaluatedCommand") or command)
        error = item.get("error") or meta.get("error")
        if isinstance(error, dict):
            error = error.get("message") or json.dumps({k: v for k, v in error.items() if k != "hierarchyRoot"})
        out.append(
            {
                "index": i,
                "name": name or f"step-{i}",
                "status": status,
                "screenshot": screenshot if isinstance(screenshot, str) else None,
                "error": error if isinstance(error, str) else None,
                "duration_ms": duration_ms,
            }
        )
    return out


def _screenshot_from_command(command: Any) -> str | None:
    if not isinstance(command, dict):
        return None
    shot = command.get("takeScreenshotCommand")
    if isinstance(shot, dict) and isinstance(shot.get("path"), str) and "${" not in shot["path"]:
        p = shot["path"]
        return p if p.lower().endswith(".png") else f"{p}.png"
    return None


def find_commands_json(run_dir: str) -> Path | None:
    root = Path(run_dir)
    top = sorted(root.glob("commands-*.json"))
    if top:
        return top[0]
    nested = sorted(root.rglob("commands-*.json"))
    return nested[0] if nested else None


def parse_steps_from_dir(run_dir: str) -> list[dict[str, Any]]:
    p = find_commands_json(run_dir)
    if p is None:
        return []
    try:
        return lift_maestro_steps(json.loads(p.read_text(encoding="utf-8", errors="replace")))
    except (OSError, json.JSONDecodeError):
        return []


# ── Shared device helpers ────────────────────────────────────────────────────


def adb(host: Host, *args: str, timeout: float = OP_TIMEOUT_S, binary: bool = False) -> Proc:
    return host.run([ADB, *args], timeout=timeout, binary=binary)


def read_file(path: str) -> str | None:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def tail_lines(path: str, n: int = 30) -> str:
    text = read_file(path)
    if text is None:
        return f"(no {os.path.basename(path)})"
    return "\n".join(text.splitlines()[-n:])


def require_device(host: Host) -> None:
    p = adb(host, "devices", timeout=PROBE_TIMEOUT_S)
    devices = parse_adb_devices(p.stdout)
    if not any(d["state"] == "device" for d in devices):
        raise CliError(
            "no-device",
            "no emulator in 'device' state on the adb server (the AVD is not booted, "
            "or it died). Run `ace-mobile diagnose`; a sick lease is released, not repaired.",
            adb_devices=devices,
        )


def _mkdtemp(prefix: str) -> str:
    os.makedirs(WORK_ROOT, exist_ok=True)
    return tempfile.mkdtemp(prefix=f"{prefix}-", dir=WORK_ROOT)


def make_work_dir(host: Host, prefix: str) -> str:
    d = _mkdtemp(prefix)
    os.chmod(d, 0o755)
    host.chown_tree(d)
    return d


def safe_extract_tar(archive: str, dest: str) -> None:
    """Extract a tar.gz palette without letting a member escape ``dest``."""
    try:
        with tarfile.open(archive, "r:*") as tf:
            try:
                tf.extractall(dest, filter="data")  # type: ignore[call-arg]
            except TypeError:  # Python without PEP 706 filters
                base = os.path.realpath(dest)
                for m in tf.getmembers():
                    target = os.path.realpath(os.path.join(dest, m.name))
                    if not (target == base or target.startswith(base + os.sep)) or m.issym() or m.islnk():
                        raise CliError("bad-palette", f"palette member escapes the run dir: {m.name!r}")
                tf.extractall(dest)
    except (tarfile.TarError, OSError) as e:
        raise CliError("bad-palette", f"could not extract palette: {e}") from e


def maestro_test(
    host: Host, run_dir: str, recipe_path: str, env: dict[str, str], timeout: float
) -> Proc:
    argv = [MAESTRO, "test", "--debug-output", run_dir]
    for k, v in env.items():
        argv += ["--env", f"{k}={v}"]
    argv.append(recipe_path)
    return host.run(argv, cwd=run_dir, timeout=timeout)


def parse_env_pairs(pairs: list[str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for pair in pairs or []:
        k, sep, v = pair.partition("=")
        if not sep or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k):
            raise UsageError(f"--env must be KEY=VALUE with a shell-identifier KEY, got {pair!r}")
        env[k] = v
    return env


# ── Subcommands ──────────────────────────────────────────────────────────────


def cmd_diagnose(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    """Read-only snapshot. Field names are ace-web's ``Diagnostics`` dataclass
    (cloud.ts ``CloudDiagnostics``), plus the lease/state facts the machine now
    knows. ``ok`` reports that the probe ran; ``healthy`` is the verdict."""
    devices_p = adb(host, "devices", timeout=PROBE_TIMEOUT_S)
    devices = parse_adb_devices(devices_p.stdout) if devices_p.code == 0 else []
    proc = host.run(["pgrep", "-af", "qemu-system-x86_64|emulator -avd"], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    emu_pid, emu_cmd = None, None
    first = next((ln for ln in (proc.stdout or "").splitlines() if ln.strip()), "")
    parts = first.strip().split(None, 1)
    if parts and parts[0].isdigit():
        emu_pid = int(parts[0])
        emu_cmd = parts[1] if len(parts) > 1 else ""
    svc = host.run(["systemctl", "is-active", RUNNER_UNIT], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    runner_state = (svc.stdout or "").strip() or "unknown"
    marker_present = os.path.exists(READY_MARKER)
    marker_age = None
    if marker_present:
        try:
            marker_age = max(0, int(host.now() - os.stat(READY_MARKER).st_mtime))
        except OSError:
            marker_age = None
    emulator_log_tail = tail_lines(EMULATOR_LOG)
    kvm_dev = os.path.exists("/dev/kvm")
    nested = (read_file("/sys/module/kvm_intel/parameters/nested")
              or read_file("/sys/module/kvm_amd/parameters/nested") or "unknown").strip()
    if "requires hardware acceleration" in emulator_log_tail.lower():
        accel = "tcg"
    else:
        accel = "kvm" if kvm_dev else "tcg"
    visible = sum(1 for d in devices if d["state"] == "device")
    states = parse_states_yaml(read_file(STATES_YAML_PATH) or "")
    lease = None
    lease_text = read_file(LEASE_PATH)
    if lease_text:
        try:
            raw = json.loads(lease_text)
            lease = {"lease_id": raw.get("lease_id"), "state": raw.get("state")}
        except json.JSONDecodeError:
            lease = None
    return {
        "ok": True,
        "healthy": visible > 0 and marker_present,
        # ssm_ok/ssm_error kept so the payload stays a CloudDiagnostics: the
        # probe itself is local now, so it is always "reachable".
        "ssm_ok": True,
        "ssm_error": None,
        "adb_devices": devices,
        "adb_visible_count": visible,
        "emulator_pid": emu_pid,
        "emulator_cmdline": emu_cmd,
        "runner_service_state": runner_state,
        "marker_present": marker_present,
        "marker_age_seconds": marker_age,
        "runner_log_tail": tail_lines(RUNNER_LOG),
        "emulator_log_tail": emulator_log_tail,
        "kvm_dev_present": kvm_dev,
        "kvm_nested": nested,
        "accel": accel,
        "active_state": (read_file(ACTIVE_STATE_PATH) or "").strip() or None,
        "states": states,
        "lease": lease,
        "cli_version": CLI_VERSION,
    }


def cmd_run_recipe(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    out_uri = args.out
    parse_s3_uri(out_uri)
    env = parse_env_pairs(args.env)
    require_device(host)
    run_dir = make_work_dir(host, "run")
    scratch = _mkdtemp("scratch")
    t0 = host.monotonic()
    try:
        if args.palette:
            pal = os.path.join(scratch, "palette.tar.gz")
            fetch_input(host, args.palette, pal)
            safe_extract_tar(pal, run_dir)
        # The recipe lives INSIDE run_dir so `runFlow: file: "./x.yaml"`
        # resolves to the extracted palette siblings (controller.py run_recipe).
        recipe_path = os.path.join(run_dir, f"recipe-{uuid.uuid4().hex[:12]}.yaml")
        fetch_input(host, args.recipe, recipe_path)
        host.chown_tree(run_dir)

        proc = maestro_test(host, run_dir, recipe_path, env, args.timeout_s)
        steps = parse_steps_from_dir(run_dir)
        Path(run_dir, "maestro-stdout.log").write_text(proc.stdout or "", encoding="utf-8")
        Path(run_dir, "maestro-stderr.log").write_text(proc.stderr or "", encoding="utf-8")
        artifacts = list_artifacts(run_dir, out_uri)
        s3_put_dir(host, run_dir, out_uri)
        exit_code = proc.code
        result: dict[str, Any] = {
            "ok": exit_code == 0,
            "exit_code": exit_code,
            "stdout": _tail(proc.stdout),
            "stderr": _tail(proc.stderr),
            "steps": steps,
            "artifacts": artifacts,
            "out": out_uri,
            "result_uri": join_s3(out_uri, "result.json"),
            "duration_s": round(host.monotonic() - t0, 1),
        }
        if proc.timed_out:
            result.update(error="recipe-timeout", message=f"maestro exceeded --timeout-s {args.timeout_s}")
        elif exit_code != 0:
            result.update(error="recipe-failed", message=f"maestro exited {exit_code}")
        res_file = os.path.join(scratch, "result.json")
        Path(res_file).write_text(json.dumps(result), encoding="utf-8")
        s3_put_file(host, res_file, result["result_uri"])
        return result
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


def _register_creds(host: Host, args: argparse.Namespace) -> dict[str, str]:
    creds: dict[str, str] = {}
    if args.creds:
        d = _mkdtemp("creds")
        local = os.path.join(d, "creds.json")
        try:
            fetch_input(host, args.creds, local)
            creds = {k: str(v) for k, v in json.loads(Path(local).read_text()).items()}
        except json.JSONDecodeError as e:
            raise UsageError(f"--creds is not JSON: {e}") from e
        finally:
            shutil.rmtree(d, ignore_errors=True)
    for k in ("phone", "phone_local", "country_code", "pin", "backup_code", "name"):
        v = getattr(args, k)
        if v is not None:
            creds[k] = v
    missing = [k for k in ("phone", "phone_local", "country_code", "pin", "backup_code", "name") if not creds.get(k)]
    if missing:
        raise UsageError("register-test-user needs " + ", ".join(f"--{m.replace('_', '-')}" for m in missing)
                         + " (flags, or keys in --creds)")
    # Same validation as ace-web's RegisterTestUserIn.
    if not E164_RE.match(creds["phone"]):
        raise UsageError(f"phone must look like '+<digits>'; got {creds['phone']!r}")
    if not DIGITS_RE.match(creds["phone_local"]):
        raise UsageError("phone_local must be digits only")
    if not E164_RE.match(creds["country_code"]):
        raise UsageError("country_code must look like '+N..'")
    if not DIGITS_RE.match(creds["pin"]) or not DIGITS_RE.match(creds["backup_code"]):
        raise UsageError("pin/backup_code must be digits")
    return creds


def _set_gms_enabled(host: Host, enabled: bool) -> None:
    # Best-effort, as controller.py: a stale GMS state surfaces as a Maestro
    # selector miss in the next recipe, not a silent corruption.
    if enabled:
        adb(host, "shell", "pm", "enable", "com.google.android.gms", timeout=PROBE_TIMEOUT_S)
    else:
        adb(host, "shell", "pm", "disable-user", "--user", "0", "com.google.android.gms", timeout=PROBE_TIMEOUT_S)


def cmd_register_test_user(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    """Port of controller.py ``register_test_user``: Part A with GMS enabled,
    Part B with GMS disabled (face capture then falls back to ManualMode).
    ``PHONE_ALREADY_REGISTERED`` in either part short-circuits."""
    for r in (args.to_otp_recipe, args.from_otp_recipe):
        if not RECIPE_BASENAME_RE.match(r):
            raise UsageError(f"recipe filename must be a basename matching [A-Za-z0-9._-]+\\.ya?ml (got {r!r})")
    if args.out:
        parse_s3_uri(args.out)
    creds = _register_creds(host, args)
    require_device(host)
    run_dir = make_work_dir(host, "register")
    scratch = _mkdtemp("scratch")
    parts: list[dict[str, Any]] = []
    try:
        pal = os.path.join(scratch, "palette.tar.gz")
        fetch_input(host, args.palette, pal)
        safe_extract_tar(pal, run_dir)
        host.chown_tree(run_dir)
        for r in (args.to_otp_recipe, args.from_otp_recipe):
            if not os.path.isfile(os.path.join(run_dir, r)):
                raise CliError("recipe-missing", f"{r} is not in the palette")

        def part(label: str, recipe: str, env: dict[str, str]) -> Proc:
            p = maestro_test(host, run_dir, os.path.join(run_dir, recipe), env, args.timeout_s)
            parts.append({"part": label, "recipe": recipe, "exit_code": p.code,
                          "stdout": _tail(p.stdout, 2000), "stderr": _tail(p.stderr, 2000)})
            return p

        def finish(result: dict[str, Any]) -> dict[str, Any]:
            result["parts"] = parts
            if args.out:
                Path(run_dir, "register-parts.json").write_text(json.dumps(parts), encoding="utf-8")
                s3_put_dir(host, run_dir, args.out)
                result["out"] = args.out
            return result

        _set_gms_enabled(host, True)
        a = part("a", args.to_otp_recipe, {
            "PHONE_LOCAL": creds["phone_local"], "COUNTRY_CODE": creds["country_code"], "PIN": creds["pin"],
        })
        if "PHONE_ALREADY_REGISTERED" in (a.stdout or ""):
            return finish({"ok": True, "already_registered": True, "phone": creds["phone"], "backup_code": None})
        if a.code != 0:
            raise CliError("register-part-a-failed",
                           f"register part A failed (exit {a.code}): {_tail(a.stderr or a.stdout, 500)}",
                           **finish({}))
        _set_gms_enabled(host, False)
        b = part("b", args.from_otp_recipe, {
            "NAME": creds["name"], "BACKUP_CODE": creds["backup_code"], "PIN": creds["pin"],
        })
        if "PHONE_ALREADY_REGISTERED" in (b.stdout or ""):
            return finish({"ok": True, "already_registered": True, "phone": creds["phone"], "backup_code": None})
        if b.code != 0:
            raise CliError("register-part-b-failed",
                           f"register part B failed (exit {b.code}): {_tail(b.stderr or b.stdout, 500)}",
                           **finish({}))
        return finish({"ok": True, "already_registered": False, "phone": creds["phone"],
                       "backup_code": creds["backup_code"]})
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


def cmd_ui_dump(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    if args.out:
        parse_s3_uri(args.out)
    require_device(host)
    dump = adb(host, "shell", "uiautomator", "dump", UI_DUMP_DEVICE_PATH)
    cat = adb(host, "exec-out", "cat", UI_DUMP_DEVICE_PATH)
    failed = detect_ui_dump_failure(dump.code, f"{dump.stdout}\n{dump.stderr}", f"{cat.stdout}\n{cat.stderr}", cat.code)
    xml = "" if failed else (cat.stdout or "")
    result: dict[str, Any] = {"ok": not failed, "xml": xml, "elements": parse_ui_elements(xml), "failed": failed}
    if args.out and xml:
        d = _mkdtemp("uidump")
        try:
            name = args.name or "ui-dump.xml"
            Path(d, name).write_text(xml, encoding="utf-8")
            uri = join_s3(args.out, name)
            s3_put_file(host, os.path.join(d, name), uri)
            result["uri"] = uri
        finally:
            shutil.rmtree(d, ignore_errors=True)
    if failed:
        result.update(error="ui-dump-failed",
                      message=_tail(f"{dump.stdout}\n{dump.stderr}\n{cat.stderr}".strip(), 500))
    return result


def cmd_screenshot(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    parse_s3_uri(args.out)
    name = args.name or (
        _dt.datetime.fromtimestamp(host.now(), tz=_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + f"-{uuid.uuid4().hex[:8]}.png"
    )
    if not NAME_RE.match(name):
        raise UsageError(f"--name must match {NAME_RE.pattern}")
    require_device(host)
    p = adb(host, "exec-out", "screencap", "-p", binary=True)
    png = p.stdout or b""
    if p.code != 0 or not png.startswith(b"\x89PNG"):
        raise CliError("screenshot-failed", f"screencap failed (exit {p.code}): {_tail(p.stderr, 300)}")
    d = _mkdtemp("screen")
    try:
        local = os.path.join(d, name)
        Path(local).write_bytes(png)
        uri = join_s3(args.out, name)
        s3_put_file(host, local, uri)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "name": name, "uri": uri, "content_type": "image/png", "bytes": len(png)}


def cmd_install_apk(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    if not (args.apk.startswith("s3://") or args.apk.startswith("https://")):
        raise UsageError(f"--apk must be s3:// or https://, got {args.apk!r}")
    require_device(host)
    d = make_work_dir(host, "apk")
    try:
        local = os.path.join(d, "install.apk")
        fetch_input(host, args.apk, local, allow_https=True)
        os.chmod(local, 0o644)
        p = adb(host, "install", "-r", local)
        if p.code != 0 or "Success" not in f"{p.stdout}\n{p.stderr}":
            raise CliError("install-failed", f"adb install failed (exit {p.code}): {_tail(p.stdout + p.stderr, 500)}")
        badging = host.run([AAPT, "dump", "badging", local], as_device_user=False, timeout=PROBE_TIMEOUT_S)
        info = parse_aapt_badging(badging.stdout)
        return {"ok": True, **info}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def cmd_clear_app_data(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    if not PACKAGE_RE.match(args.package):
        raise UsageError(f"--package must match {PACKAGE_RE.pattern} (got {args.package!r})")
    require_device(host)
    p = adb(host, "shell", "pm", "clear", args.package, timeout=PROBE_TIMEOUT_S)
    # `pm clear` prints Success or Failed and exits 0 either way; a package that
    # is not installed is cleared=false, not an error (controller.py semantics).
    return {"ok": True, "package": args.package, "cleared": "Success" in (p.stdout or "")}


MAESTRO_PACKAGES = ("dev.mobile.maestro", "dev.mobile.maestro.test")


def cmd_repair_driver(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    """``pm uninstall -k --user 0`` both Maestro halves: the ``--user 0`` form
    clears wedged instrumentation a plain uninstall does not reach
    (turmeric/20260513-2243; MaestroBackend.repairDriver)."""
    require_device(host)
    removed = []
    for pkg in MAESTRO_PACKAGES:
        p = adb(host, "shell", "pm", "uninstall", "-k", "--user", "0", pkg, timeout=PROBE_TIMEOUT_S)
        if "Success" in f"{p.stdout}\n{p.stderr}":
            removed.append(pkg)
    return {"ok": True, "uninstalled_packages": removed}


def _maestro_packages_present(host: Host) -> tuple[bool, bool]:
    p = adb(host, "shell", "pm", "list", "packages", "dev.mobile.maestro", timeout=PROBE_TIMEOUT_S)
    lines = {ln.strip() for ln in (p.stdout or "").splitlines()}
    return "package:dev.mobile.maestro" in lines, "package:dev.mobile.maestro.test" in lines


def _maestro_jar() -> str | None:
    if os.path.isfile(MAESTRO_JAR_PATH):
        return MAESTRO_JAR_PATH
    hits = sorted(Path(MAESTRO_LIB_DIR).glob("maestro-client*.jar")) if os.path.isdir(MAESTRO_LIB_DIR) else []
    return str(hits[0]) if hits else None


def cmd_install_driver(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    """Port of controller.py ``install_driver`` (local twin:
    MaestroBackend.ensureDriverInstalled, b2838cb). Maestro's own driver push
    races the early-boot ``pm`` service on a fresh AVD with no retry."""
    require_device(host)
    actions: list[str] = []
    has_app, has_test = _maestro_packages_present(host)
    if has_app and has_test:
        return {"ok": True, "actions": ["already-installed"]}
    deadline = host.monotonic() + 30
    while host.monotonic() < deadline:
        p = adb(host, "shell", "cmd", "package", "list", "packages", timeout=PROBE_TIMEOUT_S)
        if any(ln.startswith("package:") for ln in (p.stdout or "").splitlines()):
            break
        host.sleep(1)
    actions.append("pm-ready")
    jar = _maestro_jar()
    if not jar:
        raise CliError("maestro-jar-missing", f"no Maestro client jar at {MAESTRO_JAR_PATH}", actions=actions)
    st = os.stat(jar)
    cache = os.path.join(MAESTRO_DRIVER_CACHE_ROOT, f"{st.st_size}-{int(st.st_mtime)}")
    os.makedirs(cache, exist_ok=True)
    app_apk, test_apk = os.path.join(cache, "maestro-app.apk"), os.path.join(cache, "maestro-server.apk")
    if not (os.path.isfile(app_apk) and os.path.isfile(test_apk)):
        try:
            with zipfile.ZipFile(jar) as z:
                for n in ("maestro-app.apk", "maestro-server.apk"):
                    with z.open(n) as src, open(os.path.join(cache, n), "wb") as dst:
                        shutil.copyfileobj(src, dst)
        except (KeyError, zipfile.BadZipFile, OSError) as e:
            raise CliError("maestro-driver-extract-failed", f"could not extract driver APKs from {jar}: {e}",
                           actions=actions) from e
        for n in (app_apk, test_apk):
            os.chmod(n, 0o644)
    os.chmod(cache, 0o755)
    actions.append("extracted")
    for apk, tag in ((app_apk, "installed:app"), (test_apk, "installed:test")):
        p = adb(host, "install", "-r", apk)
        if p.code != 0:
            raise CliError("maestro-driver-install-failed",
                           f"adb install {os.path.basename(apk)} failed: {_tail(p.stdout + p.stderr, 300)}",
                           actions=actions)
        actions.append(tag)
    has_app, has_test = _maestro_packages_present(host)
    if not (has_app and has_test):
        raise CliError("maestro-driver-verify-failed", "driver packages not present after install", actions=actions)
    actions.append("verified")
    return {"ok": True, "actions": actions}


def cmd_snapshot(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    if not NAME_RE.match(args.name):
        raise UsageError(f"--name must match {NAME_RE.pattern}")
    require_device(host)
    p = adb(host, "emu", "avd", "snapshot", args.action, args.name)
    output = f"{p.stdout}{p.stderr}".strip()
    ok = console_ok(p.code, output)
    stamp_key = "saved_at" if args.action == "save" else "loaded_at"
    result: dict[str, Any] = {"ok": ok, "name": args.name, "action": args.action, "output": output,
                              stamp_key: _iso_now(host) if ok else None}
    if not ok:
        result.update(error=f"snapshot-{args.action}-failed", message=output or f"adb exited {p.code}")
    return result


def cmd_set_location(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    """New: ``adb emu geo fix <lon> <lat> <alt> <sats>``, LONGITUDE FIRST
    (emulator console order; avd.ts setLocation). Possible now that the CLI
    runs beside the emulator."""
    if not -180 <= args.lon <= 180:
        raise UsageError("--lon must be in [-180, 180]")
    if not -90 <= args.lat <= 90:
        raise UsageError("--lat must be in [-90, 90]")
    if not 0 <= args.sats <= 64:
        raise UsageError("--sats must be in [0, 64]")
    require_device(host)
    p = adb(host, "emu", "geo", "fix", _num(args.lon), _num(args.lat), _num(args.alt), str(args.sats),
            timeout=PROBE_TIMEOUT_S)
    output = f"{p.stdout}{p.stderr}".strip()
    applied = console_ok(p.code, output)
    result: dict[str, Any] = {"ok": applied, "longitude": args.lon, "latitude": args.lat, "altitude": args.alt,
                              "satellites": args.sats, "applied": applied, "output": output}
    if not applied:
        result.update(error="geo-fix-failed", message=output or f"adb exited {p.code}")
    return result


def _num(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else repr(float(x))


# ── argparse that answers in JSON ────────────────────────────────────────────


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        raise UsageError(message)


def build_parser() -> argparse.ArgumentParser:
    ap = _Parser(prog="ace-mobile", description="Drive the Android emulator on this capability machine.")
    ap.add_argument("--version", action="store_true", help="print {ok, cli_version} and exit")
    sub = ap.add_subparsers(dest="cmd", parser_class=_Parser)

    sub.add_parser("diagnose", help="read-only snapshot of the emulator runtime")

    rr = sub.add_parser("run-recipe", help="run a Maestro recipe; artifacts to --out")
    rr.add_argument("--recipe", required=True, help="s3:// URI of the top recipe YAML")
    rr.add_argument("--palette", help="s3:// URI of a tar.gz of sibling palette recipes")
    rr.add_argument("--env", action="append", default=[], metavar="K=V")
    rr.add_argument("--out", required=True, help="s3:// prefix for artifacts")
    rr.add_argument("--timeout-s", type=float, default=RECIPE_TIMEOUT_S)

    rt = sub.add_parser("register-test-user", help="register the Connect demo user (two recipes)")
    rt.add_argument("--palette", required=True, help="s3:// tar.gz holding both register recipes")
    rt.add_argument("--to-otp-recipe", required=True)
    rt.add_argument("--from-otp-recipe", required=True)
    rt.add_argument("--creds", help="s3:// JSON with any of phone, phone_local, country_code, pin, backup_code, name")
    for flag in ("--phone", "--phone-local", "--country-code", "--pin", "--backup-code", "--name"):
        rt.add_argument(flag)
    rt.add_argument("--out", help="s3:// prefix for the two parts' debug output")
    rt.add_argument("--timeout-s", type=float, default=RECIPE_TIMEOUT_S)

    ud = sub.add_parser("ui-dump", help="uiautomator hierarchy (inline + optional --out)")
    ud.add_argument("--out")
    ud.add_argument("--name", help="file name under --out (default ui-dump.xml)")

    sc = sub.add_parser("screenshot", help="screencap to --out")
    sc.add_argument("--out", required=True)
    sc.add_argument("--name", help="file name (default <utc-ts>-<id>.png)")

    ia = sub.add_parser("install-apk", help="adb install -r an APK from s3:// or https://")
    ia.add_argument("--apk", required=True)

    ca = sub.add_parser("clear-app-data", help="adb shell pm clear <package>")
    ca.add_argument("--package", default="org.commcare.dalvik")

    sub.add_parser("repair-driver", help="uninstall wedged Maestro driver packages")
    sub.add_parser("install-driver", help="install the Maestro driver APKs idempotently")

    sn = sub.add_parser("snapshot", help="emulator snapshot save|load")
    sn.add_argument("action", choices=["save", "load"])
    sn.add_argument("--name", required=True)

    sl = sub.add_parser("set-location", help="adb emu geo fix (longitude first)")
    sl.add_argument("--lon", type=float, required=True)
    sl.add_argument("--lat", type=float, required=True)
    sl.add_argument("--alt", type=float, default=DEFAULT_ALTITUDE)
    sl.add_argument("--sats", type=int, default=DEFAULT_SATELLITES)
    return ap


COMMANDS: dict[str, Callable[[Host, argparse.Namespace], dict[str, Any]]] = {
    "diagnose": cmd_diagnose,
    "run-recipe": cmd_run_recipe,
    "register-test-user": cmd_register_test_user,
    "ui-dump": cmd_ui_dump,
    "screenshot": cmd_screenshot,
    "install-apk": cmd_install_apk,
    "clear-app-data": cmd_clear_app_data,
    "repair-driver": cmd_repair_driver,
    "install-driver": cmd_install_driver,
    "snapshot": cmd_snapshot,
    "set-location": cmd_set_location,
}


def run_cli(argv: list[str], host: Host | None = None) -> tuple[int, dict[str, Any]]:
    host = host or Host()
    try:
        args = build_parser().parse_args(argv)
        if args.version:
            return 0, {"ok": True, "cli_version": CLI_VERSION}
        if not args.cmd:
            raise UsageError("a subcommand is required: " + ", ".join(COMMANDS))
        result = COMMANDS[args.cmd](host, args)
    except UsageError as e:
        return 2, {"ok": False, "error": "usage", "message": str(e), "cli_version": CLI_VERSION}
    except CliError as e:
        return 1, {**e.extra, "ok": False, "error": e.code, "message": e.message}
    except Exception as e:  # noqa: BLE001 — the one-JSON-line contract holds even for a bug
        return 1, {"ok": False, "error": "internal", "message": f"{type(e).__name__}: {e}"}
    return (0 if result.get("ok") else 1), result


def _default_region_from_lease() -> None:
    """awscli needs a region; the boot hook recorded the instance's."""
    if os.environ.get("AWS_DEFAULT_REGION") or os.environ.get("AWS_REGION"):
        return
    try:
        region = json.loads(read_file(LEASE_PATH) or "{}").get("region")
    except json.JSONDecodeError:
        region = None
    if region:
        os.environ["AWS_DEFAULT_REGION"] = region


def main(argv: list[str] | None = None) -> int:
    _default_region_from_lease()
    code, payload = run_cli(sys.argv[1:] if argv is None else argv)
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), default=str) + "\n")
    sys.stdout.flush()
    return code


# ── Boot hook ────────────────────────────────────────────────────────────────

IMDS = "http://169.254.169.254"
DEFAULT_MAX_LIFETIME_S = 14400  # the manifest's max_lease_s, if user-data omits it
READY_TIMEOUT_S = 900  # the manifest's ready_timeout_s, counted from instance boot
READY_MARGIN_S = 30


class Imds:
    """IMDSv2 (the stack's launch template sets HttpTokens: required)."""

    def __init__(self, base: str = IMDS) -> None:
        self.base = base
        self._token: str | None = None

    def _token_value(self) -> str:
        if self._token is None:
            req = urllib.request.Request(
                f"{self.base}/latest/api/token", method="PUT",
                headers={"X-aws-ec2-metadata-token-ttl-seconds": "21600"},
            )
            with urllib.request.urlopen(req, timeout=5) as r:  # noqa: S310
                self._token = r.read().decode()
        return self._token

    def get(self, path: str) -> str | None:
        req = urllib.request.Request(f"{self.base}/latest/{path}",
                                     headers={"X-aws-ec2-metadata-token": self._token_value()})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:  # noqa: S310
                return r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise


@dataclass
class BootContext:
    instance_id: str
    region: str
    user_data: dict[str, Any] = field(default_factory=dict)
    user_data_error: str | None = None
    uptime_s: float = 0.0


def parse_user_data(raw: str | None) -> tuple[dict[str, Any], str | None]:
    if not raw or not raw.strip():
        return {}, "no user-data: this machine was not launched for a lease"
    text = raw.strip()
    if not text.startswith("{"):
        try:  # tolerate a base64 layer
            text = base64.b64decode(text, validate=True).decode()
        except Exception:  # noqa: BLE001
            return {}, "user-data is not JSON"
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return {}, f"user-data is not JSON: {e}"
    if not isinstance(data, dict):
        return {}, "user-data JSON is not an object"
    return data, None


def plan_boot(ctx: BootContext, states: dict[str, Any], kvm_present: bool) -> dict[str, Any]:
    """Pure decision for the boot hook: what to halt at, what to boot, or why not."""
    ud = ctx.user_data
    try:
        max_lifetime = int(ud.get("max_lifetime_s") or DEFAULT_MAX_LIFETIME_S)
    except (TypeError, ValueError):
        max_lifetime = DEFAULT_MAX_LIFETIME_S
    # max_lifetime_s is the lease's whole life; the hook starts after boot, so
    # arm only what is left of it (never less than a minute).
    halt_in = max(60, int(max_lifetime - ctx.uptime_s))
    plan: dict[str, Any] = {"halt_in_s": halt_in, "bucket": ud.get("bucket"), "lease_id": ud.get("lease_id")}
    if ctx.user_data_error:
        plan["fail"] = ("bad-user-data", ctx.user_data_error)
        return plan
    if not ud.get("bucket"):
        plan["fail"] = ("bad-user-data", "user-data has no bucket")
        return plan
    params = ud.get("params") if isinstance(ud.get("params"), dict) else {}
    names = [s["name"] for s in states.get("states", [])]
    state = params.get("state") or states.get("default")
    plan["state"] = state
    if not names:
        plan["fail"] = ("no-states", f"{STATES_YAML_PATH} lists no states; the image is broken")
    elif state not in names:
        plan["fail"] = ("unknown-state", f"state {state!r} is not baked into this image (have {names})")
    elif not kvm_present:
        plan["fail"] = ("no-kvm", "/dev/kvm is absent: the launch template must enable nested virtualization")
    return plan


def caller_userid(host: Host) -> str | None:
    """``aws:userid`` of this instance's role session: ``<role-id>:<instance-id>``.
    GetCallerIdentity needs no IAM permission."""
    for _ in range(3):
        p = host.run(["aws", "sts", "get-caller-identity", "--query", "UserId", "--output", "text"],
                     as_device_user=False, timeout=PROBE_TIMEOUT_S)
        uid = (p.stdout or "").strip()
        if p.code == 0 and ":" in uid:
            return uid
        host.sleep(2)
    return None


def ready_key(userid: str | None, instance_id: str) -> str:
    """Where ready.json goes. The instance role may write only vm/${aws:userid}/*;
    without a userid there is no key it can write, so fall back to the spec's
    vm/<instance-id>/ and let the AccessDenied say so in the boot log."""
    return f"vm/{userid or instance_id}/ready.json"


def ready_payload(ok: bool, reason: str | None, timings: dict[str, float], ctx: BootContext,
                  state: str | None, detail: str | None = None) -> dict[str, Any]:
    p: dict[str, Any] = {"ok": ok, "timings": timings, "cli_version": CLI_VERSION,
                         "instance_id": ctx.instance_id, "state": state}
    if reason:
        p["reason"] = reason
    if detail:
        p["detail"] = _tail(detail, 2000)
    return p


def _log(msg: str) -> None:
    sys.stderr.write(f"[ace-capability-boot] {msg}\n")
    sys.stderr.flush()


def boot_main() -> int:  # pragma: no cover — exercised on the machine; plan_boot is unit-tested
    host = Host()
    t_hook = time.monotonic()
    imds = Imds()
    instance_id, region = "unknown", "us-east-1"
    for attempt in range(30):
        try:
            instance_id = imds.get("meta-data/instance-id") or "unknown"
            region = imds.get("meta-data/placement/region") or region
            break
        except Exception as e:  # noqa: BLE001
            _log(f"IMDS not ready ({e}); retry {attempt + 1}")
            time.sleep(2)
    os.environ["AWS_DEFAULT_REGION"] = region
    try:
        raw_ud = imds.get("user-data")
    except Exception as e:  # noqa: BLE001
        _log(f"could not read user-data: {e}")
        raw_ud = None
    ud, ud_err = parse_user_data(raw_ud)
    uptime = float((read_file("/proc/uptime") or "0").split()[0])
    ctx = BootContext(instance_id=instance_id, region=region, user_data=ud, user_data_error=ud_err, uptime_s=uptime)
    states = parse_states_yaml(read_file(STATES_YAML_PATH) or "")
    plan = plan_boot(ctx, states, os.path.exists("/dev/kvm"))

    # 1. The halt is armed before anything that can fail. With the launch
    #    template's InstanceInitiatedShutdownBehavior=terminate, poweroff IS
    #    termination: this machine ends on its own even if canopy-web is down.
    arm = host.run(["systemd-run", f"--on-active={plan['halt_in_s']}s", "--unit=ace-max-lifetime",
                    "--description=ACE capability max lifetime", "/bin/systemctl", "poweroff"],
                   as_device_user=False, timeout=PROBE_TIMEOUT_S)
    _log(f"max-lifetime halt in {plan['halt_in_s']}s (systemd-run exit {arm.code})")

    os.makedirs(RUN_DIR, exist_ok=True)
    Path(LEASE_PATH).write_text(json.dumps({"lease_id": plan.get("lease_id"), "state": plan.get("state"),
                                            "bucket": plan.get("bucket"), "instance_id": instance_id,
                                            "region": region}))
    timings: dict[str, float] = {"uptime_at_hook_s": round(uptime, 1)}

    def publish(ok: bool, reason: str | None, detail: str | None = None) -> int:
        payload = ready_payload(ok, reason, timings, ctx, plan.get("state"), detail)
        _log(f"ready.json: {json.dumps(payload)[:500]}")
        bucket = plan.get("bucket")
        if not bucket:
            _log("no bucket in user-data; cannot publish ready.json")
            return 1
        f = os.path.join(RUN_DIR, "ready.json")
        Path(f).write_text(json.dumps(payload))
        key = ready_key(caller_userid(host), instance_id)
        for attempt in range(5):
            p = host.run(["aws", "s3", "cp", "--only-show-errors", "--content-type", "application/json", f,
                          f"s3://{bucket}/{key}"], as_device_user=False, timeout=60)
            if p.code == 0:
                return 0 if ok else 1
            _log(f"ready.json upload failed ({p.stderr.strip()[:200]}); retry {attempt + 1}")
            time.sleep(3)
        return 1

    if arm.code != 0:
        return publish(False, "halt-not-armed", arm.stderr)
    if "fail" in plan:
        code, msg = plan["fail"]
        return publish(False, code, msg)

    # 2. Cold-boot the AVD for the lease's state (ace-emulator-launch reads
    #    requested-state; it boots -wipe-data and installs that state's APK).
    Path(REQUESTED_STATE_PATH).write_text(plan["state"] + "\n")
    t_start = time.monotonic()
    host.run(["systemctl", "reset-failed", RUNNER_UNIT], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    start = host.run(["systemctl", "start", "--no-block", RUNNER_UNIT], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    if start.code != 0:
        return publish(False, "runner-start-failed", start.stderr)
    budget = max(60.0, READY_TIMEOUT_S - uptime - READY_MARGIN_S)
    deadline = t_start + budget
    while time.monotonic() < deadline:
        if os.path.exists(READY_MARKER):
            timings["runner_to_ready_s"] = round(time.monotonic() - t_start, 1)
            timings["hook_s"] = round(time.monotonic() - t_hook, 1)
            timings["boot_to_ready_s"] = round(uptime + (time.monotonic() - t_hook), 1)
            timings.update(_launch_timings())
            return publish(True, None)
        failed = host.run(["systemctl", "is-failed", RUNNER_UNIT], as_device_user=False, timeout=PROBE_TIMEOUT_S)
        if (failed.stdout or "").strip() == "failed":
            return publish(False, "emulator-boot-failed", tail_lines(RUNNER_LOG, 40))
        time.sleep(2)
    return publish(False, "emulator-ready-timeout",
                   f"no {READY_MARKER} after {int(budget)}s\n" + tail_lines(RUNNER_LOG, 40))


def _launch_timings() -> dict[str, float]:
    out: dict[str, float] = {}
    for line in (read_file(LAUNCH_TIMINGS_PATH) or "").splitlines():
        k, _, v = line.partition("=")
        try:
            out[f"launch_{k.strip()}"] = float(v)
        except ValueError:
            pass
    return out


if __name__ == "__main__":
    sys.exit(main())
