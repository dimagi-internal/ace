"""The image's shell and systemd side, run for real where it can be:

* files/ace-emulator-launch against fake `emulator`/`adb`/`ace-mobile`/
  `ace-launch-plan` binaries: cold boot, snapshot fallback, a boot failure,
  and a crash after ready;
* scripts/40-commcare-apk.sh against a fake download and a fake apksigner;
* _common.sh's manifest_states / prune_images against a fake `aws`;
* static checks of the systemd units and tmpfiles rule.

Needs bash >= 4 (associative arrays, $EPOCHREALTIME) and jq; CI's ubuntu has
both. Tests skip, loudly, where a tool is missing locally.
"""
from __future__ import annotations

import configparser
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from _support import IMAGE_DIR, am

CAP_DIR = IMAGE_DIR.parent
FILES = IMAGE_DIR / "files"
SCRIPTS = IMAGE_DIR / "scripts"


def bash() -> str | None:
    for b in ("bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"):
        p = shutil.which(b) or (b if os.path.exists(b) else None)
        if not p:
            continue
        r = subprocess.run([p, "-c", 'echo "${BASH_VERSINFO[0]}"'], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip().isdigit() and int(r.stdout.strip()) >= 5:
            return p
    return None


BASH = bash()


# The fake emulator exits on its own after this long, whatever happens to the
# test that started it. Every launcher test finishes well inside it.
STUB_MAX_LIFE_S = 90


def stub_processes(d: Path) -> list[str]:
    """Live processes whose command line names something under `d`."""
    deadline = time.time() + 2  # a SIGKILLed group can take a moment to go
    while True:
        r = subprocess.run(["pgrep", "-fl", f"{d}/"], capture_output=True, text=True)
        left = [ln for ln in r.stdout.splitlines() if ln.strip()]
        if not left or time.time() > deadline:
            return left
        time.sleep(0.05)


def write_exec(path: Path, body: str) -> None:
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(0o755)


@unittest.skipUnless(BASH and shutil.which("jq"), "needs bash >= 5 and jq")
class LauncherTests(unittest.TestCase):
    """The launcher, end to end, against fakes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.d = Path(self.tmp.name)
        (d / "run").mkdir()
        (d / "bin").mkdir()
        apk = d / "commcare.apk"
        apk.write_bytes(b"PK")
        (d / "states.yaml").write_text(
            "default: cc-2.64.0\nstates:\n"
            f"  - name: cc-2.64.0\n    snapshot: cold-boot-stage\n    commcare_version: \"2.64.0\"\n    apk_path: {apk}\n"
            f"  - name: cc-2.62.0\n    snapshot: cold-boot-stage\n    commcare_version: \"2.62.0\"\n    apk_path: /nope\n")
        # emulator: a snapshot boot exits at once when FAIL_SNAPSHOT is set; a
        # cold boot exits at once when FAIL_COLD is set; otherwise it runs
        # until $D/die exists, then exits 139 (a crash).
        #
        # It must never outlive its test. The launcher backgrounds it (`&`), so
        # killing the launcher alone orphans it, and once the temp dir is gone
        # `$D/die` can never appear: it used to spin forever as
        # `bin/emulator -avd ACE_Pixel_API_34`, which the Mac's local mobile
        # backend reads as a live holder of the real AVD (38 found on one
        # machine). So it also exits when $D vanishes and after a hard bound.
        write_exec(d / "bin/emulator", f"""
echo "$*" >> {d}/emulator.argv
D={d}
if [[ " $* " == *" -snapshot "* && -e $D/FAIL_SNAPSHOT ]]; then exit 1; fi
if [[ " $* " == *" -wipe-data "* && -e $D/FAIL_COLD ]]; then exit 1; fi
touch $D/emu-up
end=$((SECONDS + {STUB_MAX_LIFE_S}))
while [[ ! -e $D/die && -d $D ]] && ((SECONDS < end)); do sleep 0.05; done
rm -f $D/emu-up
exit 139
""")
        write_exec(d / "bin/adb", f"""
D={d}
echo "$*" >> $D/adb.log
[[ -e $D/emu-up ]] || exit 1
case "$1 $2" in
  "get-state "*) echo device ;;
  "shell getprop") echo 1 ;;
  "install -r") echo Success ;;
  "shell pm") if [[ "$3" == path ]]; then
                [[ -e $D/no-commcare ]] && exit 1
                echo package:/data/app/base.apk
              fi ;;
esac
""")
        write_exec(d / "bin/ace-mobile", f"""
