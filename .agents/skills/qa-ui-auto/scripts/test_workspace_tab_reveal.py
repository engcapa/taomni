import json
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.steps import StepError
from qa_ui_auto.workspace_tab_reveal import GEOMETRY, reveal


SELECTOR = '[data-testid="workspace-tab"][data-tab-title="notes.txt"]'
LEFT = '[data-testid="workspace-tab-scroll-left"]'


def position(visible, *, active="long-json", button=LEFT):
    return {"visible": visible, "active": active, "button": button}


class WorkspaceTabRevealTests(unittest.TestCase):
    def test_clipped_native_tab_uses_a_real_arrow_without_activating_the_tab(self):
        session = Mock()
        session.execute.side_effect = [position(False), position(True)]
        with patch("qa_ui_auto.workspace_tab_reveal.time.sleep"):
            samples = reveal(SimpleNamespace(session=session), SELECTOR)
        self.assertEqual(len(samples), 2)
        session.click.assert_called_once_with(LEFT)
        self.assertTrue(all(".click(" not in call.args[0] for call in session.execute.call_args_list))
        session.dblclick.assert_not_called()
        session.type_text.assert_not_called()

    def test_browser_uses_the_same_arrow_navigation(self):
        page = Mock()
        page.evaluate.side_effect = [position(False), position(True)]
        with patch("qa_ui_auto.workspace_tab_reveal.time.sleep"):
            reveal(SimpleNamespace(page=page), SELECTOR)
        page.locator.assert_called_once_with(LEFT)
        page.locator.return_value.click.assert_called_once_with()

    def test_visible_tab_or_tree_target_needs_no_scroll_input(self):
        for value in [None, position(True)]:
            session = Mock()
            session.execute.return_value = value
            reveal(SimpleNamespace(session=session), SELECTOR)
            session.click.assert_not_called()

    def test_arrow_must_not_switch_the_active_document(self):
        session = Mock()
        session.execute.side_effect = [position(False), position(True, active="notes")]
        with patch("qa_ui_auto.workspace_tab_reveal.time.sleep"), self.assertRaisesRegex(StepError, "changed the active"):
            reveal(SimpleNamespace(session=session), SELECTOR)

    def test_missing_or_disabled_arrow_fails_without_pointer_fallback(self):
        session = Mock()
        session.execute.return_value = position(False, button=None)
        with self.assertRaisesRegex(StepError, "could not be revealed"):
            reveal(SimpleNamespace(session=session), SELECTOR)
        session.click.assert_not_called()

    def test_inaccessible_tab_cannot_loop_forever_or_be_activated_by_script(self):
        session = Mock()
        session.execute.return_value = position(False)
        with patch("qa_ui_auto.workspace_tab_reveal.time.sleep"), self.assertRaisesRegex(StepError, "could not be revealed"):
            reveal(SimpleNamespace(session=session), SELECTOR)
        self.assertEqual(session.click.call_count, 20)
        self.assertEqual(session.execute.call_count, 21)

    def test_invalid_geometry_fails_closed(self):
        for value in [True, {}, {"visible": "true"}]:
            session = Mock()
            session.execute.return_value = value
            with self.subTest(value=value), self.assertRaisesRegex(StepError, "Invalid workspace tab"):
                reveal(SimpleNamespace(session=session), SELECTOR)

    def test_geometry_uses_scroll_area_clipping_and_requires_the_actual_hit_target(self):
        script = r"""
const data = JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const area = {getBoundingClientRect:()=>({left:374,right:950}),
  querySelector:()=>({getAttribute:()=> 'long-json'})};
const tab = {matches:()=>true,closest:()=>area,
  getBoundingClientRect:()=>({left:data.left,right:data.left+105,top:8,bottom:36,width:105,height:28}),
  contains:hit=>hit===tab};
global.innerWidth=1280;
global.document={querySelector:selector=>selector.includes('scroll-')?{disabled:data.disabled}:tab,
  elementFromPoint:()=>data.covered?area:tab};
process.stdout.write(JSON.stringify(new Function(data.script)()));
"""
        for left, covered, disabled, expected, arrow in [
            (315, False, False, False, LEFT), (400, False, False, True, None),
            (400, True, False, False, None), (315, False, True, False, None),
        ]:
            with self.subTest(left=left, covered=covered, disabled=disabled):
                result = subprocess.run(["node", "-e", script], input=json.dumps({
                    "script": GEOMETRY.replace("SELECTOR", json.dumps(SELECTOR), 1),
                    "left": left, "covered": covered, "disabled": disabled,
                }), capture_output=True, text=True, check=True)
                geometry = json.loads(result.stdout)
                self.assertEqual(geometry["visible"], expected)
                self.assertEqual(geometry["button"], arrow)


if __name__ == "__main__":
    unittest.main()
