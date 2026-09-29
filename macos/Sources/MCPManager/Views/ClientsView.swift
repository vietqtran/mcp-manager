import SwiftUI

struct ClientsView: View {
    @Environment(AppState.self) private var state
    @State private var importing: ClientInfo?
    @State private var snippetFor: ClientInfo?

    private let icons: [String: String] = [
        "claude-code": "terminal", "codex": "chevron.left.forwardslash.chevron.right", "claude-desktop": "bubble.left.and.bubble.right",
        "cursor": "cursorarrow.rays", "vscode": "curlybraces", "gemini": "sparkle", "copilot-cli": "person.crop.circle.badge.checkmark",
        "windsurf": "wind", "opencode": "chevron.left.slash.chevron.right", "claude-vm-agent": "cloud",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader(title: "Clients", subtitle: "Connect each AI tool once. Every server you enable here appears in it automatically.") {
                    Button { Task { await state.refreshClients() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                }

                if let entry = state.clients?.entry {
                    Card {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Hub entry").font(.headline)
                                Text("Written into client configs as \"\(entry.name)\". Tools appear as \(entry.name) → <server>__<tool>.")
                                    .foregroundStyle(.secondary).font(.callout)
                            }
                            Spacer()
                        }
                        CodeBlock(text: entry.url)
                    }
                }

                VStack(spacing: 0) {
                    ForEach(state.clients?.clients ?? []) { c in
                        clientRow(c)
                        Divider()
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.15)))

                RemoteAccessSection()
            }
            .padding(24)
        }
        .task { await state.refreshClients(); await state.refreshStatus() }
        .sheet(item: $importing) { c in ImportSheet(source: .client(c)) }
        .sheet(item: $snippetFor) { c in SnippetSheet(client: c) }
    }

    private func clientRow(_ c: ClientInfo) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icons[c.id] ?? "app")
                .font(.title3)
                .frame(width: 34, height: 34)
                .background(Color.accentColor.opacity(c.detected ? 0.15 : 0.05), in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(c.detected ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(c.name).fontWeight(.medium)
                    if c.auto == true && c.connected { Badge(text: "Automatic", color: .green) }
                    else if c.auto == true && c.detected { Badge(text: "Update needed", color: .orange) }
                    else if c.connected { Badge(text: "Connected", color: .green) }
                    else if c.detected { Badge(text: "Detected") }
                    else { Badge(text: "Not installed", color: .secondary) }
                }
                Button {
                    AppState.reveal(c.configPath)
                } label: {
                    Text(c.configPath.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Reveal in Finder")
                if let note = c.note { Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer()
            if !c.servers.isEmpty {
                Button("Import \(c.servers.count)…") { importing = c }
                    .help("Move \(c.servers.joined(separator: ", ")) into MCP Manager")
            }
            Button(c.auto == true ? "How it works" : "Snippet") { snippetFor = c }
            if c.auto == true {
                EmptyView()
            } else if c.connected {
                Button("Disconnect") { Task { await connect(c, false) } }
            } else {
                Button("Connect") { Task { await connect(c, true) } }.buttonStyle(.borderedProminent)
            }
        }
        .controlSize(.small)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func connect(_ c: ClientInfo, _ on: Bool) async {
        if let r: BackupResponse = await state.attempt({ try await state.api.post("clients/\(c.id)/\(on ? "connect" : "disconnect")") }) {
            state.flash("\(on ? "Connected" : "Disconnected") \(c.name)" + (r.backup != nil ? " · backup saved next to the file" : "") + (on ? " — restart running sessions to pick it up" : ""))
            await state.refreshClients()
        }
    }
}

struct SnippetSheet: View {
    @Environment(\.dismiss) private var dismiss
    var client: ClientInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(client.name) configuration").font(.title3.weight(.semibold))
            if client.auto != true {
                Text("Add this to \(client.configPath) yourself if you prefer not to let MCP Manager edit the file.")
                    .foregroundStyle(.secondary)
            }
            CodeBlock(text: client.snippet)
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 560)
    }
}

/// How to use the hub from other machines: SSH stdio bridge, SSH tunnel, or LAN/Tailscale with a token.
struct RemoteAccessSection: View {
    @Environment(AppState.self) private var state
    @State private var method = 0
    @State private var host = ""

    var body: some View {
        if let s = state.status {
            let hosts = [s.hostname] + s.addresses.map(\.address)
            let target = host.isEmpty ? (s.addresses.first(where: \.tailscale)?.address ?? s.hostname) : host
            let entry = state.clients?.entry.name ?? "mcpm"
            Card {
                Label("Remote machines", systemImage: "network").font(.headline)
                Text("Servers and VMs that SSH into this Mac can use the same MCP servers — nothing needs to be installed on them.")
                    .foregroundStyle(.secondary)
                HStack {
                    Picker("Method", selection: $method) {
                        Text("SSH bridge (recommended)").tag(0)
                        Text("SSH tunnel").tag(1)
                        Text("LAN / Tailscale + token").tag(2)
                    }
                    .pickerStyle(.segmented)
                    Picker("This Mac", selection: $host) {
                        Text("\(target) (auto)").tag("")
                        ForEach(hosts, id: \.self) { Text($0).tag($0) }
                    }
                    .frame(width: 240)
                }
                switch method {
                case 0:
                    Text("The remote client launches the bridge over SSH (key-based login required). No ports are opened.")
                        .font(.callout).foregroundStyle(.secondary)
                    Text("Claude Code on the remote machine").font(.subheadline.weight(.semibold))
                    CodeBlock(text: "claude mcp add --scope user \(entry) -- ssh -T -o BatchMode=yes \(s.user)@\(target) \(s.shimPath) bridge")
                    Text("Any JSON-configured client").font(.subheadline.weight(.semibold))
                    CodeBlock(text: """
                    {
                      "mcpServers": {
                        "\(entry)": {
                          "command": "ssh",
                          "args": ["-T", "-o", "BatchMode=yes", "\(s.user)@\(target)", "\(s.shimPath)", "bridge"]
                        }
                      }
                    }
                    """)
                    Text("Codex").font(.subheadline.weight(.semibold))
                    CodeBlock(text: """
                    [mcp_servers.\(entry)]
                    command = "ssh"
                    args = ["-T", "-o", "BatchMode=yes", "\(s.user)@\(target)", "\(s.shimPath)", "bridge"]
                    """)
                case 1:
                    Text("Forward the hub port, then use the same URL as on this Mac.").font(.callout).foregroundStyle(.secondary)
                    CodeBlock(text: "ssh -N -L \(s.port):127.0.0.1:\(s.port) \(s.user)@\(target)")
                    CodeBlock(text: "claude mcp add --scope user --transport http \(entry) http://127.0.0.1:\(s.port)/mcp")
                default:
                    let listening = s.hosts.contains("0.0.0.0") || s.hosts.contains(target)
                    if !listening {
                        InfoBox(text: "The engine only listens on 127.0.0.1. Enable \(target) under Settings → Network first.", systemImage: "exclamationmark.triangle", tint: .orange)
                    }
                    Text("Requests from other machines must send the access token.").font(.callout).foregroundStyle(.secondary)
                    CodeBlock(text: "claude mcp add --scope user --transport http \(entry) http://\(target):\(s.port)/mcp --header \"Authorization: Bearer \(state.settings?.token ?? "<token>")\"")
                }
            }
        }
    }
}
