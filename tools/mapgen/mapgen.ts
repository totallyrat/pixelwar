// PIXEL WAR map generator.
// Rasterizes Natural Earth GeoJSON (50m countries, lakes, geography regions) into a pixel grid
// using a Miller cylindrical projection cropped to 82N..~61S so the map is exactly 2:1 and
// Antarctica (a giant useless ice strip in cylindrical projections) is left out.
//
// Output: client/public/maps/world-<W>.bin.gz  (format documented in shared/mapdata.ts)
// Usage:  node tools/mapgen/mapgen.ts [width ...]      default widths: 512 1024 2048

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { T } from '../../shared/balance.ts';
import { OIL_REGIONS, URANIUM_REGIONS, EXTRA_DESERTS } from './regions.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CACHE = path.join(ROOT, 'tools/mapgen/cache');
const OUT = path.join(ROOT, 'client/public/maps');
const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

const LAT_TOP = 82;

// ---- projection -------------------------------------------------------------------------
const D2R = Math.PI / 180;
const millerY = (latDeg: number) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * latDeg * D2R));
const millerLat = (y: number) => (2.5 * Math.atan(Math.exp(0.8 * y)) - 0.625 * Math.PI) / D2R;
const Y_TOP = millerY(LAT_TOP);
const Y_RANGE = Math.PI; // x range is 2*pi, so a pi-tall window gives a 2:1 map
const Y_BOTTOM = Y_TOP - Y_RANGE;
export const LAT_BOTTOM = millerLat(Y_BOTTOM);

// ---- noise ------------------------------------------------------------------------------
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi;
  xf = xf * xf * (3 - 2 * xf);
  yf = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function fbm(x: number, y: number, seed: number, oct = 4): number {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * valueNoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

const FOREST_BANDS: [number, number][] = [
  [0, 0.78], [7, 0.76], [13, 0.45], [19, 0.28], [26, 0.13], [33, 0.22], [40, 0.38], [47, 0.46],
  [54, 0.6], [61, 0.66], [66, 0.5], [70, 0.14], [90, 0],
];
function interp(pts: [number, number][], v: number): number {
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [a, pa] = pts[i - 1], [b, pb] = pts[i];
      return pa + ((v - a) / (b - a)) * (pb - pa);
    }
  }
  return pts[pts.length - 1][1];
}

