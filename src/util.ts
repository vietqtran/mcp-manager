import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function writeFileAtomic(file: string, data: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

export function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return parseJsonc(fs.readFileSync(file, 'utf8')) as T;
}

/** Parse JSON that may contain comments and trailing commas (VS Code style). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function backupFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.mcpm-backup-${stamp}`;
  fs.copyFileSync(file, backup);
  return backup;
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'server'
  );
}

export const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const SECRET_KEY_RE = /(token|secret|password|passwd|pass|key|auth|credential|cookie|pat)\b|_(token|key|secret|pass)/i;
export function looksSecret(key: string): boolean {
  return SECRET_KEY_RE.test(key) || /^authorization$/i.test(key);
}