echo "$ACE_MOBILE_INTERNAL $*" >> {d}/ace-mobile.log
echo '{{"ok":true,"fingerprint":"abc"}}'
""")
        write_exec(d / "bin/ace-launch-plan", f"""
if [[ -e {d}/PLAN_SNAPSHOT ]]; then echo "snapshot snap1"; else echo "cold image boot mode is 'cold'"; fi
""")
        self.env = {**os.environ, "STATES_YAML": str(d / "states.yaml"), "ADB": str(d / "bin/adb"),
                    "EMU": str(d / "bin/emulator"), "LAUNCH_PLAN": str(d / "bin/ace-launch-plan"),
                    "ACE_MOBILE": str(d / "bin/ace-mobile"), "RUNDIR": str(d / "run"),
                    "LOG_FILE": str(d / "emulator.log"), "BOOT_TIMEOUT_S": "60", "PM_TIMEOUT_S": "30",
                    "POLL_S": "0.05"}
        self.proc: subprocess.Popen | None = None

    def tearDown(self):
        (self.d / "die").touch()
        if self.proc:
            # The launcher runs in its own process group (start_new_session),
            # and its backgrounded emulator stays in it: kill the GROUP, not
            # just the launcher, or the stub is orphaned to ppid 1.
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.proc.wait()
            if self.proc.stdout:
                self.proc.stdout.close()
        self.tmp.cleanup()
        # Regression check: nothing this test started may still be running.
        left = stub_processes(self.d)
        self.assertEqual(left, [], f"test left processes running from {self.d}: {left}")

    def launch(self, *args):
        self.proc = subprocess.Popen([BASH, str(FILES / "ace-emulator-launch"), *args], env=self.env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     start_new_session=True)
        return self.proc

    def wait_ready(self, timeout=60):
        deadline = time.time() + timeout
        ready = self.d / "run/ready"
        while time.time() < deadline:
            if ready.exists():
                return True
            if self.proc.poll() is not None:
                return False
            time.sleep(0.05)
        return False

    def run_dir(self, name):
        return (self.d / "run" / name).read_text()

    def test_cold_boot_ready_then_crash(self):
        self.launch()
        self.assertTrue(self.wait_ready(), self.proc.stdout.read() if self.proc.poll() is not None else "")
        argv = (self.d / "emulator.argv").read_text()
        self.assertIn("-avd ACE_Pixel_API_34", argv)
        self.assertIn("-no-snapshot -wipe-data", argv)
        adb = (self.d / "adb.log").read_text()
        self.assertIn("install -r", adb)
        grants = [ln for ln in adb.splitlines() if ln.startswith("shell pm grant org.commcare.dalvik ")]
        self.assertEqual(len(grants), 9)
        self.assertEqual((self.d / "ace-mobile.log").read_text().strip(), "1 apply-baseline")
        self.assertEqual(json.loads(self.run_dir("boot-path"))["path"], "cold")
        self.assertEqual(self.run_dir("active-state").strip(), "cc-2.64.0")
        timings = dict(ln.split("=") for ln in self.run_dir("launch-timings").split())
        for k in ("emulator_started_s", "adb_visible_s", "boot_completed_s", "commcare_installed_s",
                  "baseline_s", "ready_s"):
            float(timings[k])
        # The emulator dies after ready: the launcher records it and exits 0.
        (self.d / "die").touch()
        self.assertEqual(self.proc.wait(timeout=60), 0)
        crash = self.run_dir("crashed")
        self.assertIn("emulator_exit=139", crash)
        self.assertIn("state=cc-2.64.0", crash)
        Path(am.CRASHED_MARKER)  # the CLI reads this exact key=value shape:
        rec = {k: v for k, _, v in (ln.partition("=") for ln in crash.splitlines())}
        self.assertEqual(rec["emulator_exit"], "139")

    def test_requested_state_wins_over_default(self):
        (self.d / "run/requested-state").write_text("cc-2.62.0\n")
        p = self.launch()
        self.assertEqual(p.wait(timeout=60), 1)  # cc-2.62.0's apk_path does not exist
        self.assertFalse((self.d / "run/ready").exists())

    def test_snapshot_failure_falls_back_to_cold(self):
        (self.d / "PLAN_SNAPSHOT").touch()
        (self.d / "FAIL_SNAPSHOT").touch()
        self.launch()
        self.assertTrue(self.wait_ready())
        bp = json.loads(self.run_dir("boot-path"))
        self.assertEqual(bp["path"], "cold-fallback")
        argv = (self.d / "emulator.argv").read_text().splitlines()
        self.assertIn("-snapshot snap1 -no-snapshot-save", argv[0])
        self.assertIn("-wipe-data", argv[1])

    def test_snapshot_path_skips_install(self):
        (self.d / "PLAN_SNAPSHOT").touch()
        self.launch()
        self.assertTrue(self.wait_ready())
        self.assertEqual(json.loads(self.run_dir("boot-path"))["path"], "snapshot")
        self.assertNotIn("install -r", (self.d / "adb.log").read_text())

    def test_boot_failure_exits_1_without_ready(self):
        (self.d / "FAIL_COLD").touch()
        p = self.launch()
        self.assertEqual(p.wait(timeout=60), 1)
        self.assertFalse((self.d / "run/ready").exists())
        self.assertFalse((self.d / "run/crashed").exists())


@unittest.skipUnless(BASH and shutil.which("sha256sum"), "needs bash >= 5 and sha256sum")
class CommcareApkScriptTests(unittest.TestCase):
    SIGNER = "Signer #1 certificate SHA-256 digest: 8955dfd80e666306d26d88a4a388a4d9165ac41a7ee1c6788700375593037b03\n"

    def run_script(self, versions, body: bytes, signer: str):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "body").write_bytes(body)
            write_exec(d / "fetch", f'cp {d}/body "$1"\n')
            write_exec(d / "apksigner", f"printf '%s' {json.dumps(signer)}\n")
            env = {**os.environ, "COMMCARE_VERSIONS": versions, "APK_ROOT": str(d / "ace/apks"),
                   "MANIFEST": str(d / "ace/MANIFEST.txt"), "APKSIGNER": str(d / "apksigner"),
                   "FETCH": str(d / "fetch")}
            r = subprocess.run([BASH, str(SCRIPTS / "40-commcare-apk.sh")], env=env, capture_output=True, text=True)
            files = sorted(p.relative_to(d).as_posix() for p in d.rglob("*.sha256"))
            return r, files

    def test_unpinned_version_refused(self):
        r, _ = self.run_script("2.63.0", b"x", self.SIGNER)
        self.assertEqual(r.returncode, 22, r.stderr)
        self.assertIn("no pinned URL", r.stderr)

    def test_bytes_that_do_not_match_the_pin_are_refused(self):
        r, files = self.run_script("2.64.0", b"not the real apk", self.SIGNER)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(files, [])

    def test_pins_are_real_sha256(self):
        text = (SCRIPTS / "40-commcare-apk.sh").read_text()
        for v in ("2.64.0", "2.62.0"):
            self.assertRegex(text, rf"APK_SHA256\[{v}\]=[0-9a-f]{{64}}\n")
        self.assertNotIn("APK_URL[2.63.0]", text)


@unittest.skipUnless(BASH, "needs bash >= 5")
class CommonShTests(unittest.TestCase):
    def common(self, script: str, aws_body: str = "exit 1\n") -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as d:
            write_exec(Path(d, "aws"), aws_body)
            env = {**os.environ, "PATH": f"{d}:{os.environ['PATH']}", "AWS_LOG": f"{d}/aws.log"}
            r = subprocess.run([BASH, "-c", f"set -euo pipefail; source {CAP_DIR}/_common.sh; load_config; {script}"],
                               env=env, capture_output=True, text=True)
            r.aws_log = Path(d, "aws.log").read_text() if Path(d, "aws.log").exists() else ""  # type: ignore[attr-defined]
            return r

    def test_manifest_states(self):
        r = self.common("manifest_states")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "cc-2.62.0,cc-2.64.0")

    # A fake `aws`: describe-images lists five images newest-first, with one
    # malformed id; every mutating call is logged.
    FAKE_AWS = r"""
