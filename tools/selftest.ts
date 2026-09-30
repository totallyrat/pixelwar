// Headless integration test: drives two human players through every major system and asserts the
// server reacts correctly. Usage: node tools/selftest.ts

import { Game } from '../server/sim/game.ts';
import { loadMap } from '../server/maps.ts';
import { sanitizeSettings, REL } from '../shared/protocol.ts';
import { B, U, TICK_RATE, NUKE } from '../shared/balance.ts';
import type { GameEvent } from '../server/sim/types.ts';

let failures = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const map = loadMap('medium');
const g = new Game(map, sanitizeSettings({ mapSize: 'medium', aiCount: 40, spawnSeconds: 1, peaceSeconds: 0 }), 7);
const A = g.addHuman('Alice', 0xff0000, 0, 'tokA');
const Bp = g.addHuman('Bob', 0x0000ff, 0, 'tokB');

const events: GameEvent[] = [];
function run(sec: number) { for (let i = 0; i < sec * TICK_RATE; i++) { g.tick(); events.push(...g.out); } }
function send(pid: number, m: any) { g.intent(pid, m); g.tick(); events.push(...g.out); }
let errMark = 0;
const lastErr = (pid: number) => {
  const e = events.slice(errMark).reverse().find((x) => x.e === 'err' && x._to === pid)?.msg as string | undefined;
  errMark = events.length;
  return e;
};
const millerY = (lat: number) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * Math.PI / 180));
const lonlat = (lon: number, lat: number) => {
  const x = Math.round(((lon + 180) / 360) * map.W);
  const y = Math.round(((millerY(82) - millerY(lat)) / Math.PI) * map.H);
  let best = -1, bd = Infinity;
  map.forRadius(y * map.W + x, 12, (t, d2) => { if (map.isLand(t) && d2 < bd) { bd = d2; best = t; } });
  return best;
};

// ---- spawn -------------------------------------------------------------------------------
const paris = lonlat(-1.0, 44.8); // Bordeaux: coastal, so Alice can build a shipyard
const london = lonlat(-1.5, 52.5);
ok(paris >= 0 && london >= 0, `found spawn tiles (${map.countryName(paris)}, ${map.countryName(london)})`);
send(A.id, { k: 'spawn', tile: paris });
send(Bp.id, { k: 'spawn', tile: london });
ok(A.capital === paris, 'Alice spawned');
ok(Bp.capital === london, `Bob spawned (${lastErr(Bp.id) ?? 'ok'})`);
run(6);
ok(g.s.phase === 'running', 'match running after spawn phase');
ok(g.alivePlayers().length > 30, `AI nations spawned (${g.alivePlayers().length - 2})`);

// ---- expansion -----------------------------------------------------------------------------
const t0 = A.tiles;
send(A.id, { k: 'expand', pct: 0.6, tile: -1 });
run(6);
ok(A.tiles > t0 * 2, `expansion grew Alice ${t0} -> ${A.tiles} tiles`);

// ---- rich mode for testing ------------------------------------------------------------------------
for (const p of [A, Bp]) { p.money = 1e7; p.prod = 1e7; p.oil = 1e6; p.uranium = 1e5; }
const site = (p: typeof A, pred: (t: number) => boolean) => p.owned.find((t) => pred(t) && g.s.bldAt[t] < 0 && !g.s.fallout[t] && (() => {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const u = map.idx((t % map.W) + dx, ((t / map.W) | 0) + dy); if (g.s.bldAt[u] >= 0) return false; }
  return true;
})()) ?? -1;
const build = (p: typeof A, type: number, pred: (t: number) => boolean = () => true) => {
  const t = site(p, pred);
  send(p.id, { k: 'build', tile: t, b: type });
  return t;
};
build(A, B.CITY);
build(A, B.CITY);
run(20);
const silo = build(A, B.MISSILE_SILO);
build(A, B.NUCLEAR_FACILITY);
build(A, B.AIRBASE);
const yard = build(A, B.SHIPYARD, (t) => !!map.coastal[t]);
build(A, B.TANK_FACTORY);
build(Bp, B.MISSILE_SILO);
const bAD = build(Bp, B.AIR_DEFENSE);
build(Bp, B.RADAR);
ok(A.btype[B.MISSILE_SILO].length === 1, `Alice placed silo (${lastErr(A.id) ?? 'ok'})`);
ok(yard >= 0 && A.btype[B.SHIPYARD].length === 1, `Alice placed coastal shipyard (${lastErr(A.id) ?? 'ok'})`);
run(65);
ok(A.levels[B.MISSILE_SILO] === 1 && A.levels[B.NUCLEAR_FACILITY] === 1, 'silo + nuclear facility finished');
ok(Bp.levels[B.AIR_DEFENSE] === 1, 'Bob air defense finished');

