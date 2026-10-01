// Headless integration test: drives two human players through every major system and asserts the
// server reacts correctly. Usage: node tools/selftest.ts

import { Game } from '../server/sim/game.ts';
import { loadMap } from '../server/maps.ts';
import { sanitizeSettings, REL } from '../shared/protocol.ts';
import { B, U, TICK_RATE, NUKE_TIERS, buildCost, buildTime } from '../shared/balance.ts';
import type { GameEvent } from '../server/sim/types.ts';
import { setRel } from '../server/sim/diplomacy.ts';

const NUKE = NUKE_TIERS[0];

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
// escalating prices: every extra city costs more than the last
let m0 = A.money;
const city1 = build(A, B.CITY);
const paid1 = m0 - A.money;
m0 = A.money;
build(A, B.CITY);
const paid2 = m0 - A.money;
ok(Math.abs(paid1 - buildCost(B.CITY, 0, 1).money!) < 60 && paid2 > paid1 + 150, `2nd and 3rd city cost more each (${Math.round(paid1)} -> ${Math.round(paid2)})`);
run(20);
// upgrades take half the time of a new building
send(A.id, { k: 'upgrade', tile: city1 });
const upB = g.s.buildings[g.s.bldAt[city1]]!;
const upTicks = upB.done - g.s.tick;
ok(Math.abs(upTicks - buildTime(B.CITY, 1) * TICK_RATE) <= 2 && buildTime(B.CITY, 1) === buildTime(B.CITY, 0) / 2, `city upgrade takes half the build time (${upTicks / TICK_RATE}s)`);
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

// ---- mega nuke needs a Lv2 nuclear facility ----------------------------------------------------------------
send(A.id, { k: 'train', u: U.MEGA_NUKE, n: 1 });
ok(/Lv 2/.test(lastErr(A.id) ?? ''), 'mega nuke refused without a Lv2 facility');
send(A.id, { k: 'upgrade', tile: g.s.buildings[A.btype[B.NUCLEAR_FACILITY][0]]!.tile });
run(32);
ok(A.levels[B.NUCLEAR_FACILITY] >= 2, 'nuclear facility upgraded to Lv2');
send(A.id, { k: 'train', u: U.MEGA_NUKE, n: 1 });
run(105);
ok(A.stock[U.MEGA_NUKE] >= 1, `mega nuke built (${A.stock[U.MEGA_NUKE]})`);

// ---- diplomacy ---------------------------------------------------------------------------------------
send(A.id, { k: 'propose', p: Bp.id, kind: 'ally' });
ok(events.some((e) => e.e === 'prop' && e._to === Bp.id), 'Bob received alliance proposal');
send(Bp.id, { k: 'respond', p: A.id, kind: 'ally', yes: true });
ok(g.s.rel[A.id * 1024 + Bp.id] === REL.ALLY && A.allies.includes(Bp.id), 'alliance formed');
send(A.id, { k: 'attack', tile: Bp.capital, pct: 0.2 });
ok(/ally/i.test(lastErr(A.id) ?? ''), 'cannot attack an ally');
send(A.id, { k: 'donate', p: Bp.id, troops: 0.1 });
ok(events.some((e) => e.e === 'aid'), 'aid sent to ally');

