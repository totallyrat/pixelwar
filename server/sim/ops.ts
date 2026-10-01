// Planned operations: a named plan against a target nation made of timed steps (land attacks,
// naval invasions, missile / bomber / nuclear strikes, fleet moves). Steps fire at H-hour + delay,
// so they can go all at once or in a precise sequence. Allies can be invited to join and add their
// own steps (allied operations); AI allies decide for themselves and can lead operations too.

import { OPS, TICK_RATE, U, B, AI } from '../../shared/balance.ts';
import { REL } from '../../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Operation, OpKind, OpStep, Player } from './types.ts';
import { launchAttack, effTroops } from './combat.ts';
import { invade, launchMissile, launchBomber, launchNuke, moveWarships } from './units.ts';
import { rel, opinion } from './diplomacy.ts';

export const OP_KINDS: OpKind[] = ['attack', 'invade', 'missile', 'bomb', 'nuke', 'mega', 'fleet'];
const ADJ = ['Iron', 'Crimson', 'Silent', 'Northern', 'Burning', 'Midnight', 'Thunder', 'Steel', 'Pale', 'Golden', 'Black', 'Rolling', 'Frozen', 'Desert', 'Shattered', 'Hidden', 'Red', 'Winter'];
const NOUN = ['Tide', 'Hammer', 'Dawn', 'Serpent', 'Anvil', 'Storm', 'Lance', 'Falcon', 'Avalanche', 'Trident', 'Harvest', 'Eclipse', 'Cyclone', 'Viper', 'Horizon', 'Fury', 'Spear', 'Citadel'];

const live = (op: Operation) => op.status === 'planning' || op.status === 'countdown' || op.status === 'running';
const editable = (op: Operation) => op.status === 'planning' || op.status === 'countdown';

export function codename(g: Game): string {
  return `Operation ${ADJ[g.randInt(ADJ.length)]} ${NOUN[g.randInt(NOUN.length)]}`;
}
export function findOp(g: Game, id: number): Operation | undefined {
  return g.s.operations.find((o) => o.id === id);
}
/** Owner plus everyone who joined. */
export function participants(op: Operation): number[] {
  return [op.owner, ...op.members.filter((m) => m.status === 'joined').map((m) => m.pid)];
}
/** Everyone who should see the operation (participants + pending invites). */
function audience(op: Operation): number[] {
  return [op.owner, ...op.members.filter((m) => m.status !== 'declined').map((m) => m.pid)];
}
const isParticipant = (op: Operation, pid: number) => participants(op).includes(pid);

function emitOp(g: Game, op: Operation) {
  g.emit({ e: 'op', _p: audience(op), op });
}

// ---- planning -----------------------------------------------------------------------------------
export function createOp(g: Game, pid: number, target: number, name: unknown): Operation | string {
  const s = g.s, p = g.P(pid);
  if (!p || !p.alive) return 'You have no nation';
  if (s.operations.filter((o) => o.owner === pid && live(o)).length >= OPS.maxActive) return `At most ${OPS.maxActive} active operations`;
  const t = g.P(target);
  if (!t || !t.alive || target === pid) return 'Pick an enemy nation as the target';
  if (rel(g, pid, target) === REL.ALLY) return `${t.name} is your ally`;
  const clean = String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32);
  const op: Operation = {
    id: g.id(), name: clean || codename(g), owner: pid, target, members: [], steps: [],
    status: 'planning', launchAt: 0, created: s.tick, endedAt: 0, nextStep: 1,
  };
  s.operations.push(op);
  emitOp(g, op);
  return op;
}

export function addStep(g: Game, pid: number, opId: number, kind: unknown, tile: number, pct: number, delay: number): string | null {
  const s = g.s, m = g.map;
  const op = findOp(g, opId);
  if (!op) return 'Operation not found';
  if (!isParticipant(op, pid)) return 'You are not part of this operation';
  if (!editable(op)) return 'The operation has already started';
  if (op.steps.length >= OPS.maxSteps) return `At most ${OPS.maxSteps} steps per operation`;
  if (!OP_KINDS.includes(kind as OpKind)) return 'Unknown action';
  if (!(tile >= 0 && tile < m.N)) return 'Pick a location on the map';
  const k = kind as OpKind;
  if ((k === 'attack' || k === 'invade') && !m.isLand(tile)) return 'Pick a land tile';
  if (k !== 'fleet' && s.owner[tile] === pid) return 'That is your own territory';
  if ((k === 'nuke' || k === 'mega') && !s.settings.nukes) return 'Nukes are disabled in this match';
  const step: OpStep = {
    id: op.nextStep++, by: pid, kind: k, tile,
    pct: Math.max(0.05, Math.min(1, pct || 0.3)),
    delay: Math.max(0, Math.min(OPS.maxDelay, Math.round(delay || 0))),
    state: 'planned', note: '',
  };
  op.steps.push(step);
  emitOp(g, op);
  return null;
}