// ---- data -------------------------------------------------------------------------------
async function loadGeo(name: string): Promise<any> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, name + '.geojson');
  if (!fs.existsSync(file)) {
    console.log(`downloading ${name} ...`);
    const res = await fetch(`${NE_BASE}/${name}.geojson`);
    if (!res.ok) throw new Error(`download failed: ${name} ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

type Ring = number[][];
type Poly = Ring[];
function polysOf(geom: any): Poly[] {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

// Scanline fill of one polygon (outer ring + holes, even-odd) into `out`, sampling pixel centers.
// Returns the number of pixels written.
function fillPoly(poly: Poly, W: number, H: number, cb: (i: number) => void): number {
  const ex: number[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon0, lat0] = ring[i], [lon1, lat1] = ring[i + 1];
      const x0 = ((lon0 + 180) / 360) * W, x1 = ((lon1 + 180) / 360) * W;
      const y0 = ((Y_TOP - millerY(Math.max(-85, Math.min(85, lat0)))) / Y_RANGE) * H;
      const y1 = ((Y_TOP - millerY(Math.max(-85, Math.min(85, lat1)))) / Y_RANGE) * H;
      if (y0 === y1) continue;
      ex.push(x0, y0, x1, y1);
      if (y0 < minY) minY = y0; if (y1 < minY) minY = y1;
      if (y0 > maxY) maxY = y0; if (y1 > maxY) maxY = y1;
    }
  }
  let count = 0;
  const ys = Math.max(0, Math.floor(minY - 1)), ye = Math.min(H - 1, Math.ceil(maxY + 1));
  const xs: number[] = [];
  for (let y = ys; y <= ye; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let e = 0; e < ex.length; e += 4) {
      const y0 = ex[e + 1], y1 = ex[e + 3];
      if ((y0 <= sy && sy < y1) || (y1 <= sy && sy < y0)) {
        xs.push(ex[e] + ((sy - y0) * (ex[e + 2] - ex[e])) / (y1 - y0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) { cb(y * W + x); count++; }
    }
  }
  return count;
}

function polyCentroidPx(poly: Poly, W: number, H: number): [number, number] {
  const ring = poly[0];
  let sx = 0, sy = 0;
  for (const [lon, lat] of ring) {
    sx += ((lon + 180) / 360) * W;
    sy += ((Y_TOP - millerY(Math.max(-85, Math.min(85, lat)))) / Y_RANGE) * H;
  }
  return [sx / ring.length, sy / ring.length];
}
function polyAreaDeg(poly: Poly): number {
  const r = poly[0];
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return Math.abs(a / 2);
}

// ---- main -------------------------------------------------------------------------------
async function build(W: number, countries: any, lakes: any, regions: any) {
  const H = W / 2, N = W * H;
  const t0 = Date.now();
  const country = new Uint8Array(N); // 0 = none/water, else index+1
  const land = new Uint8Array(N);
  const region = new Uint8Array(N); // 1 mountain, 2 desert, 3 tundra
  const meta: { n: string; a: string; c: string }[] = [];

  // countries: big ones (low LABELRANK) first so small countries/enclaves paint over them at shared edges
  const feats = countries.features.slice().sort((a: any, b: any) => (a.properties.LABELRANK ?? 0) - (b.properties.LABELRANK ?? 0));
  for (const f of feats) {
    const p = f.properties;
    const a3 = p.ADM0_A3 as string;
    if (a3 === 'ATA') continue; // Antarctica is outside the projection window anyway
    const id = meta.length + 1;
    meta.push({ n: (p.NAME_EN || p.NAME) as string, a: a3, c: p.CONTINENT as string });
    for (const poly of polysOf(f.geometry)) {
      const filled = fillPoly(poly, W, H, (i) => { country[i] = id; land[i] = 1; });
      if (filled === 0 && polyAreaDeg(poly) > 0.02) {
        // keep small islands/countries visible as at least a single tile
        const [cx, cy] = polyCentroidPx(poly, W, H);
        const x = Math.max(0, Math.min(W - 1, Math.floor(cx))), y = Math.max(0, Math.min(H - 1, Math.floor(cy)));
        const i = y * W + x;
        if (!land[i]) { country[i] = id; land[i] = 1; }
      }
    }
  }
  // lakes (only the big ones)
  for (const f of lakes.features) {
    if ((f.properties.scalerank ?? 9) > 3) continue;
    for (const poly of polysOf(f.geometry)) fillPoly(poly, W, H, (i) => { land[i] = 0; country[i] = 0; });
  }
  // geography regions
  for (const f of regions.features) {
    const cla = f.properties.FEATURECLA as string;
    const name = (f.properties.NAME as string) || '';
    let v = 0;
    if (cla === 'Range/mtn') v = 1;
    else if (cla === 'Desert' && name !== 'PUNJAB' && name !== 'CAATINGAS') v = 2;
    else if (cla === 'Plateau' && /TIBET|PAMIR|ALTIPLANO/i.test(name)) v = 1;
    else if (cla === 'Tundra') v = 3;
    if (!v) continue;
    for (const poly of polysOf(f.geometry)) fillPoly(poly, W, H, (i) => { if (land[i]) region[i] = v; });
  }

  const greenland = meta.findIndex((m) => m.a === 'GRL') + 1;
  const terrain = new Uint8Array(N);
  const scale = 1; // noise is sampled in lon/lat space so all map sizes look alike
  for (let y = 0; y < H; y++) {
    const lat = millerLat(Y_TOP - ((y + 0.5) / H) * Y_RANGE);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!land[i]) { terrain[i] = T.OCEAN; continue; }
      const lon = ((x + 0.5) / W) * 360 - 180;
      const n1 = fbm(lon / 7 * scale, lat / 7 * scale, 11);
      const n2 = fbm(lon / 3.2, lat / 3.2, 23, 3);
      let t: number = T.PLAINS;
      const alat = Math.abs(lat);
      // forest by climate band (smoothly interpolated so there are no visible latitude seams)
      const forestP = interp(FOREST_BANDS, alat) * (lat < 0 && alat > 25 ? 0.85 : 1);
      if (n1 < forestP) t = T.FOREST;
      // deserts
      let desert = region[i] === 2;
      if (!desert) {
        const nd = fbm(lon / 4.5, lat / 4.5, 31, 4);
        for (const d of EXTRA_DESERTS) {
          if (lon < d[0] || lon > d[1] || lat < d[2] || lat > d[3]) continue;
          const edge = Math.min(lon - d[0], d[1] - lon, lat - d[2], d[3] - lat);
          const fade = Math.min(1, edge / 3.5);
          if (nd < d[4] * fade * 0.85 + 0.08 * fade) { desert = true; break; }
        }
      }
      if (desert) t = n2 < 0.93 ? T.DESERT : T.PLAINS;
      // mountains
      if (region[i] === 1) t = n2 > 0.3 ? T.MOUNTAIN : (desert ? T.DESERT : T.FOREST);
      if (region[i] === 3) t = n1 < 0.35 ? T.FOREST : T.PLAINS;
      // polar
      if (country[i] === greenland || lat > 73) t = T.ICE;
      else if (lat > 68 && n2 < 0.35) t = T.ICE;
      terrain[i] = t;
    }
  }
  // coast and shallows
  const wx = (x: number) => (x + W) % W;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (land[i]) {
        const t = terrain[i];
        let nearWater = false;
        const nb = [y * W + wx(x - 1), y * W + wx(x + 1), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
        for (const j of nb) if (j >= 0 && !land[j]) nearWater = true;
        if (nearWater) {
          const lat = millerLat(Y_TOP - ((y + 0.5) / H) * Y_RANGE);
          if (t === T.PLAINS || t === T.FOREST) terrain[i] = T.COAST;
          else if (t === T.ICE && country[i] === greenland && lat < 76) terrain[i] = T.COAST;
        }
      } else {
        let near = false;
        const r = Math.max(1, Math.round(W / 512));
        for (let dy = -r; dy <= r && !near; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -r; dx <= r; dx++) if (land[yy * W + wx(x + dx)]) { near = true; break; }
        }
        terrain[i] = near ? T.SHALLOW : T.OCEAN;
      }
    }
  }
  // resources: 1 oil, 2 uranium
  const resource = new Uint8Array(N);
  let oil = 0, ura = 0;
  for (let y = 0; y < H; y++) {
    const lat = millerLat(Y_TOP - ((y + 0.5) / H) * Y_RANGE);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!land[i] || terrain[i] === T.ICE) continue;
      const lon = ((x + 0.5) / W) * 360 - 180;
      const h = hash2(x, y, 101 + W);
      const cellNoise = fbm(lon / 1.3, lat / 1.3, 77, 2);
      let r = 0;
      for (const [cx, cy, rx, ry] of OIL_REGIONS) {
        const d = ((lon - cx) / rx) ** 2 + ((lat - cy) / ry) ** 2;
        if (d < 1 && cellNoise > 0.42 && h < 0.16 + 0.22 * (1 - d)) { r = 1; break; }
      }
      if (!r) for (const [cx, cy, rx, ry] of URANIUM_REGIONS) {
        const d = ((lon - cx) / rx) ** 2 + ((lat - cy) / ry) ** 2;
        if (d < 1 && cellNoise > 0.4 && h < 0.14 + 0.2 * (1 - d)) { r = 2; break; }
      }
      // sparse global scatter so that every region has a small chance of strategic resources
      if (!r) {
        const g = hash2(x >> 1, y >> 1, 555 + W);
        if (g < 0.0035) r = 1; else if (g > 0.9987) r = 2;
      }
      resource[i] = r;
      if (r === 1) oil++; else if (r === 2) ura++;
    }
  }

  // write
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const head = Buffer.alloc(12);
  head.write('PXW1', 0, 'ascii');
  head.writeUInt16LE(W, 4);
  head.writeUInt16LE(H, 6);
  head.writeUInt32LE(json.length, 8);
  const raw = Buffer.concat([head, json, Buffer.from(terrain), Buffer.from(country), Buffer.from(resource)]);
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `world-${W}.bin.gz`), gz);
  let landCount = 0;
  for (let i = 0; i < N; i++) landCount += land[i];
  console.log(`world-${W}: ${W}x${H}, land ${landCount} (${((landCount / N) * 100).toFixed(1)}%), oil ${oil}, uranium ${ura}, ${(gz.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
  if (process.env.PREVIEW) writePreview(W, H, terrain, country, resource, path.join(CACHE, `preview-${W}.png`));
}

// ---- tiny PNG writer for visual checks (PREVIEW=1) -------------------------------------
function writePreview(W: number, H: number, terrain: Uint8Array, country: Uint8Array, res: Uint8Array, file: string) {
  const pal: Record<number, number[]> = {
    [T.OCEAN]: [22, 48, 82], [T.SHALLOW]: [34, 74, 112], [T.PLAINS]: [104, 150, 72], [T.FOREST]: [52, 104, 58],
    [T.MOUNTAIN]: [132, 120, 104], [T.DESERT]: [214, 190, 120], [T.ICE]: [230, 238, 242], [T.COAST]: [200, 184, 120],
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c = pal[terrain[i]];
      const r = x + 1 < W ? country[i + 1] : country[i], d = y + 1 < H ? country[i + W] : country[i];
      if (country[i] && ((r && r !== country[i]) || (d && d !== country[i]))) c = [30, 30, 30];
      if (res[i] === 1) c = [0, 0, 0];
      if (res[i] === 2) c = [120, 255, 60];
      row[1 + x * 3] = c[0]; row[2 + x * 3] = c[1]; row[3 + x * 3] = c[2];
    }
    rows.push(row);
  }
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
  console.log('preview ->', file);
}

const widths = process.argv.slice(2).map(Number).filter(Boolean);
const [countries, lakes, regions] = await Promise.all([
  loadGeo('ne_50m_admin_0_countries'), loadGeo('ne_50m_lakes'), loadGeo('ne_50m_geography_regions_polys'),
]);
console.log(`projection: Miller, lat ${LAT_TOP}N .. ${(-LAT_BOTTOM).toFixed(1)}S`);
for (const w of widths.length ? widths : [512, 1024, 2048]) await build(w, countries, lakes, regions);
