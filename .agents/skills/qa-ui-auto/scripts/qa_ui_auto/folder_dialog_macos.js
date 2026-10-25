// Operates only the NSOpenPanel belonging to this invocation's QA executable.
ObjC.import("Foundation");
const env = $.NSProcessInfo.processInfo.environment;
const readEnv = (key) => ObjC.unwrap(env.objectForKey(key));
const application = readEnv("QA_PICKER_APPLICATION");
const path = readEnv("QA_PICKER_PATH");
const events = Application("System Events");
const shell = Application.currentApplication();
shell.includeStandardAdditions = true;
function nodes(element, depth = 0) {
  if (depth > 12) return [];
  let children = [];
  try { children = element.uiElements(); } catch (_) { return []; }
  return children.reduce((all, child) => all.concat([child], nodes(child, depth + 1)), []);
}
function buttons(owner, name) {
  return nodes(owner).filter((node) => {
    try { return node.role() === "AXButton" && node.name() === name && node.enabled(); }
    catch (_) { return false; }
  });
}
let process = null;
let panel = null;
const deadline = Date.now() + 20000;
while (Date.now() < deadline && !panel) {
  for (const candidate of events.processes.whose({ backgroundOnly: false })()) {
    let pid;
    try { pid = candidate.unixId(); } catch (_) { continue; }
    // PID is numeric; application paths never enter a shell command.
    let executable;
    try { executable = shell.doShellScript("ps -p " + Number(pid) + " -o comm=").trim(); }
    catch (_) { continue; }
    if (executable !== application) continue;
    for (const window of candidate.windows()) {
      if (buttons(window, "Open").length === 1 && buttons(window, "Cancel").length === 1) {
        process = candidate;
        panel = window;
        break;
      }
    }
    if (panel) break;
  }
  if (!panel) delay(0.1);
}
if (!panel) throw new Error("No unique folder chooser owned by the QA executable");
process.frontmost = true;
if (readEnv("QA_PICKER_ACTION") === "cancel") {
  buttons(panel, "Cancel")[0].click();
} else {
  events.keystroke("g", { using: ["command down", "shift down"] });
  delay(0.4);
  events.keystroke("a", { using: ["command down"] });
  events.keystroke(path);
  events.keyCode(36);
  delay(0.6);
  const open = buttons(panel, "Open");
  if (open.length !== 1) throw new Error("Folder chooser Open button unavailable");
  open[0].click();
}
JSON.stringify({ transport: "macOS Accessibility and OS keyboard", pid: process.unixId(), application });
