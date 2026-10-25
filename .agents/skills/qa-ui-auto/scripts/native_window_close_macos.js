// Close only the standard window owned by this invocation's QA executable.
// The native button raises Tauri's normal CloseRequested/confirmation path.
ObjC.import("AppKit");
const application = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("QA_CLOSE_APPLICATION"));
const applications = $.NSWorkspace.sharedWorkspace.runningApplications;
const owners = [];
for (let i = 0; i < applications.count; i++) {
  const candidate = applications.objectAtIndex(i);
  try {
    if (ObjC.unwrap(candidate.executableURL.path) === application) owners.push(Number(candidate.processIdentifier));
  } catch (_) { }
}
if (owners.length !== 1) throw new Error("No unique process for the QA executable: " + JSON.stringify(owners));
const events = Application("System Events");
const process = events.processes.whose({ unixId: owners[0] })[0];
const windows = process.windows().filter((window) => window.subrole() === "AXStandardWindow");
if (windows.length !== 1) throw new Error("No unique standard window owned by the QA executable");
if (windows[0].sheets().length) throw new Error("Handle the QA window's native sheet before closing it");
const buttons = windows[0].buttons().filter((button) => button.subrole() === "AXCloseButton" && button.enabled());
if (buttons.length !== 1) throw new Error("No unique enabled native close button on the QA window");
process.frontmost = true;
buttons[0].click();
JSON.stringify({ transport: "macOS native close button", pid: owners[0], application });
