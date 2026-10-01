// Smoke test for the desktop app: launches it with a throwaway data folder, drives the real window over the
// Chrome DevTools protocol and checks the title screen, the hosting panel, room creation and a clean quit.
//
//   node tools/desktop-smoke.ts                 test the development build (run `npm run app` once first)
//   node tools/desktop-smoke.ts --packaged      test the app electron-builder left in release/
//   add --tunnel to also go online through Cloudflare, --shots <dir> to save screenshots

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { ROOT } from './common.ts';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const shots = opt('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });

let failed = 0;
const pass = (m: string) => console.log(`PASS  ${m}`);
const fail = (m: string) => { failed++; console.log(`FAIL  ${m}`); };
const check = (ok: unknown, m: string) => (ok ? pass(m) : fail(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function packagedExe(): string {
  const rel = path.join(ROOT, 'release');
  const cands = process.platform === 'win32' ? ['win-unpacked/PIXEL WAR.exe']
    : process.platform === 'darwin' ? [`mac-${process.arch}/PIXEL WAR.app/Contents/MacOS/PIXEL WAR`, 'mac/PIXEL WAR.app/Contents/MacOS/PIXEL WAR', 'mac-arm64/PIXEL WAR.app/Contents/MacOS/PIXEL WAR']
    : ['linux-unpacked/pixel-war'];
  const f = cands.map((c) => path.join(rel, c)).find((c) => fs.existsSync(c));
  if (!f) throw new Error(`no packaged app found in ${rel} (run npm run dist first)`);
  return f;
}

function freePort(): Promise<number> {
  return new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: any) => void>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => { const m = JSON.parse(String(d)); this.pending.get(m.id)?.(m); this.pending.delete(m.id); });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => { const ws = new WebSocket(url, { perMessageDeflate: false }); ws.once('open', () => ok(new Cdp(ws))); ws.once('error', fail); });
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      this.pending.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : ok(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }
  async shot(name: string) {
    if (!shots) return;
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.data, 'base64'));
  }
  close() { this.ws.close(); }
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelwar-smoke-'));
const dport = await freePort();
const exe = flag('--packaged') ? packagedExe() : (await import('electron')).default as unknown as string;
const exeArgs = [...(flag('--packaged') ? [] : ['.']), `--remote-debugging-port=${dport}`, '--window-size=1280,800'];
console.log(`launching ${path.relative(ROOT, exe) || exe}`);
const app = spawn(exe, exeArgs, { cwd: ROOT, env: { ...process.env, PW_USER_DATA: userData }, stdio: 'ignore' });
let exited: number | null | undefined;
app.on('exit', (code) => { exited = code; });

