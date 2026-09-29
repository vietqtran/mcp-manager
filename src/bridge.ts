import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  isInitializeRequest,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * stdio <-> Streamable HTTP bridge to the hub. Lets stdio-only clients (Claude Desktop) and remote
 * machines (`ssh mac mcp-manager bridge`) use the shared servers. Survives engine restarts by
 * replaying the initialize handshake when the hub reports an unknown session.
 */
export async function runBridge(opts: { url: string; token?: string }): Promise<void> {
  const log = (msg: string) => process.stderr.write(`[mcp-manager bridge] ${msg}\n`);
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const stdio = new StdioServerTransport();
  let http!: StreamableHTTPClientTransport;
  let initRequest: JSONRPCRequest | undefined;
  let replay: { id: string; done: () => void } | undefined;
  let closing = false;

  const connect = async () => {
    http = new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers } });
    http.onmessage = (msg) => {
      if (replay && 'id' in msg && msg.id === replay.id) return replay.done();
      void stdio.send(msg).catch((err) => log(`stdout write failed: ${err}`));
    };
    http.onerror = (err) => log(err.message);
    await http.start();
  };

  const resume = async () => {
    log('hub session expired (engine restarted?); re-initializing');
    const old = http;
    await connect();
    await old.close().catch(() => {});
    const id = `mcpm-replay-${Date.now()}`;
    const answered = new Promise<void>((done) => (replay = { id, done }));
    await http.send({ ...initRequest!, id });
    await answered;
    replay = undefined;
    await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  };

  const forward = async (msg: JSONRPCMessage) => {
    if (isInitializeRequest(msg)) initRequest = msg as JSONRPCRequest;
    try {
      await http.send(msg);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 404 && initRequest && !isInitializeRequest(msg)) {
        await resume();
        await http.send(msg);
        return;
      }
      throw err;
    }
  };

  stdio.onmessage = (msg) => {
    forward(msg).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`request failed: ${message}`);
      if (isJSONRPCRequest(msg)) {
        void stdio.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `mcp-manager hub unreachable at ${opts.url}: ${message}` },
        });
      }
    });
  };
  stdio.onclose = () => {
    if (closing) return;
    closing = true;
    void http.close().finally(() => process.exit(0));
  };

  await connect();
  await stdio.start();
  process.stdin.on('end', () => stdio.onclose?.());
}
