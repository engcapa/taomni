import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from qa_ui_auto.project_tree_reveal import reveal, run, validate
from qa_ui_auto.steps import StepError

SELECTOR = '[data-testid="code-workspace-tree-dir"][data-path="public-fixture"]'


def position(offset=0, *, found=False, visible=False, virtual=True, height=200, total=1000, loading=False):
    return dict(offset=offset, found=found, visible=visible, virtual=virtual, height=height, total=total, loading=loading)


class ProjectTreeRevealTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.ctx = SimpleNamespace(session=SimpleNamespace(execute=Mock()), case_dir=Path(self.directory.name))
        self.pending = []
        self.actions = []

        def execute(script):
            if script.startswith("\nconst tree="):
                return self.pending.pop(0)
            self.actions.append(script)
            return True
        self.ctx.session.execute.side_effect = execute
        timer = patch("qa_ui_auto.project_tree_reveal.time.sleep")
        timer.start()
        self.addCleanup(timer.stop)

    def test_scrolls_real_viewport_without_clicking_or_selecting(self):
        self.pending = [position(500), position(0), position(140, found=True, visible=True)]
        samples = reveal(self.ctx, SELECTOR)
        self.assertEqual([sample["offset"] for sample in samples], [500, 0, 140])
        self.assertEqual(len(self.actions), 2)
        self.assertTrue(all("scrollTo" in action for action in self.actions))
        self.assertFalse(any("click" in action or "dispatchEvent" in action for action in self.actions))
        artifact = next(self.ctx.case_dir.glob("tree-reveal-*.json"))
        self.assertEqual(json.loads(artifact.read_text()), samples)

    def test_a_rendered_clipped_row_uses_normal_scroll_into_view(self):
        self.pending = [position(found=True, virtual=False), position(found=True, visible=True, virtual=False)]
        self.assertEqual(len(reveal(self.ctx, SELECTOR)), 2)
        self.assertIn("scrollIntoView", self.actions[0])

    def test_a_visible_row_requires_no_scroll(self):
        self.pending = [position(found=True, visible=True)]
        run(self.ctx, SELECTOR)
        self.assertEqual(self.actions, [])

    def test_waits_for_real_directory_children_before_scrolling(self):
        for virtual in [False, True]:
            with self.subTest(virtual=virtual):
                self.pending = [position(virtual=virtual, loading=True), position(virtual=virtual, found=True, visible=True)]
                self.assertEqual(len(reveal(self.ctx, SELECTOR)), 2)
                self.assertEqual(self.actions, [])

    def test_a_child_still_absent_after_loading_fails(self):
        self.pending = [position(virtual=False, loading=True), position(virtual=False)]
        with self.assertRaisesRegex(StepError, "disappeared"):
            run(self.ctx, SELECTOR)

    def test_loading_has_a_bounded_deadline_and_retains_samples(self):
        self.pending = [position(loading=True)]
        with patch("qa_ui_auto.project_tree_reveal.time.monotonic", side_effect=[0, 21]):
            with self.assertRaisesRegex(StepError, "could not be revealed"):
                run(self.ctx, SELECTOR)
        self.assertTrue(list(self.ctx.case_dir.glob("tree-reveal-*.json")))

    def test_missing_target_at_scroll_boundary_fails_and_retains_samples(self):
        self.pending = [position(), position(), position(800), position(800)]
        with self.assertRaisesRegex(StepError, "could not be revealed"):
            run(self.ctx, SELECTOR)
        self.assertTrue(list(self.ctx.case_dir.glob("tree-reveal-*.json")))

    def test_disappearing_or_invalid_tree_never_passes(self):
        for result in [None, {}, "invalid", position(virtual=False)]:
            with self.subTest(result=result):
                self.pending = [position(), result]
                with self.assertRaises(StepError):
                    run(self.ctx, SELECTOR)

    def test_hidden_tree_and_unknown_explicit_selector_fail(self):
        self.pending = [position(height=0)]
        with self.assertRaises(StepError):
            run(self.ctx, SELECTOR)
        with self.assertRaises(StepError):
            validate('[data-testid="workspace-tab"]')

    def test_other_entry_points_do_not_touch_the_tree(self):
        self.assertEqual(reveal(self.ctx, '[data-testid="workspace-tab"]'), [])
        self.ctx.session.execute.assert_not_called()
