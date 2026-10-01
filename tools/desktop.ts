// Desktop app build. Bundles the Electron main process, preload script and game server with esbuild, fetches
// cloudflared (the Cloudflare tunnel client) for each target, and packages installers with electron-builder.
//
//   npm run app                      build and start the desktop app (development)
//   npm run dist                     installer for this computer's OS, into release/
//   npm run dist -- --win | --mac | --linux  [--x64] [--arm64]
//
// Windows builds an NSIS installer (.exe), macOS a .dmg per architecture. A Mac installer has to be built on a
// Mac (see .github/workflows/desktop.yml for building both in the cloud).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { build, type BuildOptions } from 'esbuild';
import { ROOT, ensureBuilt } from './common.ts';
import { downloadCloudflared, exeName } from '../desktop/tunnel.ts';

type OsKey = 'win' | 'mac' | 'linux';
const NODE_PLATFORM: Record<OsKey, string> = { win: 'win32', mac: 'darwin', linux: 'linux' };
const HOST_OS: OsKey = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

async function bundle() {
  ensureBuilt(); // game client + maps -> dist/client
  const common: BuildOptions = {
    absWorkingDir: ROOT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
    legalComments: 'none',
    define: { 'import.meta.dirname': '__dirname' },
  };
  await Promise.all([
    build({ ...common, entryPoints: ['desktop/main.ts'], outfile: 'dist/desktop/main.cjs', external: ['electron'] }),
    build({ ...common, entryPoints: ['desktop/preload.ts'], outfile: 'dist/desktop/preload.cjs', external: ['electron'] }),
    build({ ...common, entryPoints: ['desktop/server-entry.ts'], outfile: 'dist/desktop/server.cjs', external: ['bufferutil', 'utf-8-validate'] }),
  ]);
  console.log('Desktop bundles ready in dist/desktop');
}

/** Put cloudflared for each target into dist/vendor/cloudflared/<os>-<arch>/ (bundled into the installer). */
async function vendorCloudflared(os: OsKey, archs: string[]) {
  for (const arch of archs) {
    const dir = path.join(ROOT, 'dist/vendor/cloudflared', `${os}-${arch}`);
    const file = path.join(dir, exeName(NODE_PLATFORM[os]));
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 7 * 86400_000) continue;
    process.stdout.write(`Downloading cloudflared for ${os}-${arch}... `);
    await downloadCloudflared(dir, NODE_PLATFORM[os], arch);
    console.log(`${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  }
}

const args = process.argv.slice(2);
const cmd = args[0] ?? 'run';

if (cmd === 'run') {
  await bundle();
  const electron = (await import('electron')).default as unknown as string;
  const child = spawn(electron, ['.', ...args.slice(1)], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else if (cmd === 'bundle') {
  await bundle();
} else if (cmd === 'dist') {
  const os = (['win', 'mac', 'linux'] as OsKey[]).find((o) => args.includes(`--${o}`)) ?? HOST_OS;
  let archs = ['x64', 'arm64'].filter((a) => args.includes(`--${a}`));
  if (!archs.length) archs = os === 'mac' ? ['arm64', 'x64'] : ['x64'];
  if (os === 'mac' && HOST_OS !== 'mac') {
    console.error('A macOS installer can only be built on a Mac. Use the GitHub workflow (.github/workflows/desktop.yml) or run this on a Mac.');
    process.exit(1);
  }
  await bundle();
  await vendorCloudflared(os, archs);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/electron-builder/cli.js'), `--${os}`, ...archs.map((a) => `--${a}`), '--publish', 'never'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log('\nInstallers:');
  for (const f of fs.readdirSync(path.join(ROOT, 'release'))) if (/\.(exe|dmg|AppImage)$/.test(f)) console.log('  release/' + f);
} else {
  console.error(`Unknown command "${cmd}". Use: run | bundle | dist [--win|--mac|--linux] [--x64|--arm64]`);
  process.exit(1);
}
