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

CLI_VERSION = "1.1.0"

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
# Written by ace-emulator-launch when the emulator dies AFTER ready. Its
# presence makes every subcommand but diagnose refuse with emulator-crashed:
# the runner unit does not restart (Restart=no), so a crash mid-lease is never
# silently papered over by a fresh -wipe-data boot.
CRASHED_MARKER = f"{RUN_DIR}/crashed"
# The idle watchdog's clock: every exec touches it; ace-idle-watchdog powers the
# machine off when it is older than the threshold the boot hook wrote to
# IDLE_CONFIG_PATH and no exec is in flight (EXEC_DIR holds one file per pid).
LAST_ACTIVITY_PATH = f"{RUN_DIR}/last-activity"
IDLE_CONFIG_PATH = f"{RUN_DIR}/idle.json"
EXEC_DIR = f"{RUN_DIR}/exec"
# apply-baseline records what it applied here; the boot hook copies it into
# ready.json so the client can assert parity with the local backend.
BASELINE_PATH = f"{RUN_DIR}/baseline.json"
# ace-emulator-launch records which boot path ran (snapshot | cold |
# cold-fallback) and why, for ready.json: {"path", "detail", "state"}.
BOOT_PATH_PATH = f"{RUN_DIR}/boot-path"
# `record start` writes the in-flight recording here; `record stop` reads it.
RECORD_STATE_PATH = f"{RUN_DIR}/record.json"
# The transient systemd unit holding the host-side `adb shell screenrecord`.
# One at a time: `record stop` interrupts the device's screenrecord by name.
RECORD_UNIT = "ace-record"
# Set by the image when it calls its own CLI (ace-emulator-launch →
# apply-baseline): not a lease exec, so it must not move the idle clock.
INTERNAL_ENV = "ACE_MOBILE_INTERNAL"
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

# Defaults mirror mcp/mobile/backends/avd.ts DEFAULT_MOCK_LOCATION
# (test/infra/android-emulator-capability.test.ts holds them equal).
DEFAULT_LONGITUDE = 8.5167
DEFAULT_LATITUDE = 12.0022
DEFAULT_ALTITUDE = 480.0
DEFAULT_SATELLITES = 12

# ── The environment baseline: the ONE place the image defines it ─────────────
#
# The local backend's AvdBackend.applyEnvironmentBaseline
# (mcp/mobile/backends/avd.ts) applies these to every AVD it heals; a lease
# machine applies the identical set, from here, in ace-emulator-launch before
# ready (`ace-mobile apply-baseline`). Each step is (fingerprint key, adb args).
# The fingerprint is avd.ts's own: sha1 of the sorted keys joined by "|", first
# 12 hex chars, so the client asserts parity by comparing two strings. The
# capability test fails CI when the keys, values or fingerprint drift from avd.ts.
BASELINE_STEPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("heads_up_notifications_enabled", ("shell", "settings", "put", "global", "heads_up_notifications_enabled", "0")),
    ("notification_disallow_dnd_gms", ("shell", "cmd", "notification", "disallow_dnd", "com.google.android.gms")),
    ("screen_off_timeout", ("shell", "settings", "put", "system", "screen_off_timeout", "1800000")),
    ("location_providers_allowed", ("shell", "settings", "put", "secure", "location_mode", "3")),
    ("location_providers_allowed", ("shell", "settings", "put", "secure", "location_providers_allowed", "+gps,+network")),
    ("mock_location_fix", ("emu", "geo", "fix", "8.5167", "12.0022", "480", "12")),
)


def baseline_fingerprint(keys: list[str] | None = None) -> str:
    """avd.ts: sha1(sorted(settingsApplied).join('|')).slice(0, 12)."""
    import hashlib

    ks = sorted(set(keys if keys is not None else [k for k, _ in BASELINE_STEPS]))
    return hashlib.sha1("|".join(ks).encode("utf-8")).hexdigest()[:12]

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


# ── What a run uploads, and what it never uploads in the clear ───────────────
#
# A Maestro run dir holds far more than a reader needs: the extracted palette
# (~20 sibling recipes), the recipe copy, and Maestro's `.maestro/tests/<ts>/`
# debug tree. Uploading all of it put ~25 files per run in the bucket and blew
# one exec's stdout to 34 KB (past SSM's 24,000-character inline limit). The
# layout under --out is now exactly:
#
#   <out>/<path>.png|.jpg|.jpeg   screenshots, at the path the recipe wrote them
#   <out>/<path>.mp4              screen recordings
#   <out>/<path>.xml              UI dumps
#   <out>/maestro-stdout.log, maestro-stderr.log
#   <out>/result.json             the full result (run-recipe)
#   <out>/register-parts.json     (register-test-user)
#   <out>/debug/                  Maestro's debug output, flattened: commands-*.json,
#                                 maestro.log, failure screenshots. Names that two
#                                 debug dirs share get a "<ts>-" prefix.
#
# Recipes (.yaml) and the palette are never uploaded: the caller already has them.
#
# Secrets: Maestro writes every `--env` value into commands-*.json
# (`defineVariablesCommand.env`) and every value it typed into the evaluated
# commands, so a PIN or backup code reached S3 in plaintext. Every uploaded text
# file, and every string the CLI prints, passes through a Redactor first.

UPLOAD_EXTS = (".png", ".jpg", ".jpeg", ".mp4", ".xml")
# Maestro's own failure/step screenshots in a --debug-output dir
# ("screenshot-❌-<ts>-(<flow>).png"): debug output, not recipe screenshots.
MAESTRO_DEBUG_SHOT_PREFIXES = ("screenshot-\u274c", "screenshot-\u2705", "screenshot-\u26a0")
UPLOAD_TEXT_NAMES = ("maestro.log", "maestro-stdout.log", "maestro-stderr.log", "result.json", "register-parts.json")
DEBUG_DIR = "debug"
REDACTED = "<redacted>"
# An --env value is treated as a secret when its KEY looks like one. Every
# value of a register-test-user credential except `name` is a secret.
SECRET_ENV_KEY_RE = re.compile(r"PIN|CODE|PASS|SECRET|TOKEN|OTP|PHONE|KEY|CRED", re.I)
MIN_SECRET_LEN = 3  # shorter values would redact half the log by accident


