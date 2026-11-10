"""Static fixture contract; real shortcut submission needs hosted browser QA."""
from pathlib import Path
from unittest import TestCase
from .testcase import load_case


class MobileShortcutReadinessTest(TestCase):
    def test_continue_shortcut_waits_for_send_permission_and_checks_server_receipt(self):
        root = Path(__file__).resolve().parents[5]
        case = load_case(root / 'qa-ui-auto-tests/cases/TC-MOBILE-001-mobile-web-control-plane.testcase.yaml')
        start = case.steps.index({'click': '[data-testid="mobile-agent-continue"]'})
        self.assertEqual(case.steps[start + 1], {
            'wait_for': '[data-testid="mobile-agent-send"]:not([disabled])',
        })
        ready = case.steps[start + 2]['eval_readonly']
        self.assertIn(".value === '继续'", ready['expression'])
        self.assertIn("!document.querySelector('button.primary').disabled", ready['expression'])
        self.assertTrue(ready['expect_truthy'])
        self.assertEqual(case.steps[start + 3], {'press': {
            'selector': '[data-testid="mobile-agent-input"]',
            'key': 'Control+Enter', 'macos_key': 'Meta+Enter',
        }})
        self.assertEqual(case.steps[start + 4], {'assert_file_contains': {
            'path': '${fixture.mobile_receipt}', 'contains': 'AGENT 继续',
        }})
