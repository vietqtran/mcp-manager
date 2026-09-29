import os from 'node:os';
import express, { type Request, type Response, type Router } from 'express';
import { describeClients, getAdapter, isHubEntry, type HubEntry } from './clients/index.js';
import { cachedNodePath, runtimeAvailability } from './env.js';
import type { Gateway } from './gateway.js';
import type { Hub } from './hub.js';
import { parseServersJson, toCandidates } from './importer.js';
import { installService, restartService, serviceStatus, uninstallService } from './launchd.js';
import { CLI_FILE, DATA_DIR, SHIM_FILE } from './paths.js';
import { getPreset, loadPresets, renderPreset } from './presets.js';
import type { KV, ServerDef, Settings } from './types.js';
import { newToken, parseJsonc, slugify } from './util.js';

export const VERSION = '0.1.0';
const startedAt = Date.now();

type KVIn = { key: string; value?: string | null; secret?: boolean; hasValue?: boolean };
type DefIn = Partial<Omit<ServerDef, 'env' | 'headers' | 'fixedArgs'>> & { env?: KVIn[]; headers?: KVIn[]; fixedArgs?: KVIn[] };

/** Hide secret values from API responses. */
function publicDef(def: ServerDef, reveal = false) {
  const mask = (list?: KV[]) =>
    list?.map((kv) => (kv.secret && !reveal ? { key: kv.key, value: '', secret: true, hasValue: !!kv.value } : kv));
  return { ...def, env: mask(def.env), headers: mask(def.headers) };
}

