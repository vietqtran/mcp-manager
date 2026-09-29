import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var state
    @State private var port = ""
    @State private var entryName = ""
    @State private var hosts: Set<String> = []
    @State private var requireToken = false
    @State private var revealToken = false
    @State private var confirmRotate = false
    @State private var restartNeeded = false
    @State private var busy = false

    var body: some View {
        Form {
            Section("Engine") {
                if let s = state.status, let bundled = Engine.cliPath, s.supervised, s.cliPath != bundled {
                    InfoBox(text: "The background engine runs from another copy of MCP Manager (\(s.cliPath)). Click “Reinstall Service” to use this copy.",
                            systemImage: "exclamationmark.triangle", tint: .orange)
                }
                if let s = state.status {
                    LabeledContent("Status") {
                        HStack {
                            Circle().fill(.green).frame(width: 7, height: 7)
                            Text("Running · v\(s.version) · pid \(String(s.pid)) · up \(Duration.seconds(s.uptimeSec).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated)))")
                        }
                    }
                    LabeledContent("Background service") {
                        Text(state.service?.installed == true ? "Starts at login (launchd)" : "Not installed")
                    }
                    LabeledContent("Data folder") {
                        Button(s.dataDir.replacingOccurrences(of: NSHomeDirectory(), with: "~")) { AppState.reveal(s.dataDir) }
                            .buttonStyle(.link)
                    }
                    LabeledContent("Command-line tool") {
                        HStack {
                            Text(s.shimPath).fontDesign(.monospaced).textSelection(.enabled)
                            CopyButton(text: s.shimPath)
                        }
                    }
                }
                HStack {
                    Button("Restart Engine") { Task { await restartEngine() } }
                    Button("Reinstall Service") {
                        Task {
                            busy = true
                            _ = await state.attempt { try await Engine.installService() }
                            try? await Task.sleep(for: .seconds(1.5))
                            await state.connectEngine()
                            busy = false
                        }
                    }
                    .help("Point the login item at this copy of MCP Manager.app (use after moving or updating the app)")
                    if busy { ProgressView().controlSize(.small) }
                }
            }

            Section {
                TextField("Port", text: $port).frame(width: 200)
                ForEach(state.status?.addresses ?? [], id: \.self) { a in
                    Toggle(isOn: hostBinding(a.address)) {
                        VStack(alignment: .leading) {
                            Text("Listen on \(a.address)")
                            Text(a.tailscale ? "Tailscale (\(a.iface))" : "Network interface \(a.iface)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Toggle("Listen on all interfaces (0.0.0.0)", isOn: hostBinding("0.0.0.0"))
                Toggle("Require the token for local clients too", isOn: $requireToken)
                TextField("Entry name in client configs", text: $entryName).frame(width: 300)
                HStack {
                    Button("Save Network Settings") { Task { await save() } }
                    if restartNeeded {
                        Text("Restart the engine to apply").foregroundStyle(.orange).font(.callout)
                    }
                }
            } header: {
                Text("Network")
            } footer: {
                Text("The engine always listens on 127.0.0.1. Other addresses always require the access token.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Access token") {
                HStack {
                    Text(revealToken ? (state.settings?.token ?? "") : String(repeating: "•", count: 24))
                        .fontDesign(.monospaced).textSelection(.enabled)
                    Spacer()
                    Button(revealToken ? "Hide" : "Reveal") { revealToken.toggle() }
                    CopyButton(text: state.settings?.token ?? "")
                    Button("Rotate…") { confirmRotate = true }
                }
            }

            Section("Runtimes used by servers") {
                ForEach(["node", "npx", "uvx", "docker"], id: \.self) { r in
                    LabeledContent(r) {
                        if let path = state.status?.runtimes[r] ?? nil {
                            Text(path).fontDesign(.monospaced).foregroundStyle(.secondary)
                        } else {
                            Text(hint(r)).foregroundStyle(.orange)
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .task { await state.refreshSettings(); await state.refreshStatus(); load() }
        .confirmationDialog("Rotate the access token?", isPresented: $confirmRotate) {
            Button("Rotate", role: .destructive) {
                Task {
                    let _: SettingsResponse? = await state.attempt { try await state.api.post("settings/rotate-token") }
                    state.api.reloadConfig()
                    await state.refreshSettings()
                    await state.refreshClients()
                    state.flash("Token rotated. Remote clients need the new token.")
                }
            }
        } message: {
            Text("Remote clients using the old token will stop working until updated.")
        }
    }

    private func load() {
        guard let s = state.settings else { return }
        port = String(s.port)
        entryName = s.clientEntryName
        hosts = Set(s.hosts)
        requireToken = s.requireTokenOnLoopback
    }

    private func hostBinding(_ h: String) -> Binding<Bool> {
        Binding(get: { hosts.contains(h) }, set: { if $0 { hosts.insert(h) } else { hosts.remove(h) } })
    }

    private func save() async {
        struct Body: Encodable { var port: Int; var hosts: [String]; var requireTokenOnLoopback: Bool; var clientEntryName: String }
        let body = Body(port: Int(port) ?? 7717, hosts: ["127.0.0.1"] + hosts.filter { $0 != "127.0.0.1" }.sorted(),
                        requireTokenOnLoopback: requireToken, clientEntryName: entryName)
        if let r: SettingsResponse = await state.attempt({ try await state.api.send("PUT", "settings", json: body) }) {
            state.settings = r.settings
            restartNeeded = r.restartRequired ?? false
            state.flash(restartNeeded ? "Saved. Restart the engine to apply." : "Saved")
            await state.refreshClients()
        }
    }

    private func restartEngine() async {
        busy = true
        defer { busy = false }
        if state.status?.supervised == true {
            _ = await state.attempt { try await Engine.restartService() }
        } else {
            state.flash("The engine was started manually — restart it from the terminal.", error: true)
            return
        }
        restartNeeded = false
        try? await Task.sleep(for: .seconds(2))
        await state.connectEngine()
    }

    private func hint(_ r: String) -> String {
        switch r {
        case "uvx": "Not found — brew install uv"
        case "docker": "Not found — install Docker Desktop"
        default: "Not found — brew install node"
        }
    }
}
