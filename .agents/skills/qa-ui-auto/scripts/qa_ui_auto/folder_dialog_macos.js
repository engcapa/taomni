// Operates only the AppKit file panel belonging to this invocation's QA executable.
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
const layoutRoles = new Set([
  "AXGroup", "AXLayoutArea", "AXLayoutItem", "AXPane", "AXRemoteElement", "AXRemoteView",
  "AXScrollArea", "AXSplitGroup", "AXUnknown", "AXView",
]);
const safely = (read, fallback) => {
  try { return read(); } catch (_) { return fallback; }
};
const elements = (owner) => safely(() => owner.uiElements(), []);
const role = (node) => safely(() => node.role(), "");
function controls(owner, collection, expectedRole) {
  const typed = safely(() => owner[collection](), []);
  return typed.length ? typed : elements(owner).filter((node) => role(node) === expectedRole);
}
function nativeContainers(owner) {
  const nodes = [owner];
  for (let depth = 0, start = 0; depth < 6 && start < nodes.length; depth++) {
    const end = nodes.length;
    for (let i = start; i < end; i++) {
      // These roots belong to an identified OS sheet or native modal window.
      // Do not enter WebView, outline or table content below those roots.
      const layouts = elements(nodes[i]).filter((node) => layoutRoles.has(role(node)));
      nodes.push(...(layouts.length ? layouts : safely(() => nodes[i].groups(), [])));
    }
    start = end;
  }
  return nodes;
}
function buttons(owner, names, enabled = false) {
  return nativeContainers(owner)
    .flatMap((node) => controls(node, "buttons", "AXButton"))
    .filter((button) => safely(() => names.includes(button.name()) && (!enabled || button.enabled()), false));
}
function candidatePanels() {
  const panels = [];
  for (const window of process.windows()) {
    panels.push(...controls(window, "sheets", "AXSheet"));
    try {
      if (["AXDialog", "AXSystemDialog"].includes(window.subrole()) || [title, ...actionNames].includes(window.name())) {
        panels.push(window);
      } else if (window.attributes.byName("AXModal").value() === true) {
        panels.push(window);
      }
    } catch (_) { }
  }
  return panels;
}
function findPanel() {
  const owned = candidatePanels().filter((owner) =>
    buttons(owner, actionNames).length === 1 && buttons(owner, ["Cancel"]).length === 1
  );
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
  const candidates = nativeContainers(panel)
    .flatMap((node) => controls(node, "sheets", "AXSheet"));
  for (const window of process.windows()) {
    try { if (window.subrole() === "AXDialog" && window.name() !== title) candidates.push(window); } catch (_) { }
  }
  for (const sheet of candidates) {
    for (const node of nativeContainers(sheet)) {
      const fields = controls(node, "textFields", "AXTextField");
      if (fields.length === 1) return fields[0];
      const combos = controls(node, "comboBoxes", "AXComboBox");
      if (combos.length === 1) {
        const entry = controls(combos[0], "textFields", "AXTextField");
        return entry.length === 1 ? entry[0] : combos[0];
      }
    }
  }
  return null;
}
function describePanel(panel) {
  try {
    return {
      rootRole: role(panel),
      children: elements(panel).slice(0, 12).map(role),
      buttons: controls(panel, "buttons", "AXButton").map((button) => ({
        name: safely(() => button.name(), null), enabled: safely(() => button.enabled(), null),
      })),
      sheets: controls(panel, "sheets", "AXSheet").map((sheet) => ({
        name: safely(() => sheet.name(), null), role: role(sheet),
      })),
    };
  } catch (error) { return String(error); }
}
const screenshot = readEnv("QA_PICKER_SCREENSHOT");
function captureScreenshot() {
  if (!screenshot) return;
  const capture = $.NSTask.alloc.init;
  capture.launchPath = "/usr/sbin/screencapture";
  capture.arguments = ["-x", screenshot];
  capture.launch;
  capture.waitUntilExit;
  if (Number(capture.terminationStatus) !== 0) throw new Error("Could not capture the owned folder chooser");
}
let panel;
try {
  panel = waitFor(findPanel, "No unique file chooser owned by the QA executable", 20000);
} catch (error) {
  try {
    log("AX windows " + JSON.stringify(process.windows().map((window) => ({
      name: window.name(), role: window.role(), subrole: window.subrole(), contents: describePanel(window),
    }))));
    log("AX candidate panels " + JSON.stringify(candidatePanels().map((owner) =>
      nativeContainers(owner).slice(0, 24).map(describePanel))));
  } catch (_) { }
  try { captureScreenshot(); } catch (_) { }
  throw error;
}
log("owned AppKit file panel found");
process.frontmost = true;
captureScreenshot();
try {
  const cancelAfterPath = readEnv("QA_PICKER_CANCEL_AFTER_PATH") === "1";
  if (readEnv("QA_PICKER_ACTION") === "cancel" && !cancelAfterPath) {
    const cancel = buttons(panel, ["Cancel"], true);
    if (cancel.length !== 1) throw new Error("Native chooser cancel button unavailable");
    cancel[0].click();
  } else {
    events.keystroke("g", { using: ["command down", "shift down"] });
    const field = waitFor(() => locationField(findPanel() || panel), "Go to Folder location field unavailable");
    const location = kind === "save" ? parentPath : path;
    field.value = location;
    if (field.value() !== location) throw new Error("Go to Folder did not retain the complete path");
    events.keyCode(36);
    log("Go to Folder submitted");
    // The location field belongs to the nested Go to Folder sheet. Poll its
    // existence directly so scrolling the directory contents cannot stall AX
    // traversal of the whole file panel during navigation.
    waitFor(() => !field.exists(), "Go to Folder did not finish navigation");
    log("Go to Folder sheet closed");
    if (kind === "save") {
      // Limit traversal to native panel groups. NSSavePanel's filename is the
      // enabled text field whose AX identifier or label names the save name.
      const current = waitFor(findPanel, "NSSavePanel unavailable after directory navigation");
      const candidates = nativeContainers(current)
        .flatMap((node) => controls(node, "textFields", "AXTextField"))
        .filter((field) => safely(() => field.enabled(), false));
      const named = candidates.filter((candidate) => {
        const identifier = safely(() => candidate.attributes.byName("AXIdentifier").value(), "");
        const description = safely(() => candidate.description(), "");
        return /save|name/i.test(identifier) || /save as|name/i.test(description);
      });
      const populated = candidates.filter((candidate) => safely(() => !!candidate.value(), false));
      const target = named.length ? named : populated;
      if (target.length !== 1) throw new Error("NSSavePanel filename field is not unique");
      const name = target[0];
      name.value = filename;
      if (name.value() !== filename) throw new Error("NSSavePanel did not retain filename");
    }
    const open = waitFor(() => {
      const current = findPanel();
      if (!current) return null;
      const choices = buttons(current, cancelAfterPath ? ["Cancel"] : actionNames, true);
      return choices.length === 1 ? choices[0] : null;
    }, "Native chooser action button unavailable");
    open.click();
  }
  waitFor(() => !findPanel(), "Folder chooser did not close");
} catch (error) {
  log("AX state " + JSON.stringify(nativeContainers(findPanel() || panel).slice(0, 24).map(describePanel)));
  throw error;
}
log("chooser action submitted");
JSON.stringify({ transport: "macOS Accessibility and OS keyboard", pid: owners[0], application });
