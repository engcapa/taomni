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
  QA_PICKER_TITLE:'Select folder to open', QA_PICKER_ACTION:config.action };
let navigated = false, now = 0;
const button = (name) => ({enabled:()=>name === 'Cancel' || navigated, click:()=>actions.push(name)});
const panel = {buttons:{whose:({name})=>()=>[button(name)]}};
const main = {sheets:()=>config.standalone ? [] : [panel],
  subrole:()=>config.standalone ? 'AXDialog' : 'AXStandardWindow',
  name:()=>config.standalone ? env.QA_PICKER_TITLE : 'Taomni',
  uiElements:()=>{throw new Error('must never traverse the main WebView')},
  buttons: config.standalone ? panel.buttons : {whose:()=>{throw new Error('Home is not NSOpenPanel')}}};
const owner = {windows:()=>[main],unixId:()=>123};
const events = {processes:{whose:(query)=>{
  if(query.unixId !== undefined && query.unixId !== 123) throw new Error('unowned PID');
  if(query.frontmost) return ()=>[owner];
  return [owner];
}},
  keystroke:(key)=>actions.push(key), keyCode:(key)=>{actions.push(key);if(key===36)navigated=true;}};
const shell = {doShellScript:(command)=>{
  if(command === 'ps -ax -o pid=,comm=') return '123 taomni';
  if(command !== 'ps -axww -o pid=,args=') return ('  123 ' + application).slice(0,79);
  return config.duplicate ? '123 ' + application + '\n124 ' + application : '123 ' + application + '\n456 /other/taomni';
}};
const context = {$:{NSProcessInfo:{processInfo:{environment:{objectForKey:(key)=>env[key]}}}},
  ObjC:{import:()=>{},unwrap:(value)=>value}, Application:(name)=>name==='System Events'?events:shell,
  delay:(seconds)=>{now+=seconds*1000},Date:{now:()=>now},console:{log:()=>{}},JSON};
context.Application.currentApplication=()=>shell;
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
        self.assertEqual(observed["actions"], ["g", "a", "/qa/fixture/project with spaces", 36, "Open"])

    def test_cancel_never_types_or_accepts_a_directory(self):
        observed = self.run_helper(action="cancel")
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"], ["Cancel"])

    def test_standalone_native_dialog_is_also_supported(self):
        observed = self.run_helper(action="choose", standalone=True)
        self.assertNotIn("error", observed)
        self.assertEqual(observed["actions"][-1], "Open")

    def test_ambiguous_executable_owner_prevents_all_os_input(self):
        observed = self.run_helper(action="choose", duplicate=True)
        self.assertIn("unique process", observed["error"])
        self.assertEqual(observed["actions"], [])


if __name__ == "__main__":
    unittest.main()
