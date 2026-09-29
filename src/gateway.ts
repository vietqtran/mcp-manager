import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Hub } from './hub.js';

const VERSION = '0.1.0';
/** Sessions without an open notification stream are dropped after this much inactivity. */
const SESSION_IDLE_MS = 10 * 60_000;

interface Session {
  id?: string;
  scope: string | null;
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  client?: string;
  /** Open GET (server->client notification) streams; >0 means the client is still attached. */
  streams: number;
}

/**
 * Downstream side: exposes the hub over Streamable HTTP.
 *   /mcp        every enabled server, names prefixed "<id>__"
 *   /mcp/<id>   a single server, original names
 */
export class Gateway {
  sessions = new Map<string, Session>();

  constructor(private hub: Hub) {
    hub.on('catalog', (id: string) => this.notify(id));
    setInterval(() => this.reap(), 60_000).unref();
  }

  mount(app: Express): void {
    const json = express.json({ limit: '50mb' });
    app.all('/mcp', json, (req, res) => void this.handle(req, res, null));
    app.all('/mcp/:id', json, (req, res) => void this.handle(req, res, String(req.params.id)));
  }

  stats() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      scope: s.scope ?? '*',
      client: s.client,
      lastSeen: s.lastSeen,
      attached: s.streams > 0,
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.transport.close().catch(() => {})));
    this.sessions.clear();
  }

  private async handle(req: Request, res: Response, scope: string | null): Promise<void> {
    try {
      const sid = req.headers['mcp-session-id'];
      let session = typeof sid === 'string' ? this.sessions.get(sid) : undefined;
      if (typeof sid === 'string' && !session) {
        return rpcError(res, 404, ErrorCode.ConnectionClosed, 'Session not found; please re-initialize');
      }
      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          return rpcError(res, 400, ErrorCode.InvalidRequest, 'Missing mcp-session-id header; send initialize first');
        }
        if (scope && !this.hub.get(scope)) {
          return rpcError(res, 404, ErrorCode.InvalidRequest, `Unknown server "${scope}"`);
        }
        session = await this.createSession(scope);
        session.client = `${req.body.params?.clientInfo?.name ?? 'unknown'} ${req.body.params?.clientInfo?.version ?? ''}`.trim();
      }
      session.lastSeen = Date.now();
      if (req.method === 'GET') {
        const s = session;
        s.streams++;
        res.on('close', () => {
          s.streams--;
          s.lastSeen = Date.now();
        });
      }
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) rpcError(res, 500, ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
    }
  }

  private async createSession(scope: string | null): Promise<Session> {
    const hub = this.hub;
    const server = new Server(
      { name: scope ? `mcp-manager/${scope}` : 'mcp-manager', version: VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { listChanged: true },
        },
        instructions: hub.instructions(scope),
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: hub.tools(scope) }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const target = hub.resolve(scope, req.params.name);
      if (!target || !target.up.activeTools.some((t) => t.name === target.name)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
      }
      return target.up.callTool(target.name, req.params.arguments, { signal: extra.signal });
    });
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: hub.prompts(scope) }));
    server.setRequestHandler(GetPromptRequestSchema, async (req, extra) => {
      const target = hub.resolve(scope, req.params.name);
      if (!target) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${req.params.name}`);
      return target.up.getPrompt(target.name, req.params.arguments, { signal: extra.signal });
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: hub.resources(scope) }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: hub.resourceTemplates(scope),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
      let lastErr: unknown;
      for (const up of hub.resourceOwners(scope, req.params.uri)) {
        try {
          return await up.readResource(req.params.uri, { signal: extra.signal });
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr ?? new McpError(ErrorCode.InvalidParams, `Unknown resource: ${req.params.uri}`);
    });

    const session: Session = { scope, server, lastSeen: Date.now(), streams: 0, transport: undefined! };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        this.sessions.set(id, session);
      },
      onsessionclosed: (id) => void this.sessions.delete(id),
    });
    session.transport.onclose = () => {
      if (session.id) this.sessions.delete(session.id);
    };
    await server.connect(session.transport);
    return session;
  }

  private pending = new Set<Session>();
  private notifyTimer?: NodeJS.Timeout;

  /** Tell connected clients that the catalog changed so they refresh without restarting (debounced). */
  private notify(id: string): void {
    for (const s of this.sessions.values()) if (s.scope === null || s.scope === id) this.pending.add(s);
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      for (const s of this.pending) {
        s.server.sendToolListChanged().catch(() => {});
        s.server.sendPromptListChanged().catch(() => {});
        s.server.sendResourceListChanged().catch(() => {});
      }
      this.pending.clear();
    }, 300);
  }

  private reap(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const s of this.sessions.values()) {
      if (s.streams === 0 && s.lastSeen < cutoff) void s.transport.close().catch(() => {});
    }
  }
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}
