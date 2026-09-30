// Unit production, ships (warships / transports), and flights (missiles, nukes, bombers, interceptors).

import {
  U, UNITS, UNIT_COUNT, BUILDINGS, B, LIMITS, NAVAL, MISSILE, NUKE, AIR, AIRDEF, RADAR, TICK_RATE, COMBAT,
} from '../../shared/balance.ts';
import { REL } from '../../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Player, Ship, Flight } from './types.ts';
import { canAfford, pay, refund } from './economy.ts';
import { getNav } from './nav.ts';
import { nearestActive, destroyBuilding, damageBuilding, relocateCapital } from './buildings.ts';
import { hostileCheck, launchAttack } from './combat.ts';
import { rel, declareWar, adjustOpinion } from './diplomacy.ts';

export const FLIGHT_KIND = { missile: 0, nuke: 1, bomber: 2, return: 3, interceptor: 4 } as const;

// ---- production --------------------------------------------------------------------------------
export function queueUnit(g: Game, p: Player, u: number, n: number): string | null {
  if (!(u >= 0 && u < UNIT_COUNT)) return 'Unknown unit';
  const def = UNITS[u];
  if (u === U.NUKE && !g.s.settings.nukes) return 'Nukes are disabled in this match';
  if (!p.btype[def.building].length) return `Requires a ${BUILDINGS[def.building].name}`;
  n = Math.min(n, LIMITS.maxQueue - p.queue[u]);
  if (n <= 0) return 'Queue is full';
  let k = 0;
  while (k < n && canAfford(p, def.cost)) { pay(p, def.cost); k++; }
  if (!k) return 'Not enough resources';
  p.queue[u] += k;
  return null;
}

export function cancelQueue(g: Game, p: Player, u: number) {
  if (!(u >= 0 && u < UNIT_COUNT) || p.queue[u] <= 0) return;
  p.queue[u]--;
  refund(p, UNITS[u].cost, 1);
  if (!p.queue[u]) p.qprog[u] = 0;
}

export function stepProduction(g: Game, p: Player, dt: number) {
  for (let u = 0; u < UNIT_COUNT; u++) {
    if (p.queue[u] <= 0) continue;
    const rate = p.levels[UNITS[u].building];
    if (rate <= 0) continue;
    p.qprog[u] += dt * rate;
    const time = UNITS[u].time;
    while (p.qprog[u] >= time && p.queue[u] > 0) {
      p.qprog[u] -= time;
      p.queue[u]--;
      deliver(g, p, u);
    }
    if (!p.queue[u]) p.qprog[u] = 0;
  }
}

function deliver(g: Game, p: Player, u: number) {
  if (u === U.TANK) p.tanks++;
  else if (u === U.WARSHIP) { if (!spawnShip(g, p, U.WARSHIP, -1, [], 0, 0, -1)) p.stock[u]++; }
  else p.stock[u]++;
  if (u >= U.WARSHIP) g.emit({ e: 'unit', _to: p.id, u });
}

// ---- ships ---------------------------------------------------------------------------------------
function waterNear(g: Game, t: number): number {
  const m = g.map, nb = new Int32Array(4);
  m.n4(t, nb);
  for (let k = 0; k < 4; k++) if (nb[k] >= 0 && m.isWater(nb[k])) return nb[k];
  let best = -1;
  m.forRadius(t, 2, (u) => { if (best < 0 && m.isWater(u)) best = u; });
  return best;
}

function spawnShip(g: Game, p: Player, type: number, from: number, path: number[], troops: number, tanks: number, dest: number): Ship | null {
  let start = from;
  if (start < 0) {
    const yards = p.btype[B.SHIPYARD].map((id) => g.s.buildings[id]!).filter((b) => b.level > 0);
    if (!yards.length) return null;
    start = waterNear(g, yards[g.randInt(yards.length)].tile);
    if (start < 0) return null;
  }
  const sh: Ship = {
    id: g.id(), type, owner: p.id, tile: start, path: path.length ? path : [start], pi: 0, prog: 0,
    hp: type === U.WARSHIP ? NAVAL.warshipHp : NAVAL.transportHp, troops, tanks, dest,
  };
  g.s.ships.push(sh);
  p.ships++;
  return sh;
}

