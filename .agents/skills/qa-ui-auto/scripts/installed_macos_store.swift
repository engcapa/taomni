import AppKit
import ApplicationServices
import Foundation

struct Module: Decodable {
    let id: String
    let name: String
    let removed: Bool
}

struct Request: Decodable {
    let pid: pid_t
    let executable: String
    let phase: String
    let password: String?
    let modules: [Module]?
    let issuer: String?
    let codes: [String]?
    let rdpScreenshot: String?
}

struct Observation: Encodable {
    let ownerPid: pid_t
    let phase: String
    var currentModules: [String]?
    var confirmation: String?
    var permissions: [String: String]?
    var rdpRowClick: [String: Double]?
    var codes: [String]?
    var scannedIssuer: String?
    var endpoint: String?
    var pairingCode: String?
    let transport = "macOS AppKit accessibility"
}

struct CheckFailure: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return nil
    }
    return (value as! AXUIElement)
}

func nodes(_ root: AXUIElement) -> [AXUIElement] {
    var pending = [root]
    var result: [AXUIElement] = []
    while let element = pending.popLast(), result.count < 6000 {
        result.append(element)
        let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        pending.append(contentsOf: children.reversed())
    }
    return result
}

func labels(_ element: AXUIElement) -> [String] {
    var fields = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, "AXPlaceholderValue"]
    if attribute(element, kAXRoleAttribute) as? String == kAXStaticTextRole {
        fields.append(kAXValueAttribute)
    }
    return fields.compactMap {
        (attribute(element, $0) as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

func button(_ elements: [AXUIElement], _ name: String) -> AXUIElement? {
    let candidates = elements.filter {
        attribute($0, kAXRoleAttribute) as? String == kAXButtonRole
            && attribute($0, kAXEnabledAttribute) as? Bool == true
            && labels($0).contains(name)
    }
    return candidates.count == 1 ? candidates.first : nil
}

func press(_ element: AXUIElement) throws {
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard result == .success else {
        throw CheckFailure("AXPress failed with status \(result.rawValue)")
    }
}

func focus(_ element: AXUIElement) throws {
    if attribute(element, kAXFocusedAttribute) as? Bool == true { return }
    let result = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard result == .success else {
        throw CheckFailure("Focusing the accessible text field failed with status \(result.rawValue)")
    }
}

func postKey(pid: pid_t, code: CGKeyCode, flags: CGEventFlags = []) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { throw CheckFailure("Could not create the installed app key event") }
    down.flags = flags
    up.flags = flags
    down.postToPid(pid)
    up.postToPid(pid)
}

func pasteText(_ value: String, into element: AXUIElement, pid: pid_t) throws {
    // The focused WebView field receives an ordinary paste event. The runner
    // uses a synthetic Vault password and clears the pasteboard after entry.
    try focus(element)
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    guard pasteboard.setString(value, forType: .string) else {
        throw CheckFailure("Could not prepare text entry for the installed app")
    }
    try postKey(pid: pid, code: 0, flags: .maskCommand)
    try postKey(pid: pid, code: 9, flags: .maskCommand)
}

func storeAction(
    _ elements: [AXUIElement], module: Module, roster: [Module], action: String
) -> AXUIElement? {
    let names = Set(roster.map(\.name))
    for title in elements where labels(title).contains(module.name) {
        var ancestor = elementAttribute(title, kAXParentAttribute)
        for _ in 0..<8 {
            guard let container = ancestor else { break }
            let children = nodes(container)
            let visibleModules = Set(children.flatMap(labels)).intersection(names)
            guard visibleModules.isSubset(of: [module.name]) else { break }
            if let control = button(children, action) { return control }
            ancestor = elementAttribute(container, kAXParentAttribute)
        }
    }
    return nil
}

func confirmation(_ elements: [AXUIElement], message: String, action: String) -> AXUIElement? {
    for label in elements where labels(label).contains(where: { $0.contains(message) }) {
        var ancestor = elementAttribute(label, kAXParentAttribute)
        for _ in 0..<7 {
            guard let container = ancestor else { break }
            let children = nodes(container)
            if button(children, "Cancel") != nil, let accept = button(children, action) {
                return accept
            }
            ancestor = elementAttribute(container, kAXParentAttribute)
        }
    }
    return nil
}

func observe(_ request: Request) throws -> Observation {
    guard AXIsProcessTrusted() else {
        throw CheckFailure("The GitHub runner cannot use AppKit accessibility")
    }
    let registrationDeadline = ProcessInfo.processInfo.systemUptime + 15
    var application = NSRunningApplication(processIdentifier: request.pid)
    while application?.executableURL == nil,
          ProcessInfo.processInfo.systemUptime < registrationDeadline {
        Thread.sleep(forTimeInterval: 0.1)
        application = NSRunningApplication(processIdentifier: request.pid)
    }
    guard let owned = application,
          owned.executableURL?.resolvingSymlinksInPath().path
            == URL(fileURLWithPath: request.executable).resolvingSymlinksInPath().path
    else { throw CheckFailure("The accessibility target differs from the installed executable") }
    _ = owned.activate(options: [.activateIgnoringOtherApps])
    let app = AXUIElementCreateApplication(request.pid)
    AXUIElementSetMessagingTimeout(app, 3)
    let deadline = ProcessInfo.processInfo.systemUptime + 85
    func wait<T>(_ description: String, _ probe: () throws -> T?) throws -> T {
        while ProcessInfo.processInfo.systemUptime < deadline {
            guard !owned.isTerminated else { throw CheckFailure("App exited while waiting for \(description)") }
            if let result = try probe() { return result }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw CheckFailure("Timed out waiting for \(description)")
    }
    func window() -> AXUIElement? {
        return elementAttribute(app, kAXFocusedWindowAttribute)
            ?? elementAttribute(app, kAXMainWindowAttribute)
    }
    func contents() -> [AXUIElement] { window().map(nodes) ?? [] }
    var result = Observation(ownerPid: request.pid, phase: request.phase)

    func unlockVault() throws {
        guard let password = request.password else { throw CheckFailure("Missing the fixture password") }
        defer { NSPasteboard.general.clearContents() }
        let field = try wait("vault unlock field") {
            contents().first { attribute($0, kAXSubroleAttribute) as? String == "AXSecureTextField" }
        }
        try pasteText(password, into: field, pid: request.pid)
        _ = try wait("Vault Unlock button") { button(contents(), "Unlock") }
        try postKey(pid: request.pid, code: 36)
        _ = try wait("the vault unlock field to close") {
            guard let visibleWindow = window() else { return nil as Bool? }
            let elements = nodes(visibleWindow)
            if elements.contains(where: { labels($0).contains("Incorrect master password.") }) {
                throw CheckFailure("The installed Vault rejected the fixture password")
            }
            return elements
                .contains { attribute($0, kAXSubroleAttribute) as? String == "AXSecureTextField" }
                ? nil : true
        }
    }
    func openSettings(_ query: String) throws {
        // AppKit's Settings shortcut uses Command and the comma key.
        try postKey(pid: request.pid, code: 43, flags: .maskCommand)
        let search = try wait("Settings search field") {
            contents().first {
                attribute($0, kAXRoleAttribute) as? String == kAXTextFieldRole
                    && labels($0).contains { $0.hasPrefix("Search settings") }
            }
        }
        try pasteText(query, into: search, pid: request.pid)
    }
    func openTool(_ name: String) throws {
        func menuItem(_ root: AXUIElement?, role: String, label: String) -> AXUIElement? {
            guard let root = root else { return nil }
            return nodes(root).first { attribute($0, kAXRoleAttribute) as? String == role && labels($0).contains(label) }
        }
        let tools = try wait("Tools menu") {
            menuItem(elementAttribute(app, kAXMenuBarAttribute), role: kAXMenuBarItemRole, label: "Tools")
        }
        try press(tools)
        try press(try wait(name) { menuItem(tools, role: kAXMenuItemRole, label: name) })
    }
    func readHOTP(_ expected: String, stage: String) throws -> String {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        defer { pasteboard.clearContents() }
        // Both the displayed code and its icon have the same accessible name.
        // Either button writes the current code to the native pasteboard.
        let copyName = "Copy code for \(request.issuer ?? "")"
        func copyControl() -> AXUIElement? {
            contents().first {
                attribute($0, kAXRoleAttribute) as? String == kAXButtonRole
                    && attribute($0, kAXEnabledAttribute) as? Bool == true
                    && labels($0).contains(copyName)
            }
        }
        try press(try wait("MFA copy control", copyControl))
        var lastActivation = ProcessInfo.processInfo.systemUptime
        return try wait("expected HOTP on the pasteboard \(stage)") {
            let actual = pasteboard.string(forType: .string)
            if actual == expected { return actual }
            if ProcessInfo.processInfo.systemUptime - lastActivation >= 1, let current = copyControl() {
                // The one-off Next action updates the code asynchronously.
                try press(current)
                lastActivation = ProcessInfo.processInfo.systemUptime
            }
            return nil
        }
    }

    switch request.phase {
    case "mobile-pair":
        try unlockVault()
        try openSettings("mobile")
        try press(try wait("Enable mobile service") { button(contents(), "Enable mobile service") })
        result.endpoint = try wait("loopback Mobile endpoint") {
            contents().flatMap(labels).compactMap { label -> String? in
                guard let range = label.range(of: #"http://127[.]0[.]0[.]1:[0-9]+"#, options: .regularExpression),
                      label.hasPrefix("Running") else { return nil }
                return String(label[range])
            }.first
        }
        try press(try wait("pairing button") { button(contents(), "Generate one-time pairing code") })
        result.pairingCode = try wait("one-time pairing code") {
            contents().flatMap(labels).first { $0.range(of: #"^[0-9a-f]{32}$"#, options: .regularExpression) != nil }
        }
    case "mobile-opt-in":
        let checkbox = try wait("Mobile screen capture checkbox") {
            contents().first {
                attribute($0, kAXRoleAttribute) as? String == kAXCheckBoxRole
                    && labels($0).contains("Allow paired phones and the Feishu adapter to view the current desktop screen")
            }
        }
        guard (attribute(checkbox, kAXValueAttribute) as? NSNumber)?.boolValue == false
        else { throw CheckFailure("Expected Mobile screen capture to start disabled") }
        try press(checkbox)
    case "permissions", "screenshot-permissions":
        defer { NSPasteboard.general.clearContents() }
        try unlockVault()
        try openSettings("screenshot")
        let grantedPrefix = "Screen Recording permission granted; native display capture is available"
        let deniedPrefix = "Screen Recording permission is required before the RDP server can start"
        let summary = try wait("Screenshot Screen Recording status") {
            contents().flatMap(labels).first {
                $0.hasPrefix(grantedPrefix) || $0.hasPrefix(deniedPrefix)
            }
        }
        if request.phase == "screenshot-permissions" {
            result.permissions = ["screenRecording": summary.hasPrefix(grantedPrefix) ? "granted" : "denied",
                                  "screenshotSummary": summary]
            break
        }
        try openTool("Local servers")
        guard let image = request.rdpScreenshot else { throw CheckFailure("Missing the RDP screenshot path") }
        let rdp = try wait("RDP row in the owned Local servers window") {
            try selectRdpRow(pid: request.pid, screenshot: URL(fileURLWithPath: image))
        }
        result.rdpRowClick = ["x": Double(rdp.x), "y": Double(rdp.y)]
        result.permissions = try wait("RDP Screen Recording and Accessibility grants") { () -> [String: String]? in
            let elements = contents()
            let visible = elements.flatMap(labels)
            guard visible.contains("Permission granted"), visible.contains("Keyboard and mouse control enabled"),
                  visible.contains("Refresh displays"), visible.contains("Refresh status")
            else { return nil }
            return ["screenRecording": "granted", "accessibility": "granted", "screenshotSummary": summary]
        }
        guard summary.hasPrefix(grantedPrefix)
        else { throw CheckFailure("Screenshot and RDP disagree about the installed Screen Recording permission") }
    case "mfa-before", "mfa-after":
        let expectedCount = request.phase == "mfa-before" ? 1 : 2
        guard let issuer = request.issuer, let expected = request.codes, expected.count == expectedCount else {
            throw CheckFailure("Missing the MFA fixture or expected HOTP values")
        }
        try unlockVault()
        try openTool("MFA authenticator")
        var codes = [try readHOTP(expected[0], stage: "when opening the account")]
        if expected.count == 2 {
            try press(try wait("advance HOTP") { button(contents(), "Generate the next code for \(issuer)") })
            codes.append(try readHOTP(expected[1], stage: "after advancing the account"))
        }
        result.codes = codes
    case "screen-scan":
        guard request.issuer != nil, let codes = request.codes, codes.count == 1 else {
            throw CheckFailure("Missing the MFA fixture or expected HOTP value")
        }
        try unlockVault()
        try openTool("MFA authenticator")
        try press(try wait("Add MFA account") { button(contents(), "Add MFA account") })
        try press(try wait("Scan screen tab") {
            contents().first {
                let role = attribute($0, kAXRoleAttribute) as? String
                return ["AXRadioButton", "AXTab", "AXButton"].contains(role ?? "") && labels($0).contains("Scan screen")
            }
        })
        // The active tab can share the action's AX label and button role.
        // The actual scan button is in the pane following the screen hint.
        let scanHint = "Show the QR code on screen, then scan."
        try press(try wait("Scan screen button") {
            let elements = contents()
            guard let index = elements.firstIndex(where: { labels($0).contains(where: { $0.hasPrefix(scanHint) }) })
            else { return nil }
            return button(Array(elements.dropFirst(index + 1)), "Scan screen")
        })
        _ = try wait("screen scan to produce the import preview") {
            let elements = contents()
            let visible = elements.flatMap(labels)
            if let failure = visible.first(where: {
                $0 == "No QR code found on screen." || $0.hasPrefix("Taomni needs Screen Recording permission.")
                    || $0.hasPrefix("Screen capture failed:")
            }) { throw CheckFailure(failure) }
            return visible.contains("Review accounts") ? true : nil
        }
        _ = try wait("one duplicate QA Bank account in the preview") {
            let elements = contents()
            let visible = elements.flatMap(labels)
            let importDisabled = elements.contains {
                attribute($0, kAXRoleAttribute) as? String == kAXButtonRole
                    && attribute($0, kAXEnabledAttribute) as? Bool == false
                    && labels($0).contains("Import 0")
            }
            // The external QR uses the same RFC HOTP secret as the migrated account.
            guard visible.contains("1 account(s) found"), visible.contains("Already added"), importDisabled else {
                return nil as Bool?
            }
            let issuerField = elements.contains {
                attribute($0, kAXRoleAttribute) as? String == kAXTextFieldRole
                    && attribute($0, kAXValueAttribute) as? String == "QA Bank"
            }
            let accountRow = elements.contains {
                attribute($0, kAXRoleAttribute) as? String == kAXCheckBoxRole
                    && labels($0).contains { $0 == "QA Bank" || $0.hasPrefix("QA Bank · ") }
            }
            return issuerField || accountRow ? true : nil
        }
        result.scannedIssuer = "QA Bank"
        try postKey(pid: request.pid, code: 53)
        _ = try wait("import preview to close") {
            let elements = contents()
            return button(elements, "Add MFA account") != nil
                && !elements.flatMap(labels).contains("1 account(s) found") ? true : nil
        }
        result.codes = [try readHOTP(codes[0], stage: "after dismissing the scan")]
    case "unlock-store":
        defer { NSPasteboard.general.clearContents() }
        try unlockVault()
        try openSettings("module store")
        _ = try wait("Module Store") {
            contents().first { labels($0).contains("Module Store") }
        }
    case "roster":
        guard let modules = request.modules else { throw CheckFailure("Missing the signed roster") }
        for module in modules {
            let action = module.removed ? "Install" : "Uninstall"
            _ = try wait("\(module.name) \(action) control") {
                storeAction(contents(), module: module, roster: modules, action: action)
            }
        }
        result.currentModules = modules.filter { !$0.removed }.map(\.id)
    case "remove-mail":
        guard let modules = request.modules, let mail = modules.first(where: { $0.id == "taomni-plugin-mail" })
        else { throw CheckFailure("Mail is missing from the signed roster") }
        try press(try wait("Mail Uninstall control") {
            storeAction(contents(), module: mail, roster: modules, action: "Uninstall")
        })
        let message = "Uninstall Mail? Module data will be retained unless you select delete module data."
        try press(try wait("Mail retention confirmation") {
            confirmation(contents(), message: message, action: "Uninstall")
        })
        _ = try wait("Mail Install control after uninstall") {
            storeAction(contents(), module: mail, roster: modules, action: "Install")
        }
        result.confirmation = message
    case "enable-rdp-server":
        guard let modules = request.modules, let rdp = modules.first(where: { $0.id == "taomni-plugin-rdp-server" })
        else { throw CheckFailure("RDP Server is missing from the signed roster") }
        let action = try wait("RDP Server activation control") {
            let elements = contents()
            return storeAction(elements, module: rdp, roster: modules, action: "Disable")
                ?? storeAction(elements, module: rdp, roster: modules, action: "Enable")
        }
        if labels(action).contains("Enable") { try press(action) }
        _ = try wait("enabled RDP Server before checking installed permissions") {
            storeAction(contents(), module: rdp, roster: modules, action: "Disable")
        }
        result.currentModules = [rdp.id]
    case "confirm-close":
        try press(try wait("installed window close button") {
            window().flatMap { elementAttribute($0, kAXCloseButtonAttribute) }
        })
        let message = "There is 1 open tab. Exit Taomni and close it?"
        try press(try wait("installed app exit confirmation") {
            confirmation(contents(), message: message, action: "Exit")
        })
        result.confirmation = message
    default:
        throw CheckFailure("Unknown macOS store observation")
    }
    return result
}

@main
struct InstalledMacOSStore {
    static func main() {
        do {
            let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
            let receipt = try JSONEncoder().encode(observe(request))
            FileHandle.standardOutput.write(receipt)
        } catch {
            let message = (error as? CheckFailure)?.message ?? String(describing: error)
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(EXIT_FAILURE)
        }
    }
}
