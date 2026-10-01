// AI nations (PvE). Each AI "thinks" every ~2s (staggered so 500 of them never spike one tick).
// A think samples the border to learn its neighbourhood, then makes at most one economic decision,
// sets mobilisation, and decides on expansion / war / naval / strategic strikes / diplomacy.

import { AI, B, U, BUILDINGS, TICK_RATE, TECH, TERRAIN, RES, buildCost, unitCost, type Cost } from '../../shared/balance.ts';
import { REL } from '../../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Player } from './types.ts';
import { launchAttack, effTroops } from './combat.ts';
import { canPlace, placeBuilding, upgradeBuilding, slotsTotal } from './buildings.ts';
import { canAfford } from './economy.ts';
import { queueUnit, invade, launchMissile, launchNuke, launchBomber, moveWarships, maxLevel, unitHave } from './units.ts';
import { aiLeadOp } from './ops.ts';
import { rel, propose, breakTreaty, opinion } from './diplomacy.ts';
import { buyTech } from './game.ts';

export function setupAI(g: Game, p: Player) {
  p.ai = { next: g.s.tick + 1 + g.randInt(Math.round(AI.thinkSeconds[p.diff] * TICK_RATE)), lastWar: 0, lastNaval: 0, lastDiplo: 0, focus: 0 };
  p.mobilization = AI.mobilization[p.diff];
}

const nb = new Int32Array(4);

export function aiThink(g: Game, p: Player) {
  if (!p.spawned || !p.alive) return;
  const s = g.s, m = g.map;
  // --- neighbourhood scan
  const counts = new Map<number, number>();
  let neutral = 0;
  const border = p.border, n = border.length, samples = Math.min(n, 48);
  for (let i = 0; i < samples; i++) {
    const t = border[n <= 48 ? i : g.randInt(n)];
    m.n4(t, nb);
    for (let k = 0; k < 4; k++) {
      const q = nb[k];
      if (q < 0 || !m.isLand(q)) continue;
      const o = s.owner[q];
      if (o === p.id) continue;
      if (!o) neutral++;
      else counts.set(o, (counts.get(o) ?? 0) + 1);
    }
  }
  let atWar = false;
  for (const o of counts.keys()) if (rel(g, p.id, o) === REL.WAR) { atWar = true; break; }
  p.mobilization = Math.min(0.7, AI.mobilization[p.diff] + (atWar ? 0.12 : 0));

  economy(g, p, counts, neutral, atWar);
  military(g, p, counts, neutral);
  if (s.tick - p.ai!.lastDiplo > 15 * TICK_RATE) { p.ai!.lastDiplo = s.tick; diplomacy(g, p, counts); }
}