export function moveWarships(g: Game, p: Player, tile: number): string | null {
  const m = g.map;
  let target = tile;
  if (!m.isWater(target)) {
    target = waterNear(g, tile);
    if (target < 0) return 'Pick a water tile';
  }
  const body = m.waterBody[target];
  const nav = getNav(m);
  let moved = 0, any = 0;
  for (const sh of g.s.ships) {
    if (sh.owner !== p.id || sh.type !== U.WARSHIP || sh.hp <= 0) continue;
    any++;
    if (m.waterBody[sh.tile] !== body || moved >= 40) continue;
    const path = nav.path(sh.tile, target);
    if (!path) continue;
    sh.path = path; sh.pi = 0; sh.prog = 0;
    moved++;
  }
  if (!any) return 'You have no warships. Build them at a shipyard.';
  if (!moved) return 'None of your warships can reach that sea';
  return null;
}

export function invade(g: Game, p: Player, tile: number, frac: number): string | null {
  const s = g.s, m = g.map;
  if (!m.isLand(tile)) return 'Pick a coastal land tile to invade';
  const target = s.owner[tile];
  if (target === p.id) return 'That is already yours';
  if (p.stock[U.TRANSPORT] < 1) return 'No transports. Build one at a shipyard.';
  const yards = p.btype[B.SHIPYARD].map((id) => s.buildings[id]!).filter((b) => b.level > 0);
  if (!yards.length) return 'You need a shipyard';
  // candidate beaches near the tapped tile
  const cands: { t: number; d: number }[] = [];
  m.forRadius(tile, Math.max(3, NAVAL.landingSearch * m.ms), (t, d2) => {
    if (m.coastal[t] && m.isLand(t) && s.owner[t] !== p.id) cands.push({ t, d: d2 });
  });
  if (!cands.length) return 'No beach near that spot';
  cands.sort((a, b) => a.d - b.d);
  const nav = getNav(m);
  const ys = yards.map((b) => ({ b, w: waterNear(g, b.tile) })).filter((y) => y.w >= 0);
  let found: { path: number[]; land: number } | null = null;
  for (const c of cands.slice(0, 6)) {
    const wl = waterNear(g, c.t);
    if (wl < 0) continue;
    const opts = ys.filter((y) => m.waterBody[y.w] === m.waterBody[wl]).sort((a, b) => m.dist2(a.w, wl) - m.dist2(b.w, wl));
    for (const y of opts.slice(0, 2)) {
      const path = nav.path(y.w, wl);
      if (path) { found = { path, land: c.t }; break; }
    }
    if (found) break;
  }
  if (!found) return 'None of your shipyards can reach that coast';
  const landOwner = s.owner[found.land];
  if (landOwner) {
    const hc = hostileCheck(g, p.id, landOwner);
    if (hc) return hc;
  }
  const troops = p.troops * frac, tanks = Math.floor(p.tanks * frac);
  if (troops < COMBAT.minAttackTroops) return 'Not enough troops';
  p.troops -= troops;
  p.tanks -= tanks;
  p.stock[U.TRANSPORT]--;
  spawnShip(g, p, U.TRANSPORT, found.path[0], found.path, troops, tanks, found.land);
  if (landOwner) g.emit({ e: 'warn', _to: landOwner, kind: 'naval', from: p.id, tile: found.land });
  return null;
}

export function sinkShipsOf(g: Game, pid: number) {
  for (const sh of g.s.ships) if (sh.owner === pid) sh.hp = 0;
}

export function stepShips(g: Game) {
  const s = g.s, m = g.map, dt = g.dt;
  if (!s.ships.length) return;
  let w = 0;
  for (let i = 0; i < s.ships.length; i++) {
    const sh = s.ships[i];
    const p = g.P(sh.owner);
    if (sh.hp <= 0 || !p || !p.alive) {
      if (p) p.ships--;
      if (sh.hp <= 0 && p && p.alive) g.emit({ e: 'sunk', _at: sh.tile, _p: [sh.owner], tile: sh.tile, type: sh.type });
      continue;
    }
    if (sh.pi < sh.path.length - 1) {
      sh.prog += (sh.type === U.WARSHIP ? NAVAL.warshipSpeed : NAVAL.transportSpeed) * m.ms * dt;
      while (sh.prog >= 1 && sh.pi < sh.path.length - 1) { sh.pi++; sh.prog -= 1; }
      sh.tile = sh.path[sh.pi];
    } else if (sh.type === U.TRANSPORT) {
      land(g, p, sh);
      p.ships--;
      continue;
    }
    s.ships[w++] = sh;
  }
  s.ships.length = w;
  if (s.tick % 2 === 0) navalCombat(g, dt * 2);
  if (s.tick % TICK_RATE === 0) bombard(g, dt * TICK_RATE);
}

