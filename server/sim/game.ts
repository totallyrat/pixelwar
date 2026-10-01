// Authoritative game simulation. One Game per room. Fixed tick (TICK_RATE), seeded RNG,
// all state in `s` (plain data) so it can be snapshotted.

import type { GameMap } from '../../shared/mapdata.ts';
import type { MatchSettings } from '../../shared/protocol.ts';
import { REL } from '../../shared/protocol.ts';
import {
  TICK_RATE, LIMITS, ECON, SPAWN, VISION, B, U, UNIT_COUNT, BUILDING_COUNT, SCORE, HAPPY, NUKE, AI, TERRAIN, T, TECH,
} from '../../shared/balance.ts';
import { aiName, aiColor } from '../../shared/names.ts';
import type { State, Player, GameEvent, Building } from './types.ts';
import { stepAttacks, launchAttack, cancelAttack, endAttacksOf } from './combat.ts';
import { stepEconomy, updateHappiness, canAfford, pay } from './economy.ts';
import {
  placeBuilding, upgradeBuilding, demolishBuilding, stepBuildings, destroyBuilding, transferBuilding, relocateCapital, bpack, slotsTotal,
} from './buildings.ts';
import {
  queueUnit, cancelQueue, moveWarships, invade, stepShips, launchMissile, launchNuke, interceptNuke, launchBomber, stepFlights, sinkShipsOf, maxLevel,
} from './units.ts';
import {
  createOp, addStep, editStep, removeStep, retime, inviteToOp, answerOp, leaveOp, launchOp, cancelOp, stepOps,
} from './ops.ts';
import { rel, propose, respond, declareWar, breakTreaty, donate, driftOpinions, setRel, expirePacts } from './diplomacy.ts';
import { computeVision } from './vision.ts';
import { aiThink, setupAI } from './ai.ts';

export const STATE_VERSION = 1;
const MAXP = LIMITS.maxPlayers;

export class Game {
  readonly map: GameMap;
  s: State;
  out: GameEvent[] = [];
  changed: number[] = [];
  readonly changeStamp: Uint32Array;
  readonly nb = new Int32Array(4);
  readonly BW: number;
  readonly BH: number;
  vis = new Map<number, Uint8Array>();
  visGen = 0;
  inbox: { pid: number; m: any }[] = [];
  perf = { sim: 0, max: 0 };

  constructor(map: GameMap, settings: MatchSettings, seed: number, state?: State) {
    this.map = map;
    this.s = state ?? this.freshState(settings, seed);
    if (state) migrate(this.s);
    this.changeStamp = new Uint32Array(map.N);
    this.BW = Math.ceil(map.W / VISION.block);
    this.BH = Math.ceil(map.H / VISION.block);
  }

  private freshState(settings: MatchSettings, seed: number): State {
    const N = this.map.N;
    let z = seed >>> 0;
    const sm = () => { z = (z + 0x9e3779b9) | 0; let t = z ^ (z >>> 16); t = Math.imul(t, 0x21f0aaad); t ^= t >>> 15; t = Math.imul(t, 0x735a2d97); return (t ^ (t >>> 15)) >>> 0; };
    return {
      version: STATE_VERSION,
      tick: 0,
      phase: 'spawn',
      phaseEnd: settings.spawnSeconds * TICK_RATE,
      startTick: 0,
      peaceUntil: 0,
      settings,
      seed,
      rng: [sm(), sm(), sm(), sm()],
      owner: new Uint16Array(N),
      fallout: new Uint16Array(N),
      falloutList: [],
      bldAt: new Int32Array(N).fill(-1),
      ownedPos: new Int32Array(N).fill(-1),
      borderPos: new Int32Array(N).fill(-1),
      players: [null],
      buildings: [],
      freeB: [],
      pendingB: [],
      attacks: [],
      ships: [],
      flights: [],
      rel: new Uint8Array(MAXP * MAXP),
      opinion: new Int8Array(MAXP * MAXP),
      proposals: [],
      napUntil: new Map(),
      operations: [],
      nextId: 1,
      winter: 0,
      winterTimer: 0,
      humansAtStart: 0,
      winner: null,
      usedNames: [],
      chat: [],
    };
  }