class Redactor:
    """Replaces known secret values, and every Maestro env value, with <redacted>."""

    def __init__(self, secrets: list[str] | None = None) -> None:
        uniq = {s for s in (secrets or []) if isinstance(s, str) and len(s) >= MIN_SECRET_LEN}
        # Longest first, so a secret that contains another is replaced whole.
        self.secrets = sorted(uniq, key=len, reverse=True)

    @classmethod
    def for_env(cls, env: dict[str, str]) -> "Redactor":
        return cls([v for k, v in env.items() if SECRET_ENV_KEY_RE.search(k)])

    def text(self, text: str) -> str:
        for s in self.secrets:
            text = text.replace(s, REDACTED)
        return text

    def obj(self, obj: Any, *, _in_define: bool = False) -> Any:
        """Redact a parsed Maestro report: ALL ``defineVariablesCommand.env``
        values whatever their key, then every known secret in every string."""
        if isinstance(obj, dict):
            out: dict[str, Any] = {}
            for k, v in obj.items():
                if _in_define and k == "env" and isinstance(v, dict):
                    out[k] = {ek: REDACTED for ek in v}
                else:
                    out[k] = self.obj(v, _in_define=_in_define or k == "defineVariablesCommand")
            return out
        if isinstance(obj, list):
            return [self.obj(v, _in_define=_in_define) for v in obj]
        if isinstance(obj, str):
            return self.text(obj)
        return obj

    def json_bytes(self, raw: bytes) -> bytes:
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return self.text(raw.decode("utf-8", errors="replace")).encode("utf-8")
        return json.dumps(self.obj(data), indent=1).encode("utf-8")


def _is_uploadable(name: str) -> bool:
    low = name.lower()
    return (
        name in UPLOAD_TEXT_NAMES
        or (name.startswith("commands-") and low.endswith(".json"))
        or low.endswith(UPLOAD_EXTS)
    )


def stage_artifacts(run_dir: str, stage_dir: str, redactor: Redactor) -> None:
    """Copy what a run uploads from ``run_dir`` into ``stage_dir`` (layout above),
    redacting every text file on the way."""
    src_root, dst_root = Path(run_dir), Path(stage_dir)
    for p in sorted(src_root.rglob("*")):
        if not p.is_file() or p.is_symlink() or not _is_uploadable(p.name):
            continue
        rel = p.relative_to(src_root)
        parts = rel.parts
        is_debug = (len(parts) >= 3 and parts[0] == ".maestro" and parts[1] == "tests") or (
            len(parts) == 1 and (p.name == "maestro.log" or p.name.startswith(("commands-", *MAESTRO_DEBUG_SHOT_PREFIXES))))
        if is_debug:
            ts = parts[2] if len(parts) >= 3 else ""
            dest = dst_root / DEBUG_DIR / Path(*parts[3:]) if len(parts) > 3 else dst_root / DEBUG_DIR / p.name
            if dest.exists() and ts:
                dest = dest.with_name(f"{ts}-{dest.name}")
        elif parts[0].startswith("."):
            continue  # some other dot-tree (Maestro caches): not an artifact
        else:
            dest = dst_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        raw = p.read_bytes()
        low = p.name.lower()
        if low.endswith(".json"):
            raw = redactor.json_bytes(raw)
        elif low.endswith((".log", ".xml")):
            raw = redactor.text(raw.decode("utf-8", errors="replace")).encode("utf-8")
        dest.write_bytes(raw)


# The budget a result line may spend on stdout before SSM cuts it (24,000
# characters inline). Over budget, the inline copy sheds detail in a fixed
# order; result.json under --out always holds the full result.
INLINE_BUDGET_CHARS = 20000
ARTIFACTS_INLINE_MAX = 25


def fit_inline(result: dict[str, Any], budget: int = INLINE_BUDGET_CHARS) -> dict[str, Any]:
    """The inline (stdout) copy of a result, shrunk to ``budget`` characters.

    Order: cap ``artifacts`` at ARTIFACTS_INLINE_MAX (``artifacts_total`` keeps
    the count), cut stdout/stderr tails to 2,000 characters, keep only the
    failing and last 20 ``steps``, then drop ``artifacts`` and ``steps`` entirely.
    Every field it shortened is listed in ``inline_truncated``."""
    out = dict(result)
    cut: list[str] = []
    arts = out.get("artifacts")
    if isinstance(arts, list):
        out["artifacts_total"] = len(arts)
        if len(arts) > ARTIFACTS_INLINE_MAX:
            out["artifacts"] = arts[:ARTIFACTS_INLINE_MAX]
            cut.append("artifacts")

    def size() -> int:
        return len(json.dumps({**out, "inline_truncated": cut}, separators=(",", ":"), default=str))

    if size() > budget:
        for k in ("stdout", "stderr"):
            if isinstance(out.get(k), str) and len(out[k]) > 2000:
                out[k] = out[k][-2000:]
                cut.append(k)
    steps = out.get("steps")
    if size() > budget and isinstance(steps, list) and len(steps) > 20:
        keep = [s for s in steps[:-20] if isinstance(s, dict) and s.get("status") == "fail"] + steps[-20:]
        out["steps"] = keep
        out["steps_total"] = len(steps)
        cut.append("steps")
    for k in ("artifacts", "steps"):
        if size() > budget and k in out:
            out[k] = []
            if k not in cut:
                cut.append(k)
    if cut:
        out["inline_truncated"] = cut
    return out


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


