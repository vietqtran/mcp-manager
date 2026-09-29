import { adapters, describeClients, getAdapter } from './clients/index.js';
import { runBridge } from './bridge.js';
import { runDaemon } from './daemon.js';
import { stableNodePath } from './env.js';
import { installService, restartService, serviceStatus, uninstallService } from './launchd.js';
import { Store } from './store.js';

const HELP = `mcp-manager — run MCP servers once on this Mac and share them with every client

Usage:
  mcp-manager start [--port N]            Run the engine in the foreground
  mcp-manager service install|uninstall|restart|status
                                          Run the engine at login via launchd
  mcp-manager status                      Show engine and server status
  mcp-manager token                       Print the access token for remote clients
  mcp-manager clients                     List detected MCP clients
  mcp-manager connect <client>            Add the hub to a client config (claude-code, codex, cursor, ...)
  mcp-manager disconnect <client>         Remove the hub from a client config
  mcp-manager bridge [--server ID] [--url URL] [--token T]
                                          stdio bridge to the hub (for stdio-only clients or ssh)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function api(path: string): Promise<any> {
  const store = new Store();
  const res = await fetch(`http://127.0.0.1:${store.settings.port}/api${path}`, {
    headers: { Authorization: `Bearer ${store.settings.token}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'start':
      return runDaemon({ port: flag(rest, 'port') ? Number(flag(rest, 'port')) : undefined });
    case 'bridge': {
      const store = new Store();
      const server = flag(rest, 'server');
      const url = flag(rest, 'url') ?? `http://127.0.0.1:${store.settings.port}/mcp${server ? `/${server}` : ''}`;
      return runBridge({ url, token: flag(rest, 'token') ?? store.settings.token });
    }
    case 'service': {
      const sub = rest[0] ?? 'status';
      if (sub === 'install') await installService();
      else if (sub === 'uninstall') await uninstallService();
      else if (sub === 'restart') await restartService();
      console.log(JSON.stringify(await serviceStatus(), null, 2));
      return;
    }
    case 'status': {
      try {
        const s = await api('/status');
        const { servers } = await api('/servers');
        console.log(`Engine ${s.version} pid ${s.pid} — ${s.runningCount}/${s.serverCount} running — ${s.aggregateUrl}`);
        for (const v of servers) {
          console.log(`  ${v.status.padEnd(8)} ${v.id.padEnd(24)} ${v.activeToolCount} tools  ${v.error ?? ''}`);
        }
      } catch (err) {
        console.log(`Engine not reachable: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'token':
      console.log(new Store().settings.token);
      return;
    case 'clients': {
      const store = new Store();
      const entry = { name: store.settings.clientEntryName, url: `http://127.0.0.1:${store.settings.port}/mcp` };
      for (const c of describeClients(entry, store.settings.port)) {
        const state = c.connected ? 'connected' : c.detected ? 'detected' : '-';
        console.log(`${c.id.padEnd(15)} ${state.padEnd(10)} ${c.servers.length} other servers  ${c.configPath}`);
      }
      return;
    }
    case 'connect':
    case 'disconnect': {
      const id = rest[0];
      if (!id) throw new Error(`Usage: mcp-manager ${cmd} <${adapters().map((a) => a.id).join('|')}>`);
      const store = new Store();
      const s = store.settings;
      const a = getAdapter(id);
      await stableNodePath();
      const backup =
        cmd === 'connect'
          ? a.connect({
              name: s.clientEntryName,
              url: `http://127.0.0.1:${s.port}/mcp`,
              token: s.requireTokenOnLoopback ? s.token : undefined,
            })
          : a.remove([s.clientEntryName]);
      console.log(`${cmd === 'connect' ? 'Connected' : 'Disconnected'} ${a.name} (${a.file})${backup ? `\nBackup: ${backup}` : ''}`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