  // ---- helpers ---------------------------------------------------------------------------
  get speed() { return this.s.settings.speed; }
  get dt() { return this.s.settings.speed / TICK_RATE; }
  rand(): number {
    const r = this.s.rng;
    let a = r[0] | 0, b = r[1] | 0, c = r[2] | 0, d = r[3] | 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    r[0] = a; r[1] = b; r[2] = c; r[3] = d;
    return (t >>> 0) / 4294967296;
  }
  randInt(n: number): number { return Math.floor(this.rand() * n); }
  id(): number { return this.s.nextId++; }
  emit(ev: GameEvent) { this.out.push(ev); }
  err(pid: number, msg: string) { this.emit({ e: 'err', _to: pid, msg }); }
  P(id: number): Player | null { return this.s.players[id] ?? null; }
  alivePlayers(): Player[] { return this.s.players.filter((p): p is Player => !!p && p.alive); }
  humans(): Player[] { return this.s.players.filter((p): p is Player => !!p && p.human); }
  secondsToTicks(sec: number) { return Math.max(1, Math.round((sec * TICK_RATE) / this.speed)); }
  get running() { return this.s.phase === 'running'; }
  get peace() { return this.s.tick < this.s.peaceUntil; }
  block(t: number): number {
    const W = this.map.W, x = t % W, y = (t / W) | 0;
    return ((y / VISION.block) | 0) * this.BW + ((x / VISION.block) | 0);
  }

  // ---- players ---------------------------------------------------------------------------
  newPlayer(name: string, color: number, human: boolean, diff: number): Player {
    const id = this.s.players.length;
    if (id >= MAXP) throw new Error('player capacity reached');
    const p: Player = {
      id, name, color, human, token: '', diff, team: 0, alive: true, spawned: false, capital: -1,
      tiles: 0, popCapTiles: 0, foodTiles: 0, tradeTiles: 0, falloutTiles: 0,
      pop: ECON.startPop, troops: ECON.startTroops, tanks: 0, mobilization: ECON.defaultMobilization,
      food: ECON.startFood, prod: ECON.startProd, money: ECON.startMoney, oil: 0, uranium: 0,
      rates: [0, 0, 0, 0, 0, 0, 0], popCap: 0, happiness: HAPPY.base, starving: false, techOff: 0, techDef: 0,
      stock: new Array(UNIT_COUNT).fill(0), queue: new Array(UNIT_COUNT).fill(0), qprog: new Array(UNIT_COUNT).fill(0),
      levels: new Array(BUILDING_COUNT).fill(0), btype: Array.from({ length: BUILDING_COUNT }, () => []),
      farmFood: 0, slotsUsed: 0, traitorUntil: 0, recentLoss: 0, score: 0,
      owned: [], border: [], blocks: new Map(), ships: 0, allies: [], ai: null, killedBy: 0, eliminatedAt: 0,
      stats: { tilesTaken: 0, nukes: 0, kills: 0 },
    };
    this.s.players.push(p);
    this.s.usedNames.push(name);
    return p;
  }

  addHuman(name: string, color: number, team: number, token: string): Player {
    const p = this.newPlayer(name, color, true, -1);
    p.token = token;
    p.team = team;
    this.emit({ e: 'pl', _all: true, p: this.rosterEntry(p) });
    if (this.s.phase === 'running') {
      const t = this.findSpawnTile(SPAWN.minDistance * this.map.ms, true);
      if (t >= 0) this.spawnAt(p, t);
    }
    return p;
  }

  rosterEntry(p: Player) {
    return { id: p.id, n: p.name, c: p.color, h: p.human ? 1 : 0, a: p.alive ? 1 : 0, cap: p.capital, tm: p.team, d: p.diff };
  }

