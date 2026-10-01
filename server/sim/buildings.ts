// Buildings: placement, construction, upgrades, capture, destruction.

import {
  B, BUILDINGS, BUILDING_COUNT, BUILDING_SPACING, DEMOLISH_REFUND, EFFECT, ECON, RES, TERRAIN, COMBAT, buildCost, buildTime,
} from '../../shared/balance.ts';
import type { Game } from './game.ts';
import type { Building, Player } from './types.ts';
import { canAfford, pay, refund } from './economy.ts';

export const slotsTotal = (p: Player) => ECON.capitalSlots + p.levels[B.CITY] * EFFECT.citySlots;
export const bpack = (b: Building) => [b.id, b.type, b.tile, b.owner, b.level, b.done];

function emitB(g: Game, b: Building, extra?: number) {
  g.emit({ e: 'b', _at: b.tile, _p: extra ? [b.owner, extra] : [b.owner], b: bpack(b) });
}

export function applyEffect(g: Game, b: Building, sign: number) {
  const p = g.P(b.owner);
  if (!p || b.level <= 0) return;
  p.levels[b.type] += b.level * sign;
  if (b.type === B.FARM) p.farmFood += b.level * TERRAIN[g.map.terrain[b.tile]].farm * sign;
}

export function canPlace(g: Game, p: Player, t: number, type: number): string | null {
  const s = g.s, m = g.map;
  if (!(type > 0 && type < BUILDING_COUNT)) return 'Unknown building';
  const def = BUILDINGS[type];
  if (s.owner[t] !== p.id) return 'Build on your own territory';
  if (!m.isLand(t)) return 'Must build on land';
  if (s.bldAt[t] >= 0) return 'Tile occupied';
  if (s.fallout[t] > 0) return 'Radioactive fallout here';
  if (def.req === 'oil' && m.resource[t] !== RES.OIL) return 'Needs an oil deposit (black dots)';
  if (def.req === 'uranium' && m.resource[t] !== RES.URANIUM) return 'Needs a uranium deposit (green dots)';
  if (def.req === 'coast' && !m.coastal[t]) return 'Shipyards must touch the sea';
  if (type === B.NUCLEAR_FACILITY && !s.settings.nukes) return 'Nukes are disabled in this match';
  if (def.slot && p.slotsUsed >= slotsTotal(p)) return 'No free building slots. Build or upgrade cities';
  const gap = Math.max(1, Math.round(BUILDING_SPACING * m.ms));
  const W = m.W, x0 = t % W, y0 = (t / W) | 0;
  for (let dy = -gap; dy <= gap; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= m.H) continue;
    for (let dx = -gap; dx <= gap; dx++) {
      const x = (x0 + dx + W) % W;
      if (s.bldAt[y * W + x] >= 0) return 'Too close to another building';
    }
  }
  return null;
}

export function placeBuilding(g: Game, p: Player, t: number, type: number, instant: boolean): Building | string {
  const s = g.s;
  if (!instant) {
    const e = canPlace(g, p, t, type);
    if (e) return e;
    const c = buildCost(type, 0, p.btype[type].length);
    if (!canAfford(p, c)) return 'Not enough resources';
    pay(p, c);
  }
  const id = s.freeB.length ? s.freeB.pop()! : s.buildings.length;
  const b: Building = { id, type, tile: t, owner: p.id, level: instant ? 1 : 0, done: instant ? 0 : s.tick + g.secondsToTicks(buildTime(type, 0)) };
  s.buildings[id] = b;
  s.bldAt[t] = id;
  p.btype[type].push(id);
  if (BUILDINGS[type].slot) p.slotsUsed++;
  if (instant) applyEffect(g, b, 1);
  else s.pendingB.push(id);
  emitB(g, b);
  return b;
}

export function upgradeBuilding(g: Game, p: Player, t: number): string | null {
  const s = g.s, id = s.bldAt[t];
  if (id < 0) return 'No building here';
  const b = s.buildings[id]!;
  if (b.owner !== p.id) return 'Not your building';
  if (b.done) return 'Already under construction';
  if (b.level >= BUILDINGS[b.type].maxLevel) return 'Already at max level';
  const c = buildCost(b.type, b.level);
  if (!canAfford(p, c)) return 'Not enough resources';
  pay(p, c);
  b.done = s.tick + g.secondsToTicks(buildTime(b.type, b.level));
  s.pendingB.push(id);
  emitB(g, b);
  return null;
}

