import AppKit
import CoreGraphics
import Foundation

// Hosted macOS initially exposes a 1024x768 desktop. AppKit constrains a
// window's height to that desktop, preventing the named native viewport cases.
let display = CGMainDisplayID()
let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
let modes = CGDisplayCopyAllDisplayModes(display, options) as? [CGDisplayMode] ?? []
let candidates = modes.filter { $0.width >= 1600 && $0.height >= 1000 }
  .sorted { $0.width * $0.height < $1.width * $1.height }
guard let mode = candidates.first else {
  fputs("No native desktop mode of at least 1600x1000. Available: \(modes.map { "\($0.width)x\($0.height)" })\n", stderr)
  exit(1)
}
let result = CGDisplaySetDisplayMode(display, mode, nil)
guard result == .success else {
  fputs("CGDisplaySetDisplayMode failed: \(result.rawValue)\n", stderr)
  exit(1)
}
guard let actual = CGDisplayCopyDisplayMode(display), actual.width >= 1600, actual.height >= 1000 else {
  fputs("Desktop did not reach the required native testing size\n", stderr)
  exit(1)
}
let receipt: [String: Any] = ["display": display, "width": actual.width, "height": actual.height,
  "pixelWidth": actual.pixelWidth, "pixelHeight": actual.pixelHeight]
print(String(data: try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]), encoding: .utf8)!)
