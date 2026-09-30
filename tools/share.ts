// npm run share: start the game server AND a free Cloudflare "quick tunnel", then print a public
// https link your friends can open. No account, no port forwarding, no cost.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { ensureBuilt, isWin } from './common.ts';

const PORT = Number(process.env.PORT ?? 8080);

function findCloudflared(): string | null {
  const which = spawnSync(isWin ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  const cands = isWin
    ? [
        path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
      ]
    : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared', path.join(os.homedir(), '.local/bin/cloudflared')];
  return cands.find((c) => c && fs.existsSync(c)) ?? null;
}

async function install(): Promise<string | null> {
  console.log('\n  cloudflared (the free Cloudflare tunnel client) is not installed.\n');
  if (isWin) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question('  Install it now with winget? [Y/n] ')).trim().toLowerCase();
    rl.close();
    if (ans === '' || ans === 'y' || ans === 'yes') {
      spawnSync('winget', ['install', '--id', 'Cloudflare.cloudflared', '-e'], { stdio: 'inherit' });
      const p = findCloudflared();
      if (p) return p;
      console.log('\n  Installed. Please close this window and run SHARE again (PATH needs a refresh).');
      return null;
    }
    console.log('  Manual install: winget install --id Cloudflare.cloudflared');
  } else if (process.platform === 'darwin') {
    console.log('  Install with:  brew install cloudflared');
  } else {
    console.log('  Install from:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  }
  return null;
}

let tunnel: ChildProcess | null = null;
function cleanup() { if (tunnel && !tunnel.killed) tunnel.kill(); }
process.on('exit', cleanup);

ensureBuilt();
const bin = findCloudflared() ?? (await install());
await import('../server/main.ts');
if (!bin) {
  console.log(`  Server is running locally only: http://localhost:${PORT}\n`);
} else {
  console.log('  Opening a Cloudflare tunnel...');
  tunnel = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let shown = false;
  const scan = (buf: Buffer) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString());
    if (!m || shown) return;
    shown = true;
    const url = m[0];
    const line = '='.repeat(url.length + 8);
    console.log(`\n  ${line}\n     ${url}\n  ${line}`);
    console.log('  Send this link to your friends. Create a room, then share the room code (or invite link).');
    console.log('  The link changes every time you run SHARE. Press Ctrl+C to stop.\n');
    if (isWin) { const c = spawn('clip'); c.stdin.end(url); console.log('  (link copied to your clipboard)\n'); }
  };
  tunnel.stdout!.on('data', scan);
  tunnel.stderr!.on('data', scan);
  tunnel.on('exit', (code) => { if (!shown) console.log(`  cloudflared exited (${code}). Is your internet connection up?`); });
}
