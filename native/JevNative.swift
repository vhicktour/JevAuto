import AppKit
import Foundation

struct RectJSON: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct DisplayJSON: Codable {
  let id: UInt32; let name: String; let frame: RectJSON; let visibleFrame: RectJSON
  let scale: Double; let notch: RectJSON?
}
struct FrontmostJSON: Codable { let bundleId: String?; let pid: Int32; let name: String? }
struct MouseJSON: Codable { let pressedButtons: Int; let modifierFlags: UInt }

// Cocoa uses a bottom-left origin on the primary screen; Electron and Cua use top-left points.
func topLeft(_ r: NSRect, primaryHeight: CGFloat) -> RectJSON {
  RectJSON(x: Double(r.origin.x), y: Double(primaryHeight - r.origin.y - r.size.height),
           width: Double(r.size.width), height: Double(r.size.height))
}

func displays() -> [DisplayJSON] {
  guard let primary = NSScreen.screens.first else { return [] }
  let primaryHeight = primary.frame.height
  return NSScreen.screens.map { screen in
    let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
    var notch: RectJSON? = nil
    if screen.safeAreaInsets.top > 0, var left = screen.auxiliaryTopLeftArea, var right = screen.auxiliaryTopRightArea {
      // Accept either global or screen-local areas: local ones fall outside the screen's global frame.
      if !screen.frame.contains(NSPoint(x: left.midX, y: left.midY)) {
        left = left.offsetBy(dx: screen.frame.minX, dy: screen.frame.minY)
        right = right.offsetBy(dx: screen.frame.minX, dy: screen.frame.minY)
      }
      let gap = NSRect(x: left.maxX, y: left.minY, width: right.minX - left.maxX, height: left.height)
      if gap.width > 0 && gap.height > 0 { notch = topLeft(gap, primaryHeight: primaryHeight) }
    }
    return DisplayJSON(id: number?.uint32Value ?? 0, name: screen.localizedName,
                       frame: topLeft(screen.frame, primaryHeight: primaryHeight),
                       visibleFrame: topLeft(screen.visibleFrame, primaryHeight: primaryHeight),
                       scale: Double(screen.backingScaleFactor), notch: notch)
  }
}

func emit<T: Encodable>(_ value: T) {
  let data = try! JSONEncoder().encode(value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

switch CommandLine.arguments.dropFirst().first ?? "" {
case "displays":
  emit(displays())
case "frontmost":
  let app = NSWorkspace.shared.frontmostApplication
  emit(FrontmostJSON(bundleId: app?.bundleIdentifier, pid: app?.processIdentifier ?? -1, name: app?.localizedName))
case "mouse":
  emit(MouseJSON(pressedButtons: NSEvent.pressedMouseButtons, modifierFlags: NSEvent.modifierFlags.rawValue))
default:
  FileHandle.standardError.write(Data("usage: JevNative displays|frontmost|mouse\n".utf8))
  exit(64)
}
