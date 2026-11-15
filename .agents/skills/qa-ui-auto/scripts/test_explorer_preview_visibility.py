"""Actual toolbar-only idempotent preview visibility contracts, no app launch."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto import explorer_preview_visibility as preview
from qa_ui_auto.steps import StepError
from qa_ui_auto.control_coverage import _touches_for_case


class PreviewVisibilityTests(TestCase):
    def test_visible_native_preview_is_not_toggled(self):
        with TemporaryDirectory() as tmp:
            session=SimpleNamespace(execute=Mock(return_value={'active':1,'visible':True}),click=Mock())
            ctx=SimpleNamespace(case_dir=Path(tmp),session=session)
            preview.native(ctx,None)
            session.click.assert_not_called()
            result=json.loads((ctx.case_dir/'explorer-preview-visibility.jsonl').read_text())
            self.assertEqual(result['clickCount'],0);self.assertTrue(result['passed'])

    def test_hidden_browser_preview_gets_one_real_toolbar_click_then_waits(self):
        with TemporaryDirectory() as tmp:
            page=Mock();page.evaluate.side_effect=[{'active':1,'visible':False},{'active':1,'visible':True}]
            ctx=SimpleNamespace(case_dir=Path(tmp),page=page)
            preview.browser(ctx,None)
            page.locator.assert_called_once_with(preview.BUTTON)
            page.locator.return_value.click.assert_called_once()
            result=json.loads((ctx.case_dir/'explorer-preview-visibility.jsonl').read_text())
            self.assertEqual(result['clickCount'],1);self.assertTrue(result['passed'])

    def test_uncertain_click_error_is_retained_and_not_replayed(self):
        with TemporaryDirectory() as tmp:
            session=SimpleNamespace(execute=Mock(return_value={'active':1,'visible':False}),click=Mock(side_effect=StepError('input failed')))
            ctx=SimpleNamespace(case_dir=Path(tmp),session=session)
            with self.assertRaisesRegex(StepError,'input failed'):preview.native(ctx,None)
            session.click.assert_called_once()
            self.assertFalse(json.loads((ctx.case_dir/'explorer-preview-visibility.jsonl').read_text())['passed'])

    def test_missing_or_ambiguous_explorer_fails_before_input(self):
        with TemporaryDirectory() as tmp:
            session=SimpleNamespace(execute=Mock(return_value={'active':2,'visible':False}),click=Mock())
            ctx=SimpleNamespace(case_dir=Path(tmp),session=session)
            with self.assertRaisesRegex(StepError,'unique'):preview.native(ctx,None)
            session.click.assert_not_called()
            with self.assertRaises(StepError):preview.native(ctx,{})

    def test_coverage_retains_real_toolbar_action_and_visible_result(self):
        case=SimpleNamespace(id='TC-test',steps=[{'show_explorer_preview':None}])
        touches=_touches_for_case(case)
        self.assertEqual([(touch.selector,touch.kind) for touch in touches],[('[data-testid="explorer-cmd-preview"]','interactive'),('[data-testid="explorer-preview"]','display')])
