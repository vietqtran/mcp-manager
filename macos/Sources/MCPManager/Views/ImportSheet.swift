import SwiftUI

/// Import servers from pasted JSON (any client's format) or from a detected client's config.
struct ImportSheet: View {
    enum Source: Equatable {
        case paste
        case client(ClientInfo)
    }

    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    var source: Source

    @State private var json = ""
    @State private var candidates: [Candidate] = []
    @State private var selected: Set<String> = []
    @State private var replaceInClient = true
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title2.weight(.semibold))
            switch source {
            case .paste:
                Text("Paste an `mcpServers` block from any README or config file (Claude, Cursor, VS Code, Gemini, opencode formats all work).")
                    .foregroundStyle(.secondary)
                TextEditor(text: $json)
                    .font(.system(.callout, design: .monospaced))
                    .frame(minHeight: 150)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                    .onChange(of: json) { Task { await parse() } }
            case .client(let c):
                Text("Servers found in \(c.configPath). They will run in MCP Manager instead, shared by every client.")
                    .foregroundStyle(.secondary)
            }

            if !candidates.isEmpty {
                List(candidates) { c in
                    HStack {
                        Toggle("", isOn: Binding(
                            get: { selected.contains(c.id) },
                            set: { if $0 { selected.insert(c.id) } else { selected.remove(c.id) } }
                        ))
                        .labelsHidden()
                        .disabled(c.def == nil)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(c.sourceName).fontWeight(.medium)
                                if let d = c.def { Text("→ \(d.id)").font(.caption.monospaced()).foregroundStyle(.secondary) }
                            }
                            if let d = c.def {
                                Text(d.transport == "stdio" ? "\(d.command ?? "") \((d.args ?? []).joined(separator: " "))" : (d.url ?? ""))
                                    .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                                let secrets = (d.env ?? []).filter { $0.secret == true }.count + (d.headers ?? []).filter { $0.secret == true }.count
                                if secrets > 0 { Text("\(secrets) value(s) will be stored as secrets").font(.caption2).foregroundStyle(.orange) }
                            } else if let e = c.error {
                                Text(e).font(.caption).foregroundStyle(.red)
                            }
                        }
                    }
                }
                .frame(minHeight: 160)
            } else if case .client = source {
                Text("No importable servers found.").foregroundStyle(.secondary)
            }

            if case .client(let c) = source, !candidates.isEmpty {
                Toggle("Replace the imported entries in \(c.name) with a single MCP Manager entry (a backup of the file is kept)", isOn: $replaceInClient)
            }
            if let error { InfoBox(text: error, systemImage: "exclamationmark.triangle.fill", tint: .red) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Import \(selected.count) Server\(selected.count == 1 ? "" : "s")") { Task { await importSelected() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(selected.isEmpty || busy)
            }
        }
        .padding(20)
        .frame(width: 640, height: 560)
        .task { if case .client(let c) = source { await loadClient(c) } }
    }

    private var title: String {
        if case .client(let c) = source { return "Import from \(c.name)" }
        return "Import JSON"
    }

    private func parse() async {
        guard !json.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { candidates = []; return }
        struct Body: Encodable { var json: String }
        do {
            let r: CandidatesResponse = try await state.api.post("import/parse", Body(json: json))
            candidates = r.candidates
            selected = Set(r.candidates.filter { $0.def != nil }.map(\.id))
            error = nil
        } catch {
            candidates = []
            self.error = error.localizedDescription
        }
    }

    private func loadClient(_ c: ClientInfo) async {
        do {
            let r: CandidatesResponse = try await state.api.get("clients/\(c.id)/candidates")
            candidates = r.candidates
            selected = Set(r.candidates.filter { $0.def != nil }.map(\.id))
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func importSelected() async {
        busy = true
        defer { busy = false }
        let chosen = candidates.filter { selected.contains($0.id) }
        struct Body: Encodable { var defs: [ServerDef]; var client: String?; var removeFromClient: [String]? }
        var body = Body(defs: chosen.compactMap(\.def))
        if case .client(let c) = source, replaceInClient {
            body.client = c.id
            body.removeFromClient = chosen.map(\.sourceName)
        }
        do {
            let r: ImportResponse = try await state.api.post("import", body)
            for s in r.created { state.replace(s) }
            if !r.errors.isEmpty {
                error = r.errors.map { "\($0.id ?? "?"): \($0.error)" }.joined(separator: "\n")
                return
            }
            state.flash("Imported \(r.created.count) server(s)" + (r.backup.map { " · backup: \(($0 as NSString).lastPathComponent)" } ?? ""))
            await state.refreshClients()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
