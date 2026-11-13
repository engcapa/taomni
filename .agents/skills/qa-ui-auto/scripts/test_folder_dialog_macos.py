"""Scope and selection contracts for the macOS OS automation helper.

The real NSOpenPanel boundary is verified by native cases on macOS. This AX
model catches accidental traversal of the WebView and confusion with Home's
ordinary Open button before spending a hosted native run.
"""
import json
import subprocess
import unittest
from pathlib import Path


HARNESS = r"""
const fs = require('fs'), vm = require('vm');
const config = JSON.parse(process.argv[1]), actions = [];
const application = '/Users/runner/work/taomni/taomni/src-tauri/target/qa-ui-auto/debug/taomni';
const env = { QA_PICKER_APPLICATION:application, QA_PICKER_PATH:'/qa/fixture/project with spaces',
  QA_PICKER_TITLE:config.kind === 'save' ? 'Save as' : 'Select folder to open', QA_PICKER_ACTION:config.action,
  QA_PICKER_KIND:config.kind || 'folder', QA_PICKER_DIRECTORY:'/qa/fixture/project with spaces', QA_PICKER_FILENAME:'export.html',
  QA_PICKER_CANCEL_AFTER_PATH:config.cancelAfterPath ? '1' : '' };
let navigated = false, now = 0, opened = true, goTo = false, location = '';
const actionName = config.actionName || (config.kind === 'save' ? 'Save' : 'Open');
let savedName='live.html';
const nameField={enabled:()=>true,attributes:{byName:()=>({value:()=> 'saveAsName'})}};
Object.defineProperty(nameField,'value',{get:()=>()=>savedName,set:(value)=>{savedName=value;actions.push('name:'+value);}});
const button = (name) => ({name:()=>name, enabled:()=>name === 'Cancel' || navigated,
  click:()=>{actions.push(name);opened=false;}});
const field = {};
Object.defineProperty(field,'value',{get:()=>()=>location,set:(value)=>{location=value;actions.push(value);}});
const locationSheet = {textFields:()=>now >= (config.slowGoTo ? 800 : 0) ? [field] : []};
const panel = {buttons:Object.assign(()=>[button(actionName),button('Cancel')],
  {whose:({name})=>()=>name === actionName || name === 'Cancel' ? [button(name)] : []}),
  sheets:()=>goTo ? [locationSheet] : [], textFields:()=>config.kind === 'save' ? [nameField] : [], groups:()=>[]};
const main = {sheets:()=>!opened ? [] : config.standalone ? (goTo ? [locationSheet] : []) : [panel],
  subrole:()=>config.standalone ? 'AXDialog' : 'AXStandardWindow',
  name:()=>config.standalone ? env.QA_PICKER_TITLE : 'Taomni',
  uiElements:()=>{throw new Error('must never traverse the main WebView')},
  buttons: config.standalone ? panel.buttons : {whose:()=>{throw new Error('Home is not NSOpenPanel')}},
  textFields:()=>[],comboBoxes:()=>[]};
const owner = {windows:()=>config.standalone && !opened ? [] : [main],unixId:()=>123};
const events = {processes:{whose:(query)=>{
  if(query.unixId !== undefined && query.unixId !== 123) throw new Error('unowned PID');
  if(query.frontmost) return ()=>[owner];
  return [owner];
}},
  keystroke:(key)=>{actions.push(key);if(key==='g')goTo=true;},
  keyCode:(key)=>{actions.push(key);if(key===36){navigated=location===env.QA_PICKER_PATH;goTo=false;}}};
const nativeApps = [{executableURL:{path:application},processIdentifier:123}];
if(config.duplicate) nativeApps.push({executableURL:{path:application},processIdentifier:124});
const context = {$:{NSProcessInfo:{processInfo:{environment:{objectForKey:(key)=>env[key]}}},
  NSWorkspace:{sharedWorkspace:{runningApplications:{count:nativeApps.length,objectAtIndex:(i)=>nativeApps[i]}}}},
  ObjC:{import:()=>{},unwrap:(value)=>value}, Application:(name)=>events,
  delay:(seconds)=>{now+=seconds*1000},Date:{now:()=>now},console:{log:()=>{}},JSON};
let result, error;
try {result=JSON.parse(vm.runInNewContext(fs.readFileSync(process.argv[2],'utf8'),context));}
catch(e){error=e.message;}
process.stdout.write(JSON.stringify({result,error,actions}));
"""


class MacFolderDialogContracts(unittest.TestCase):
    def run_helper(self, **config):
        helper = Path(__file__).parent / "qa_ui_auto" / "folder_dialog_macos.js"
        result = subprocess.run(["node", "-e", HARNESS, json.dumps(config), str(helper)],
                                capture_output=True, text=True, check=True, timeout=10)
        return json.loads(result.stdout)

    def test_disabled_open_does_not_hide_the_sheet_or_trigger_webview_traversal(self):
        observed = self.run_helper(action="choose")
        self.assertNotIn("error", observed)
        self.assertEqual(observed["result"]["pid"], 123)
        self.assertEqual(observed["actions"], ["g", "/qa/fixture/project with spaces", 36, "Open"])

    def test_waits_for_the_go_to_folder_field_before_entering_the_path(self):
        observed = self.run_helper(action="choose", slowGoTo=True)
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"], ["g", "/qa/fixture/project with spaces", 36, "Open"])

    def test_cancel_never_types_or_accepts_a_directory(self):
        observed = self.run_helper(action="cancel")
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"], ["Cancel"])

    def test_standalone_native_dialog_is_also_supported(self):
        observed = self.run_helper(action="choose", standalone=True)
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"][-1], "Open")

    def test_folder_chooser_alternate_action_label_is_supported(self):
        observed = self.run_helper(action="choose", actionName="Choose")
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"][-1], "Choose")

    def test_save_panel_uses_parent_directory_and_exact_filename(self):
        observed = self.run_helper(action="choose", kind="save")
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"], ["g", "/qa/fixture/project with spaces", 36, "name:export.html", "Save"])

    def test_save_panel_cancel_never_enters_name_or_chooses_path(self):
        observed = self.run_helper(action="cancel", kind="save")
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"], ["Cancel"])

    def test_save_panel_can_cancel_a_typed_owned_filename_without_accepting(self):
        observed = self.run_helper(action="cancel", kind="save", cancelAfterPath=True)
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"], ["g", "/qa/fixture/project with spaces", 36, "name:export.html", "Cancel"])

    def test_ambiguous_executable_owner_prevents_all_os_input(self):
        observed = self.run_helper(action="choose", duplicate=True)
        self.assertIn("unique process", observed["error"])
        self.assertEqual(observed["actions"], [])


if __name__ == "__main__":
    unittest.main()
