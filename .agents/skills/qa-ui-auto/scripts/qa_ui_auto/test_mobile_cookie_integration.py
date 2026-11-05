"""Cookie case wiring only; real browser/native execution is separate evidence."""
import argparse
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from .ci import make_plan
from .control_coverage import _touches_for_case
from .deadline import BudgetedPage, Deadline
from .fixtures import mobile_service, mobile_web
from .native_steps import NativeStepContext, VERBS
from .steps import StepContext, StepError, get
from .testcase import load_case


ROOT = Path(__file__).resolve().parents[5]
CASES = ROOT / 'qa-ui-auto-tests/cases'
BROWSER_ID = 'TC-MOBILE-012'
NATIVE_ID = 'TC-MOBILE-013'


class CookieProbeDispatchTest(unittest.TestCase):
    def browser_context(self, folder, *, dry_run=False):
        return StepContext(page=Mock(), case_id=BROWSER_ID, case_dir=Path(folder),
                           cfg={'app': {'mode': 'browser'}}, env={}, dry_run=dry_run,
                           values={'mobile_endpoint': 'http://127.0.0.1:12345',
                                   'mobile_assets': '/immutable/phone-assets'})

    def test_browser_reuses_runner_browser_and_fixture_production_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = self.browser_context(folder)
            with patch('qa_ui_auto.mobile_cookie_probe.probe') as probe:
                get('mobile_browser_probe')(ctx, 'cookie-gateway')
            probe.assert_called_once_with('http://127.0.0.1:12345', 'qa-mobile-code', Path(folder),
                                          assets='/immutable/phone-assets', browser=ctx.page.context.browser)
            self.assertNotIn('real_pty', probe.call_args.kwargs)

    def test_budget_proxy_is_unwrapped_so_playwright_expect_receives_real_locators(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = self.browser_context(folder)
            browser = SimpleNamespace(_impl_obj=object())
            page = SimpleNamespace(_impl_obj=object(),
                                   context=SimpleNamespace(_impl_obj=object(), browser=browser))
            ctx.page = BudgetedPage(page, Deadline(10))
            with patch('qa_ui_auto.mobile_cookie_probe.probe') as probe:
                get('mobile_browser_probe')(ctx, 'cookie-gateway')
            self.assertIs(probe.call_args.kwargs['browser'], browser)

    def test_missing_runner_browser_never_falls_back_to_nested_playwright(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = self.browser_context(folder)
            ctx.page.context.browser = None
            with patch('qa_ui_auto.mobile_cookie_probe.probe') as probe:
                with self.assertRaisesRegex(StepError, 'existing runner Browser'):
                    get('mobile_browser_probe')(ctx, 'cookie-gateway')
            probe.assert_not_called()

    def test_browser_dry_run_never_opens_gateway_or_nested_playwright(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = self.browser_context(folder, dry_run=True)
            with patch('qa_ui_auto.mobile_cookie_probe.probe') as probe:
                get('mobile_browser_probe')(ctx, 'cookie-gateway')
            probe.assert_not_called()
            ctx.page.assert_not_called()

    def test_browser_rejects_invalid_mode_and_preserves_oracle_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = self.browser_context(folder)
            with patch('qa_ui_auto.mobile_cookie_probe.probe', side_effect=AssertionError('oracle failed')):
                with self.assertRaisesRegex(AssertionError, 'oracle failed'):
                    get('mobile_browser_probe')(ctx, 'cookie-gateway')
            ctx.cfg['app']['mode'] = 'native'
            with self.assertRaisesRegex(StepError, 'requires browser mode'):
                get('mobile_browser_probe')(ctx, 'cookie-gateway')

    def test_native_requires_real_pty_and_uses_embedded_assets_without_override(self):
        with tempfile.TemporaryDirectory() as folder:
            session = Mock()
            ctx = NativeStepContext(session, Path(folder), {'app': {'mode': 'native'}})
            with patch('qa_ui_auto.mobile_native.address', return_value='http://127.0.0.1:12345'), \
                 patch('qa_ui_auto.mobile_native.text', return_value='disposable-fixture-code') as code, \
                 patch('qa_ui_auto.mobile_cookie_probe.probe') as probe:
                VERBS['mobile_service_probe'](ctx, 'cookie-gateway')
            code.assert_called_once_with(ctx, '[data-testid="mobile-settings-code"]')
            probe.assert_called_once_with('http://127.0.0.1:12345', 'disposable-fixture-code', Path(folder), real_pty=True)
            self.assertNotIn('assets', probe.call_args.kwargs)
            self.assertNotIn('browser', probe.call_args.kwargs)
            session.execute.assert_not_called()


class CookieFixtureWiringTest(unittest.TestCase):
    def test_browser_fixture_exposes_immutable_assets_and_receipt_then_cleans_up(self):
        with tempfile.TemporaryDirectory() as folder:
            snapshot = tempfile.TemporaryDirectory()
            ctx = SimpleNamespace(cfg={'app': {'mode': 'browser'}}, case_id=BROWSER_ID,
                                  case_dir=Path(folder), values={})
            with patch.object(mobile_web, 'build_snapshot', return_value=snapshot):
                try:
                    mobile_web.setup(ctx)
                    self.assertEqual(ctx.values['mobile_assets'], str(Path(snapshot.name).resolve()))
                    self.assertEqual(ctx.values['mobile_cookie_receipt'], str((Path(folder) / 'mobile-cookie-gateway-receipt.json').resolve()))
                    self.assertTrue(ctx.values['mobile_endpoint'].startswith('http://127.0.0.1:'))
                finally:
                    mobile_web.teardown(ctx)
            self.assertFalse(Path(snapshot.name).exists())

    def test_mobile_web_never_becomes_a_native_stub_for_either_cookie_case(self):
        for case_id in (BROWSER_ID, NATIVE_ID):
            with self.subTest(case=case_id):
                ctx = SimpleNamespace(cfg={'app': {'mode': 'native'}}, case_id=case_id)
                with self.assertRaisesRegex(RuntimeError, 'browser fixture'):
                    mobile_web.setup(ctx)

    def test_native_assigns_gateway_paths_without_changing_saved_projection(self):
        with tempfile.TemporaryDirectory() as folder:
            ctx = SimpleNamespace(case_id=NATIVE_ID, case_dir=Path(folder), values={})
            with patch.object(mobile_service, 'seed_sessions') as seed:
                mobile_service.setup(ctx)
            self.assertEqual([row['id'] for row in seed.call_args.args[1]],
                             ['mobile-saved-ssh', 'mobile-hidden-RDP', 'mobile-hidden-MySQL', 'mobile-hidden-VNC'])
            self.assertEqual(Path(ctx.values['mobile_cookie_receipt']), Path(folder) / 'mobile-cookie-gateway-receipt.json')
            self.assertEqual(Path(ctx.values['mobile_cookie_marker']), Path(folder) / 'gateway-real-pty-marker.txt')


class CookieCaseCatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.browser = load_case(CASES / 'TC-MOBILE-012-cookie-gateway-browser.testcase.yaml')
        cls.native = load_case(CASES / 'TC-MOBILE-013-cookie-gateway-native.testcase.yaml')

    def test_cases_are_reviewed_crash_regressions_with_truthful_mode_fixtures(self):
        for case in (self.browser, self.native):
            self.assertIn('crash-regression', case.tags)
            self.assertEqual(case.verification['review'], 'reviewed')
            self.assertIsNone(case.skip)
        self.assertEqual(self.browser.modes, ['browser'])
        self.assertEqual(self.browser.fixtures, ['mobile_web'])
        self.assertEqual(self.native.modes, ['native'])
        self.assertEqual(self.native.fixtures, ['reset_db', 'mobile_service'])
        self.assertIn({'mobile_browser_probe': 'cookie-gateway'}, self.browser.steps)
        self.assertIn({'mobile_service_probe': 'cookie-gateway'}, self.native.steps)

    def test_control_mapping_distinguishes_observation_from_real_actions_and_native_pty(self):
        def touches(verb):
            case = SimpleNamespace(id='TC-MOBILE-COOKIE', steps=[{verb: 'cookie-gateway'}])
            return {(touch.selector, touch.kind) for touch in _touches_for_case(case)}
        browser = touches('mobile_browser_probe')
        native = touches('mobile_service_probe')
        self.assertIn(('[data-testid="mobile-pair-submit"]', 'interactive'), browser)
        self.assertIn(('[data-testid="mobile-pair-error"]', 'display'), browser)
        self.assertNotIn(('[data-testid="mobile-pair-error"]', 'interactive'), browser)
        self.assertNotIn(('[data-testid="mobile-open-local"]', 'interactive'), browser)
        self.assertIn(('[data-testid="mobile-open-local"]', 'interactive'), native)
        self.assertIn(('[data-testid="mobile-terminal-command-send"]', 'interactive'), native)
        self.assertIn(('[data-testid="mobile-terminal-status"]', 'display'), native)
        self.assertTrue(browser.issubset(native))

    def test_hosted_plan_registers_both_exact_cases_on_all_three_platforms(self):
        options = argparse.Namespace(scope='selected', head='', base='',
                                     platforms='linux,windows,macos', modes='browser,native',
                                     case_ids=BROWSER_ID + ',' + NATIVE_ID, features='', tags='', shards='1')
        plan = make_plan(options)
        self.assertEqual(len(plan['entries']), 6)
        self.assertFalse(plan['gaps'])
        self.assertFalse(plan['unreviewed'])
        for entry in plan['entries']:
            with self.subTest(entry=entry['id']):
                native = entry['mode'] == 'native'
                self.assertEqual(entry['selected_ids'], [NATIVE_ID if native else BROWSER_ID])
                self.assertEqual('mobile' in entry['capabilities'], native)
                self.assertIn(entry['platform'], ('Linux', 'Windows', 'macOS'))


if __name__ == '__main__':
    unittest.main()
