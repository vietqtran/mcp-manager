import SwiftUI

struct ServerDetailView: View {
    @Environment(AppState.self) private var state
    var serverId: String

    enum Tab: String, CaseIterable, Identifiable {
        case tools = "Tools", logs = "Logs", config = "Configuration", connect = "Connect"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .tools
    @State private var def: ServerDef?
    @State private var editing = false
    @State private var confirmDelete = false

    private var server: ServerView? { state.server(serverId) }

    var body: some View {
        if let s = server {
            VStack(alignment: .leading, spacing: 0) {
                header(s).padding([.horizontal, .top], 24).padding(.bottom, 12)
                if s.status == .error, let err = s.error {
                    InfoBox(text: err, systemImage: "exclamationmark.octagon.fill", tint: .red)
                        .padding(.horizontal, 24).padding(.bottom, 12)
                }
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: 480)
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
                Divider()
                Group {
                    switch tab {
                    case .tools: ToolsTab(server: s)
                    case .logs: LogsTab(serverId: s.id)
                    case .config: ConfigTab(def: def, onEdit: { editing = true })
                    case .connect: ConnectTab(server: s)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .task(id: s.status) { await loadDef() }
            .sheet(isPresented: $editing) {
                if let def {
                    ServerEditorSheet(existing: def) { updated in
                        state.replace(updated)
                        Task { await loadDef() }
                    }
                }
            }
            .confirmationDialog("Delete \(s.name)?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) { Task { await state.delete(s.id) } }
            } message: {
                Text("The server is stopped and removed from MCP Manager. Its secrets are deleted too.")
            }
        }
    }

    private func header(_ s: ServerView) -> some View {
        HStack(alignment: .center, spacing: 14) {
            ProviderAvatar(name: s.name, size: 44)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(s.name).font(.title2.weight(.semibold))
                    StatusPill(status: s.status)
                }
                HStack(spacing: 6) {
                    Text(s.id).font(.system(.caption, design: .monospaced))
                    Text("·")
                    Text(s.transport == "stdio" ? "Local process" : "Remote HTTP")
                    if let info = s.serverInfo {
                        Text("·")
                        Text("\(info.name) \(info.version ?? "")")
                    }
                    if let pid = s.pid {
                        Text("·")
                        Text("pid \(String(pid))")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("Enabled", isOn: Binding(
                get: { s.enabled },
                set: { v in Task { await state.setEnabled(s.id, v) } }
            ))
            .toggleStyle(.switch)
            .help("Disabled servers are stopped and hidden from every client")
            ControlGroup {
                if s.status == .running || s.status == .starting {
                    Button { Task { await state.action(s.id, "restart") } } label: { Label("Restart", systemImage: "arrow.clockwise") }
                    Button { Task { await state.action(s.id, "stop") } } label: { Label("Stop", systemImage: "stop.fill") }
                } else {
                    Button { Task { await state.action(s.id, "start") } } label: { Label("Start", systemImage: "play.fill") }
                }
            }
            .fixedSize()
            Menu {
                Button("Edit Configuration…") { editing = true }
                Button("Copy Endpoint URL") { AppState.copy(endpoint(s)) }
                Button("Reveal Log File") { AppState.reveal(APIClient.dataDir.appendingPathComponent("logs/\(s.id).log").path) }
                Divider()
                Button("Delete…", role: .destructive) { confirmDelete = true }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }

    private func endpoint(_ s: ServerView) -> String { "http://127.0.0.1:\(state.status?.port ?? 7717)/mcp/\(s.id)" }

    private func loadDef() async {
        if let r: ServerDetailResponse = try? await state.api.get("servers/\(serverId)") { def = r.def }
    }
}

// MARK: - Tools

struct ToolsTab: View {
    @Environment(AppState.self) private var state
    var server: ServerView
    @State private var catalog: CatalogResponse?
    @State private var search = ""
    @State private var running: ToolInfo?

    var body: some View {
        Group {
            if server.status != .running && (catalog?.tools.isEmpty ?? true) {
                ContentUnavailableView(
                    server.status == .starting ? "Starting…" : "Server not running",
                    systemImage: server.status == .starting ? "hourglass" : "power",
                    description: Text(server.status == .starting
                        ? "The first start can take a while if npx/uvx needs to download the package."
                        : "Start the server to see its tools.")
                )
            } else if let catalog {
                let disabled = Set(catalog.disabledTools)
                let tools = catalog.tools.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || ($0.description ?? "").localizedCaseInsensitiveContains(search) }
                VStack(spacing: 0) {
                    HStack {
                        Text("\(catalog.tools.count - disabled.count) of \(catalog.tools.count) tools exposed to clients")
                            .foregroundStyle(.secondary).font(.callout)
                        Spacer()
                        Button("Enable All") { Task { await state.setDisabledTools(server.id, []) ; await load() } }
                            .disabled(disabled.isEmpty)
                        Button("Disable All") { Task { await state.setDisabledTools(server.id, catalog.tools.map(\.name)); await load() } }
                        TextField("Filter", text: $search).textFieldStyle(.roundedBorder).frame(width: 180)
                    }
                    .controlSize(.small)
                    .padding(.horizontal, 24).padding(.vertical, 10)
                    List {
                        ForEach(tools) { tool in
                            ToolRow(tool: tool, enabled: !disabled.contains(tool.name)) { on in
                                var next = disabled
                                if on { next.remove(tool.name) } else { next.insert(tool.name) }
                                Task { await state.setDisabledTools(server.id, Array(next).sorted()); await load() }
                            } onRun: {
                                running = tool
                            }
                        }
                        if !catalog.prompts.isEmpty {
                            Section("Prompts") {
                                ForEach(catalog.prompts) { p in
                                    VStack(alignment: .leading) {
                                        Text(p.name).font(.system(.body, design: .monospaced))
                                        if let d = p.description { Text(d).font(.caption).foregroundStyle(.secondary) }
                                    }
                                }
                            }
                        }
                        let res = catalog.resources.count + catalog.resourceTemplates.count
                        if res > 0 {
                            Section("Resources") { Text("\(res) resources / templates").foregroundStyle(.secondary) }
                        }
                    }
                    .listStyle(.inset)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: "\(server.status.rawValue)-\(state.catalogVersion[server.id] ?? 0)") { await load() }
        .sheet(item: $running) { tool in ToolRunnerSheet(serverId: server.id, tool: tool) }
    }

    private func load() async {
        catalog = try? await state.api.get("servers/\(server.id)/catalog")
    }
}

struct ToolRow: View {
    var tool: ToolInfo
    var enabled: Bool
    var onToggle: (Bool) -> Void
    var onRun: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Toggle("", isOn: Binding(get: { enabled }, set: onToggle))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
            VStack(alignment: .leading, spacing: 3) {
                Text(tool.name).font(.system(.body, design: .monospaced).weight(.medium))
                    .foregroundStyle(enabled ? .primary : .secondary)
                if let d = tool.description, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            Button("Try…", action: onRun).controlSize(.small)
        }
        .padding(.vertical, 3)
    }
}

struct ToolRunnerSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    var serverId: String
    var tool: ToolInfo
    @State private var argsText = ""
    @State private var result: String?
    @State private var isError = false
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(tool.name).font(.title2.weight(.semibold)).fontDesign(.monospaced)
            if let d = tool.description { Text(d).foregroundStyle(.secondary).lineLimit(6) }
            Text("Arguments (JSON)").font(.headline)
            TextEditor(text: $argsText)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 140)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            if let result {
                Text(isError ? "Error" : "Result").font(.headline).foregroundStyle(isError ? .red : .primary)
                ScrollView {
                    Text(result).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 120, maxHeight: 260)
                .padding(8)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Run") { Task { await run() } }.keyboardShortcut(.defaultAction).disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 640)
        .onAppear { argsText = skeleton() }
    }

    private func skeleton() -> String {
        guard let props = tool.inputSchema?["properties"]?.objectValue else { return "{}" }
        var obj: [String: JSONValue] = [:]
        for (k, v) in props {
            switch v["type"]?.stringValue {
            case "number", "integer": obj[k] = .number(0)
            case "boolean": obj[k] = .bool(false)
            case "array": obj[k] = .array([])
            case "object": obj[k] = .object([:])
            default: obj[k] = .string("")
            }
        }
        return JSONValue.object(obj).pretty
    }

    private func run() async {
        busy = true
        defer { busy = false }
        guard let data = argsText.data(using: .utf8), let args = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            result = "Arguments are not valid JSON"
            isError = true
            return
        }
        struct Body: Encodable { var tool: String; var arguments: JSONValue }
        do {
            let r: JSONValue = try await state.api.post("servers/\(serverId)/call", Body(tool: tool.name, arguments: args))
            isError = r["isError"]?.boolValue ?? false
            let texts = r["content"]?.arrayValue?.compactMap { $0["text"]?.stringValue } ?? []
            result = texts.isEmpty ? r.pretty : texts.joined(separator: "\n\n")
        } catch {
            isError = true
            result = error.localizedDescription
        }
    }
}

// MARK: - Logs

struct LogsTab: View {
    @Environment(AppState.self) private var state
    var serverId: String
    @State private var lines: [LogLine] = []
    @State private var follow = true

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Toggle("Follow", isOn: $follow).toggleStyle(.checkbox)
                Spacer()
                Button("Clear View") { lines = [] }
                Button("Copy All") { AppState.copy(lines.map(format).joined(separator: "\n")) }
                Button("Reveal Log File") { AppState.reveal(APIClient.dataDir.appendingPathComponent("logs/\(serverId).log").path) }
            }
            .controlSize(.small)
            .padding(.horizontal, 24).padding(.vertical, 8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                            Text(format(line))
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(line.stream == "system" ? Color.accentColor : .primary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(i)
                        }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 8)
                }
                .background(Color(nsColor: .textBackgroundColor).opacity(0.5))
                .onChange(of: lines.count) {
                    if follow, !lines.isEmpty { proxy.scrollTo(lines.count - 1, anchor: .bottom) }
                }
            }
        }
        .task { await stream() }
    }

    private func format(_ l: LogLine) -> String {
        let d = Date(timeIntervalSince1970: l.ts / 1000)
        return "\(d.formatted(date: .omitted, time: .standard))  \(l.text)"
    }

    private func stream() async {
        if let r: LogsResponse = try? await state.api.get("servers/\(serverId)/logs") { lines = r.logs }
        do {
            for try await (_, data) in state.api.events("servers/\(serverId)/logs/stream") {
                if let line = try? JSONDecoder().decode(LogLine.self, from: data) {
                    lines.append(line)
                    if lines.count > 2000 { lines.removeFirst(lines.count - 2000) }
                }
            }
        } catch {}
    }
}

