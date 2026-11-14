"""Unit/runner contracts for native dialog, OS paste and Markdown byte oracles."""
import base64
import hashlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import MagicMock, Mock, patch
import zipfile

from qa_ui_auto import file_dialog, native_paste
from qa_ui_auto import markdown_export_observation as artifacts
from qa_ui_auto.fixtures import markdown_native, file_open_entries
from qa_ui_auto import terminal_file_link
from qa_ui_auto.steps import StepError


class NativeFileDialogTests(unittest.TestCase):
    def test_destinations_cannot_overwrite_escape_or_use_missing_parent(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root=Path(tmp);case=root/'case';case.mkdir();ctx=SimpleNamespace(case_dir=case)
            fresh=root/'new.html'
            self.assertEqual(file_dialog.validate(ctx,{'kind':'save','action':'choose','path':str(fresh)}),fresh)
            for path in [str(Path(outside)/'bad.html'),str(root/'missing/file.html')]:
                with self.assertRaises(StepError):file_dialog.validate(ctx,{'kind':'save','action':'choose','path':path})
            fresh.write_bytes(b'keep')
            with self.assertRaises(StepError):file_dialog.validate(ctx,{'kind':'save','action':'choose','path':str(fresh)})
            self.assertEqual(fresh.read_bytes(),b'keep')
            self.assertIsNone(file_dialog.validate(ctx,{'kind':'save','action':'cancel'}))
            with self.assertRaises(StepError):file_dialog.validate(ctx,{'kind':'save','action':'cancel','path':str(fresh)})
            self.assertEqual(file_dialog.validate(ctx,{'kind':'save','action':'cancel','path':str(root/'cancelled.html')}),root/'cancelled.html')

    def test_one_modal_trigger_is_joined_after_actual_dialog_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);case=root/'case';case.mkdir();clicked=threading.Event();operated=threading.Event()
            def click(selector):
                self.assertEqual(selector,'#export');clicked.set();self.assertTrue(operated.wait(2))
            def operate(ctx,path,**kwargs):
                self.assertTrue(clicked.wait(2));operated.set();return {'pid':123,'transport':'real OS chooser'}
            ctx=SimpleNamespace(case_dir=case,session=SimpleNamespace(click=click))
            with patch.object(file_dialog.platform,'system',return_value='Linux'),patch('qa_ui_auto.folder_dialog.linux_dialog',side_effect=operate):
                file_dialog.run(ctx,{'kind':'save','action':'cancel','trigger':'#export'})
            receipt=json.loads((case/'native-file-dialogs.jsonl').read_text())
            self.assertTrue(receipt['passed']);self.assertEqual(receipt['pid'],123)

    def test_operational_failure_is_never_reported_as_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx=SimpleNamespace(case_dir=Path(tmp))
            with patch.object(file_dialog.platform,'system',return_value='Linux'),patch('qa_ui_auto.folder_dialog.linux_dialog',side_effect=StepError('no owned dialog')):
                with self.assertRaisesRegex(StepError,'no owned dialog'):file_dialog.run(ctx,{'kind':'save','action':'cancel'})
            self.assertFalse(json.loads((ctx.case_dir/'native-file-dialogs.jsonl').read_text())['passed'])

    def test_native_paste_requires_focus_and_uses_OS_not_clipboard_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            session=SimpleNamespace(application=Path('/qa/taomni'),execute=Mock(return_value=False))
            ctx=SimpleNamespace(case_dir=Path(tmp),session=session)
            with self.assertRaisesRegex(StepError,'focus'):native_paste.run(ctx,{'selector':'.cm-content'})
            session.execute.return_value=True
            with patch.object(native_paste.platform,'system',return_value='Linux'),patch('qa_ui_auto.wayland.active',return_value=False),patch('qa_ui_auto.native_steps._activate_x11_application',return_value=('0x1','owned')),patch('qa_ui_auto.native_steps._inject_x11_keys') as keys:
                native_paste.run(ctx,{'selector':'.cm-content'})
            keys.assert_called_once_with(['Control+v'])
            receipt=json.loads((ctx.case_dir/'native-paste.jsonl').read_text())
            self.assertTrue(receipt['passed']);self.assertFalse(receipt['syntheticClipboardEvent'])

    def test_windows_native_paste_qualifies_system_threading_thread_sleep(self):
        self.assertIn('System.Threading.Thread.Sleep(', native_paste.WIN)

    def test_native_session_text_uses_textcontent_for_svg_elements(self):
        from tauri_webdriver import NativeSession
        session=NativeSession('http://driver.invalid',Path('/qa/taomni'))
        session.execute=Mock(return_value='Markdown Source')
        session.find=Mock()
        self.assertEqual(session.text('svg.flowchart'),'Markdown Source')
        script=session.execute.call_args.args[0]
        self.assertIn('SVGElement',script)
        self.assertIn('textContent',script)
        session.find.assert_not_called()