export function demolishBuilding(g: Game, p: Player, t: number): string | null {
  const s = g.s, id = s.bldAt[t];
  if (id < 0) return 'No building here';
  const b = s.buildings[id]!;
  if (b.owner !== p.id) return 'Not your building';
  if (p.capital === t) return 'You cannot demolish your capital';
  refund(p, BUILDINGS[b.type].cost, DEMOLISH_REFUND * Math.max(1, b.level));
  destroyBuilding(g, b, 'demolished');
  return null;
}

export function stepBuildings(g: Game) {
  const s = g.s, list = s.pendingB;
  if (!list.length) return;
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const b = s.buildings[list[i]];
    if (!b || !b.done) continue;
    if (b.done > s.tick) { list[w++] = list[i]; continue; }
    applyEffect(g, b, -1);
    b.level++;
    b.done = 0;
    applyEffect(g, b, 1);
    emitB(g, b);
    g.emit({ e: 'built', _to: b.owner, type: b.type, level: b.level, tile: b.tile });
  }
  list.length = w;
}

export function destroyBuilding(g: Game, b: Building, _reason: string) {
  const s = g.s, p = g.P(b.owner);
  applyEffect(g, b, -1);
  if (p) {
    const l = p.btype[b.type], i = l.indexOf(b.id);
    if (i >= 0) l.splice(i, 1);
    if (BUILDINGS[b.type].slot) p.slotsUsed--;
  }
  s.bldAt[b.tile] = -1;
  s.buildings[b.id] = null;
  s.freeB.push(b.id);
  b.done = 0;
  g.emit({ e: 'bx', _at: b.tile, _p: [b.owner], id: b.id, tile: b.tile });
}

export function transferBuilding(g: Game, b: Building, to: number) {
  const from = g.P(b.owner), np = g.P(to);
  if (!np) return;
  applyEffect(g, b, -1);
  if (from) {
    const l = from.btype[b.type], i = l.indexOf(b.id);
    if (i >= 0) l.splice(i, 1);
    if (BUILDINGS[b.type].slot) from.slotsUsed--;
  }
  const old = b.owner;
  b.owner = to;
  np.btype[b.type].push(b.id);
  if (BUILDINGS[b.type].slot) np.slotsUsed++;
  applyEffect(g, b, 1);
  emitB(g, b, old);
}

/** Damage from missiles/bombs: cities lose a level, other buildings are destroyed. */
export function damageBuilding(g: Game, b: Building) {
  const p = g.P(b.owner);
  if (p && p.capital === b.tile) return;
  if (b.type === B.CITY && b.level > 1) {
    applyEffect(g, b, -1);
    b.level--;
    applyEffect(g, b, 1);
    emitB(g, b);
  } else destroyBuilding(g, b, 'destroyed');
}

export function relocateCapital(g: Game, p: Player) {
  let best: Building | null = null;
  for (const id of p.btype[B.CITY]) {
    const b = g.s.buildings[id]!;
    if (b.tile !== p.capital && b.level > 0 && (!best || b.level > best.level)) best = b;
  }
  const old = p.capital;
  if (best) p.capital = best.tile;
  else if (p.owned.length) p.capital = p.owned[g.randInt(p.owned.length)];
  else p.capital = -1;
  if (old >= 0) {
    p.pop *= 1 - COMBAT.capitalLossPop;
    p.happiness = Math.max(0, p.happiness + COMBAT.capitalLossHappy);
    g.emit({ e: 'caplost', _to: p.id, tile: old, now: p.capital });
  }
  g.emit({ e: 'pl', _all: true, p: g.rosterEntry(p) });
}

export function bunkerMult(g: Game, def: Player, t: number): number {
  let m = 1;
  const r = COMBAT.bunkerRange * g.map.ms, r2 = r * r;
  for (const id of def.btype[B.BUNKER]) {
    const b = g.s.buildings[id]!;
    if (b.level > 0 && g.map.dist2(b.tile, t) <= r2) m += COMBAT.bunkerPerLevel * b.level;
  }
  return Math.min(m, COMBAT.bunkerMax);
}

/** Nearest active building of a type, optionally within `maxDist` tiles (map units). */
export function nearestActive(g: Game, p: Player, type: number, t: number, maxDist = Infinity, rangeFn?: (b: Building) => number): Building | null {
  let best: Building | null = null, bd = Infinity;
  for (const id of p.btype[type]) {
    const b = g.s.buildings[id]!;
    if (b.level <= 0) continue;
    const d = g.map.dist(b.tile, t);
    const lim = rangeFn ? rangeFn(b) : maxDist;
    if (d <= lim && d < bd) { bd = d; best = b; }
  }
  return best;
}
