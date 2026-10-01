// Client-side mirror of the game as this player is allowed to see it.

import { GameMap, decodeMap, mapFileName } from '../../shared/mapdata.ts';
import { Reader, rleDecode, decodeTileChanges, MSG, REL, type MatchSettings } from '../../shared/protocol.ts';
import { LIMITS, TICK_MS, VISION } from '../../shared/balance.ts';

export interface PInfo {
  id: number; name: string; color: number; human: boolean; alive: boolean; capital: number; team: number; diff: number;
  troops: number | null; tanks: number | null; eff: number | null;
}
export interface Bld { id: number; type: number; tile: number; owner: number; level: number; done: number }
export interface ShipC { id: number; type: number; owner: number; tile: number; prev: number; hp: number; at: number }
export interface FlightC { id: number; kind: number; owner: number; from: number; to: number; t0: number; t1: number; ref: number; tier: number }
export interface NukeAlert { id: number; o: number; tile: number; target: number; t1: number; tier: number; from: number; t0: number }
export interface OpStepC { id: number; by: number; kind: string; tile: number; pct: number; delay: number; state: string; note: string }
export interface OpC {
  id: number; name: string; owner: number; target: number; status: string; launchAt: number; created: number; endedAt: number;
  members: { pid: number; status: string }[]; steps: OpStepC[];
}
export interface ChatLine { ch: string; from: number; name: string; text: string; tick: number }

const MAXP = LIMITS.maxPlayers;

const mapCache = new Map<number, Promise<GameMap>>();
export function fetchMap(w: number): Promise<GameMap> {
  let p = mapCache.get(w);
  if (!p) {
    p = (async () => {
      const res = await fetch(`/maps/${mapFileName(w)}`);
      if (!res.ok) throw new Error('map download failed');
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(ds).arrayBuffer());
      }
      return decodeMap(bytes);
    })();
    mapCache.set(w, p);
    p.catch(() => mapCache.delete(w));
  }
  return p;
}

export class World {
  map!: GameMap;
  W = 0; H = 0; N = 0;
  owner = new Uint16Array(0);
  fallout = new Uint8Array(0);
  bldAt = new Int32Array(0);
  vis: Uint8Array | null = null;
  BW = 0; BH = 0; B = VISION.block;
  players: PInfo[] = [];
  tileCount = new Int32Array(MAXP);
  sumX = new Float64Array(MAXP);
  sumY = new Float64Array(MAXP);
  bld = new Map<number, Bld>();
  ships = new Map<number, ShipC>();
  flights = new Map<number, FlightC>();
  nukes = new Map<number, NukeAlert>();
  ops = new Map<number, OpC>();
  me: any = null;
  myId = 0;
  rel = new Uint8Array(MAXP);
  relUntil = new Map<number, number>();
  proposals: { from: number; kind: string; at: number }[] = [];
  tick = 0;
  tickAt = 0;
  phase: 'spawn' | 'running' | 'ended' = 'spawn';
  phaseEnd = 0;
  peaceUntil = 0;
  startTick = 0;
  settings!: MatchSettings;
  lb: { top: number[][]; n: number; land: number } | null = null;
  winner: { ids: number[]; reason: string } | null = null;
  winter = 0;
  chat: ChatLine[] = [];
  ready = false;
  private loading = false;
  private queue: Uint8Array[] = [];

  onInit: () => void = () => {};
  onTiles: (tiles: number[]) => void = () => {};
  onVis: (blocks: number[]) => void = () => {};
  onEvent: (e: any) => void = () => {};

  /** Fractional server tick "now" for smooth animation. */
  now(): number { return this.tick + Math.min(1.5, (performance.now() - this.tickAt) / TICK_MS); }
  P(id: number): PInfo | undefined { return this.players[id]; }
  name(id: number): string { return id ? this.players[id]?.name ?? '?' : 'Unclaimed land'; }
  block(t: number): number { const x = t % this.W, y = (t / this.W) | 0; return ((y / this.B) | 0) * this.BW + ((x / this.B) | 0); }
  visible(t: number): boolean { return !this.vis || this.vis[this.block(t)] === 1; }
  isAlly(id: number): boolean { return id === this.myId || this.rel[id] === REL.ALLY; }
  secondsLeft(tick: number): number { return Math.max(0, (tick - this.now()) * TICK_MS / 1000); }

  async handleBinary(b: Uint8Array) {
    if (this.loading) { this.queue.push(b); return; }
    if (b[0] === MSG.INIT) {
      const r = new Reader(b);
      r.u8();
      const meta = r.json<any>();
      if (!this.map || this.map.W !== meta.mapW) {
        this.loading = true;
        try { this.map = await fetchMap(meta.mapW); } finally { this.loading = false; }
      }
      this.applyInit(meta, r);
      const q = this.queue;
      this.queue = [];
      for (const x of q) await this.handleBinary(x);
    } else if (b[0] === MSG.TICK && this.ready) this.applyTick(b);
  }

