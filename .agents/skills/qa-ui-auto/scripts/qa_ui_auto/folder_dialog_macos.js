// Operates only the NSOpenPanel belonging to this invocation's QA executable.
ObjC.import("AppKit");
const env = $.NSProcessInfo.processInfo.environment;
const readEnv = (key) => ObjC.unwrap(env.objectForKey(key));
const application = readEnv("QA_PICKER_APPLICATION");
const path = readEnv("QA_PICKER_PATH");
const title = readEnv("QA_PICKER_TITLE");
const events = Application("System Events");
const log = (stage) => console.log("native_folder_dialog: " + stage);
const kind = readEnv("QA_PICKER_KIND") || "folder";
const actionNames = kind === "save" ? ["Save"] : ["Open", "Choose", "Select", "Select Folder"];
const parentPath = readEnv("QA_PICKER_DIRECTORY") || path;
const filename = readEnv("QA_PICKER_FILENAME");
// NSWorkspace supplies the executable URL without ps argv truncation or a
// frontmost-process fallback, which can resolve to the automation host itself.
const applications = $.NSWorkspace.sharedWorkspace.runningApplications;
const owners = [];
for (let i = 0; i < applications.count; i++) {
  const candidate = applications.objectAtIndex(i);
  try {
    if (ObjC.unwrap(candidate.executableURL.path) === application) owners.push(Number(candidate.processIdentifier));
  } catch (_) { }
}
if (owners.length !== 1) throw new Error("No unique process for the QA executable: " + JSON.stringify(owners));
const process = events.processes.whose({ unixId: owners[0] })[0];
log("owned process " + owners[0]);
function buttons(owner, name, enabled = false) {
  return owner.buttons.whose({ name })().filter((button) => !enabled || button.enabled());
}
function actionButtons(owner, enabled = false) {
  for (const name of actionNames) {
    try { const found = buttons(owner, name, enabled); if (found.length) return found; } catch (_) { }
  }
  return [];
}
function findPanel() {
  const panels = [];
  for (const window of process.windows()) {
    try { panels.push(...window.sheets()); } catch (_) { }
    try { if (window.subrole() === "AXDialog" || window.name() === title) panels.push(window); } catch (_) { }
  }
  const owned = panels.filter((owner) => {
    try { return actionButtons(owner).length === 1 && buttons(owner, "Cancel").length === 1; } catch (_) { return false; }
  });
  return owned.length === 1 ? owned[0] : null;
}
function waitFor(probe, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = probe(); if (result) return result; } catch (_) { }
    delay(0.1);
  }
  throw new Error(description);
}
function locationField(panel) {
  // Only descend native sheets/groups of NSOpenPanel. Never recurse through
  // the underlying application's WebView accessibility tree.
  const sheets = panel.sheets();
  const candidates = [...sheets];
  for (const window of process.windows()) {
    try { if (window.subrole() === "AXDialog" && window.name() !== title) candidates.push(window); } catch (_) { }
  }
  for (const sheet of candidates) {
    const nodes = [sheet];
    for (let depth = 0, start = 0; depth < 3; depth++) {
      const end = nodes.length;
      for (let i = start; i < end; i++) {
        try { const fields = nodes[i].textFields(); if (fields.length === 1) return fields[0]; } catch (_) { }
        try {
          const combos = nodes[i].comboBoxes();
          if (combos.length === 1) {
            const fields = combos[0].textFields();
            return fields.length === 1 ? fields[0] : combos[0];
          }
        } catch (_) { }
        try { nodes.push(...nodes[i].groups()); } catch (_) { }
      }
      start = end;
    }
  }
  return null;
}
function describePanel(panel) {
  try {
    return JSON.stringify({ buttons: panel.buttons().map((button) => ({ name: button.name(), enabled: button.enabled() })),
      sheets: panel.sheets().map((sheet) => ({ name: sheet.name(), role: sheet.role() })) });
  } catch (error) { return String(error); }
}
const panel = waitFor(findPanel, "No unique folder chooser owned by the QA executable", 20000);
log("owned NSOpenPanel found");
process.frontmost = true;
const screenshot = readEnv("QA_PICKER_SCREENSHOT");
if (screenshot) {
  const capture = $.NSTask.alloc.init;
  capture.launchPath = "/usr/sbin/screencapture";
  capture.arguments = ["-x", screenshot];
  capture.launch;
  capture.waitUntilExit;
  if (Number(capture.terminationStatus) !== 0) throw new Error("Could not capture the owned folder chooser");
}
try {
  const cancelAfterPath = readEnv("QA_PICKER_CANCEL_AFTER_PATH") === "1";
  if (readEnv("QA_PICKER_ACTION") === "cancel" && !cancelAfterPath) {
    buttons(panel, "Cancel", true)[0].click();
  } else {
    events.keystroke("g", { using: ["command down", "shift down"] });
    const field = waitFor(() => locationField(findPanel() || panel), "Go to Folder location field unavailable");
    const location = kind === "save" ? parentPath : path;
    field.value = location;
    if (field.value() !== location) throw new Error("Go to Folder did not retain the complete path");
    events.keyCode(36);
    log("Go to Folder submitted");
    waitFor(() => !locationField(findPanel() || panel), "Go to Folder did not finish navigation");
    if (kind === "save") {
      // Limit traversal to native panel groups. NSSavePanel's filename is the
      // enabled text field whose AX identifier or label names the save name.
      const current = findPanel();
      const nodes = [current];
      const candidates = [];
      for (let depth = 0, start = 0; depth < 4; depth++) {
        const end = nodes.length;
        for (let i = start; i < end; i++) {
          try { candidates.push(...nodes[i].textFields()); } catch (_) { }
          try { nodes.push(...nodes[i].groups()); } catch (_) { }
        }
        start = end;
      }
      const named = candidates.filter((candidate) => {
        try {
          const identifier = String(candidate.attributes.byName("AXIdentifier").value());
          return /save|name/i.test(identifier) && candidate.enabled();
        } catch (_) {
          try { return /save as|name/i.test(String(candidate.description())) && candidate.enabled(); } catch (_) { return false; }
        }
      });
      const target = named.length === 1 ? named[0] : candidates.filter((candidate) => {
        try { return candidate.enabled() && String(candidate.value()).includes("."); } catch (_) { return false; }
      });
      const name = Array.isArray(target) ? (target.length === 1 ? target[0] : null) : target;
      if (!name) throw new Error("NSSavePanel filename field is not unique");
      name.value = filename;
      if (name.value() !== filename) throw new Error("NSSavePanel did not retain filename");
    }
    const open = waitFor(() => {
      const current = findPanel();
      return current && (cancelAfterPath ? buttons(current, "Cancel", true)[0] : actionButtons(current, true)[0]);
    }, "Native chooser action button unavailable");
    open.click();
  }
  waitFor(() => !findPanel(), "Folder chooser did not close");
} catch (error) {
  log("AX state " + describePanel(findPanel() || panel));
  throw error;
}
log("chooser action submitted");
JSON.stringify({ transport: "macOS Accessibility and OS keyboard", pid: owners[0], application });
