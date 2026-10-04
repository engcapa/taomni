from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.steps.shell import navigate, backend_scenario, menu_action
from qa_ui_auto.steps import StepError
from qa_ui_auto.native_steps import VERBS
from qa_ui_auto.control_coverage import _selectors_in_step


class ShellNavigationTest(TestCase):
    def test_exit_uses_the_platform_menu_and_requires_the_installed_quit_acknowledgement(self):
        browser = Mock(dry_run=False)
        menu_action(browser, "exit")
        expected = ['[data-testid="app-main-menu"]', '[data-testid="context-menu-item-exit"]']
        self.assertEqual([call.args[0] for call in browser.page.locator.call_args_list], expected)
        self.assertEqual(_selectors_in_step("app_menu_action", "exit"), expected)
        native = Mock()
        with patch("qa_ui_auto.native_steps.platform.system", return_value="Windows"), \
                patch("qa_ui_auto.native_steps._wait_for"), patch("qa_ui_auto.native_steps._hover") as hover:
            VERBS["app_menu_action"](native, "exit")
            self.assertEqual([call.args[0] for call in native.session.click.call_args_list], expected)
            hover.assert_not_called()
        native.session.endpoint.side_effect = lambda path: path
        native.session.request.return_value = {"activated": "quit", "transport": "AppKit NSMenu"}
        with patch("qa_ui_auto.native_steps.platform.system", return_value="Darwin"):
            VERBS["app_menu_action"](native, "exit")
            native.session.request.assert_called_once_with("POST", "/qa/native-app-menu", {"action": "exit"})
            native.session.request.return_value = {"activated": "quit", "transport": "simulated"}
            with self.assertRaisesRegex(StepError, "not activated"):
                VERBS["app_menu_action"](native, "exit")

    def test_browser_menu_action_uses_visible_menu_controls(self):
        ctx = Mock(dry_run=False)
        menu_action(ctx, "multiexec")
        selectors = [call.args[0] for call in ctx.page.locator.call_args_list]
        self.assertEqual(selectors, ['[data-testid="app-main-menu"]', '[data-testid="context-menu-item-view"]',
                                    '[data-testid="context-menu-item-multiexec"]'])
        ctx.page.locator.return_value.hover.assert_called_once_with()
        self.assertEqual(ctx.page.locator.return_value.click.call_count, 2)

    def test_macos_menu_action_requires_real_appkit_activation_acknowledgement(self):
        ctx = Mock()
        ctx.session.endpoint.side_effect = lambda path: path
        ctx.session.request.return_value = {"activated": "split", "transport": "AppKit NSMenu"}
        with patch("qa_ui_auto.native_steps.platform.system", return_value="Darwin"):
            VERBS["app_menu_action"](ctx, "split")
            ctx.session.request.assert_called_once_with("POST", "/qa/native-view-menu", {"action": "split"})
            ctx.session.click.assert_not_called()
            ctx.session.request.return_value = None
            with self.assertRaisesRegex(StepError, "not activated"):
                VERBS["app_menu_action"](ctx, "split")

    def test_native_renderer_menu_reenters_a_reopened_portal_before_clicking(self):
        ctx = Mock()
        with patch("qa_ui_auto.native_steps.platform.system", return_value="Linux"), \
                patch("qa_ui_auto.native_steps._wait_for"), patch("qa_ui_auto.native_steps._hover") as hover:
            VERBS["app_menu_action"](ctx, "multiexec")
        self.assertEqual([call.args[1] for call in hover.call_args_list],
                         ['[data-testid="app-main-menu"]', '[data-testid="context-menu-item-view"]'])
        self.assertEqual([call.args[0] for call in ctx.session.click.call_args_list],
                         ['[data-testid="app-main-menu"]', '[data-testid="context-menu-item-multiexec"]'])
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

    def test_browser_observes_visibility_only_after_the_rail_has_mounted(self):
        ctx = Mock(dry_run=False)
        rail, target = Mock(), Mock()
        mounted = []
        rail.wait_for.side_effect = lambda **kwargs: mounted.append(True)
        target.first.is_visible.side_effect = lambda: bool(mounted)
        ctx.page.locator.side_effect = lambda selector: rail if selector == '[data-testid="shell-rail-sessions"]' else target
        navigate(ctx, "sessions")
        rail.wait_for.assert_called_once_with(state="visible")
        rail.click.assert_not_called()

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
