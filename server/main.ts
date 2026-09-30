// PIXEL WAR server: static file hosting + WebSocket game server on a single port.
//   PORT (default 8080)   HOST (default 0.0.0.0)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import v8 from 'node:v8';
import crypto from 'node:crypto';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, cleanName, send } from './room.ts';
import { MAP_DIR } from './maps.ts';
import { sanitizeSettings } from '../shared/protocol.ts';
import { HUMAN_COLORS, LIMITS } from '../shared/balance.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist/client');
const DATA = path.join(ROOT, 'server/data/rooms');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const SNAPSHOT_MS = 20_000;
const EMPTY_ROOM_MS = 30 * 60_000;

const rooms = new Map<string, Room>();
const tokenRoom = new Map<string, string>(); // token -> room code

// ---- static files ------------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.gz': 'application/octet-stream', '.webmanifest': 'application/manifest+json',
};
const gzCache = new Map<string, Buffer>();

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback
      const index = path.join(DIST, 'index.html');
      if (file !== index && fs.existsSync(index)) return serveFile(req, res, index);
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(fs.existsSync(DIST) ? 'Not found' : 'Client not built yet. Run "npm start" (it builds automatically) or "npm run build".');
    }
    const ext = path.extname(file);
    const type = MIME[ext] ?? 'application/octet-stream';
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (file.endsWith('.bin.gz')) {
      // pre-compressed map: let the browser inflate it transparently
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = String(st.size);
      res.writeHead(200, headers);
      return fs.createReadStream(file).pipe(res);
    }
    const compressible = /text|javascript|json|svg/.test(type);
    if (compressible && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const key = `${file}:${st.mtimeMs}`;
      let gz = gzCache.get(key);
      if (!gz) { gz = zlib.gzipSync(fs.readFileSync(file)); gzCache.set(key, gz); }
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = String(gz.length);
      res.writeHead(200, headers);
      return res.end(gz);
    }
    headers['content-length'] = String(st.size);
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((a, r) => a + r.connected, 0) }));
  }
  if (p.startsWith('/maps/')) {
    const f = path.join(MAP_DIR, path.basename(p));
    return serveFile(req, res, f);
  }
  const f = path.normalize(path.join(DIST, p === '/' ? 'index.html' : p));
  if (!f.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  serveFile(req, res, f);
});

// ---- websocket ----------------------------------------------------------------------------------
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 16 * 1024,
  perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 }, serverMaxWindowBits: 13, concurrencyLimit: 4 },
});

function newCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}

function createRoom(host: string): Room {
  const r = new Room(newCode(), host);
  rooms.set(r.code, r);
  return r;
}

interface Conn { token: string; ws: WebSocket; alive: boolean; msgs: number; name: string; color: number }
const conns = new Set<Conn>();

wss.on('connection', (ws) => {
  const c: Conn = { token: '', ws, alive: true, msgs: 0, name: 'Commander', color: HUMAN_COLORS[0] };
  conns.add(c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (++c.msgs > 60) return; // hard flood cap per second (reset below)
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try { handle(c, m); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    conns.delete(c);
    const code = tokenRoom.get(c.token);
    const r = code ? rooms.get(code) : null;
    const mem = r?.members.get(c.token);
    if (r && mem && mem.ws === ws) r.detach(mem);
  });
});

// flood counter reset
setInterval(() => { for (const c of conns) c.msgs = 0; }, 1000);

function handle(c: Conn, m: any) {
  switch (m.t) {
    case 'hello': {
      let token = typeof m.token === 'string' && /^[a-f0-9-]{36}$/.test(m.token) ? m.token : '';
      if (!token) token = crypto.randomUUID();
      c.token = token;
      if (typeof m.name === 'string') c.name = cleanName(m.name);
      if (typeof m.color === 'number' && HUMAN_COLORS.includes(m.color)) c.color = m.color;
      send(c.ws, { t: 'welcome', token });
      // reconnect to an existing room
      const code = tokenRoom.get(token);
      const r = code ? rooms.get(code) : null;
      const mem = r?.members.get(token);
      if (r && mem) r.attach(mem, c.ws);
      return;
    }
    case 'create': {
      if (!c.token) return;
      if (rooms.size >= LIMITS.maxRooms * 4) return send(c.ws, { t: 'error', msg: 'Server is full' });
      leaveCurrent(c);
      const r = createRoom(c.token);
      if (m.settings) r.settings = sanitizeSettings(m.settings);
      joinRoom(c, r, m);
      if (m.startNow) {
        const e = r.start(c.token);
        if (e) send(c.ws, { t: 'error', msg: e });
      }
      return;
    }
    case 'join': {
      if (!c.token) return;
      const code = String(m.code ?? '').toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) return send(c.ws, { t: 'error', msg: `Room ${code} not found` });
      if (tokenRoom.get(c.token) !== code) leaveCurrent(c);
      joinRoom(c, r, m);
      return;
    }
    case 'leave': leaveCurrent(c); send(c.ws, { t: 'left' }); return;
    case 'rooms': {
      const list = [...rooms.values()].filter((r) => r.state === 'lobby' || r.game?.s.phase === 'spawn')
        .map((r) => ({ code: r.code, players: r.members.size, state: r.state, map: r.settings.mapSize, ai: r.settings.aiCount }));
      return send(c.ws, { t: 'rooms', list });
    }
  }
  const code = tokenRoom.get(c.token);
  const r = code ? rooms.get(code) : null;
  if (!r) return;
  switch (m.t) {
    case 'me': r.updateMember(c.token, m); return;
    case 'settings': r.setSettings(c.token, m.settings ?? {}); return;
    case 'start': { const e = r.start(c.token); if (e) send(c.ws, { t: 'error', msg: e }); return; }
    case 'lobbyReturn': r.backToLobby(c.token); return;
    case 'i': r.intent(c.token, m); return;
  }
}