  // ---- territory ---------------------------------------------------------------------------
  setOwner(t: number, o: number): void {
    const s = this.s, m = this.map;
    const old = s.owner[t];
    if (old === o) return;
    const fall = s.fallout[t] > 0;
    if (old) {
      const p = s.players[old]!;
      // remove from owned list (swap remove)
      const pos = s.ownedPos[t], last = p.owned.pop()!;
      if (last !== t) { p.owned[pos] = last; s.ownedPos[last] = pos; }
      s.ownedPos[t] = -1;
      if (s.borderPos[t] >= 0) this.borderRemove(p, t);
      p.tiles--;
      if (!fall) { p.popCapTiles -= m.tilePop[t]; p.foodTiles -= m.tileFood[t]; } else p.falloutTiles--;
      p.tradeTiles -= m.tileTrade[t];
      p.recentLoss++;
      const bk = this.block(t), c = p.blocks.get(bk)! - 1;
      if (c <= 0) p.blocks.delete(bk); else p.blocks.set(bk, c);
    }
    s.owner[t] = o;
    if (o) {
      const p = s.players[o]!;
      s.ownedPos[t] = p.owned.length;
      p.owned.push(t);
      p.tiles++;
      if (!fall) { p.popCapTiles += m.tilePop[t]; p.foodTiles += m.tileFood[t]; } else p.falloutTiles++;
      p.tradeTiles += m.tileTrade[t];
      const bk = this.block(t);
      p.blocks.set(bk, (p.blocks.get(bk) ?? 0) + 1);
    }
    // buildings on the tile
    const bid = s.bldAt[t];
    if (bid >= 0) {
      const b = s.buildings[bid]!;
      const prev = old ? s.players[old]! : null;
      if (!o || (prev && prev.capital === t)) destroyBuilding(this, b, o ? 'captured' : 'wiped');
      else transferBuilding(this, b, o);
      if (prev && prev.capital === t && prev.alive) relocateCapital(this, prev);
    }
    // borders
    this.updateBorder(t);
    const nb = this.nb;
    m.n4(t, nb);
    const n0 = nb[0], n1 = nb[1], n2 = nb[2], n3 = nb[3];
    this.updateBorder(n0);
    this.updateBorder(n1);
    if (n2 >= 0) this.updateBorder(n2);
    if (n3 >= 0) this.updateBorder(n3);
    const stamp = s.tick + 1;
    if (this.changeStamp[t] !== stamp) { this.changeStamp[t] = stamp; this.changed.push(t); }
  }

  private updateBorder(t: number) {
    const s = this.s, o = s.owner[t];
    if (!o) return;
    const m = this.map, W = m.W, x = t % W, own = s.owner, ter = m.terrain;
    const l = x === 0 ? t + W - 1 : t - 1, r = x === W - 1 ? t - W + 1 : t + 1, u = t - W, d = t + W;
    const isB =
      (own[l] !== o && ter[l] > T.SHALLOW) || (own[r] !== o && ter[r] > T.SHALLOW) ||
      (u >= 0 && own[u] !== o && ter[u] > T.SHALLOW) || (d < m.N && own[d] !== o && ter[d] > T.SHALLOW);
    const p = s.players[o]!;
    if (isB && s.borderPos[t] < 0) { s.borderPos[t] = p.border.length; p.border.push(t); }
    else if (!isB && s.borderPos[t] >= 0) this.borderRemove(p, t);
  }
  private borderRemove(p: Player, t: number) {
    const s = this.s, pos = s.borderPos[t], last = p.border.pop()!;
    if (last !== t) { p.border[pos] = last; s.borderPos[last] = pos; }
    s.borderPos[t] = -1;
  }
  touches(t: number, o: number): boolean {
    const m = this.map, W = m.W, x = t % W, own = this.s.owner;
    return own[x === 0 ? t + W - 1 : t - 1] === o || own[x === W - 1 ? t - W + 1 : t + 1] === o ||
      (t >= W && own[t - W] === o) || (t < m.N - W && own[t + W] === o);
  }

