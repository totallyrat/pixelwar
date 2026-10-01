// Plain-data simulation state. Everything in State is serializable with v8.serialize so rooms
// can be snapshotted to disk and restored after a server restart.

import type { MatchSettings } from '../../shared/protocol.ts';

export interface AIState {
  next: number;          // tick of next think
  lastWar: number;
  lastNaval: number;
  lastDiplo: number;
  focus: number;         // preferred enemy id
  lastOp?: number;       // tick the AI last led an allied operation
}

export type OpKind = 'attack' | 'invade' | 'missile' | 'bomb' | 'nuke' | 'mega' | 'fleet';
export interface OpStep {
  id: number;
  by: number;            // executing nation
  kind: OpKind;
  tile: number;
  pct: number;           // troop share for attack / invade
  delay: number;         // seconds after H-hour
  state: 'planned' | 'done' | 'failed';
  note: string;
}
export interface OpMember { pid: number; status: 'invited' | 'joined' | 'declined' }
export interface Operation {
  id: number;
  name: string;
  owner: number;
  target: number;        // nation the operation is aimed at (0 = none)
  members: OpMember[];   // allies (owner excluded)
  steps: OpStep[];
  status: 'planning' | 'countdown' | 'running' | 'done' | 'cancelled';
  launchAt: number;      // H-hour tick
  created: number;
  endedAt: number;
  nextStep: number;
}

export interface Player {
  id: number;
  name: string;
  color: number;
  human: boolean;
  token: string;
  diff: number;          // AI difficulty 0 passive 1 defensive 2 aggressive (-1 human)
  team: number;
  alive: boolean;
  spawned: boolean;
  capital: number;       // tile or -1
  tiles: number;
  popCapTiles: number;
  foodTiles: number;
  tradeTiles: number;
  falloutTiles: number;
  pop: number;
  troops: number;
  tanks: number;
  mobilization: number;
  food: number;
  prod: number;
  money: number;
  oil: number;
  uranium: number;
  rates: number[];       // food prod money oil uranium pop troops (per second)
  popCap: number;
  happiness: number;
  starving: boolean;
  techOff: number;
  techDef: number;
  stock: number[];       // per unit type (tanks live in .tanks, warships are entities)
  queue: number[];       // queued units per type
  qprog: number[];       // seconds of progress toward the next unit per type
  levels: number[];      // sum of *active* building levels per type
  btype: number[][];     // building ids per type (includes under construction)
  farmFood: number;      // sum over active farms of level * terrain.farm
  slotsUsed: number;
  traitorUntil: number;
  recentLoss: number;
  score: number;
  owned: number[];
  border: number[];
  blocks: Map<number, number>;
  ships: number;         // live warships + transports
  allies: number[];
  ai: AIState | null;
  killedBy: number;
  eliminatedAt: number;
  stats: { tilesTaken: number; nukes: number; kills: number };
}

export interface Building {
  id: number;
  type: number;
  tile: number;
  owner: number;
  level: number;         // active level (0 while first under construction)
  done: number;          // tick when current construction/upgrade completes, 0 if idle
}

export interface Attack {
  id: number;
  attacker: number;
  target: number;        // 0 = neutral land
  troops: number;
  tanks: number;
  tiles: number[];       // min-heap of candidate tiles
  pri: number[];
  clock: number;
  focus: number;         // tile the attack is pulled toward, -1 none
  landing: number;       // naval beachhead tile allowed without adjacency, -1 none
  born: number;
  taken: number;
}

export interface Ship {
  id: number;
  type: number;          // U.WARSHIP | U.TRANSPORT
  owner: number;
  tile: number;
  path: number[];
  pi: number;
  prog: number;
  hp: number;
  troops: number;
  tanks: number;
  dest: number;          // transports: land tile to invade
}

export interface Flight {
  id: number;
  kind: 'missile' | 'nuke' | 'bomber' | 'return' | 'interceptor';
  owner: number;
  from: number;
  to: number;
  t0: number;
  t1: number;
  ref: number;           // interceptor: nuke flight id; bomber return: airbase tile
  dead: boolean;
  tier: number;          // warheads: index into NUKE_TIERS
}

export interface Proposal { from: number; to: number; kind: 'nap' | 'ally' | 'peace'; expires: number }

export interface ChatLine { ch: 'g' | 'a'; from: number; name: string; text: string; tick: number; party?: number[] }

export interface State {
  version: number;
  tick: number;
  phase: 'spawn' | 'running' | 'ended';
  phaseEnd: number;
  startTick: number;
  peaceUntil: number;
  settings: MatchSettings;
  seed: number;
  rng: number[];
  owner: Uint16Array;
  fallout: Uint16Array;  // seconds remaining
  falloutList: number[];
  bldAt: Int32Array;
  ownedPos: Int32Array;
  borderPos: Int32Array;
  players: (Player | null)[];
  buildings: (Building | null)[];
  freeB: number[];
  pendingB: number[];
  attacks: Attack[];
  ships: Ship[];
  flights: Flight[];
  rel: Uint8Array;
  opinion: Int8Array;
  proposals: Proposal[];
  napUntil: Map<number, number>;  // key min*MAXP+max -> tick the pact expires
  operations: Operation[];
  nextId: number;
  winter: number;
  winterTimer: number;
  humansAtStart: number;
  winner: { ids: number[]; reason: string } | null;
  usedNames: string[];
  chat: ChatLine[];
}

export interface GameEvent {
  e: string;
  _all?: boolean;
  _to?: number;
  _p?: number[];
  _at?: number;
  [k: string]: unknown;
}