function joinRoom(c: Conn, r: Room, m: any) {
  const name = cleanName(m.name ?? c.name);
  const color = typeof m.color === 'number' && HUMAN_COLORS.includes(m.color) ? m.color : c.color;
  const res = r.addMember(c.token, name, color, c.ws);
  if (typeof res === 'string') return send(c.ws, { t: 'error', msg: res });
  tokenRoom.set(c.token, r.code);
}

function leaveCurrent(c: Conn) {
  const code = tokenRoom.get(c.token);
  if (!code) return;
  tokenRoom.delete(c.token);
  const r = rooms.get(code);
  if (r) r.leave(c.token);
}

// ---- heartbeat & housekeeping ----------------------------------------------------------------------
const hb = setInterval(() => {
  for (const c of conns) {
    if (c.ws.readyState > 1) { conns.delete(c); continue; }
    if (!c.alive) { c.ws.terminate(); conns.delete(c); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* ignore */ }
  }
  const now = Date.now();
  for (const [code, r] of rooms) {
    const empty = r.connected === 0;
    const lobbyEmpty = r.state === 'lobby' && empty && now - r.emptySince > 5 * 60_000;
    const gameEmpty = empty && r.emptySince && now - r.emptySince > EMPTY_ROOM_MS;
    const finished = r.game?.s.phase === 'ended' && empty;
    if (lobbyEmpty || gameEmpty || finished) {
      r.dispose();
      rooms.delete(code);
      for (const [t, rc] of tokenRoom) if (rc === code) tokenRoom.delete(t);
      fs.rm(path.join(DATA, `${code}.snap`), { force: true }, () => {});
      console.log(`room ${code} closed`);
    }
  }
}, 15_000);

// ---- persistence ---------------------------------------------------------------------------------
fs.mkdirSync(DATA, { recursive: true });
let saving = false;
async function saveAll() {
  if (saving) return;
  saving = true;
  try {
    for (const r of rooms.values()) {
      const snap = r.snapshot();
      if (!snap) continue;
      const buf = v8.serialize(snap);
      const gz = await new Promise<Buffer>((ok, fail) => zlib.gzip(buf, { level: 1 }, (e, b) => (e ? fail(e) : ok(b))));
      const file = path.join(DATA, `${r.code}.snap`);
      await fs.promises.writeFile(file + '.tmp', gz);
      await fs.promises.rename(file + '.tmp', file);
    }
  } catch (e) { console.error('snapshot failed', e); }
  saving = false;
}
const saver = setInterval(saveAll, SNAPSHOT_MS);

function restoreAll() {
  for (const f of fs.readdirSync(DATA)) {
    if (!f.endsWith('.snap')) continue;
    const file = path.join(DATA, f);
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs > 6 * 3600_000) { fs.rmSync(file); continue; }
      const snap = v8.deserialize(zlib.gunzipSync(fs.readFileSync(file)));
      const r = new Room(snap.code, snap.host);
      r.restore(snap.state, snap.members);
      rooms.set(r.code, r);
      for (const m of snap.members) tokenRoom.set(m.token, r.code);
      console.log(`restored room ${r.code} (tick ${snap.state.tick}, ${snap.members.length} players)`);
    } catch (e) {
      console.error(`could not restore ${f}:`, (e as Error).message);
    }
  }
}
restoreAll();

async function shutdown() {
  console.log('\nsaving rooms...');
  clearInterval(saver);
  clearInterval(hb);
  await saveAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
  console.log(`\n  PIXEL WAR server running`);
  console.log(`  local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  network: http://${ip}:${PORT}`);
  console.log('');
  if (process.env.PW_OPEN) {
    const url = `http://localhost:${PORT}`;
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    import('node:child_process').then(({ spawn }) => spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).unref()).catch(() => {});
  }
});