// ---- production ------------------------------------------------------------------------------------
send(A.id, { k: 'train', u: U.MISSILE, n: 3 });
send(A.id, { k: 'train', u: U.NUKE, n: 2 });
send(A.id, { k: 'train', u: U.BOMBER, n: 2 });
send(A.id, { k: 'train', u: U.TRANSPORT, n: 2 });
send(A.id, { k: 'train', u: U.WARSHIP, n: 2 });
send(A.id, { k: 'train', u: U.TANK, n: 5 });
send(Bp.id, { k: 'train', u: U.MISSILE, n: 3 });
run(100);
ok(A.stock[U.MISSILE] >= 3, `missiles built (${A.stock[U.MISSILE]})`);
ok(A.stock[U.NUKE] >= 1, `nuke built (${A.stock[U.NUKE]})`);
ok(A.stock[U.BOMBER] >= 1, `bombers built (${A.stock[U.BOMBER]})`);
ok(A.stock[U.TRANSPORT] >= 2, `transports built (${A.stock[U.TRANSPORT]})`);
ok(g.s.ships.filter((s) => s.owner === A.id).length >= 1, `warships launched (${A.ships})`);
ok(A.tanks >= 5, `tanks built (${A.tanks})`);

// ---- diplomacy ---------------------------------------------------------------------------------------
send(A.id, { k: 'propose', p: Bp.id, kind: 'ally' });
ok(events.some((e) => e.e === 'prop' && e._to === Bp.id), 'Bob received alliance proposal');
send(Bp.id, { k: 'respond', p: A.id, kind: 'ally', yes: true });
ok(g.s.rel[A.id * 1024 + Bp.id] === REL.ALLY && A.allies.includes(Bp.id), 'alliance formed');
send(A.id, { k: 'attack', tile: Bp.capital, pct: 0.2 });
ok(/ally/i.test(lastErr(A.id) ?? ''), 'cannot attack an ally');
send(A.id, { k: 'donate', p: Bp.id, troops: 0.1 });
ok(events.some((e) => e.e === 'aid'), 'aid sent to ally');
send(A.id, { k: 'break', p: Bp.id });
ok(g.s.rel[A.id * 1024 + Bp.id] === REL.WAR && A.traitorUntil > g.s.tick, 'betrayal -> war + traitor debuff');

// ---- missiles & air defense -------------------------------------------------------------------------
const bTile = Bp.owned.find((t) => map.dist(t, bAD) < 3) ?? Bp.capital;
const inRange = map.dist(silo, bTile);
send(A.id, { k: 'missile', tile: bTile });
ok(!lastErr(A.id) || !/missile/i.test(lastErr(A.id)!), `missile launched at Bob (dist ${inRange.toFixed(0)}) ${lastErr(A.id) ?? ''}`);
run(8);
ok(events.some((e) => e.e === 'hit' && e.k === 0), 'missile resolved (hit or intercepted)');

// ---- bomber ---------------------------------------------------------------------------------------------
send(A.id, { k: 'bomb', tile: Bp.owned[0] });
run(12);
ok(events.some((e) => e.e === 'hit' && e.k === 2), `bomber strike resolved ${lastErr(A.id) ?? ''}`);

