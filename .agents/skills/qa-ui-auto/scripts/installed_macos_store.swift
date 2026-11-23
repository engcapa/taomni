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
}

struct Observation: Encodable {
    let ownerPid: pid_t
    let phase: String
    var currentModules: [String]?
    var confirmation: String?
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

func postKey(pid: pid_t, code: CGKeyCode, flags: CGEventFlags = [], text: String? = nil) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { throw CheckFailure("Could not create the installed app key event") }
    down.flags = flags
    up.flags = flags
    if let text {
        Array(text.utf16).withUnsafeBufferPointer { chars in
            down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars.baseAddress)
        }
    }
    down.postToPid(pid)
    up.postToPid(pid)
}

func typeText(_ value: String, into element: AXUIElement, pid: pid_t) throws {
    // WKWebView inputs are controlled by React. Send text through the focused
    // field so the product handles input events and enables its submit button.
    try focus(element)
    for character in value {
        try postKey(pid: pid, code: 0, text: String(character))
    }
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
    func wait<T>(_ description: String, _ probe: () -> T?) throws -> T {
        while ProcessInfo.processInfo.systemUptime < deadline {
            guard !owned.isTerminated else { throw CheckFailure("App exited while waiting for \(description)") }
            if let result = probe() { return result }
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

    switch request.phase {
    case "unlock-store":
        guard let password = request.password else { throw CheckFailure("Missing the fixture password") }
        let field = try wait("vault unlock field") {
            contents().first { attribute($0, kAXSubroleAttribute) as? String == "AXSecureTextField" }
        }
        try typeText(password, into: field, pid: request.pid)
        try press(try wait("Vault Unlock button") { button(contents(), "Unlock") })
        _ = try wait("the vault unlock field to close") {
            guard let visibleWindow = window() else { return nil as Bool? }
            return nodes(visibleWindow)
                .contains { attribute($0, kAXSubroleAttribute) as? String == "AXSecureTextField" }
                ? nil : true
        }
        // AppKit's Settings shortcut uses Command and the comma key.
        try postKey(pid: request.pid, code: 43, flags: .maskCommand)
        let search = try wait("Settings search field") {
            contents().first {
                attribute($0, kAXRoleAttribute) as? String == kAXTextFieldRole
                    && labels($0).contains { $0.hasPrefix("Search settings") }
            }
        }
        try typeText("module store", into: search, pid: request.pid)
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

do {
    let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
    let receipt = try JSONEncoder().encode(observe(request))
    FileHandle.standardOutput.write(receipt)
} catch {
    let message = (error as? CheckFailure)?.message ?? String(describing: error)
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(EXIT_FAILURE)
}
