import AppKit

guard CommandLine.arguments.count == 4,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let x = Double(CommandLine.arguments[2]),
      let y = Double(CommandLine.arguments[3]),
      let screen = NSScreen.screens.first else {
    fatalError("The image fixture needs a PNG, coordinates and an Aqua display")
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let margin: CGFloat = 24
let bounds = screen.visibleFrame
let width = image.size.width + 2 * margin
let height = image.size.height + 2 * margin
let frame = NSRect(
    x: max(bounds.minX, min(bounds.minX + CGFloat(x), bounds.maxX - width)),
    y: max(bounds.minY, min(bounds.maxY - CGFloat(y) - height, bounds.maxY - height)),
    width: width,
    height: height
)
let panel = NSPanel(
    contentRect: frame,
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
panel.backgroundColor = .white
panel.level = .floating
panel.hidesOnDeactivate = false
let picture = NSImageView(frame: NSRect(
    x: margin, y: margin, width: image.size.width, height: image.size.height
))
picture.image = image
picture.imageScaling = .scaleNone
panel.contentView?.addSubview(picture)
panel.orderFrontRegardless()

DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
    guard panel.isVisible else { fatalError("The image fixture panel is hidden") }
    let actual = panel.frame
    let ready = "WINDOW-READY \(Int(actual.minX)) \(Int(screen.frame.maxY - actual.maxY)) \(Int(actual.width)) \(Int(actual.height))\n"
    FileHandle.standardOutput.write(Data(ready.utf8))
}
app.run()
