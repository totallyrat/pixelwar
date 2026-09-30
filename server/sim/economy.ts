// Economy, population, recruitment, happiness and rebellion.

import { ECON, EFFECT, HAPPY, NUKE, UNITS, U, B, UNIT_COUNT, TICK_RATE, type Cost } from '../../shared/balance.ts';
import { REL } from '../../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Player } from './types.ts';
import { stepProduction } from './units.ts';
import { setRel } from './diplomacy.ts';
import { setupAI } from './ai.ts';

export function canAfford(p: Player, c: Cost, mult = 1): boolean {
  return (c.money ?? 0) * mult <= p.money + 1e-6 && (c.prod ?? 0) * mult <= p.prod + 1e-6 &&
    (c.oil ?? 0) * mult <= p.oil + 1e-6 && (c.uranium ?? 0) * mult <= p.uranium + 1e-6;
}
export function pay(p: Player, c: Cost, mult = 1) {
  p.money -= (c.money ?? 0) * mult;
  p.prod -= (c.prod ?? 0) * mult;
  p.oil -= (c.oil ?? 0) * mult;
  p.uranium -= (c.uranium ?? 0) * mult;
}
export function refund(p: Player, c: Cost, mult: number) { pay(p, c, -mult); }

export function winterMult(g: Game): number {
  const s = g.s;
  if (!s.settings.nuclearWinter || s.winter <= NUKE.winterThreshold) return 1;
  return Math.max(1 - NUKE.winterMax, 1 - (s.winter - NUKE.winterThreshold) * NUKE.winterStep);
}

export function stepEconomy(g: Game) {
  const dt = g.dt;
  const wm = winterMult(g);
  for (const p of g.s.players) {
    if (!p || !p.alive || !p.spawned) continue;
    economy(g, p, dt, wm);
    stepProduction(g, p, dt);
  }
}

function economy(g: Game, p: Player, dt: number, wm: number) {
  const hm = HAPPY.outputMin + ((HAPPY.outputMax - HAPPY.outputMin) * p.happiness) / 100;
  const hasCap = p.capital >= 0 ? 1 : 0;
  const cityLv = p.levels[B.CITY];
  const popCap = Math.max(500, p.popCapTiles + hasCap * ECON.capitalPop + cityLv * EFFECT.cityPop);
  p.popCap = popCap;

  // food
  const foodIn = (p.foodTiles + p.farmFood * EFFECT.farmFood + hasCap * ECON.capitalFood) * hm * wm;
  const foodOut = p.pop * ECON.foodPerPop + p.troops * ECON.foodPerTroop;
  const foodNet = foodIn - foodOut;
  p.food += foodNet * dt;
  if (p.food <= 0 && foodNet < 0) { p.food = 0; p.starving = true; } else if (p.food > 5) p.starving = false;

  // money
  let upkeep = p.tanks * UNITS[U.TANK].upkeep;
  for (let u = 1; u < UNIT_COUNT; u++) upkeep += p.stock[u] * UNITS[u].upkeep;
  upkeep += p.ships * UNITS[U.WARSHIP].upkeep;
  const moneyIn = (p.pop * ECON.tax + cityLv * EFFECT.cityMoney + hasCap * ECON.capitalMoney + p.tradeTiles) * hm;
  const moneyNet = moneyIn - upkeep;
  p.money = Math.max(0, p.money + moneyNet * dt);
  const prodNet = (1 + hasCap * ECON.capitalProd + p.levels[B.FACTORY] * EFFECT.factoryProd) * hm;
  p.prod += prodNet * dt;
  const oilNet = p.levels[B.OIL_WELL] * EFFECT.oilWell * hm;
  const uraNet = p.levels[B.URANIUM_MINE] * EFFECT.uraniumMine * hm;
  p.oil += oilNet * dt;
  p.uranium += uraNet * dt;

  // population
  const pop0 = p.pop, troops0 = p.troops;
  const total = p.pop + p.troops;
  if (p.starving) {
    p.pop -= p.pop * ECON.starveLoss * dt;
    p.troops -= p.troops * ECON.starveDesert * dt;
  } else if (total < popCap) {
    p.pop += (p.pop * ECON.growth * (1 - total / popCap) + ECON.baseGrowth) * dt * Math.min(1, hm + 0.2);
  } else {
    p.pop -= Math.min(p.pop, (total - popCap) * 0.03 * dt);
  }
  // recruitment toward mobilisation target
  const target = p.mobilization * (p.pop + p.troops);
  if (p.troops < target) {
    const rate = Math.min(ECON.recruitMax, ECON.recruitBase + p.levels[B.BARRACKS] * EFFECT.barracksRecruit);
    const r = Math.min(rate * p.pop * dt, target - p.troops, Math.max(0, p.pop - 50));
    p.troops += r;
    p.pop -= r;
  } else if (p.troops > target * 1.02) {
    const d = Math.min(p.troops - target, p.troops * ECON.demobilize * dt);
    p.troops -= d;
    p.pop += d;
  }
  if (p.pop < 0) p.pop = 0;
  if (p.troops < 0) p.troops = 0;

  const inv = 1 / dt;
  const R = p.rates;
  R[0] = foodNet; R[1] = prodNet; R[2] = moneyNet; R[3] = oilNet; R[4] = uraNet;
  R[5] = (p.pop - pop0) * inv; R[6] = (p.troops - troops0) * inv;
}