// MARK: - Config

struct ConfigTab: View {
    var def: ServerDef?
    var onEdit: () -> Void

    var body: some View {
        ScrollView {
            if let def {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Spacer()
                        Button("Edit…", action: onEdit).buttonStyle(.borderedProminent)
                    }
                    Form {
                        if def.transport == "stdio" {
                            LabeledContent("Command") { Text(def.command ?? "").fontDesign(.monospaced).textSelection(.enabled) }
                            LabeledContent("Arguments") {
                                Text((def.args ?? []).map(shellQuote).joined(separator: " ")).fontDesign(.monospaced).textSelection(.enabled)
                            }
                            if let cwd = def.cwd { LabeledContent("Working directory") { Text(cwd).fontDesign(.monospaced) } }
                            kvSection("Environment", def.env ?? [])
                        } else {
                            LabeledContent("URL") { Text(def.url ?? "").fontDesign(.monospaced).textSelection(.enabled) }
                            kvSection("Headers", def.headers ?? [])
                        }
                        if let fixed = def.fixedArgs, !fixed.isEmpty { kvSection("Fixed tool arguments", fixed) }
                        if let p = def.presetId { LabeledContent("Created from preset") { Text(p) } }
                    }
                    .formStyle(.grouped)
                }
                .padding(24)
            }
        }
    }

    @ViewBuilder private func kvSection(_ title: String, _ list: [KV]) -> some View {
        Section(title) {
            if list.isEmpty { Text("None").foregroundStyle(.secondary) }
            ForEach(list, id: \.key) { kv in
                LabeledContent {
                    if kv.secret == true {
                        Label(kv.hasValue == true ? "stored secret" : "empty", systemImage: "lock.fill").foregroundStyle(.secondary)
                    } else {
                        Text(kv.value ?? "").fontDesign(.monospaced).textSelection(.enabled)
                    }
                } label: {
                    Text(kv.key).fontDesign(.monospaced)
                }
            }
        }
    }
}