// ---- economy --------------------------------------------------------------------------------------
function economy(g: Game, p: Player, counts: Map<number, number>, neutral: number, atWar: boolean) {
  const d = p.diff, m = g.map, s0 = g.s;
  const total = p.pop + p.troops;
  const free = slotsTotal(p) - p.slotsUsed;
  const want: number[] = [];
  const nCity = p.btype[B.CITY].length;
  if (p.rates[0] < 0.5 + total * 0.00015 || (p.food < 150 && p.rates[0] < 3)) want.push(B.FARM);
  if (total > p.popCap * 0.8 || free <= 1) want.push(B.CITY);
  if (p.btype[B.BARRACKS].length < 1 + Math.floor((p.tiles * m.as) / 700)) want.push(B.BARRACKS);
  if (p.btype[B.FACTORY].length < 1 + nCity) want.push(B.FACTORY);
  if (p.btype[B.OIL_WELL].length < 3) want.push(B.OIL_WELL);
  if (d === 2) {
    if (!p.btype[B.TANK_FACTORY].length && p.money > 900) want.push(B.TANK_FACTORY);
    if (!p.btype[B.MISSILE_SILO].length && p.money > 3000 && p.tiles * m.as > 600) want.push(B.MISSILE_SILO);
    if (!p.btype[B.AIRBASE].length && p.money > 2500 && p.tiles * m.as > 900) want.push(B.AIRBASE);
    if (p.btype[B.MISSILE_SILO].length && !p.btype[B.NUCLEAR_FACILITY].length && p.tiles * m.as > 1500) want.push(B.URANIUM_MINE, B.NUCLEAR_FACILITY);
  } else if (d === 1) {
    if (atWar && p.btype[B.BUNKER].length < 1 + nCity) want.push(B.BUNKER);
    if (!p.btype[B.TANK_FACTORY].length && p.money > 1500 && p.tiles * m.as > 400) want.push(B.TANK_FACTORY);
    if (!p.btype[B.AIR_DEFENSE].length && p.money > 2000 && p.tiles * m.as > 700) want.push(B.AIR_DEFENSE);
    if (!p.btype[B.RADAR].length && p.money > 2500 && p.tiles * m.as > 900) want.push(B.RADAR);
  }
  if (!neutral && counts.size === 0 && !p.btype[B.SHIPYARD].length) want.push(B.SHIPYARD);
  if (d > 0 && !p.btype[B.SHIPYARD].length && p.money > 2000 && g.rand() < 0.1) want.push(B.SHIPYARD);
  // rich nations diversify into strategic infrastructure
  if (p.money > 6000) {
    if (d === 2) want.push(B.MISSILE_SILO, B.AIRBASE, B.TANK_FACTORY, B.URANIUM_MINE, B.NUCLEAR_FACILITY);
    else if (d === 1) want.push(B.AIR_DEFENSE, B.RADAR, B.BUNKER, B.TANK_FACTORY, B.MISSILE_SILO);
    else want.push(B.AIR_DEFENSE, B.CITY, B.FACTORY, B.TANK_FACTORY);
  }
  if (p.money > 30000) {
    want.push(B.TANK_FACTORY, B.MISSILE_SILO, B.AIR_DEFENSE, B.URANIUM_MINE, B.NUCLEAR_FACILITY);
    if (d > 0) want.push(B.AIRBASE);
  }

  // the first (most urgent) want keeps its place, the rest are tried in random order
  for (let i = want.length - 1; i > 1; i--) { const j = 1 + g.randInt(i); const tmp = want[i]; want[i] = want[j]; want[j] = tmp; }
  const maxBuilds = 1 + Math.min(3, Math.floor(p.money / 5000));
  let built = 0, slotsLeft = free;
  for (const type of want) {
    if (built >= maxBuilds) break;
    if (type === B.NUCLEAR_FACILITY && (p.btype[type].length || !p.btype[B.MISSILE_SILO].length || !s0.settings.nukes)) continue;
    if ((type === B.MISSILE_SILO || type === B.AIRBASE || type === B.RADAR || type === B.TANK_FACTORY) && p.btype[type].length >= 1 + Math.floor(p.tiles * m.as / 4000)) continue;
    // each extra copy costs more, so upgrading an existing one is often the better deal
    const fresh = buildCost(type, 0, p.btype[type].length);
    const up = cheapestUpgrade(g, p, type);
    if (up && (up.cost.money ?? 0) <= (fresh.money ?? 0) && canAfford(p, up.cost)) {
      if (!upgradeBuilding(g, p, up.tile)) { built++; continue; }
    }
    if (BUILDINGS[type].slot && slotsLeft <= 0) continue;
    if (!canAfford(p, fresh)) continue;
    const t = pickSite(g, p, type, counts);
    if (t < 0) continue;
    if (typeof placeBuilding(g, p, t, type, false) !== 'string') { built++; if (BUILDINGS[type].slot) slotsLeft--; }
  }
  // upgrades when rich
  if (!built && p.money > 2500 + p.tiles * 0.5) {
    const types = [B.CITY, B.FARM, B.FACTORY, B.BARRACKS, B.OIL_WELL];
    const up = cheapestUpgrade(g, p, types[g.randInt(types.length)]);
    if (up && canAfford(p, up.cost)) upgradeBuilding(g, p, up.tile);
  }
  // a rich nuclear power upgrades its facility to unlock the mega nuke
  if (p.money > 40000 && d > 0) {
    const up = cheapestUpgrade(g, p, B.NUCLEAR_FACILITY);
    if (up && canAfford(p, up.cost)) upgradeBuilding(g, p, up.tile);
  }
  // tech
  if (g.rand() < AI.techChance[d] * 0.3) {
    const which = d === 1 ? 'def' : d === 2 ? 'off' : g.rand() < 0.5 ? 'off' : 'def';
    const lvl = which === 'off' ? p.techOff : p.techDef;
    const c = TECH.cost(lvl);
    if (lvl < TECH.maxLevel && p.money > (c.money ?? 0) * 2 && p.prod > (c.prod ?? 0) * 1.5) buyTech(g, p, which);
  }
  // units
  // armour turns surplus money into strength without costing population
  if (p.btype[B.TANK_FACTORY].length && p.money > 1200 && p.queue[U.TANK] < 4) queueUnit(g, p, U.TANK, Math.min(10, 2 + Math.floor(p.money / 8000)));
  if (p.btype[B.MISSILE_SILO].length && p.money > 2500 && p.stock[U.MISSILE] + p.queue[U.MISSILE] < 2 + (p.money > 50000 ? 3 : 0)) queueUnit(g, p, U.MISSILE, 1);
  if (p.btype[B.NUCLEAR_FACILITY].length && p.stock[U.NUKE] + p.queue[U.NUKE] < (d === 2 ? 2 : 1) && canAfford(p, unitCost(U.NUKE, unitHave(p, U.NUKE)))) queueUnit(g, p, U.NUKE, 1);
  if (d > 0 && maxLevel(g, p, B.NUCLEAR_FACILITY) >= 2 && unitHave(p, U.MEGA_NUKE) < 1 && canAfford(p, unitCost(U.MEGA_NUKE, 0))) queueUnit(g, p, U.MEGA_NUKE, 1);
  if (p.btype[B.AIRBASE].length && p.money > 1500) {
    if (p.stock[U.FIGHTER] + p.queue[U.FIGHTER] < 2 + d) queueUnit(g, p, U.FIGHTER, 1);
    else if (d === 2 && p.stock[U.BOMBER] + p.queue[U.BOMBER] < 2) queueUnit(g, p, U.BOMBER, 1);
  }
  if (p.btype[B.SHIPYARD].length) {
    if (p.stock[U.TRANSPORT] + p.queue[U.TRANSPORT] < 1 + (d === 2 ? 1 : 0)) queueUnit(g, p, U.TRANSPORT, 1);
    if (d > 0 && p.money > 3500 && p.ships + p.queue[U.WARSHIP] < d * 2) queueUnit(g, p, U.WARSHIP, 1);
  }
}

