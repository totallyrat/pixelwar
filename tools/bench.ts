// Headless simulation benchmark: runs a full match of AI nations (plus 2 idle "humans")
// and reports per-tick timing and how the world evolves.
// Usage: node tools/bench.ts [small|medium|large] [aiCount] [seconds]

import v8 from 'node:v8';
import { Game } from '../server/sim/game.ts';
import { loadMap } from '../server/maps.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../shared/protocol.ts';
import { TICK_RATE, B } from '../shared/balance.ts';

const size = (process.argv[2] ?? 'medium') as 'small' | 'medium' | 'large';
const ai = Number(process.argv[3] ?? 500);
const secs = Number(process.argv[4] ?? 600);

let t = performance.now();
const map = loadMap(size);
console.log(`map ${map.W}x${map.H} loaded in ${(performance.now() - t).toFixed(0)}ms, land ${map.landCount}`);
const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, mapSize: size, aiCount: ai, spawnSeconds: 5, peaceSeconds: 30 });
const g = new Game(map, settings, 12345);
const humans = Number(process.argv[5] ?? 0);
for (let i = 0; i < humans; i++) g.addHuman(`Tester ${i}`, 0xff0000, 0, 't' + i);

const ticks = secs * TICK_RATE;
let worst = 0, sum = 0, n = 0, changedMax = 0, events = 0;
const hist: number[] = [];
t = performance.now();
for (let i = 0; i < ticks; i++) {
  const t0 = performance.now();
  g.tick();
  const dt = performance.now() - t0;
  if (g.s.phase === 'running') { worst = Math.max(worst, dt); sum += dt; n++; hist.push(dt); }
  changedMax = Math.max(changedMax, g.changed.length);
  events += g.out.length;
  if (g.s.phase === 'ended') { console.log('ENDED:', g.s.winner); break; }
  if (i % (60 * TICK_RATE) === 0 && g.s.phase === 'running') {
    const alive = g.alivePlayers();
    const owned = alive.reduce((a, p) => a + p.tiles, 0);
    const top = alive.slice().sort((a, b) => b.tiles - a.tiles).slice(0, 3);
    const blds = g.s.buildings.filter((b) => b).length;
    const nukes = alive.reduce((a, p) => a + p.stats.nukes, 0);
    console.log(
      `t=${(i / TICK_RATE).toFixed(0).padStart(4)}s alive=${alive.length} claimed=${((owned / map.landCount) * 100).toFixed(1)}% ` +
      `attacks=${g.s.attacks.length} ships=${g.s.ships.length} flights=${g.s.flights.length} buildings=${blds} nukesLaunched=${nukes} ` +
      `avg=${(sum / Math.max(1, n)).toFixed(2)}ms worst=${worst.toFixed(1)}ms | top: ${top.map((p) => `${p.name}[d${p.diff}](${p.tiles}t ${Math.round(p.troops)}tr ${Math.round(p.pop)}pop $${Math.round(p.money)} P${Math.round(p.prod)} oil${Math.round(p.oil)} U${Math.round(p.uranium)} silo${p.btype[B.MISSILE_SILO].length} nf${p.btype[B.NUCLEAR_FACILITY].length} um${p.btype[B.URANIUM_MINE].length} tk${Math.round(p.tanks)} msl${p.stock[5]} nk${p.stock[6]} q${p.queue.join('/')})`).join(', ')}`,
    );
  }
}
hist.sort((a, b) => a - b);
const pct = (q: number) => hist[Math.floor(hist.length * q)]?.toFixed(2);
console.log(`sim ${n} running ticks in ${((performance.now() - t) / 1000).toFixed(1)}s wall; avg ${(sum / n).toFixed(2)}ms p50 ${pct(0.5)} p95 ${pct(0.95)} p99 ${pct(0.99)} worst ${worst.toFixed(1)}ms; max tiles changed/tick ${changedMax}; events ${events}`);
t = performance.now();
const snap = v8.serialize(g.s);
console.log(`snapshot ${(snap.length / 1e6).toFixed(1)} MB in ${(performance.now() - t).toFixed(0)}ms`);
t = performance.now();
v8.deserialize(snap);
console.log(`restore in ${(performance.now() - t).toFixed(0)}ms`);
