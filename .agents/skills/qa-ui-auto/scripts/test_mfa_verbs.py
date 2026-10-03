"""MFA authenticator verbs: RFC oracle, argument contracts, schema and platform scope."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

import jsonschema

from qa_ui_auto import mfa_support, verification
from qa_ui_auto.otp import hotp, totp_candidates
from qa_ui_auto.steps import StepContext, StepError, get
from qa_ui_auto.testcase import TestCase as Case

SCHEMA = Path(".agents/skills/qa-ui-auto/schema/testcase.schema.json")
FIXTURE = "qa-ui-auto-tests/synthetic-fixtures/mfa/hotp-qa-bank.png"
RFC6238 = {  # RFC 6238 appendix B (8 digits)
    "SHA1": ("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "94287082"),
    "SHA256": ("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA", "46119246"),
    "SHA512": ("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
               "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA", "90693936"),
}


class OracleTest(TestCase):
    def test_rfc4226_hotp_vectors(self):
        codes = [hotp(b"12345678901234567890", c) for c in range(10)]
        self.assertEqual(codes, ["755224", "287082", "359152", "969429", "338314",
                                 "254676", "287922", "162583", "399871", "520489"])

    def test_rfc6238_totp_vectors_and_rollover_grace(self):
        for algorithm, (secret, code) in RFC6238.items():
            with self.subTest(algorithm=algorithm):
                self.assertEqual(totp_candidates(secret, digits=8, algorithm=algorithm, now=59), {1: code})
        early = totp_candidates(RFC6238["SHA1"][0], digits=8, now=61)
        self.assertEqual(list(early), [1, 2])
        self.assertEqual(early[1], "94287082")

    def test_rejects_bad_secrets(self):
        with self.assertRaises(ValueError):
            totp_candidates("not base32!", now=0)


class AssertTotpTest(TestCase):
    secret = "JBSWY3DPEHPK3PXP"

    def check(self, observed, **extra):
        args = {"selector": "[data-testid='code']", "secret": self.secret, "timeout_sec": 0.3, **extra}
        return mfa_support.assert_totp_code(lambda _expr: observed, args)

    def test_accepts_the_current_code_from_one_element(self):
        current = totp_candidates(self.secret)
        self.assertIn("TOTP matched", self.check([list(current.values())[-1]]))

    def test_rejects_wrong_missing_and_duplicate_codes(self):
        code = list(totp_candidates(self.secret).values())[-1]
        wrong = str((int(code) + 1) % 1_000_000).zfill(6)
        for observed in ([wrong], [], [code, code]):
            with self.subTest(observed=observed), self.assertRaisesRegex(StepError, "RFC 6238 expects"):
                self.check(observed)

    def test_argument_contract(self):
        for args in ({"selector": "x"}, {"selector": "x", "secret": self.secret, "algorithm": "MD5"},
                     {"selector": "x", "secret": "short"}):
            with self.subTest(args=args), self.assertRaises(StepError):
                mfa_support.totp_args(args)


class FixtureAndBrowserVerbTest(TestCase):
    def test_png_fixture_resolves_from_repository_root(self):
        path, data = mfa_support.png_fixture(FIXTURE, "verb")
        self.assertTrue(path.is_absolute())
        self.assertTrue(data.startswith(mfa_support.PNG_SIGNATURE))
        with TemporaryDirectory() as tmp:
            fake = Path(tmp) / "fake.png"
            fake.write_text("not a png")
            with self.assertRaisesRegex(StepError, "not a PNG"):
                mfa_support.png_fixture(str(fake), "verb")
        with self.assertRaisesRegex(StepError, "cannot read"):
            mfa_support.png_fixture("missing.png", "verb")

    def test_browser_verbs_validate_in_dry_run(self):
        ctx = StepContext(page=mock.Mock(), case_id="TC", case_dir=Path("."), cfg={}, env={}, dry_run=True)
        get("seed_clipboard_image")(ctx, {"path": FIXTURE})
        get("browser_fake_camera")(ctx, {"mode": "qr", "image": FIXTURE})
        get("browser_fake_camera")(ctx, {"mode": "none"})
        for args in ({"mode": "flash"}, {"mode": "qr"}):
            with self.subTest(args=args), self.assertRaises(StepError):
                get("browser_fake_camera")(ctx, args)
        ctx.page.evaluate.assert_not_called()


class SchemaAndPlatformTest(TestCase):
    def setUp(self):
        self.validator = jsonschema.Draft202012Validator(json.loads(SCHEMA.read_text(encoding="utf-8")))

    def valid(self, step):
        return self.validator.is_valid({"id": "TC-X", "title": "x", "steps": [step]})

    def test_schema_accepts_documented_forms_only(self):
        good = [
            {"seed_clipboard_image": {"path": FIXTURE}},
            {"browser_fake_camera": {"mode": "qr", "image": FIXTURE}},
            {"browser_fake_camera": {"mode": "denied"}},
            {"assert_totp_code": {"selector": "[data-testid='c']", "secret": "JBSWY3DPEHPK3PXP", "digits": 8}},
            {"native_clipboard_image": {"path": FIXTURE}},
            {"native_show_image_window": {"path": FIXTURE, "x": 10}},
            {"native_show_image_window": {"action": "close"}},
        ]
        bad = [
            {"seed_clipboard_image": {"path": "image.jpg"}},
            {"browser_fake_camera": {"mode": "qr"}},
            {"browser_fake_camera": {"mode": "none", "image": FIXTURE}},
            {"assert_totp_code": {"selector": "x", "secret": "JBSWY3DPEHPK3PXP", "digits": 9}},
            {"native_show_image_window": {"action": "show"}},
            {"native_show_image_window": {"action": "close", "path": FIXTURE}},
        ]
        for step in good:
            with self.subTest(step=step):
                self.assertTrue(self.valid(step))
        for step in bad:
            with self.subTest(step=step):
                self.assertFalse(self.valid(step))

    def test_native_platform_scope(self):
        clipboard = Case(id="TC-a", title="a", modes=["native"], steps=[{"native_clipboard_image": {"path": FIXTURE}}])
        window = Case(id="TC-b", title="b", modes=["native"], steps=[{"native_show_image_window": {"path": FIXTURE}}])
        self.assertIsNone(verification.native_support(clipboard, "Linux"))
        self.assertIn("Linux/X11", verification.native_support(clipboard, "Windows"))
        self.assertIsNone(verification.native_support(window, "Windows"))
        self.assertIn("Linux/Windows", verification.native_support(window, "macOS"))
