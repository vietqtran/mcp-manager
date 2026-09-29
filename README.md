# MCP Manager

A native macOS app for running your MCP servers **once**, managing them from a UI, and sharing them with every AI tool on your Mac — Claude Code, Codex, Cursor, VS Code, Gemini CLI, Claude Desktop — and with remote machines that SSH into it.

**The problem.** Each client keeps its own JSON/TOML file of MCP servers. Changing a token means hunting through `~/.claude.json`, `~/.codex/config.toml`, `.cursor/mcp.json`… and every new session starts its own copy of every server.

**The fix.** MCP Manager runs every server in a single background engine and exposes them through one endpoint. You connect each client **once**, with a single entry. After that you add, remove, or disable servers and individual tools in the app, and every connected client picks up the change straight away via `tools/list_changed`, without anyone editing JSON.

```
Claude Code ─┐                                   ┌─ uvx mcp-atlassian   (Jira, PAT)
Codex ───────┤  http://127.0.0.1:7717/mcp        ├─ npx @playwright/mcp
Cursor ──────┼──────────────► MCP Manager engine ┼─ docker github-mcp-server
VS Code ─────┤   (one process per server,        ├─ https://api.githubcopilot.com/mcp/
remote VM ───┘    shared by all sessions)        └─ npx mcp-remote https://mcp.atlassian.com/v2/mcp (OAuth)
  (ssh … bridge)
```

## Features

- **Catalog of 36 verified presets.** Covers Atlassian (Rovo OAuth, Cloud API token, Jira/Confluence Server & Data Center PAT with read-only mode), GitHub (remote and Docker), GitLab (self-managed), Playwright, Chrome DevTools, Postgres, MySQL, SQLite, Google Sheets & Drive (OAuth or service account), Google Workspace, Slack, Notion, Linear, Sentry, Figma, Context7, Brave Search, Supabase, Kubernetes, Docker, filesystem/git/fetch/memory/time, and more. You fill in a form; the app never asks you to write JSON.
- **Import what you already have.** The app reads MCP servers from Claude Code, Codex, Cursor, VS Code, Gemini CLI, Copilot CLI, Windsurf and opencode configs. You can also paste any `mcpServers` snippet from a README. Import can replace the old entries with the single hub entry, and keeps a backup of the file.
- **One-click client connection.** The app writes the hub entry into each client's config in that client's own format. Codex TOML is edited without losing your comments.
- **Remote machines.**
  - The built-in `bridge` command speaks MCP over SSH's stdin/stdout: `ssh mac ~/.mcp-manager/bin/mcp-manager bridge`. No ports are opened.
  - Alternatively, use an SSH tunnel, or listen on your LAN or Tailscale IP with a bearer token.
- **Per-tool control.** Hide individual tools from every client to save context. You can also run any tool from the UI with JSON arguments to debug it.
- **Runtime supervision.**
  - Live logs per server.
  - Automatic restart with backoff when a server crashes.
  - Secrets are stored separately with mode `0600` and never shown again.
  - The engine starts at login through launchd, so it keeps serving clients even when the app is closed.
- **Endpoints.** `/mcp` exposes every enabled server with tool names prefixed `<id>__tool`. `/mcp/<id>` exposes a single server with its original tool names.

## Requirements

- macOS 14 or later, Apple Silicon or Intel.
- Node.js 20 or later (`brew install node`). It runs the engine and is needed by `npx`-based servers anyway.
- Optional, depending on which presets you use: `uv` (`brew install uv`) for `uvx` servers, and Docker Desktop.
- To build: Swift 5.10 or later. The Xcode Command Line Tools are enough; the full Xcode app is not required.

## Build & run

```bash
npm install
npm run build            # bundles the engine and builds "build/MCP Manager.app"
open "build/MCP Manager.app"
```

To install, drag `build/MCP Manager.app` to `/Applications`. On first launch the app installs the engine as a launchd agent (`io.github.mcp-manager`). If you move the app later, use **Settings → Reinstall Service**.

> Without Xcode, the newest SDKs shipped with the Command Line Tools cannot expand SwiftUI's `@State` macro. `scripts/build-app.sh` automatically falls back to the newest SDK that works, for example `MacOSX26.5.sdk`.

## Connecting clients

In the app, open **Clients** and click **Connect**. The equivalent commands are:

```bash
# Claude Code (user scope)
claude mcp add --scope user --transport http mcpm http://127.0.0.1:7717/mcp

# Codex (~/.codex/config.toml)
[mcp_servers.mcpm]
url = "http://127.0.0.1:7717/mcp"
tool_timeout_sec = 1800
```

For a remote machine or VM that can SSH into the Mac with key-based auth:

```bash
claude mcp add --scope user mcpm -- ssh -T -o BatchMode=yes you@your-mac ~/.mcp-manager/bin/mcp-manager bridge
```

The bridge re-initializes transparently if the engine restarts.

### Claude VM Agent (VS Code)

[Claude VM Agent](https://github.com/vietqtran/claude-cli-wrapper) 0.31.0 or later reads `~/.mcp-manager/config.json` directly:

- Every enabled server appears in the extension's **Skills & MCP** panel, turned on by default.
- All servers reach the VM through **one** reverse SSH tunnel to the hub, with no per-tab `supergateway`.
- There is nothing to connect. The **Clients** page shows the extension as *Automatic*, or *Update needed* if an older version is installed.

## CLI

The app installs a shim at `~/.mcp-manager/bin/mcp-manager`.

```
mcp-manager status                  engine + server status
mcp-manager clients                 detected clients
mcp-manager connect <client>        add the hub entry (claude-code, codex, cursor, vscode, gemini, …)
mcp-manager bridge [--server ID]    stdio ⇄ hub bridge (Claude Desktop, SSH)
mcp-manager service install|uninstall|restart|status
mcp-manager token                   access token for LAN/Tailscale clients
```

## Security model

- The engine binds to `127.0.0.1` by default. Other interfaces are opt-in, and requests from them always require the bearer token.
- Loopback requests without a token must carry a local `Host` header and must not come from a cross-site `Origin`. This blocks DNS-rebinding and drive-by requests from web pages.
- Secret env vars and headers are stored in `~/.mcp-manager/secrets.json` with mode `0600`. The API never returns them.
- Before editing a client config file, the app writes a backup next to it named `*.mcpm-backup-<timestamp>`.

## Files

| Path | Contents |
|---|---|
| `~/.mcp-manager/config.json` | settings and server definitions (no secrets) |
| `~/.mcp-manager/secrets.json` | secret values (0600) |
| `~/.mcp-manager/logs/<id>.log` | per-server logs; `daemon.log` for the engine |
| `~/Library/LaunchAgents/io.github.mcp-manager.plist` | login item |

## Development

```
src/            engine (TypeScript): upstream process manager, MCP gateway, REST API, client adapters, CLI
presets/        catalog.json — add a preset here (see src/presets.ts for the schema)
macos/          SwiftUI app (Swift Package)
scripts/        build-app.sh, icon renderer
test/           unit + end-to-end tests (real engine, real MCP clients)
```

```bash
npm test                       # engine tests
npm run dev:engine             # engine with reload (port 7717)
MCPM_ENGINE_CLI=$PWD/dist/cli.js swift run --package-path macos   # app against a dev engine
```

When adding a preset, cite the source you verified it against in `verifiedSource`. The unit tests render every preset, so run them before submitting.

## Roadmap

- OAuth for remote servers handled natively by the hub, instead of through `mcp-remote`
- Profiles: named subsets of servers per client or project
- Signed and notarized releases, plus a Homebrew cask
- Optional bundled Node runtime

## License

MIT
