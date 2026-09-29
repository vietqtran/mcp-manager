import { EventEmitter } from 'node:events';
import type { Prompt, Resource, ResourceTemplate, Tool } from '@modelcontextprotocol/sdk/types.js';
import { Store } from './store.js';
import type { ServerDef } from './types.js';
import { Upstream } from './upstream.js';

/** Separator between server id and tool/prompt name on the aggregated endpoint. Ids never contain "_". */
export const SEP = '__';

export interface ServerView {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  transport: ServerDef['transport'];
  presetId?: string;
  status: Upstream['status'];
  error?: string;
  pid?: number;
  startedAt?: number;
  serverInfo?: Upstream['serverInfo'];
  command: string;
  toolCount: number;
  activeToolCount: number;
  promptCount: number;
  resourceCount: number;
}

/**
 * Owns every Upstream and exposes a merged catalog.
 * Events: 'status' (id), 'catalog' (id), 'log' (id, line), 'servers' (list changed).
 */
export class Hub extends EventEmitter {
  private ups = new Map<string, Upstream>();

  constructor(public store: Store) {
    super();
    this.setMaxListeners(0);
    for (const def of store.servers) this.attach(def);
  }

  async startEnabled(): Promise<void> {
    await Promise.all([...this.ups.values()].filter((u) => u.def.enabled).map((u) => u.start()));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.ups.values()].map((u) => u.stop()));
  }

  get(id: string): Upstream | undefined {
    return this.ups.get(id);
  }

  list(): Upstream[] {
    return this.store.servers.map((s) => this.ups.get(s.id)!).filter(Boolean);
  }

  view(u: Upstream): ServerView {
    const d = u.def;
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      enabled: d.enabled,
      transport: d.transport,
      presetId: d.presetId,
      status: u.status,
      error: u.error,
      pid: u.pid,
      startedAt: u.startedAt,
      serverInfo: u.serverInfo,
      command: u.describe(),
      toolCount: u.tools.length,
      activeToolCount: u.activeTools.length,
      promptCount: u.prompts.length,
      resourceCount: u.resources.length + u.resourceTemplates.length,
    };
  }

  async create(def: ServerDef): Promise<Upstream> {
    if (this.ups.has(def.id)) throw new Error(`A server with id "${def.id}" already exists`);
    this.store.upsert(def);
    const u = this.attach(def);
    this.emit('servers');
    if (def.enabled) void u.start();
    return u;
  }

  /** Replace a server definition. Restarts the connection only when launch-relevant fields changed. */
  async update(id: string, def: ServerDef): Promise<Upstream> {
    const u = this.ups.get(id);
    if (!u) throw new Error(`Unknown server "${id}"`);
    if (def.id !== id) throw new Error('Server id cannot be changed');
    this.store.upsert(def);
    const needsRestart = launchKey(u.def) !== launchKey(def);
    const toolsChanged =
      JSON.stringify([u.def.disabledTools ?? [], u.def.fixedArgs ?? []]) !==
      JSON.stringify([def.disabledTools ?? [], def.fixedArgs ?? []]);
    u.def = def;
    this.emit('servers');
    if (!def.enabled) await u.stop();
    else if (needsRestart || u.status === 'stopped') await u.restart();
    else if (toolsChanged) this.emit('catalog', id);
    return u;
  }

  async remove(id: string): Promise<void> {
    const u = this.ups.get(id);
    if (!u) throw new Error(`Unknown server "${id}"`);
    await u.stop();
    u.removeAllListeners();
    this.ups.delete(id);
    this.store.remove(id);
    this.emit('servers');
    this.emit('catalog', id);
  }

  private attach(def: ServerDef): Upstream {
    const u = new Upstream(def);
    u.on('status', () => this.emit('status', u.def.id));
    u.on('catalog', () => this.emit('catalog', u.def.id));
    u.on('log', (line) => this.emit('log', u.def.id, line));
    this.ups.set(def.id, u);
    return u;
  }

  // ---- catalog for the gateway. scope = null means "all enabled servers", prefixed. ----

  private scoped(scope: string | null): Upstream[] {
    if (scope) {
      const u = this.ups.get(scope);
      return u ? [u] : [];
    }
    return this.list().filter((u) => u.def.enabled && u.status === 'running');
  }

  tools(scope: string | null): Tool[] {
    return this.scoped(scope).flatMap((u) =>
      u.activeTools.map((t) => (scope ? t : { ...t, name: `${u.def.id}${SEP}${t.name}` })),
    );
  }

  prompts(scope: string | null): Prompt[] {
    return this.scoped(scope).flatMap((u) =>
      u.prompts.map((p) => (scope ? p : { ...p, name: `${u.def.id}${SEP}${p.name}` })),
    );
  }

  resources(scope: string | null): Resource[] {
    return this.scoped(scope).flatMap((u) => u.resources);
  }

  resourceTemplates(scope: string | null): ResourceTemplate[] {
    return this.scoped(scope).flatMap((u) => u.resourceTemplates);
  }

  /** Map a client-visible tool/prompt name back to its server and original name. */
  resolve(scope: string | null, name: string): { up: Upstream; name: string } | undefined {
    if (scope) {
      const up = this.ups.get(scope);
      return up ? { up, name } : undefined;
    }
    const i = name.indexOf(SEP);
    if (i <= 0) return undefined;
    const up = this.ups.get(name.slice(0, i));
    return up ? { up, name: name.slice(i + SEP.length) } : undefined;
  }

  /** Servers that may be able to read a resource URI: exact matches first, then servers with templates. */
  resourceOwners(scope: string | null, uri: string): Upstream[] {
    const ups = this.scoped(scope);
    const exact = ups.filter((u) => u.resources.some((r) => r.uri === uri));
    const rest = ups.filter((u) => !exact.includes(u) && u.capabilities?.resources);
    return [...exact, ...rest];
  }

  instructions(scope: string | null): string | undefined {
    const parts = this.scoped(scope)
      .filter((u) => u.instructions)
      .map((u) => (scope ? u.instructions! : `## ${u.def.name} (tools prefixed "${u.def.id}${SEP}")\n${u.instructions}`));
    return parts.length ? parts.join('\n\n') : undefined;
  }
}

function launchKey(d: ServerDef): string {
  return JSON.stringify([d.transport, d.command, d.args, d.env, d.cwd, d.url, d.headers]);
}