export function editStep(g: Game, pid: number, opId: number, stepId: number, delay?: number, pct?: number): string | null {
  const op = findOp(g, opId);
  const st = op?.steps.find((x) => x.id === stepId);
  if (!op || !st) return 'Step not found';
  if (st.by !== pid && op.owner !== pid) return 'Only the planner or the step owner can change it';
  if (!editable(op)) return 'The operation has already started';
  if (typeof delay === 'number' && isFinite(delay)) st.delay = Math.max(0, Math.min(OPS.maxDelay, Math.round(delay)));
  if (typeof pct === 'number' && isFinite(pct)) st.pct = Math.max(0.05, Math.min(1, pct));
  emitOp(g, op);
  return null;
}

export function removeStep(g: Game, pid: number, opId: number, stepId: number): string | null {
  const op = findOp(g, opId);
  const st = op?.steps.find((x) => x.id === stepId);
  if (!op || !st) return 'Step not found';
  if (st.by !== pid && op.owner !== pid) return 'Only the planner or the step owner can remove it';
  if (!editable(op)) return 'The operation has already started';
  op.steps = op.steps.filter((x) => x !== st);
  emitOp(g, op);
  return null;
}

/** Re-time every step: 'sync' = all at H-hour, 'seq' = one after another, `gap` seconds apart. */
export function retime(g: Game, pid: number, opId: number, mode: unknown, gap: number): string | null {
  const op = findOp(g, opId);
  if (!op) return 'Operation not found';
  if (op.owner !== pid) return 'Only the planner can re-time the operation';
  if (!editable(op)) return 'The operation has already started';
  const ordered = op.steps.slice().sort((a, b) => a.delay - b.delay || a.id - b.id);
  const g2 = Math.max(1, Math.min(60, Math.round(gap || OPS.defaultGap)));
  ordered.forEach((st, i) => { st.delay = mode === 'seq' ? i * g2 : 0; });
  emitOp(g, op);
  return null;
}

// ---- allies ------------------------------------------------------------------------------------------
export function inviteToOp(g: Game, pid: number, opId: number, other: number): string | null {
  const op = findOp(g, opId), q = g.P(other);
  if (!op) return 'Operation not found';
  if (op.owner !== pid) return 'Only the planner can invite allies';
  if (!editable(op)) return 'The operation has already started';
  if (!q || !q.alive) return 'Invalid nation';
  if (rel(g, pid, other) !== REL.ALLY) return `You can only invite allies (${q.name} is not your ally)`;
  if (other === op.target) return 'That is the target';
  const mem = op.members.find((x) => x.pid === other);
  if (mem && mem.status !== 'declined') return `${q.name} is already invited`;
  if (mem) mem.status = 'invited'; else op.members.push({ pid: other, status: 'invited' });
  emitOp(g, op);
  g.emit({ e: 'opInvite', _to: other, op: op.id, from: pid, name: op.name, target: op.target });
  if (!q.human) aiRespondOp(g, q, op);
  return null;
}

export function answerOp(g: Game, pid: number, opId: number, yes: boolean): string | null {
  const op = findOp(g, opId);
  const mem = op?.members.find((x) => x.pid === pid);
  if (!op || !mem || mem.status !== 'invited') return 'Invitation expired';
  if (!live(op) || op.status === 'running') { mem.status = 'declined'; return 'The operation has already started'; }
  if (yes && rel(g, pid, op.owner) !== REL.ALLY) return 'You are no longer allied with the planner';
  mem.status = yes ? 'joined' : 'declined';
  emitOp(g, op);
  if (!yes) g.emit({ e: 'opx', _to: pid, id: op.id });
  g.emit({ e: 'opAns', _to: op.owner, op: op.id, from: pid, yes: yes ? 1 : 0 });
  return null;
}

