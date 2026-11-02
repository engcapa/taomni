"""Count real restore clicks without inventing interactions in target windows."""
import unittest
from types import SimpleNamespace

from qa_ui_auto.control_coverage import _touches_for_case


class WindowControlCoverageTest(unittest.TestCase):
    def test_restore_click_is_interactive_but_destination_is_only_observed(self):
        case = SimpleNamespace(id="TC-WINDOW", steps=[{"switch_window": {
            "selector": '[data-testid="terminal-pane"]',
            "close_with": '[data-testid="sftp-reattach"]',
        }}])
        touches = _touches_for_case(case)
        self.assertEqual(
            [(touch.selector, touch.kind) for touch in touches],
            [('[data-testid="sftp-reattach"]', "interactive"),
             ('[data-testid="terminal-pane"]', "display")],
        )

    def test_observation_without_close_does_not_claim_a_click(self):
        case = SimpleNamespace(id="TC-WINDOW", steps=[{"switch_window": {
            "selector": '[data-testid="sftp-detached-window"]',
        }}])
        touches = _touches_for_case(case)
        self.assertEqual(len(touches), 1)
        self.assertEqual(touches[0].kind, "display")


if __name__ == "__main__":
    unittest.main()
