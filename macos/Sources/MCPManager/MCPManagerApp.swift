import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Closing the window keeps the app in the menu bar; the engine keeps running either way.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct MCPManagerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var state = AppState()

    var body: some Scene {
        Window("MCP Manager", id: "main") {
            RootView()
                .environment(state)
                .frame(minWidth: 900, minHeight: 600)
                .task { await state.bootstrap() }
        }
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Add Server…") { state.selection = .catalog }
                    .keyboardShortcut("n")
            }
        }

        MenuBarExtra {
            MenuBarContent().environment(state)
        } label: {
            Image(systemName: state.phase == .running ? "point.3.connected.trianglepath.dotted" : "exclamationmark.triangle")
        }
        .menuBarExtraStyle(.menu)
    }
}

struct MenuBarContent: View {
    @Environment(AppState.self) private var state
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(state.phase == .running ? "Engine running · \(state.runningCount)/\(state.servers.count) servers" : "Engine not running")
        Divider()
        ForEach(state.servers) { s in
            Menu {
                if s.status == .running {
                    Button("Restart") { Task { await state.action(s.id, "restart") } }
                    Button("Stop") { Task { await state.action(s.id, "stop") } }
                } else {
                    Button("Start") { Task { await state.action(s.id, "start") } }
                }
                Divider()
                Button("Show Details") { show(.server(s.id)) }
            } label: {
                Text("\(symbol(s)) \(s.name)  (\(s.activeToolCount) tools)")
            }
        }
        if !state.servers.isEmpty { Divider() }
        Button("Open MCP Manager") { show(state.selection ?? .overview) }
            .keyboardShortcut("o")
        Button("Add Server…") { show(.catalog) }
        if let url = state.status?.aggregateUrl {
            Button("Copy Hub URL") { AppState.copy(url) }
        }
        Divider()
        Button("Quit MCP Manager") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private func symbol(_ s: ServerView) -> String {
        guard s.enabled else { return "○" }
        switch s.status {
        case .running: return "🟢"
        case .starting: return "🟡"
        case .error: return "🔴"
        case .stopped: return "⚪️"
        }
    }

    private func show(_ item: SidebarItem) {
        state.selection = item
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}