export function leaveOp(g: Game, pid: number, opId: number): string | null {
  const op = findOp(g, opId);
  const mem = op?.members.find((x) => x.pid === pid);
  if (!op || !mem) return 'Not part of this operation';
  if (op.status === 'running') return 'Too late to pull out';
  op.steps = op.steps.filter((x) => x.by !== pid);
  mem.status = 'declined';
  emitOp(g, op);
  g.emit({ e: 'opx', _to: pid, id: op.id });
  return null;
}

// ---- launch / abort -------------------------------------------------------------------------------------
export function launchOp(g: Game, pid: number, opId: number, countdown: number): string | null {
  const op = findOp(g, opId);
  if (!op) return 'Operation not found';
  if (op.owner !== pid) return 'Only the planner can launch the operation';
  if (op.status !== 'planning') return 'Already launched';
  if (!op.steps.length) return 'Add at least one step first';
  const cd = Math.max(0, Math.min(OPS.maxCountdown, Math.round(countdown || 0)));
  op.status = 'countdown';
  op.launchAt = g.s.tick + cd * TICK_RATE;
  emitOp(g, op);
  g.emit({ e: 'opGo', _p: participants(op), op: op.id, name: op.name, h: op.launchAt, started: 0 });
  return null;
}

export function cancelOp(g: Game, pid: number, opId: number): string | null {
  const op = findOp(g, opId);
  if (!op) return 'Operation not found';
  if (op.owner !== pid) return 'Only the planner can cancel the operation';
  if (!live(op)) return 'Operation already over';
  op.status = 'cancelled';
  op.endedAt = g.s.tick;
  emitOp(g, op);
  return null;
}

// ---- execution ---------------------------------------------------------------------------------------------
export function stepOps(g: Game) {
  const s = g.s;
  if (!s.operations.length) return;
  for (const op of s.operations) {
    if (!live(op)) continue;
    const owner = g.P(op.owner);
    if (!owner || !owner.alive) { op.status = 'cancelled'; op.endedAt = s.tick; emitOp(g, op); continue; }
    if (op.status === 'countdown' && s.tick >= op.launchAt) {
      op.status = 'running';
      g.emit({ e: 'opGo', _p: participants(op), op: op.id, name: op.name, h: op.launchAt, started: 1 });
    }
    if (op.status !== 'running') continue;
    let pending = 0, changed = false;
    for (const st of op.steps) {
      if (st.state !== 'planned') continue;
      if (s.tick < op.launchAt + Math.round(st.delay * TICK_RATE)) { pending++; continue; }
      execute(g, op, st);
      changed = true;
    }
    if (!pending) { op.status = 'done'; op.endedAt = s.tick; changed = true; }
    if (changed) emitOp(g, op);
  }
  // forget finished operations after a while
  const keep = OPS.keepSeconds * TICK_RATE;
  const gone = s.operations.filter((o) => !live(o) && s.tick - o.endedAt > keep);
  if (gone.length) {
    for (const o of gone) g.emit({ e: 'opx', _p: audience(o), id: o.id });
    s.operations = s.operations.filter((o) => !gone.includes(o));
  }
}

function execute(g: Game, op: Operation, st: OpStep) {
  const s = g.s, p = g.P(st.by);
  let err: string | null = null;
  if (!p || !p.alive) err = 'Nation no longer exists';
  else if (!isParticipant(op, p.id)) err = 'Left the operation';
  else {
    switch (st.kind) {
      case 'attack': {
        const o = s.owner[st.tile];
        err = o === p.id ? 'Already captured' : launchAttack(g, p.id, o, st.pct, st.tile);
        break;
      }
      case 'invade': err = invade(g, p, st.tile, st.pct); break;
      case 'missile': err = launchMissile(g, p, st.tile); break;
      case 'bomb': err = launchBomber(g, p, st.tile); break;
      case 'nuke': err = launchNuke(g, p, st.tile, 0); break;
      case 'mega': err = launchNuke(g, p, st.tile, 1); break;
      case 'fleet': err = moveWarships(g, p, st.tile); break;
    }
  }
  st.state = err ? 'failed' : 'done';
  st.note = err ?? '';
  g.emit({ e: 'opStep', _p: participants(op), op: op.id, step: st.id, ok: err ? 0 : 1, note: st.note, by: st.by, kind: st.kind, tile: st.tile, name: op.name });
}

