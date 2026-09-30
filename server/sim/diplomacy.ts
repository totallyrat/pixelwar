// Relations, proposals (NAP / alliance / peace), war declarations, betrayal, donations, AI opinion.

import { LIMITS, COMBAT, TICK_RATE, AI, DIPLO } from '../../shared/balance.ts';
import { REL, REL_NAMES } from '../../shared/protocol.ts';
import type { Game } from './game.ts';
import type { Player } from './types.ts';
import { effTroops } from './combat.ts';

const MAXP = LIMITS.maxPlayers;

export const rel = (g: Game, a: number, b: number): number => (a && b ? g.s.rel[a * MAXP + b] : REL.PEACE);

export function setRel(g: Game, a: number, b: number, r: number) {
  const s = g.s, pa = g.P(a), pb = g.P(b);
  if (!pa || !pb || a === b) return;
  const old = s.rel[a * MAXP + b];
  if (old === r) return;
  s.rel[a * MAXP + b] = r;
  s.rel[b * MAXP + a] = r;
  if (old === REL.ALLY) { pa.allies = pa.allies.filter((x) => x !== b); pb.allies = pb.allies.filter((x) => x !== a); }
  if (r === REL.ALLY) { pa.allies.push(b); pb.allies.push(a); }
  const key = Math.min(a, b) * MAXP + Math.max(a, b);
  let until = 0;
  if (r === REL.NAP) { until = s.tick + Math.round((DIPLO.napSeconds * TICK_RATE) / g.speed); s.napUntil.set(key, until); }
  else s.napUntil.delete(key);
  g.emit({ e: 'rel', _p: [a, b], a, b, r, until });
  if (pa.human || pb.human) {
    const verb = r === REL.WAR ? 'declared war on' : r === REL.ALLY ? 'formed an alliance with' : r === REL.NAP ? 'signed a non-aggression pact with' : 'made peace with';
    g.emit({ e: 'news', _all: true, a, b, r, text: `${pa.name} ${verb} ${pb.name}` });
  }
  // allies' vision changes
  if (old === REL.ALLY || r === REL.ALLY) g.visGen++;
}

export function adjustOpinion(g: Game, who: number, of: number, d: number) {
  const i = who * MAXP + of;
  g.s.opinion[i] = Math.max(-100, Math.min(100, g.s.opinion[i] + d));
}
export const opinion = (g: Game, who: number, of: number) => g.s.opinion[who * MAXP + of];

export function declareWar(g: Game, a: number, b: number, explicit: boolean): string | null {
  const pa = g.P(a), pb = g.P(b);
  if (!pa || !pb || !pb.alive || a === b) return 'Invalid nation';
  const r = rel(g, a, b);
  if (r === REL.WAR) return explicit ? 'Already at war' : null;
  if (r === REL.ALLY || r === REL.NAP) return breakTreaty(g, a, b);
  setRel(g, a, b, REL.WAR);
  if (!pb.human) adjustOpinion(g, b, a, -25);
  return null;
}

/** Betrayal: breaking a NAP or alliance. Traitors get a defence debuff and everyone dislikes them. */
export function breakTreaty(g: Game, a: number, b: number): string | null {
  const pa = g.P(a), pb = g.P(b);
  if (!pa || !pb) return 'Invalid nation';
  const r = rel(g, a, b);
  if (r !== REL.ALLY && r !== REL.NAP) return 'No treaty to break';
  setRel(g, a, b, REL.WAR);
  pa.traitorUntil = g.s.tick + Math.round(COMBAT.traitorSeconds * TICK_RATE);
  for (const q of g.s.players) if (q && !q.human && q.alive && q.id !== a) adjustOpinion(g, q.id, a, q.id === b ? -80 : -20);
  g.emit({ e: 'news', _all: true, a, b, r: -1, text: `${pa.name} BETRAYED ${pb.name}!` });
  return null;
}

