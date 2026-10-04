// Independent host-side flip oracle for macOS RDP input checks.
// An AppKit process keeps Python's GUI consent dialogs out of the target.
import AppKit
import Darwin
import Foundation

func argument(_ name: String, default fallback: String? = nil) -> String {
    if let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count {
        return CommandLine.arguments[index + 1]
    }
    if let fallback { return fallback }
    fatalError("Missing \(name)")
}

let stateURL = URL(fileURLWithPath: argument("--state"))
let geometry = argument("--geometry", default: "480x320+40+80")
let fields = geometry.split(separator: "+")
let size = fields.first?.split(separator: "x") ?? []
guard fields.count == 3, size.count == 2,
      let width = Double(size[0]), let height = Double(size[1]),
      let x = Double(fields[1]), let y = Double(fields[2]), width > 0, height > 0 else {
    fatalError("Expected positive WxH+X+Y geometry")
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
guard let screen = NSScreen.main else { fatalError("No Aqua display") }
let scale = screen.backingScaleFactor
let rectangle = NSRect(x: screen.frame.minX + x / scale,
                       y: screen.frame.maxY - (y + height) / scale,
                       width: width / scale, height: height / scale)
final class TargetWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
let window = TargetWindow(contentRect: rectangle, styleMask: [.borderless], backing: .buffered, defer: false)
window.title = "taomni-rdp-target"
window.level = .floating
window.isReleasedWhenClosed = false

final class FlipView: NSView {
    var flips = 0
    var samples: [[String: Any]] = []
    var lastEvent: Int64?
    var ready = false
    let pattern = CommandLine.arguments.contains("--pattern")
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func writeState() {
        guard let window, let screen = window.screen else { fatalError("Target has no screen") }
        let factor = screen.backingScaleFactor
        let state: [String: Any] = [
            "mode": "flip", "pid": Int(getpid()), "geometry": geometry, "flips": flips,
            "color": flips.isMultiple(of: 2) ? "#000000" : "#ffffff", "frames": 0,
            "last_event_unix_ms": lastEvent.map { $0 as Any } ?? NSNull(), "ready": ready,
            "process_activity": "default", "flip_samples": samples, "target_backend": "AppKit",
            "window": ["x": (window.frame.minX - screen.frame.minX) * factor,
                       "y": (screen.frame.maxY - window.frame.maxY) * factor,
                       "width": window.frame.width * factor, "height": window.frame.height * factor]
        ]
        do {
            try JSONSerialization.data(withJSONObject: state).write(to: stateURL, options: .atomic)
        } catch {
            fputs("Target state write failed: \(error)\n", stderr)
            exit(1)
        }
    }

    func flip() {
        flips += 1
        lastEvent = Int64(Date().timeIntervalSince1970 * 1000)
        needsDisplay = true
        displayIfNeeded()
        samples.append(["flip": flips, "event_unix_us": lastEvent! * 1000,
                        "draw_submitted_unix_us": Int64(Date().timeIntervalSince1970 * 1_000_000)])
        if samples.count > 128 { samples.removeFirst(samples.count - 128) }
        writeState()
    }

    override func mouseDown(with event: NSEvent) { flip() }
    override func keyDown(with event: NSEvent) { flip() }
    override func draw(_ dirtyRect: NSRect) {
        (flips.isMultiple(of: 2) ? NSColor.black : NSColor.white).setFill()
        NSBezierPath(rect: bounds).fill()
        if pattern {
            NSColor.magenta.setFill()
            NSBezierPath(rect: NSRect(x: 0, y: 0, width: 96 / scale, height: 96 / scale)).fill()
            NSColor.cyan.setFill()
            NSBezierPath(rect: NSRect(x: 96 / scale, y: 0, width: 96 / scale, height: 96 / scale)).fill()
        }
    }
}

let view = FlipView(frame: NSRect(origin: .zero, size: rectangle.size))
window.contentView = view
window.makeKeyAndOrderFront(nil)
window.orderFrontRegardless()
window.makeFirstResponder(view)
app.activate(ignoringOtherApps: true)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
    guard window.isVisible else { fatalError("Target window is not visible") }
    view.ready = true
    view.writeState()
}
let lifetime = Double(argument("--lifetime-sec", default: "900")) ?? 900
DispatchQueue.main.asyncAfter(deadline: .now() + lifetime) { app.terminate(nil) }
app.run()
