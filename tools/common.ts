// Shared helpers for the launcher scripts.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const isWin = process.platform === 'win32';

function newest(p: string): number {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = st.mtimeMs;
  for (const f of fs.readdirSync(p)) m = Math.max(m, newest(path.join(p, f)));
  return m;
}

/** Build the client bundle if it is missing or older than its sources. */
export function ensureBuilt() {
  const out = path.join(ROOT, 'dist/client/index.html');
  const src = Math.max(newest(path.join(ROOT, 'client/src')), newest(path.join(ROOT, 'client/index.html')), newest(path.join(ROOT, 'shared')));
  if (!fs.existsSync(path.join(ROOT, 'client/public/maps/world-1024.bin.gz'))) {
    console.log('Generating world maps (first run, downloads Natural Earth data)...');
    const r = spawnSync(process.execPath, ['tools/mapgen/mapgen.ts'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) process.exit(1);
  }
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src) return;
  console.log('Building the game client...');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('Client build failed.'); process.exit(1); }
}