/** Once per second. */
export function updateHappiness(g: Game, p: Player) {
  const s = g.s;
  let target = HAPPY.base;
  if (p.rates[0] > 0) target += HAPPY.foodSurplus;
  if (p.starving) target += HAPPY.starving;
  target += HAPPY.mobilization * Math.max(0, p.mobilization - 0.4) * 2.5;
  if (p.tiles > 0) {
    target += HAPPY.fallout * Math.min(1, (p.falloutTiles / p.tiles) * 5);
    target += HAPPY.warLosses * Math.min(1, (p.recentLoss / p.tiles) * 4);
  }
  target += Math.min(HAPPY.maxCityBonus, p.levels[B.CITY] * HAPPY.perCityLevel);
  if (p.traitorUntil > s.tick) target += HAPPY.traitor;
  target = Math.max(0, Math.min(100, target));
  const step = HAPPY.change * g.speed;
  p.happiness += Math.max(-step, Math.min(step, target - p.happiness));
  p.recentLoss *= 0.93;
  if (s.tick % (TICK_RATE * 10) === 0 && p.happiness < HAPPY.rebelBelow && p.tiles > 60 && g.rand() < HAPPY.rebelChance) rebel(g, p);
}

/** Part of an unhappy nation breaks away as a new AI nation. */
function rebel(g: Game, p: Player) {
  const s = g.s, m = g.map;
  if (s.players.length >= 1000 || p.capital < 0) return;
  // seed: the farthest of a few random owned tiles from the capital
  let seed = -1, best = -1;
  for (let i = 0; i < 12; i++) {
    const t = p.owned[g.randInt(p.owned.length)];
    const d = m.dist2(t, p.capital);
    if (d > best) { best = d; seed = t; }
  }
  if (seed < 0) return;
  const want = Math.min(Math.floor(p.tiles * 0.1), Math.round(4000 / m.as));
  const region: number[] = [seed];
  const seen = new Set<number>([seed]);
  const nb = new Int32Array(4);
  for (let i = 0; i < region.length && region.length < want; i++) {
    m.n4(region[i], nb);
    for (let k = 0; k < 4; k++) {
      const n = nb[k];
      if (n >= 0 && !seen.has(n) && s.owner[n] === p.id && n !== p.capital) { seen.add(n); region.push(n); }
    }
  }
  if (region.length < 8) return;
  const cname = m.country[seed] ? m.countries[m.country[seed] - 1].n : null;
  const used = new Set(s.usedNames);
  const base = `Free ${(cname ?? 'Rebels').slice(0, 20)}`;
  let name = base;
  for (let k = 2; used.has(name); k++) name = `${base} ${k}`;
  const color = ((g.randInt(200) + 40) << 16) | ((g.randInt(200) + 40) << 8) | (g.randInt(200) + 40);
  const r = g.newPlayer(name, color, false, 1);
  setupAI(g, r);
  const f = region.length / p.tiles;
  r.troops = p.troops * f * 1.5;
  r.pop = p.pop * f;
  p.troops -= p.troops * f;
  p.pop -= r.pop;
  r.spawned = true;
  for (const t of region) g.setOwner(t, r.id);
  r.capital = region[0];
  setRel(g, p.id, r.id, REL.WAR);
  p.happiness += 15;
  g.emit({ e: 'pl', _all: true, p: g.rosterEntry(r) });
  g.emit({ e: 'rebel', _all: true, from: p.id, id: r.id, tile: region[0] });
}