echo "$*" >> "$AWS_LOG"
case "$*" in
  *"--owners self"*) printf 'ami-0000000000000005\tami-0000000000000004\tbogus\tami-0000000000000003\tami-0000000000000002\tami-0000000000000001\n' ;;
  *"--image-ids"*) printf 'snap-0000000000000001\tsnap-bad\n' ;;
  *) exit 0 ;;
esac
"""

    def deregistered(self, log: str) -> list[str]:
        return [ln.split("--image-id ")[1].split()[0] for ln in log.splitlines() if "deregister-image" in ln]

    def test_prune_keeps_newest_n_and_pinned(self):
        r = self.common("prune_images 3 ami-0000000000000001", self.FAKE_AWS)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.deregistered(r.aws_log), ["ami-0000000000000002"])
        deleted = [ln for ln in r.aws_log.splitlines() if "delete-snapshot" in ln]
        self.assertEqual(len(deleted), 1)  # snap-bad is never passed to AWS
        self.assertIn("skipping 'bogus'", r.stderr)

    def test_prune_everything(self):
        r = self.common("prune_images 0", self.FAKE_AWS)
        self.assertEqual(len(self.deregistered(r.aws_log)), 5)

    def test_prune_refuses_a_bad_pin(self):
        r = self.common("prune_images 3 None", self.FAKE_AWS)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.deregistered(r.aws_log), [])

    def test_current_ami_distinguishes_absent_from_unreadable(self):
        absent = self.common("current_ami", 'echo "An error occurred (ParameterNotFound)" >&2; exit 254\n')
        self.assertEqual((absent.returncode, absent.stdout), (0, ""))
        broken = self.common("current_ami", 'echo "ExpiredToken" >&2; exit 254\n')
        self.assertNotEqual(broken.returncode, 0)
        self.assertIn("ExpiredToken", broken.stderr)

    def test_require_ami_states(self):
        good = self.common("require_ami_states ami-0000000000000001", 'echo "cc-2.64.0,cc-2.62.0"\n')
        self.assertEqual(good.returncode, 0, good.stderr)
        stale = self.common("require_ami_states ami-0000000000000001", 'echo "cc-2.63.0,cc-2.62.0"\n')
        self.assertNotEqual(stale.returncode, 0)
        untagged = self.common("require_ami_states ami-0000000000000001", 'echo None\n')
        self.assertIn("no ace:states tag", untagged.stderr)


class UnitFileTests(unittest.TestCase):
    def unit(self, name):
        cp = configparser.ConfigParser(strict=False, interpolation=None)
        cp.optionxform = str  # systemd keys are case-sensitive
        cp.read(FILES / name)
        return cp

    def test_runner_never_restarts_and_start_limits_are_unit_settings(self):
        u = self.unit("ace-mobile-runner.service")
        self.assertEqual(u["Service"]["Restart"], "no")
        for k in ("StartLimitIntervalSec", "StartLimitBurst"):
            self.assertIn(k, u["Unit"])
            self.assertNotIn(k, u["Service"])
        self.assertEqual(u["Service"]["User"], "ubuntu")

    def test_boot_hook_outlasts_the_ready_budget(self):
        u = self.unit("ace-capability-boot.service")
        self.assertGreater(int(u["Service"]["TimeoutStartSec"]), am.READY_TIMEOUT_S)
        self.assertEqual(u["Service"]["ExecStart"], "/usr/local/sbin/ace-capability-boot")

    def test_idle_watchdog(self):
        s, t = self.unit("ace-idle-watchdog.service"), self.unit("ace-idle-watchdog.timer")
        self.assertEqual(s["Service"]["ExecStart"], "/usr/local/sbin/ace-idle-watchdog")
        self.assertEqual(t["Install"]["WantedBy"], "timers.target")
        install = (SCRIPTS / "60-systemd.sh").read_text()
        self.assertIn("systemctl enable ace-capability-boot.service ace-idle-watchdog.timer", install)
        for name in ("ace-capability-boot", "ace-idle-watchdog", "ace-launch-plan"):
            self.assertIn(name, install)
        self.assertIn("systemd-analyze verify", install)

    def test_tmpfiles_exec_dir_is_sticky_world_writable(self):
        rules = [ln.split() for ln in (FILES / "ace-mobile.tmpfiles.conf").read_text().splitlines()
                 if ln and not ln.startswith("#")]
        self.assertIn(["d", "/run/ace-mobile/exec", "1777", "root", "root", "-"], rules)
        self.assertIn(["d", "/run/ace-mobile", "0755", "ubuntu", "ubuntu", "-"], rules)
        self.assertEqual(am.EXEC_DIR.rsplit("/", 1)[-1], "exec")

    def test_launcher_paths_match_the_cli(self):
        launcher = (FILES / "ace-emulator-launch").read_text()
        for const, name in ((am.READY_MARKER, "ready"), (am.LAUNCH_TIMINGS_PATH, "launch-timings"),
                            (am.BOOT_PATH_PATH, "boot-path"), (am.CRASHED_MARKER, "crashed")):
            self.assertTrue(const.endswith("/" + name))
            self.assertIn(f'"$RUNDIR/{name}"', launcher)
        self.assertIn("RUNDIR=${RUNDIR:-" + am.RUN_DIR + "}", launcher)


if __name__ == "__main__":
    unittest.main()
