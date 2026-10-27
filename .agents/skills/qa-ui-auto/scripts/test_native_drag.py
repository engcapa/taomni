import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock

from qa_ui_auto.native_steps import VERBS
from qa_ui_auto.steps import StepError


class NativeDragTest(TestCase):
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
            self.assertEqual(json.loads((Path(directory) / "native-drags.jsonl").read_text())["end"], [68, 35])

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

    def test_missing_or_hidden_geometry_cannot_start_a_drag(self):
        for box in (None, {}, {"x": 0, "y": 0, "width": 0, "height": 10}):
            with self.subTest(box=box), TemporaryDirectory() as directory:
                session = Mock(); session.execute.return_value = box
                with self.assertRaises(StepError):
                    VERBS["drag_to"](SimpleNamespace(session=session, case_dir=Path(directory)),
                                     {"from": "#hidden", "by": {"dx": 30}})
                session.request.assert_not_called()
