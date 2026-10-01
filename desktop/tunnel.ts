// Free Cloudflare "quick tunnel": runs `cloudflared tunnel --url http://127.0.0.1:<port>`, which gives a
// public https://<random>.trycloudflare.com link to the local game server. No account, no port forwarding.
// Used by the desktop app and by `npm run share`. cloudflared is looked up (bundled copy, PATH, usual install
// folders) and, as a last resort, downloaded from Cloudflare's official GitHub releases.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import zlib from 'node:zlib';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const START_TIMEOUT_MS = 45_000;

export const exeName = (platform: string = process.platform) => (platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

/** Release asset name for a Node platform/arch pair. */
export function releaseAsset(platform: string, arch: string): { file: string; tgz: boolean } | null {
  const cpu = ({ x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' } as Record<string, string>)[arch];
  if (!cpu) return null;
  if (platform === 'win32') return { file: `cloudflared-windows-${cpu === 'arm64' ? 'amd64' : cpu}.exe`, tgz: false }; // x64 build runs emulated on ARM
  if (platform === 'darwin' && (cpu === 'amd64' || cpu === 'arm64')) return { file: `cloudflared-darwin-${cpu}.tgz`, tgz: true };
  if (platform === 'linux') return { file: `cloudflared-linux-${cpu}`, tgz: false };
  return null;
}

/** cloudflared on PATH or in the usual install folders (winget, Homebrew, ...). */
export function findSystemCloudflared(): string | null {
  const isWin = process.platform === 'win32';
  const which = spawnSync(isWin ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
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

function get(url: string, hops = 0): Promise<IncomingMessage> {
  return new Promise((ok, fail) => {
    const req = https.get(url, { headers: { 'user-agent': 'pixel-war' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && hops < 8) {
        res.resume();
        return ok(get(new URL(res.headers.location, url).toString(), hops + 1));
      }
      if (code !== 200) { res.resume(); return fail(new Error(`HTTP ${code} for ${url}`)); }
      ok(res);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('download timed out')));
    req.on('error', fail);
  });
}

/** Pull one file out of an (uncompressed) tar archive. */
function untar(buf: Buffer, name: string): Buffer {
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (s: number, n: number) => h.subarray(s, s + n).toString('latin1').replace(/\0[\s\S]*$/, '').trim();
    const prefix = field(345, 155);
    const file = (prefix ? prefix + '/' : '') + field(0, 100);
    const size = parseInt(field(124, 12) || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    if (type === '0' && path.posix.basename(file) === name) return buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} not found in the archive`);
}

/** Download cloudflared for platform/arch into dir; returns the executable's path. */
export async function downloadCloudflared(dir: string, platform: string = process.platform, arch: string = process.arch,
  onProgress?: (fraction: number) => void): Promise<string> {
  const asset = releaseAsset(platform, arch);
  if (!asset) throw new Error(`cloudflared is not available for ${platform}/${arch}`);
  const res = await get(RELEASES + asset.file);
  const total = Number(res.headers['content-length'] ?? 0);
  const parts: Buffer[] = [];
  let got = 0;
  for await (const chunk of res) {
    parts.push(chunk as Buffer);
    got += (chunk as Buffer).length;
    if (total) onProgress?.(got / total);
  }
  let data: Buffer = Buffer.concat(parts);
  if (total && data.length !== total) throw new Error('download was cut off');
  if (asset.tgz) data = untar(zlib.gunzipSync(data), 'cloudflared');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, exeName(platform));
  fs.writeFileSync(out + '.part', data, { mode: 0o755 });
  fs.renameSync(out + '.part', out);
  return out;
}

// Is a new quick-tunnel hostname published yet? Never ask the computer's own DNS (or any normal resolver) too
// early: resolvers remember "not found" for trycloudflare.com names for 60 s, so whoever opens the link next would
// get an error page. The authoritative nameservers hold the real record and cache nothing, so ask them directly.
let nsIps: string[] | null = null;
async function authoritativeLookup(host: string): Promise<string | null> {
  try {
    if (!nsIps) {
      const names = await dns.resolveNs('trycloudflare.com');
      nsIps = (await Promise.all(names.map((n) => dns.resolve4(n).catch(() => [] as string[])))).flat();
    }
    if (!nsIps.length) return null;
    const r = new dns.Resolver({ timeout: 2500, tries: 1 });
    r.setServers(nsIps);
    return (await r.resolve4(host))[0] ?? '';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOTFOUND' || code === 'ENODATA' ? '' : null; // null: can't ask (e.g. DNS port blocked)
  }
}

/** Fallback when the nameservers can't be reached: Cloudflare's public resolver over HTTPS. Returns an IPv4
 *  address, '' if the name doesn't exist yet, or null if 1.1.1.1 can't be reached either. */
async function publicLookup(host: string): Promise<string | null> {
  try {
    const r = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    return j.Answer?.find((a) => a.type === 1)?.data ?? '';
  } catch { return null; }
}

/** GET url, connecting to ip instead of resolving the hostname (TLS still checks the real hostname). */
function httpOk(url: string, ip: string): Promise<boolean> {
  return new Promise((ok) => {
    const lookup = (_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      (o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
    const req = https.get(url, { lookup, timeout: 8000, headers: { 'user-agent': 'pixel-war' } } as https.RequestOptions, (res) => {
      res.resume();
      ok(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => ok(false));
  });
}

export type TunnelStatus = 'off' | 'download' | 'starting' | 'publishing' | 'online' | 'error';
export interface TunnelState {
  status: TunnelStatus;
  url: string;        // https://<random>.trycloudflare.com once known (share it only when online)
  verified: boolean;  // the link answered through Cloudflare
  progress: number;   // 0..1 while downloading cloudflared
  error: string;
}

export interface TunnelOptions {
  /** Paths to try first (e.g. a copy bundled with the app). */
  bundled?: string[];
  /** Where to download cloudflared if it is nowhere to be found (omit to never download). */
  downloadDir?: string;
  log?: (line: string) => void;
}

/** One quick tunnel at a time. Emits 'state' with a TunnelState on every change. */
export class QuickTunnel extends EventEmitter {
  state: TunnelState = { status: 'off', url: '', verified: false, progress: 0, error: '' };
  private opts: TunnelOptions;
  private proc: ChildProcess | null = null;
  private run = 0; // bumps on every start/stop so callbacks of an old run go quiet

  constructor(opts: TunnelOptions = {}) {
    super();
    this.opts = opts;
  }

  get active() { return this.state.status !== 'off' && this.state.status !== 'error'; }

  private set(patch: Partial<TunnelState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  private async binary(run: number): Promise<string> {
    for (const p of this.opts.bundled ?? []) if (p && fs.existsSync(p)) return p;
    const sys = findSystemCloudflared();
    if (sys) return sys;
    const dir = this.opts.downloadDir;
    if (!dir) throw new Error('cloudflared is not installed');
    const local = path.join(dir, exeName());
    if (fs.existsSync(local)) return local;
    this.set({ status: 'download', progress: 0 });
    this.opts.log?.('downloading cloudflared...');
    return downloadCloudflared(dir, process.platform, process.arch, (f) => {
      if (run === this.run && Math.floor(f * 100) !== Math.floor(this.state.progress * 100)) this.set({ progress: f });
    });
  }

  async start(port: number) {
    if (this.active) return;
    const run = ++this.run;
    this.set({ status: 'starting', url: '', verified: false, progress: 0, error: '' });
    let bin: string;
    try { bin = await this.binary(run); }
    catch (e) {
      if (run === this.run) this.fail(`Could not get the Cloudflare tunnel tool (${(e as Error).message}). Check your internet connection.`);
      return;
    }
    if (run !== this.run) return; // stopped while downloading
    this.opts.log?.(`using ${bin}`);
    this.set({ status: 'starting' });
    const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    let lastErr = '';
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.opts.log?.(line);
        if (run !== this.run) continue;
        const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(line);
        if (m && !this.state.url) this.set({ url: m[0] });
        if (/registered tunnel connection/i.test(line) && this.state.url && this.state.status === 'starting') {
          this.set({ status: 'publishing' });
          void this.publish(run);
        }
        if (/\b(ERR|error|failed)\b/i.test(line)) lastErr = line;
      }
    };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', onData);
    p.on('error', (e) => { if (run === this.run) this.fail(`Could not run cloudflared: ${e.message}`); });
    p.on('exit', (code) => { if (run === this.run) this.fail(explain(lastErr, code)); });
    setTimeout(() => {
      if (run === this.run && this.state.status === 'starting') this.fail('Cloudflare did not answer in time. Check your internet connection and try again.');
    }, START_TIMEOUT_MS);
  }

  stop() {
    this.run++;
    this.kill();
    this.set({ status: 'off', url: '', verified: false, progress: 0, error: '' });
  }

  private fail(error: string) {
    this.run++;
    this.kill();
    this.set({ status: 'error', url: '', verified: false, progress: 0, error });
  }

  private kill() {
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null && p.signalCode === null) p.kill();
  }

  /** The tunnel is connected, but Cloudflare can take a while to publish the new hostname in DNS. Anyone who opens
   *  the link before that gets "not found" (and keeps getting it from their DNS cache for a minute), so the link only
   *  counts as online once the name is published. */
  private async publish(run: number) {
    const host = new URL(this.state.url).hostname;
    const t0 = Date.now();
    let authFails = 0, dohFails = 0;
    while (run === this.run) {
      // the nameservers first; if they can't be reached, 1.1.1.1 (asked sparingly, since it caches "not found")
      const useDoh = authFails >= 3;
      const ip = useDoh ? await publicLookup(host) : await authoritativeLookup(host);
      if (run !== this.run) return;
      if (ip) {
        this.opts.log?.(`link published after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        this.set({ status: 'online' });
        return void this.verify(run, ip);
      }
      if (ip === null) { if (useDoh) dohFails++; else authFails++; }
      if (dohFails >= 3 || Date.now() - t0 > 150_000) { // can't tell from here: assume it works
        this.opts.log?.('could not confirm that the link is published');
        return this.set({ status: 'online' });
      }
      await sleep(useDoh ? 6000 : 1500);
    }
  }

  /** Fetch the game through the public link, connecting straight to Cloudflare's address for it. */
  private async verify(run: number, ip: string) {
    for (let i = 0; i < 10 && run === this.run; i++) {
      if (await httpOk(`${this.state.url}/api/health`, ip)) { if (run === this.run) this.set({ verified: true }); return; }
      await sleep(3000);
    }
  }
}

function explain(line: string, code: number | null): string {
  if (/429|too many/i.test(line)) return 'Cloudflare is limiting new links right now. Wait a minute and try again.';
  if (/failed to (request|unmarshal) quick tunnel|no such host|dial tcp|i\/o timeout|network is unreachable/i.test(line)) {
    return 'Could not reach Cloudflare. Check your internet connection and try again.';
  }
  if (/config/i.test(line)) return `cloudflared stopped: ${trimLog(line)}. A cloudflared config file in your user folder (.cloudflared) can block quick tunnels.`;
  return line ? `The tunnel stopped: ${trimLog(line)}` : `The tunnel stopped (exit code ${code}).`;
}

const trimLog = (line: string) => line.replace(/^\S+\s+(ERR|WRN|INF)\s+/, '').slice(0, 200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
