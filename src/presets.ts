import fs from 'node:fs';
import { DATA_DIR, PRESETS_FILE } from './paths.js';
import type { KV, ServerDef } from './types.js';

export interface PresetField {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'url' | 'path' | 'boolean' | 'select' | 'number';
  required?: boolean;
  default?: string | boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
}

export type PresetArg = string | { when: string; args: string[] };

export interface Preset {
  id: string;
  name: string;
  provider: string;
  category: string;
  description: string;
  homepage: string;
  runtime: 'node' | 'python' | 'docker' | 'remote';
  transport: 'stdio' | 'http';
  command?: string;
  args?: PresetArg[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  fields: PresetField[];
  notes?: string;
  verifiedSource?: string;
}

export type PresetValues = Record<string, string | boolean | undefined>;

let cache: Preset[] | undefined;

export function loadPresets(): Preset[] {
  cache ??= (JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) as { presets: Preset[] }).presets;
  return cache;
}

export function getPreset(id: string): Preset | undefined {
  return loadPresets().find((p) => p.id === id);
}

/** {{field}} = user value; {{$dataDir}} / {{$id}} = built-ins; {{...field}} (whole arg) = split into several args. */
const PLACEHOLDER = /\{\{(\$?\w+)\}\}/g;
const SPREAD = /^\{\{\.\.\.(\w+)\}\}$/;

/** Turn a preset + user-entered values into a concrete server definition. */
export function renderPreset(
  preset: Preset,
  input: PresetValues,
  meta: { id: string; name?: string },
): ServerDef {
  const values: PresetValues = { $dataDir: DATA_DIR, $id: meta.id };
  for (const f of preset.fields) {
    const v = input[f.key] ?? f.default;
    values[f.key] = typeof v === 'string' ? v.trim() : v;
    if (f.required && (v === undefined || v === '')) throw new Error(`"${f.label}" is required`);
  }
  const fmt = (v: string | boolean | undefined) => (v === undefined ? '' : String(v));
  const fill = (tpl: string) => tpl.replace(PLACEHOLDER, (_, k: string) => fmt(values[k]));
  const truthy = (k: string) => values[k] !== undefined && values[k] !== '' && values[k] !== false;
  const secretKeys = new Set(preset.fields.filter((f) => f.type === 'secret').map((f) => f.key));
  const isSecretTpl = (tpl: string) => [...tpl.matchAll(PLACEHOLDER)].some((m) => secretKeys.has(m[1]));
  // A template that only references empty fields is dropped entirely.
  const refsEmpty = (tpl: string) => {
    const refs = [...tpl.matchAll(PLACEHOLDER)].map((m) => m[1]);
    return refs.length > 0 && refs.every((k) => fmt(values[k]) === '');
  };
  const expand = (tpl: string): string[] => {
    const spread = SPREAD.exec(tpl);
    if (spread) return fmt(values[spread[1]]).split(/[\s,]+/).filter(Boolean);
    return refsEmpty(tpl) ? [] : [fill(tpl)];
  };

  const args: string[] = [];
  for (const a of preset.args ?? []) {
    if (typeof a === 'string') args.push(...expand(a));
    else if (truthy(a.when)) args.push(...a.args.flatMap((x) => (SPREAD.test(x) ? expand(x) : [fill(x)])));
  }
  const kvs = (map: Record<string, string> | undefined): KV[] =>
    Object.entries(map ?? {})
      .filter(([, tpl]) => !refsEmpty(tpl))
      .map(([key, tpl]) => ({ key, value: fill(tpl), ...(isSecretTpl(tpl) ? { secret: true } : {}) }));

  const now = new Date().toISOString();
  return {
    id: meta.id,
    name: meta.name?.trim() || preset.name,
    description: preset.description,
    enabled: true,
    transport: preset.transport,
    ...(preset.transport === 'stdio'
      ? { command: preset.command, args, env: kvs(preset.env) }
      : { url: fill(preset.url ?? ''), headers: kvs(preset.headers) }),
    presetId: preset.id,
    createdAt: now,
    updatedAt: now,
  };
}
