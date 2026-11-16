"""Check setup/lock priority and promptly recognize an already-ready page."""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from qa_ui_auto.steps import StepError
from qa_ui_auto.steps.app_specific import step_vault_first_run


class BrowserVaultFirstRunTests(unittest.TestCase):
    def context(self, *, setup=False, locked=False, ready=False):
        page = Mock()
        nodes = {}
        for name, visible in (("vault-setup-dialog", setup), ("vault-unlock-dialog", locked), ("welcome-panel", ready)):
            node = nodes[name] = Mock()
            node.count.return_value = int(visible)
            node.first.is_visible.return_value = visible
        page.locator.side_effect = lambda selector: next(node for name, node in nodes.items() if name in selector)
        return SimpleNamespace(page=page, dry_run=False), nodes

    def test_ready_page_does_not_wait_for_an_absent_setup_dialog(self):
        ctx, nodes = self.context(ready=True)
        step_vault_first_run(ctx, "qa-password")
        ctx.page.wait_for_selector.assert_called_once()
        nodes["vault-setup-dialog"].wait_for.assert_not_called()
        nodes["vault-setup-dialog"].locator.assert_not_called()

    def test_visible_setup_uses_real_fields_even_with_a_page_behind_it(self):
        ctx, nodes = self.context(setup=True, ready=True)
        step_vault_first_run(ctx, "qa-password")
        setup = nodes["vault-setup-dialog"]
        self.assertEqual([call.args[0] for call in setup.locator.call_args_list], [
            "[data-testid='vault-setup-pw1']", "[data-testid='vault-setup-pw2']", "[data-testid='vault-setup-confirm']",
        ])
        self.assertEqual(setup.locator.return_value.fill.call_count, 2)
        setup.locator.return_value.click.assert_called_once_with()
        setup.wait_for.assert_called_once_with(state="hidden", timeout=30_000)

    def test_locked_dialog_cannot_be_hidden_by_the_ready_page(self):
        ctx, nodes = self.context(locked=True, ready=True)
        with self.assertRaisesRegex(StepError, "LOCKED with an unknown master password"):
            step_vault_first_run(ctx, "not-a-guessed-password")
        nodes["vault-unlock-dialog"].locator.assert_not_called()

    def test_startup_timeout_remains_a_failure(self):
        ctx, _ = self.context()
        ctx.page.wait_for_selector.side_effect = TimeoutError("no app")
        with self.assertRaisesRegex(StepError, "neither vault dialog nor welcome-panel"):
            step_vault_first_run(ctx, "qa-password")

    def test_hidden_or_disappearing_ready_page_is_not_a_success(self):
        ctx, nodes = self.context(ready=True)
        nodes["welcome-panel"].first.is_visible.return_value = False
        with self.assertRaisesRegex(StepError, "neither vault dialog nor welcome-panel"):
            step_vault_first_run(ctx, "qa-password")

    def test_dry_run_does_not_touch_the_page(self):
        ctx, _ = self.context()
        ctx.dry_run = True
        step_vault_first_run(ctx, "qa-password")
        ctx.page.locator.assert_not_called()
        ctx.page.wait_for_selector.assert_not_called()


if __name__ == "__main__":
    unittest.main()
