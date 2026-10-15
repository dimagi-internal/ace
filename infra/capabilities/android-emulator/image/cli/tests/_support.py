"""Shared fakes for the ace-mobile CLI tests (not a test module)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
CLI_DIR = HERE.parent
IMAGE_DIR = CLI_DIR.parent
FIX = HERE / "fixtures"
sys.path.insert(0, str(CLI_DIR))

import ace_mobile as am  # noqa: E402

BOOTED_DEVICES = "List of devices attached\nemulator-5554\tdevice\n\n"


class FakeHost(am.Host):
    """Scripted host: each call is matched by a handler; records argv."""

    def __init__(self, handler: Callable[["FakeHost", list[str], dict], am.Proc]) -> None:
        self.handler = handler
        self.calls: list[list[str]] = []
        self.kw: list[dict] = []
        self.t = 1_800_000_000.0
        self.uploads: dict[str, bytes] = {}

    def run(self, argv, **kw):  # type: ignore[override]
        self.calls.append(list(argv))
        self.kw.append(kw)
        # Default S3 behaviour: record uploads, serve downloads from self.s3.
        if argv[:3] == ["aws", "s3", "cp"]:
            args, rest = [], list(argv[3:])
            while rest:
                a = rest.pop(0)
                if a in ("--content-type",):
                    rest.pop(0)  # an option that takes a value
                elif not a.startswith("--"):
                    args.append(a)
            src, dst = args[0], args[1]
            if "--recursive" in argv:
                for p in Path(src).rglob("*"):
                    if p.is_file():
                        self.uploads[dst.rstrip("/") + "/" + p.relative_to(src).as_posix()] = p.read_bytes()
                return am.Proc(0, "", "")
            if src.startswith("s3://"):
                body = getattr(self, "s3", {}).get(src)
                if body is None:
                    return am.Proc(1, "", f"fatal error: An error occurred (404) when calling HeadObject: {src}")
                Path(dst).write_bytes(body)
                return am.Proc(0, "", "")
            self.uploads[dst] = Path(src).read_bytes()
            return am.Proc(0, "", "")
        return self.handler(self, argv, kw)

    def now(self):
        return self.t

    def monotonic(self):
        self.t += 0.5
        return self.t

    def sleep(self, s):
        self.t += s

    def chown_tree(self, path):
        pass

    def http_get(self, url, dest, timeout=0):
        Path(dest).write_bytes(getattr(self, "https", {})[url])


def adb_only(responses: dict[tuple, am.Proc] | None = None, default: am.Proc | None = None):
    """Handler answering adb argv by prefix match on the args after `adb`."""
    responses = responses or {}

    def h(host, argv, kw):
        if argv[0] == am.ADB:
            rest = tuple(argv[1:])
            for k, v in responses.items():
                if rest[: len(k)] == k:
                    return v(host, argv, kw) if callable(v) else v
            if rest[:1] == ("devices",):
                return am.Proc(0, BOOTED_DEVICES, "")
        if default is not None:
            return default
        raise AssertionError(f"unexpected call: {argv}")

    return h


class TmpPaths(unittest.TestCase):
    """Point every in-VM path at a temp dir."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self._saved = {}
        run = root / "run"
        for name, val in {
            "WORK_ROOT": root / "work",
            "RUN_DIR": run,
            "READY_MARKER": run / "ready",
            "ACTIVE_STATE_PATH": run / "active-state",
            "REQUESTED_STATE_PATH": run / "requested-state",
            "LAUNCH_TIMINGS_PATH": run / "launch-timings",
            "LEASE_PATH": run / "lease.json",
            "CRASHED_MARKER": run / "crashed",
            "LAST_ACTIVITY_PATH": run / "last-activity",
            "IDLE_CONFIG_PATH": run / "idle.json",
            "EXEC_DIR": run / "exec",
            "BASELINE_PATH": run / "baseline.json",
            "BOOT_PATH_PATH": run / "boot-path",
            "RECORD_STATE_PATH": run / "record.json",
            "STATES_YAML_PATH": root / "states.yaml",
            "BOOT_MODE_PATH": root / "boot-mode",
            "AVD_DIR": root / "avd",
            "KVM_DEV": root / "kvm",
            "PROC_UPTIME": root / "uptime",
            "RUNNER_LOG": root / "runner.log",
            "EMULATOR_LOG": root / "emulator.log",
            "MAESTRO_DRIVER_CACHE_ROOT": root / "driver-cache",
            "MAESTRO_JAR_PATH": root / "maestro/lib/maestro-client.jar",
            "MAESTRO_LIB_DIR": root / "maestro/lib",
        }.items():
            self._saved[name] = getattr(am, name)
            setattr(am, name, str(val))
        run.mkdir()
        self.root = root
        # A process environment that says "the image calling itself" would
        # skip the activity clock; tests must see the lease-exec path.
        self._internal = os.environ.pop(am.INTERNAL_ENV, None)

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(am, k, v)
        if self._internal is not None:
            os.environ[am.INTERNAL_ENV] = self._internal
        self.tmp.cleanup()


def cli(argv, host):
    code, payload = am.run_cli(argv, host)
    json.dumps(payload)  # must always serialize
    return code, payload
