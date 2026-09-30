// Min-heaps.
// heapPush/heapPop work on plain arrays so attack frontiers stay serializable.

export function heapPush(tiles: number[], pri: number[], t: number, p: number): void {
  let i = tiles.length;
  tiles.push(t);
  pri.push(p);
  while (i > 0) {
    const par = (i - 1) >> 1;
    if (pri[par] <= p) break;
    tiles[i] = tiles[par];
    pri[i] = pri[par];
    i = par;
  }
  tiles[i] = t;
  pri[i] = p;
}

/** Remove the minimum. Read tiles[0]/pri[0] before calling. */
export function heapPop(tiles: number[], pri: number[]): void {
  const n = tiles.length - 1;
  if (n < 0) return;
  const lt = tiles[n], lp = pri[n];
  tiles.length = n;
  pri.length = n;
  if (n === 0) return;
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && pri[c + 1] < pri[c]) c++;
    if (pri[c] >= lp) break;
    tiles[i] = tiles[c];
    pri[i] = pri[c];
    i = c;
  }
  tiles[i] = lt;
  pri[i] = lp;
}

/** Typed-array heap used by A* (not serialized). */
export class NumHeap {
  keys: Float64Array;
  vals: Int32Array;
  size = 0;
  constructor(cap = 1024) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
  }
  clear() { this.size = 0; }
  push(v: number, k: number) {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2); nk.set(this.keys); this.keys = nk;
      const nv = new Int32Array(this.size * 2); nv.set(this.vals); this.vals = nv;
    }
    let i = this.size++;
    const K = this.keys, V = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = k; V[i] = v;
  }
  pop(): number {
    const K = this.keys, V = this.vals;
    const top = V[0];
    const n = --this.size;
    if (n > 0) {
      const lk = K[n], lv = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= lk) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = lk; V[i] = lv;
    }
    return top;
  }
}
