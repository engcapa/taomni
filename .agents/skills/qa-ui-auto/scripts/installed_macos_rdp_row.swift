import AppKit
import ApplicationServices
import ImageIO
import Vision

// WKWebView can omit the contents of a listbox option from its accessibility
// tree. Locate the real label in an owned window capture before sending input.
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
    let column = CGRect(x: 40 * pixelScale, y: 0, width: 145 * pixelScale, height: CGFloat(image.height)).integral
    guard let cropped = image.cropping(to: column) else { throw CheckFailure("The Local servers label column is missing") }
    let labels = try recognizedLabels(cropped)
    let rdp = labels.filter { $0.0 == "RDP" }
    guard rdp.count == 1,
          let row = rdp.first?.1,
          labels.contains(where: { $0.0.caseInsensitiveCompare("Local servers") == .orderedSame && $0.1.midY > row.midY })
    else { return nil }
    let point = CGPoint(x: bounds.minX + (column.minX + row.midX * column.width) / pixelScale,
                        y: bounds.minY + (1 - row.midY) * bounds.height)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else { throw CheckFailure("The captured Local servers window lost input ownership") }
    down.setIntegerValueField(.mouseEventClickState, value: 1)
    up.setIntegerValueField(.mouseEventClickState, value: 1)
    down.postToPid(pid)
    up.postToPid(pid)
    return point
}

private func recognizedLabels(_ image: CGImage) throws -> [(String, CGRect)] {
    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .accurate
    text.recognitionLanguages = ["en-US"]
    text.usesLanguageCorrection = false
    text.minimumTextHeight = 0.005
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([text])
    return (text.results ?? []).compactMap { line in
        guard let match = line.topCandidates(1).first else { return nil }
        return (match.string.trimmingCharacters(in: .whitespacesAndNewlines), line.boundingBox)
    }
}
