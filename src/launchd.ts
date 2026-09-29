import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loginPath, stableNodePath } from './env.js';
import { CLI_FILE, DATA_DIR, LAUNCHD_LABEL, LAUNCHD_PLIST, LOG_DIR } from './paths.js';

const run = promisify(execFile);
const domain = () => `gui/${os.userInfo().uid}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(nodePath: string, pathEnv: string): string {
  const log = path.join(LOG_DIR, 'daemon.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(CLI_FILE)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>${esc(DATA_DIR)}</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(pathEnv)}</string>
    <key>MCPM_SUPERVISED</key><string>1</string>
  </dict>
</dict>
</plist>
`;
}

export async function serviceStatus(): Promise<{ installed: boolean; running: boolean; pid?: number }> {
  const installed = fs.existsSync(LAUNCHD_PLIST);
  try {
    const { stdout } = await run('launchctl', ['print', `${domain()}/${LAUNCHD_LABEL}`]);
    const pid = /\bpid = (\d+)/.exec(stdout)?.[1];
    return { installed, running: /state = running/.test(stdout), pid: pid ? Number(pid) : undefined };
  } catch {
    return { installed, running: false };
  }
}

export async function installService(): Promise<void> {
  if (!fs.existsSync(CLI_FILE)) throw new Error(`Build first: ${CLI_FILE} not found (run npm run build)`);
  fs.mkdirSync(path.dirname(LAUNCHD_PLIST), { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST, plist(await stableNodePath(), await loginPath()));
  await bootout();
  // launchd sometimes needs a moment after bootout ("Bootstrap failed: 5: Input/output error").
  for (let attempt = 1; ; attempt++) {
    try {
      await run('launchctl', ['bootstrap', domain(), LAUNCHD_PLIST]);
      return;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(1000);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Unload the agent and wait until launchd has really forgotten it. */
async function bootout(): Promise<void> {
  await run('launchctl', ['bootout', `${domain()}/${LAUNCHD_LABEL}`]).catch(() => {});
  for (let i = 0; i < 50; i++) {
    const loaded = await run('launchctl', ['print', `${domain()}/${LAUNCHD_LABEL}`]).then(() => true, () => false);
    if (!loaded) return;
    await sleep(100);
  }
}

export async function uninstallService(): Promise<void> {
  await bootout();
  fs.rmSync(LAUNCHD_PLIST, { force: true });
}

export async function restartService(): Promise<void> {
  await run('launchctl', ['kickstart', '-k', `${domain()}/${LAUNCHD_LABEL}`]);
}
