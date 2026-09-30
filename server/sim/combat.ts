// Land combat: attacks are "fronts". Each attack owns a priority queue of enemy/neutral tiles
// touching the attacker. A clock advances every tick; every queued tile whose priority is below
// the clock is fought for, which makes conquest spread as an organic wave shaped by terrain.

import { COMBAT, TERRAIN, TICK_RATE, B } from '../../shared/balance.ts';
import { REL } from '../../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Attack, Player } from './types.ts';
import { heapPush, heapPop } from './heap.ts';
import { rel, declareWar, adjustOpinion } from './diplomacy.ts';
import { bunkerMult } from './buildings.ts';

export function effTroops(p: Player): number {
  return p.troops + p.tanks * COMBAT.tankPower * COMBAT.tankDefense;
}

/** Validate relations for a hostile action against `target`. Declares war when at peace. */
export function hostileCheck(g: Game, pid: number, target: number): string | null {
  if (!target || target === pid) return target === pid ? 'That is your own territory' : null;
  const t = g.P(target);
  if (!t || !t.alive) return 'Nation no longer exists';
  if (g.peace) return `Peace time: ${Math.ceil((g.s.peaceUntil - g.s.tick) / TICK_RATE)}s left`;
  const r = rel(g, pid, target);
  if (r === REL.ALLY) return `${t.name} is your ally. Break the alliance first.`;
  if (r === REL.NAP) return `You have a non-aggression pact with ${t.name}. Break it first.`;
  if (r === REL.PEACE) declareWar(g, pid, target, false);
  return null;
}

export function launchAttack(g: Game, pid: number, target: number, frac: number, focus: number, landing = -1,
  force?: { troops: number; tanks: number }): string | null {
  const s = g.s, m = g.map, p = g.P(pid);
  if (!p || !p.alive || s.phase !== 'running') return 'Cannot attack now';
  if (target === pid) return 'That is your own territory';
  const hc = hostileCheck(g, pid, target);
  if (hc) return hc;
  let troops = force ? force.troops : p.troops * frac;
  let tanks = force ? force.tanks : Math.floor(p.tanks * frac);
  if (troops + tanks * COMBAT.tankPower < COMBAT.minAttackTroops) return 'Not enough troops';
  if (!force) { p.troops -= troops; p.tanks -= tanks; }

  // counter-attack: opposing fronts cancel out
  if (target && landing < 0) {
    for (const o of s.attacks) {
      if (o.attacker === target && o.target === pid && o.landing < 0 && o.troops > 0) {
        const c = Math.min(o.troops, troops);
        o.troops -= c;
        troops -= c;
        if (troops <= 0 && tanks <= 0) return null;
      }
    }
    const tp = g.P(target)!;
    if (!tp.human) adjustOpinion(g, target, pid, -12);
    else g.emit({ e: 'atk', _to: target, from: pid, troops: Math.round(troops + tanks * COMBAT.tankPower) });
  }

  let a: Attack | undefined;
  if (landing < 0) a = s.attacks.find((x) => x.attacker === pid && x.target === target && x.landing < 0);
  if (a) {
    a.troops += troops;
    a.tanks += tanks;
    a.focus = focus;
  } else {
    a = { id: g.id(), attacker: pid, target, troops, tanks, tiles: [], pri: [], clock: 0, focus, landing, born: s.tick, taken: 0 };
    s.attacks.push(a);
  }
  // seed the frontier
  if (landing >= 0) {
    heapPush(a.tiles, a.pri, landing, a.clock);
  } else {
    const seeds: number[] = [];
    const nb = g.nb, own = s.owner;
    for (const t of p.border) {
      m.n4(t, nb);
      for (let k = 0; k < 4; k++) {
        const n = nb[k];
        if (n >= 0 && own[n] === target && m.isLand(n)) seeds.push(n);
      }
    }
    if (!seeds.length) {
      // nothing to fight: refund
      s.attacks.splice(s.attacks.indexOf(a), 1);
      if (!force) { p.troops += a.troops; p.tanks += a.tanks; }
      return target ? `You don't share a land border with ${g.P(target)!.name}. Try a naval invasion.` : 'No unclaimed land next to you';
    }
    let dmin = 0;
    if (focus >= 0) {
      dmin = Infinity;
      for (const t of seeds) dmin = Math.min(dmin, m.dist(t, focus));
    }
    const bias = focus >= 0 ? COMBAT.directionBias : 0;
    for (const t of seeds) {
      const d = focus >= 0 ? m.dist(t, focus) - dmin : 0;
      heapPush(a.tiles, a.pri, t, a.clock + TERRAIN[m.terrain[t]].step * (1 + COMBAT.jitter * (g.rand() - 0.5)) + bias * d);
    }
  }
  return null;
}

export function cancelAttack(g: Game, pid: number, id: number) {
  const s = g.s;
  const i = s.attacks.findIndex((a) => a.id === id && a.attacker === pid);
  if (i < 0) return;
  finishAttack(g, s.attacks[i]);
  s.attacks.splice(i, 1);
}

function finishAttack(g: Game, a: Attack) {
  const p = g.P(a.attacker);
  if (p && p.alive) {
    p.troops += Math.max(0, a.troops);
    p.tanks += Math.max(0, Math.floor(a.tanks));
  }
}

