import SwiftUI

struct CatalogView: View {
    @Environment(AppState.self) private var state
    @State private var search = ""
    @State private var category = "all"
    @State private var installing: Preset?
    @State private var customOpen = false
    @State private var importOpen = false

    private static let categories: [(String, String)] = [
        ("all", "All"), ("project-management", "Project"), ("docs", "Docs"), ("code", "Code"),
        ("database", "Database"), ("browser", "Browser"), ("productivity", "Productivity"),
        ("devops", "DevOps"), ("design", "Design"), ("search", "Search"), ("utility", "Utility"),
    ]

    private var filtered: [Preset] {
        state.presets.filter { p in
            (category == "all" || p.category == category) &&
                (search.isEmpty || [p.name, p.provider, p.description].contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PageHeader(title: "Add a server", subtitle: "Pick a ready-made preset and fill in a few fields — no JSON needed.") {
                    HStack {
                        Button { importOpen = true } label: { Label("Import JSON…", systemImage: "square.and.arrow.down") }
                        Button { customOpen = true } label: { Label("Custom Server…", systemImage: "hammer") }
                    }
                }
                HStack {
                    Picker("Category", selection: $category) {
                        ForEach(Self.categories, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .frame(width: 220)
                    Spacer()
                    TextField("Search presets", text: $search).textFieldStyle(.roundedBorder).frame(width: 260)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 14)], spacing: 14) {
                    ForEach(filtered) { p in
                        PresetCard(preset: p, missingRuntime: missing(p)) { installing = p }
                    }
                }
            }
            .padding(24)
        }
        .sheet(item: $installing) { p in PresetInstallSheet(preset: p) }
        .sheet(isPresented: $customOpen) { ServerEditorSheet(existing: nil) { state.created($0) } }
        .sheet(isPresented: $importOpen) { ImportSheet(source: .paste) }
    }

    private func missing(_ p: Preset) -> String? {
        guard let runtimes = state.status?.runtimes else { return nil }
        let need: String? = switch p.runtime {
        case "node": "npx"
        case "python": "uvx"
        case "docker": "docker"
        default: nil
        }
        guard let need, (runtimes[need] ?? nil) == nil else { return nil }
        return need
    }
}

struct PresetCard: View {
    var preset: Preset
    var missingRuntime: String?
    var onAdd: () -> Void
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                ProviderAvatar(name: preset.provider)
                VStack(alignment: .leading, spacing: 2) {
                    Text(preset.name).font(.headline).lineLimit(2)
                    Text(preset.provider).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            Text(preset.description).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                .frame(maxWidth: .infinity, minHeight: 50, alignment: .topLeading)
            HStack(spacing: 6) {
                Badge(text: runtimeLabel, color: .accentColor)
                if preset.fields.contains(where: { $0.type == "secret" }) { Badge(text: "token") }
                if preset.notes?.localizedCaseInsensitiveContains("oauth") == true { Badge(text: "OAuth", color: .purple) }
                if let m = missingRuntime { Badge(text: "needs \(m)", color: .orange) }
                Spacer()
                Button("Add", action: onAdd).buttonStyle(.borderedProminent).controlSize(.small)
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(hover ? Color.accentColor.opacity(0.6) : Color.secondary.opacity(0.15)))
        .onHover { hover = $0 }
        .onTapGesture(count: 2, perform: onAdd)
    }

    private var runtimeLabel: String {
        switch preset.runtime {
        case "node": "npx"
        case "python": "uvx"
        case "docker": "Docker"
        default: "Remote"
        }
    }
}

struct PresetInstallSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    var preset: Preset

    @State private var name = ""
    @State private var id = ""
    @State private var text: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                ProviderAvatar(name: preset.provider, size: 40)
                VStack(alignment: .leading) {
                    Text(preset.name).font(.title3.weight(.semibold))
                    Text(preset.description).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                if let url = URL(string: preset.homepage) { Link("Docs", destination: url) }
            }
            .padding(20)
            Divider()
            Form {
                if let notes = preset.notes { InfoBox(text: notes) }
                Section {
                    TextField("Display name", text: $name)
                    TextField("ID", text: $id).fontDesign(.monospaced)
                        .help("Tools are exposed as \(id.isEmpty ? "<id>" : id)__<tool>. Keep it short.")
                }
                if !preset.fields.isEmpty {
                    Section("Configuration") {
                        ForEach(preset.fields) { f in field(f) }
                    }
                }
            }
            .formStyle(.grouped)
            if let error {
                InfoBox(text: error, systemImage: "exclamationmark.triangle.fill", tint: .red).padding(.horizontal, 20)
            }
            HStack {
                Text(commandPreview).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Add Server") { Task { await install() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || !requiredFilled)
            }
            .padding(20)
        }
        .frame(width: 600, height: min(760, CGFloat(300 + preset.fields.count * 62)))
        .onAppear(perform: setup)
    }

    @ViewBuilder private func field(_ f: PresetField) -> some View {
        let label = f.label + (f.required == true ? " *" : "")
        VStack(alignment: .leading, spacing: 3) {
            switch f.type {
            case "boolean":
                Toggle(label, isOn: Binding(get: { flags[f.key] ?? false }, set: { flags[f.key] = $0 }))
            case "select":
                Picker(label, selection: Binding(get: { text[f.key] ?? "" }, set: { text[f.key] = $0 })) {
                    ForEach(f.options ?? [], id: \.self) { Text($0).tag($0) }
                }
            case "secret":
                SecureField(label, text: binding(f.key), prompt: Text(f.placeholder ?? ""))
            case "path":
                LabeledContent(label) { PathField(placeholder: f.placeholder ?? "", text: binding(f.key)) }
            default:
                TextField(label, text: binding(f.key), prompt: Text(f.placeholder ?? ""))
            }
            if let help = f.help {
                Text(.init(linkified(help))).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { text[key] ?? "" }, set: { text[key] = $0 })
    }

    private var requiredFilled: Bool {
        preset.fields.allSatisfy { f in
            f.required != true || f.type == "boolean" || !(text[f.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private var commandPreview: String {
        preset.transport == "http" ? (preset.url ?? "") : "\(preset.command ?? "") \((preset.args ?? []).compactMap(\.stringValue).joined(separator: " "))"
    }

    private func setup() {
        name = preset.name
        let base = preset.id.replacingOccurrences(of: "-remote", with: "").replacingOccurrences(of: "-local", with: "")
        var candidate = base
        var n = 2
        while state.server(candidate) != nil {
            candidate = "\(base)-\(n)"
            n += 1
        }
        id = candidate
        for f in preset.fields {
            switch f.default {
            case .bool(let b): flags[f.key] = b
            case .string(let s): text[f.key] = s
            case .number(let n): text[f.key] = String(Int(n))
            default: if f.type == "boolean" { flags[f.key] = false }
            }
        }
    }

    private func install() async {
        busy = true
        defer { busy = false }
        var values: [String: JSONValue] = [:]
        for f in preset.fields {
            if f.type == "boolean" { values[f.key] = .bool(flags[f.key] ?? false) }
            else if let v = text[f.key], !v.isEmpty { values[f.key] = .string(v) }
        }
        struct Body: Encodable { var id: String; var name: String; var values: [String: JSONValue] }
        do {
            let r: ServerResponse = try await state.api.post("presets/\(preset.id)/install", Body(id: id, name: name, values: values))
            state.created(r.server)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Turn bare URLs in help text into markdown links.
    private func linkified(_ s: String) -> String {
        s.replacingOccurrences(of: #"(https?://[^\s)]+)"#, with: "[$1]($1)", options: .regularExpression)
    }
}
