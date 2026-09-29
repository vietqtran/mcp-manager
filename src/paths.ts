import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const DATA_DIR = process.env.MCP_MANAGER_HOME ?? path.join(HOME, '.mcp-manager');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
/** Stable, space-free launcher for the CLI (used by SSH bridge commands). */
export const SHIM_FILE = path.join(DATA_DIR, 'bin', 'mcp-manager');

/** Package root (the directory containing package.json), for both src/ (tsx) and dist/. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRESETS_FILE = path.join(PACKAGE_ROOT, 'presets', 'catalog.json');
export const CLI_FILE = path.join(PACKAGE_ROOT, 'dist', 'cli.js');

export const DEFAULT_PORT = 7717;
export const LAUNCHD_LABEL = 'io.github.mcp-manager';
export const LAUNCHD_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
