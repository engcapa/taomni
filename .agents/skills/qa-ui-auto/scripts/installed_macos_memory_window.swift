import CoreGraphics
import Foundation

// The WindowServer list can establish visibility without requesting the app's accessibility tree.
guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]) else { exit(2) }
let deadline = Date().addingTimeInterval(45)
while Date() < deadline {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    for window in windows {
        guard window[kCGWindowOwnerPID as String] as? Int == pid,
              window[kCGWindowLayer as String] as? Int == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? Double, width >= 300,
              let height = bounds["Height"] as? Double, height >= 200 else { continue }
        let result: [String: Any] = ["ownerPid": pid, "width": width, "height": height]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
        exit(0)
    }
    Thread.sleep(forTimeInterval: 0.1)
}
exit(1)
