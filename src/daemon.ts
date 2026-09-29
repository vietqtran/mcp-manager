import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { apiRouter, VERSION } from './api.js';
import { Gateway } from './gateway.js';
import { Hub } from './hub.js';
import { CLI_FILE, SHIM_FILE } from './paths.js';
import { guard } from './security.js';
import { stableNodePath, cachedNodePath } from './env.js';
import { Store } from './store.js';

export async function runDaemon(opts: { port?: number } = {}): Promise<void> {
  const store = new Store();
  await stableNodePath();
  writeShim();
  if (opts.port) store.settings.port = opts.port;
  const hub = new Hub(store);
  const gateway = new Gateway(hub);

  const app = express();
  app.disable('x-powered-by');
  app.use(guard(store));
  app.use('/api', apiRouter(hub, gateway));
  gateway.mount(app);
  app.get('/', (_req, res) => res.json({ name: 'mcp-manager', version: VERSION, mcp: '/mcp' }));

  const port = store.settings.port;
  const hosts = store.settings.hosts.includes('0.0.0.0') ? ['0.0.0.0'] : store.settings.hosts;
  const servers: http.Server[] = [];
  for (const host of hosts) {
    try {
      servers.push(await listen(app, host, port));
      console.log(`mcp-manager ${VERSION} listening on http://${host.includes(':') ? `[${host}]` : host}:${port}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (host === '127.0.0.1' || host === '0.0.0.0') {
        console.error(code === 'EADDRINUSE' ? `Port ${port} is already in use (is the engine already running?)` : err);
        process.exit(1);
      }
      console.error(`Could not listen on ${host}:${port} (${code}); continuing without it`);
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, stopping servers...`);
    for (const s of servers) s.close();
    await gateway.closeAll();
    await Promise.race([hub.shutdown(), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await hub.startEnabled();
  const running = hub.list().filter((u) => u.status === 'running').length;
  console.log(`${running}/${hub.list().length} servers running. Aggregate endpoint: http://127.0.0.1:${port}/mcp`);
}

function listen(app: express.Express, host: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** ~/.mcp-manager/bin/mcp-manager -> this node + this CLI, so remote SSH commands have a stable path. */
function writeShim(): void {
  if (!CLI_FILE.endsWith('.js') || !fs.existsSync(CLI_FILE)) return;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.mkdirSync(path.dirname(SHIM_FILE), { recursive: true });
  fs.writeFileSync(SHIM_FILE, `#!/bin/sh\nexec ${q(cachedNodePath())} ${q(CLI_FILE)} "$@"\n`, { mode: 0o755 });
}
