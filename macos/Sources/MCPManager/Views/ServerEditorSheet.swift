import SwiftUI

/// Create a custom server or edit any existing one (raw command/args/env or URL/headers).
struct ServerEditorSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    var existing: ServerDef?
    var onSaved: (ServerView) -> Void

    @State private var name = ""
    @State private var id = ""
    @State private var transport = "stdio"
    @State private var command = ""
    @State private var argsText = ""
    @State private var cwd = ""
    @State private var url = ""
    @State private var env: [KVRow] = []
    @State private var headers: [KVRow] = []
    @State private var fixedArgs: [KVRow] = []
    @State private var enabled = true
    @State private var busy = false
    @State private var error: String?

    private var isNew: Bool { existing == nil }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    TextField("Name", text: $name, prompt: Text("Jira (company)"))
                    if isNew {
                        TextField("ID", text: $id, prompt: Text(slug(name)))
                            .help("Used in URLs and as the tool prefix (<id>__tool). Lowercase letters, digits, dashes.")
                    } else {
                        LabeledContent("ID") { Text(existing?.id ?? "").fontDesign(.monospaced) }
                    }
                    Picker("Type", selection: $transport) {
                        Text("Local process (stdio)").tag("stdio")
                        Text("Remote URL (HTTP)").tag("http")
                    }
                    .pickerStyle(.radioGroup)
                    Toggle("Enabled", isOn: $enabled)
                }
                if transport == "stdio" {
                    Section {
                        TextField("Command", text: $command, prompt: Text("npx, uvx, docker, /path/to/binary"))
                            .fontDesign(.monospaced)
                        VStack(alignment: .leading) {
                            Text("Arguments — one per line").font(.callout)
                            TextEditor(text: $argsText)
                                .font(.system(.body, design: .monospaced))
                                .frame(minHeight: 80)
                                .scrollContentBackground(.hidden)
                                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 5))
                        }
                        PathField(placeholder: "Working directory (optional)", text: $cwd)
                    } header: {
                        Text("Process")
                    }
                    Section("Environment variables") {
                        KVEditor(rows: $env, keyPlaceholder: "NAME", valuePlaceholder: "value")
                    }
                } else {
                    Section("Endpoint") {
                        TextField("URL", text: $url, prompt: Text("https://example.com/mcp"))
                            .fontDesign(.monospaced)
                    }
                    Section("HTTP headers") {
                        KVEditor(rows: $headers, keyPlaceholder: "Header", valuePlaceholder: "Bearer …")
                    }
                }
                Section {
                    KVEditor(rows: $fixedArgs, keyPlaceholder: "argument", valuePlaceholder: "value")
                } header: {
                    Text("Fixed tool arguments")
                } footer: {
                    Text("Hidden from AI clients and always sent with this value, e.g. user_google_email.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            if let error {
                InfoBox(text: error, systemImage: "exclamationmark.triangle.fill", tint: .red).padding(.horizontal, 20)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(isNew ? "Add Server" : "Save & Restart") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(20)
        }
        .frame(width: 640, height: 640)
        .onAppear(perform: load)
    }

    private func load() {
        guard let d = existing else { return }
        name = d.name
        transport = d.transport
        command = d.command ?? ""
        argsText = (d.args ?? []).joined(separator: "\n")
        cwd = d.cwd ?? ""
        url = d.url ?? ""
        env = (d.env ?? []).map(KVRow.init)
        headers = (d.headers ?? []).map(KVRow.init)
        fixedArgs = (d.fixedArgs ?? []).map(KVRow.init)
        enabled = d.enabled
    }

    private func save() async {
        busy = true
        defer { busy = false }
        let args = argsText.split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var def = existing ?? ServerDef(id: id.isEmpty ? slug(name) : id, name: name, enabled: enabled, transport: transport)
        def.name = name
        def.enabled = enabled
        def.transport = transport
        def.command = command
        def.args = args
        def.cwd = cwd.isEmpty ? nil : cwd
        def.url = url
        def.env = env.filter { !$0.key.isEmpty }.map(\.kv)
        def.headers = headers.filter { !$0.key.isEmpty }.map(\.kv)
        def.fixedArgs = fixedArgs.filter { !$0.key.isEmpty }.map { KV(key: $0.key, value: $0.value) }
        do {
            let r: ServerResponse = isNew
                ? try await state.api.post("servers", def)
                : try await state.api.send("PUT", "servers/\(def.id)", json: def)
            onSaved(r.server)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

func slug(_ s: String) -> String {
    let lowered = s.lowercased().folding(options: .diacriticInsensitive, locale: .current)
    let dashed = lowered.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
    return String(dashed.trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(32))
}
