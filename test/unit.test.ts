import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexBlock, removeTomlServer } from '../src/clients/index.js';
import { parseServersJson, toCandidates } from '../src/importer.js';
import { getPreset, loadPresets, renderPreset } from '../src/presets.js';
import { parseJsonc } from '../src/util.js';

test('every preset renders with its defaults and dummy required values', () => {
  for (const p of loadPresets()) {
    const values: Record<string, string> = {};
    for (const f of p.fields) if (f.required && f.default === undefined) values[f.key] = f.type === 'url' ? 'https://x.test' : 'v';
    const def = renderPreset(p, values, { id: p.id });
    if (def.transport === 'stdio') {
      assert.ok(def.command, p.id);
      assert.ok(!def.args!.some((a) => a.includes('{{')), `${p.id} has unrendered args`);
    } else {
      assert.doesNotThrow(() => new URL(def.url!), p.id);
    }
  }
});

test('jira-server preset: secrets flagged, optional fields dropped, booleans rendered', () => {
  const def = renderPreset(getPreset('jira-server')!, { jiraUrl: 'https://jira.corp', personalToken: 'pat', readOnly: true }, { id: 'jira' });
  const env = Object.fromEntries(def.env!.map((kv) => [kv.key, kv]));
  assert.equal(env.JIRA_PERSONAL_TOKEN.secret, true);
  assert.equal(env.JIRA_URL.secret, undefined);
  assert.equal(env.READ_ONLY_MODE.value, 'true');
  assert.equal(env.JIRA_SSL_VERIFY.value, 'true');
  assert.equal(env.JIRA_PROJECTS_FILTER, undefined);
  assert.throws(() => renderPreset(getPreset('jira-server')!, {}, { id: 'x' }), /required/);
});

test('conditional args only appear when the field is set', () => {
  const on = renderPreset(getPreset('github-local')!, { token: 't', readOnly: true }, { id: 'gh' });
  const off = renderPreset(getPreset('github-local')!, { token: 't', readOnly: false }, { id: 'gh' });
  assert.ok(on.args!.join(' ').includes('-e GITHUB_READ_ONLY'));
  assert.ok(!off.args!.join(' ').includes('GITHUB_READ_ONLY'));
  assert.equal(on.args!.at(-1), 'ghcr.io/github/github-mcp-server');
});

test('import parses Claude, VS Code, opencode and bare shapes', () => {
  const claude = parseServersJson({ mcpServers: { Jira: { command: 'uvx', args: ['mcp-atlassian'], env: { JIRA_API_TOKEN: 's', JIRA_URL: 'u' } } } });
  const [c] = toCandidates(claude, new Set());
  assert.equal(c.def!.id, 'jira');
  assert.equal(c.def!.env!.find((e) => e.key === 'JIRA_API_TOKEN')!.secret, true);
  assert.equal(c.def!.env!.find((e) => e.key === 'JIRA_URL')!.secret, undefined);

  const vscode = toCandidates(parseServersJson(parseJsonc('{ // c\n "servers": { "gh": { "type": "http", "url": "https://x/mcp", }, } }')), new Set());
  assert.equal(vscode[0].def!.transport, 'http');

  const oc = toCandidates(parseServersJson({ mcp: { fs: { type: 'local', command: ['npx', '-y', 'pkg'], environment: { A: '1' } } } }), new Set(['fs']));
  assert.equal(oc[0].def!.id, 'fs-2');
  assert.deepEqual(oc[0].def!.args, ['-y', 'pkg']);
});

test('codex TOML editing keeps unrelated content', () => {
  const original = `model = "gpt-5"\n# keep me\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.mcpm]\nurl = "old"\n\n[mcp_servers.mcpm.env]\nA = "1"\n\n[profiles.fast]\nmodel = "y"\n`;
  const out = removeTomlServer(original, 'mcpm');
  assert.ok(!out.includes('old') && !out.includes('A = "1"'));
  assert.ok(out.includes('# keep me') && out.includes('[mcp_servers.other]') && out.includes('[profiles.fast]'));
  assert.match(codexBlock({ name: 'mcpm', url: 'http://127.0.0.1:1/mcp', token: 't' }), /http_headers = \{ "Authorization" = "Bearer t" \}/);
});
