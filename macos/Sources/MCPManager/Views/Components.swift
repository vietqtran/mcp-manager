import AppKit
import SwiftUI

extension ServerStatus {
    var color: Color {
        switch self {
        case .running: .green
        case .starting: .orange
        case .error: .red
        case .stopped: .secondary
        }
    }

    var label: String {
        switch self {
        case .running: "Running"
        case .starting: "Starting"
        case .error: "Error"
        case .stopped: "Stopped"
        }
    }
}

struct StatusDot: View {
    var status: ServerStatus
    var enabled = true

    var body: some View {
        Circle()
            .fill(enabled ? status.color : Color.secondary.opacity(0.4))
            .frame(width: 8, height: 8)
            .overlay {
                if status == .starting {
                    Circle().stroke(status.color.opacity(0.4), lineWidth: 3).scaleEffect(1.6)
                }
            }
    }
}

struct StatusPill: View {
    var status: ServerStatus

    var body: some View {
        HStack(spacing: 5) {
            StatusDot(status: status)
            Text(status.label).font(.caption.weight(.medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(status.color.opacity(0.12), in: Capsule())
    }
}

struct Badge: View {
    var text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// Coloured initial avatar for providers (Atlassian, GitHub, ...).
struct ProviderAvatar: View {
    var name: String
    var size: CGFloat = 36

    private var color: Color {
        let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .indigo, .green, .red, .brown, .cyan, .mint]
        let hash = name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        return palette[hash % palette.count]
    }

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.25)
            .fill(color.gradient)
            .frame(width: size, height: size)
            .overlay {
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.45, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            }
    }
}

/// Monospaced, selectable text with a copy button.
struct CodeBlock: View {
    var text: String
    var copyLabel = "Copy"

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .padding(.trailing, 60)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            CopyButton(text: text, label: copyLabel).padding(6)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
    }
}

struct CopyButton: View {
    var text: String
    var label = "Copy"
    @State private var copied = false

    var body: some View {
        Button {
            AppState.copy(text)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Label(copied ? "Copied" : label, systemImage: copied ? "checkmark" : "doc.on.doc")
        }
        .controlSize(.small)
    }
}

/// Editable list of key/value rows with a per-row "secret" lock.
struct KVRow: Identifiable, Hashable {
    var id = UUID()
    var key = ""
    var value = ""
    var secret = false
    /// Secret already stored in the engine; `value` stays empty until the user types a new one.
    var storedSecret = false

    init(key: String = "", value: String = "", secret: Bool = false, storedSecret: Bool = false) {
        self.key = key
        self.value = value
        self.secret = secret
        self.storedSecret = storedSecret
    }

    init(_ kv: KV) {
        key = kv.key
        secret = kv.secret ?? false
        storedSecret = secret && (kv.hasValue ?? false) && (kv.value ?? "").isEmpty
        value = storedSecret ? "" : (kv.value ?? "")
    }

    /// For the API: an untouched stored secret is sent without a value so the engine keeps it.
    var kv: KV {
        if secret && storedSecret && value.isEmpty { return KV(key: key, value: nil, secret: true, hasValue: true) }
        return KV(key: key, value: value, secret: secret ? true : nil)
    }
}

struct KVEditor: View {
    @Binding var rows: [KVRow]
    var keyPlaceholder = "KEY"
    var valuePlaceholder = "value"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach($rows) { $row in
                HStack(spacing: 6) {
                    TextField(keyPlaceholder, text: $row.key)
                        .font(.system(.body, design: .monospaced))
                        .frame(maxWidth: 220)
                    Group {
                        if row.secret {
                            SecureField(row.storedSecret ? "•••••••• (unchanged)" : valuePlaceholder, text: $row.value)
                        } else {
                            TextField(valuePlaceholder, text: $row.value)
                        }
                    }
                    .font(.system(.body, design: .monospaced))
                    Toggle(isOn: $row.secret) {
                        Image(systemName: row.secret ? "lock.fill" : "lock.open")
                    }
                    .toggleStyle(.button)
                    .help("Store as secret (kept in secrets.json, never shown again)")
                    Button {
                        rows.removeAll { $0.id == row.id }
                    } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                .textFieldStyle(.roundedBorder)
            }
            Button {
                rows.append(KVRow())
            } label: {
                Label("Add", systemImage: "plus")
            }
            .controlSize(.small)
        }
    }
}

struct PathField: View {
    var placeholder: String
    @Binding var text: String

    var body: some View {
        HStack {
            TextField(placeholder, text: $text).textFieldStyle(.roundedBorder)
            Button("Choose…") {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = true
                panel.allowsMultipleSelection = false
                if panel.runModal() == .OK, let url = panel.url { text = url.path }
            }
        }
    }
}

struct PageHeader<Trailing: View>: View {
    var title: String
    var subtitle: String?
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.largeTitle.weight(.semibold))
                if let subtitle { Text(subtitle).foregroundStyle(.secondary) }
            }
            Spacer()
            trailing()
        }
    }
}

extension PageHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10, content: content)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.15)))
    }
}

struct InfoBox: View {
    var text: String
    var systemImage = "info.circle"
    var tint: Color = .blue

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage).foregroundStyle(tint)
            Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}