func shellQuote(_ s: String) -> String {
    s.range(of: #"[^A-Za-z0-9_@%+=:,./-]"#, options: .regularExpression) == nil ? s : "'\(s.replacingOccurrences(of: "'", with: "'\\''"))'"
}

// MARK: - Connect (per server)

struct ConnectTab: View {
    @Environment(AppState.self) private var state
    var server: ServerView

    var body: some View {
        let port = state.status?.port ?? 7717
        let url = "http://127.0.0.1:\(port)/mcp/\(server.id)"
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                InfoBox(text: "Usually you don't need this: connecting a client to the hub (Clients page) already exposes this server as \(server.id)__<tool>. Use the dedicated endpoint below when a tool should only see this one server.")
                Text("Endpoint").font(.headline)
                CodeBlock(text: url)
                Text("Claude Code").font(.headline)
                CodeBlock(text: "claude mcp add --scope user --transport http \(server.id) \(url)")
                Text("Codex (~/.codex/config.toml)").font(.headline)
                CodeBlock(text: "[mcp_servers.\(server.id)]\nurl = \"\(url)\"")
                if let s = state.status {
                    Text("From another machine over SSH (stdio bridge)").font(.headline)
                    CodeBlock(text: "ssh -T -o BatchMode=yes \(s.user)@\(s.addresses.first(where: \.tailscale)?.address ?? s.hostname) \(s.shimPath) bridge --server \(server.id)")
                }
            }
            .padding(24)
        }
    }
}