  private applyInit(meta: any, r: Reader) {
    const m = this.map;
    this.W = m.W; this.H = m.H; this.N = m.N;
    this.B = meta.blockSize ?? VISION.block;
    this.BW = Math.ceil(m.W / this.B); this.BH = Math.ceil(m.H / this.B);
    this.owner = new Uint16Array(m.N);
    rleDecode(r, this.owner);
    this.fallout = new Uint8Array(m.N);
    for (const [t] of meta.fallout) this.fallout[t] = 1;
    if (r.u8()) { this.vis = new Uint8Array(this.BW * this.BH); rleDecode(r, this.vis); } else this.vis = null;
    this.bldAt = new Int32Array(m.N).fill(-1);
    this.bld.clear();
    for (const b of meta.buildings) this.setBld(b);
    this.tileCount.fill(0); this.sumX.fill(0); this.sumY.fill(0);
    const W = m.W;
    for (let t = 0; t < m.N; t++) {
      const o = this.owner[t];
      if (!o) continue;
      this.tileCount[o]++;
      this.sumX[o] += t % W; this.sumY[o] += (t / W) | 0;
    }
    this.players = [];
    for (const e of meta.roster) this.setPlayer(e);
    this.myId = meta.you;
    this.rel.fill(0);
    this.relUntil.clear();
    for (const [j, rr, until] of meta.rel) { this.rel[j] = rr; if (until) this.relUntil.set(j, until); }
    this.flights.clear();
    for (const f of meta.flights) this.addFlight(f);
    this.nukes.clear();
    for (const n of meta.nukes) this.nukes.set(n.id, { tier: 0, ...n });
    this.ops.clear();
    for (const o of meta.ops ?? []) this.ops.set(o.id, o);
    this.ships.clear();
    this.tick = meta.tick; this.tickAt = performance.now();
    this.phase = meta.phase; this.phaseEnd = meta.phaseEnd; this.peaceUntil = meta.peaceUntil; this.startTick = meta.startTick;
    this.settings = meta.settings;
    this.proposals = meta.proposals.map((p: any) => ({ ...p, at: meta.tick }));
    this.chat = meta.chat;
    this.winter = meta.winter;
    this.winner = meta.winner;
    this.me = meta.me;
    this.ready = true;
    this.onInit();
  }

  private setPlayer(e: any) {
    const old = this.players[e.id];
    this.players[e.id] = {
      id: e.id, name: e.n, color: e.c, human: !!e.h, alive: !!e.a, capital: e.cap, team: e.tm, diff: e.d,
      troops: old?.troops ?? null, tanks: old?.tanks ?? null, eff: old?.eff ?? null,
    };
  }

  private setBld(p: number[]) {
    const [id, type, tile, owner, level, done] = p;
    const old = this.bld.get(id);
    if (old && old.tile !== tile && this.bldAt[old.tile] === id) this.bldAt[old.tile] = -1;
    const prev = this.bldAt[tile];
    if (prev >= 0 && prev !== id) this.bld.delete(prev);
    this.bld.set(id, { id, type, tile, owner, level, done });
    this.bldAt[tile] = id;
  }
  private delBld(id: number, tile: number) {
    const b = this.bld.get(id);
    if (b && this.bldAt[b.tile] === id) this.bldAt[b.tile] = -1;
    if (this.bldAt[tile] === id) this.bldAt[tile] = -1;
    this.bld.delete(id);
  }

  private addFlight(f: number[]) {
    const [id, kind, owner, from, to, t0, t1, ref, tier] = f;
    this.flights.set(id, { id, kind, owner, from, to, t0, t1, ref, tier: tier ?? 0 });
  }

