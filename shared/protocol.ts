// Wire protocol helpers shared by client and server.
// Client -> server: JSON text frames ({t: ...}).
// Server -> client: JSON text frames for lobby traffic; binary frames (first byte = type) for game state.

export const MSG = { INIT: 1, TICK: 2 } as const;

export class Writer {
  buf: Uint8Array;
  dv: DataView;
  o = 0;
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
  }
  private need(n: number) {
    if (this.o + n <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.o + n) s *= 2;
    const nb = new Uint8Array(s);
    nb.set(this.buf.subarray(0, this.o));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  reset() { this.o = 0; return this; }
  u8(v: number) { this.need(1); this.buf[this.o++] = v; }
  u16(v: number) { this.need(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
  u32(v: number) { this.need(4); this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; }
  f32(v: number) { this.need(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  vu(v: number) {
    // unsigned LEB128 (supports up to 2^53)
    this.need(8);
    while (v >= 0x80) { this.buf[this.o++] = (v & 0x7f) | 0x80; v = Math.floor(v / 128); }
    this.buf[this.o++] = v;
  }
  vs(v: number) { this.vu(v < 0 ? -2 * v - 1 : 2 * v); }
  bytes(b: Uint8Array) { this.need(b.length); this.buf.set(b, this.o); this.o += b.length; }
  str(s: string) { const b = new TextEncoder().encode(s); this.vu(b.length); this.bytes(b); }
  json(v: unknown) { this.str(JSON.stringify(v)); }
  view(): Uint8Array { return this.buf.subarray(0, this.o); }
  copy(): Uint8Array { return this.buf.slice(0, this.o); }
}

export class Reader {
  dv: DataView;
  o = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get done() { return this.o >= this.b.length; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  vu() {
    let v = 0, m = 1, b: number;
    do { b = this.b[this.o++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    return v;
  }
  vs() { const v = this.vu(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  bytes(n: number) { const r = this.b.subarray(this.o, this.o + n); this.o += n; return r; }
  str() { const n = this.vu(); return new TextDecoder().decode(this.bytes(n)); }
  json<T = any>(): T { return JSON.parse(this.str()); }
}

/** Run-length encode a typed array of small unsigned ints. */
export function rleEncode(w: Writer, a: ArrayLike<number>) {
  const n = a.length;
  let i = 0, runs = 0;
  const start = w.o;
  w.u32(0); // run count placeholder
  while (i < n) {
    const v = a[i];
    let j = i + 1;
    while (j < n && a[j] === v) j++;
    w.vu(v);
    w.vu(j - i);
    runs++;
    i = j;
  }
  w.dv.setUint32(start, runs, true);
}
export function rleDecode(r: Reader, out: { [i: number]: number; length: number }) {
  const runs = r.u32();
  let o = 0;
  for (let k = 0; k < runs; k++) {
    const v = r.vu(), len = r.vu();
    for (let i = 0; i < len; i++) out[o++] = v;
  }
}

/** Encode owner changes grouped by owner with delta-coded sorted indices. */
export function encodeTileChanges(w: Writer, tiles: number[], owners: Uint16Array) {
  const groups = new Map<number, number[]>();
  for (const t of tiles) {
    const o = owners[t];
    let g = groups.get(o);
    if (!g) groups.set(o, (g = []));
    g.push(t);
  }
  w.vu(groups.size);
  for (const [o, list] of groups) {
    list.sort((a, b) => a - b);
    w.vu(o);
    w.vu(list.length);
    let prev = 0;
    for (const t of list) { w.vu(t - prev); prev = t; }
  }
}
export function decodeTileChanges(r: Reader, cb: (t: number, owner: number) => void) {
  const g = r.vu();
  for (let k = 0; k < g; k++) {
    const o = r.vu(), n = r.vu();
    let t = 0;
    for (let i = 0; i < n; i++) { t += r.vu(); cb(t, o); }
  }
}

// ---- shared message shapes ---------------------------------------------------------------
export interface MatchSettings {
  mapSize: 'small' | 'medium' | 'large';
  aiCount: number;
  aiDifficulty: 'mixed' | 'passive' | 'defensive' | 'aggressive';
  speed: number;
  spawnSeconds: number;
  peaceSeconds: number;
  timeLimitMin: number;
  winPercent: number;
  nukes: boolean;
  nuclearWinter: boolean;
  sharedVictory: boolean;
  fog: boolean;
}
export const DEFAULT_SETTINGS: MatchSettings = {
  mapSize: 'medium',
  aiCount: 200,
  aiDifficulty: 'mixed',
  speed: 1,
  spawnSeconds: 20,
  peaceSeconds: 60,
  timeLimitMin: 0,
  winPercent: 70,
  nukes: true,
  nuclearWinter: true,
  sharedVictory: true,
  fog: true,
};

export function sanitizeSettings(s: Partial<MatchSettings>, base: MatchSettings = DEFAULT_SETTINGS): MatchSettings {
  const r = { ...base };
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  if (s.mapSize === 'small' || s.mapSize === 'medium' || s.mapSize === 'large') r.mapSize = s.mapSize;
  r.aiCount = Math.round(num(s.aiCount, 0, 500, r.aiCount));
  if (['mixed', 'passive', 'defensive', 'aggressive'].includes(s.aiDifficulty as string)) r.aiDifficulty = s.aiDifficulty!;
  r.speed = num(s.speed, 0.5, 3, r.speed);
  r.spawnSeconds = Math.round(num(s.spawnSeconds, 5, 90, r.spawnSeconds));
  r.peaceSeconds = Math.round(num(s.peaceSeconds, 0, 600, r.peaceSeconds));
  r.timeLimitMin = Math.round(num(s.timeLimitMin, 0, 600, r.timeLimitMin));
  r.winPercent = Math.round(num(s.winPercent, 20, 100, r.winPercent));
  for (const k of ['nukes', 'nuclearWinter', 'sharedVictory', 'fog'] as const) if (typeof s[k] === 'boolean') r[k] = s[k] as boolean;
  return r;
}

/** Relation between two players. */
export const REL = { PEACE: 0, WAR: 1, NAP: 2, ALLY: 3 } as const;
export const REL_NAMES = ['Peace', 'War', 'Non-aggression', 'Alliance'];
