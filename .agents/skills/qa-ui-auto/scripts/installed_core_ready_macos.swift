import AppKit
import ApplicationServices
import Foundation

func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success else { return nil }
    return value
}

func children(_ node: AXUIElement) -> [AXUIElement] {
    return attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func hasReadyControl(_ window: AXUIElement) -> Bool {
    guard attribute(window, kAXMinimizedAttribute) as? Bool != true else { return false }
    var pending = [(node: window, web: false)]
    var seen = 0
    while let item = pending.popLast(), seen < 2500 {
        seen += 1
        let role = attribute(item.node, kAXRoleAttribute) as? String
        let web = item.web || role == "AXWebArea"
        if web && role == kAXButtonRole && attribute(item.node, kAXEnabledAttribute) as? Bool == true {
            let labels = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute]
            if labels.contains(where: { attribute(item.node, $0) as? String == "Tools" }) {
                return true
            }
        }
        pending.append(contentsOf: children(item.node).reversed().map { (node: $0, web: web) })
    }
    return false
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3, let pid = pid_t(CommandLine.arguments[1]), pid > 0 else {
    fail("Expected the PID and executable path of the installed app")
}
guard AXIsProcessTrusted() else { fail("The hosted runner could not read AppKit accessibility") }
let expected = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().path
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1)
let deadline = ProcessInfo.processInfo.systemUptime + 70
while ProcessInfo.processInfo.systemUptime < deadline {
    if let running = NSRunningApplication(processIdentifier: pid),
       let executable = running.executableURL {
        guard executable.resolvingSymlinksInPath().path == expected else {
            fail("Readiness probe resolved a different installed executable")
        }
        guard !running.isTerminated else { fail("Installed application exited during startup") }
        let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
        if !running.isHidden, windows.contains(where: hasReadyControl) {
            let receipt: [String: Any] = ["ownerPid": pid, "control": "Tools"]
            let data = try JSONSerialization.data(withJSONObject: receipt)
            FileHandle.standardOutput.write(data)
            exit(0)
        }
    }
    Thread.sleep(forTimeInterval: 0.1)
}
fail("Timed out waiting for the installed window's Tools button inside its WebView")
