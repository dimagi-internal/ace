"""The lease-machine runtime around the subcommands: the crash guard, the boot
hook end to end (ready.json), the idle watchdog, the boot-path selector,
apply-baseline, and `record start|stop`."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from _support import FakeHost, TmpPaths, adb_only, am, cli

# The local backend's five baseline keys (mcp/mobile/backends/avd.ts
# applyEnvironmentBaseline settingsApplied). The TS parity test reads avd.ts
# itself; this pins the Python side's arithmetic.
LOCAL_KEYS = ["heads_up_notifications_enabled", "notification_disallow_dnd_gms", "screen_off_timeout",
              "mock_location_fix", "location_providers_allowed"]


def ok(*_a):
    return am.Proc(0, "", "")


# ── Crash guard ──────────────────────────────────────────────────────────────


class CrashGuardTests(TmpPaths):
    def crash(self):
        Path(am.CRASHED_MARKER).write_text("emulator_exit=139\nat=2026-10-14T00:00:00Z\nstate=cc-2.64.0\n")

    def test_every_subcommand_but_diagnose_refuses(self):
        self.crash()
        host = FakeHost(adb_only())
        for argv in (["clear-app-data"], ["ui-dump"], ["apply-baseline"], ["record", "start"],
                     ["screenshot", "--out", "s3://bkt/o"]):
            code, out = cli(argv, host)
            self.assertEqual((code, out["ok"], out["error"]), (1, False, "emulator-crashed"), argv)
            self.assertEqual(out["crash"]["emulator_exit"], "139")
        self.assertFalse([c for c in host.calls if c[0] == am.ADB], "a crashed machine must not touch adb")

    def test_diagnose_reports_it(self):
        self.crash()
        Path(am.READY_MARKER).write_text("")

        def handler(host, argv, kw):
            if argv[0] in ("pgrep", "systemctl"):
                return am.Proc(1, "", "")
            return adb_only()(host, argv, kw)

        code, out = cli(["diagnose"], FakeHost(handler))
        self.assertEqual((code, out["ok"], out["healthy"], out["crashed"], out["error"]),
                         (0, True, False, True, "emulator-crashed"))


class ActivityTests(TmpPaths):
    def test_exec_touches_the_clock_and_cleans_its_pid_file(self):
        cli(["clear-app-data"], FakeHost(adb_only({("shell", "pm", "clear"): am.Proc(0, "Success", "")})))
        self.assertTrue(Path(am.LAST_ACTIVITY_PATH).exists())
        self.assertEqual(os.listdir(am.EXEC_DIR), [])

    def test_internal_call_does_not(self):
        os.environ[am.INTERNAL_ENV] = "1"
        try:
            cli(["clear-app-data"], FakeHost(adb_only({("shell", "pm", "clear"): am.Proc(0, "Success", "")})))
        finally:
            del os.environ[am.INTERNAL_ENV]
        self.assertFalse(Path(am.LAST_ACTIVITY_PATH).exists())


# ── apply-baseline ───────────────────────────────────────────────────────────


class BaselineTests(TmpPaths):
    def test_fingerprint_is_the_local_backends(self):
        want = hashlib.sha1("|".join(sorted(LOCAL_KEYS)).encode()).hexdigest()[:12]
        self.assertEqual(am.baseline_fingerprint(), want)
        self.assertEqual(sorted({k for k, _ in am.BASELINE_STEPS}), sorted(LOCAL_KEYS))

    def test_applies_every_step_and_records_it(self):
        host = FakeHost(adb_only({("emu", "geo", "fix"): am.Proc(0, "OK", ""), ("shell", "su"): ok}, default=ok(0)))
        code, out = cli(["apply-baseline"], host)
        self.assertEqual(code, 0, out)
        self.assertEqual((out["complete"], out["failed"], out["clock_synced"]), (True, [], True))
        self.assertEqual(out["fingerprint"], am.baseline_fingerprint())
        for k in ("ok", "fingerprint", "keys", "complete", "failed", "clock_synced", "steps"):
            self.assertIn(k, out)
        sent = [tuple(c[1:]) for c in host.calls if c[0] == am.ADB and c[1] != "devices"]
        for _, argv in am.BASELINE_STEPS:
            self.assertIn(argv, sent)
        date = next(c for c in host.calls if "date" in c)
        self.assertEqual(date[1:6], ["shell", "su", "0", "date", "-u"])
        self.assertRegex(date[6], r"^\d{12}\.\d{2}$")  # MMDDhhmmCCYY.ss, toybox's format
        rec = json.loads(Path(am.BASELINE_PATH).read_text())
        self.assertEqual(rec["fingerprint"], am.baseline_fingerprint())

    def test_a_console_ko_is_a_failed_step_not_a_crash(self):
        host = FakeHost(adb_only({("emu", "geo", "fix"): am.Proc(0, "KO: bad", ""),
                                  ("shell", "settings", "put", "system"): am.Proc(0, "Exception: no", "")},
                                 default=ok()))
        code, out = cli(["apply-baseline"], host)
        self.assertEqual((code, out["ok"], out["error"]), (1, False, "baseline-failed"))
        self.assertEqual(out["failed"], ["mock_location_fix", "screen_off_timeout"])
        self.assertEqual(len(out["steps"]), len(am.BASELINE_STEPS))  # every step still ran


# ── Boot hook ────────────────────────────────────────────────────────────────


class FakeImds:
    def __init__(self, user_data, fail=False):
        self.user_data, self.fail = user_data, fail

    def get(self, path):
        if self.fail:
            raise OSError("imds down")
        return {"meta-data/instance-id": "i-0abc", "meta-data/placement/region": "us-east-1",
                "user-data": self.user_data}.get(path)


STATES_YAML = """default: cc-2.64.0
states:
  - name: cc-2.64.0
    snapshot: cold-boot-stage
    commcare_version: "2.64.0"
    apk_path: /opt/ace/apks/2.64.0/commcare.apk
  - name: cc-2.62.0
    snapshot: cold-boot-stage
    commcare_version: "2.62.0"
    apk_path: /opt/ace/apks/2.62.0/commcare.apk
