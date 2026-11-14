"""Exercise helpers through actual NativeSession.execute, not variadic mocks.

Hosted43526262110 native006/011 exposed an incompatible execute(script,args)
call hidden by Mock(*args). Keep one real transport method in these unit tests;
only the HTTP boundary is mocked. No app or browser is launched.
"""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from tauri_webdriver import NativeSession, selector_strategy
from qa_ui_auto import file_open_observation, native_paste, terminal_file_link


def session_with(result):
    session = object.__new__(NativeSession)
    session.session_id = "unit-session"
    session.request = Mock(return_value=result)
    return session


class NativeSessionFileOpenContracts(TestCase):
    def test_global_thread_title_uses_same_exact_leaf_xpath_in_browser_and_native(self):
        import yaml
        from qa_ui_auto.steps import mouse
        root=Path(__file__).resolve().parents[4]
        case=next((root/'qa-ui-auto-tests/cases').glob('TC-FILE-OPEN-008-*.testcase.yaml'))
        document=yaml.safe_load(case.read_text(encoding='utf-8'))
        selector=document['steps'][9]['click']
        expected='//*[@data-testid="ai-chat-drawer"]//div[text()="QA file path entry"]'
        self.assertEqual(selector_strategy(selector,interactive=True),('xpath',expected))
        page=Mock();ctx=SimpleNamespace(page=page,dry_run=False)
        mouse.step_click(ctx,selector)
        page.locator.assert_called_once_with('xpath='+expected)
        page.locator.return_value.first.click.assert_called_once()

    def test_byte_oracle_observes_selected_path_through_actual_single_argument_execute(self):
        with TemporaryDirectory() as temporary:
            root=Path(temporary);case=root/'case';case.mkdir();target=root/'fixture'/'copy.txt'
            target.parent.mkdir();target.write_bytes(b'Attachment bytes\n')
            (case/'file-open-fixture.json').write_text(json.dumps({'schema':'qa.file-open-fixture.v1','mode':'native','root':str(target.parent)}))
            session=session_with([str(target)])
            ctx=SimpleNamespace(case_dir=case,session=session)
            selector='[data-testid="file-viewer"][data-readonly="true"]'
            file_open_observation.native(ctx,{'selector':selector,'remember':'copy','equals':'Attachment bytes\n'})
            request=session.request.call_args
            self.assertEqual(request.args[:2],('POST','/session/unit-session/execute/sync'))
            self.assertEqual(request.args[2]['args'],[])
            self.assertIn(json.dumps(selector),request.args[2]['script'])
            self.assertNotIn('arguments[0]',request.args[2]['script'])
            target.unlink()
            file_open_observation.native(ctx,{'remember':'copy','absent':True})

    def test_terminal_pointer_observes_geometry_with_actual_single_argument_execute(self):
        with TemporaryDirectory() as temporary:
            point={'x':30,'y':40,'width':800,'height':600,'hit':True}
            session=session_with(point);ctx=SimpleNamespace(case_dir=Path(temporary),session=session)
            with patch.object(terminal_file_link.platform,'system',return_value='Windows'),patch('qa_ui_auto.deadline.budget_time.sleep'):
                terminal_file_link.native(ctx,{'selector':'[data-testid="terminal-pane"]'})
            execute=next(call for call in session.request.call_args_list if call.args[1].endswith('/execute/sync'))
            self.assertEqual(execute.args[2]['args'],[])
            self.assertNotIn('arguments[0]',execute.args[2]['script'])
            self.assertIn(json.dumps('[data-testid="terminal-pane"]'),execute.args[2]['script'])
            click_actions=[call for call in session.request.call_args_list if call.args[1].endswith('/actions') and call.args[0]=='POST' and len(call.args[2]['actions'])==2]
            self.assertEqual(len(click_actions),1)

    def test_native_paste_focus_observer_uses_actual_single_argument_execute(self):
        with TemporaryDirectory() as temporary:
            session=session_with(True);session.application=Path('/qa/taomni')
            ctx=SimpleNamespace(case_dir=Path(temporary),session=session)
            with patch.object(native_paste.platform,'system',return_value='Linux'),patch('qa_ui_auto.wayland.active',return_value=False),patch('qa_ui_auto.native_steps._activate_x11_application',return_value=('0x1','owned')),patch('qa_ui_auto.native_steps._inject_x11_keys') as keys:
                native_paste.run(ctx,{'selector':'.cm-content'})
            keys.assert_called_once_with(['Control+v'])
            request=session.request.call_args
            self.assertEqual(request.args[2]['args'],[])
            self.assertIn(json.dumps('.cm-content'),request.args[2]['script'])