/** Called on elimination. Never reassigns s.attacks (may run while stepAttacks iterates). */
export function endAttacksOf(g: Game, pid: number) {
  for (const a of g.s.attacks) {
    if (a.attacker === pid) { a.troops = 0; a.tanks = 0; a.tiles.length = a.pri.length = 0; }
    else if (a.target === pid) a.tiles.length = a.pri.length = 0;
  }
}

export function stepAttacks(g: Game) {
  const s = g.s;
  if (!s.attacks.length) return;
  let w = 0;
  for (let i = 0; i < s.attacks.length; i++) {
    const a = s.attacks[i];
    if (stepAttack(g, a)) s.attacks[w++] = a;
    else finishAttack(g, a);
  }
  s.attacks.length = w;
}

function stepAttack(g: Game, a: Attack): boolean {
  const s = g.s, m = g.map, own = s.owner, ter = m.terrain;
  const p = g.P(a.attacker);
  if (!p || !p.alive) return false;
  const def = a.target ? g.P(a.target) : null;
  if (a.target && (!def || !def.alive)) return false;
  if (def) {
    const r = rel(g, a.attacker, a.target);
    if (r === REL.ALLY || r === REL.NAP) return false;
  }
  if (!a.tiles.length) return false;

  const tankPow = COMBAT.tankPower;
  let speedMult = 1, dens = 0, defMult = 1;
  if (def) {
    const defEff = Math.max(1, effTroops(def));
    const ratio = (a.troops + a.tanks * tankPow) / defEff;
    speedMult = Math.max(COMBAT.speedMin, Math.min(COMBAT.speedMax, 0.5 + 0.5 * ratio));
    dens = defEff / Math.max(1, def.tiles);
    defMult = COMBAT.defenderAdvantage * (1 + 0.1 * def.techDef) / (1 + 0.1 * p.techOff) * (def.traitorUntil > s.tick ? COMBAT.traitorDefense : 1);
  }
  const offMult = 1 / (1 + 0.1 * p.techOff);
  a.clock += COMBAT.waveSpeed * m.ms * g.speed * speedMult;
  const bias = a.focus >= 0 ? COMBAT.directionBias : 0;
  const minCost = COMBAT.minTileCost * m.as;
  const maxTiles = Math.ceil(COMBAT.maxTilesPerTick * m.ms * m.ms);
  const nb = g.nb;
  const hasBunkers = def ? def.btype[B.BUNKER].length > 0 : false;
  let taken = 0;

  while (a.tiles.length && taken < maxTiles) {
    const pr = a.pri[0];
    if (pr > a.clock) break;
    const t = a.tiles[0];
    heapPop(a.tiles, a.pri);
    if (own[t] !== a.target || ter[t] <= 1) continue;
    if (t !== a.landing && !g.touches(t, a.attacker)) continue;
    const td = TERRAIN[ter[t]];
    let cost: number;
    const fall = s.fallout[t] > 0 ? COMBAT.falloutCost : 1;
    if (def) {
      cost = Math.max(minCost, dens * td.def * defMult * fall * (hasBunkers ? bunkerMult(g, def, t) : 1));
    } else {
      cost = td.cost * m.as * fall * offMult;
    }
    const tankEff = a.tanks * tankPow * td.tank;
    const eff = a.troops + tankEff;
    if (eff < cost) {
      // out of steam
      a.tiles.length = a.pri.length = 0;
      break;
    }
    // pay proportionally between infantry and armour
    const fInf = a.troops / eff;
    a.troops -= cost * fInf;
    if (tankEff > 0) a.tanks = Math.max(0, a.tanks - (cost * (1 - fInf)) / (tankPow * td.tank));
    if (def) {
      const loss = dens * COMBAT.defenderLoss;
      const dEff = effTroops(def);
      if (dEff > 0) {
        const fi = def.troops / dEff;
        def.troops = Math.max(0, def.troops - loss * fi);
        def.tanks = Math.max(0, def.tanks - (loss * (1 - fi)) / (tankPow * COMBAT.tankDefense));
      }
    }
    g.setOwner(t, a.attacker);
    p.stats.tilesTaken++;
    a.taken++;
    taken++;
    if (def && def.tiles === 0) { g.eliminate(def, p.id); a.tiles.length = a.pri.length = 0; break; }
    // expand the frontier
    m.n4(t, nb);
    const dPar = bias ? m.dist(t, a.focus) : 0;
    for (let k = 0; k < 4; k++) {
      const n = nb[k];
      if (n < 0 || own[n] !== a.target || ter[n] <= 1) continue;
      const step = TERRAIN[ter[n]].step * (1 + COMBAT.jitter * (g.rand() - 0.5));
      const d = bias ? (m.dist(n, a.focus) - dPar) * bias : 0;
      heapPush(a.tiles, a.pri, n, pr + step + d);
    }
  }
  if (taken > 0 && def && !def.human) def.ai && (def.ai.focus = a.attacker);
  return a.tiles.length > 0 && a.troops + a.tanks * tankPow >= COMBAT.minAttackTroops * 0.5;
}
