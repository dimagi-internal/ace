"""What a run uploads and prints: redaction, the artifact allowlist and its
debug/ flattening, the inline-size budget, and upload failures that must not
discard a run's outcome."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from _support import FIX, FakeHost, TmpPaths, adb_only, am, cli


class RedactorTests(unittest.TestCase):
    def test_env_values_by_key(self):
        r = am.Redactor.for_env({"PIN": "4321", "BACKUP_CODE": "98765", "NAME": "Asha", "PHONE_LOCAL": "4260000000"})
        self.assertEqual(r.text("pin 4321 code 98765 name Asha phone 4260000000"),
                         "pin <redacted> code <redacted> name Asha phone <redacted>")

    def test_short_values_never_redacted(self):
        self.assertEqual(am.Redactor(["12"]).text("12 of 120"), "12 of 120")

    def test_longest_secret_first(self):
        self.assertEqual(am.Redactor(["1234", "123456"]).text("x123456x"), "x<redacted>x")

    def test_define_variables_env_redacted_whatever_the_key(self):
        data = json.loads((FIX / "maestro-commands-passed-2.5.1.json").read_text())
        out = am.Redactor().obj(data)
        defs = [c for c in out if "defineVariablesCommand" in json.dumps(c)]
        self.assertTrue(defs)
        for c in defs:
            self.assertEqual(c["command"]["defineVariablesCommand"]["env"], {"SCREENSHOT_NAME": "<redacted>"})
            self.assertEqual(c["metadata"]["evaluatedCommand"]["defineVariablesCommand"]["env"],
                             {"SCREENSHOT_NAME": "<redacted>"})

    def test_typed_secret_redacted_everywhere(self):
        data = [{"command": {"inputTextCommand": {"text": "4321"}}, "metadata": {"status": "COMPLETED"}}]
        raw = am.Redactor(["4321"]).json_bytes(json.dumps(data).encode())
        self.assertNotIn(b"4321", raw)

    def test_non_json_falls_back_to_text(self):
        self.assertEqual(am.Redactor(["4321"]).json_bytes(b"not json 4321"), b"not json <redacted>")


class StageArtifactsTests(unittest.TestCase):
    def test_allowlist_flattening_and_redaction(self):
        with tempfile.TemporaryDirectory() as d:
            run, stage = Path(d, "run"), Path(d, "stage")
            files = {
                "journey/a.png": b"\x89PNG",
                "video.mp4": b"mp4",
                "ui.xml": b"<hierarchy pin='4321'/>",
                "maestro-stdout.log": b"typed 4321",
                "recipe-abc.yaml": b"- launchApp",
                "form-advance.yaml": b"- back",
                "commands-(recipe.yaml).json": json.dumps([{"command": {"inputTextCommand": {"text": "4321"}}}]).encode(),
                "maestro.log": b"env PIN=4321",
                "screenshot-❌-1700000000-(recipe).png": b"\x89PNG",
                ".maestro/tests/2026-10-14_1/commands-(sub.yaml).json": b"[]",
                ".maestro/tests/2026-10-14_2/commands-(sub.yaml).json": b"[]",
                ".cache/x.png": b"\x89PNG",
                "notes.txt": b"no",
            }
            for rel, body in files.items():
                p = run / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(body)
            am.stage_artifacts(str(run), str(stage), am.Redactor(["4321"]))
            got = sorted(p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file())
            self.assertEqual(got, sorted([
                "journey/a.png", "video.mp4", "ui.xml", "maestro-stdout.log",
                "debug/commands-(recipe.yaml).json", "debug/maestro.log",
                "debug/screenshot-❌-1700000000-(recipe).png",
                "debug/commands-(sub.yaml).json", "debug/2026-10-14_2-commands-(sub.yaml).json",
            ]))
            for rel in ("ui.xml", "maestro-stdout.log", "debug/commands-(recipe.yaml).json", "debug/maestro.log"):
                self.assertNotIn(b"4321", (stage / rel).read_bytes(), rel)
            self.assertEqual((stage / "journey/a.png").read_bytes(), b"\x89PNG")  # binaries untouched


class FitInlineTests(unittest.TestCase):
    def test_small_result_untouched_but_counted(self):
        out = am.fit_inline({"ok": True, "artifacts": [{"name": "a"}]})
        self.assertEqual(out["artifacts_total"], 1)
        self.assertNotIn("inline_truncated", out)

    def test_artifact_cap(self):
        out = am.fit_inline({"ok": True, "artifacts": [{"name": str(i)} for i in range(40)]})
        self.assertEqual((len(out["artifacts"]), out["artifacts_total"]), (am.ARTIFACTS_INLINE_MAX, 40))
        self.assertEqual(out["inline_truncated"], ["artifacts"])

    def test_sheds_in_order_until_under_budget(self):
        steps = [{"index": i, "name": "x" * 300, "status": "fail" if i == 3 else "pass"} for i in range(200)]
        res = {"ok": False, "stdout": "o" * 8000, "stderr": "e" * 8000, "steps": steps,
               "artifacts": [{"name": "a" * 200} for _ in range(25)]}
        out = am.fit_inline(res)
        self.assertLessEqual(len(json.dumps(out, separators=(",", ":"))), am.INLINE_BUDGET_CHARS)
        self.assertEqual(len(out["stdout"]), 2000)
        self.assertIn("stdout", out["inline_truncated"])
        self.assertIn("steps", out["inline_truncated"])
        self.assertEqual(out["steps_total"], 200)
        if out["steps"]:
            self.assertIn(3, [s["index"] for s in out["steps"]])  # the failing step survives
        self.assertEqual(len(res["stdout"]), 8000)  # the full result is not mutated


class UploadFailureTests(TmpPaths):
    def test_run_recipe_upload_failure_keeps_the_outcome(self):
        def handler(host, argv, kw):
            if argv[0] == am.MAESTRO:
                Path(kw["cwd"], "commands-(r.yaml).json").write_bytes(
                    (FIX / "maestro-commands-passed-2.5.1.json").read_bytes())
                return am.Proc(0, "ok", "")
            return adb_only()(host, argv, kw)

        class FailingUploads(FakeHost):
            def run(self, argv, **kw):
                if argv[:3] == ["aws", "s3", "cp"] and not argv[-2].startswith("s3://"):
                    self.calls.append(list(argv))
                    return am.Proc(1, "", "upload failed: AccessDenied")
                return super().run(argv, **kw)

        host = FailingUploads(handler)
        host.s3 = {"s3://b/in/r.yaml": b"- launchApp"}
        code, out = cli(["run-recipe", "--recipe", "s3://b/in/r.yaml", "--out", "s3://b/out/x"], host)
        self.assertEqual(code, 1)
        self.assertEqual((out["exit_code"], out["error"]), (0, "s3-upload-failed"))
        self.assertIn("AccessDenied", out["upload_error"])
        self.assertGreater(len(out["steps"]), 10)


if __name__ == "__main__":
    unittest.main()
