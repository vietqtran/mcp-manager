import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'echo-server.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpm-test-'));
const port = 17000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let engine: ChildProcess;

const api = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}/api${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
};
const waitFor = async (fn: () => Promise<boolean>, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timeout');
};
const mcpClient = async (url: string, headers: Record<string, string> = {}) => {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return c;
};

before(async () => {
  engine = spawn(TSX, [path.join(ROOT, 'src', 'cli.ts'), 'start', '--port', String(port)], {
    env: { ...process.env, MCP_MANAGER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine.stderr!.on('data', (d) => process.stderr.write(`[engine] ${d}`));
  await waitFor(async () => (await fetch(`${base}/api/status`)).ok);
  await api('/servers', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Echo',
      id: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: [{ key: 'ECHO_PREFIX', value: 'sekret', secret: true }],
    }),
  });
  await waitFor(async () => (await api('/servers/echo')).server.status === 'running');
});

after(async () => {
  engine.kill('SIGTERM');
  await new Promise((r) => engine.once('exit', r));
  fs.rmSync(home, { recursive: true, force: true });
});

test('secrets are stored in a 0600 file and masked by the API', async () => {
  const cfg = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.ok(!cfg.includes('sekret'));
  const secrets = path.join(home, 'secrets.json');
  assert.ok(fs.readFileSync(secrets, 'utf8').includes('sekret'));
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
  const { def } = await api('/servers/echo');
  assert.deepEqual(def.env[0], { key: 'ECHO_PREFIX', value: '', secret: true, hasValue: true });
});

test('two sessions share one upstream process through the aggregate endpoint', async () => {
  const a = await mcpClient(`${base}/mcp`);
  const b = await mcpClient(`${base}/mcp`);
  const { tools } = await a.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['echo__add', 'echo__echo']);
  const ra = await a.callTool({ name: 'echo__echo', arguments: { text: 'hi' } });
  const rb = await b.callTool({ name: 'echo__echo', arguments: { text: 'yo' } });
  const pid = (r: any) => /pid=(\d+)/.exec(r.content[0].text)![1];
  assert.match((ra.content as any)[0].text, /^echo:hi:sekret:/);
  assert.equal(pid(ra), pid(rb));
  const prompt = await a.getPrompt({ name: 'echo__greet', arguments: { name: 'Viet' } });
  assert.equal((prompt.messages[0].content as any).text, 'Hello Viet');
  assert.match(a.getInstructions() ?? '', /Echo fixture server/);
  await a.close();
  await b.close();
});

test('per-server endpoint exposes original tool names', async () => {
  const c = await mcpClient(`${base}/mcp/echo`);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'echo']);
  const r = await c.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
  assert.equal((r.content as any)[0].text, '5');
  await c.close();
});

test('disabling a tool notifies connected clients and hides it', async () => {
  const c = await mcpClient(`${base}/mcp`);
  const changed = new Promise<void>((resolve) => c.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
  await c.listTools();
  await api('/servers/echo', { method: 'PATCH', body: JSON.stringify({ disabledTools: ['add'] }) });
  await changed;
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['echo__echo']);
  await assert.rejects(c.callTool({ name: 'echo__add', arguments: { a: 1, b: 1 } }), /Unknown tool/);
  await api('/servers/echo', { method: 'PATCH', body: JSON.stringify({ disabledTools: [] }) });
  await c.close();
});

test('stdio bridge works and survives an upstream restart', async () => {
  const c = new Client({ name: 'bridge-test', version: '1' });
  await c.connect(
    new StdioClientTransport({
      command: TSX,
      args: [path.join(ROOT, 'src', 'cli.ts'), 'bridge', '--server', 'echo'],
      env: { ...process.env, MCP_MANAGER_HOME: home } as Record<string, string>,
    }),
  );
  const r = await c.callTool({ name: 'echo', arguments: { text: 'via-bridge' } });
  assert.match((r.content as any)[0].text, /^echo:via-bridge:/);
  await api('/servers/echo/restart', { method: 'POST' });
  const r2 = await c.callTool({ name: 'add', arguments: { a: 1, b: 2 } });
  assert.equal((r2.content as any)[0].text, '3');
  await c.close();
});

test('updating a secret-less field keeps the stored secret; crash triggers auto-restart', async () => {
  const { def } = await api('/servers/echo');
  await api('/servers/echo', { method: 'PUT', body: JSON.stringify({ ...def, name: 'Echo 2', args: [FIXTURE, '--x'] }) });
  await waitFor(async () => (await api('/servers/echo')).server.status === 'running');
  const c = await mcpClient(`${base}/mcp/echo`);
  const r = await c.callTool({ name: 'echo', arguments: { text: 'k' } });
  assert.match((r.content as any)[0].text, /:sekret:/);
  const pid = Number(/pid=(\d+)/.exec((r.content as any)[0].text)![1]);
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => {
    const s = (await api('/servers/echo')).server;
    return s.status === 'running' && s.pid !== pid;
  });
  await c.close();
});

test('rejects cross-origin browser requests and non-local Host headers', async () => {
  const evil = await fetch(`${base}/api/servers`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const rebind = await new Promise<number>((resolve, reject) =>
    http
      .get({ host: '127.0.0.1', port, path: '/api/servers', headers: { Host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
      .on('error', reject),
  );
  assert.equal(rebind, 403);
  const token = fs.readFileSync(path.join(home, 'config.json'), 'utf8').match(/"token": "([^"]+)"/)![1];
  const ok = await fetch(`${base}/api/servers`, { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
});