function land(g: Game, p: Player, sh: Ship) {
  const s = g.s;
  const o = s.owner[sh.dest];
  const back = () => { p.troops += sh.troops; p.tanks += sh.tanks; };
  if (o === p.id) return back();
  if (o) {
    const r = rel(g, p.id, o);
    if (r === REL.ALLY || r === REL.NAP) return back();
  }
  const err = launchAttack(g, p.id, o, 0, sh.dest, sh.dest, { troops: sh.troops, tanks: sh.tanks });
  if (err) back();
  g.emit({ e: 'land', _at: sh.dest, _p: [p.id, o], tile: sh.dest, by: p.id });
}

function navalCombat(g: Game, dt: number) {
  const s = g.s, m = g.map, ships = s.ships;
  const r2 = (NAVAL.warshipRange * m.ms) ** 2;
  for (const a of ships) {
    if (a.type !== U.WARSHIP || a.hp <= 0) continue;
    let best: Ship | null = null, bd = r2;
    for (const b of ships) {
      if (b.owner === a.owner || b.hp <= 0) continue;
      const d = m.dist2(a.tile, b.tile);
      if (d > bd) continue;
      if (rel(g, a.owner, b.owner) !== REL.WAR) continue;
      bd = d; best = b;
    }
    if (best) {
      best.hp -= NAVAL.warshipDps * dt;
      if (best.hp <= 0) {
        const killer = g.P(a.owner);
        if (killer) killer.stats.kills++;
      }
    }
  }
}

function bombard(g: Game, dt: number) {
  const s = g.s, m = g.map;
  for (const sh of s.ships) {
    if (sh.type !== U.WARSHIP || sh.hp <= 0 || sh.pi < sh.path.length - 1) continue;
    let target = 0;
    m.forRadius(sh.tile, NAVAL.warshipRange * m.ms, (t) => {
      if (target) return;
      const o = s.owner[t];
      if (o && o !== sh.owner && rel(g, sh.owner, o) === REL.WAR) target = o;
    });
    if (target) {
      const q = g.P(target)!;
      q.troops = Math.max(0, q.troops - NAVAL.bombardDps * dt);
    }
  }
}

// ---- flights --------------------------------------------------------------------------------------
function addFlight(g: Game, kind: Flight['kind'], owner: number, from: number, to: number, ticks: number, ref = -1): Flight {
  const s = g.s;
  const f: Flight = { id: g.id(), kind, owner, from, to, t0: s.tick, t1: s.tick + Math.max(1, Math.round(ticks)), ref, dead: false };
  s.flights.push(f);
  return f;
}
const fpack = (f: Flight) => [f.id, FLIGHT_KIND[f.kind], f.owner, f.from, f.to, f.t0, f.t1, f.ref];
export { fpack };

function flightTicks(g: Game, dist: number, speed: number, extra: number) {
  return ((dist / (speed * g.map.ms) + extra) * TICK_RATE) / g.speed;
}

export function launchMissile(g: Game, p: Player, tile: number): string | null {
  const s = g.s, m = g.map;
  if (p.stock[U.MISSILE] < 1) return 'No missiles ready. Build them at a Missile Silo.';
  const silo = nearestActive(g, p, B.MISSILE_SILO, tile, Infinity, (b) => (MISSILE.range + (b.level - 1) * MISSILE.rangePerLevel) * m.ms);
  if (!silo) return p.btype[B.MISSILE_SILO].length ? 'Target is out of range of your silos' : 'You need a Missile Silo';
  const target = s.owner[tile];
  if (target === p.id) return 'Cannot target your own territory';
  const hc = hostileCheck(g, p.id, target);
  if (hc) return hc;
  p.stock[U.MISSILE]--;
  const f = addFlight(g, 'missile', p.id, silo.tile, tile, flightTicks(g, m.dist(silo.tile, tile), MISSILE.speed, 0.8));
  g.emit({ e: 'fl', _at: tile, _p: [p.id, target], f: fpack(f) });
  if (target) g.emit({ e: 'warn', _to: target, kind: 'missile', from: p.id, tile });
  return null;
}

