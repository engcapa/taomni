"""Independent regression oracles for expanded commercial native coverage."""
import json
from pathlib import Path
import subprocess
import unittest

import yaml

from qa_ui_auto.steps import StepError
from qa_ui_auto.tao_real_code import verify_average
from qa_ui_auto.tao_real_images import FILES
from qa_ui_auto.testcase import validate_doc


class ExpandedTests(unittest.TestCase):
    def test_actual_arithmetic_accepts_guard_or_ternary(self):
        for code in ("def average(v):\n return sum(v)/len(v) if v else None\n",
                     "def average(v):\n if len(v)==0:\n  return None\n return sum(v)/len(v)\n"):
            verify_average(code)

    def test_arithmetic_rejects_bug_and_unsafe_or_irrelevant_code(self):
        for code in ("def average(v):\n return sum(v)//len(v) if v else None\n",
                     "def average(v):\n return 4.5\n",
                     "def average(v):\n return __import__('os').system('anything')\n",
                     "def average(v):\n while True: pass\n",
                     "def average(v):\n return sum(v)/len(v) if v else 0\n",
                     "def wrong(v): return None\n"):
            with self.subTest(code=code), self.assertRaises(StepError):
                verify_average(code)

    def test_file_oracle_requires_explicit_credential_error_and_never_returns_reserved_error_key(self):
        for error, expected in (("file: not supported", False), ("upload returned HTTP 401", True),
                                ("upload returned HTTP 500", False), ("network failed", False)):
            html = '<section data-tao-active="true"><section data-testid="tao-home-files"><p role="alert">' + error + '</p></section></section>'
            script = "const {JSDOM}=require('jsdom');const w=new JSDOM(process.argv[1]).window;w.__taomniQaTaoProvider={observe:()=>({files:[]})};const result=new Function('window','document',process.argv[2])(w,w.document);process.stdout.write(JSON.stringify(result));"
            result = subprocess.run(["node", "-e", script, html, FILES], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(result.stdout)
            self.assertEqual(state["credentialInvalid"], expected)
            self.assertEqual(state["uploadError"], error)
            self.assertNotIn("error", state)

    def test_every_new_case_has_a_valid_reviewed_execution_contract(self):
        root = Path(__file__).resolve().parents[4]
        for number in range(14, 24):
            paths = list((root / "qa-ui-auto-tests/cases").glob(f"TC-TAO-HOME-{number:03d}-*.testcase.yaml"))
            self.assertEqual(len(paths), 1)
            doc = yaml.safe_load(paths[0].read_text(encoding="utf-8"))
            self.assertEqual(validate_doc(doc, source=str(paths[0])), [])
            self.assertEqual(doc["verification"]["review"], "reviewed")


if __name__ == "__main__":
    unittest.main()
