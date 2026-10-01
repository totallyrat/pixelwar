// A room: lobby membership, the running Game, the fixed-rate tick loop and per-client broadcasting.

import type { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { Game } from './sim/game.ts';
import type { State, Player } from './sim/types.ts';
import { loadMap } from './maps.ts';
import { computeVision } from './sim/vision.ts';
import { bpack } from './sim/buildings.ts';
import { fpack } from './sim/units.ts';
import { effTroops } from './sim/combat.ts';
import { opsFor } from './sim/ops.ts';
import {
  MSG, Writer, rleEncode, encodeTileChanges, sanitizeSettings, DEFAULT_SETTINGS, type MatchSettings,
} from '../shared/protocol.ts';
import { TICK_MS, TICK_RATE, LIMITS, HUMAN_COLORS, VISION, U, LIMITS as L } from '../shared/balance.ts';

export interface Member {
  token: string;
  name: string;
  color: number;
  team: number;
  ws: WebSocket | null;
  pid: number;
  lastSeen: number;
  // per-connection sync state
  lastVis: Uint8Array | null;
  needInit: boolean;
  bucket: number;
}

const stripKeys = (k: string, v: unknown) => (k.length && k[0] === '_' ? undefined : v);

export class Room {
  readonly code: string;
  settings: MatchSettings;
  host: string;
  members = new Map<string, Member>();
  game: Game | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextTick = 0;
  private tw = new Writer(1 << 16);
  private w = new Writer(1 << 16);
  emptySince = Date.now();
  onChange: () => void = () => {};

  constructor(code: string, host: string, settings?: MatchSettings) {
    this.code = code;
    this.host = host;
    this.settings = settings ?? { ...DEFAULT_SETTINGS };
  }

  get state(): 'lobby' | 'game' { return this.game ? 'game' : 'lobby'; }
  get connected(): number { let n = 0; for (const m of this.members.values()) if (m.ws) n++; return n; }

  // ---- lobby ---------------------------------------------------------------------------------
  addMember(token: string, name: string, color: number, ws: WebSocket): Member | string {
    let m = this.members.get(token);
    if (!m) {
      if (this.members.size >= LIMITS.maxHumans) return 'Room is full (20 players)';
      const used = new Set([...this.members.values()].map((x) => x.color));
      if (used.has(color)) color = HUMAN_COLORS.find((c) => !used.has(c)) ?? color;
      m = { token, name, color, team: 0, ws: null, pid: 0, lastSeen: Date.now(), lastVis: null, needInit: true, bucket: LIMITS.intentsPerSecond };
      this.members.set(token, m);
      if (this.game && this.game.s.phase !== 'ended') {
        const p = this.game.addHuman(name, color, 0, token);
        m.pid = p.id;
      }
    }
    this.attach(m, ws);
    return m;
  }

  attach(m: Member, ws: WebSocket) {
    if (m.ws && m.ws !== ws) try { m.ws.close(4000, 'replaced'); } catch { /* ignore */ }
    m.ws = ws;
    m.lastSeen = Date.now();
    m.lastVis = null;
    m.needInit = true;
    this.emptySince = 0;
    this.sendLobby();
    if (this.game) this.sendInit(m);
    if (!this.timer && this.game) this.startLoop();
  }

  detach(m: Member) {
    m.ws = null;
    m.lastSeen = Date.now();
    if (this.connected === 0) this.emptySince = Date.now();
    this.sendLobby();
  }

  leave(token: string) {
    const m = this.members.get(token);
    if (!m) return;
    if (!this.game) this.members.delete(token);
    else m.ws = null;
    if (this.host === token) {
      const next = [...this.members.values()].find((x) => x.ws);
      if (next) this.host = next.token;
    }
    if (this.connected === 0) this.emptySince = Date.now();
    this.sendLobby();
  }

  updateMember(token: string, d: any) {
    const m = this.members.get(token);
    if (!m) return;
    if (typeof d.name === 'string') m.name = cleanName(d.name);
    if (typeof d.color === 'number' && HUMAN_COLORS.includes(d.color)) m.color = d.color;
    if (typeof d.team === 'number') m.team = Math.max(0, Math.min(4, Math.floor(d.team)));
    this.sendLobby();
  }

  setSettings(token: string, s: Partial<MatchSettings>) {
    if (token !== this.host || this.game) return;
    this.settings = sanitizeSettings(s, this.settings);
    this.sendLobby();
  }

  lobbyInfo() {
    return {
      t: 'lobby', code: this.code, host: pubId(this.host), state: this.state, settings: this.settings,
      phase: this.game?.s.phase ?? null,
      players: [...this.members.values()].map((m) => ({ id: pubId(m.token), name: m.name, color: m.color, team: m.team, host: m.token === this.host, on: !!m.ws, pid: m.pid })),
    };
  }
  sendLobby() {
    const base = this.lobbyInfo();
    for (const m of this.members.values()) {
      if (!m.ws) continue;
      send(m.ws, { ...base, you: pubId(m.token) });
    }
    this.onChange();
  }

  // ---- match lifecycle ---------------------------------------------------------------------
  start(token: string): string | null {
    if (token !== this.host) return 'Only the host can start';
    if (this.game && this.game.s.phase !== 'ended') return 'Already running';
    const map = loadMap(this.settings.mapSize);
    const seed = (Math.random() * 2 ** 31) | 0;
    this.game = new Game(map, this.settings, seed);
    for (const m of this.members.values()) {
      m.pid = this.game.addHuman(m.name, m.color, m.team, m.token).id;
      m.needInit = true;
      m.lastVis = null;
    }
    computeVision(this.game);
    for (const m of this.members.values()) if (m.ws) this.sendInit(m);
    this.sendLobby();
    this.startLoop();
    return null;
  }

  backToLobby(token: string) {
    if (token !== this.host || !this.game || this.game.s.phase !== 'ended') return;
    this.stopLoop();
    this.game = null;
    for (const m of this.members.values()) m.pid = 0;
    // drop members that left during the match
    for (const [t, m] of this.members) if (!m.ws) this.members.delete(t);
    this.sendLobby();
  }

  restore(state: State, members: { token: string; name: string; color: number; team: number; pid: number }[]) {
    const map = loadMap(state.settings.mapSize);
    this.settings = state.settings;
    this.game = new Game(map, state.settings, state.seed, state);
    for (const x of members) {
      this.members.set(x.token, { ...x, ws: null, lastSeen: Date.now(), lastVis: null, needInit: true, bucket: LIMITS.intentsPerSecond });
    }
    computeVision(this.game);
    this.emptySince = Date.now();
  }

  private startLoop() {
    if (this.timer) return;
    this.nextTick = performance.now() + TICK_MS;
    const loop = () => {
      const now = performance.now();
      let steps = 0;
      while (this.nextTick <= now && steps < 5) {
        this.step();
        this.nextTick += TICK_MS;
        steps++;
      }
      if (now - this.nextTick > 1000) this.nextTick = now + TICK_MS; // fell far behind: resync
      this.timer = setTimeout(loop, Math.max(1, this.nextTick - performance.now()));
    };
    this.timer = setTimeout(loop, TICK_MS);
  }
  stopLoop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private step() {
    const g = this.game;
    if (!g) return;
    // pause the world while nobody is connected (saves CPU; resumes on reconnect)
    if (this.connected === 0) return;
    for (const m of this.members.values()) m.bucket = Math.min(LIMITS.intentsPerSecond, m.bucket + LIMITS.intentsPerSecond / TICK_RATE);
    if (g.s.phase !== 'ended') g.tick();
    else { g.out = []; g.changed = []; }
    this.broadcast();
  }

  intent(token: string, msg: any) {
    const m = this.members.get(token);
    if (!m || !m.pid || !this.game) return;
    if (m.bucket < 1) return;
    m.bucket--;
    this.game.intent(m.pid, msg);
  }

  // ---- networking --------------------------------------------------------------------------
  private visible(g: Game, pid: number) { return g.vis.get(pid) ?? null; }

  sendInit(m: Member) {
    const g = this.game;
    if (!g || !m.ws || !m.pid) return;
    const s = g.s, pid = m.pid, me = g.P(pid)!;
    if (!g.vis.has(pid)) computeVision(g);
    const vis = this.visible(g, pid);
    const seeB = (t: number, owner: number) => owner === pid || me.allies.includes(owner) || !vis || vis[g.block(t)] === 1;
    const buildings: number[][] = [];
    for (const b of s.buildings) if (b && seeB(b.tile, b.owner)) buildings.push(bpack(b));
    const flights = s.flights.filter((f) => !f.dead && (f.kind === 'nuke' || f.kind === 'interceptor' || f.owner === pid || seeB(f.to, 0))).map(fpack);
    const rels: number[][] = [];
    const base = pid * L.maxPlayers;
    for (let j = 1; j < s.players.length; j++) {
      const r = s.rel[base + j];
      if (r) rels.push([j, r, s.napUntil.get(Math.min(pid, j) * L.maxPlayers + Math.max(pid, j)) ?? 0]);
    }
    const nukes = s.flights.filter((f) => f.kind === 'nuke' && !f.dead).map((f) => ({ id: f.id, o: f.owner, tile: f.to, target: s.owner[f.to], t1: f.t1, tier: f.tier ?? 0, from: f.from, t0: f.t0 }));
    const meta = {
      you: pid, tick: s.tick, phase: s.phase, phaseEnd: s.phaseEnd, peaceUntil: s.peaceUntil, startTick: s.startTick,
      settings: s.settings, mapW: g.map.W, blockSize: VISION.block,
      roster: s.players.filter((p): p is Player => !!p).map((p) => g.rosterEntry(p)),
      rel: rels, buildings, flights, nukes,
      fallout: s.falloutList.map((t) => [t, s.fallout[t]]),
      proposals: s.proposals.filter((p) => p.to === pid).map((p) => ({ from: p.from, kind: p.kind })),
      chat: s.chat.slice(-40), winter: s.winter, winner: s.winner, me: g.privateView(me),
      ops: opsFor(g, pid),
    };
    const w = new Writer(1 << 18);
    w.u8(MSG.INIT);
    w.json(meta);
    rleEncode(w, s.owner);
    if (vis) { w.u8(1); rleEncode(w, vis); m.lastVis = vis.slice(); } else w.u8(0);
    m.needInit = false;
    sendBin(m.ws, w.view());
  }

  private broadcast() {
    const g = this.game!;
    const s = g.s;
    const tw = this.tw.reset();
    encodeTileChanges(tw, g.changed, s.owner);
    const tileBytes = tw.view();
    // stringify each event once, strip routing keys
    const evJson: string[] = g.out.map((e) => JSON.stringify(e, stripKeys));
    const second = s.tick % TICK_RATE === 0;
    for (const m of this.members.values()) {
      if (!m.ws || !m.pid) continue;
      // a client that can't keep up gets a full resync later instead of an ever-growing buffer
      if (m.ws.bufferedAmount > CONGESTED) { m.needInit = true; continue; }
      if (m.needInit) { this.sendInit(m); continue; }
      const pid = m.pid, me = g.P(pid);
      if (!me) continue;
      const vis = this.visible(g, pid);
      const w = this.w.reset();
      w.u8(MSG.TICK);
      w.u32(s.tick);
      w.bytes(tileBytes);
      // fog changes
      const parts: string[] = [];
      let visChanged = false;
      if (vis && (!m.lastVis || second)) {
        const lv = m.lastVis;
        if (!lv) visChanged = true;
        else for (let i = 0; i < vis.length; i++) if (vis[i] !== lv[i]) { visChanged = true; break; }
        if (visChanged) {
          // reveal buildings in newly visible blocks
          if (lv) this.revealBlocks(g, vis, lv, parts);
          m.lastVis = vis.slice();
        }
      }
      if (visChanged) { w.u8(1); rleEncode(w, vis!); } else w.u8(0);
      // ships in vision
      const shipStart = w.o;
      w.vu(0);
      let ns = 0;
      for (const sh of s.ships) {
        if (sh.hp <= 0) continue;
        if (sh.owner !== pid && vis && !vis[g.block(sh.tile)] && !me.allies.includes(sh.owner)) continue;
        w.vu(sh.id); w.u8(sh.type); w.vu(sh.owner); w.u32(sh.tile);
        w.u8(Math.max(0, Math.min(255, Math.round((sh.hp / (sh.type === U.WARSHIP ? 100 : 30)) * 255))));
        ns++;
      }
      if (ns) {
        // rewrite count (varint may need more bytes than the placeholder): rebuild section
        const body = w.buf.slice(shipStart + 1, w.o);
        w.o = shipStart;
        w.vu(ns);
        w.bytes(body);
      }
      // events
      for (let i = 0; i < g.out.length; i++) {
        const e = g.out[i];
        if (e._all || e._to === pid || (e._p && e._p.includes(pid)) || (e._at !== undefined && (!vis || vis[g.block(e._at as number)]))) parts.push(evJson[i]);
      }
      parts.push(JSON.stringify(g.privateView(me)));
      if (second) parts.push(JSON.stringify(this.visibleTroops(g, me, vis)));
      w.str('[' + parts.join(',') + ']');
      sendBin(m.ws, w.view());
    }
  }

  private revealBlocks(g: Game, vis: Uint8Array, lv: Uint8Array, parts: string[]) {
    const s = g.s, W = g.map.W, H = g.map.H, B = VISION.block;
    for (let bk = 0; bk < vis.length; bk++) {
      if (!vis[bk] || lv[bk]) continue;
      const bx = (bk % g.BW) * B, by = ((bk / g.BW) | 0) * B;
      for (let y = by; y < Math.min(H, by + B); y++) {
        for (let x = bx; x < Math.min(W, bx + B); x++) {
          const id = s.bldAt[y * W + x];
          if (id >= 0) parts.push(JSON.stringify({ e: 'b', b: bpack(s.buildings[id]!) }));
        }
      }
    }
  }

  private visibleTroops(g: Game, me: Player, vis: Uint8Array | null) {
    const list: number[][] = [];
    for (const p of g.s.players) {
      if (!p || !p.alive || p.id === me.id) continue;
      let seen = !vis || me.allies.includes(p.id);
      if (!seen) for (const bk of p.blocks.keys()) if (vis![bk]) { seen = true; break; }
      if (seen) list.push([p.id, Math.round(p.troops), Math.floor(p.tanks), Math.round(effTroops(p))]);
    }
    return { e: 'vt', l: list };
  }

  broadcastJSON(msg: unknown) {
    for (const m of this.members.values()) if (m.ws) send(m.ws, msg);
  }

  snapshot() {
    if (!this.game || this.game.s.phase === 'ended') return null;
    return {
      code: this.code, host: this.host, savedAt: Date.now(),
      members: [...this.members.values()].map((m) => ({ token: m.token, name: m.name, color: m.color, team: m.team, pid: m.pid })),
      state: this.game.s,
    };
  }

  dispose() {
    this.stopLoop();
    for (const m of this.members.values()) if (m.ws) try { m.ws.close(4001, 'room closed'); } catch { /* ignore */ }
  }
}

/** Public, non-secret identifier derived from a session token. */
const pubIds = new Map<string, string>();
export function pubId(token: string): string {
  let id = pubIds.get(token);
  if (!id) { id = createHash('sha256').update('pw:' + token).digest('hex').slice(0, 12); pubIds.set(token, id); }
  return id;
}

export function cleanName(s: string): string {
  const n = String(s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return n || 'Commander';
}

export function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
const CONGESTED = 4 * 1024 * 1024;
function sendBin(ws: WebSocket, b: Uint8Array) {
  if (ws.readyState !== 1) return;
  ws.send(b.slice(), { binary: true });
}
