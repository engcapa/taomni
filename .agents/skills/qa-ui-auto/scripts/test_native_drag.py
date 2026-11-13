import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from qa_ui_auto.native_steps import VERBS
from qa_ui_auto.steps import StepError


class NativeDragTest(TestCase):
    def test_tc155_requires_complete_query_before_targeting_search_hit(self):
        from qa_ui_auto.testcase import load_case

        root = Path(__file__).resolve().parents[4]
        case = load_case(root / 'qa-ui-auto-tests/cases/TC-155-terminal-gutter-native.testcase.yaml')
        query_checks = []
        for index, step in enumerate(case.steps):
            expression = step.get('eval_readonly', {}).get('expression', '')
            if 'QA-LEFT-GUTTER' not in expression:
                continue
            query_checks.append(index)
            self.assertIn('.value === "QA-LEFT-GUTTER"', expression)
            self.assertTrue(step['eval_readonly']['expect_truthy'])
            self.assertEqual(case.steps[index - 1], {'fill': {
                'selector': 'input[placeholder="Find"]', 'value': 'QA-LEFT-GUTTER'}})
            self.assertEqual(case.steps[index + 1], {'press': 'Enter'})
            geometry = case.steps[index + 3]['eval_readonly']
            self.assertIn('.terminal-search-hit-active', geometry['expression'])
            self.assertTrue(geometry['expression'].endswith(' < 1'))
            self.assertTrue(geometry['expect_truthy'])
            # Do not let seeded search text make a broken Copy look successful.
            self.assertEqual(case.steps[index + 4], {'host_clipboard': {
                'action': 'set', 'kind': 'text', 'text': 'NOT-SELECTED'}})
        self.assertEqual(len(query_checks), 2, 'local and SSH must both verify the full query')
        marker_commands = [step['terminal_input']['text'] for step in case.steps if 'terminal_input' in step]
        self.assertEqual(marker_commands, [' echo QA-LEFT-""GUTTER'] * 2)

    def test_offset_uses_one_action_request_and_fixed_viewport_geometry(self):
        with TemporaryDirectory() as directory:
            session = Mock()
            session.execute.return_value = {"x": 20, "y": 30, "width": 6, "height": 10}
            ctx = SimpleNamespace(session=session, case_dir=Path(directory))
            VERBS["drag_to"](ctx, {"from": "#handle", "by": {"dx": 45, "steps": 3}})
            payload = session.request.call_args_list[0].args[2]
            actions = payload["actions"][0]["actions"]
            self.assertEqual([a["type"] for a in actions], ["pointerMove", "pointerDown",
                             "pointerMove", "pointerMove", "pointerMove", "pointerUp"])
            self.assertEqual([a["x"] for a in actions if a["type"] == "pointerMove"], [23, 38, 53, 68])
            self.assertEqual(session.request.call_args_list[-1].args[0], "DELETE")
            receipts = [json.loads(line) for line in (Path(directory) / "native-drags.jsonl").read_text().splitlines()]
            self.assertEqual(receipts[0]["end"], [68, 35])
            self.assertEqual(receipts[1]["kind"], "dom-events")
            self.assertEqual(receipts[0]["traceId"], receipts[1]["traceId"])

    def test_modifier_copy_uses_one_synchronized_key_pointer_request_and_macos_option(self):
        for system, expected in [("Linux", ""), ("Darwin", "")]:
            with self.subTest(system=system), TemporaryDirectory() as directory:
                session = Mock()
                session.execute.side_effect = [{"x": 0, "y": 0, "width": 10, "height": 10}, {"x": 60, "y": 80, "width": 20, "height": 20}]
                with patch("qa_ui_auto.steps.mouse.platform.system", return_value=system):
                    VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)),
                                     {"from": "#a", "to": "#b", "modifiers": ["Control"], "macos_modifiers": ["Alt"]})
                sources = session.request.call_args_list[0].args[2]["actions"]
                self.assertEqual(len(sources), 2)
                self.assertEqual(sources[1]["actions"][0], {"type": "keyDown", "value": expected})
                self.assertEqual(sources[1]["actions"][-1], {"type": "keyUp", "value": expected})
                self.assertEqual(len(sources[0]["actions"]), len(sources[1]["actions"]))
                self.assertEqual(session.request.call_args_list[-1].args[0], "DELETE")

    def test_offscreen_target_cannot_be_reported_as_a_delivered_native_drag(self):
        with TemporaryDirectory() as directory:
            session = Mock()
            session.execute.side_effect = [{"x": 0, "y": 0, "width": 10, "height": 10, "viewportWidth": 1200, "viewportHeight": 800},
                                           {"x": 2100, "y": 50, "width": 50, "height": 20, "viewportWidth": 1200, "viewportHeight": 800}]
            with self.assertRaisesRegex(StepError, "outside the WebView viewport"):
                VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)), {"from": "#a", "to": "#b"})
            session.request.assert_not_called()

    def test_failed_transport_releases_pointer_and_preserves_failure(self):
        with TemporaryDirectory() as directory:
            session = Mock()
            session.execute.side_effect = [{"x": 0, "y": 0, "width": 10, "height": 10},
                                           {"x": 60, "y": 80, "width": 20, "height": 20}]
            session.request.side_effect = [RuntimeError("drag rejected"), None]
            with self.assertRaisesRegex(RuntimeError, "rejected"):
                VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)), {"from": "#a", "to": "#b"})
            self.assertEqual(session.request.call_args_list[-1].args[0], "DELETE")
            self.assertTrue((Path(directory) / "native-drags.jsonl").is_file())

    def test_passive_dom_trace_wraps_action_and_preserves_actual_event_fields(self):
        with TemporaryDirectory() as directory:
            session = Mock()
            events = [{"type": "pointerdown", "target": {"tag": "SPAN", "path": "/source/file.txt"},
                       "buttons": 1, "clientX": 746, "clientY": 183, "altKey": False, "ctrlKey": True},
                      {"type": "pointerup", "target": {"path": "/target/folder"}, "buttons": 0}]
            session.execute.side_effect = [
                {"x": 740, "y": 170, "width": 12, "height": 26},
                {"x": 740, "y": 142, "width": 12, "height": 26},
                True, {"events": events, "dropped": 3},
            ]
            VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)), {"from": "#a", "to": "#b"})
            scripts = [call.args[0] for call in session.execute.call_args_list]
            self.assertIn("capture: true, passive: true", scripts[2])
            self.assertIn("state.events.length >= 2048", scripts[2])
            self.assertIn("event.buttons", scripts[2])
            self.assertNotIn("preventDefault(", scripts[2])
            self.assertNotIn("stopPropagation(", scripts[2])
            self.assertIn("state.stop(); delete window[key]", scripts[3])
            calls = [call[0] for call in session.mock_calls]
            self.assertEqual(calls, ["find", "execute", "find", "execute", "execute",
                                     "endpoint", "request", "endpoint", "request", "execute"])
            receipt = json.loads((Path(directory) / "native-drags.jsonl").read_text().splitlines()[-1])
            self.assertEqual(receipt["events"], events)
            self.assertEqual(receipt["dropped"], 3)
            self.assertNotIn("collectionError", receipt)

    def test_dom_observer_javascript_is_bounded_passive_and_fully_removed(self):
        from qa_ui_auto.native_drag import _start_dom_trace, _finish_dom_trace

        session = Mock()
        _start_dom_trace(session, "__qa-test-observer")
        start_script = session.execute.call_args.args[0]
        session.execute.return_value = {"events": []}
        _finish_dom_trace(session, "__qa-test-observer")
        stop_script = session.execute.call_args.args[0]
        program = r"""
const assert = require('node:assert/strict');
const scripts = JSON.parse(process.argv[1]);
const listeners = new Map();
global.window = {
  addEventListener(type, callback, options) {
    assert.equal(options.capture, true); assert.equal(options.passive, true);
    listeners.set(type, callback);
  },
  removeEventListener(type, callback, options) {
    assert.equal(listeners.get(type), callback); assert.equal(options.passive, true);
    listeners.delete(type);
  },
};
class Element {
  constructor(tagName, attrs) { Object.assign(this, {tagName, attrs}); }
  closest() { return this; }
  getAttribute(name) { return this.attrs[name] ?? null; }
}
global.Element = Element;
const target = new Element('SPAN', {'data-path': '/target/folder', 'data-testid': 'explorer-file-row'});
global.document = {activeElement: target};
new Function(scripts[0])();
const event = {type: 'pointermove', target, buttons: 1, button: 0,
  clientX: 746, clientY: 155, altKey: true, ctrlKey: false, isTrusted: true};
for (let index = 0; index < 2050; index++) listeners.get('pointermove')(event);
const result = new Function(scripts[1])();
assert.equal(result.events.length, 2048); assert.equal(result.dropped, 2);
assert.equal(result.events[0].target.path, '/target/folder');
assert.equal(result.events[0].target.testId, 'explorer-file-row');
assert.equal(result.events[0].buttons, 1); assert.equal(result.events[0].altKey, true);
assert.equal(result.events[0].clientX, 746); assert.equal(result.events[0].clientY, 155);
assert.equal(listeners.size, 0); assert.equal(Object.keys(window).length, 2);
"""
        subprocess.run(["node", "-e", program, json.dumps([start_script, stop_script])],
                       check=True, capture_output=True, text=True)

    def test_failed_drag_collects_and_removes_dom_observer_without_masking_transport_error(self):
        with TemporaryDirectory() as directory:
            session = Mock()
            session.execute.side_effect = [
                {"x": 0, "y": 0, "width": 10, "height": 10},
                {"x": 60, "y": 80, "width": 20, "height": 20},
                True, {"events": [{"type": "pointercancel", "buttons": 0}], "dropped": 0},
            ]
            session.request.side_effect = [RuntimeError("original transport failure"), RuntimeError("release failure")]
            with self.assertRaisesRegex(RuntimeError, "original transport failure"):
                VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)), {"from": "#a", "to": "#b"})
            self.assertIn("state.stop(); delete window[key]", session.execute.call_args_list[-1].args[0])
            receipt = json.loads((Path(directory) / "native-drags.jsonl").read_text().splitlines()[-1])
            self.assertEqual(receipt["events"][0]["type"], "pointercancel")

    def test_diagnostic_setup_and_collection_errors_do_not_suppress_drag_or_its_failure(self):
        with TemporaryDirectory() as directory:
            session = Mock()
            session.execute.side_effect = [
                {"x": 0, "y": 0, "width": 10, "height": 10},
                RuntimeError("observer setup blocked"), RuntimeError("observer collection blocked"),
            ]
            session.request.side_effect = [RuntimeError("drag failed"), None]
            with self.assertRaisesRegex(RuntimeError, "drag failed"):
                VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)), {"from": "#a", "by": {"dx": 30}})
            self.assertEqual(session.request.call_args_list[0].args[0], "POST")
            receipt = json.loads((Path(directory) / "native-drags.jsonl").read_text().splitlines()[-1])
            self.assertIn("setup blocked", receipt["setupError"])
            self.assertIn("collection blocked", receipt["collectionError"])

    def test_missing_or_hidden_geometry_cannot_start_a_drag(self):
        for box in (None, {}, {"x": 0, "y": 0, "width": 0, "height": 10}):
            with self.subTest(box=box), TemporaryDirectory() as directory:
                session = Mock(); session.execute.return_value = box
                with self.assertRaises(StepError):
                    VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)),
                                     {"from": "#hidden", "by": {"dx": 30}})
                session.request.assert_not_called()


def load_tests(loader, suite, pattern):
    """Keep synthetic external-drag contracts in the existing hosted drag suite.

    qa-ui-auto-entry and tool-contracts already select this module. No workflow
    conditions, platform scope or crash-regression selection need to change.
    """
    for module in ("test_os_file_drag", "test_workspace_drop_import", "test_file_clipboard", "test_file_clipboard_macos"):
        suite.addTests(loader.loadTestsFromName(module))
    return suite
