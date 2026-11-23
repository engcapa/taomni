import AppKit
import ApplicationServices
import ImageIO

// WKWebView omits the server list options on the release runners. Verify the
// stopped-status markers in the owned window before selecting its last row.
func selectRdpRow(pid: pid_t, screenshot: URL) throws -> CGPoint? {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]],
          let window = windows.first(where: {
              ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
                  && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
          }),
          let id = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
          let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
          bounds.width > 300, bounds.height > 450
    else { return nil }

    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-o", "-l", String(id), screenshot.path]
    try capture.run()
    capture.waitUntilExit()
    guard capture.terminationStatus == 0 else { throw CheckFailure("The owned Local servers window capture failed") }

    guard let source = CGImageSourceCreateWithURL(screenshot as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw CheckFailure("The owned Local servers screenshot is unreadable") }
    let pixelScale = CGFloat(image.width) / bounds.width
    let rowCenters = (0..<10).map { 105 + CGFloat($0) * 30 }
    guard rowCenters.allSatisfy({
        isStoppedMarker(in: image, x: 55 * pixelScale, y: $0 * pixelScale)
    }), let rdpRow = rowCenters.last else { return nil }
    // The label column selects the row. Start/stop actions are farther right.
    let point = CGPoint(x: bounds.minX + 78, y: bounds.minY + rdpRow)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else { throw CheckFailure("The captured Local servers window lost input ownership") }
    down.setIntegerValueField(.mouseEventClickState, value: 1)
    up.setIntegerValueField(.mouseEventClickState, value: 1)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return point
}

private func isStoppedMarker(in image: CGImage, x: CGFloat, y: CGFloat) -> Bool {
    let rectangle = CGRect(x: x.rounded(), y: y.rounded(), width: 1, height: 1)
    guard let pixel = image.cropping(to: rectangle),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ), let bytes = context.data?.assumingMemoryBound(to: UInt8.self)
    else { return false }

    context.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1))
    // Both hosted screenshots use the stopped color from ServerRow.tsx.
    return abs(Int(bytes[0]) - 148) <= 12
        && abs(Int(bytes[1]) - 163) <= 12
        && abs(Int(bytes[2]) - 184) <= 12
}