// ---- operations: planned, timed, allied ------------------------------------------------------------------
{
  const nb = new Int32Array(4);
  let target = 0;
  for (const t of A.border) { map.n4(t, nb); for (const n of nb) { const o = n >= 0 ? g.s.owner[n] : 0; if (!target && o && !g.P(o)!.human) target = o; } }
  // no AI neighbour: aim at the nearest AI (the land attack step will then report "no border")
  if (!target) target = g.alivePlayers().filter((p) => !p.human && p.capital >= 0).sort((a, b) => map.dist(a.capital, silo) - map.dist(b.capital, silo))[0].id;
  const tgt = g.P(target)!;
  ok(!!target, `target picked: ${tgt?.name}`);
  send(A.id, { k: 'opNew', p: target, name: 'Operation Test' });
  const op = g.s.operations.find((o) => o.owner === A.id)!;
  ok(op && op.status === 'planning', 'operation created');
  send(A.id, { k: 'opStep', op: op.id, kind: 'attack', tile: tgt.capital, pct: 0.3, delay: 0 });
  send(A.id, { k: 'opStep', op: op.id, kind: 'missile', tile: tgt.capital, delay: 0 });
  send(A.id, { k: 'opInvite', op: op.id, p: Bp.id });
  ok(events.some((e) => e.e === 'opInvite' && e._to === Bp.id), 'Bob invited to the allied operation');
  send(Bp.id, { k: 'opAnswer', op: op.id, yes: true });
  send(Bp.id, { k: 'opStep', op: op.id, kind: 'missile', tile: tgt.owned[0], delay: 0 });
  ok(op.steps.length === 3 && op.members.find((m) => m.pid === Bp.id)?.status === 'joined', `Bob joined and added a step (${op.steps.length} steps) ${lastErr(Bp.id) ?? ''}`);
  // a fleet move that is certain to succeed
  const fleetTile = [...Array(map.N).keys()].find((t) => map.isWater(t) && map.waterBody[t] === map.waterBody[g.s.ships.find((s) => s.owner === A.id)!.tile] && map.dist(t, yard) > 10 && map.dist(t, yard) < 25)!;
  send(A.id, { k: 'opStep', op: op.id, kind: 'fleet', tile: fleetTile, delay: 0 });
  send(A.id, { k: 'opTime', op: op.id, mode: 'seq', gap: 3 });
  ok(op.steps.map((s) => s.delay).join() === '0,3,6,9', `steps sequenced 3s apart (${op.steps.map((s) => s.delay).join()})`);
  // an AI ally decides for itself
  const aiAlly = g.alivePlayers().find((p) => !p.human && p.id !== target && g.s.rel[p.id * 1024 + target] !== REL.ALLY)!;
  setRel(g, A.id, aiAlly.id, REL.ALLY);
  send(A.id, { k: 'opInvite', op: op.id, p: aiAlly.id });
  const st = op.members.find((m) => m.pid === aiAlly.id)?.status;
  ok(st === 'joined' || st === 'declined', `AI ally answered the invitation (${st}, steps now ${op.steps.length})`);
  send(Bp.id, { k: 'opLaunch', op: op.id, cd: 2 });
  ok(/planner/i.test(lastErr(Bp.id) ?? ''), 'only the planner can launch');
  send(A.id, { k: 'opLaunch', op: op.id, cd: 2 });
  ok(op.status === 'countdown', 'H-hour countdown started');
  run(2.4);
  const s1 = op.steps.map((s) => s.state).join();
  ok(op.status === 'running' && op.steps[0].state !== 'planned' && op.steps[1].state === 'planned', `step 1 fired at H-hour, the rest wait (${s1})`);
  run(3);
  ok(op.steps[1].state !== 'planned' && op.steps[2].state === 'planned', 'step 2 fired 3s later');
  run(8);
  ok(op.status === 'done' && op.steps.every((s) => s.state !== 'planned'), `operation complete: ${op.steps.map((s) => `${s.kind}:${s.state}${s.note ? `(${s.note})` : ''}`).join(', ')}`);
  ok(op.steps.some((s) => s.kind === 'fleet' && s.state === 'done'), 'fleet step executed');
  ok(events.filter((e) => e.e === 'opStep' && e.op === op.id).length === op.steps.length, 'every step reported to the participants');
}
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

// ---- mega nuke on a far-away AI -------------------------------------------------------------------------------
{
  const far = g.alivePlayers().filter((p) => !p.human && p.capital >= 0 && p.tiles > 100 && !A.allies.includes(p.id)).sort((a, b) => map.dist(b.capital, A.capital) - map.dist(a.capital, A.capital))[0];
  const before = far.tiles;
  send(A.id, { k: 'nuke', tile: far.capital, tier: 1 });
  const nl2 = [...events].reverse().find((e) => e.e === 'nl');
  ok(nl2 && nl2.tier === 1 && (nl2.t1 as number) - g.s.tick >= NUKE_TIERS[1].flightSeconds * TICK_RATE - 2, `mega nuke launched with a ${NUKE_TIERS[1].flightSeconds}s window ${lastErr(A.id) ?? ''}`);
  run(NUKE_TIERS[1].flightSeconds + 1);
  const boom = [...events].reverse().find((e) => e.e === 'nuke');
  const hit = [...events].reverse().find((e) => e.e === 'hit' && e.id === nl2?.id);
  ok((boom && boom.tier === 1 && Math.abs((boom.r as number) - NUKE_TIERS[1].radius * map.ms) < 0.01) || hit?.x, `mega nuke resolved (${boom?.tier === 1 ? `radius ${boom.r}, ${far.name} ${before} -> ${far.tiles} tiles` : 'intercepted'})`);
}

// ---- nuke + manual interception ----------------------------------------------------------------------------
Bp.troops += 1e6; // keep Bob alive through the nuke so the match continues
if (!Bp.btype[B.MISSILE_SILO].some((id) => g.s.buildings[id]!.level > 0)) { build(Bp, B.MISSILE_SILO); run(35); }
ok(Bp.levels[B.MISSILE_SILO] > 0, 'Bob has an active silo (rebuilt after the air raid if needed)');
send(Bp.id, { k: 'expand', pct: 0.5, tile: -1 });
run(10);
const nukesBefore = events.filter((e) => e.e === 'nuke').length;
send(A.id, { k: 'nuke', tile: Bp.capital });
const nl = [...events].reverse().find((e) => e.e === 'nl' && e.o === A.id);
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
