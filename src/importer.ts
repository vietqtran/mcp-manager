import type { KV, ServerDef } from './types.js';
import { looksSecret, slugify } from './util.js';

/** Loose shape covering Claude/Cursor/VS Code/Gemini/Windsurf/Copilot/Opencode/Codex entries. */
export interface RawServer {
  type?: string;
  command?: string | string[];
  args?: string[];
  env?: Record<string, string>;
  environment?: Record<string, string>;
  cwd?: string;
  url?: string;
  serverUrl?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
  http_headers?: Record<string, string>;
  bearer_token_env_var?: string;
  disabled?: boolean;
  enabled?: boolean;
}

export interface ImportCandidate {
  sourceName: string;
  def?: ServerDef;
  error?: string;
}

/**
 * Accepts any of:
 *   { "mcpServers": { name: {...} } }   (Claude, Cursor, Gemini, Windsurf, Copilot CLI)
 *   { "servers": { name: {...} } }      (VS Code)
 *   { "mcp": { name: {...} } }          (Opencode)
 *   { name: {...} }                      (bare map)
 *   { "command": ..., ... }              (single server; name taken from `fallbackName`)
 */
export function parseServersJson(input: unknown, fallbackName = 'imported'): Record<string, RawServer> {
  if (!input || typeof input !== 'object') throw new Error('Expected a JSON object');
  const obj = input as Record<string, unknown>;
  for (const key of ['mcpServers', 'servers', 'mcp', 'mcp_servers']) {
    if (obj[key] && typeof obj[key] === 'object') return obj[key] as Record<string, RawServer>;
  }
  if ('command' in obj || 'url' in obj || 'serverUrl' in obj || 'httpUrl' in obj) {
    return { [fallbackName]: obj as RawServer };
  }
  return obj as Record<string, RawServer>;
}

export function rawToDef(name: string, raw: RawServer, takenIds: Set<string>): ServerDef {
  const now = new Date().toISOString();
  const toKV = (map: Record<string, string> | undefined): KV[] =>
    Object.entries(map ?? {}).map(([key, value]) => ({
      key,
      value: String(value),
      ...(looksSecret(key) ? { secret: true } : {}),
    }));
  let id = slugify(name);
  for (let n = 2; takenIds.has(id); n++) id = `${slugify(name).slice(0, 28)}-${n}`;
  takenIds.add(id);
  const base = {
    id,
    name,
    enabled: raw.enabled !== false && raw.disabled !== true,
    createdAt: now,
    updatedAt: now,
  };
  const url = raw.url ?? raw.serverUrl ?? raw.httpUrl;
  if (url && !raw.command) {
    const headers = toKV({ ...(raw.headers ?? {}), ...(raw.http_headers ?? {}) });
    if (raw.bearer_token_env_var && process.env[raw.bearer_token_env_var]) {
      headers.push({ key: 'Authorization', value: `Bearer ${process.env[raw.bearer_token_env_var]}`, secret: true });
    }
    return { ...base, transport: 'http', url, headers };
  }
  if (!raw.command) throw new Error('Entry has neither "command" nor "url"');
  const [command, ...cmdArgs] = Array.isArray(raw.command) ? raw.command : [raw.command];
  return {
    ...base,
    transport: 'stdio',
    command,
    args: [...cmdArgs, ...(raw.args ?? [])].map(String),
    env: toKV(raw.env ?? raw.environment),
    cwd: raw.cwd,
  };
}

export function toCandidates(servers: Record<string, RawServer>, takenIds: Set<string>): ImportCandidate[] {
  return Object.entries(servers).map(([sourceName, raw]) => {
    try {
      return { sourceName, def: rawToDef(sourceName, raw, takenIds) };
    } catch (err) {
      return { sourceName, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
