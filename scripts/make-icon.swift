// Renders the app icon (gradient squircle + SF Symbol) into an .iconset folder.
import AppKit

let out = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let size = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = size * 0.09
    let rect = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
    let path = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.225, yRadius: rect.width * 0.225)
    NSGradient(colors: [NSColor(red: 0.36, green: 0.30, blue: 0.95, alpha: 1), NSColor(red: 0.10, green: 0.55, blue: 0.98, alpha: 1)])!
        .draw(in: path, angle: -60)
    let config = NSImage.SymbolConfiguration(pointSize: size * 0.42, weight: .semibold)
        .applying(.init(paletteColors: [.white]))
    if let symbol = NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: nil)?
        .withSymbolConfiguration(config) {
        let s = symbol.size
        symbol.draw(in: NSRect(x: (size - s.width) / 2, y: (size - s.height) / 2, width: s.width, height: s.height))
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    try! render(base).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base).png"))
    try! render(base * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base)@2x.png"))
}
