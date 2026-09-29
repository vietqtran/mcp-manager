import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport as McpTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Implementation,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { loginPath } from './env.js';
import { LOG_DIR } from './paths.js';
import type { LogLine, ServerDef, Status } from './types.js';

const VERSION = '0.1.0';
const MAX_LOG_LINES = 1000;
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RESTARTS = 5;
const CONNECT_TIMEOUT_MS = 180_000; // first `npx`/`uvx` run may download packages
export const TOOL_TIMEOUT_MS = 30 * 60_000;

/**
 * One long-lived connection to an MCP server (a child process for stdio, or a remote HTTP endpoint).
 * Every client session of the hub shares this single connection.
 *
 * Events: 'status' (status changed), 'catalog' (tools/prompts/resources changed), 'log' (LogLine).
 */
export class Upstream extends EventEmitter {
  status: Status = 'stopped';
  error?: string;
  pid?: number;
  startedAt?: number;
  serverInfo?: Implementation;
  capabilities?: ServerCapabilities;
  instructions?: string;
  tools: Tool[] = [];
  prompts: Prompt[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  logs: LogLine[] = [];

  private client?: Client;
  private transport?: McpTransport;
  private stopping = false;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private logFile: string;
  private generation = 0;

  constructor(public def: ServerDef) {
    super();
    this.setMaxListeners(0);
    this.logFile = path.join(LOG_DIR, `${def.id}.log`);
  }

  get activeTools(): Tool[] {
    const off = new Set(this.def.disabledTools ?? []);
    const fixed = new Set((this.def.fixedArgs ?? []).map((kv) => kv.key));
    return this.tools.filter((t) => !off.has(t.name)).map((t) => (fixed.size ? hideArgs(t, fixed) : t));
  }

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.stopping = false;
    clearTimeout(this.restartTimer);
    const gen = ++this.generation;
    this.setStatus('starting');
    this.log('system', `Starting ${this.describe()}`);
    try {
      await this.connect(gen);
      if (gen !== this.generation) return;
      this.startedAt = Date.now();
      this.setStatus('running');
      this.log('system', `Connected to ${this.serverInfo?.name ?? 'server'} ${this.serverInfo?.version ?? ''}`.trim());
      await this.refresh();
      this.stableTimer = setTimeout(() => (this.restarts = 0), 60_000);
    } catch (err) {
      if (gen !== this.generation) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.log('system', `Failed to start: ${msg}`);
      await this.teardown();
      this.error = msg;
      this.setStatus('error');
      this.scheduleRestart();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    clearTimeout(this.restartTimer);
    clearTimeout(this.stableTimer);
    if (this.status !== 'stopped') this.log('system', 'Stopping');
    await this.teardown();
    this.error = undefined;
    this.setStatus('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    this.restarts = 0;
    await this.start();
  }

  callTool(name: string, args: Record<string, unknown> | undefined, opts: RequestOptions = {}) {
    if (!this.client || this.status !== 'running') throw new Error(`Server "${this.def.id}" is not running`);
    const pinned: Record<string, unknown> = {};
    const props = this.tools.find((t) => t.name === name)?.inputSchema?.properties ?? {};
    for (const kv of this.def.fixedArgs ?? []) if (kv.key in props) pinned[kv.key] = kv.value;
    return this.client.callTool({ name, arguments: { ...(args ?? {}), ...pinned } }, undefined, {
      timeout: TOOL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      ...opts,
    });
  }

  getPrompt(name: string, args: Record<string, string> | undefined, opts: RequestOptions = {}) {
    if (!this.client) throw new Error(`Server "${this.def.id}" is not running`);
    return this.client.getPrompt({ name, arguments: args }, opts);
  }

  readResource(uri: string, opts: RequestOptions = {}) {
    if (!this.client) throw new Error(`Server "${this.def.id}" is not running`);
    return this.client.readResource({ uri }, opts);
  }

  /** Re-fetch tools, prompts and resources from the server. */
  async refresh(): Promise<void> {
    const c = this.client;
    const caps = this.capabilities ?? {};
    if (!c) return;
    const all = async <T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; next?: string }>) => {
      const items: T[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetchPage(cursor);
        items.push(...page.items);
        cursor = page.next;
      } while (cursor);
      return items;
    };
    const safe = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (err) {
        this.log('system', `Failed to list ${label}: ${err instanceof Error ? err.message : err}`);
        return [];
      }
    };
    [this.tools, this.prompts, this.resources, this.resourceTemplates] = await Promise.all([
      caps.tools
        ? safe('tools', () => all((cursor) => c.listTools({ cursor }).then((r) => ({ items: r.tools, next: r.nextCursor }))))
        : Promise.resolve([]),
      caps.prompts
        ? safe('prompts', () => all((cursor) => c.listPrompts({ cursor }).then((r) => ({ items: r.prompts, next: r.nextCursor }))))
        : Promise.resolve([]),
      caps.resources
        ? safe('resources', () =>
            all((cursor) => c.listResources({ cursor }).then((r) => ({ items: r.resources, next: r.nextCursor }))),
          )
        : Promise.resolve([]),
      caps.resources
        ? safe('resource templates', () =>
            all((cursor) =>
              c.listResourceTemplates({ cursor }).then((r) => ({ items: r.resourceTemplates, next: r.nextCursor })),
            ),
          )
        : Promise.resolve([]),
    ]);
    this.emit('catalog');
  }

  describe(): string {
    return this.def.transport === 'stdio'
      ? [this.def.command, ...(this.def.args ?? [])].join(' ')
      : (this.def.url ?? '');
  }

  private async connect(gen: number): Promise<void> {
    const client = new Client({ name: 'mcp-manager', version: VERSION }, { capabilities: {} });
    let transport: McpTransport;
    if (this.def.transport === 'stdio') {
      const env: Record<string, string> = { ...getDefaultEnvironment(), PATH: await loginPath() };
      for (const kv of this.def.env ?? []) if (kv.key) env[kv.key] = kv.value;
      const stdio = new StdioClientTransport({
        command: this.def.command!,
        args: this.def.args ?? [],
        env,
        cwd: this.def.cwd || undefined,
        stderr: 'pipe',
      });
      stdio.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) this.log('stderr', line);
      });
      transport = stdio;
    } else {
      transport = this.httpTransport(false);
    }
    this.client = client;
    this.transport = transport;
    this.wire(client, transport, gen);
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      // Older remote servers only speak the legacy HTTP+SSE transport.
      if (this.def.transport !== 'http' || gen !== this.generation) throw err;
      this.log('system', `Streamable HTTP failed (${err instanceof Error ? err.message : err}); trying SSE`);
      await this.teardown();
      const sseClient = new Client({ name: 'mcp-manager', version: VERSION }, { capabilities: {} });
      const sse = this.httpTransport(true);
      this.client = sseClient;
      this.transport = sse;
      this.wire(sseClient, sse, gen);
      await sseClient.connect(sse, { timeout: CONNECT_TIMEOUT_MS });
    }
    const c = this.client!;
    this.pid = (this.transport as StdioClientTransport).pid ?? undefined;
    this.serverInfo = c.getServerVersion();
    this.capabilities = c.getServerCapabilities();
    this.instructions = c.getInstructions();
  }

  private httpTransport(sse: boolean): McpTransport {
    const headers: Record<string, string> = {};
    for (const kv of this.def.headers ?? []) if (kv.key && kv.value) headers[kv.key] = kv.value;
    const url = new URL(this.def.url!);
    if (sse || url.pathname.endsWith('/sse')) {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: {
          fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as object), ...headers } }),
        },
      });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }

  private wire(client: Client, transport: McpTransport, gen: number): void {
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void this.refresh());
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => void this.refresh());
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void this.refresh());
    client.onerror = (err) => this.log('system', `Transport error: ${err.message}`);
    const prevClose = transport.onclose;
    transport.onclose = () => {
      prevClose?.();
      if (gen !== this.generation || this.stopping || this.status !== 'running') return;
      this.log('system', 'Connection closed unexpectedly');
      this.client = undefined;
      this.transport = undefined;
      this.pid = undefined;
      this.error = 'Server exited';
      this.setStatus('error');
      this.clearCatalog();
      this.scheduleRestart();
    };
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.def.enabled) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.log('system', `Giving up after ${MAX_RESTARTS} restart attempts. Fix the config and restart manually.`);
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** this.restarts++);
    this.log('system', `Restarting in ${Math.round(delay / 1000)}s (attempt ${this.restarts}/${MAX_RESTARTS})`);
    this.restartTimer = setTimeout(() => {
      this.setStatus('stopped');
      void this.start();
    }, delay);
  }

  private async teardown(): Promise<void> {
    clearTimeout(this.stableTimer);
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.pid = undefined;
    this.startedAt = undefined;
    this.clearCatalog();
    try {
      await client?.close();
    } catch {
      /* already closed */
    }
  }

  private clearCatalog(): void {
    const had = this.tools.length + this.prompts.length + this.resources.length + this.resourceTemplates.length;
    this.tools = [];
    this.prompts = [];
    this.resources = [];
    this.resourceTemplates = [];
    if (had) this.emit('catalog');
  }

  private setStatus(status: Status): void {
    if (status === 'running' || status === 'starting' || status === 'stopped') this.error = undefined;
    this.status = status;
    this.emit('status', status);
  }

  log(stream: LogLine['stream'], text: string): void {
    const line: LogLine = { ts: Date.now(), stream, text };
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    this.emit('log', line);
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > MAX_LOG_FILE_BYTES) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
      fs.appendFileSync(this.logFile, `${new Date(line.ts).toISOString()} [${stream}] ${text}\n`);
    } catch {
      /* logging must never crash the daemon */
    }
  }
}

/** Remove pinned arguments from a tool's input schema so clients never try to fill them in. */
function hideArgs(tool: Tool, fixed: Set<string>): Tool {
  const schema = tool.inputSchema;
  if (!schema?.properties || !Object.keys(schema.properties).some((k) => fixed.has(k))) return tool;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !fixed.has(k)));
  const required = schema.required?.filter((k) => !fixed.has(k));
  return { ...tool, inputSchema: { ...schema, properties, ...(required ? { required } : {}) } };
}