/** Build a full ServerDef from client input, keeping stored secret values the client left blank. */
function mergeDef(input: DefIn, prev?: ServerDef): ServerDef {
  const merge = (list: KVIn[] | undefined, old: KV[] | undefined): KV[] =>
    (list ?? [])
      .filter((kv) => kv.key?.trim())
      .map((kv) => {
        const key = kv.key.trim();
        // A masked secret sent back unchanged (null, missing, or "" with hasValue) keeps the stored value.
        const keep = kv.secret && (kv.value == null || (kv.value === '' && kv.hasValue === true));
        const value = keep ? (old?.find((o) => o.key === key)?.value ?? '') : String(kv.value ?? '');
        return { key, value, ...(kv.secret ? { secret: true } : {}) };
      });
  const now = new Date().toISOString();
  const name = (input.name ?? prev?.name ?? '').trim();
  const transport = input.transport ?? prev?.transport ?? 'stdio';
  return {
    id: prev?.id ?? (input.id?.trim() || slugify(name)),
    name,
    description: input.description ?? prev?.description,
    enabled: input.enabled ?? prev?.enabled ?? true,
    transport,
    ...(transport === 'stdio'
      ? {
          command: (input.command ?? prev?.command ?? '').trim(),
          args: (input.args ?? prev?.args ?? []).map(String),
          env: merge(input.env ?? prev?.env, prev?.env),
          cwd: (input.cwd ?? prev?.cwd)?.trim() || undefined,
        }
      : {
          url: (input.url ?? prev?.url ?? '').trim(),
          headers: merge(input.headers ?? prev?.headers, prev?.headers),
        }),
    disabledTools: input.disabledTools ?? prev?.disabledTools ?? [],
    fixedArgs: (input.fixedArgs ?? prev?.fixedArgs ?? [])
      .filter((kv) => kv.key?.trim())
      .map((kv) => ({ key: kv.key.trim(), value: String(kv.value ?? '') })),
    presetId: prev?.presetId ?? input.presetId,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

function sse(res: Response): (event: string, data: unknown) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  res.on('close', () => clearInterval(ping));
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function apiRouter(hub: Hub, gateway: Gateway): Router {
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));
  const store = hub.store;
  const baseUrl = () => `http://127.0.0.1:${store.settings.port}`;
  const hubEntry = (): HubEntry => ({
    name: store.settings.clientEntryName,
    url: `${baseUrl()}/mcp`,
    token: store.settings.requireTokenOnLoopback ? store.settings.token : undefined,
  });
  const need = (id: string) => {
    const u = hub.get(id);
    if (!u) throw Object.assign(new Error(`Unknown server "${id}"`), { status: 404 });
    return u;
  };
  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
      try {
        const out = await fn(req, res);
        if (out !== undefined && !res.headersSent) res.json(out);
      } catch (err) {
        const e = err as Error & { status?: number };
        if (!res.headersSent) res.status(e.status ?? 400).json({ error: e.message });
      }
    };
  const id = (req: Request) => String(req.params.id);

  // ---- engine ----
  r.get('/status', wrap(async () => ({
    version: VERSION,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    port: store.settings.port,
    hosts: store.settings.hosts,
    dataDir: DATA_DIR,
    supervised: process.env.MCPM_SUPERVISED === '1',
    aggregateUrl: `${baseUrl()}/mcp`,
    serverCount: hub.list().length,
    runningCount: hub.list().filter((u) => u.status === 'running').length,
    sessions: gateway.stats(),
    runtimes: await runtimeAvailability(),
    cliPath: CLI_FILE,
    shimPath: SHIM_FILE,
    nodePath: cachedNodePath(),
    user: os.userInfo().username,
    hostname: os.hostname(),
    addresses: Object.entries(os.networkInterfaces()).flatMap(([iface, list]) =>
      (list ?? [])
        .filter((i) => i.family === 'IPv4' && !i.internal)
        .map((i) => ({ iface, address: i.address, tailscale: i.address.startsWith('100.') })),
    ),
  })));
  r.post('/engine/restart', wrap(async (_req, res) => {
    if (process.env.MCPM_SUPERVISED !== '1') throw new Error('Engine is not running under launchd; restart it manually');
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 200);
  }));
  r.get('/service', wrap(() => serviceStatus()));
  r.post('/service/install', wrap(async () => (await installService(), serviceStatus())));
  r.post('/service/uninstall', wrap(async () => (await uninstallService(), serviceStatus())));
  r.post('/service/restart', wrap(async () => (await restartService(), { ok: true })));

  // ---- servers ----
  r.get('/servers', wrap(() => ({ servers: hub.list().map((u) => hub.view(u)) })));
  r.post('/servers', wrap(async (req) => {
    const def = mergeDef(req.body as DefIn);
    return { server: hub.view(await hub.create(def)) };
  }));
  r.get('/servers/:id', wrap((req) => {
    const u = need(id(req));
    return { server: hub.view(u), def: publicDef(u.def, req.query.reveal === '1') };
  }));
  r.put('/servers/:id', wrap(async (req) => {
    const u = need(id(req));
    return { server: hub.view(await hub.update(u.def.id, mergeDef(req.body as DefIn, u.def))) };
  }));
  r.patch('/servers/:id', wrap(async (req) => {
    const u = need(id(req));
    const body = req.body as Pick<ServerDef, 'enabled' | 'disabledTools' | 'name'>;
    const def: ServerDef = {
      ...u.def,
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.disabledTools ? { disabledTools: body.disabledTools } : {}),
      ...(body.name ? { name: body.name } : {}),
      updatedAt: new Date().toISOString(),
    };
    return { server: hub.view(await hub.update(u.def.id, def)) };
  }));
  r.delete('/servers/:id', wrap(async (req) => (await hub.remove(need(id(req)).def.id), { ok: true })));
  for (const action of ['start', 'stop', 'restart'] as const) {
    r.post(`/servers/:id/${action}`, wrap(async (req) => {
      const u = need(id(req));
      if (action === 'start') await u.start();
      else if (action === 'stop') await u.stop();
      else await u.restart();
      return { server: hub.view(u) };
    }));
  }
  r.get('/servers/:id/catalog', wrap((req) => {
    const u = need(id(req));
    return {
      tools: u.tools,
      disabledTools: u.def.disabledTools ?? [],
      prompts: u.prompts,
      resources: u.resources,
      resourceTemplates: u.resourceTemplates,
      instructions: u.instructions ?? null,
    };
  }));
  r.post('/servers/:id/refresh', wrap(async (req) => {
    const u = need(id(req));
    await u.refresh();
    return { server: hub.view(u) };
  }));
  r.post('/servers/:id/call', wrap(async (req) => {
    const u = need(id(req));
    const { tool, arguments: args } = req.body as { tool: string; arguments?: Record<string, unknown> };
    return u.callTool(tool, args ?? {});
  }));
  r.get('/servers/:id/logs', wrap((req) => ({ logs: need(id(req)).logs })));
  r.get('/servers/:id/logs/stream', (req, res) => {
    const u = hub.get(id(req));
    if (!u) return void res.status(404).json({ error: 'Unknown server' });
    const send = sse(res);
    const onLog = (line: unknown) => send('log', line);
    u.on('log', onLog);
    res.on('close', () => u.off('log', onLog));
  });

  // ---- presets & import ----
  r.get('/presets', wrap(() => ({ presets: loadPresets() })));
  r.post('/presets/:id/install', wrap(async (req) => {
    const preset = getPreset(id(req));
    if (!preset) throw Object.assign(new Error('Unknown preset'), { status: 404 });
    const body = req.body as { id?: string; name?: string; values?: Record<string, string | boolean> };
    const sid = body.id?.trim() || uniqueId(slugify(body.name || preset.id));
    const def = renderPreset(preset, body.values ?? {}, { id: sid, name: body.name });
    return { server: hub.view(await hub.create(def)) };
  }));
  r.post('/import/parse', wrap((req) => {
    const { json } = req.body as { json: string };
    const servers = parseServersJson(parseJsonc(json));
    return { candidates: toCandidates(servers, takenIds()) };
  }));
  r.post('/import', wrap(async (req) => {
    const { defs, client, removeFromClient } = req.body as { defs: DefIn[]; client?: string; removeFromClient?: string[] };
    const created = [];
    const errors = [];
    for (const input of defs) {
      try {
        created.push(hub.view(await hub.create(mergeDef(input))));
      } catch (err) {
        errors.push({ id: input.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    let backup: string | undefined;
    if (client && removeFromClient?.length && errors.length === 0) {
      const a = getAdapter(client);
      backup = a.remove(removeFromClient);
      a.connect(hubEntry());
    }
    return { created, errors, backup: backup ?? null };
  }));

  // ---- clients ----
  r.get('/clients', wrap(() => ({ entry: hubEntry(), clients: describeClients(hubEntry(), store.settings.port) })));
  r.get('/clients/:id/candidates', wrap((req) => {
    const servers = getAdapter(id(req)).read();
    const own = Object.fromEntries(Object.entries(servers).filter(([, raw]) => !isHubEntry(raw, store.settings.port)));
    return { candidates: toCandidates(own, takenIds()) };
  }));
  r.post('/clients/:id/connect', wrap((req) => ({ ok: true, backup: getAdapter(id(req)).connect(hubEntry()) ?? null })));
  r.post('/clients/:id/disconnect', wrap((req) => ({
    ok: true,
    backup: getAdapter(id(req)).remove([store.settings.clientEntryName]) ?? null,
  })));

  // ---- settings ----
  r.get('/settings', wrap(() => ({ settings: store.settings })));
  r.put('/settings', wrap((req) => {
    const body = req.body as Partial<Settings>;
    const before = JSON.stringify([store.settings.port, store.settings.hosts]);
    const patch: Partial<Settings> = {};
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024-65535');
      patch.port = port;
    }
    if (body.hosts) patch.hosts = [...new Set(body.hosts.map((h) => h.trim()).filter(Boolean))];
    if (body.requireTokenOnLoopback !== undefined) patch.requireTokenOnLoopback = !!body.requireTokenOnLoopback;
    if (body.clientEntryName) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(body.clientEntryName)) throw new Error('Entry name: letters, digits, - and _');
      patch.clientEntryName = body.clientEntryName;
    }
    const settings = store.updateSettings(patch);
    return { settings, restartRequired: JSON.stringify([settings.port, settings.hosts]) !== before };
  }));
  r.post('/settings/rotate-token', wrap(() => ({ settings: store.updateSettings({ token: newToken() }) })));

  // ---- live events for the app ----
  r.get('/events', (_req, res) => {
    const send = sse(res);
    const onStatus = (sid: string) => send('status', { id: sid });
    const onServers = () => send('servers', {});
    const onCatalog = (sid: string) => send('catalog', { id: sid });
    hub.on('status', onStatus);
    hub.on('servers', onServers);
    hub.on('catalog', onCatalog);
    res.on('close', () => {
      hub.off('status', onStatus);
      hub.off('servers', onServers);
      hub.off('catalog', onCatalog);
    });
  });

  function takenIds(): Set<string> {
    return new Set(hub.list().map((u) => u.def.id));
  }
  function uniqueId(base: string): string {
    const taken = takenIds();
    let sid = base;
    for (let n = 2; taken.has(sid); n++) sid = `${base.slice(0, 28)}-${n}`;
    return sid;
  }
  return r;
}
