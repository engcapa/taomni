// Hosted-only automation for the Python fixture's observed macOS network prompt.
// Never approve application, microphone, screen-recording or unknown dialogs.
function fixtureNetworkPrompt(owner, text) {
  return ["UserNotificationCenter", "CoreServicesUIAgent"].includes(owner)
    && /\bPython\b/.test(text) && /find devices/i.test(text)
    && /local networks?/i.test(text);
}

function run() {
  ObjC.import("Foundation");
  if (ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("GITHUB_ACTIONS")) !== "true") {
    throw new Error("Consent automation is restricted to GitHub hosted QA");
  }
  const events = Application("System Events");
  function descendants(element, depth) {
    if (depth > 12) return [];
    let children = [];
    try { children = element.uiElements(); } catch (_) { return []; }
    return children.reduce((all, child) => all.concat([child], descendants(child, depth + 1)), []);
  }
  // Force the accessibility connection before reporting readiness.
  events.processes.name();
  console.log("Python fixture network consent monitor ready");
  function scanOnce() {
    for (const owner of ["UserNotificationCenter", "CoreServicesUIAgent"]) {
      const process = events.processes.byName(owner);
      if (!process.exists()) continue;
      for (const window of process.windows()) {
        const nodes = [window].concat(descendants(window, 0));
        const text = nodes.map(node => {
          let value = "";
          try { value += " " + node.name(); } catch (_) {}
          try { value += " " + node.value(); } catch (_) {}
          return value;
        }).join(" ");
        if (!fixtureNetworkPrompt(owner, text)) continue;
        const buttons = nodes.filter(node => {
          try { return node.role() === "AXButton" && node.name() === "Allow" && node.enabled(); }
          catch (_) { return false; }
        });
        if (buttons.length === 1) {
          buttons[0].click();
          console.log("Accepted Python fixture local-network prompt in " + owner);
        }
      }
    }
  }
  while (true) {
    try {
      scanOnce();
    } catch (error) {
      // Accessibility queries race with the dialog being rebuilt and can throw
      // "Can't get object" (-1728). A monitor that exits aborts the whole
      // shard before its cases run, so a failed scan is skipped, not fatal.
      console.log("consent scan skipped: " + error);
    }
    delay(0.5);
  }
}

if (typeof module !== "undefined") module.exports = { fixtureNetworkPrompt };
