import AppKit
import Foundation
import Observation

enum SidebarItem: Hashable {
    case overview
    case server(String)
    case catalog
    case clients
    case settings
}

enum EnginePhase: Equatable {
    case connecting
    case installing
    case running
    case failed(String)
}

@MainActor
@Observable
final class AppState {
    let api = APIClient()

    var phase: EnginePhase = .connecting
    var status: EngineStatus?
    var servers: [ServerView] = []
    var presets: [Preset] = []
    var clients: ClientsResponse?
    var settings: AppSettings?
    var service: ServiceStatus?
    var selection: SidebarItem? = .overview
    var banner: Banner?
    /// Bumped whenever a server's catalog changes, so open detail views reload tools.
    var catalogVersion: [String: Int] = [:]

    struct Banner: Equatable {
        var text: String
        var isError: Bool
    }

    private var eventTask: Task<Void, Never>?
    private var didBootstrap = false

    var runningCount: Int { servers.filter { $0.status == .running }.count }

    func bootstrap() async {
        guard !didBootstrap else { return }
        didBootstrap = true
        await connectEngine()
    }

    func connectEngine() async {
        phase = .connecting
        api.reloadConfig()
        if await !api.ping() {
            phase = .installing
            do {
                try await Engine.installService()
            } catch {
                phase = .failed(error.localizedDescription)
                return
            }
            for _ in 0..<40 where await !api.ping() {
                try? await Task.sleep(for: .milliseconds(250))
            }
            api.reloadConfig()
            guard await api.ping() else {
                phase = .failed("The engine did not start. Check ~/.mcp-manager/logs/daemon.log")
                return
            }
        }
        phase = .running
        await reloadAll()
        startEvents()
    }

    func reloadAll() async {
        async let s: Void = refreshServers()
        async let st: Void = refreshStatus()
        async let p: Void = loadPresets()
        async let c: Void = refreshClients()
        async let se: Void = refreshSettings()
        _ = await (s, st, p, c, se)
    }

    func refreshServers() async {
        if let r: ServersResponse = await attempt({ try await self.api.get("servers") }) { servers = r.servers }
    }

    func refreshStatus() async {
        status = try? await api.get("status")
        service = try? await api.get("service")
    }

    func loadPresets() async {
        if let r: PresetsResponse = await attempt({ try await self.api.get("presets") }) { presets = r.presets }
    }

    func refreshClients() async {
        clients = try? await api.get("clients")
    }

    func refreshSettings() async {
        settings = (try? await api.get("settings") as SettingsResponse)?.settings
    }

    private func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    for try await (event, data) in self.api.events("events") {
                        let id = (try? JSONDecoder().decode([String: String].self, from: data))?["id"]
                        switch event {
                        case "catalog":
                            if let id { self.catalogVersion[id, default: 0] += 1 }
                            await self.refreshServers()
                        default:
                            await self.refreshServers()
                        }
                    }
                } catch {}
                if Task.isCancelled { return }
                try? await Task.sleep(for: .seconds(2))
                if await !self.api.ping() { self.phase = .connecting } else if self.phase != .running {
                    self.phase = .running
                    await self.reloadAll()
                }
            }
        }
    }

    // MARK: - Actions

    func server(_ id: String) -> ServerView? { servers.first { $0.id == id } }

    func action(_ id: String, _ verb: String) async {
        if let r: ServerResponse = await attempt({ try await self.api.post("servers/\(id)/\(verb)") }) {
            replace(r.server)
        }
    }

    func setEnabled(_ id: String, _ enabled: Bool) async {
        struct Body: Encodable { var enabled: Bool }
        if let r: ServerResponse = await attempt({ try await self.api.send("PATCH", "servers/\(id)", json: Body(enabled: enabled)) }) {
            replace(r.server)
        }
    }

    func setDisabledTools(_ id: String, _ tools: [String]) async {
        struct Body: Encodable { var disabledTools: [String] }
        if let r: ServerResponse = await attempt({ try await self.api.send("PATCH", "servers/\(id)", json: Body(disabledTools: tools)) }) {
            replace(r.server)
        }
    }

    func delete(_ id: String) async {
        let ok: OKResponse? = await attempt({ try await self.api.send("DELETE", "servers/\(id)") })
        if ok != nil {
            servers.removeAll { $0.id == id }
            if selection == .server(id) { selection = .overview }
            flash("Removed \(id)")
        }
    }

    func replace(_ s: ServerView) {
        if let i = servers.firstIndex(where: { $0.id == s.id }) { servers[i] = s } else { servers.append(s) }
    }

    func created(_ s: ServerView) {
        replace(s)
        selection = .server(s.id)
        flash("Added \(s.name)")
    }

    func flash(_ text: String, error: Bool = false) {
        banner = Banner(text: text, isError: error)
        let current = banner
        Task {
            try? await Task.sleep(for: .seconds(error ? 6 : 3))
            if self.banner == current { self.banner = nil }
        }
    }

    /// Run an API call, surfacing failures as a banner.
    func attempt<T>(_ op: @escaping () async throws -> T) async -> T? {
        do {
            return try await op()
        } catch {
            flash(error.localizedDescription, error: true)
            return nil
        }
    }

    // MARK: - Helpers

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    static func reveal(_ path: String) {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }
}