"""
UD = json.dumps({"lease_id": "L1", "bucket": "cap-bkt", "max_lifetime_s": 3600, "params": {"state": "cc-2.62.0"}})


class BootHookTests(TmpPaths):
    def setUp(self):
        super().setUp()
        Path(am.STATES_YAML_PATH).write_text(STATES_YAML)
        Path(am.KVM_DEV).write_text("")
        Path(am.PROC_UPTIME).write_text("40.00 10.0\n")

    def host(self, *, arm_fail=False, runner="ready", polls_to_ready=3):
        state = {"polls": 0}

        def handler(host, argv, kw):
            if argv[0] == "systemd-run":
                return am.Proc(1 if arm_fail else 0, "", "Failed to start transient timer" if arm_fail else "")
            if argv[:3] == ["aws", "sts", "get-caller-identity"]:
                return am.Proc(0, "AROAEXAMPLE:i-0abc\n", "")
            if argv[:2] == ["systemctl", "show"]:
                prop = argv[3]
                if prop == "ActiveState":
                    state["polls"] += 1
                    if runner == "ready" and state["polls"] >= polls_to_ready:
                        Path(am.LAUNCH_TIMINGS_PATH).write_text(
                            "emulator_started_s=0.4\nadb_visible_s=21.0\nboot_completed_s=80.2\nready_s=95.0\n")
                        Path(am.BASELINE_PATH).write_text(json.dumps(
                            {"fingerprint": am.baseline_fingerprint(), "keys": [], "complete": True,
                             "failed": [], "clock_synced": True}))
                        Path(am.BOOT_PATH_PATH).write_text(json.dumps({"path": "cold", "detail": "x"}))
                        Path(am.READY_MARKER).write_text("")
                    return am.Proc(0, {"ready": "active", "failed": "failed", "exited": "inactive"}[runner] + "\n", "")
                if prop == "NRestarts":
                    return am.Proc(0, "0\n", "")
                if prop == "ExecMainExitTimestampMonotonic":
                    return am.Proc(0, "123\n" if runner == "exited" else "0\n", "")
            if argv[0] == "systemctl":
                return am.Proc(0, "", "")
            raise AssertionError(argv)

        return FakeHost(handler)

    def ready(self, host):
        key = "s3://cap-bkt/vm/AROAEXAMPLE:i-0abc/ready.json"
        self.assertIn(key, host.uploads)
        return json.loads(host.uploads[key])

    def test_happy_path(self):
        host = self.host()
        self.assertEqual(am.boot_main(host, FakeImds(UD)), 0)
        r = self.ready(host)
        self.assertEqual((r["ok"], r["state"], r["instance_id"], r["cli_version"], r["accel"]),
                         (True, "cc-2.62.0", "i-0abc", am.CLI_VERSION, "kvm"))
        self.assertEqual(r["baseline_fingerprint"], am.baseline_fingerprint())
        self.assertEqual(r["baseline"]["fingerprint"], am.baseline_fingerprint())
        self.assertEqual(r["boot_path"]["path"], "cold")
        for k in ("launch_emulator_started_s", "launch_adb_visible_s", "launch_boot_completed_s",
                  "runner_to_ready_s", "boot_to_ready_s", "uptime_at_hook_s"):
            self.assertIn(k, r["timings"])
        # Halt armed first (default), then the lease's own, then the default dropped.
        runs = [c for c in host.calls if c[0] == "systemd-run"]
        self.assertEqual([c[2] for c in runs], [f"--unit={am.DEFAULT_HALT_UNIT}", f"--unit={am.LEASE_HALT_UNIT}"])
        self.assertEqual(runs[1][1], "--on-active=3560s")
        self.assertLess(host.calls.index(runs[0]), next(i for i, c in enumerate(host.calls) if c[0] == "aws"))
        self.assertIn(["systemctl", "start", am.RUNNER_UNIT], host.calls)  # blocking start, no --no-block
        self.assertEqual(Path(am.REQUESTED_STATE_PATH).read_text().strip(), "cc-2.62.0")
        self.assertEqual(json.loads(Path(am.LEASE_PATH).read_text())["lease_id"], "L1")
        self.assertTrue(Path(am.LAST_ACTIVITY_PATH).exists())  # the idle clock starts at publish

    def test_halt_arm_failure_reports_and_powers_off(self):
        host = self.host(arm_fail=True)
        self.assertEqual(am.boot_main(host, FakeImds(UD)), 1)
        r = self.ready(host)
        self.assertEqual((r["ok"], r["reason"]), (False, "halt-not-armed"))
        self.assertIn(["systemctl", "poweroff"], host.calls)
        self.assertNotIn(["systemctl", "start", am.RUNNER_UNIT], host.calls)

    def test_runner_failure(self):
        host = self.host(runner="failed")
        self.assertEqual(am.boot_main(host, FakeImds(UD)), 1)
        self.assertEqual(self.ready(host)["reason"], "emulator-boot-failed")

    def test_runner_exit_before_ready(self):
        host = self.host(runner="exited")
        am.boot_main(host, FakeImds(UD))
        self.assertEqual(self.ready(host)["reason"], "emulator-boot-failed")

    def test_ready_timeout(self):
        host = self.host(polls_to_ready=10**9)
        am.boot_main(host, FakeImds(UD))
        self.assertEqual(self.ready(host)["reason"], "emulator-ready-timeout")

    def test_unknown_state_and_no_kvm(self):
        ud = json.dumps({"bucket": "cap-bkt", "params": {"state": "cc-2.63.0"}})
        host = self.host()
        am.boot_main(host, FakeImds(ud))
        self.assertEqual(self.ready(host)["reason"], "unknown-state")
        os.unlink(am.KVM_DEV)
        host = self.host()
        am.boot_main(host, FakeImds(UD))
        r = self.ready(host)
        self.assertEqual((r["reason"], r["accel"]), ("no-kvm", "tcg"))

    def test_no_bucket_powers_off_without_publishing(self):
        host = self.host()
        self.assertEqual(am.boot_main(host, FakeImds("")), 1)
        self.assertEqual(host.uploads, {})
        self.assertIn(["systemctl", "poweroff"], host.calls)

    def test_a_crash_becomes_hook_crashed(self):
        host = self.host()

        class Boom(am._Boot):
            def run(self):
                self.plan = {"bucket": "cap-bkt", "state": "cc-2.64.0"}
                raise RuntimeError("kaboom")

        orig = am._Boot
        am._Boot = Boom
        try:
            self.assertEqual(am.boot_main(host, FakeImds(UD)), 1)
        finally:
            am._Boot = orig
        r = self.ready(host)
        self.assertEqual((r["ok"], r["reason"]), (False, "hook-crashed"))
        self.assertIn("kaboom", r["detail"])


# ── Idle watchdog ────────────────────────────────────────────────────────────


class IdleTests(TmpPaths):
    def test_decision(self):
        self.assertFalse(am.idle_decision(10_000, None, 60, 0)[0])
        self.assertFalse(am.idle_decision(10_000, 0, 60, 1)[0])
        self.assertTrue(am.idle_decision(10_000, 9_000, 600, 0)[0])
        self.assertFalse(am.idle_decision(10_000, 9_900, 600, 0)[0])

    def test_thresholds(self):
        self.assertEqual(am.idle_poweroff_s({"idle_release_s": 900}), 900 + am.IDLE_GRACE_S)
        self.assertEqual(am.idle_poweroff_s({}), am.DEFAULT_IDLE_POWEROFF_S)

    def test_main_powers_off_when_idle_and_cleans_stale_pids(self):
        Path(am.IDLE_CONFIG_PATH).write_text(json.dumps({"idle_poweroff_s": 60}))
        Path(am.LAST_ACTIVITY_PATH).write_text("")
        os.utime(am.LAST_ACTIVITY_PATH, (1, 1))
        os.makedirs(am.EXEC_DIR)
        Path(am.EXEC_DIR, "999999999").write_text("")  # a pid that cannot exist
        host = FakeHost(lambda h, argv, kw: am.Proc(0, "", ""))
        am.idle_main(host)
        self.assertIn(["systemctl", "poweroff"], host.calls)
        self.assertEqual(os.listdir(am.EXEC_DIR), [])

    def test_main_waits_while_an_exec_runs(self):
        Path(am.IDLE_CONFIG_PATH).write_text(json.dumps({"idle_poweroff_s": 60}))
        Path(am.LAST_ACTIVITY_PATH).write_text("")
        os.utime(am.LAST_ACTIVITY_PATH, (1, 1))
        os.makedirs(am.EXEC_DIR)
        Path(am.EXEC_DIR, str(os.getpid())).write_text("")
        host = FakeHost(lambda h, argv, kw: am.Proc(0, "", ""))
        am.idle_main(host)
        self.assertEqual(host.calls, [])


# ── Boot path ────────────────────────────────────────────────────────────────


class LaunchPlanTests(TmpPaths):
    def test_choose(self):
        st = {"name": "cc-2.64.0", "snapshot": "cc-2.64.0-ready"}
        self.assertEqual(am.choose_boot_path(None, "snapshot", am.AVD_DIR)[0], "cold")
        self.assertEqual(am.choose_boot_path(st, "cold", am.AVD_DIR)[0], "cold")
        self.assertEqual(am.choose_boot_path({**st, "snapshot": "cold-boot-stage"}, "snapshot", am.AVD_DIR)[0], "cold")
        self.assertIn("missing ram.bin", am.choose_boot_path(st, "snapshot", am.AVD_DIR)[1])
        snap = Path(am.AVD_DIR, "snapshots", "cc-2.64.0-ready")
        snap.mkdir(parents=True)
        (snap / "ram.bin").write_text("")
        (snap / "snapshot.pb").write_text("")
        self.assertEqual(am.choose_boot_path(st, "snapshot\n", am.AVD_DIR), ("snapshot", "cc-2.64.0-ready"))


# ── record start | stop ──────────────────────────────────────────────────────


class RecordTests(TmpPaths):
    def host(self, *, running=True, pull_ok=True, upload_ok=True):
        sizes = iter([100, 200, 200])

        def handler(host, argv, kw):
            if argv[0] in ("systemd-run", "systemctl"):
                host.unit_calls = getattr(host, "unit_calls", []) + [argv]
                return am.Proc(0, "", "")
            if argv[0] == am.ADB:
                rest = argv[1:]
                if rest[:2] == ["shell", "pidof"]:
                    return am.Proc(0, "4321\n", "") if running else am.Proc(1, "", "")
                if rest[:2] == ["shell", "stat"]:
                    return am.Proc(0, f"{next(sizes, 200)}\n", "")
                if rest[0] == "pull":
                    if pull_ok:
                        Path(rest[2]).write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"x" * 200)
                        return am.Proc(0, "1 file pulled", "")
                    return am.Proc(1, "", "adb: error: remote object does not exist")
                return adb_only(default=am.Proc(0, "", ""))(host, argv, kw)
            raise AssertionError(argv)

        class H(FakeHost):
            def run(self, argv, **kw):
                if not upload_ok and argv[:3] == ["aws", "s3", "cp"]:
                    return am.Proc(1, "", "AccessDenied")
                return super().run(argv, **kw)

        return H(handler)

    def test_start_then_stop(self):
        host = self.host()
        code, out = cli(["record", "start", "--name", "journey.mp4"], host)
        self.assertEqual(code, 0, out)
        self.assertEqual((out["name"], out["device_path"]), ("journey.mp4", "/sdcard/ace-rec-journey.mp4"))
        run = next(c for c in host.calls if c[0] == "systemd-run")
        self.assertIn(f"--unit={am.RECORD_UNIT}", run)
        tail = run[run.index(am.ADB):]
        self.assertEqual(tail, [am.ADB, "shell", "screenrecord", "--time-limit", "0", "--bit-rate", "1M",
                                "--size", "540x1140", "/sdcard/ace-rec-journey.mp4"])
        code, again = cli(["record", "start", "--name", "x"], host)
        self.assertEqual((code, again["error"]), (1, "record-busy"))

        code, out = cli(["record", "stop", "--out", "s3://bkt/out/rec", "--name", "journey"], host)
        self.assertEqual(code, 0, out)
        self.assertEqual((out["key"], out["uri"], out["content_type"]),
                         ("journey.mp4", "s3://bkt/out/rec/journey.mp4", "video/mp4"))
        self.assertGreater(out["bytes"], 0)
        self.assertIn("s3://bkt/out/rec/journey.mp4", host.uploads)
        adb_calls = [c[1:] for c in host.calls if c[0] == am.ADB]
        self.assertIn(["shell", "pkill", "-INT", "screenrecord"], adb_calls)  # SIGINT, never -9
        self.assertNotIn("-9", json.dumps(adb_calls))
        self.assertEqual(adb_calls[-1], ["shell", "rm", "-f", "/sdcard/ace-rec-journey.mp4"])
        self.assertFalse(Path(am.RECORD_STATE_PATH).exists())
        self.assertEqual(cli(["record", "stop", "--out", "s3://bkt/o"], host)[1]["error"], "no-recording")

    def test_default_name(self):
        code, out = cli(["record", "start"], self.host())
        self.assertEqual(code, 0, out)
        self.assertRegex(out["name"], r"^rec-\d{8}T\d{6}Z\.mp4$")

    def test_start_that_never_records_cleans_up(self):
        host = self.host(running=False)
        code, out = cli(["record", "start", "--name", "j"], host)
        self.assertEqual((code, out["error"]), (1, "record-start-failed"))
        self.assertFalse(Path(am.RECORD_STATE_PATH).exists())

    def test_pull_failure_still_cleans_the_device(self):
        host = self.host(pull_ok=False)
        cli(["record", "start", "--name", "j"], host)
        code, out = cli(["record", "stop", "--out", "s3://bkt/o"], host)
        self.assertEqual((code, out["error"]), (1, "record-pull-failed"))
        self.assertIn([am.ADB, "shell", "rm", "-f", "/sdcard/ace-rec-j.mp4"], host.calls)
        self.assertFalse(Path(am.RECORD_STATE_PATH).exists())

    def test_upload_failure(self):
        host = self.host(upload_ok=False)
        cli(["record", "start", "--name", "j"], host)
        code, out = cli(["record", "stop", "--out", "s3://bkt/o"], host)
        self.assertEqual((code, out["error"]), (1, "s3-upload-failed"))
        self.assertIn("AccessDenied", out["upload_error"])

    def test_usage(self):
        host = self.host()
        self.assertEqual(cli(["record", "start", "--size", "big"], host)[0], 2)
        self.assertEqual(cli(["record", "start", "--name", "a/b"], host)[0], 2)
        self.assertEqual(cli(["record", "stop"], host)[0], 2)
        self.assertEqual(cli(["record", "pause"], host)[0], 2)
        self.assertEqual(cli(["no-such-thing"], host)[1]["error"], "usage")