def parse_steps_from_dir(run_dir: str, redactor: Redactor | None = None) -> list[dict[str, Any]]:
    """Steps from the run's commands-*.json, read through ``redactor`` so a
    step named after a typed value (``inputTextCommand: <pin>``) is redacted."""
    p = find_commands_json(run_dir)
    if p is None:
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8", errors="replace"))
        return lift_maestro_steps((redactor or Redactor()).obj(data))
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
    """Read-only snapshot. Field names are the retired ace-web ``Diagnostics``
    dataclass (kept so diagnose readers did not change), plus the lease/state facts the machine now
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
    crash = read_crash_marker()
    result: dict[str, Any] = {
        "ok": True,
        "healthy": visible > 0 and marker_present and crash is None,
        # ssm_ok/ssm_error kept so the payload keeps the retired ace-web shape: the
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
        "crashed": crash is not None,
        "crash": crash,
        "baseline": _read_json(BASELINE_PATH),
        "boot_path": _read_json(BOOT_PATH_PATH),
        "recording": _read_json(RECORD_STATE_PATH),
        "cli_version": CLI_VERSION,
    }
    if crash is not None:
        # ok stays true (the probe ran) and the exit code 0; `error` names the
        # verdict so a reader that only checks `error` still sees it.
        result.update(error="emulator-crashed", message=crash_message(crash))
    return result


def _read_json(path: str) -> Any:
    text = read_file(path)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text.strip()[:500]}


def read_crash_marker() -> dict[str, Any] | None:
    """The crash record ace-emulator-launch wrote (``key=value`` lines), or None."""
    text = read_file(CRASHED_MARKER)
    if text is None:
        return None
    rec: dict[str, Any] = {}
    for line in text.splitlines():
        k, sep, v = line.partition("=")
        if sep:
            rec[k.strip()] = v.strip()
    return rec


def crash_message(crash: dict[str, Any]) -> str:
    return ("the emulator died after ready (exit {exit}, at {at}); this machine will not "
            "reboot it. Release the lease and acquire a new one.").format(
        exit=crash.get("emulator_exit", "?"), at=crash.get("at", "?"))


def cmd_apply_baseline(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    """Apply BASELINE_STEPS (the local backend's environment baseline) and sync
    the device clock to the host's. Idempotent. Writes BASELINE_PATH.

    Every step runs even when one fails; ``ok`` is true only when all did, and
    ``failed`` names the keys that did not. The clock sync is not part of the
    fingerprint (avd.ts does it separately, after a snapshot load)."""
    require_device(host)
    applied: list[dict[str, Any]] = []
    for key, argv in BASELINE_STEPS:
        p = adb(host, *argv, timeout=PROBE_TIMEOUT_S)
        out = f"{p.stdout}{p.stderr}".strip()
        ok = console_ok(p.code, out) if argv[0] == "emu" else p.code == 0 and not re.search(
            r"Exception|Error|not found|Unknown", out)
        applied.append({"key": key, "ok": ok, **({} if ok else {"output": _tail(out, 300)})})
    clock = sync_clock(host)
    failed = sorted({a["key"] for a in applied if not a["ok"]})
    record = {
        "fingerprint": baseline_fingerprint(),
        "keys": sorted({k for k, _ in BASELINE_STEPS}),
        "complete": not failed,
        "failed": failed,
        "clock_synced": clock,
        "applied_at": _iso_now(host),
    }
    try:
        os.makedirs(os.path.dirname(BASELINE_PATH), exist_ok=True)
        Path(BASELINE_PATH).write_text(json.dumps(record), encoding="utf-8")
    except OSError as e:
        _log(f"could not write {BASELINE_PATH}: {e}")
    result: dict[str, Any] = {"ok": not failed, **record, "steps": applied}
    if failed:
        result.update(error="baseline-failed", message="baseline steps failed: " + ", ".join(failed))
    return result


def sync_clock(host: Host) -> bool:
    """Set the device wall clock to the host's (UTC). A snapshot resumes with
    the clock it was saved with; a stale clock is what made a cached Connect
    token pass the device-side expiry check and 401 server-side
    (docs/learnings/2026-05-14-demo-user-no-otp.md). google_apis images ship
    `su`, so no `adb root` (which would restart adbd under Maestro)."""
    stamp = _dt.datetime.fromtimestamp(host.now(), tz=_dt.timezone.utc).strftime("%m%d%H%M%Y.%S")
    p = adb(host, "shell", "su", "0", "date", "-u", stamp, timeout=PROBE_TIMEOUT_S)
    return p.code == 0


def upload_run(host: Host, run_dir: str, scratch: str, out_uri: str, redactor: Redactor,
               extra: dict[str, bytes] | None = None) -> tuple[list[dict[str, Any]], str | None]:
    """Stage (filter + flatten + redact) and upload a run dir. Returns the
    artifact rows and, if the upload failed, its message (never raises: a
    failed upload must not discard the run's exit code and steps)."""
    stage = os.path.join(scratch, "stage")
    os.makedirs(stage, exist_ok=True)
    stage_artifacts(run_dir, stage, redactor)
    for name, body in (extra or {}).items():
        Path(stage, name).write_bytes(body)
    artifacts = list_artifacts(stage, out_uri)
    try:
        s3_put_dir(host, stage, out_uri)
    except CliError as e:
        return artifacts, e.message
    return artifacts, None


def cmd_run_recipe(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    out_uri = args.out
    parse_s3_uri(out_uri)
    env = parse_env_pairs(args.env)
    redactor = Redactor.for_env(env)
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
        stdout, stderr = redactor.text(proc.stdout or ""), redactor.text(proc.stderr or "")
        steps = parse_steps_from_dir(run_dir, redactor)
        Path(run_dir, "maestro-stdout.log").write_text(stdout, encoding="utf-8")
        Path(run_dir, "maestro-stderr.log").write_text(stderr, encoding="utf-8")
        artifacts, upload_error = upload_run(host, run_dir, scratch, out_uri, redactor)
        exit_code = proc.code
        result: dict[str, Any] = {
            "ok": exit_code == 0,
            "exit_code": exit_code,
            "stdout": _tail(stdout),
            "stderr": _tail(stderr),
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
        if upload_error is None:
            Path(res_file).write_text(json.dumps(result), encoding="utf-8")
            try:
                s3_put_file(host, res_file, result["result_uri"])
            except CliError as e:
                upload_error = e.message
        if upload_error is not None:
            # The run's own outcome (exit_code, steps) is kept; only the upload failed.
            result["upload_error"] = upload_error
            result["ok"] = False
            if "error" not in result:
                result.update(error="s3-upload-failed", message=upload_error)
        return fit_inline(result)
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


_MAESTRO_BANNER_RE = re.compile(r"^[\u256d\u2502\u2570]")
_MAESTRO_HARD_ERROR_RE = re.compile(r"^(Assertion is false|Element not found|Unable to |Exception|Error: |java\.|maestro\.)")


def maestro_failure_summary(stdout: str, stderr: str = "", limit: int = 500) -> str:
    """The one-line reason a failed ``maestro test`` gives. Maestro ends every
    run's stdout with a boxed "Maestro Cloud" advert, so a plain tail of the
    output was only the advert (ace#2934). Picks the last top-level ``FAILED``
    step and the last hard error line; indented FAILED lines and ``Warning:``
    lines belong to optional probes. Twin of mcp/mobile/maestro-failure-summary.ts
    (a vitest runs both on the same recorded output)."""
    lines = [ln for ln in f"{stdout or ''}\n{stderr or ''}".split("\n")
             if ln.strip() and not _MAESTRO_BANNER_RE.match(ln.strip())]
    failed = [ln.strip() for ln in lines if not ln[:1].isspace() and ln.rstrip().endswith("FAILED")]
    errors = [ln.strip() for ln in lines if _MAESTRO_HARD_ERROR_RE.match(ln.strip())]
    parts = failed[-1:] + errors[-1:]
    out = " | ".join(parts) if parts else "\n".join(lines)
    return out[-limit:] if len(out) > limit else out


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


def _preset_lock_pin(host: Host, pin: str) -> None:
    # Mirrors AvdBackend.presetScreenLockPin (mcp/mobile/backends/avd.ts):
    # with a device PIN already set, part B's Configure-PIN goes straight to
    # the system unlock prompt instead of the Settings lock chooser (~15-20 s
    # of taps). Best-effort: a device that already has a lock refuses without
    # --old, and the recipe handles both an existing lock and a missing one.
    if DIGITS_RE.match(pin):
        adb(host, "shell", "locksettings", "set-pin", pin, timeout=PROBE_TIMEOUT_S)


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
    redactor = Redactor([v for k, v in creds.items() if k != "name"])
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
                          "stdout": _tail(redactor.text(p.stdout or ""), 2000),
                          "stderr": _tail(redactor.text(p.stderr or ""), 2000)})
            return p

        def finish(result: dict[str, Any]) -> dict[str, Any]:
            result["parts"] = parts
            if args.out:
                _, upload_error = upload_run(host, run_dir, scratch, args.out, redactor,
                                             {"register-parts.json": json.dumps(parts).encode("utf-8")})
                result["out"] = args.out
                if upload_error is not None:
                    result["upload_error"] = upload_error
            return result

        _set_gms_enabled(host, True)
        a = part("a", args.to_otp_recipe, {
            "PHONE_LOCAL": creds["phone_local"], "COUNTRY_CODE": creds["country_code"], "PIN": creds["pin"],
        })
        if "PHONE_ALREADY_REGISTERED" in (a.stdout or ""):
            return finish({"ok": True, "already_registered": True, "phone": creds["phone"],
                           "backup_code_set": False})
        if a.code != 0:
            raise CliError("register-part-a-failed",
                           f"register part A failed (exit {a.code}): "
                           f"{redactor.text(maestro_failure_summary(a.stdout or '', a.stderr or ''))}",
                           **finish({}))
        _set_gms_enabled(host, False)
        _preset_lock_pin(host, creds["pin"])
        b = part("b", args.from_otp_recipe, {
            "NAME": creds["name"], "BACKUP_CODE": creds["backup_code"], "PIN": creds["pin"],
        })
        if "PHONE_ALREADY_REGISTERED" in (b.stdout or ""):
            return finish({"ok": True, "already_registered": True, "phone": creds["phone"],
                           "backup_code_set": False})
        if b.code != 0:
            raise CliError("register-part-b-failed",
                           f"register part B failed (exit {b.code}): "
                           f"{redactor.text(maestro_failure_summary(b.stdout or '', b.stderr or ''))}",
                           **finish({}))
        # The backup code is never echoed: the caller supplied it, and stdout
        # lands in canopy-web's exec record and SSM's invocation history.
        return finish({"ok": True, "already_registered": False, "phone": creds["phone"],
                       "backup_code_set": True})
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


# ── Screen recording (record start | record stop) ────────────────────────────
#
# The lease twin of the local backend's mcp/mobile/screen-recorder.ts, with the
# same mechanics, because the same reasons hold here:
#   * on-device `screenrecord`, not the emulator console's recorder;
#   * `--time-limit 0` (screenrecord's default stops at 180 s, recipes run 10+ min);
#   * stopped with SIGINT, never SIGKILL (SIGKILL leaves no moov atom: an
#     unplayable file), then the file is polled until its size is stable;
#   * the device file is removed on every stop path, success or not.
# The client wraps a whole recipe (all its chunked execs) in one start/stop, as
# the local backend wraps a whole run. Container normalisation (ffmpeg -c copy
# +faststart) is the client's: the image ships no ffmpeg.
#
# The host-side `adb shell screenrecord` must outlive the `record start` exec,
# so it runs as a transient systemd unit (RECORD_UNIT), outside SSM's process
# tree, where an exec's teardown cannot reach it.

RECORD_DEFAULT_BITRATE = "1M"
RECORD_DEFAULT_SIZE = "540x1140"
BITRATE_RE = re.compile(r"^[1-9][0-9]*[KkMm]?$")
SIZE_RE = re.compile(r"^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$")
RECORD_START_WAIT_S = 10
RECORD_STABLE_TIMEOUT_S = 10
RECORD_PULL_TIMEOUT_S = 180


def record_file_name(name: str) -> str:
    """``name`` as the mp4's file name: ``journey`` and ``journey.mp4`` are the same recording."""
    return name if name.lower().endswith(".mp4") else f"{name}.mp4"


def record_device_path(name: str) -> str:
    return f"/sdcard/ace-rec-{record_file_name(name)}"


def _screenrecord_running(host: Host) -> bool:
    p = adb(host, "shell", "pidof", "screenrecord", timeout=PROBE_TIMEOUT_S)
    return p.code == 0 and bool((p.stdout or "").strip())


def _device_file_size(host: Host, path: str) -> int:
    p = adb(host, "shell", "stat", "-c", "%s", path, timeout=PROBE_TIMEOUT_S)
    try:
        return int((p.stdout or "").strip()) if p.code == 0 else -1
    except ValueError:
        return -1


def _record_cleanup(host: Host, device_path: str | None) -> None:
    """Best-effort, every path: the device file, the host unit, the state file."""
    if device_path:
        adb(host, "shell", "rm", "-f", device_path, timeout=PROBE_TIMEOUT_S)
    host.run(["systemctl", "stop", f"{RECORD_UNIT}.service"], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    host.run(["systemctl", "reset-failed", f"{RECORD_UNIT}.service"], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    try:
        os.unlink(RECORD_STATE_PATH)
    except OSError:
        pass


def cmd_record(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    if args.action == "start":
        if not args.name:
            args.name = _dt.datetime.fromtimestamp(host.now(), tz=_dt.timezone.utc).strftime(
                "rec-%Y%m%dT%H%M%SZ") + ".mp4"
        return record_start(host, args)
    if not args.out:
        raise UsageError("record stop needs --out s3://...")
    return record_stop(host, args)


def record_start(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    if not NAME_RE.match(args.name):
        raise UsageError(f"--name must match {NAME_RE.pattern}")
    if not BITRATE_RE.match(args.bit_rate):
        raise UsageError(f"--bit-rate must look like 1M, 800K or 2000000 (got {args.bit_rate!r})")
    if not SIZE_RE.match(args.size):
        raise UsageError(f"--size must be WIDTHxHEIGHT (got {args.size!r})")
    require_device(host)
    current = _read_json(RECORD_STATE_PATH)
    if isinstance(current, dict) and current.get("name"):
        raise CliError("record-busy", f"recording {current['name']!r} is already running; "
                       "`ace-mobile record stop` it first (one recording at a time)", recording=current)
    device_path = record_device_path(args.name)
    adb(host, "shell", "rm", "-f", device_path, timeout=PROBE_TIMEOUT_S)
    # A unit left `failed` by an earlier recording would refuse the name.
    host.run(["systemctl", "reset-failed", f"{RECORD_UNIT}.service"], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    argv = ["systemd-run", f"--unit={RECORD_UNIT}", "--collect", "--quiet",
            "--description=ACE screen recording " + args.name]
    if os.geteuid() == 0 and _user_exists(DEVICE_USER):
        argv += [f"--uid={DEVICE_USER}", f"--gid={DEVICE_USER}"]
    argv += [f"--setenv=ANDROID_SDK_ROOT={ANDROID_SDK_ROOT}", f"--setenv=HOME=/home/{DEVICE_USER}",
             ADB, "shell", "screenrecord", "--time-limit", "0", "--bit-rate", args.bit_rate,
             "--size", args.size, device_path]
    p = host.run(argv, as_device_user=False, timeout=PROBE_TIMEOUT_S)
    if p.code != 0:
        raise CliError("record-start-failed", f"systemd-run failed (exit {p.code}): {_tail(p.stderr, 300)}")
    # Proof it is recording: the device process exists. Without this a bad
    # --size (screenrecord exits at once) would only surface at stop.
    deadline = host.monotonic() + RECORD_START_WAIT_S
    while not _screenrecord_running(host):
        if host.monotonic() >= deadline:
            _record_cleanup(host, device_path)
            raise CliError("record-start-failed",
                           f"screenrecord was not running on the device within {RECORD_START_WAIT_S}s")
        host.sleep(0.5)
    started = host.now()
    state = {"name": args.name, "device_path": device_path, "bit_rate": args.bit_rate, "size": args.size,
             "started_at": _dt.datetime.fromtimestamp(started, tz=_dt.timezone.utc).isoformat(),
             "started_epoch": started}
    Path(RECORD_STATE_PATH).write_text(json.dumps(state), encoding="utf-8")
    return {"ok": True, "name": args.name, "device_path": device_path, "started_at": state["started_at"],
            "bit_rate": args.bit_rate, "size": args.size}


def record_stop(host: Host, args: argparse.Namespace) -> dict[str, Any]:
    parse_s3_uri(args.out)
    state = _read_json(RECORD_STATE_PATH)
    if not isinstance(state, dict) or not state.get("name"):
        # Nothing to stop, but a stray device recorder must not keep writing.
        adb(host, "shell", "pkill", "-INT", "screenrecord", timeout=PROBE_TIMEOUT_S)
        raise CliError("no-recording", "no recording is in flight (`ace-mobile record start` first)")
    name = state["name"]
    if args.name and record_file_name(args.name) != record_file_name(name):
        raise CliError("no-recording", f"the recording in flight is {name!r}, not {args.name!r}",
                       recording=state)
    device_path = state.get("device_path") or record_device_path(name)
    require_device(host)
    d = make_work_dir(host, "record")
    try:
        # SIGINT so screenrecord finalises the mp4.
        adb(host, "shell", "pkill", "-INT", "screenrecord", timeout=PROBE_TIMEOUT_S)
        previous, deadline = -1, host.monotonic() + RECORD_STABLE_TIMEOUT_S
        while host.monotonic() < deadline:
            size = _device_file_size(host, device_path)
            if size > 0 and size == previous:
                break
            previous = size
            host.sleep(0.5)
        local = os.path.join(d, record_file_name(name))
        p = adb(host, "pull", device_path, local, timeout=RECORD_PULL_TIMEOUT_S)
        if p.code != 0 or not os.path.isfile(local) or os.path.getsize(local) == 0:
            raise CliError("record-pull-failed",
                           f"adb pull {device_path} failed (exit {p.code}): {_tail(p.stdout + p.stderr, 300)}")
        nbytes = os.path.getsize(local)
        key = record_file_name(name)
        uri = join_s3(args.out, key)
        result: dict[str, Any] = {
            "ok": True, "name": name, "key": key, "uri": uri, "content_type": "video/mp4", "bytes": nbytes,
            "duration_s": round(host.now() - float(state.get("started_epoch") or host.now()), 1),
        }
        try:
            s3_put_file(host, local, uri)
        except CliError as e:
            result.update(ok=False, error="s3-upload-failed", message=e.message, upload_error=e.message)
        return result
    finally:
        _record_cleanup(host, device_path)
        shutil.rmtree(d, ignore_errors=True)


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

    sub.add_parser("apply-baseline",
                   help="apply the local backend's environment baseline + sync the clock (idempotent)")

    rc = sub.add_parser("record", help="on-device screen recording: start, then stop (uploads the mp4 to --out)")
    rc.add_argument("action", choices=["start", "stop"])
    rc.add_argument("--name", help="recording name, [A-Za-z0-9._-], e.g. journey.mp4 (start: default rec-<utc>.mp4; "
                    "stop: optional check that it is the one in flight)")
    rc.add_argument("--out", help="stop: s3:// prefix the mp4 is uploaded under, as <name>.mp4")
    rc.add_argument("--bit-rate", default=RECORD_DEFAULT_BITRATE, help="start: screenrecord --bit-rate (default 1M)")
    rc.add_argument("--size", default=RECORD_DEFAULT_SIZE, help="start: screenrecord --size (default 540x1140)")
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
    "apply-baseline": cmd_apply_baseline,
    "record": cmd_record,
}

# Subcommands that still run on a machine whose emulator crashed after ready.
# Everything else refuses with emulator-crashed (exit 1): the device it would
# drive is gone, and this machine never reboots it.
RUNS_AFTER_CRASH = frozenset({"diagnose"})


def run_cli(argv: list[str], host: Host | None = None) -> tuple[int, dict[str, Any]]:
    host = host or Host()
    try:
        args = build_parser().parse_args(argv)
        if args.version:
            return 0, {"ok": True, "cli_version": CLI_VERSION}
        if not args.cmd:
            raise UsageError("a subcommand is required: " + ", ".join(COMMANDS))
        if args.cmd not in RUNS_AFTER_CRASH:
            crash = read_crash_marker()
            if crash is not None:
                raise CliError("emulator-crashed", crash_message(crash), crash=crash)
        if os.environ.get(INTERNAL_ENV) == "1":
            result = COMMANDS[args.cmd](host, args)
        else:
            with exec_activity():
                result = COMMANDS[args.cmd](host, args)
    except UsageError as e:
        return 2, {"ok": False, "error": "usage", "message": str(e), "cli_version": CLI_VERSION}
    except CliError as e:
        return 1, {**e.extra, "ok": False, "error": e.code, "message": e.message}
    except Exception as e:  # noqa: BLE001 — the one-JSON-line contract holds even for a bug
        return 1, {"ok": False, "error": "internal", "message": f"{type(e).__name__}: {e}"}
    return (0 if result.get("ok") else 1), result


class exec_activity:
    """Mark an exec in flight for the idle watchdog: touch LAST_ACTIVITY_PATH on
    entry and exit, and hold EXEC_DIR/<pid> while running, so a 30-minute
    recipe is never mistaken for idleness. Best-effort: it must never fail an exec."""

    def __enter__(self) -> "exec_activity":
        self.pid_file = os.path.join(EXEC_DIR, str(os.getpid()))
        touch_activity()
        try:
            os.makedirs(EXEC_DIR, exist_ok=True)
            Path(self.pid_file).write_text(str(int(time.time())))
        except OSError:
            pass
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            os.unlink(self.pid_file)
        except OSError:
            pass
        touch_activity()


def touch_activity() -> None:
    try:
        Path(LAST_ACTIVITY_PATH).touch()
    except OSError:
        pass


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
# These three mirror capability.yaml `limits` (max_lease_s, ready_timeout_s,
# idle_release_s); test/infra/android-emulator-capability.test.ts fails CI when
# they drift. DEFAULT_MAX_LIFETIME_S is also the halt armed BEFORE user-data is
# read, so it must never be shorter than a real lease may live.
DEFAULT_MAX_LIFETIME_S = 14400
READY_TIMEOUT_S = 900  # counted from instance boot
MANIFEST_IDLE_RELEASE_S = 900
READY_MARGIN_S = 30
# The in-VM idle watchdog powers off after (user-data idle_release_s + IDLE_GRACE_S)
# without an exec, or DEFAULT_IDLE_POWEROFF_S when user-data carries no idle
# value (canopy-web passes max_lifetime_s, not idle_release_s, today). It is a
# backstop for a broker that stopped releasing, not the release path.
IDLE_GRACE_S = 600
DEFAULT_IDLE_POWEROFF_S = 1800
DEFAULT_HALT_UNIT = "ace-max-lifetime-default"
LEASE_HALT_UNIT = "ace-max-lifetime"
PROC_UPTIME = "/proc/uptime"
KVM_DEV = "/dev/kvm"
IMDS_ATTEMPTS = 30


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


def halt_in_s(max_lifetime_s: float, uptime_s: float) -> int:
    """max_lifetime_s is the lease's whole life; the hook starts after boot, so
    arm only what is left of it (never less than a minute)."""
    return max(60, int(max_lifetime_s - uptime_s))


def idle_poweroff_s(user_data: dict[str, Any]) -> int:
    try:
        idle = int(user_data.get("idle_release_s") or 0)
    except (TypeError, ValueError):
        idle = 0
    return idle + IDLE_GRACE_S if idle > 0 else DEFAULT_IDLE_POWEROFF_S


def plan_boot(ctx: BootContext, states: dict[str, Any], kvm_present: bool) -> dict[str, Any]:
    """Pure decision for the boot hook: what to halt at, what to boot, or why not."""
    ud = ctx.user_data
    try:
        max_lifetime = int(ud.get("max_lifetime_s") or DEFAULT_MAX_LIFETIME_S)
    except (TypeError, ValueError):
        max_lifetime = DEFAULT_MAX_LIFETIME_S
    plan: dict[str, Any] = {"halt_in_s": halt_in_s(max_lifetime, ctx.uptime_s), "bucket": ud.get("bucket"),
                            "lease_id": ud.get("lease_id"), "idle_poweroff_s": idle_poweroff_s(ud)}
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


def ready_payload(ok: bool, reason: str | None, timings: dict[str, Any], ctx: BootContext,
                  state: str | None, detail: str | None = None, **extra: Any) -> dict[str, Any]:
    p: dict[str, Any] = {"ok": ok, "timings": timings, "cli_version": CLI_VERSION,
                         "instance_id": ctx.instance_id, "state": state, **extra}
    if reason:
        p["reason"] = reason
    if detail:
        p["detail"] = _tail(detail, 2000)
    return p


def _log(msg: str) -> None:
    sys.stderr.write(f"[ace-capability-boot] {msg}\n")
    sys.stderr.flush()


def read_uptime() -> float:
    try:
        return float((read_file(PROC_UPTIME) or "0").split()[0])
    except (ValueError, IndexError):
        return 0.0


def arm_halt(host: Host, unit: str, seconds: int) -> Proc:
    """``systemd-run --on-active``: a transient timer that powers off. With the
    launch template's InstanceInitiatedShutdownBehavior=terminate, poweroff IS
    termination, so the machine ends on its own even if canopy-web is down."""
    return host.run(["systemd-run", f"--on-active={seconds}s", f"--unit={unit}",
                     "--description=ACE capability max lifetime", "/bin/systemctl", "poweroff"],
                    as_device_user=False, timeout=PROBE_TIMEOUT_S)


def unit_prop(host: Host, unit: str, prop: str) -> str:
    p = host.run(["systemctl", "show", "-p", prop, "--value", unit], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    return (p.stdout or "").strip()


class _Boot:
    """One run of the boot hook. Every exit goes through ``publish``."""

    def __init__(self, host: Host, imds: Any) -> None:
        self.host, self.imds = host, imds
        self.t_hook = host.monotonic()
        self.ctx = BootContext(instance_id="unknown", region="us-east-1")
        self.plan: dict[str, Any] = {}
        self.timings: dict[str, Any] = {}
        self.published = False

    # -- exits --------------------------------------------------------------

    def poweroff(self, why: str) -> None:
        _log(f"powering off: {why}")
        self.host.run(["systemctl", "poweroff"], as_device_user=False, timeout=PROBE_TIMEOUT_S)

    def publish(self, ok: bool, reason: str | None, detail: str | None = None) -> int:
        self.published = True
        self.timings.setdefault("hook_s", round(self.host.monotonic() - self.t_hook, 1))
        extra: dict[str, Any] = {"accel": "kvm" if os.path.exists(KVM_DEV) else "tcg"}
        for k, path in (("baseline", BASELINE_PATH), ("boot_path", BOOT_PATH_PATH)):
            v = _read_json(path)
            if v is not None:
                extra[k] = v
        baseline = extra.get("baseline")
        if isinstance(baseline, dict) and isinstance(baseline.get("fingerprint"), str):
            # Top-level too: lease-contract.ts readyBaseline() reads this first.
            extra["baseline_fingerprint"] = baseline["fingerprint"]
        payload = ready_payload(ok, reason, self.timings, self.ctx, self.plan.get("state"), detail, **extra)
        _log(f"ready.json: {json.dumps(payload)[:800]}")
        # The idle watchdog counts from here: a lease nobody drives (or a failed
        # one the broker never releases) still ends.
        touch_activity()
        bucket = self.plan.get("bucket")
        if not bucket:
            self.poweroff("no bucket in user-data, so no lease can ever read or release this machine")
            return 1
        f = os.path.join(RUN_DIR, "ready.json")
        Path(f).write_text(json.dumps(payload))
        key = ready_key(caller_userid(self.host), self.ctx.instance_id)
        for attempt in range(5):
            p = self.host.run(["aws", "s3", "cp", "--only-show-errors", "--content-type", "application/json", f,
                               f"s3://{bucket}/{key}"], as_device_user=False, timeout=60)
            if p.code == 0:
                return 0 if ok else 1
            _log(f"ready.json upload failed ({(p.stderr or '').strip()[:200]}); retry {attempt + 1}")
            self.host.sleep(3)
        return 1

    # -- the hook -----------------------------------------------------------

    def run(self) -> int:
        host = self.host
        os.makedirs(RUN_DIR, exist_ok=True)
        uptime = read_uptime()
        self.timings["uptime_at_hook_s"] = round(uptime, 1)
        # 1. A halt, armed before ANYTHING that can fail or wait (IMDS included),
        #    from the conservative default: the longest a lease may live.
        default_arm = arm_halt(host, DEFAULT_HALT_UNIT, halt_in_s(DEFAULT_MAX_LIFETIME_S, uptime))
        _log(f"default halt in {halt_in_s(DEFAULT_MAX_LIFETIME_S, uptime)}s (systemd-run exit {default_arm.code})")

        # 2. Who and where am I, and what lease is this?
        for attempt in range(IMDS_ATTEMPTS):
            try:
                self.ctx.instance_id = self.imds.get("meta-data/instance-id") or "unknown"
                self.ctx.region = self.imds.get("meta-data/placement/region") or self.ctx.region
                break
            except Exception as e:  # noqa: BLE001
                _log(f"IMDS not ready ({e}); retry {attempt + 1}")
                host.sleep(2)
        os.environ["AWS_DEFAULT_REGION"] = self.ctx.region
        try:
            raw_ud = self.imds.get("user-data")
        except Exception as e:  # noqa: BLE001
            _log(f"could not read user-data: {e}")
            raw_ud = None
        ud, ud_err = parse_user_data(raw_ud)
        self.ctx.user_data, self.ctx.user_data_error = ud, ud_err
        self.ctx.uptime_s = read_uptime()
        states = parse_states_yaml(read_file(STATES_YAML_PATH) or "")
        self.plan = plan_boot(self.ctx, states, os.path.exists(KVM_DEV))
        self.timings["imds_s"] = round(host.monotonic() - self.t_hook, 1)

        if default_arm.code != 0:
            code = self.publish(False, "halt-not-armed",
                                f"default halt: systemd-run exit {default_arm.code}: {default_arm.stderr}")
            self.poweroff("the max-lifetime halt could not be armed")
            return code

        # 3. Re-arm with the lease's own lifetime, then drop the default.
        lease_arm = arm_halt(host, LEASE_HALT_UNIT, self.plan["halt_in_s"])
        _log(f"lease halt in {self.plan['halt_in_s']}s (systemd-run exit {lease_arm.code})")
        if lease_arm.code != 0:
            code = self.publish(False, "halt-not-armed", f"lease halt: {lease_arm.stderr}")
            self.poweroff("the lease's max-lifetime halt could not be armed")
            return code
        host.run(["systemctl", "stop", f"{DEFAULT_HALT_UNIT}.timer"], as_device_user=False, timeout=PROBE_TIMEOUT_S)

        Path(LEASE_PATH).write_text(json.dumps({
            "lease_id": self.plan.get("lease_id"), "state": self.plan.get("state"), "bucket": self.plan.get("bucket"),
            "instance_id": self.ctx.instance_id, "region": self.ctx.region}))
        Path(IDLE_CONFIG_PATH).write_text(json.dumps({"idle_poweroff_s": self.plan["idle_poweroff_s"]}))
        if "fail" in self.plan:
            code, msg = self.plan["fail"]
            return self.publish(False, code, msg)

        # 4. Boot the AVD for the lease's state (ace-emulator-launch reads
        #    requested-state: snapshot load, or cold boot + install).
        Path(REQUESTED_STATE_PATH).write_text(self.plan["state"] + "\n")
        t_start = host.monotonic()
        host.run(["systemctl", "reset-failed", RUNNER_UNIT], as_device_user=False, timeout=PROBE_TIMEOUT_S)
        # Blocking: for a Type=simple unit `systemctl start` returns once the
        # launcher is forked, so the first ActiveState read below is already
        # `active`. (--no-block raced: the job could still be queued, reading
        # `inactive`, which the loop reports as emulator-boot-failed.)
        start = host.run(["systemctl", "start", RUNNER_UNIT], as_device_user=False, timeout=PROBE_TIMEOUT_S)
        if start.code != 0:
            return self.publish(False, "runner-start-failed", start.stderr)
        budget = max(60.0, READY_TIMEOUT_S - self.ctx.uptime_s - READY_MARGIN_S)
        deadline = t_start + budget
        while host.monotonic() < deadline:
            if os.path.exists(READY_MARKER):
                now = host.monotonic()
                self.timings["runner_to_ready_s"] = round(now - t_start, 1)
                self.timings["hook_s"] = round(now - self.t_hook, 1)
                self.timings["boot_to_ready_s"] = round(uptime + (now - self.t_hook), 1)
                self.timings.update(_launch_timings())
                return self.publish(True, None)
            # The runner unit is Restart=no: one start, one boot. A restart
            # (someone re-added Restart=) or an exit before ready is a failed
            # lease, never a second -wipe-data boot.
            restarts = unit_prop(host, RUNNER_UNIT, "NRestarts")
            active = unit_prop(host, RUNNER_UNIT, "ActiveState")
            # `inactive` means "exited" only once the launcher has actually run
            # (it exits 0 only after ready, which the marker check above saw).
            exited = active == "inactive" and unit_prop(
                host, RUNNER_UNIT, "ExecMainExitTimestampMonotonic") not in ("", "0")
            if restarts not in ("", "0") or active == "failed" or exited:
                self.timings.update(_launch_timings())
                return self.publish(False, "emulator-boot-failed",
                                    f"runner {active}, NRestarts={restarts or '?'}\n" + tail_lines(RUNNER_LOG, 40))
            host.sleep(1)
        self.timings.update(_launch_timings())
        return self.publish(False, "emulator-ready-timeout",
                            f"no {READY_MARKER} after {int(budget)}s\n" + tail_lines(RUNNER_LOG, 40))


def boot_main(host: Host | None = None, imds: Any = None) -> int:
    """The image's boot hook (/usr/local/sbin/ace-capability-boot). Never
    leaves without a ready.json when a bucket is known: an exception becomes
    ``{ok:false, reason:"hook-crashed"}`` instead of a broker waiting out
    ready_timeout_s."""
    boot = _Boot(host or Host(), imds or Imds())
    try:
        return boot.run()
    except Exception as e:  # noqa: BLE001
        import traceback

        detail = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
        _log(f"hook crashed: {detail}")
        if boot.published:
            return 1
        try:
            return boot.publish(False, "hook-crashed", detail)
        except Exception as e2:  # noqa: BLE001
            _log(f"could not publish hook-crashed: {e2}")
            boot.poweroff("the boot hook crashed and could not report it")
            return 1


def _launch_timings() -> dict[str, Any]:
    """/run/ace-mobile/launch-timings (``key=value`` lines from ace-emulator-launch)."""
    out: dict[str, Any] = {}
    for line in (read_file(LAUNCH_TIMINGS_PATH) or "").splitlines():
        k, _, v = line.partition("=")
        try:
            out[f"launch_{k.strip()}"] = float(v)
        except ValueError:
            if k.strip():
                out[f"launch_{k.strip()}"] = v.strip()
    return out


# ── Idle watchdog (ace-idle-watchdog.timer → /usr/local/sbin/ace-idle-watchdog) ──


def idle_decision(now: float, last_activity: float | None, threshold_s: int, live_execs: int) -> tuple[bool, str]:
    """Pure: power off? Never before the boot hook has published (no
    last-activity yet), never while an exec runs."""
    if last_activity is None:
        return False, "no activity clock yet (the boot hook has not published)"
    if live_execs > 0:
        return False, f"{live_execs} exec(s) in flight"
    idle = now - last_activity
    if idle >= threshold_s:
        return True, f"idle {int(idle)}s >= {threshold_s}s"
    return False, f"idle {int(idle)}s < {threshold_s}s"


def live_exec_count() -> int:
    n = 0
    try:
        names = os.listdir(EXEC_DIR)
    except OSError:
        return 0
    for name in names:
        try:
            os.kill(int(name), 0)
            n += 1
        except (ValueError, ProcessLookupError):
            try:
                os.unlink(os.path.join(EXEC_DIR, name))  # a stale pid file from a killed exec
            except OSError:
                pass
        except PermissionError:
            n += 1  # alive, owned by someone else
    return n


def idle_main(host: Host | None = None) -> int:
    host = host or Host()
    try:
        threshold = int(json.loads(read_file(IDLE_CONFIG_PATH) or "{}").get("idle_poweroff_s") or DEFAULT_IDLE_POWEROFF_S)
    except (json.JSONDecodeError, TypeError, ValueError):
        threshold = DEFAULT_IDLE_POWEROFF_S
    try:
        last = os.stat(LAST_ACTIVITY_PATH).st_mtime
    except OSError:
        last = None
    off, why = idle_decision(host.now(), last, threshold, live_exec_count())
    sys.stderr.write(f"[ace-idle-watchdog] {why}\n")
    if off:
        host.run(["systemctl", "poweroff"], as_device_user=False, timeout=PROBE_TIMEOUT_S)
    return 0


# ── Boot-path selection (ace-emulator-launch asks `ace-launch-plan <state>`) ──

BOOT_MODE_PATH = "/opt/ace/boot-mode"
AVD_DIR = "/home/ubuntu/.android/avd/ACE_Pixel_API_34.avd"


def choose_boot_path(state: dict[str, str] | None, boot_mode: str, avd_dir: str) -> tuple[str, str]:
    """Pure: ``("snapshot", name)`` or ``("cold", why)``.

    The image bakes one quick-boot snapshot per state (CommCare installed, no
    user registered) only when built with boot_mode=snapshot; a snapshot is
    used only when that mode is on AND its files are present. Everything else
    cold-boots (-wipe-data + install), which is always available."""
    if not state:
        return "cold", "unknown state"
    if boot_mode.strip() != "snapshot":
        return "cold", f"image boot mode is {boot_mode.strip() or 'cold'!r}"
    snap = (state.get("snapshot") or "").strip()
    if not snap or snap in ("none", "cold-boot-stage"):
        return "cold", "no snapshot baked for this state"
    snap_dir = os.path.join(avd_dir, "snapshots", snap)
    for f in ("ram.bin", "snapshot.pb"):
        if not os.path.isfile(os.path.join(snap_dir, f)):
            return "cold", f"snapshot {snap} is missing {f}"
    return "snapshot", snap


def launch_plan_main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    name = argv[0] if argv else ""
    states = parse_states_yaml(read_file(STATES_YAML_PATH) or "")
    entry = next((s for s in states["states"] if s["name"] == name), None)
    path, detail = choose_boot_path(entry, read_file(BOOT_MODE_PATH) or "cold", AVD_DIR)
    sys.stdout.write(f"{path} {detail}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
