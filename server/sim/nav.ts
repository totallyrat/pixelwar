// Naval pathfinding. Hierarchical A*: a coarse search over 8x8 blocks finds a corridor, then a fine
// 8-directional A* runs inside the corridor. Falls back to a budgeted unrestricted search.
// Buffers are shared per map (not serialized).

import type { GameMap } from '../../shared/mapdata.ts';
import { NumHeap } from './heap.ts';

const SQRT2 = Math.SQRT2;
const CB = 8;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

export class Nav {
  readonly map: GameMap;
  readonly water: Uint8Array;
  readonly CW: number;
  readonly CH: number;
  readonly cellBody: Int32Array;
  private g: Float32Array;
  private came: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private gen = 0;
  private heap = new NumHeap(8192);
  private corr: Uint32Array;
  private corrGen = 0;
  private cg: Float32Array;
  private ccame: Int32Array;
  private cseen: Uint32Array;
  private cclosed: Uint32Array;
  private cgen = 0;
  private cheap = new NumHeap(2048);

  constructor(map: GameMap) {
    this.map = map;
    const N = map.N;
    this.water = new Uint8Array(N);
    for (let t = 0; t < N; t++) this.water[t] = map.isWater(t) ? 1 : 0;
    this.CW = Math.ceil(map.W / CB);
    this.CH = Math.ceil(map.H / CB);
    const C = this.CW * this.CH;
    this.cellBody = new Int32Array(C).fill(-1);
    for (let t = 0; t < N; t++) {
      if (!this.water[t]) continue;
      const c = this.cell(t), b = map.waterBody[t];
      const cur = this.cellBody[c];
      if (cur === -1) this.cellBody[c] = b;
      else if (cur !== b) this.cellBody[c] = -2;
    }
    this.g = new Float32Array(N);
    this.came = new Int32Array(N);
    this.seen = new Uint32Array(N);
    this.closed = new Uint32Array(N);
    this.corr = new Uint32Array(C);
    this.cg = new Float32Array(C);
    this.ccame = new Int32Array(C);
    this.cseen = new Uint32Array(C);
    this.cclosed = new Uint32Array(C);
  }

  cell(t: number): number {
    const W = this.map.W;
    return (((t / W) | 0) / CB | 0) * this.CW + ((t % W) / CB | 0);
  }

  /** Water path from `from` to `to` (both water tiles), inclusive. */
  path(from: number, to: number): number[] | null {
    const m = this.map;
    if (!this.water[from] || !this.water[to]) return null;
    const body = m.waterBody[from];
    if (m.waterBody[to] !== body) return null;
    if (from === to) return [from];
    const cp = this.coarse(this.cell(from), this.cell(to), body);
    if (cp) {
      this.corrGen++;
      const CW = this.CW, CH = this.CH;
      for (const c of cp) {
        const cx = c % CW, cy = (c / CW) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const y = cy + dy;
          if (y < 0 || y >= CH) continue;
          for (let dx = -1; dx <= 1; dx++) this.corr[y * CW + ((cx + dx + CW) % CW)] = this.corrGen;
        }
      }
      const r = this.fine(from, to, true, 250000);
      if (r) return r;
    }
    return this.fine(from, to, false, 600000);
  }

  private coarse(a: number, b: number, body: number): number[] | null {
    const CW = this.CW, CH = this.CH, cb = this.cellBody;
    if (++this.cgen >= 0xffffffff) { this.cgen = 1; this.cseen.fill(0); this.cclosed.fill(0); }
    const gen = this.cgen, g = this.cg, came = this.ccame, seen = this.cseen, closed = this.cclosed, heap = this.cheap;
    heap.clear();
    const bx = b % CW, by = (b / CW) | 0;
    const h = (c: number) => {
      let dx = Math.abs((c % CW) - bx);
      if (dx > CW / 2) dx = CW - dx;
      const dy = Math.abs(((c / CW) | 0) - by);
      return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
    };
    g[a] = 0; came[a] = -1; seen[a] = gen;
    heap.push(a, h(a));
    while (heap.size) {
      const c = heap.pop();
      if (c === b) {
        const out: number[] = [];
        for (let k = c; k !== -1; k = came[k]) out.push(k);
        return out;
      }
      if (closed[c] === gen) continue;
      closed[c] = gen;
      const cx = c % CW, cy = (c / CW) | 0, gc = g[c];
      for (let d = 0; d < 8; d++) {
        const ny = cy + DY[d];
        if (ny < 0 || ny >= CH) continue;
        const n = ny * CW + ((cx + DX[d] + CW) % CW);
        const nb = cb[n];
        if (nb !== body && nb !== -2) continue;
        const ng = gc + (d < 4 ? 1 : SQRT2);
        if (seen[n] !== gen || ng < g[n]) {
          seen[n] = gen; g[n] = ng; came[n] = c;
          heap.push(n, ng + h(n));
        }
      }
    }
    return null;
  }

  private fine(from: number, to: number, useCorr: boolean, budget: number): number[] | null {
    const m = this.map, W = m.W, H = m.H, water = this.water;
    if (++this.gen >= 0xffffffff) { this.gen = 1; this.seen.fill(0); this.closed.fill(0); }
    const gen = this.gen, g = this.g, came = this.came, seen = this.seen, closed = this.closed, heap = this.heap;
    const corr = this.corr, cgen = this.corrGen, CW = this.CW;
    heap.clear();
    const tx = to % W, ty = (to / W) | 0;
    const h = (t: number) => {
      let dx = Math.abs((t % W) - tx);
      if (dx > W / 2) dx = W - dx;
      const dy = Math.abs(((t / W) | 0) - ty);
      return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
    };
    g[from] = 0; came[from] = -1; seen[from] = gen;
    heap.push(from, h(from));
    let expanded = 0;
    while (heap.size) {
      const t = heap.pop();
      if (t === to) {
        const out: number[] = [];
        for (let k = t; k !== -1; k = came[k]) out.push(k);
        out.reverse();
        return out;
      }
      if (closed[t] === gen) continue;
      closed[t] = gen;
      if (++expanded > budget) return null;
      const x = t % W, y = (t / W) | 0, gt = g[t];
      for (let d = 0; d < 8; d++) {
        const ny = y + DY[d];
        if (ny < 0 || ny >= H) continue;
        let nx = x + DX[d];
        if (nx < 0) nx += W; else if (nx >= W) nx -= W;
        const n = ny * W + nx;
        if (!water[n]) continue;
        if (d >= 4 && (!water[y * W + nx] || !water[ny * W + x])) continue;
        if (useCorr && corr[((ny / CB) | 0) * CW + ((nx / CB) | 0)] !== cgen) continue;
        const ng = gt + (d < 4 ? 1 : SQRT2);
        if (seen[n] !== gen || ng < g[n]) {
          seen[n] = gen; g[n] = ng; came[n] = t;
          heap.push(n, ng + h(n));
        }
      }
    }
    return null;
  }
}

const cache = new WeakMap<GameMap, Nav>();
export function getNav(map: GameMap): Nav {
  let n = cache.get(map);
  if (!n) { n = new Nav(map); cache.set(map, n); }
  return n;
}
