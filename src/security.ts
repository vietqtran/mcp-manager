import os from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import type { Store } from './store.js';
import { safeEqual } from './util.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(addr: string | undefined): boolean {
  return !!addr && LOOPBACK.has(addr);
}

function localNames(store: Store): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const host = os.hostname().toLowerCase();
  names.add(host);
  names.add(host.replace(/\.local$/, '') + '.local');
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) names.add(i.address);
  for (const h of store.settings.hosts) names.add(h);
  return names;
}

function hostnameOf(value: string | undefined): string {
  if (!value) return '';
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1).toLowerCase();
  return value.split(':')[0].toLowerCase();
}

export function extractToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const q = req.query.token;
  return typeof q === 'string' ? q : undefined;
}

/**
 * - A valid bearer token (header or ?token=) always passes.
 * - Without a token, only loopback requests pass, and only when Host/Origin look local.
 *   That blocks DNS-rebinding and cross-site requests from web pages open in a browser.
 * - Static UI files are always served; the UI then asks for the token when needed.
 */
export function guard(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    const isStatic = !req.path.startsWith('/api') && !req.path.startsWith('/mcp');
    if (isStatic) return next();

    const token = extractToken(req);
    if (token && safeEqual(token, store.settings.token)) return next();

    const deny = (status: number, message: string) => res.status(status).json({ error: message });
    if (!isLoopback(req.socket.remoteAddress) || store.settings.requireTokenOnLoopback) {
      return deny(401, 'A valid access token is required (Authorization: Bearer <token>)');
    }
    const names = localNames(store);
    if (!names.has(hostnameOf(req.headers.host))) return deny(403, 'Host not allowed');
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = names.has(new URL(origin).hostname.toLowerCase()) || names.has(`[${new URL(origin).hostname}]`);
      } catch {
        ok = false;
      }
      if (!ok) return deny(403, 'Cross-origin request blocked');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return deny(403, 'Cross-site request blocked');
    next();
  };
}
