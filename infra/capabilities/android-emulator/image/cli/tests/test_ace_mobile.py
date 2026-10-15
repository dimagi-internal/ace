"""Unit tests for the ace-mobile CLI and boot hook (stdlib unittest).

Run: python3 -m unittest discover -s infra/capabilities/android-emulator/image/cli/tests
CI runs them through test/infra/android-emulator-cli.test.ts (vitest), so the
`clean-install` unit shards gate them.

Fixtures (tests/fixtures/):
  RECORDED — maestro-commands-{passed,failed}-2.5.1.json are real Maestro 2.5.1
    `--debug-output` command reports from ACE Phase 6 walks (2026-08-26), with
    the demo user's PIN/phone/backup code replaced and the per-failure view
    hierarchy removed. uiautomator-dump-postlearn-landing.xml is a real dump
    (bednet-check-2-visit, 2026-08-14). aapt-badging-commcare-2.62.0.txt is
    `aapt dump badging` of the real CommCare 2.62.0 APK. adb-devices-empty.txt
    is `adb devices` with no device attached.
  CONSTRUCTED — anything built inline below (a booted `adb devices`, console
    KO replies), in the formats the recorded files and controller.py's tests use.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Callable

from _support import BOOTED_DEVICES, CLI_DIR, FIX, IMAGE_DIR, FakeHost, TmpPaths, adb_only, am, cli  # noqa: E402

# ── Parsers ──────────────────────────────────────────────────────────────────


class ParserTests(unittest.TestCase):
    def test_adb_devices_recorded_empty(self):
        self.assertEqual(am.parse_adb_devices((FIX / "adb-devices-empty.txt").read_text()), [])

    def test_adb_devices_states(self):
        text = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n"
        self.assertEqual(
            am.parse_adb_devices(text),
            [{"serial": "emulator-5554", "state": "device"}, {"serial": "emulator-5556", "state": "offline"}],
        )

    def test_adb_devices_ignores_daemon_banner(self):
        text = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n"
        self.assertEqual(am.parse_adb_devices(text), [])

    def test_steps_recorded_passed_flow(self):
        data = json.loads((FIX / "maestro-commands-passed-2.5.1.json").read_text())
        steps = am.lift_maestro_steps(data)
        self.assertEqual(len(steps), len(data))
        # Real output is not in execution order; rows come back by sequenceNumber.
        self.assertEqual([s["index"] for s in steps], list(range(len(steps))))
        self.assertTrue(steps[0]["name"].startswith("defineVariablesCommand"))
        self.assertTrue(all(s["status"] == "pass" for s in steps))
        shots = [s["screenshot"] for s in steps if s["screenshot"]]
        self.assertIn("journey-deliver-attendance-done.png", shots)
        taps = [s["name"] for s in steps if s["name"].startswith("tapOnElement")]
        self.assertIn("tapOnElement: org.commcare.dalvik:id/nav_btn_next", taps)
        self.assertTrue(all(isinstance(s["duration_ms"], (int, type(None))) for s in steps))
        # The shape cloud.ts CloudStep consumes, exactly.
        self.assertEqual(set(steps[0]), {"index", "name", "status", "screenshot", "error", "duration_ms"})

    def test_steps_recorded_failed_flow(self):
        steps = am.lift_maestro_steps(json.loads((FIX / "maestro-commands-failed-2.5.1.json").read_text()))
        failed = [s for s in steps if s["status"] == "fail"]
        # Maestro fails the leaf assertion AND the runFlow that encloses it, with
        # the same error; in sequence order the leaf is the last row.
        self.assertEqual([s["name"].split(":")[0] for s in failed], ["runFlowCommand", "assertConditionCommand"])
        self.assertEqual(steps[-1], failed[-1])
        self.assertEqual(
            failed[-1]["error"],
            "Assertion is false: id: org.commcare.dalvik:id/connect_fragment_jobs_list is visible",
        )
        self.assertEqual(failed[-1]["name"], "assertConditionCommand: org.commcare.dalvik:id/connect_fragment_jobs_list")
        # WARNED (an optional command that failed) is 'unknown', as controller.py had it.
        self.assertIn("unknown", [s["status"] for s in steps])

    def test_steps_legacy_shapes_from_controller_tests(self):
        steps = am.lift_maestro_steps([
            {"command": {"launchApp": "com.example"}, "status": "COMPLETED", "metadata": {"duration": 1234}},
            {"command": {"tapOn": "Submit"}, "status": "COMPLETED", "screenshot": "01.png"},
            {"command": {"assertVisible": {"text": "Welcome"}}, "status": "FAILED",
             "error": {"message": "element not found"}},
        ])
        self.assertEqual(steps[0]["name"], "launchApp: com.example")
        self.assertEqual(steps[0]["duration_ms"], 1234)
        self.assertEqual(steps[1]["screenshot"], "01.png")
        self.assertEqual(steps[2]["status"], "fail")
        self.assertEqual(steps[2]["error"], "element not found")
        flow = am.lift_maestro_steps({"commands": [{"command": {"tapOn": "x"}, "status": "SKIPPED"},
                                                   {"command": {"tapOn": "y"}, "status": "WEIRD"}]})
        self.assertEqual([s["status"] for s in flow], ["skipped", "unknown"])
        self.assertEqual(am.lift_maestro_steps("nope"), [])

    def test_ui_elements_recorded_dump(self):
        xml = (FIX / "uiautomator-dump-postlearn-landing.xml").read_text()
        els = am.parse_ui_elements(xml)
        self.assertGreater(len(els), 5)
        self.assertIn({"text": "Training and Post-Test"}, [{"text": e["text"]} for e in els if "text" in e])
        self.assertIn("org.commcare.dalvik:id/grid_menu_grid", [e.get("id") for e in els])
        self.assertTrue(all("bounds" in e for e in els))
        # Empty attributes are omitted, as avd.ts maps '' to undefined.
        self.assertNotIn("", [v for e in els for v in e.values()])

    def test_ui_dump_failure_detection(self):
        self.assertFalse(am.detect_ui_dump_failure(0, "UI hierchary dumped to: x", "<hierarchy/>", 0))
        self.assertTrue(am.detect_ui_dump_failure(0, "", "cat: /data/local/tmp/window_dump.xml: No such file or directory", 1))
        self.assertTrue(am.detect_ui_dump_failure(0, "ERROR: could not get idle state.", "", 0))

    def test_aapt_recorded(self):
        info = am.parse_aapt_badging((FIX / "aapt-badging-commcare-2.62.0.txt").read_text())
        self.assertEqual(info, {"package_name": "org.commcare.dalvik", "version": "2.62.0", "version_code": 486560})

    def test_console_ok(self):
        self.assertTrue(am.console_ok(0, "OK"))
        self.assertFalse(am.console_ok(0, 'KO: Snapshot save is disabled because "-read-only" was specified'))
        self.assertFalse(am.console_ok(1, "OK"))
        self.assertFalse(am.console_ok(0, "error: no emulator detected"))

    def test_states_yaml_from_the_real_bake_script(self):
        """Run image/scripts/50-states.sh against fake APKs and parse its output."""
        with tempfile.TemporaryDirectory() as d:
            for v in ("2.64.0", "2.62.0"):
                p = Path(d, "apks", v)
                p.mkdir(parents=True)
                (p / "commcare.apk").write_bytes(b"x")
                (p / "commcare.apk.sha256").write_text("ab" * 32 + "\n")
            out = Path(d, "states.yaml")
            env = {**os.environ, "COMMCARE_VERSIONS": "2.64.0,2.62.0", "APK_ROOT": str(Path(d, "apks")),
                   "STATES_YAML": str(out), "STATES_OWNER": ""}
            r = subprocess.run(["bash", str(IMAGE_DIR / "scripts/50-states.sh")], env=env,
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            out_text = out.read_text()
            cat = am.parse_states_yaml(out_text)
        self.assertEqual(cat["default"], "cc-2.64.0")
        self.assertEqual([s["name"] for s in cat["states"]], ["cc-2.64.0", "cc-2.62.0"])
        self.assertTrue(cat["states"][0]["apk_path"].endswith("2.64.0/commcare.apk"))
        self.assertIn("commcare_apk_sha256: " + "ab" * 32, out_text)


# ── Subcommands ──────────────────────────────────────────────────────────────


class ContractTests(TmpPaths):
    def test_one_json_line_on_stdout(self):
        for argv, want in ((["--version"], 0), (["set-location", "--lat", "1"], 2), ([], 2)):
            r = subprocess.run([sys.executable, str(CLI_DIR / "ace_mobile.py"), *argv],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, want, r.stderr)
            lines = r.stdout.splitlines()
            self.assertEqual(len(lines), 1, r.stdout)
            self.assertIn("ok", json.loads(lines[0]))

    def test_no_device_is_a_typed_failure(self):
        host = FakeHost(adb_only({("devices",): am.Proc(0, (FIX / "adb-devices-empty.txt").read_text(), "")}))
        code, out = cli(["clear-app-data"], host)
        self.assertEqual((code, out["ok"], out["error"]), (1, False, "no-device"))

    def test_bug_still_yields_json(self):
        def boom(*_a, **_k):
            raise RuntimeError("kaboom")
        host = FakeHost(boom)
        code, out = cli(["repair-driver"], host)
        self.assertEqual((code, out["error"]), (1, "internal"))


class RunRecipeTests(TmpPaths):
    def _host(self, maestro_exit=0, write_report=True):
        def handler(host, argv, kw):
            if argv[0] == am.MAESTRO:
                run_dir = kw["cwd"]
                host.maestro_argv = argv
                if write_report:
                    Path(run_dir, "commands-(recipe.yaml).json").write_bytes(
                        (FIX / "maestro-commands-passed-2.5.1.json").read_bytes())
                Path(run_dir, "journey-deliver-attendance-done.png").write_bytes(b"\x89PNG fake")
                return am.Proc(maestro_exit, "Running on emulator-5554\n" + ("x" * 20000), "boom" if maestro_exit else "")
            return adb_only()(host, argv, kw)

        host = FakeHost(handler)
        palette = io.BytesIO()
        with tarfile.open(fileobj=palette, mode="w:gz") as tf:
            data = b"appId: org.commcare.dalvik\n---\n- back\n"
            ti = tarfile.TarInfo("form-advance.yaml")
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
        host.s3 = {"s3://bkt/leases/L/in/recipe.yaml": b"appId: org.commcare.dalvik\n---\n- launchApp\n",
                   "s3://bkt/leases/L/in/palette.tar.gz": palette.getvalue()}
        return host

    ARGV = ["run-recipe", "--recipe", "s3://bkt/leases/L/in/recipe.yaml", "--palette",
            "s3://bkt/leases/L/in/palette.tar.gz", "--env", "PIN=1234", "--env", "NAME=A B",
            "--out", "s3://bkt/leases/L/out/smoke"]

    def test_pass(self):
        host = self._host()
        code, out = cli(self.ARGV, host)
        self.assertEqual(code, 0, out)
        self.assertTrue(out["ok"])
        self.assertEqual(out["exit_code"], 0)
        # The keys cloud.ts's CloudRunResult reads, plus the lease-era additions.
        for k in ("exit_code", "stdout", "stderr", "artifacts", "steps", "out", "result_uri"):
            self.assertIn(k, out)
        self.assertLessEqual(len(out["stdout"]), am.LOG_TAIL_CHARS)
        names = {a["name"] for a in out["artifacts"]}
        self.assertIn("journey-deliver-attendance-done.png", names)
        # The palette was extracted beside the recipe, but recipes are never
        # uploaded: the caller already has them.
        self.assertFalse(any(n.endswith((".yaml", ".yml")) for n in names), names)
        png = next(a for a in out["artifacts"] if a["name"].endswith(".png"))
        self.assertEqual(png["content_type"], "image/png")
        self.assertEqual(png["uri"], "s3://bkt/leases/L/out/smoke/journey-deliver-attendance-done.png")
        self.assertIn(png["uri"], host.uploads)
        self.assertIn("s3://bkt/leases/L/out/smoke/result.json", host.uploads)
        self.assertEqual(json.loads(host.uploads[out["result_uri"]])["exit_code"], 0)
        self.assertGreater(len(out["steps"]), 10)
        m = host.maestro_argv
        self.assertEqual(m[1:3], ["test", "--debug-output"])
        self.assertEqual(m[m.index("--env") + 1], "PIN=1234")
        self.assertIn("NAME=A B", m)
        self.assertTrue(m[-1].endswith(".yaml"))
        # The work dir is gone afterwards.
        self.assertEqual(list(Path(am.WORK_ROOT).iterdir()), [])

    def test_recipe_failure_still_uploads(self):
        host = self._host(maestro_exit=1, write_report=False)
        code, out = cli(self.ARGV, host)
        self.assertEqual((code, out["ok"], out["exit_code"], out["error"]), (1, False, 1, "recipe-failed"))
        self.assertEqual(out["steps"], [])
        self.assertIn("s3://bkt/leases/L/out/smoke/maestro-stderr.log", host.uploads)

    def test_missing_recipe_is_s3_failure(self):
        host = self._host()
        host.s3.pop("s3://bkt/leases/L/in/recipe.yaml")
        code, out = cli(self.ARGV, host)
        self.assertEqual((code, out["error"]), (1, "s3-download-failed"))

    def test_usage(self):
        host = self._host()
        self.assertEqual(cli(["run-recipe", "--recipe", "s3://bkt/r.yaml"], host)[0], 2)
        self.assertEqual(cli(["run-recipe", "--recipe", "s3://bkt/r.yaml", "--out", "/tmp/x"], host)[0], 2)
        self.assertEqual(cli([*self.ARGV, "--env", "bad"], host)[0], 2)

    def test_palette_cannot_escape(self):
        host = self._host()
        evil = io.BytesIO()
        with tarfile.open(fileobj=evil, mode="w:gz") as tf:
            ti = tarfile.TarInfo("../../escape.yaml")
            ti.size = 1
            tf.addfile(ti, io.BytesIO(b"x"))
        host.s3["s3://bkt/leases/L/in/palette.tar.gz"] = evil.getvalue()
        code, out = cli(self.ARGV, host)
        self.assertEqual((code, out["error"]), (1, "bad-palette"))
        self.assertFalse(Path(am.WORK_ROOT).parent.joinpath("escape.yaml").exists())


class RegisterTests(TmpPaths):
    def _host(self, part_a=(0, ""), part_b=(0, "")):
        seen: list[str] = []

        def handler(host, argv, kw):
            if argv[0] == am.MAESTRO:
                recipe = Path(argv[-1]).name
                seen.append(recipe)
                code, out = part_a if recipe == "to.yaml" else part_b
                return am.Proc(code, out, "")
            if argv[0] == am.ADB and argv[1:3] == ["shell", "pm"] and "gms" in argv[-1]:
                seen.append("gms:" + argv[3])
                return am.Proc(0, "", "")
            if argv[0] == am.ADB and argv[1:4] == ["shell", "locksettings", "set-pin"]:
                seen.append("lock-pin:" + argv[4])
                return am.Proc(0, "", "")
            return adb_only()(host, argv, kw)

        host = FakeHost(handler)
        host.seen = seen
        pal = io.BytesIO()
        with tarfile.open(fileobj=pal, mode="w:gz") as tf:
            for n in ("to.yaml", "from.yaml"):
                ti = tarfile.TarInfo(n)
                ti.size = 2
                tf.addfile(ti, io.BytesIO(b"x\n"))
        host.s3 = {"s3://bkt/in/pal.tgz": pal.getvalue(),
                   "s3://bkt/in/creds.json": json.dumps({"pin": "1111", "backup_code": "2222"}).encode()}
        return host

    ARGV = ["register-test-user", "--palette", "s3://bkt/in/pal.tgz", "--to-otp-recipe", "to.yaml",
            "--from-otp-recipe", "from.yaml", "--phone", "+74260000000", "--phone-local", "4260000000",
            "--country-code", "+7", "--name", "ACE Test", "--creds", "s3://bkt/in/creds.json"]

    def test_fresh_registration_toggles_gms_between_parts(self):
        host = self._host()
        code, out = cli(self.ARGV, host)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["already_registered"], False)
        # The code itself is never echoed (stdout lands in SSM history).
        self.assertEqual(out["backup_code_set"], True)
        self.assertNotIn("backup_code", out)
        self.assertNotIn("2222", json.dumps(out))
        # The device PIN is pre-set between the parts, so part B skips the
        # Settings lock chooser.
        self.assertEqual(host.seen, ["gms:enable", "to.yaml", "gms:disable-user", "lock-pin:1111", "from.yaml"])
        maestro_calls = [c for c in host.calls if c[0] == am.MAESTRO]
        self.assertIn("PIN=1111", maestro_calls[0])
        self.assertIn("BACKUP_CODE=2222", maestro_calls[1])

    def test_already_registered_short_circuits(self):
        host = self._host(part_a=(1, "... PHONE_ALREADY_REGISTERED ..."))
        code, out = cli(self.ARGV, host)
        self.assertEqual((code, out["already_registered"], out["backup_code_set"]), (0, True, False))
        self.assertNotIn("from.yaml", host.seen)

    def test_part_b_failure(self):
        host = self._host(part_b=(1, "Element not found"))
        code, out = cli(self.ARGV, host)
        self.assertEqual((code, out["error"]), (1, "register-part-b-failed"))
        self.assertEqual([p["part"] for p in out["parts"]], ["a", "b"])

    def test_recipe_name_traversal_refused(self):
        host = self._host()
        argv = list(self.ARGV)
        argv[argv.index("to.yaml")] = "../to.yaml"
        self.assertEqual(cli(argv, host)[0], 2)


class SmallCommandTests(TmpPaths):
    def test_ui_dump(self):
        xml = (FIX / "uiautomator-dump-postlearn-landing.xml").read_text()
        host = FakeHost(adb_only({
            ("shell", "uiautomator", "dump"): am.Proc(0, f"UI hierchary dumped to: {am.UI_DUMP_DEVICE_PATH}\n", ""),
            ("exec-out", "cat"): am.Proc(0, xml, ""),
        }))
        code, out = cli(["ui-dump", "--out", "s3://bkt/out/dumps"], host)
        self.assertEqual(code, 0)
        self.assertEqual(out["xml"], xml)
        self.assertFalse(out["failed"])
        self.assertEqual(out["uri"], "s3://bkt/out/dumps/ui-dump.xml")
        dump_call = next(c for c in host.calls if "uiautomator" in c)
        self.assertEqual(dump_call[-1], "/data/local/tmp/window_dump.xml")

    def test_ui_dump_failed(self):
        host = FakeHost(adb_only({
            ("shell", "uiautomator", "dump"): am.Proc(0, "ERROR: could not get idle state.", ""),
            ("exec-out", "cat"): am.Proc(1, "", "No such file or directory"),
        }))
        code, out = cli(["ui-dump"], host)
        self.assertEqual((code, out["ok"], out["failed"], out["xml"]), (1, False, True, ""))

    def test_screenshot(self):
        host = FakeHost(adb_only({("exec-out", "screencap", "-p"): am.Proc(0, b"\x89PNG\r\n\x1a\nrest", "")}))
        code, out = cli(["screenshot", "--out", "s3://bkt/out/adhoc", "--name", "now.png"], host)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["uri"], "s3://bkt/out/adhoc/now.png")
        self.assertEqual(host.uploads["s3://bkt/out/adhoc/now.png"][:4], b"\x89PNG")
        self.assertEqual(out["content_type"], "image/png")

    def test_screenshot_not_png(self):
        host = FakeHost(adb_only({("exec-out", "screencap", "-p"): am.Proc(0, b"error: closed", "")}))
        self.assertEqual(cli(["screenshot", "--out", "s3://bkt/o"], host)[1]["error"], "screenshot-failed")

    def test_install_apk(self):
        badging = (FIX / "aapt-badging-commcare-2.62.0.txt").read_text()

        def handler(host, argv, kw):
            if argv[0] == am.AAPT:
                return am.Proc(0, badging, "")
            return adb_only({("install", "-r"): am.Proc(0, "Performing Streamed Install\nSuccess\n", "")})(host, argv, kw)

        host = FakeHost(handler)
        host.https = {"https://example.org/cc.apk": b"PK"}
        code, out = cli(["install-apk", "--apk", "https://example.org/cc.apk"], host)
        self.assertEqual(code, 0, out)
        self.assertEqual(out, {"ok": True, "package_name": "org.commcare.dalvik", "version": "2.62.0",
                               "version_code": 486560})
        self.assertEqual(cli(["install-apk", "--apk", "/tmp/local.apk"], host)[0], 2)

    def test_install_apk_failure(self):
        host = FakeHost(adb_only({("install", "-r"): am.Proc(1, "Failure [INSTALL_FAILED_OLDER_SDK]", "")}))
        host.s3 = {"s3://bkt/in/x.apk": b"PK"}
        self.assertEqual(cli(["install-apk", "--apk", "s3://bkt/in/x.apk"], host)[1]["error"], "install-failed")

    def test_clear_app_data(self):
        host = FakeHost(adb_only({("shell", "pm", "clear"): am.Proc(0, "Success\n", "")}))
        self.assertEqual(cli(["clear-app-data"], host)[1],
                         {"ok": True, "package": "org.commcare.dalvik", "cleared": True})
        self.assertEqual(cli(["clear-app-data", "--package", "x; rm -rf /"], host)[0], 2)

    def test_repair_driver(self):
        host = FakeHost(adb_only({
            ("shell", "pm", "uninstall", "-k", "--user", "0", "dev.mobile.maestro.test"):
                am.Proc(0, "Failure [DELETE_FAILED_INTERNAL_ERROR]", ""),
            ("shell", "pm", "uninstall", "-k", "--user", "0", "dev.mobile.maestro"): am.Proc(0, "Success", ""),
        }))
        self.assertEqual(cli(["repair-driver"], host)[1], {"ok": True, "uninstalled_packages": ["dev.mobile.maestro"]})

    def test_install_driver_warm(self):
        host = FakeHost(adb_only({("shell", "pm", "list", "packages"):
                                  am.Proc(0, "package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n", "")}))
        self.assertEqual(cli(["install-driver"], host)[1], {"ok": True, "actions": ["already-installed"]})

    def test_install_driver_cold(self):
        Path(am.MAESTRO_LIB_DIR).mkdir(parents=True)
        with zipfile.ZipFile(am.MAESTRO_JAR_PATH, "w") as z:
            z.writestr("maestro-app.apk", b"app")
            z.writestr("maestro-server.apk", b"server")
        lists = iter([am.Proc(0, "", ""),
                      am.Proc(0, "package:dev.mobile.maestro\npackage:dev.mobile.maestro.test\n", "")])
        host = FakeHost(adb_only({
            ("shell", "pm", "list", "packages"): lambda *_: next(lists),
            ("shell", "cmd", "package", "list"): am.Proc(0, "package:android\n", ""),
            ("install", "-r"): am.Proc(0, "Success", ""),
        }))
        code, out = cli(["install-driver"], host)
        self.assertEqual(code, 0, out)
        self.assertEqual(out["actions"], ["pm-ready", "extracted", "installed:app", "installed:test", "verified"])

    def test_install_driver_no_jar(self):
        host = FakeHost(adb_only({("shell", "pm", "list", "packages"): am.Proc(0, "", ""),
                                  ("shell", "cmd", "package", "list"): am.Proc(0, "package:android\n", "")}))
        self.assertEqual(cli(["install-driver"], host)[1]["error"], "maestro-jar-missing")

    def test_snapshot_ko_is_failure(self):
        host = FakeHost(adb_only({("emu", "avd", "snapshot", "save"):
                                  am.Proc(0, 'KO: Snapshot save is disabled because "-read-only" was specified', "")}))
        code, out = cli(["snapshot", "save", "--name", "pre-submit"], host)
        self.assertEqual((code, out["ok"], out["error"], out["saved_at"]), (1, False, "snapshot-save-failed", None))
        host = FakeHost(adb_only({("emu", "avd", "snapshot", "load"): am.Proc(0, "OK", "")}))
        code, out = cli(["snapshot", "load", "--name", "pre-submit"], host)
        self.assertEqual((code, out["ok"]), (0, True))
        self.assertIsNotNone(out["loaded_at"])

    def test_set_location_longitude_first(self):
        host = FakeHost(adb_only({("emu", "geo", "fix"): am.Proc(0, "OK", "")}))
        code, out = cli(["set-location", "--lon", "8.5167", "--lat", "12.0022"], host)
        self.assertEqual(code, 0, out)
        call = next(c for c in host.calls if "geo" in c)
        self.assertEqual(call[-4:], ["8.5167", "12.0022", "480", "12"])
        self.assertEqual((out["longitude"], out["latitude"], out["applied"]), (8.5167, 12.0022, True))
        self.assertEqual(cli(["set-location", "--lon", "200", "--lat", "0"], host)[0], 2)

    def test_diagnose(self):
        Path(am.READY_MARKER).write_text("")
        Path(am.ACTIVE_STATE_PATH).write_text("cc-2.63.0\n")
        Path(am.LEASE_PATH).write_text(json.dumps({"lease_id": "L1", "state": "cc-2.63.0"}))
        Path(am.RUNNER_LOG).write_text("a\nb\n[ace-emulator-launch] AVD ready\n")

        def handler(host, argv, kw):
            if argv[0] == "pgrep":
                return am.Proc(0, "4242 /opt/android-sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -avd X\n", "")
            if argv[0] == "systemctl":
                return am.Proc(0, "active\n", "")
            return adb_only()(host, argv, kw)

        code, out = cli(["diagnose"], FakeHost(handler))
        self.assertEqual(code, 0)
        for k in ("ssm_ok", "ssm_error", "adb_devices", "adb_visible_count", "emulator_pid", "emulator_cmdline",
                  "runner_service_state", "marker_present", "marker_age_seconds", "runner_log_tail",
                  "emulator_log_tail", "accel", "kvm_nested", "kvm_dev_present"):
            self.assertIn(k, out)  # every field of the retired ace-web Diagnostics shape
        self.assertEqual((out["adb_visible_count"], out["emulator_pid"], out["healthy"]), (1, 4242, True))
        self.assertEqual(out["active_state"], "cc-2.63.0")
        self.assertEqual(out["lease"], {"lease_id": "L1", "state": "cc-2.63.0"})
        self.assertIn("AVD ready", out["runner_log_tail"])


# ── Boot hook planning ───────────────────────────────────────────────────────

STATES = {"default": "cc-2.64.0", "states": [{"name": "cc-2.64.0"}, {"name": "cc-2.62.0"}]}


class BootPlanTests(unittest.TestCase):
    def ctx(self, ud=None, err=None, uptime=40.0):
        return am.BootContext(instance_id="i-1", region="us-east-1", user_data=ud or {}, user_data_error=err,
                              uptime_s=uptime)

    def test_happy(self):
        ud = {"lease_id": "L", "bucket": "bkt", "max_lifetime_s": 3600, "params": {"state": "cc-2.62.0"}}
        plan = am.plan_boot(self.ctx(ud), STATES, kvm_present=True)
        self.assertNotIn("fail", plan)
        self.assertEqual((plan["state"], plan["bucket"], plan["halt_in_s"]), ("cc-2.62.0", "bkt", 3560))

    def test_default_state_when_params_omit_it(self):
        plan = am.plan_boot(self.ctx({"bucket": "b", "params": {}}), STATES, True)
        self.assertEqual(plan["state"], "cc-2.64.0")
        self.assertEqual(plan["halt_in_s"], am.DEFAULT_MAX_LIFETIME_S - 40)

    def test_failures(self):
        self.assertEqual(am.plan_boot(self.ctx({"bucket": "b", "params": {"state": "cc-9"}}), STATES, True)["fail"][0],
                         "unknown-state")
        self.assertEqual(am.plan_boot(self.ctx({"bucket": "b"}), STATES, False)["fail"][0], "no-kvm")
        self.assertEqual(am.plan_boot(self.ctx({"params": {}}), STATES, True)["fail"][0], "bad-user-data")
        self.assertEqual(am.plan_boot(self.ctx(err="no user-data"), STATES, True)["fail"][0], "bad-user-data")
        self.assertEqual(am.plan_boot(self.ctx({"bucket": "b"}), {"default": "", "states": []}, True)["fail"][0],
                         "no-states")

    def test_halt_never_below_a_minute(self):
        plan = am.plan_boot(self.ctx({"bucket": "b", "max_lifetime_s": 30}, uptime=100), STATES, True)
        self.assertEqual(plan["halt_in_s"], 60)

    def test_user_data_parsing(self):
        raw = json.dumps({"lease_id": "L", "params": {}, "max_lifetime_s": 10, "bucket": "b"})
        self.assertEqual(am.parse_user_data(raw)[0]["lease_id"], "L")
        import base64
        self.assertEqual(am.parse_user_data(base64.b64encode(raw.encode()).decode())[0]["bucket"], "b")
        self.assertIsNotNone(am.parse_user_data("")[1])
        self.assertIsNotNone(am.parse_user_data("#cloud-config\n")[1])
        self.assertIsNotNone(am.parse_user_data("[1]")[1])

    def test_ready_key_is_the_role_session_prefix(self):
        # The stack's instance role may write only vm/${aws:userid}/*, and an
        # instance-profile session's userid is "<role-id>:<instance-id>".
        host = FakeHost(lambda h, argv, kw: am.Proc(0, "AROAEXAMPLE:i-0abc\n", ""))
        uid = am.caller_userid(host)
        self.assertEqual(uid, "AROAEXAMPLE:i-0abc")
        self.assertEqual(am.ready_key(uid, "i-0abc"), "vm/AROAEXAMPLE:i-0abc/ready.json")
        self.assertEqual(am.ready_key(None, "i-0abc"), "vm/i-0abc/ready.json")
        failing = FakeHost(lambda h, argv, kw: am.Proc(255, "", "Unable to locate credentials"))
        self.assertIsNone(am.caller_userid(failing))

    def test_ready_payload_shape(self):
        p = am.ready_payload(False, "no-kvm", {"hook_s": 1.0}, self.ctx(), "cc-2.63.0", "x" * 5000)
        self.assertEqual(p["ok"], False)
        self.assertEqual(p["reason"], "no-kvm")
        self.assertEqual(p["cli_version"], am.CLI_VERSION)
        self.assertLessEqual(len(p["detail"]), 2000)
        self.assertNotIn("reason", am.ready_payload(True, None, {}, self.ctx(), "cc-2.63.0"))


if __name__ == "__main__":
    unittest.main()
