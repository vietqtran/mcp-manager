import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.js';

const FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.docker', 'bin'),
  path.join(HOME, '.cargo', 'bin'),
  path.join(HOME, '.bun', 'bin'),
  path.join(HOME, '.volta', 'bin'),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

let cached: string | undefined;

/**
 * launchd and non-interactive SSH sessions start with a minimal PATH, so `npx`/`uvx`/`docker`
 * would not be found. Ask the user's login shell for its PATH once and merge common locations.
 */
export async function loginPath(): Promise<string> {
  if (cached) return cached;
  const shell = process.env.SHELL || '/bin/zsh';
  const fromShell = await new Promise<string>((resolve) => {
    execFile(
      shell,
      ['-l', '-i', '-c', 'printf "__MCPM__%s__MCPM__" "$PATH"'],
      { timeout: 8000, env: { ...process.env, TERM: 'dumb' } },
      (_err, stdout) => resolve(/__MCPM__(.*)__MCPM__/.exec(stdout ?? '')?.[1] ?? ''),
    );
  });
  const parts = [...fromShell.split(':'), ...(process.env.PATH ?? '').split(':'), ...FALLBACK_DIRS];
  cached = [...new Set(parts.filter(Boolean))].join(':');
  return cached;
}

/** Resolve a command name to an absolute path using the login PATH. */
export async function which(cmd: string): Promise<string | undefined> {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : undefined;
  for (const dir of (await loginPath()).split(':')) {
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export async function runtimeAvailability(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const cmd of ['node', 'npx', 'uvx', 'docker']) out[cmd] = (await which(cmd)) ?? null;
  return out;
}

let nodePath: string | undefined;

/**
 * Node binary to reference in generated files (launchd plist, shim, client configs).
 * process.execPath is the resolved Cellar path, which disappears after `brew upgrade node`;
 * prefer the stable symlink from PATH (e.g. /opt/homebrew/bin/node).
 */
export async function stableNodePath(): Promise<string> {
  if (nodePath) return nodePath;
  const found = await which('node');
  nodePath = found && fs.realpathSync(found) === fs.realpathSync(process.execPath) ? found : process.execPath;
  return nodePath;
}

export function cachedNodePath(): string {
  return nodePath ?? process.execPath;
}