export function launchBomber(g: Game, p: Player, tile: number): string | null {
  const s = g.s, m = g.map;
  if (p.stock[U.BOMBER] < 1) return 'No bombers available. Build them at an Airbase.';
  const base = nearestActive(g, p, B.AIRBASE, tile, AIR.bomberRange * m.ms);
  if (!base) return p.btype[B.AIRBASE].length ? 'Target is out of bomber range' : 'You need an Airbase';
  const target = s.owner[tile];
  if (target === p.id) return 'Cannot bomb your own territory';
  const hc = hostileCheck(g, p.id, target);
  if (hc) return hc;
  p.stock[U.BOMBER]--;
  const f = addFlight(g, 'bomber', p.id, base.tile, tile, flightTicks(g, m.dist(base.tile, tile), AIR.bomberSpeed, 0.5), base.tile);
  g.emit({ e: 'fl', _at: tile, _p: [p.id, target], f: fpack(f) });
  if (target) g.emit({ e: 'warn', _to: target, kind: 'bomber', from: p.id, tile });
  return null;
}

export function launchNuke(g: Game, p: Player, tile: number): string | null {
  const s = g.s;
  if (!s.settings.nukes) return 'Nukes are disabled in this match';
  if (p.stock[U.NUKE] < 1) return 'No nuke ready. Build one at a Nuclear Facility.';
  const silo = nearestActive(g, p, B.MISSILE_SILO, tile);
  if (!silo) return 'You need a Missile Silo to launch';
  const target = s.owner[tile];
  if (target === p.id) return 'Cannot nuke your own territory';
  const hc = hostileCheck(g, p.id, target);
  if (hc) return hc;
  p.stock[U.NUKE]--;
  p.stats.nukes++;
  const f = addFlight(g, 'nuke', p.id, silo.tile, tile, NUKE.flightSeconds * TICK_RATE);
  g.emit({ e: 'fl', _all: true, f: fpack(f) });
  g.emit({ e: 'nl', _all: true, id: f.id, o: p.id, tile, target, t1: f.t1 });
  // diplomatic fallout
  for (const q of s.players) {
    if (!q || q.human || !q.alive || q.id === p.id) continue;
    adjustOpinion(g, q.id, p.id, q.id === target ? NUKE.aiOpinionVictim : NUKE.aiOpinionAll);
    if (target && (q.allies.includes(target)) && rel(g, q.id, p.id) !== REL.WAR && g.rand() < 0.6) declareWar(g, q.id, p.id, true);
  }
  return null;
}

export function interceptNuke(g: Game, p: Player, id: number): string | null {
  const s = g.s, m = g.map;
  const f = s.flights.find((x) => x.id === id && x.kind === 'nuke' && !x.dead);
  if (!f) return 'That warhead is gone';
  if (f.owner === p.id) return 'That is your own warhead';
  if (p.stock[U.MISSILE] < 1) return 'Intercepting needs a conventional missile in stock';
  if (s.tick > f.t1 - 2 * TICK_RATE) return 'Too late to intercept!';
  const silo = nearestActive(g, p, B.MISSILE_SILO, f.to, Infinity, (b) => (MISSILE.range + (b.level - 1) * MISSILE.rangePerLevel) * m.ms * NUKE.manualRangeMult);
  if (!silo) return 'No silo within range of the impact point';
  p.stock[U.MISSILE]--;
  const x = addFlight(g, 'interceptor', p.id, silo.tile, f.to, Math.min(1.6 * TICK_RATE, f.t1 - s.tick - 2), f.id);
  g.emit({ e: 'fl', _all: true, f: fpack(x) });
  return null;
}

export function stepFlights(g: Game) {
  const s = g.s;
  if (!s.flights.length) return;
  const due: Flight[] = [];
  let w = 0;
  for (const f of s.flights) {
    if (f.dead) continue;
    if (f.t1 <= s.tick) due.push(f);
    else s.flights[w++] = f;
  }
  s.flights.length = w;
  // interceptors resolve before warheads
  due.sort((a, b) => (a.kind === 'interceptor' ? -1 : 0) - (b.kind === 'interceptor' ? -1 : 0));
  for (const f of due) resolve(g, f);
}