/** The cheapest idle building of a type that can still be upgraded. */
function cheapestUpgrade(g: Game, p: Player, type: number): { tile: number; cost: Cost } | null {
  let best: { tile: number; cost: Cost } | null = null;
  for (const id of p.btype[type]) {
    const b = g.s.buildings[id]!;
    if (b.done || b.level <= 0 || b.level >= BUILDINGS[type].maxLevel) continue;
    const c = buildCost(type, b.level);
    if (!best || (c.money ?? 0) < (best.cost.money ?? 0)) best = { tile: b.tile, cost: c };
  }
  return best;
}

function pickSite(g: Game, p: Player, type: number, counts: Map<number, number>): number {
  const s = g.s, m = g.map, owned = p.owned;
  if (!owned.length) return -1;
  let best = -1, bs = -Infinity;
  const tries = type === B.OIL_WELL || type === B.URANIUM_MINE ? 80 : 26;
  const fromBorder = type === B.BUNKER;
  for (let i = 0; i < tries; i++) {
    const pool = fromBorder && p.border.length ? p.border : owned;
    const t = pool[g.randInt(pool.length)];
    if (type === B.OIL_WELL && m.resource[t] !== RES.OIL) continue;
    if (type === B.URANIUM_MINE && m.resource[t] !== RES.URANIUM) continue;
    if (type === B.SHIPYARD && !m.coastal[t]) continue;
    if (canPlace(g, p, t, type)) continue;
    let sc = g.rand();
    if (type === B.FARM) sc += TERRAIN[m.terrain[t]].farm * 2;
    else if (type === B.CITY) {
      let dmin = 1e9;
      for (const id of p.btype[B.CITY]) dmin = Math.min(dmin, m.dist2(t, s.buildings[id]!.tile));
      sc += Math.sqrt(dmin) / m.ms + (s.borderPos[t] >= 0 ? -20 : 0);
    } else if (type === B.BUNKER) {
      m.n4(t, nb);
      for (let k = 0; k < 4; k++) { const o = nb[k] >= 0 ? s.owner[nb[k]] : 0; if (o && o !== p.id && counts.has(o)) sc += 3; }
    } else if (s.borderPos[t] >= 0) sc -= 2; // keep infrastructure away from the front
    if (sc > bs) { bs = sc; best = t; }
  }
  return best;
}

