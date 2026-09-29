import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { cachedNodePath } from '../env.js';
import { CLI_FILE, HOME } from '../paths.js';
import type { RawServer } from '../importer.js';
import { backupFile, parseJsonc, writeFileAtomic } from '../util.js';

export interface HubEntry {
  name: string;
  url: string;
  token?: string;
}

export interface ClientInfo {
  id: string;
  name: string;
  configPath: string;
  detected: boolean;
  connected: boolean;
  /** Client discovers the hub by itself; there is nothing to connect or disconnect. */
  auto?: boolean;
  servers: string[];
  snippet: string;
  note?: string;
}

interface Adapter {
  id: string;
  name: string;
  file: string;
  /** Directories whose existence means the client is installed. */
  markers: string[];
  note?: string;
  /** For clients that read ~/.mcp-manager themselves: report install/compat state instead of editing files. */
  auto?: () => { detected: boolean; connected: boolean; note: string };
  read(): Record<string, RawServer>;
  connect(e: HubEntry): string | undefined;
  remove(names: string[]): string | undefined;
  snippet(e: HubEntry): string;
}

const auth = (e: HubEntry) => (e.token ? { Authorization: `Bearer ${e.token}` } : undefined);
const exists = (p: string) => fs.existsSync(p);

function readJsonObj(file: string): Record<string, any> {
  if (!exists(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  return text.trim() ? (parseJsonc(text) as Record<string, any>) : {};
}

function writeJsonObj(file: string, obj: Record<string, any>): string | undefined {
  const backup = backupFile(file);
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', exists(file) ? fs.statSync(file).mode & 0o777 : 0o644);
  return backup;
}

/** Adapter for the common "JSON file with a map of servers" layout. */
function jsonAdapter(opts: {
  id: string;
  name: string;
  file: string;
  markers: string[];
  key: string;
  entry: (e: HubEntry) => Record<string, unknown>;
  note?: string;
  extraRead?: (obj: Record<string, any>) => Record<string, RawServer>;
  extraRemove?: (obj: Record<string, any>, names: string[]) => void;
}): Adapter {
  const wrap = (e: HubEntry) => ({ [opts.key]: { [e.name]: opts.entry(e) } });
  return {
    id: opts.id,
    name: opts.name,
    file: opts.file,
    markers: opts.markers,
    note: opts.note,
    read() {
      const obj = readJsonObj(opts.file);
      return { ...(opts.extraRead?.(obj) ?? {}), ...(obj[opts.key] ?? {}) };
    },
    connect(e) {
      const obj = readJsonObj(opts.file);
      obj[opts.key] = { ...(obj[opts.key] ?? {}), [e.name]: opts.entry(e) };
      return writeJsonObj(opts.file, obj);
    },
    remove(names) {
      if (!exists(opts.file)) return undefined;
      const obj = readJsonObj(opts.file);
      for (const n of names) if (obj[opts.key]) delete obj[opts.key][n];
      opts.extraRemove?.(obj, names);
      return writeJsonObj(opts.file, obj);
    },
    snippet: (e) => JSON.stringify(wrap(e), null, 2),
  };
}

// ---- Codex: TOML, edited textually so comments and formatting survive ----

const TABLE_RE = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/;

export function removeTomlServer(text: string, name: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const m = TABLE_RE.exec(line);
    if (m) {
      const table = m[1].replace(/["'\s]/g, '');
      skipping = table === `mcp_servers.${name}` || table.startsWith(`mcp_servers.${name}.`);
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function codexBlock(e: HubEntry): string {
  const lines = [`[mcp_servers.${e.name}]`, `url = ${JSON.stringify(e.url)}`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 1800'];
  if (e.token) lines.push(`http_headers = { "Authorization" = ${JSON.stringify(`Bearer ${e.token}`)} }`);
  return lines.join('\n') + '\n';
}

function codexAdapter(): Adapter {
  const file = path.join(HOME, '.codex', 'config.toml');
  const read = () => (exists(file) ? fs.readFileSync(file, 'utf8') : '');
  const write = (text: string) => {
    const backup = backupFile(file);
    writeFileAtomic(file, text, exists(file) ? fs.statSync(file).mode & 0o777 : 0o600);
    return backup;
  };
  return {
    id: 'codex',
    name: 'Codex CLI',
    file,
    markers: [path.join(HOME, '.codex')],
    read() {
      const text = read();
      if (!text.trim()) return {};
      const parsed = parseToml(text) as { mcp_servers?: Record<string, RawServer> };
      return parsed.mcp_servers ?? {};
    },
    connect(e) {
      const text = removeTomlServer(read(), e.name).trimEnd();
      return write(`${text ? text + '\n\n' : ''}${codexBlock(e)}`);
    },
    remove(names) {
      if (!exists(file)) return undefined;
      return write(names.reduce((t, n) => removeTomlServer(t, n), read()));
    },
    snippet: codexBlock,
  };
}

function bridgeCommand(): { command: string; args: string[] } {
  return { command: cachedNodePath(), args: [CLI_FILE, 'bridge'] };
}

const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support');

/** Claude VM Agent (VS Code extension, claude-cli-wrapper) reads ~/.mcp-manager/config.json from 0.31.0 on. */
const VM_AGENT_MIN = [0, 31, 0];

function claudeVmAgentAdapter(): Adapter {
  const roots = [path.join(HOME, '.vscode', 'extensions'), path.join(HOME, '.cursor', 'extensions')];
  return {
    id: 'claude-vm-agent',
    name: 'Claude VM Agent (VS Code)',
    file: roots[0],
    markers: [],
    read: () => ({}),
    connect: () => {
      throw new Error('Claude VM Agent picks up MCP Manager servers automatically');
    },
    remove: () => {
      throw new Error('Disable servers in MCP Manager or untick them in the extension panel instead');
    },
    snippet: () =>
      'Nothing to configure. Claude VM Agent lists every enabled MCP Manager server in its\n' +
      '"Skills & MCP" panel and forwards them to the VM through one reverse SSH tunnel.',
    auto: () => {
      const versions = roots
        .flatMap((r) => (exists(r) ? fs.readdirSync(r) : []))
        .map((d) => /^[\w-]+\.claude-vm-agent-(\d+)\.(\d+)\.(\d+)/.exec(d))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
      if (!versions.length) return { detected: false, connected: false, note: 'Extension not installed' };
      const newest = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
      const ok = newest[0] - VM_AGENT_MIN[0] || newest[1] - VM_AGENT_MIN[1] || newest[2] - VM_AGENT_MIN[2];
      return ok >= 0
        ? { detected: true, connected: true, note: `v${newest.join('.')} — servers appear automatically in its Skills & MCP panel` }
        : { detected: true, connected: false, note: `v${newest.join('.')} installed — update to ${VM_AGENT_MIN.join('.')}+ to use MCP Manager servers` };
    },
  };
}

export function adapters(): Adapter[] {
  return [
    jsonAdapter({
      id: 'claude-code',
      name: 'Claude Code',
      file: path.join(HOME, '.claude.json'),
      markers: [path.join(HOME, '.claude'), path.join(HOME, '.claude.json')],
      key: 'mcpServers',
      entry: (e) => ({ type: 'http', url: e.url, ...(e.token ? { headers: auth(e) } : {}) }),
      note: 'User scope (all projects). Equivalent CLI: claude mcp add --scope user --transport http <name> <url>',
      extraRead: (obj) =>
        Object.assign({}, ...Object.values<any>(obj.projects ?? {}).map((p) => p?.mcpServers ?? {})),
      extraRemove: (obj, names) => {
        for (const p of Object.values<any>(obj.projects ?? {})) for (const n of names) delete p?.mcpServers?.[n];
      },
    }),
    codexAdapter(),
    jsonAdapter({
      id: 'claude-desktop',
      name: 'Claude Desktop',
      file: path.join(APP_SUPPORT, 'Claude', 'claude_desktop_config.json'),
      markers: [path.join(APP_SUPPORT, 'Claude'), '/Applications/Claude.app'],
      key: 'mcpServers',
      entry: () => bridgeCommand(),
      note: 'Claude Desktop config only supports stdio, so it launches the built-in `mcp-manager bridge`. Restart Claude Desktop afterwards.',
    }),
    jsonAdapter({
      id: 'cursor',
      name: 'Cursor',
      file: path.join(HOME, '.cursor', 'mcp.json'),
      markers: [path.join(HOME, '.cursor'), '/Applications/Cursor.app'],
      key: 'mcpServers',
      entry: (e) => ({ url: e.url, ...(e.token ? { headers: auth(e) } : {}) }),
    }),
    jsonAdapter({
      id: 'vscode',
      name: 'VS Code (Copilot)',
      file: path.join(APP_SUPPORT, 'Code', 'User', 'mcp.json'),
      markers: [path.join(APP_SUPPORT, 'Code'), '/Applications/Visual Studio Code.app'],
      key: 'servers',
      entry: (e) => ({ type: 'http', url: e.url, ...(e.token ? { headers: auth(e) } : {}) }),
    }),
    jsonAdapter({
      id: 'gemini',
      name: 'Gemini CLI',
      file: path.join(HOME, '.gemini', 'settings.json'),
      markers: [path.join(HOME, '.gemini')],
      key: 'mcpServers',
      entry: (e) => ({ httpUrl: e.url, ...(e.token ? { headers: auth(e) } : {}) }),
    }),
    jsonAdapter({
      id: 'copilot-cli',
      name: 'GitHub Copilot CLI',
      file: path.join(HOME, '.copilot', 'mcp-config.json'),
      markers: [path.join(HOME, '.copilot')],
      key: 'mcpServers',
      entry: (e) => ({ type: 'http', url: e.url, ...(e.token ? { headers: auth(e) } : {}), tools: ['*'] }),
    }),
    jsonAdapter({
      id: 'windsurf',
      name: 'Windsurf',
      file: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
      markers: [path.join(HOME, '.codeium', 'windsurf'), '/Applications/Windsurf.app'],
      key: 'mcpServers',
      entry: (e) => ({ serverUrl: e.url, ...(e.token ? { headers: auth(e) } : {}) }),
    }),
    claudeVmAgentAdapter(),
    jsonAdapter({
      id: 'opencode',
      name: 'opencode',
      file: path.join(HOME, '.config', 'opencode', 'opencode.json'),
      markers: [path.join(HOME, '.config', 'opencode')],
      key: 'mcp',
      entry: (e) => ({ type: 'remote', url: e.url, enabled: true, oauth: false, ...(e.token ? { headers: auth(e) } : {}) }),
    }),
  ];
}

export function getAdapter(id: string): Adapter {
  const a = adapters().find((x) => x.id === id);
  if (!a) throw new Error(`Unknown client "${id}"`);
  return a;
}

/** True when a raw entry points back at this hub (so we never import ourselves). */
export function isHubEntry(raw: RawServer, port: number): boolean {
  const url = raw.url ?? raw.serverUrl ?? raw.httpUrl ?? '';
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/mcp/.test(url) && url.includes(`:${port}/`)) return true;
  const cmd = [raw.command, ...(raw.args ?? [])].flat().join(' ');
  return cmd.includes(CLI_FILE) && cmd.includes('bridge');
}

export function describeClients(entry: HubEntry, port: number): ClientInfo[] {
  return adapters().map((a) => {
    if (a.auto) {
      const st = a.auto();
      return { id: a.id, name: a.name, configPath: a.file, ...st, auto: true, servers: [], snippet: a.snippet(entry) };
    }
    let servers: Record<string, RawServer> = {};
    let note = a.note;
    try {
      servers = a.read();
    } catch (err) {
      note = `Could not parse ${a.file}: ${err instanceof Error ? err.message : err}`;
    }
    const connected = Object.entries(servers).some(([n, raw]) => n === entry.name && isHubEntry(raw, port));
    return {
      id: a.id,
      name: a.name,
      configPath: a.file,
      detected: exists(a.file) || a.markers.some(exists),
      connected,
      servers: Object.entries(servers)
        .filter(([, raw]) => !isHubEntry(raw, port))
        .map(([n]) => n),
      snippet: a.snippet(entry),
      note,
    };
  });
}
