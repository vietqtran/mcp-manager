import fs from 'node:fs';
import { CONFIG_FILE, DATA_DIR, DEFAULT_PORT, LOG_DIR, SECRETS_FILE } from './paths.js';
import type { ConfigFile, KV, SecretsFile, ServerDef, Settings } from './types.js';
import { ID_RE, newToken, readJson, writeFileAtomic } from './util.js';

const DEFAULT_SETTINGS = (): Settings => ({
  port: DEFAULT_PORT,
  hosts: ['127.0.0.1'],
  token: newToken(),
  requireTokenOnLoopback: false,
  clientEntryName: 'mcpm',
});

/**
 * Persists server definitions in config.json and secret values in secrets.json (mode 0600).
 * In memory, ServerDef objects always carry the real secret values.
 */
export class Store {
  settings: Settings;
  servers: ServerDef[];

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DATA_DIR, 0o700); // launchd may have created it (for the log path) with 0755
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const f of [CONFIG_FILE, SECRETS_FILE]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    const cfg = readJson<ConfigFile>(CONFIG_FILE);
    const secrets = readJson<SecretsFile>(SECRETS_FILE) ?? {};
    this.settings = { ...DEFAULT_SETTINGS(), ...(cfg?.settings ?? {}) };
    this.servers = (cfg?.servers ?? []).map((s) => hydrate(s, secrets[s.id] ?? {}));
    if (!cfg) this.save();
  }

  get(id: string): ServerDef | undefined {
    return this.servers.find((s) => s.id === id);
  }

  upsert(def: ServerDef): void {
    validate(def);
    const i = this.servers.findIndex((s) => s.id === def.id);
    if (i >= 0) this.servers[i] = def;
    else this.servers.push(def);
    this.save();
  }

  remove(id: string): void {
    this.servers = this.servers.filter((s) => s.id !== id);
    this.save();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch };
    if (!this.settings.hosts.includes('127.0.0.1')) this.settings.hosts.unshift('127.0.0.1');
    this.save();
    return this.settings;
  }

  save(): void {
    const secrets: SecretsFile = {};
    const servers = this.servers.map((s) => {
      const bag: Record<string, string> = {};
      const strip = (list: KV[] | undefined, kind: string) =>
        list?.map((kv) => {
          if (!kv.secret) return kv;
          bag[`${kind}:${kv.key}`] = kv.value;
          return { ...kv, value: '' };
        });
      const out = { ...s, env: strip(s.env, 'env'), headers: strip(s.headers, 'header') };
      if (Object.keys(bag).length) secrets[s.id] = bag;
      return out;
    });
    const cfg: ConfigFile = { version: 1, settings: this.settings, servers };
    writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 0o600);
    writeFileAtomic(SECRETS_FILE, JSON.stringify(secrets, null, 2) + '\n', 0o600);
  }
}

function hydrate(s: ServerDef, bag: Record<string, string>): ServerDef {
  const fill = (list: KV[] | undefined, kind: string) =>
    list?.map((kv) => (kv.secret ? { ...kv, value: bag[`${kind}:${kv.key}`] ?? '' } : kv));
  return { ...s, env: fill(s.env, 'env'), headers: fill(s.headers, 'header') };
}

export function validate(def: ServerDef): void {
  if (!ID_RE.test(def.id)) {
    throw new Error(`Invalid id "${def.id}": use lowercase letters, digits and single dashes (max 32 chars)`);
  }
  if (!def.name?.trim()) throw new Error('Name is required');
  if (def.transport === 'stdio' && !def.command?.trim()) throw new Error('Command is required for stdio servers');
  if (def.transport === 'http') {
    try {
      new URL(def.url ?? '');
    } catch {
      throw new Error('A valid URL is required for HTTP servers');
    }
  }
}