function defendersOf(g: Game, tile: number): number[] {
  const o = g.s.owner[tile];
  if (!o) return [];
  const p = g.P(o)!;
  return [o, ...p.allies];
}

function radarNear(g: Game, q: Player, tile: number): boolean {
  for (const id of q.btype[B.RADAR]) {
    const b = g.s.buildings[id]!;
    if (b.level > 0 && g.map.dist(b.tile, tile) <= (RADAR.range + (b.level - 1) * RADAR.perLevel) * g.map.ms) return true;
  }
  return false;
}

function adIntercept(g: Game, tile: number, kind: 'missile' | 'nuke' | 'bomber'): boolean {
  const m = g.map;
  for (const d of defendersOf(g, tile)) {
    const q = g.P(d);
    if (!q || !q.alive || !q.btype[B.AIR_DEFENSE].length) continue;
    const radar = radarNear(g, q, tile) ? AIRDEF.radarBonus : 0;
    for (const id of q.btype[B.AIR_DEFENSE]) {
      const b = g.s.buildings[id]!;
      if (b.level <= 0) continue;
      if (m.dist(b.tile, tile) > (AIRDEF.range + (b.level - 1) * AIRDEF.rangePerLevel) * m.ms) continue;
      const base = kind === 'missile' ? AIRDEF.missile : kind === 'bomber' ? AIRDEF.bomber : NUKE.autoIntercept;
      const chance = kind === 'nuke' ? base * b.level + radar * 0.5 : base + AIRDEF.perLevel * (b.level - 1) + radar;
      if (g.rand() < chance) return true;
    }
  }
  return false;
}

function resolve(g: Game, f: Flight) {
  const s = g.s, m = g.map;
  const owner = s.owner[f.to];
  switch (f.kind) {
    case 'interceptor': {
      const n = s.flights.find((x) => x.id === f.ref && !x.dead);
      if (!n) return;
      const ok = g.rand() < NUKE.manualIntercept + (radarNear(g, g.P(f.owner)!, n.to) ? AIRDEF.radarBonus : 0);
      if (ok) {
        n.dead = true;
        g.emit({ e: 'hit', _all: true, id: n.id, tile: n.to, x: 1, k: 1, by: f.owner });
      }
      g.emit({ e: 'ic', _all: true, id: n.id, ok: ok ? 1 : 0, by: f.owner });
      return;
    }
    case 'missile': {
      if (adIntercept(g, f.to, 'missile')) { g.emit({ e: 'hit', _at: f.to, _p: [f.owner, owner], id: f.id, tile: f.to, x: 1, k: 0 }); return; }
      impact(g, f.owner, f.to, MISSILE.radius * m.ms, MISSILE.troopKill, MISSILE.flatKill, 0);
      g.emit({ e: 'hit', _at: f.to, _p: [f.owner, owner], id: f.id, tile: f.to, x: 0, k: 0, r: MISSILE.radius * m.ms });
      return;
    }
    case 'bomber': {
      let shot = adIntercept(g, f.to, 'bomber');
      if (!shot) {
        for (const d of defendersOf(g, f.to)) {
          const q = g.P(d)!;
          const fighters = q.stock[U.FIGHTER];
          if (!fighters) continue;
          const bases = q.btype[B.AIRBASE].map((id) => s.buildings[id]!).filter((b) => b.level > 0);
          if (!bases.length) continue;
          const near = bases.filter((b) => m.dist(b.tile, f.to) <= AIR.fighterRange * m.ms).length;
          const eff = (fighters * near) / bases.length;
          const chance = Math.min(AIR.interceptMax, 1 - (1 - AIR.fighterIntercept) ** eff);
          if (g.rand() < chance) { shot = true; break; }
        }
      }
      if (shot) { g.emit({ e: 'hit', _at: f.to, _p: [f.owner, owner], id: f.id, tile: f.to, x: 1, k: 2 }); return; }
      impact(g, f.owner, f.to, AIR.bombRadius * m.ms, 1.5, AIR.bombKill / 8, 2);
      g.emit({ e: 'hit', _at: f.to, _p: [f.owner, owner], id: f.id, tile: f.to, x: 0, k: 2, r: AIR.bombRadius * m.ms });
      const r = addFlight(g, 'return', f.owner, f.to, f.ref, flightTicks(g, m.dist(f.to, f.ref), AIR.bomberSpeed, 0.3));
      g.emit({ e: 'fl', _at: f.to, _p: [f.owner], f: fpack(r) });
      return;
    }
    case 'return': {
      const p = g.P(f.owner);
      if (p && p.alive) p.stock[U.BOMBER]++;
      return;
    }
    case 'nuke': {
      if (adIntercept(g, f.to, 'nuke')) {
        g.emit({ e: 'hit', _all: true, id: f.id, tile: f.to, x: 1, k: 1 });
        g.emit({ e: 'ic', _all: true, id: f.id, ok: 1, by: owner });
        return;
      }
      detonate(g, f);
      return;
    }
  }
}