  setFallout(t: number, secs: number) {
    const s = this.s, m = this.map;
    if (m.isWater(t)) return;
    if (s.fallout[t] === 0) {
      s.falloutList.push(t);
      const o = s.owner[t];
      if (o) { const p = s.players[o]!; p.popCapTiles -= m.tilePop[t]; p.foodTiles -= m.tileFood[t]; p.falloutTiles++; }
    }
    s.fallout[t] = Math.max(s.fallout[t], Math.min(65000, Math.round(secs)));
  }
  private stepFallout() {
    const s = this.s, m = this.map, list = s.falloutList;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const v = s.fallout[t] - Math.max(1, Math.round(this.speed));
      if (v > 0) { s.fallout[t] = v; list[w++] = t; continue; }
      s.fallout[t] = 0;
      const o = s.owner[t];
      if (o) { const p = s.players[o]!; p.popCapTiles += m.tilePop[t]; p.foodTiles += m.tileFood[t]; p.falloutTiles--; }
      this.emit({ e: 'fc', _all: true, t });
    }
    list.length = w;
  }

  // ---- spawning ------------------------------------------------------------------------------
  capitals(): number[] {
    const r: number[] = [];
    for (const p of this.s.players) if (p && p.alive && p.capital >= 0) r.push(p.capital);
    return r;
  }
  findSpawnTile(minDist: number, human: boolean): number {
    const m = this.map, caps = this.capitals();
    const md2 = minDist * minDist;
    for (let attempt = 0; attempt < 4000; attempt++) {
      const t = m.landTiles[this.randInt(m.landTiles.length)];
      const ter = m.terrain[t];
      if (this.s.owner[t] || ter === T.ICE || (ter === T.MOUNTAIN && attempt < 2000)) continue;
      let ok = true;
      for (const c of caps) if (m.dist2(t, c) < md2) { ok = false; break; }
      if (!ok) continue;
      // avoid 1-tile islands for humans
      if (human && attempt < 3000) {
        let land = 0;
        m.forRadius(t, 3, (u) => { if (m.isLand(u)) land++; });
        if (land < 18) continue;
      }
      return t;
    }
    return -1;
  }
  validSpawn(pid: number, t: number): string | null {
    const m = this.map;
    if (t < 0 || t >= m.N || !m.isLand(t)) return 'Pick a land tile';
    if (m.terrain[t] === T.ICE) return 'Too cold to found a nation here';
    const o = this.s.owner[t];
    if (o && o !== pid) return 'Already claimed';
    const minD = SPAWN.humanProtect * m.ms;
    for (const p of this.s.players) {
      if (!p || p.id === pid || p.capital < 0) continue;
      if (m.dist2(t, p.capital) < minD * minD) return `Too close to ${p.name}`;
    }
    return null;
  }
  spawnAt(p: Player, t: number) {
    const m = this.map;
    if (p.spawned) this.unspawn(p);
    const r = Math.max(2, SPAWN.radius * m.ms);
    m.forRadius(t, r, (u) => { if (m.isLand(u) && !this.s.owner[u]) this.setOwner(u, p.id); });
    if (this.s.owner[t] !== p.id) this.setOwner(t, p.id);
    p.capital = t;
    p.spawned = true;
    placeBuilding(this, p, t, B.CITY, true);
    this.emit({ e: 'pl', _all: true, p: this.rosterEntry(p) });
  }
  private unspawn(p: Player) {
    p.capital = -1;
    for (const t of p.owned.slice()) this.setOwner(t, 0);
    p.spawned = false;
  }
  /** Recompute building aggregates after direct level edits. */
  recountBuilding(p: Player) {
    p.levels.fill(0);
    p.farmFood = 0;
    for (let ty = 1; ty < BUILDING_COUNT; ty++) {
      for (const id of p.btype[ty]) {
        const b = this.s.buildings[id]!;
        p.levels[ty] += b.level;
        if (ty === B.FARM) p.farmFood += b.level * TERRAIN[this.map.terrain[b.tile]].farm;
      }
    }
  }

  private startMain() {
    const s = this.s, set = s.settings;
    // humans who never picked get a random spot
    for (const p of this.humans()) {
      if (!p.spawned) {
        const t = this.findSpawnTile(SPAWN.humanProtect * this.map.ms, true);
        if (t >= 0) this.spawnAt(p, t);
      }
    }
    s.humansAtStart = this.humans().length;
    // AI nations
    const levels = ['passive', 'defensive', 'aggressive'];
    const n = Math.min(set.aiCount, LIMITS.maxAI, MAXP - s.players.length - 40);
    const land = this.map.landCount;
    let minDist = Math.max(4, Math.min(SPAWN.minDistance * this.map.ms, Math.sqrt(land / Math.max(1, n + s.humansAtStart) / Math.PI) * 1.1));
    const used = new Set(s.usedNames);
    for (let i = 0; i < n; i++) {
      let t = this.findSpawnTile(minDist, false);
      while (t < 0 && minDist > 2) { minDist *= 0.8; t = this.findSpawnTile(minDist, false); }
      if (t < 0) break;
      const cname = this.map.country[t] ? this.map.countries[this.map.country[t] - 1].n : null;
      let diff = levels.indexOf(set.aiDifficulty);
      if (diff < 0) { const r = this.rand(); diff = r < 0.3 ? 0 : r < 0.72 ? 1 : 2; }
      const p = this.newPlayer(aiName(cname, () => this.rand(), used), aiColor(i, () => this.rand()), false, diff);
      setupAI(this, p);
      this.spawnAt(p, t);
    }
    // teams start allied
    const hs = this.humans();
    for (const a of hs) for (const b of hs) if (a.id < b.id && a.team && a.team === b.team) setRel(this, a.id, b.id, REL.ALLY);
    // opinions: small random spread
    for (const p of this.s.players) if (p && !p.human) for (const q of this.s.players) if (q && q !== p) this.s.opinion[p.id * MAXP + q.id] = Math.round((this.rand() - 0.5) * 20);
    s.phase = 'running';
    s.startTick = s.tick;
    s.peaceUntil = s.tick + Math.round(set.peaceSeconds * TICK_RATE);
    this.emit({ e: 'phase', _all: true, phase: 'running', peaceUntil: s.peaceUntil, start: s.startTick });
    this.emit({ e: 'roster', _all: true, list: this.s.players.filter((p) => p).map((p) => this.rosterEntry(p!)) });
  }

  eliminate(p: Player, by: number) {
    if (!p.alive) return;
    p.alive = false;
    p.killedBy = by;
    p.eliminatedAt = this.s.tick;
    for (const t of p.owned.slice()) this.setOwner(t, 0);
    endAttacksOf(this, p.id);
    sinkShipsOf(this, p.id);
    for (let ty = 1; ty < BUILDING_COUNT; ty++) for (const id of p.btype[ty].slice()) destroyBuilding(this, this.s.buildings[id]!, 'wiped');
    for (const a of p.allies.slice()) setRel(this, p.id, a, REL.PEACE);
    this.s.proposals = this.s.proposals.filter((x) => x.from !== p.id && x.to !== p.id);
    const killer = this.P(by);
    if (killer) killer.stats.kills++;
    this.emit({ e: 'elim', _all: true, id: p.id, by });
    this.emit({ e: 'pl', _all: true, p: this.rosterEntry(p) });
  }

  // ---- main loop ---------------------------------------------------------------------------
  tick(): void {
    const t0 = performance.now();
    const s = this.s;
    this.out = [];
    this.changed = [];
    s.tick++;
    const inbox = this.inbox;
    this.inbox = [];
    for (const { pid, m } of inbox) {
      try { this.handle(pid, m); } catch (e) { console.error('intent error', e); }
    }
    if (s.phase === 'spawn') {
      if (s.tick >= s.phaseEnd) this.startMain();
    } else if (s.phase === 'running') {
      stepAttacks(this);
      stepEconomy(this);
      stepBuildings(this);
      stepShips(this);
      stepFlights(this);
      stepOps(this);
      for (const p of s.players) {
        if (p && p.alive && p.ai && p.ai.next <= s.tick) {
          aiThink(this, p);
          p.ai.next = s.tick + Math.round(AI.thinkSeconds[p.diff] * TICK_RATE * (0.8 + this.rand() * 0.4));
        }
      }
      if (s.tick % TICK_RATE === 0) this.everySecond();
      if (s.tick % (TICK_RATE * 2) === 0) this.leaderboard();
    }
    if (s.tick % TICK_RATE === 0) { computeVision(this); this.visGen++; }
    const dtMs = performance.now() - t0;
    this.perf.sim = this.perf.sim * 0.95 + dtMs * 0.05;
    this.perf.max = Math.max(this.perf.max * 0.999, dtMs);
  }

  private everySecond() {
    const s = this.s;
    this.stepFallout();
    for (const p of s.players) {
      if (!p || !p.alive || !p.spawned) continue;
      if (p.tiles === 0) { this.eliminate(p, 0); continue; }
      updateHappiness(this, p);
      this.score(p);
    }
    // proposals expire
    if (s.proposals.length) s.proposals = s.proposals.filter((x) => x.expires > s.tick);
    // nuclear winter decay
    if (s.winter > 0 && ++s.winterTimer >= NUKE.winterDecaySeconds / this.speed) { s.winter--; s.winterTimer = 0; this.emit({ e: 'winter', _all: true, v: s.winter }); }
    if (s.tick % (TICK_RATE * 30) === 0) driftOpinions(this);
    if (s.tick % (TICK_RATE * 5) === 0) expirePacts(this);
    this.checkWin();
  }

  score(p: Player) {
    let bl = 0;
    for (let ty = 1; ty < BUILDING_COUNT; ty++) bl += p.levels[ty];
    p.score = Math.round(p.tiles * this.map.as * SCORE.perTile + p.pop * SCORE.perPop + p.troops * SCORE.perTroop + bl * SCORE.perBuildingLevel + (p.techOff + p.techDef) * SCORE.perTech);
  }

  private leaderboard() {
    const alive = this.alivePlayers().sort((a, b) => b.score - a.score);
    const top = alive.slice(0, 15).map((p) => [p.id, p.score, p.tiles]);
    for (let i = 0; i < alive.length; i++) (alive[i] as any)._rank = i + 1;
    this.emit({ e: 'lb', _all: true, top, n: alive.length, land: this.map.landCount });
  }

  private checkWin() {
    const s = this.s, set = s.settings;
    if (s.phase !== 'running') return;
    const need = (this.map.landCount * set.winPercent) / 100;
    const alive = this.alivePlayers();
    // territory victory
    for (const p of alive) {
      let tiles = p.tiles;
      if (set.sharedVictory) for (const a of p.allies) tiles += this.P(a)?.tiles ?? 0;
      if (tiles >= need) {
        const ids = [p.id, ...(set.sharedVictory ? p.allies : [])];
        return this.endGame(ids, `${p.name}${set.sharedVictory && p.allies.length ? ' and allies' : ''} control ${set.winPercent}% of the world`);
      }
    }
    const humans = this.humans();
    const aliveH = humans.filter((p) => p.alive);
    if (humans.length > 0 && aliveH.length === 0) {
      const top = alive.sort((a, b) => b.score - a.score)[0];
      return this.endGame(top ? [top.id] : [], 'All human nations have fallen');
    }
    // "last human (alliance) standing" only counts once human rivals were actually knocked out,
    // otherwise friends playing as a team (or simply allying) would win on the spot
    if (s.humansAtStart >= 2 && aliveH.length >= 1 && aliveH.length < humans.length) {
      const first = aliveH[0];
      const allAllied = aliveH.every((p) => p === first || rel(this, first.id, p.id) === REL.ALLY);
      if (aliveH.length === 1 || (set.sharedVictory && allAllied)) {
        const ids = aliveH.map((p) => p.id);
        return this.endGame(ids, aliveH.length === 1 ? `${first.name} is the last human nation standing` : 'The last human alliance stands victorious');
      }
    }
    if (set.timeLimitMin > 0 && (s.tick - s.startTick) / TICK_RATE >= set.timeLimitMin * 60) {
      const top = alive.sort((a, b) => b.score - a.score)[0];
      if (top) return this.endGame([top.id, ...(set.sharedVictory ? top.allies : [])], `Time is up. ${top.name} has the highest score`);
    }
  }

  endGame(ids: number[], reason: string) {
    const s = this.s;
    s.phase = 'ended';
    s.winner = { ids, reason };
    const stats = this.s.players.filter((p): p is Player => !!p && (p.human || p.alive)).sort((a, b) => b.score - a.score).slice(0, 30)
      .map((p) => ({ id: p.id, score: p.score, tiles: p.tiles, kills: p.stats.kills, nukes: p.stats.nukes, alive: p.alive }));
    this.emit({ e: 'end', _all: true, ids, reason, stats });
  }

  // ---- intents -----------------------------------------------------------------------------
  intent(pid: number, m: any) { this.inbox.push({ pid, m }); }

  private handle(pid: number, m: any) {
    const s = this.s, p = this.P(pid);
    if (!p || typeof m !== 'object' || m === null) return;
    const num = (v: unknown, d = -1) => (typeof v === 'number' && isFinite(v) ? v : d);
    const tile = Math.floor(num(m.tile));
    const tileOk = tile >= 0 && tile < this.map.N;
    const frac = Math.max(0.01, Math.min(1, num(m.pct, 0.3)));
    const other = Math.floor(num(m.p, 0));
    let r: string | null = null;
    if (m.k === 'chat') return this.chat(p, m);
    if (m.k === 'ping') { if (tileOk) this.emit({ e: 'ping', _p: [pid, ...p.allies], from: pid, tile, kind: String(m.kind ?? 'look').slice(0, 10) }); return; }
    if (s.phase === 'spawn') {
      if (m.k !== 'spawn') return this.err(pid, 'Wait for the match to start');
      if (!p.human || !tileOk) return;
      r = this.validSpawn(pid, tile);
      if (r) return this.err(pid, r);
      this.spawnAt(p, tile);
      return;
    }
    if (s.phase !== 'running' || !p.alive) return;
    switch (m.k) {
      case 'build': r = tileOk ? placeBuildingIntent(this, p, tile, Math.floor(num(m.b, 0))) : 'Bad tile'; break;
      case 'upgrade': r = tileOk ? upgradeBuilding(this, p, tile) : 'Bad tile'; break;
      case 'demolish': r = tileOk ? demolishBuilding(this, p, tile) : 'Bad tile'; break;
      case 'attack': {
        if (!tileOk || !this.map.isLand(tile)) { r = 'Pick a land tile'; break; }
        const target = s.owner[tile];
        r = launchAttack(this, pid, target, frac, tile);
        break;
      }
      case 'expand': r = launchAttack(this, pid, 0, frac, tileOk ? tile : -1); break;
      case 'cancel': cancelAttack(this, pid, Math.floor(num(m.id, 0))); break;
      case 'mob': p.mobilization = Math.max(0, Math.min(0.9, num(m.v, 0.35))); break;
      case 'train': r = queueUnit(this, p, Math.floor(num(m.u, -1)), Math.max(1, Math.min(10, Math.floor(num(m.n, 1))))); break;
      case 'untrain': cancelQueue(this, p, Math.floor(num(m.u, -1))); break;
      case 'tech': r = buyTech(this, p, m.w === 'def' ? 'def' : 'off'); break;
      case 'missile': r = tileOk ? launchMissile(this, p, tile) : 'Bad tile'; break;
      case 'nuke': r = tileOk ? launchNuke(this, p, tile, num(m.tier, 0) === 1 ? 1 : 0) : 'Bad tile'; break;
      case 'intercept': r = interceptNuke(this, p, Math.floor(num(m.id, 0))); break;
      case 'bomb': r = tileOk ? launchBomber(this, p, tile) : 'Bad tile'; break;
      case 'invade': r = tileOk ? invade(this, p, tile, frac) : 'Bad tile'; break;
      case 'ships': r = tileOk ? moveWarships(this, p, tile) : 'Bad tile'; break;
      case 'propose': r = propose(this, pid, other, m.kind); break;
      case 'respond': r = respond(this, pid, other, m.kind, !!m.yes); break;
      case 'war': r = declareWar(this, pid, other, true); break;
      case 'break': r = breakTreaty(this, pid, other); break;
      case 'donate': r = donate(this, pid, other, Math.max(0, Math.min(1, num(m.troops, 0))), Math.max(0, Math.min(1, num(m.money, 0)))); break;
      case 'surrender': this.eliminate(p, 0); break;
      // operations
      case 'opNew': { const o = createOp(this, pid, other, m.name); if (typeof o === 'string') r = o; else this.emit({ e: 'opMade', _to: pid, id: o.id }); break; }
      case 'opStep': r = addStep(this, pid, num(m.op, 0), m.kind, tile, frac, num(m.delay, 0)); break;
      case 'opEdit': r = editStep(this, pid, num(m.op, 0), num(m.step, 0), typeof m.delay === 'number' ? m.delay : undefined, typeof m.pct === 'number' ? m.pct : undefined); break;
      case 'opDel': r = removeStep(this, pid, num(m.op, 0), num(m.step, 0)); break;
      case 'opTime': r = retime(this, pid, num(m.op, 0), m.mode, num(m.gap, 5)); break;
      case 'opInvite': r = inviteToOp(this, pid, num(m.op, 0), other); break;
      case 'opAnswer': r = answerOp(this, pid, num(m.op, 0), !!m.yes); break;
      case 'opLeave': r = leaveOp(this, pid, num(m.op, 0)); break;
      case 'opLaunch': r = launchOp(this, pid, num(m.op, 0), num(m.cd, 0)); break;
      case 'opCancel': r = cancelOp(this, pid, num(m.op, 0)); break;
    }
    if (r) this.err(pid, r);
  }

  private chat(p: Player, m: any) {
    const text = String(m.text ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, LIMITS.chatLength);
    if (!text) return;
    const ch = m.ch === 'a' ? 'a' : 'g';
    const line = { ch, from: p.id, name: p.name, text, tick: this.s.tick } as const;
    if (ch === 'g') {
      this.s.chat.push(line);
      if (this.s.chat.length > 60) this.s.chat.shift();
      this.emit({ e: 'chat', _all: true, ...line });
    } else {
      this.emit({ e: 'chat', _p: [p.id, ...p.allies], ...line });
    }
  }

  // ---- views for the network layer --------------------------------------------------------------
  privateView(p: Player) {
    const r = (v: number) => Math.round(v * 10) / 10;
    const atk = this.s.attacks.filter((a) => a.attacker === p.id).map((a) => [a.id, a.target, Math.round(a.troops), Math.round(a.tanks)]);
    const slots = slotsTotal(p);
    return {
      e: 'me', id: p.id, alive: p.alive ? 1 : 0,
      food: r(p.food), prod: r(p.prod), money: r(p.money), oil: r(p.oil), ura: r(p.uranium),
      pop: Math.round(p.pop), cap: Math.round(p.popCap), troops: Math.round(p.troops), tanks: Math.floor(p.tanks),
      mob: p.mobilization, happy: Math.round(p.happiness), starving: p.starving ? 1 : 0,
      rates: p.rates.map(r), tiles: p.tiles, score: p.score, rank: (p as any)._rank ?? 0,
      stock: p.stock, queue: p.queue, qprog: p.qprog.map(r), levels: p.levels,
      nb: p.btype.map((l) => l.length), slots, used: p.slotsUsed,
      tech: [p.techOff, p.techDef], atk, traitor: p.traitorUntil > this.s.tick ? p.traitorUntil : 0,
      ships: this.s.ships.filter((sh) => sh.owner === p.id && sh.type === U.WARSHIP).length,
      winter: this.s.winter,
      nfl: maxLevel(this, p, B.NUCLEAR_FACILITY),
    };
  }
}

/** Bring snapshots written by older versions up to the current state shape. */
function migrate(s: State) {
  s.operations ??= [];
  for (const f of s.flights) f.tier ??= 0;
  for (const p of s.players) {
    if (!p) continue;
    while (p.stock.length < UNIT_COUNT) p.stock.push(0);
    while (p.queue.length < UNIT_COUNT) p.queue.push(0);
    while (p.qprog.length < UNIT_COUNT) p.qprog.push(0);
  }
}

// small intent helpers that need both buildings and economy
function placeBuildingIntent(g: Game, p: Player, tile: number, type: number): string | null {
  const r = placeBuilding(g, p, tile, type, false);
  return typeof r === 'string' ? r : null;
}

export function buyTech(g: Game, p: Player, which: 'off' | 'def'): string | null {
  const lvl = which === 'off' ? p.techOff : p.techDef;
  if (lvl >= TECH.maxLevel) return 'Max tech level';
  const c = TECH.cost(lvl);
  if (!canAfford(p, c)) return 'Not enough resources';
  pay(p, c);
  if (which === 'off') p.techOff++; else p.techDef++;
  return null;
}

export type { Building };
export { bpack };
