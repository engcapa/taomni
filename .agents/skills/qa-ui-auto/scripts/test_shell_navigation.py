from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.steps.shell import navigate, backend_scenario
from qa_ui_auto.native_steps import VERBS
from qa_ui_auto.control_coverage import _selectors_in_step


class ShellNavigationTest(TestCase):
    def test_one_shot_hold_is_sent_as_external_boundary_input(self):
        ctx = Mock(dry_run=False, cfg={"app": {"mode": "browser"}})
        rule = {"action": "hold", "command": "workspace_list_dir", "owner": "/repo", "once": True}
        backend_scenario(ctx, rule)
        self.assertEqual(ctx.page.evaluate.call_args.args[1], rule)
        self.assertIn("once:rule.once", ctx.page.evaluate.call_args.args[0])

    def test_static_catalog_traces_the_real_composite_navigation_controls(self):
        self.assertEqual(_selectors_in_step("shell_navigate", "tools"), [
            '[data-testid="shell-rail-workspaces"]', '[data-testid="shell-navigator-page"][data-page="tools"]'])
        self.assertEqual(_selectors_in_step("shell_navigate", "sessions"), ['[data-testid="shell-rail-sessions"]'])

    def test_browser_repeated_sessions_does_not_toggle_the_page_closed(self):
        ctx = Mock(dry_run=False)
        ctx.page.locator.return_value.first.is_visible.return_value = True
        navigate(ctx, "sessions")
        ctx.page.locator.return_value.click.assert_not_called()
        ctx.page.locator.return_value.first.wait_for.assert_called_once_with(state="visible")

    def test_browser_opens_tools_by_rail_and_page_clicks(self):
        ctx = Mock(dry_run=False)
        ctx.page.locator.return_value.first.is_visible.return_value = False
        navigate(ctx, "tools")
        selectors = [call.args[0] for call in ctx.page.locator.call_args_list]
        self.assertIn('[data-testid="shell-rail-workspaces"]', selectors)
        self.assertEqual(ctx.page.locator.return_value.click.call_count, 2)
        self.assertIn('[data-testid="sidebar-tools-panel"]', selectors)

    def test_native_sessions_and_tools_keep_existing_visible_area(self):
        ctx = Mock()
        with patch("qa_ui_auto.native_steps._element_has_layout", return_value=True), \
             patch("qa_ui_auto.native_steps._wait_for") as wait:
            VERBS["shell_navigate"](ctx, "sessions")
            ctx.session.click.assert_not_called()
            VERBS["shell_navigate"](ctx, "tools")
            ctx.session.click.assert_called_once_with('[data-testid="shell-navigator-page"][data-page="tools"]')
            wait.assert_any_call(ctx, '[data-testid="sidebar-tools-panel"]')
