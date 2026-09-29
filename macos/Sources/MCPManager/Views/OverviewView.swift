import SwiftUI

struct OverviewView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PageHeader(title: "MCP Manager", subtitle: "Every MCP server runs once on this Mac and is shared by all your AI tools.")

                HStack(spacing: 12) {
                    stat("Servers", "\(state.servers.count)", "server.rack")
                    stat("Running", "\(state.runningCount)", "play.circle", tint: .green)
                    stat("Tools exposed", "\(state.servers.filter { $0.enabled && $0.status == .running }.reduce(0) { $0 + $1.activeToolCount })", "wrench.and.screwdriver")
                    stat("Client sessions", "\(state.status?.sessions.count ?? 0)", "person.2.wave.2")
                }

                if let url = state.status?.aggregateUrl {
                    Card {
                        Label("Hub endpoint", systemImage: "point.3.connected.trianglepath.dotted").font(.headline)
                        Text("Point any MCP client at this single URL. Servers you add or enable here show up in the client automatically — no more editing JSON per tool.")
                            .foregroundStyle(.secondary)
                        CodeBlock(text: url)
                        HStack {
                            Button("Connect Clients…") { state.selection = .clients }.buttonStyle(.borderedProminent)
                            Button("Add Server…") { state.selection = .catalog }
                        }
                    }
                }

                if state.servers.isEmpty {
                    Card {
                        Label("Get started", systemImage: "sparkles").font(.headline)
                        step(1, "Add servers from the Catalog (Jira, Confluence, GitHub, GitLab, Playwright…) or import the ones already in your Claude Code / Codex config.")
                        step(2, "Connect your clients once: Claude Code, Codex, Cursor, VS Code…")
                        step(3, "Using another machine over SSH? See Clients → Remote machines.")
                    }
                }

                let failing = state.servers.filter { $0.status == .error }
                if !failing.isEmpty {
                    Card {
                        Label("Needs attention", systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.red)
                        ForEach(failing) { s in
                            Button {
                                state.selection = .server(s.id)
                            } label: {
                                HStack {
                                    Text(s.name).fontWeight(.medium)
                                    Text(s.error ?? "").foregroundStyle(.secondary).lineLimit(1)
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if let sessions = state.status?.sessions, !sessions.isEmpty {
                    Card {
                        Label("Connected clients", systemImage: "person.2.wave.2").font(.headline)
                        ForEach(sessions, id: \.self) { s in
                            HStack {
                                Circle().fill(s.attached == true ? Color.green : Color.secondary.opacity(0.4)).frame(width: 7, height: 7)
                                Text(s.client ?? "unknown").fontWeight(.medium)
                                Text(s.scope == "*" ? "all servers" : s.scope).foregroundStyle(.secondary)
                                Spacer()
                                Text(Date(timeIntervalSince1970: s.lastSeen / 1000), style: .relative).foregroundStyle(.secondary).font(.caption)
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
        .task { await state.refreshStatus() }
    }

    private func stat(_ title: String, _ value: String, _ icon: String, tint: Color = .accentColor) -> some View {
        Card {
            Image(systemName: icon).foregroundStyle(tint).font(.title3)
            Text(value).font(.system(size: 28, weight: .semibold, design: .rounded)).monospacedDigit()
            Text(title).foregroundStyle(.secondary).font(.callout)
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(n)").font(.callout.bold()).frame(width: 22, height: 22).background(Color.accentColor.opacity(0.15), in: Circle())
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
    }
}