class GlobalEntryContracts(unittest.TestCase):
    def test_native_terminal_click_uses_one_synchronized_pointer_with_modifier_and_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            session=SimpleNamespace(execute=Mock(return_value={'x':20,'y':40,'width':800,'height':400,'hit':True}),request=Mock(),endpoint=lambda path:path)
            ctx=SimpleNamespace(case_dir=Path(tmp),session=session)
            with patch.object(terminal_file_link.platform,'system',return_value='Linux'),patch('qa_ui_auto.deadline.budget_time.sleep'):
                terminal_file_link.native(ctx,{'selector':'#terminal'})
            calls=session.request.call_args_list
            actions=next(call.args[2]['actions'] for call in calls if call.args[1]=='/actions' and call.args[0]=='POST' and len(call.args[2]['actions'])==2)
            keyboard,pointer=actions
            self.assertEqual(keyboard['actions'][0],{'type':'keyDown','value':''})
            self.assertEqual([item['type'] for item in pointer['actions']].count('pointerDown'),1)
            self.assertEqual(keyboard['actions'][-1],{'type':'keyUp','value':''})
            self.assertEqual(calls[-1].args,('DELETE','/actions'))

    def test_native_terminal_click_parks_on_distinct_cell_before_hover(self):
        with tempfile.TemporaryDirectory() as tmp:
            session=SimpleNamespace(execute=Mock(return_value={'x':20,'y':40,'parkX':780,'parkY':380,'width':800,'height':400,'hit':True}),request=Mock(),endpoint=lambda path:path)
            ctx=SimpleNamespace(case_dir=Path(tmp),session=session)
            with patch.object(terminal_file_link.platform,'system',return_value='Windows'),patch('qa_ui_auto.deadline.budget_time.sleep'):
                terminal_file_link.native(ctx,{'selector':'#terminal'})
            posts=[call.args[2]['actions'] for call in session.request.call_args_list if call.args[0]=='POST' and call.args[1]=='/actions']
            self.assertEqual(len(posts),3)
            self.assertEqual(posts[0][0]['actions'][0],{'type':'pointerMove','origin':'viewport','x':780,'y':380,'duration':0})
            self.assertEqual(posts[1][0]['actions'][0],{'type':'pointerMove','origin':'viewport','x':20,'y':40,'duration':0})
            self.assertEqual(len(posts[2]),2)

    def test_file_link_transition_asserts_automatic_chat_hide_without_clicking_hidden_control(self):
        import yaml
        from qa_ui_auto.testcase import load_case
        from qa_ui_auto.behavior_contract import validate_contract
        root=Path(__file__).resolve().parents[4]
        path=next((root/'qa-ui-auto-tests/cases').glob('TC-FILE-OPEN-008-*.testcase.yaml'))
        doc=yaml.safe_load(path.read_text(encoding='utf-8'))
        # Hosted run43526262110: all three browser platforms proved exact AI
        # file content, then timed out clicking this already-hidden drawer.
        # Preserve that successful content checkpoint and the remaining real
        # Git/SFTP workflow; assert the actual automatic context transition.
        self.assertEqual(doc['steps'][13]['assert_items']['equals'],['repo-b WORKTREE','shared line',''])
        self.assertEqual(doc['steps'][14],{'assert_not_visible':'[data-testid="ai-chat-drawer"]'})
        self.assertFalse(any(step.get('click')=='[data-testid="ai-chat-drawer-hide"]' for step in doc['steps']))
        self.assertEqual(validate_contract(doc),[])
        load_case(path)

    def test_global_entry_fixture_seeds_persisted_conversation_and_only_owned_remote_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);case=root/'case';case.mkdir()
            ctx=SimpleNamespace(case_dir=case,values={'parity008_root':'/preview/parity008'},page=Mock(),cfg={'app':{'mode':'browser'},'ssh_posix':{'host':'127.0.0.1','port':2222,'user':'qa'}},env={'QA_POSIX_SSH_PASSWORD':'fixture-only'})
            client=MagicMock();sftp=client.open_sftp.return_value.__enter__.return_value
            with patch.object(file_open_entries.file_open_files,'setup'),patch.object(file_open_entries.parity008_git,'setup'),patch('paramiko.SSHClient',return_value=client):
                file_open_entries.setup(ctx)
                remote=ctx.values['file_open_entry_remote']
                self.assertTrue(remote.startswith('/tmp/taomni-file-open-'))
                sftp.mkdir.assert_called_once_with(remote)
                sftp.file.assert_called_once_with(remote+'/remote.txt','wb')
                payload=ctx.page.evaluate.call_args.args[1]
                self.assertEqual(payload[0]['title'],'QA file path entry')
                self.assertIn('/preview/parity008/repo-b/same.txt',payload[1]['content'])
                self.assertNotIn('useChatStore',ctx.page.evaluate.call_args.args[0])
                file_open_entries.teardown(ctx)
                sftp.remove.assert_called_once_with(remote+'/remote.txt')
                sftp.rmdir.assert_called_once_with(remote)
                client.close.assert_called_once()


class MarkdownNativeArtifactsTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);self.ctx=SimpleNamespace(case_dir=self.root/'case',report_root=self.root,values={},cfg={'app':{'mode':'native'}},case_id='unit',worker_id=0)
        with patch('qa_ui_auto.host_clipboard.get_text', return_value='previous clipboard'):
            markdown_native.setup(self.ctx)
        self.source=Path(self.ctx.values['markdown_native_source']);self.clipboard=Path(self.ctx.values['markdown_native_clipboard'])
        self.manifest=json.loads((self.ctx.case_dir/'markdown-native-fixture.json').read_text())
        self.exports=Path(self.ctx.values['markdown_native_exports'])

    def test_os_paste_asset_pixels_and_source_hash_are_independently_checked(self):
        asset=self.source.parent/'assets/image-test.png';asset.write_bytes(self.clipboard.read_bytes())
        with self.source.open('a') as stream:stream.write('\n![image](assets/image-test.png)\n')
        artifacts.check_artifact('pasted-image',self.source,self.source,self.manifest)
        artifacts.check_artifact('source',self.source,self.source,self.manifest)
        self.source.write_text('changed')
        with self.assertRaises(StepError):artifacts.check_artifact('source',self.source,self.source,self.manifest)

    def test_html_docx_and_markdown_require_real_image_pixels_and_contents(self):
        image=base64.b64encode(self.clipboard.read_bytes()).decode()
        diagram_svg='<svg xmlns="http://www.w3.org/2000/svg" width="480" height="100"><text>Markdown Source</text><text>Live Diagram</text><text>Export Artifact</text><path d="M0 0L100 100"/></svg>'
        html=self.exports/'native.html';html.write_text('<h1>File open Markdown</h1><strong>Rendered bold</strong><span class="katex">x^2</span>'+f'<img src="data:image/png;base64,{image}">'*2+diagram_svg)
        artifacts.check_artifact('html',html,self.source,self.manifest)
        html.write_text('<h1>File open Markdown</h1><strong>Rendered bold</strong><img src="assets/pixel.png">')
        with self.assertRaises(StepError):artifacts.check_artifact('html',html,self.source,self.manifest)
        docx=self.exports/'native.docx'
        from PIL import Image, ImageDraw
        diagram_png=io.BytesIO();diagram=Image.new('RGB',(480,100),'white');drawing=ImageDraw.Draw(diagram)
        drawing.rectangle((10,10,120,80),fill=(219,234,254));drawing.rectangle((160,10,280,80),fill=(220,252,231));drawing.rectangle((320,10,470,80),fill=(254,243,199));diagram.save(diagram_png,format='PNG')
        with zipfile.ZipFile(docx,'w') as archive:
            archive.writestr('word/document.xml','<document>File open Markdown Rendered bold</document>')
            archive.writestr('word/media/one.png',self.clipboard.read_bytes());archive.writestr('word/media/two.png',self.clipboard.read_bytes());archive.writestr('word/media/diagram.png',diagram_png.getvalue())
        artifacts.check_artifact('docx',docx,self.source,self.manifest)
        directory=self.exports/'live';(directory/'assets').mkdir(parents=True)
        (directory/'assets/a.png').write_bytes(self.clipboard.read_bytes());(directory/'assets/b.png').write_bytes(self.clipboard.read_bytes())
        (directory/self.source.name).write_text('# File open Markdown\n![a](assets/a.png)\n![b](assets/b.png)\n\n```mermaid\nflowchart LR\nA[Markdown Source]-->B[Live Diagram]-->C[Export Artifact]\n```\n')
        artifacts.check_artifact('markdown',directory,self.source,self.manifest)
        (directory/'assets/b.png').unlink()
        with self.assertRaises(StepError):artifacts.check_artifact('markdown',directory,self.source,self.manifest)

    def test_clipboard_fixture_cleanup_restores_text_and_records_format_boundary(self):
        with patch('qa_ui_auto.host_clipboard.set_text') as restore,patch('qa_ui_auto.host_clipboard.clear') as clear:
            markdown_native.teardown(self.ctx)
        restore.assert_called_once_with('previous clipboard');clear.assert_not_called()
        self.assertTrue(json.loads((self.ctx.case_dir/'markdown-clipboard-cleanup.json').read_text())['nonTextPreviousFormatsNotRestored'])

    def test_png_cancel_and_failed_receipts(self):
        from PIL import Image, ImageDraw
        image=Image.new('RGB',(800,400),'white')
        drawing=ImageDraw.Draw(image)
        drawing.rectangle((20,200,120,280),fill=(219,234,254));drawing.rectangle((180,200,280,280),fill=(220,252,231));drawing.rectangle((340,200,440,280),fill=(254,243,199))
        with Image.open(self.clipboard) as pasted:image.paste(pasted.convert('RGB'),(30,40))
        png=self.exports/'native.png';image.save(png)
        artifacts.check_artifact('png',png,self.source,self.manifest)
        artifacts.run(self.ctx,{'kind':'absent','path':str(self.exports/'cancelled.html'),'source':str(self.source)})
        with self.assertRaises(StepError):artifacts.run(self.ctx,{'kind':'html','path':str(self.exports/'missing.html'),'source':str(self.source),'timeout_sec':0})
        records=[json.loads(line) for line in (self.ctx.case_dir/'markdown-artifacts.jsonl').read_text().splitlines()]
        self.assertEqual([record['passed'] for record in records],[True,False])


if __name__=='__main__':unittest.main()