// ---- military -------------------------------------------------------------------------------------
function military(g: Game, p: Player, counts: Map<number, number>, neutral: number) {
  const s = g.s, d = p.diff, ai = p.ai!;
  let atkNeutral = 0, atkTotal = 0;
  const atkOn = new Map<number, number>();
  for (const a of s.attacks) {
    if (a.attacker !== p.id) continue;
    atkTotal += a.troops;
    if (!a.target) atkNeutral += a.troops;
    else atkOn.set(a.target, (atkOn.get(a.target) ?? 0) + a.troops);
  }
  const myEff = effTroops(p);
  // expansion into unclaimed land
  if (neutral > 0 && p.troops > 120 && atkNeutral < p.troops * 0.15) {
    launchAttack(g, p.id, 0, AI.expandFrac[d] * (ai.focus && counts.has(ai.focus) ? 0.6 : 1), -1);
  }
  if (g.peace) return;
  // wars. An army at full strength sitting idle makes AIs restless.
  const saturated = p.troops >= 0.9 * p.mobilization * (p.pop + p.troops);
  const warChance = AI.warChance[d] * (saturated ? 2 : 1);
  let best = 0, bestScore = 0;
  for (const [o, c] of counts) {
    const q = g.P(o);
    if (!q || !q.alive) continue;
    const r = rel(g, p.id, o);
    const ratio = (myEff + atkTotal * 0.5) / (effTroops(q) + 50);
    if (r === REL.ALLY || r === REL.NAP) {
      if (d === 2 && ratio > 4 && g.rand() < 0.004) breakTreaty(g, p.id, o);
      continue;
    }
    let need = AI.attackRatio[d] * (r === REL.WAR ? 0.75 : 1) * (neutral > 0 ? 1.4 : 1) * (saturated ? 0.8 : 1);
    if (ai.focus === o) need *= 0.7; // they attacked us: strike back more readily
    if (ratio < need) continue;
    if (r !== REL.WAR && ai.focus !== o && g.rand() > warChance) continue;
    if ((atkOn.get(o) ?? 0) > p.troops * 0.5) continue;
    const sc = ratio * Math.sqrt(c) * (ai.focus === o ? 2 : 1);
    if (sc > bestScore) { bestScore = sc; best = o; }
  }
  if (best && p.troops > 200) launchAttack(g, p.id, best, AI.attackFrac[d], -1);

  // naval invasions when boxed in
  const boxed = neutral === 0 && (best === 0);
  if (boxed && s.tick - ai.lastNaval > 25 * TICK_RATE && g.rand() < AI.navalChance[d] + (counts.size === 0 ? 0.3 : 0)) {
    ai.lastNaval = s.tick;
    naval(g, p);
  }
  // strategic strikes
  const enemies: Player[] = [];
  for (const o of counts.keys()) if (rel(g, p.id, o) === REL.WAR) enemies.push(g.P(o)!);
  if (ai.focus && !counts.has(ai.focus) && rel(g, p.id, ai.focus) === REL.WAR) { const f = g.P(ai.focus); if (f && f.alive) enemies.push(f); }
  if (!enemies.length) return;
  const foe = enemies[g.randInt(enemies.length)];
  if (p.stock[U.MISSILE] > 0 && g.rand() < 0.5) {
    const t = pickTarget(g, foe, [B.AIR_DEFENSE, B.MISSILE_SILO, B.BARRACKS, B.FACTORY, B.CITY]);
    if (t >= 0) launchMissile(g, p, t);
  }
  if (p.stock[U.BOMBER] > 0 && g.rand() < 0.5) {
    const t = pickTarget(g, foe, [B.FACTORY, B.FARM, B.BARRACKS, B.TANK_FACTORY]);
    if (t >= 0) launchBomber(g, p, t);
  }
  const threat = foe.score > p.score * 0.5 || p.recentLoss > p.tiles * 0.05;
  if (p.stock[U.MEGA_NUKE] > 0 && g.s.settings.nukes && g.rand() < AI.nukeChance[d] * 0.6 && foe.score > p.score * 0.7) {
    launchNuke(g, p, foe.capital >= 0 ? foe.capital : pickTarget(g, foe, [B.CITY]), 1);
  } else if (p.stock[U.NUKE] > 0 && g.s.settings.nukes && g.rand() < AI.nukeChance[d] && threat) {
    const t = pickTarget(g, foe, [B.CITY, B.MISSILE_SILO, B.NUCLEAR_FACILITY]);
    launchNuke(g, p, t >= 0 ? t : foe.capital, 0);
  }
  if (p.ships > 0 && g.rand() < 0.1 && foe.capital >= 0) moveWarships(g, p, foe.capital);
  // lead an allied operation with a human ally now and then
  if (g.rand() < 0.08) aiLeadOp(g, p, foe);
}

