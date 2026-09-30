// Static map data shared by client and server.
//
// File format (gzip-compressed): world-<W>.bin.gz
//   'PXW1'  u16 W  u16 H  u32 jsonLen  json(countries[])  terrain[N] u8  country[N] u8  resource[N] u8
// Tiles are row-major, index t = y * W + x. The map wraps horizontally (x = -1 is x = W-1).

import { T, TERRAIN, mapScale, areaScale } from './balance.ts';

export interface CountryMeta { n: string; a: string; c: string }

export class GameMap {
  readonly W: number;
  readonly H: number;
  readonly N: number;
  readonly terrain: Uint8Array;
  readonly country: Uint8Array;
  readonly resource: Uint8Array;
  readonly countries: CountryMeta[];
  /** water body id for water tiles (4-connected), -1 on land */
  readonly waterBody: Int32Array;
  readonly bodySize: number[] = [];
  /** 1 if land tile touches water (4-neighbourhood) */
  readonly coastal: Uint8Array;
  /** land tiles list (for random sampling) */
  readonly landTiles: Int32Array;
  readonly landCount: number;
  /** per-tile static stats */
  readonly tilePop: Float32Array;
  readonly tileFood: Float32Array;
  readonly tileTrade: Float32Array;
  readonly ms: number;  // linear scale vs reference map
  readonly as: number;  // area scale vs reference map

  constructor(W: number, H: number, terrain: Uint8Array, country: Uint8Array, resource: Uint8Array, countries: CountryMeta[]) {
    this.W = W; this.H = H; this.N = W * H;
    this.terrain = terrain; this.country = country; this.resource = resource; this.countries = countries;
    this.ms = mapScale(W);
    this.as = areaScale(W);
    const N = this.N;
    this.coastal = new Uint8Array(N);
    this.tilePop = new Float32Array(N);
    this.tileFood = new Float32Array(N);
    this.tileTrade = new Float32Array(N);
    let land = 0;
    for (let t = 0; t < N; t++) {
      const td = TERRAIN[terrain[t]];
      if (td.water) continue;
      land++;
      this.tilePop[t] = td.pop * this.as;
      this.tileFood[t] = td.food * this.as;
      this.tileTrade[t] = td.trade * this.as;
      const x = t % W;
      const l = x === 0 ? t + W - 1 : t - 1, r = x === W - 1 ? t - W + 1 : t + 1;
      if (this.isWater(l) || this.isWater(r) || (t >= W && this.isWater(t - W)) || (t < N - W && this.isWater(t + W))) this.coastal[t] = 1;
    }
    this.landCount = land;
    this.landTiles = new Int32Array(land);
    let k = 0;
    for (let t = 0; t < N; t++) if (!TERRAIN[terrain[t]].water) this.landTiles[k++] = t;
    // water bodies
    this.waterBody = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    let body = 0;
    for (let s = 0; s < N; s++) {
      if (this.waterBody[s] !== -1 || !this.isWater(s)) continue;
      let sp = 0, size = 0;
      stack[sp++] = s;
      this.waterBody[s] = body;
      while (sp > 0) {
        const t = stack[--sp];
        size++;
        const x = t % W;
        const nb0 = x === 0 ? t + W - 1 : t - 1, nb1 = x === W - 1 ? t - W + 1 : t + 1;
        const nb2 = t >= W ? t - W : -1, nb3 = t < N - W ? t + W : -1;
        if (this.waterBody[nb0] === -1 && this.isWater(nb0)) { this.waterBody[nb0] = body; stack[sp++] = nb0; }
        if (this.waterBody[nb1] === -1 && this.isWater(nb1)) { this.waterBody[nb1] = body; stack[sp++] = nb1; }
        if (nb2 >= 0 && this.waterBody[nb2] === -1 && this.isWater(nb2)) { this.waterBody[nb2] = body; stack[sp++] = nb2; }
        if (nb3 >= 0 && this.waterBody[nb3] === -1 && this.isWater(nb3)) { this.waterBody[nb3] = body; stack[sp++] = nb3; }
      }
      this.bodySize.push(size);
      body++;
    }
  }

  isWater(t: number): boolean { return this.terrain[t] <= T.SHALLOW; }
  isLand(t: number): boolean { return this.terrain[t] > T.SHALLOW; }
  x(t: number): number { return t % this.W; }
  y(t: number): number { return (t / this.W) | 0; }
  idx(x: number, y: number): number {
    x = ((x % this.W) + this.W) % this.W;
    return y * this.W + x;
  }
  /** Fill `out` with the 4 neighbours (-1 where off-map vertically). */
  n4(t: number, out: Int32Array): void {
    const W = this.W, x = t % W;
    out[0] = x === 0 ? t + W - 1 : t - 1;
    out[1] = x === W - 1 ? t - W + 1 : t + 1;
    out[2] = t >= W ? t - W : -1;
    out[3] = t < this.N - W ? t + W : -1;
  }
  dx(ax: number, bx: number): number {
    let d = Math.abs(ax - bx);
    return d > this.W / 2 ? this.W - d : d;
  }
  /** signed shortest horizontal offset from a to b */
  sdx(ax: number, bx: number): number {
    let d = bx - ax;
    if (d > this.W / 2) d -= this.W; else if (d < -this.W / 2) d += this.W;
    return d;
  }
  dist2(a: number, b: number): number {
    const W = this.W;
    const dx = this.dx(a % W, b % W), dy = ((a / W) | 0) - ((b / W) | 0);
    return dx * dx + dy * dy;
  }
  dist(a: number, b: number): number { return Math.sqrt(this.dist2(a, b)); }
  /** Iterate tiles within radius r of center (inclusive). */
  forRadius(center: number, r: number, cb: (t: number, d2: number) => void): void {
    const W = this.W, cx = center % W, cy = (center / W) | 0, ri = Math.ceil(r), r2 = r * r;
    for (let dy = -ri; dy <= ri; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.H) continue;
      for (let dx = -ri; dx <= ri; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        let x = cx + dx;
        if (x < 0) x += W; else if (x >= W) x -= W;
        cb(y * W + x, d2);
      }
    }
  }
  countryName(t: number): string {
    const c = this.country[t];
    return c ? this.countries[c - 1].n : this.isWater(t) ? 'Ocean' : 'Unclaimed land';
  }
}

export function decodeMap(bytes: Uint8Array): GameMap {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'PXW1') throw new Error('bad map file');
  const W = dv.getUint16(4, true), H = dv.getUint16(6, true), jl = dv.getUint32(8, true);
  const N = W * H;
  const json = new TextDecoder().decode(bytes.subarray(12, 12 + jl));
  let o = 12 + jl;
  const terrain = bytes.slice(o, o + N); o += N;
  const country = bytes.slice(o, o + N); o += N;
  const resource = bytes.slice(o, o + N);
  return new GameMap(W, H, terrain, country, resource, JSON.parse(json));
}

export const mapFileName = (w: number) => `world-${w}.bin.gz`;
