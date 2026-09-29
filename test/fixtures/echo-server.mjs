// Minimal stdio MCP server used by the integration tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' }, { instructions: 'Echo fixture server.' });
server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo:${text}:${process.env.ECHO_PREFIX ?? ''}:pid=${process.pid}` }],
}));
server.registerTool('add', { description: 'Add numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}));
server.registerPrompt('greet', { description: 'Greeting', argsSchema: { name: z.string() } }, ({ name }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }],
}));
console.error('echo fixture started');
await server.connect(new StdioServerTransport());