function impact(g: Game, launcher: number, center: number, R: number, killMult: number, flatPerTile: number, kind: number) {
  const s = g.s, m = g.map;
  const counts = new Map<number, number>();
  const blds: number[] = [];
  m.forRadius(center, R, (t) => {
    if (m.isWater(t)) return;
    const o = s.owner[t];
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
    if (s.bldAt[t] >= 0) blds.push(s.bldAt[t]);
  });
  for (const id of blds) { const b = s.buildings[id]; if (b) damageBuilding(g, b); }
  for (const [o, c] of counts) {
    const q = g.P(o)!;
    const frac = Math.min(0.5, (killMult * c) / Math.max(1, q.tiles));
    const loss = q.troops * frac + flatPerTile * c * m.as;
    q.troops = Math.max(0, q.troops - loss);
    q.recentLoss += c * 0.5;
  }
  const r2 = R * R;
  for (const sh of s.ships) if (sh.owner !== launcher && m.dist2(sh.tile, center) <= r2) sh.hp -= kind === 2 ? 40 : 70;
}

function detonate(g: Game, f: Flight) {
  const s = g.s, m = g.map;
  const R = NUKE.radius * m.ms, inner2 = (R * NUKE.innerFrac) ** 2;
  const counts = new Map<number, number>();
  const tiles: number[] = [], d2s: number[] = [];
  m.forRadius(f.to, R, (t, d2) => {
    if (m.isWater(t)) return;
    tiles.push(t); d2s.push(d2);
    const o = s.owner[t];
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  });
  for (const [o, c] of counts) {
    const q = g.P(o)!;
    const frac = Math.min(1, (NUKE.killMult * c) / Math.max(1, q.tiles));
    q.troops *= 1 - frac;
    q.tanks *= 1 - frac;
    q.pop *= 1 - frac * 0.8;
    q.recentLoss += c;
  }
  // inner zone is wiped clean (buildings go with the tile)
  for (let i = 0; i < tiles.length; i++) if (d2s[i] <= inner2) g.setOwner(tiles[i], 0);
  // outer ring buildings destroyed
  for (let i = 0; i < tiles.length; i++) {
    const id = s.bldAt[tiles[i]];
    if (id < 0) continue;
    const b = s.buildings[id]!;
    const q = g.P(b.owner);
    const wasCap = q && q.capital === b.tile;
    destroyBuilding(g, b, 'nuked');
    if (q && wasCap) relocateCapital(g, q);
  }
  for (let i = 0; i < tiles.length; i++) g.setFallout(tiles[i], d2s[i] <= inner2 ? NUKE.falloutSeconds : NUKE.falloutSeconds * 0.6);
  const r2 = R * R;
  for (const sh of s.ships) if (m.dist2(sh.tile, f.to) <= r2) sh.hp = 0;
  s.winter++;
  g.emit({ e: 'nuke', _all: true, id: f.id, tile: f.to, r: R, by: f.owner, fall: NUKE.falloutSeconds });
  if (s.settings.nuclearWinter && s.winter > NUKE.winterThreshold) g.emit({ e: 'winter', _all: true, v: s.winter });
  for (const [o] of counts) {
    const q = g.P(o)!;
    if (q.alive && q.tiles === 0) g.eliminate(q, f.owner);
  }
}