// ---- naval invasion ----------------------------------------------------------------------------------------
{
  lastErr(A.id);
  const fleetBody = map.waterBody[g.s.ships.find((s) => s.owner === A.id)?.tile ?? 0];
  const nb = new Int32Array(4);
  const seaOf = (t: number) => { map.n4(t, nb); for (const n of nb) if (n >= 0 && map.isWater(n)) return map.waterBody[n]; return -1; };
  const coast = map.landTiles.find((t) => !!map.coastal[t] && g.s.owner[t] !== A.id && g.s.owner[t] !== Bp.id && seaOf(t) === fleetBody && map.dist(t, yard) < 70 && map.dist(t, yard) > 20) ?? -1;
  send(A.id, { k: 'invade', tile: coast, pct: 0.3 });
  const err = lastErr(A.id);
  ok(!err, `invasion launched toward ${map.countryName(coast)} ${err ?? ''}`);
  const transports = g.s.ships.filter((s) => s.owner === A.id && s.type === U.TRANSPORT).length;
  ok(transports >= 1, `transport at sea (${transports})`);
  run(45);
  ok(events.some((e) => e.e === 'land' && e.by === A.id), 'transport landed troops');
}

// ---- nuke + manual interception ----------------------------------------------------------------------------
Bp.troops += 1e6; // keep Bob alive through the nuke so the match continues
if (!Bp.btype[B.MISSILE_SILO].some((id) => g.s.buildings[id]!.level > 0)) { build(Bp, B.MISSILE_SILO); run(35); }
ok(Bp.levels[B.MISSILE_SILO] > 0, 'Bob has an active silo (rebuilt after the air raid if needed)');
send(Bp.id, { k: 'expand', pct: 0.5, tile: -1 });
run(10);
const nukesBefore = events.filter((e) => e.e === 'nuke').length;
send(A.id, { k: 'nuke', tile: Bp.capital });
const nl = events.find((e) => e.e === 'nl');
ok(!!nl && nl._all, 'nuke launch broadcast to everyone');
run(3);
lastErr(Bp.id);
send(Bp.id, { k: 'intercept', id: nl?.id });
const icErr = lastErr(Bp.id);
ok(!icErr && events.some((e) => e.e === 'fl' && (e.f as number[])[1] === 4), `Bob fired an interceptor (missiles ${Bp.stock[U.MISSILE]}) ${icErr ?? ''}`);
run(NUKE.flightSeconds);
const intercepted = events.some((e) => e.e === 'ic');
const detonated = events.filter((e) => e.e === 'nuke').length > nukesBefore;
ok(intercepted || detonated, `nuke resolved (${intercepted ? 'interception attempted' : ''}${detonated ? ' detonated' : ''})`);
if (detonated) {
  ok(g.s.falloutList.length > 0, `fallout created (${g.s.falloutList.length} tiles)`);
  ok(g.s.winter >= 1, 'nuclear winter counter increased');
}
// a second nuke should now certainly reach (Bob is out of missiles?)
if (A.stock[U.NUKE] > 0) {
  send(A.id, { k: 'nuke', tile: Bp.owned[Math.floor(Bp.owned.length / 2)] ?? Bp.capital });
  run(NUKE.flightSeconds + 1);
}

// ---- warships ------------------------------------------------------------------------------------------------
const sea = map.landTiles.length && [...Array(map.N).keys()].find((t) => map.isWater(t) && map.waterBody[t] === map.waterBody[g.s.ships.find((s) => s.owner === A.id)?.tile ?? 0] && map.dist(t, yard) > 20 && map.dist(t, yard) < 40);
if (sea !== undefined) {
  send(A.id, { k: 'ships', tile: sea });
  ok(!lastErr(A.id) || !/warship|reach/i.test(lastErr(A.id)!), `fleet ordered to sea ${lastErr(A.id) ?? ''}`);
}

// ---- long run for stability ------------------------------------------------------------------------------------
let maxMs = 0;
for (let i = 0; i < 300 * TICK_RATE; i++) { const t = performance.now(); g.tick(); maxMs = Math.max(maxMs, performance.now() - t); if (g.s.phase === 'ended') break; }
ok(true, `ran 5 more minutes without exceptions (worst tick ${maxMs.toFixed(1)}ms, phase ${g.s.phase})`);

// ---- snapshot roundtrip --------------------------------------------------------------------------------------------
import v8 from 'node:v8';
const snap = v8.deserialize(v8.serialize(g.s));
const g2 = new Game(map, snap.settings, snap.seed, snap);
for (let i = 0; i < 50; i++) g2.tick();
ok(g2.s.tick === g.s.tick + 50, 'snapshot restored and continues ticking');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
