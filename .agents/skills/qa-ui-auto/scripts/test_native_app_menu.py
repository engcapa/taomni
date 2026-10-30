import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import yaml

from qa_ui_auto.behavior_contract import validate_contract
from qa_ui_auto.native_app_menu import native_menu
from qa_ui_auto.steps import StepError
from qa_ui_auto.testcase import load_case


class NativeAppMenuTests(unittest.TestCase):
    def context(self, directory):
        session = Mock()
        session.endpoint.side_effect = lambda suffix: '/session/owned' + suffix
        session.execute.return_value = True
        return SimpleNamespace(session=session, case_dir=Path(directory))

    def observation(self, **changes):
        return {'path': [1, 3], 'transport': 'AppKit NSMenu', 'enabled': True,
                'checked': False, 'activated': False, **changes}

    def test_waits_for_current_document_and_actual_flags_without_mutating_renderer(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = self.context(directory)
            ctx.session.execute.side_effect = [False, True, True]
            ctx.session.request.side_effect = [self.observation(enabled=False), self.observation()]
            with patch('qa_ui_auto.native_app_menu.time.sleep'):
                native_menu(ctx, {'path': [1, 3], 'enabled': True, 'checked': False})
            self.assertEqual(ctx.session.execute.call_count, 3)
            for call in ctx.session.execute.call_args_list:
                self.assertEqual(call.args, ('return window.__TAOMNI_QA_APP_MENU__?.ready() === true;',))
            for call in ctx.session.request.call_args_list:
                self.assertEqual(call.args, ('POST', '/session/owned/qa/application-menu', {'path': [1, 3]}))
            observations = [json.loads(line) for line in
                            ctx.case_dir.joinpath('native-menu-observations.jsonl').read_text().splitlines()]
            self.assertEqual([item['enabled'] for item in observations], [False, True])

    def test_action_only_locates_path_and_activation_uses_appkit_once(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = self.context(directory)
            ctx.session.execute.side_effect = [True, [1, 3]]
            ctx.session.request.side_effect = [self.observation(), self.observation(activated=True)]
            native_menu(ctx, {'action': 'close-active', 'enabled': True, 'activate': True})
            self.assertEqual(ctx.session.execute.call_args_list[1].args,
                             ('return window.__TAOMNI_QA_APP_MENU__?.path("close-active") ?? null;',))
            self.assertEqual(ctx.session.request.call_count, 2)
            self.assertEqual(ctx.session.request.call_args.args,
                             ('POST', '/session/owned/qa/application-menu', {'path': [1, 3], 'activate': True}))

    def test_uncertain_activation_is_never_retried(self):
        outcomes = [RuntimeError('lost native acknowledgement'), {}, self.observation(activated=False),
                    self.observation(activated=True, path=[0]), self.observation(activated=True, transport='renderer')]
        for outcome in outcomes:
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                ctx = self.context(directory)
                ctx.session.request.side_effect = [self.observation(), outcome]
                with self.assertRaises((RuntimeError, StepError)):
                    native_menu(ctx, {'path': [1, 3], 'enabled': True, 'activate': True})
                self.assertEqual(ctx.session.request.call_count, 2)

    def test_mismatched_observation_fails_before_activation(self):
        for changes in [{'path': [0]}, {'transport': 'renderer'}]:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as directory:
                ctx = self.context(directory)
                ctx.session.request.return_value = self.observation(**changes)
                with self.assertRaisesRegex(StepError, 'matching AppKit'):
                    native_menu(ctx, {'path': [1, 3], 'enabled': True, 'activate': True})
                ctx.session.request.assert_called_once()

    def test_invalid_arguments_fail_without_native_requests(self):
        invalid = [None, {}, {'path': []}, {'path': [True], 'enabled': True},
                   {'path': [-1], 'enabled': True}, {'path': [0] * 9, 'enabled': True},
                   {'path': [0], 'action': 'help', 'enabled': True}, {'action': '', 'enabled': True},
                   {'path': [0], 'enabled': 1}, {'path': [0], 'checked': False, 'activate': True},
                   {'path': [0], 'enabled': False, 'activate': True},
                   {'path': [0], 'enabled': True, 'unexpected': True}]
        for args in invalid:
            with self.subTest(args=args):
                ctx = SimpleNamespace(session=Mock())
                with self.assertRaises(StepError):
                    native_menu(ctx, args)
                ctx.session.execute.assert_not_called()
                ctx.session.request.assert_not_called()

    def test_unresolved_or_invalid_action_path_times_out_without_using_native_endpoint(self):
        for path in [None, [], [True], [-1], [0] * 9]:
            with self.subTest(path=path):
                ctx = SimpleNamespace(session=Mock())
                ctx.session.execute.side_effect = [True, path]
                with patch('qa_ui_auto.native_app_menu.time.monotonic', side_effect=[0, 0, 11]), \
                     patch('qa_ui_auto.native_app_menu.time.sleep'):
                    with self.assertRaisesRegex(StepError, 'expected state'):
                        native_menu(ctx, {'action': 'help', 'enabled': True})
                ctx.session.request.assert_not_called()

    def test_case_has_reviewed_real_native_state_and_lifetime_contract(self):
        path = Path('qa-ui-auto-tests/cases/TC-WS-080-native-application-menu-state-lifetime.testcase.yaml')
        case = load_case(path)
        self.assertEqual(case.modes, ['native'])
        self.assertEqual(case.native_platforms, ['macOS'])
        self.assertEqual(validate_contract(yaml.safe_load(path.read_text()), require_review=True), [])


if __name__ == '__main__':
    unittest.main()
