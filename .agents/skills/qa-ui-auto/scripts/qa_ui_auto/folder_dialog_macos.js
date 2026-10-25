// Operates only the NSOpenPanel belonging to this invocation's QA executable.
ObjC.import("Foundation");
const env = $.NSProcessInfo.processInfo.environment;
const readEnv = (key) => ObjC.unwrap(env.objectForKey(key));
const application = readEnv("QA_PICKER_APPLICATION");
const path = readEnv("QA_PICKER_PATH");
const title = readEnv("QA_PICKER_TITLE");
const events = Application("System Events");
const shell = Application.currentApplication();
shell.includeStandardAdditions = true;
const log = (stage) => console.log("native_folder_dialog: " + stage);
// Resolve the executable once. Recursing through the main window's complete
// accessibility tree walks the whole WebView and can take minutes on CI.
// Darwin's `comm` field is only the executable basename. Use the unbounded
// command line so the QA app's full path remains available for ownership.
const processes = shell.doShellScript("ps -axww -o pid=,args=").split("\n").map((line) => {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  return match ? { pid: Number(match[1]), path: match[2].split(/\s+/, 1)[0] } : null;
}).filter((process) => process !== null);
const owners = processes.filter((process) => process.path === application).map((process) => process.pid);
if (owners.length !== 1) {
  log("expected executable " + application + "; candidates " + JSON.stringify(processes.filter((process) => process.path.includes("taomni"))));
  throw new Error("No unique process for the QA executable");
}
const process = events.processes.whose({ unixId: owners[0] })[0];
log("owned process " + owners[0]);
function buttons(owner, name, enabled = false) {
  // Native Open/Cancel buttons are direct children of NSOpenPanel. Query only
  // the panel, never Home's unrelated Open button in the underlying WebView.
  return owner.buttons.whose({ name })().filter((button) => !enabled || button.enabled());
}
function findPanel() {
  const panels = [];
  for (const window of process.windows()) {
    let sheets = [];
    try { sheets = window.sheets(); } catch (_) { }
    panels.push(...sheets);
    try {
      if (window.subrole() === "AXDialog" || window.name() === title) panels.push(window);
    } catch (_) { }
  }
  const owned = panels.filter((owner) => buttons(owner, "Open").length === 1 && buttons(owner, "Cancel").length === 1);
  return owned.length === 1 ? owned[0] : null;
}
let panel = null;
const deadline = Date.now() + 20000;
while (Date.now() < deadline && !panel) {
  panel = findPanel();
  if (!panel) delay(0.1);
}
if (!panel) throw new Error("No unique folder chooser owned by the QA executable");
log("owned NSOpenPanel found");
process.frontmost = true;
if (readEnv("QA_PICKER_ACTION") === "cancel") {
  buttons(panel, "Cancel", true)[0].click();
} else {
  events.keystroke("g", { using: ["command down", "shift down"] });
  delay(0.4);
  events.keystroke("a", { using: ["command down"] });
  events.keystroke(path);
  events.keyCode(36);
  log("Go to Folder submitted");
  delay(0.6);
  const open = buttons(panel, "Open", true);
  if (open.length !== 1) throw new Error("Folder chooser Open button unavailable");
  open[0].click();
}
log("chooser action submitted");
JSON.stringify({ transport: "macOS Accessibility and OS keyboard", pid: process.unixId(), application });
