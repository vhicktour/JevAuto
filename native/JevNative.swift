import AppKit
import ApplicationServices
import Foundation

struct RectJSON: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
struct DisplayJSON: Codable {
  let id: UInt32; let name: String; let frame: RectJSON; let visibleFrame: RectJSON
  let scale: Double; let notch: RectJSON?
}
struct FrontmostJSON: Codable { let bundleId: String?; let pid: Int32; let name: String? }
struct MouseJSON: Codable { let pressedButtons: Int; let modifierFlags: UInt }
struct FocusJSON: Codable {
  let ok: Bool; let error: String?; let role: String?; let subrole: String?
  let frame: RectJSON?; let windowFrame: RectJSON?; let webArea: Bool; let secure: Bool
}

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

func axString(_ e: AXUIElement, _ attribute: String) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success else { return nil }
  return value as? String
}

func axElement(_ e: AXUIElement, _ attribute: String) -> AXUIElement? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success, let v = value,
        CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}

// AX positions are already top-left global points, the same space as Cua's element frames.
func axFrame(_ e: AXUIElement) -> RectJSON? {
  var p: CFTypeRef?, s: CFTypeRef?
  guard AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &p) == .success,
        AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &s) == .success else { return nil }
  var point = CGPoint.zero, size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
  return RectJSON(x: Double(point.x), y: Double(point.y), width: Double(size.width), height: Double(size.height))
}

/// The element that keystrokes for `pid` would reach: its role, where it is, and whether it is a password field.
func focus(_ pid: pid_t) -> FocusJSON {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 1.0)
  guard let element = axElement(app, kAXFocusedUIElementAttribute) else {
    return FocusJSON(ok: false, error: "no focused element", role: nil, subrole: nil, frame: nil, windowFrame: nil, webArea: false, secure: false)
  }
  let role = axString(element, kAXRoleAttribute)
  let subrole = axString(element, kAXSubroleAttribute)
  var webArea = false
  var node: AXUIElement? = element
  for _ in 0..<40 {
    guard let n = node else { break }
    if axString(n, kAXRoleAttribute) == "AXWebArea" { webArea = true; break }
    node = axElement(n, kAXParentAttribute)
  }
  let window = axElement(element, kAXWindowAttribute)
  return FocusJSON(ok: true, error: nil, role: role, subrole: subrole, frame: axFrame(element),
                   windowFrame: window.flatMap(axFrame), webArea: webArea,
                   secure: subrole == "AXSecureTextField" || role == "AXSecureTextField")
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
case "ax-focus":
  guard CommandLine.arguments.count > 2, let pid = pid_t(CommandLine.arguments[2]) else {
    FileHandle.standardError.write(Data("usage: JevNative ax-focus <pid>\n".utf8)); exit(64)
  }
  emit(focus(pid))
default:
  FileHandle.standardError.write(Data("usage: JevNative displays|frontmost|mouse|ax-focus <pid>\n".utf8))
  exit(64)
}
