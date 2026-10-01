// npm run share: start the game server AND a free Cloudflare "quick tunnel", then print a public
// https link your friends can open. No account, no port forwarding, no cost. If cloudflared is not
// installed, it is downloaded once into dist/vendor/.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, ensureBuilt, isWin } from './common.ts';
import { QuickTunnel, exeName } from '../desktop/tunnel.ts';

const PORT = Number(process.env.PORT ?? 8080);
const osKey = isWin ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const vendor = path.join(ROOT, 'dist/vendor/cloudflared', `${osKey}-${process.arch}`);

ensureBuilt();
await import('../server/main.ts');

const tunnel = new QuickTunnel({ bundled: [path.join(vendor, exeName())], downloadDir: vendor });
process.on('exit', () => tunnel.stop());
let last = '';
tunnel.on('state', (s) => {
  if (s.status === last && !s.verified) return;
  last = s.status;
  if (s.status === 'download') console.log('  Downloading cloudflared (the free Cloudflare tunnel client, one time only)...');
  else if (s.status === 'publishing') console.log('  Connected. Waiting for Cloudflare to publish the link (up to a minute)...');
  else if (s.status === 'online' && !s.verified) {
    const line = '='.repeat(s.url.length + 8);
    console.log(`\n  ${line}\n     ${s.url}\n  ${line}`);
    console.log('  Send this link to your friends. Create a room, then share the room code (or invite link).');
    console.log('  The link changes every time you run SHARE. Press Ctrl+C to stop.\n');
    if (isWin) { const c = spawn('clip'); c.stdin.end(s.url); console.log('  (link copied to your clipboard)\n'); }
  } else if (s.verified) console.log('  Link checked: it works from the internet.\n');
  else if (s.status === 'error') console.log(`  ${s.error}\n  The game still runs locally: http://localhost:${PORT}\n`);
});
console.log('  Opening a Cloudflare tunnel...');
void tunnel.start(PORT);
