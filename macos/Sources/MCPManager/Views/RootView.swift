import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        @Bindable var state = state
        NavigationSplitView {
            List(selection: $state.selection) {
                Label("Overview", systemImage: "gauge.with.dots.needle.33percent").tag(SidebarItem.overview)

                Section("Servers") {
                    ForEach(state.servers) { s in
                        HStack(spacing: 8) {
                            StatusDot(status: s.status, enabled: s.enabled)
                            Text(s.name).lineLimit(1)
                                .foregroundStyle(s.enabled ? .primary : .secondary)
                            Spacer()
                            if s.status == .running {
                                Text("\(s.activeToolCount)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                        .tag(SidebarItem.server(s.id))
                        .contextMenu { ServerContextMenu(server: s) }
                    }
                    Label("Add Server…", systemImage: "plus.circle").tag(SidebarItem.catalog)
                        .foregroundStyle(Color.accentColor)
                }

                Section("Manage") {
                    Label("Catalog", systemImage: "square.grid.2x2").tag(SidebarItem.catalog)
                    Label("Clients", systemImage: "laptopcomputer.and.arrow.down").tag(SidebarItem.clients)
                    Label("Settings", systemImage: "gearshape").tag(SidebarItem.settings)
                }
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 250)
            .safeAreaInset(edge: .bottom) { EngineFooter().padding(10) }
        } detail: {
            ZStack(alignment: .top) {
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                if let b = state.banner {
                    BannerView(banner: b).padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.spring(duration: 0.3), value: state.banner)
        }
    }

    @ViewBuilder private var detail: some View {
        switch state.phase {
        case .connecting, .installing:
            VStack(spacing: 12) {
                ProgressView()
                Text(state.phase == .installing ? "Installing the background engine…" : "Connecting to the engine…")
                    .foregroundStyle(.secondary)
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("Engine unavailable", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await state.connectEngine() } }.buttonStyle(.borderedProminent)
            }
        case .running:
            switch state.selection ?? .overview {
            case .overview: OverviewView()
            case .server(let id):
                if state.server(id) != nil { ServerDetailView(serverId: id).id(id) } else { OverviewView() }
            case .catalog: CatalogView()
            case .clients: ClientsView()
            case .settings: SettingsView()
            }
        }
    }
}

struct ServerContextMenu: View {
    @Environment(AppState.self) private var state
    var server: ServerView

    var body: some View {
        if server.status == .running {
            Button("Restart") { Task { await state.action(server.id, "restart") } }
            Button("Stop") { Task { await state.action(server.id, "stop") } }
        } else {
            Button("Start") { Task { await state.action(server.id, "start") } }
        }
        Button(server.enabled ? "Disable" : "Enable") { Task { await state.setEnabled(server.id, !server.enabled) } }
        Divider()
        Button("Copy Endpoint URL") {
            AppState.copy("http://127.0.0.1:\(state.status?.port ?? 7717)/mcp/\(server.id)")
        }
    }
}

struct EngineFooter: View {
    @Environment(AppState.self) private var state

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(state.phase == .running ? Color.green : Color.orange).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(state.phase == .running ? "Engine running" : "Engine offline").font(.caption.weight(.medium))
                if let s = state.status {
                    Text("127.0.0.1:\(String(s.port)) · \(s.sessions.count) sessions").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct BannerView: View {
    var banner: AppState.Banner

    var body: some View {
        Label(banner.text, systemImage: banner.isError ? "exclamationmark.octagon.fill" : "checkmark.circle.fill")
            .font(.callout)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .foregroundStyle(banner.isError ? .white : .primary)
            .background(banner.isError ? AnyShapeStyle(Color.red.gradient) : AnyShapeStyle(.regularMaterial), in: Capsule())
            .shadow(radius: 6, y: 2)
            .frame(maxWidth: 600)
    }
}