  private applyTick(b: Uint8Array) {
    const r = new Reader(b);
    r.u8();
    this.tick = r.u32();
    this.tickAt = performance.now();
    const changed: number[] = [];
    const own = this.owner, W = this.W, tc = this.tileCount, sx = this.sumX, sy = this.sumY;
    decodeTileChanges(r, (t, o) => {
      const old = own[t];
      if (old === o) return;
      const x = t % W, y = (t / W) | 0;
      if (old) { tc[old]--; sx[old] -= x; sy[old] -= y; }
      own[t] = o;
      if (o) { tc[o]++; sx[o] += x; sy[o] += y; }
      changed.push(t);
    });
    if (r.u8()) {
      const nv = new Uint8Array(this.BW * this.BH);
      rleDecode(r, nv);
      const blocks: number[] = [];
      const ov = this.vis;
      for (let i = 0; i < nv.length; i++) if (!ov || ov[i] !== nv[i]) blocks.push(i);
      this.vis = nv;
      // forget what we can no longer see
      for (const bl of this.bld.values()) if (!this.isAlly(bl.owner) && !nv[this.block(bl.tile)]) this.delBld(bl.id, bl.tile);
      if (blocks.length) this.onVis(blocks);
    }
    const ns = r.vu();
    const now = performance.now();
    const seen = new Set<number>();
    for (let i = 0; i < ns; i++) {
      const id = r.vu(), type = r.u8(), owner = r.vu(), tile = r.u32(), hp = r.u8() / 255;
      seen.add(id);
      const old = this.ships.get(id);
      if (old) {
        if (old.tile !== tile) { old.prev = old.tile; old.tile = tile; old.at = now; }
        old.hp = hp;
      } else this.ships.set(id, { id, type, owner, tile, prev: tile, hp, at: now });
    }
    for (const id of this.ships.keys()) if (!seen.has(id)) this.ships.delete(id);
    const events = JSON.parse(r.str()) as any[];
    for (const e of events) this.applyEvent(e);
    if (changed.length) this.onTiles(changed);
    // flights whose resolution we never saw (e.g. bomber return legs, impacts outside our vision)
    if (this.tick % 5 === 0) {
      for (const [id, f] of this.flights) if (f.t1 < this.tick - 10) this.flights.delete(id);
      for (const [id, n] of this.nukes) if (n.t1 < this.tick - 25) this.nukes.delete(id);
    }
    this.onTick();
  }
  onTick: () => void = () => {};

  private applyEvent(e: any) {
    switch (e.e) {
      case 'me': this.me = e; { const p = this.players[this.myId]; if (p) { p.troops = e.troops; p.tanks = e.tanks; } } return;
      case 'b': this.setBld(e.b); break;
      case 'bx': this.delBld(e.id, e.tile); break;
      case 'pl': this.setPlayer(e.p); break;
      case 'roster': for (const p of e.list) this.setPlayer(p); break;
      case 'phase': this.phase = e.phase; this.peaceUntil = e.peaceUntil; this.startTick = e.start; break;
      case 'rel': {
        const other = e.a === this.myId ? e.b : e.b === this.myId ? e.a : 0;
        if (other) { this.rel[other] = e.r; if (e.until) this.relUntil.set(other, e.until); else this.relUntil.delete(other); }
        break;
      }
      case 'fl': this.addFlight(e.f); break;
      case 'hit': this.flights.delete(e.id); if (e.k === 1) this.nukes.delete(e.id); break;
      case 'nl': this.nukes.set(e.id, { id: e.id, o: e.o, tile: e.tile, target: e.target, t1: e.t1, tier: e.tier ?? 0, from: e.from ?? e.tile, t0: e.t0 ?? this.tick }); break;
      case 'op': this.ops.set(e.op.id, e.op); break;
      case 'opx': this.ops.delete(e.id); break;
      case 'nuke': {
        this.flights.delete(e.id);
        this.nukes.delete(e.id);
        const m = this.map, changed: number[] = [];
        m.forRadius(e.tile, e.r, (t) => { if (m.isLand(t)) { this.fallout[t] = 1; changed.push(t); } });
        this.onTiles(changed);
        break;
      }
      case 'fc': this.fallout[e.t] = 0; this.onTiles([e.t]); return;
      case 'prop': this.proposals = this.proposals.filter((p) => !(p.from === e.from && p.kind === e.kind)); this.proposals.push({ from: e.from, kind: e.kind, at: this.tick }); break;
      case 'propAns': this.proposals = this.proposals.filter((p) => !(p.from === e.from && p.kind === e.kind && e.to === this.myId)); break;
      case 'lb': this.lb = e; break;
      case 'vt': {
        for (const p of this.players) if (p && p.id !== this.myId) { p.troops = null; p.tanks = null; p.eff = null; }
        for (const [id, tr, tk, eff] of e.l) { const p = this.players[id]; if (p) { p.troops = tr; p.tanks = tk; p.eff = eff; } }
        return;
      }
      case 'chat': this.chat.push(e); if (this.chat.length > 150) this.chat.shift(); break;
      case 'winter': this.winter = e.v; break;
      case 'end': this.phase = 'ended'; this.winner = { ids: e.ids, reason: e.reason }; break;
    }
    this.onEvent(e);
  }

  /** Current neighbours of the player (land contact), by scanning the owner grid. */
  neighbours(pid: number): Map<number, number> {
    const res = new Map<number, number>();
    const own = this.owner, W = this.W, N = this.N, m = this.map;
    const add = (n: number) => {
      if (n < 0 || n >= N) return;
      const q = own[n];
      if (q && q !== pid && m.isLand(n)) res.set(q, (res.get(q) ?? 0) + 1);
    };
    for (let t = 0; t < N; t++) {
      if (own[t] !== pid) continue;
      const x = t % W;
      add(x === 0 ? t + W - 1 : t - 1);
      add(x === W - 1 ? t - W + 1 : t + 1);
      add(t - W);
      add(t + W);
    }
    return res;
  }
}