// ---- AI participation -----------------------------------------------------------------------------------------
function sharesBorder(g: Game, a: Player, b: number): number {
  const m = g.map, own = g.s.owner, nb = new Int32Array(4);
  const n = a.border.length, step = Math.max(1, Math.floor(n / 400));
  for (let i = 0; i < n; i += step) {
    m.n4(a.border[i], nb);
    for (const x of nb) if (x >= 0 && own[x] === b) return x;
  }
  return -1;
}

/** The AI adds the steps it can actually carry out against the target. Returns how many. */
export function aiPlanSteps(g: Game, ai: Player, op: Operation): number {
  const s = g.s, m = g.map, t = g.P(op.target);
  if (!t || !t.alive) return 0;
  const before = op.steps.length;
  const base = op.steps.length ? Math.min(...op.steps.map((x) => x.delay)) : 0;
  const d = Math.max(0, ai.diff);
  const border = sharesBorder(g, ai, t.id);
  if (border >= 0) addStep(g, ai.id, op.id, 'attack', t.capital >= 0 ? t.capital : border, AI.attackFrac[d] + 0.1, base);
  else if (ai.stock[U.TRANSPORT] > 0 && ai.btype[B.SHIPYARD].length) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < 80 && t.owned.length; i++) {
      const x = t.owned[g.randInt(t.owned.length)];
      if (!m.coastal[x]) continue;
      const dd = ai.capital >= 0 ? m.dist2(x, ai.capital) : 0;
      if (dd < bd) { bd = dd; best = x; }
    }
    if (best >= 0) addStep(g, ai.id, op.id, 'invade', best, 0.3 + d * 0.05, base);
  }
  if (ai.stock[U.MISSILE] > 0) {
    const pool = [...t.btype[B.AIR_DEFENSE], ...t.btype[B.MISSILE_SILO], ...t.btype[B.BARRACKS], ...t.btype[B.CITY]];
    if (pool.length) addStep(g, ai.id, op.id, 'missile', s.buildings[pool[g.randInt(pool.length)]]!.tile, 0, base + 2);
  }
  if (ai.stock[U.BOMBER] > 0 && t.btype[B.FACTORY].length) addStep(g, ai.id, op.id, 'bomb', s.buildings[t.btype[B.FACTORY][0]]!.tile, 0, base + 4);
  return op.steps.length - before;
}

/** An AI ally decides whether to join an operation it was invited to. */
export function aiRespondOp(g: Game, ai: Player, op: Operation) {
  const t = g.P(op.target), owner = g.P(op.owner);
  let yes = !!t && !!owner && t.alive;
  if (yes) {
    const r = rel(g, ai.id, t!.id);
    if (r === REL.ALLY || r === REL.NAP) yes = false;
    else if (opinion(g, ai.id, op.owner) < -20) yes = false;
    else if (effTroops(ai) + effTroops(owner!) < effTroops(t!) * (ai.diff === 2 ? 0.5 : ai.diff === 1 ? 0.8 : 1.2)) yes = false;
  }
  if (!yes) { answerOp(g, ai.id, op.id, false); return; }
  answerOp(g, ai.id, op.id, true);
  if (!aiPlanSteps(g, ai, op)) leaveOp(g, ai.id, op.id); // joined but has no way to help
}

/** Occasionally an AI at war leads an operation and invites a human ally to join during the countdown. */
export function aiLeadOp(g: Game, ai: Player, foe: Player) {
  const s = g.s;
  if (!ai.ai || ai.diff < 1) return;
  if (s.tick - (ai.ai.lastOp ?? -1e9) < OPS.aiInviteSeconds * TICK_RATE) return;
  const human = ai.allies.map((id) => g.P(id)).find((p) => p && p.human && p.alive && rel(g, p.id, foe.id) !== REL.ALLY);
  if (!human) return;
  ai.ai.lastOp = s.tick;
  const op = createOp(g, ai.id, foe.id, '');
  if (typeof op === 'string') return;
  if (!aiPlanSteps(g, ai, op)) { op.status = 'cancelled'; op.endedAt = s.tick; emitOp(g, op); return; }
  inviteToOp(g, ai.id, op.id, human.id);
  launchOp(g, ai.id, op.id, OPS.aiCountdown);
}

/** Operations a player can see (for the join snapshot). */
export function opsFor(g: Game, pid: number): Operation[] {
  return g.s.operations.filter((o) => audience(o).includes(pid));
}