export function propose(g: Game, from: number, to: number, kind: unknown): string | null {
  const s = g.s, pf = g.P(from), pt = g.P(to);
  if (kind !== 'nap' && kind !== 'ally' && kind !== 'peace') return 'Unknown proposal';
  if (!pf || !pt || !pt.alive || from === to) return 'Invalid nation';
  const r = rel(g, from, to);
  if (kind === 'peace' && r !== REL.WAR) return 'You are not at war';
  if (kind === 'nap' && (r === REL.NAP || r === REL.ALLY)) return 'Already have a treaty';
  if (kind === 'ally' && r === REL.ALLY) return 'Already allied';
  if (kind !== 'peace' && r === REL.WAR) return 'Make peace first';
  if (s.proposals.some((p) => p.from === from && p.to === to && p.kind === kind)) return 'Already proposed';
  if (!pt.human) {
    const yes = aiAccepts(g, pt, pf, kind);
    applyProposal(g, from, to, kind, yes);
    return null;
  }
  s.proposals.push({ from, to, kind, expires: s.tick + 30 * TICK_RATE });
  g.emit({ e: 'prop', _to: to, from, kind });
  g.emit({ e: 'propSent', _to: from, to, kind });
  return null;
}

export function respond(g: Game, pid: number, from: number, kind: unknown, yes: boolean): string | null {
  const s = g.s;
  const i = s.proposals.findIndex((p) => p.from === from && p.to === pid && p.kind === kind);
  if (i < 0) return 'Proposal expired';
  const pr = s.proposals[i];
  s.proposals.splice(i, 1);
  applyProposal(g, from, pid, pr.kind, yes);
  return null;
}

function applyProposal(g: Game, from: number, to: number, kind: 'nap' | 'ally' | 'peace', yes: boolean) {
  const pf = g.P(from)!, pt = g.P(to)!;
  if (yes) {
    setRel(g, from, to, kind === 'ally' ? REL.ALLY : kind === 'nap' ? REL.NAP : REL.PEACE);
    if (!pf.human) adjustOpinion(g, from, to, 10);
    if (!pt.human) adjustOpinion(g, to, from, 10);
  }
  g.emit({ e: 'propAns', _p: [from, to], from, to, kind, yes: yes ? 1 : 0 });
}

export function aiAccepts(g: Game, ai: Player, other: Player, kind: 'nap' | 'ally' | 'peace'): boolean {
  const o = opinion(g, ai.id, other.id);
  const ratio = (effTroops(other) + 1) / (effTroops(ai) + 1);
  const d = ai.diff;
  if (kind === 'nap') {
    if (d === 0) return o > -40;
    if (d === 1) return o > -20 && ratio > 0.6;
    return o > 10 && ratio > 1.4;
  }
  if (kind === 'ally') {
    if (ai.allies.length >= AI.maxAllies) return false;
    const need = d === 0 ? 5 : d === 1 ? 20 : 40;
    return o + (ratio > 1.5 ? 20 : 0) > need;
  }
  // peace
  if (ratio > 1.3) return o > -70;
  return o > -30 && g.rand() < 0.5;
}

export function donate(g: Game, from: number, to: number, troopsFrac: number, moneyFrac: number): string | null {
  const pf = g.P(from), pt = g.P(to);
  if (!pf || !pt || !pt.alive) return 'Invalid nation';
  if (rel(g, from, to) !== REL.ALLY) return 'You can only send aid to allies';
  const tr = pf.troops * troopsFrac, mo = pf.money * moneyFrac;
  pf.troops -= tr; pt.troops += tr;
  pf.money -= mo; pt.money += mo;
  if (!pt.human) adjustOpinion(g, to, from, 8);
  g.emit({ e: 'aid', _p: [from, to], from, to, troops: Math.round(tr), money: Math.round(mo) });
  return null;
}

/** Non-aggression pacts are time-limited; they lapse back to plain peace. */
export function expirePacts(g: Game) {
  const s = g.s;
  for (const [key, until] of s.napUntil) {
    if (until > s.tick) continue;
    s.napUntil.delete(key);
    const a = Math.floor(key / MAXP), b = key % MAXP;
    if (rel(g, a, b) === REL.NAP) setRel(g, a, b, REL.PEACE);
  }
}

export function driftOpinions(g: Game) {
  const s = g.s, op = s.opinion;
  for (const p of s.players) {
    if (!p || p.human || !p.alive) continue;
    const base = p.id * MAXP;
    for (let j = 1; j < s.players.length; j++) {
      const v = op[base + j];
      if (v > 0) op[base + j] = v - 1; else if (v < 0) op[base + j] = v + 1;
      if (s.rel[base + j] === REL.ALLY && op[base + j] < 60) op[base + j] += 2;
    }
  }
}

export { REL_NAMES };