let cdp: Cdp | null = null;
try {
  // the window first shows a splash page, then the game from the built-in server
  const page = await waitFor('the game page', async () => {
    const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
    return list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
  }, 40_000);
  pass(`game window loaded ${page.url}`);
  cdp = await Cdp.open(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  await waitFor('the title screen', () => cdp!.eval<boolean>(`!!document.querySelector('.titlebox #nm')`), 15_000);
  pass('title screen rendered');
  check(await cdp.eval(`typeof window.pwDesktop === 'object' && typeof window.require === 'undefined' && typeof process === 'undefined'`),
    'desktop bridge present, no Node access in the page');
  const health = await cdp.eval<any>(`fetch('/api/health').then(r => r.json())`);
  check(health?.ok, `built-in server answers (${JSON.stringify(health)})`);
  await waitFor('the hosting panel', () => cdp!.eval<boolean>(`/OFFLINE/.test(document.querySelector('.hostbox')?.textContent ?? '')`), 10_000);
  pass('hosting panel shows OFFLINE');
  const lan = await cdp.eval<string>(`document.querySelector('.hostbox .invlink')?.textContent ?? ''`);
  check(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/$/.test(lan) || lan.startsWith('http://127.0.0.1'), `server link shown: ${lan}`);
  await sleep(600);
  await cdp.shot('1-title');

  let publicUrl = '';
  if (flag('--tunnel')) {
    await cdp.eval(`document.querySelector('.hostbox [data-h=on]').click()`);
    publicUrl = await waitFor('the online link', () => cdp!.eval<string>(
      `document.querySelector('.hostbox .hdot.on') ? document.querySelector('.hostbox .invlink').textContent : ''`), 180_000);
    check(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/$/.test(publicUrl), `went online: ${publicUrl}`);
    const ok = await waitFor('the link check', () => cdp!.eval<boolean>(`/LINK WORKS/.test(document.querySelector('.hostbox').textContent)`), 60_000).catch(() => false);
    check(ok, 'public link answered from the internet');
    await cdp.shot('2-online');
  }

  await cdp.eval(`document.querySelector('[data-a=create]').click()`);
  const code = await waitFor('the room lobby', () => cdp!.eval<string>(`document.querySelector('.roomcode')?.textContent ?? ''`), 10_000);
  pass(`room ${code} created`);
  const link = await cdp.eval<string>(`document.querySelector('[data-invite] .invlink')?.textContent ?? ''`);
  check(link === (publicUrl || link.replace(/\?room=.*$/, '')) + `?room=${code}`, `invite link ${link}`);
  const qr = await cdp.eval<boolean>(`!!document.querySelector('[data-invite] canvas.qr')`);
  check(qr || link.startsWith('http://127.0.0.1'), qr ? 'QR code drawn for the invite link' : 'no network address, so no QR code');
  await sleep(400);
  await cdp.shot('3-room');

  if (publicUrl) {
    // a friend joins the room through the tunnel, the same way a browser would
    const friend = new WebSocket(publicUrl.replace(/^https/, 'wss') + 'ws');
    const joined = await new Promise<boolean>((ok) => {
      const t = setTimeout(() => ok(false), 20_000);
      friend.on('open', () => friend.send(JSON.stringify({ t: 'hello', name: 'Remote friend' })));
      friend.on('message', (d, bin) => {
        if (bin) return;
        const m = JSON.parse(String(d));
        if (m.t === 'welcome') friend.send(JSON.stringify({ t: 'join', code, name: 'Remote friend' }));
        if (m.t === 'lobby' && m.players?.length === 2) { clearTimeout(t); ok(true); }
      });
      friend.on('error', () => ok(false));
    });
    check(joined, 'a remote player joined the room through the public link');
    const seen = await waitFor('the friend in the lobby', () => cdp!.eval<boolean>(`/Remote friend/.test(document.querySelector('.plist')?.textContent ?? '')`), 10_000).catch(() => false);
    check(seen, 'the host sees the remote player in the lobby');
    await cdp.shot('4-room-online');
    friend.close();
    await cdp.eval(`document.querySelector('[data-invite] [data-h=off]').click()`);
    const back = await waitFor('the Wi-Fi link again', () => cdp!.eval<string>(
      `/OFFLINE/.test(document.querySelector('[data-invite]').textContent) ? document.querySelector('[data-invite] .invlink').textContent : ''`), 10_000);
    check(back.startsWith('http://') && back.endsWith(`?room=${code}`), `stopped hosting, invite link back to ${back}`);
  }

  // start the match and open Menu > Invite friends
  await cdp.eval(`document.querySelector('[data-a=start]').click()`);
  await waitFor('the match', () => cdp!.eval<boolean>(`window.pixelwar.screen === 'game'`), 30_000);
  pass('match started');
  await cdp.eval(`window.pixelwar.hud.showMenu(); document.querySelector('[data-o=invite]').click()`);
  const inv = await waitFor('the invite screen', () => cdp!.eval<string>(`document.querySelector('.overlay [data-invite] .invlink')?.textContent ?? ''`), 5000);
  check(inv.endsWith(`?room=${code}`), `in-game invite screen: ${inv}`);
  await sleep(300);
  await cdp.shot('5-ingame-invite');

  // closing the window quits the app (no confirmation needed: nobody else is connected, not online)
  await cdp.eval(`setTimeout(() => window.close(), 50), true`);
  cdp.close();
  cdp = null;
  await waitFor('the app to quit', async () => exited !== undefined, 20_000);
  check(exited === 0, `app quit cleanly (exit code ${exited})`);
  const log = fs.readFileSync(path.join(userData, 'logs', 'pixelwar.log'), 'utf8');
  check(/bye/.test(log), 'server and tunnel shut down in order');
  check(fs.readdirSync(path.join(userData, 'rooms')).some((f) => f.endsWith('.snap')), 'running match saved on quit');
  if (publicUrl) console.log('      ' + (/\[tunnel\] using .*/.exec(log)?.[0] ?? 'cloudflared path not logged'));
} catch (e) {
  fail((e as Error).message);
  const log = path.join(userData, 'logs', 'pixelwar.log');
  if (fs.existsSync(log)) console.log('--- app log ---\n' + fs.readFileSync(log, 'utf8').split('\n').slice(-30).join('\n'));
} finally {
  cdp?.close();
  if (exited === undefined) app.kill();
  await sleep(500);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* still locked on Windows: leave it */ }
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