function pickTarget(g: Game, q: Player, prefs: number[]): number {
  for (const ty of prefs) {
    const l = q.btype[ty];
    if (l.length) return g.s.buildings[l[g.randInt(l.length)]]!.tile;
  }
  return q.capital;
}

function naval(g: Game, p: Player) {
  const s = g.s, m = g.map;
  if (!p.btype[B.SHIPYARD].length) return;
  if (p.stock[U.TRANSPORT] < 1) return;
  let best = -1, bs = -Infinity;
  const myEff = effTroops(p);
  for (let i = 0; i < 60; i++) {
    const t = m.landTiles[g.randInt(m.landTiles.length)];
    if (!m.coastal[t]) continue;
    const o = s.owner[t];
    if (o === p.id) continue;
    let sc: number;
    if (o) {
      const r = rel(g, p.id, o);
      if (r === REL.ALLY || r === REL.NAP) continue;
      const q = g.P(o)!;
      const ratio = myEff / (effTroops(q) / Math.max(1, q.tiles) * 40 + 50);
      if (ratio < 1.5) continue;
      sc = Math.min(ratio, 5) - (r === REL.WAR ? 0 : 1.5);
    } else sc = 4;
    sc -= (p.capital >= 0 ? m.dist(t, p.capital) : 0) / (120 * m.ms);
    if (sc > bs) { bs = sc; best = t; }
  }
  if (best >= 0) invade(g, p, best, 0.3 + p.diff * 0.1);
}

// ---- diplomacy --------------------------------------------------------------------------------------
function diplomacy(g: Game, p: Player, counts: Map<number, number>) {
  const d = p.diff, myEff = effTroops(p);
  for (const o of counts.keys()) {
    const q = g.P(o);
    if (!q || !q.alive) continue;
    const r = rel(g, p.id, o);
    const ratio = (effTroops(q) + 1) / (myEff + 1);
    const op = opinion(g, p.id, o);
    // humans get fewer unsolicited proposals
    if (q.human && g.rand() > 0.12) continue;
    if (r === REL.WAR && ratio > 1.3 && g.rand() < 0.3) { propose(g, p.id, o, 'peace'); return; }
    if (r === REL.PEACE && d < 2 && ratio > 0.9 && op > -30 && g.rand() < 0.25) { propose(g, p.id, o, 'nap'); return; }
    if ((r === REL.NAP || r === REL.PEACE) && op > 35 && p.allies.length < AI.maxAllies && g.rand() < 0.2) { propose(g, p.id, o, 'ally'); return; }
  }
}
