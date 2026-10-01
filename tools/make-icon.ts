// Draws the app icon (desktop/assets/icon.png, 1024x1024): a pixel-art globe split into nation colours on a
// rounded dark tile. electron-builder turns it into the Windows .ico and the macOS .icns.
//   node tools/make-icon.ts

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './common.ts';

const G = 32;            // design grid
const CELL = 1024 / G;   // pixels per grid cell
type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const shade = (c: RGB, k: number): RGB => c.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))) as RGB;

const grid: (RGB | null)[] = new Array(G * G).fill(null);
const put = (x: number, y: number, c: RGB) => { if (x >= 0 && y >= 0 && x < G && y < G) grid[y * G + x] = c; };

// rounded tile (macOS-style margins, stair-stepped corners)
const M = 2, R = 7.5;
const inTile = (x: number, y: number) => {
  const cx = x + 0.5, cy = y + 0.5, lo = M, hi = G - M;
  if (cx < lo || cy < lo || cx > hi || cy > hi) return false;
  const kx = Math.max(lo + R - cx, cx - (hi - R), 0), ky = Math.max(lo + R - cy, cy - (hi - R), 0);
  return kx * kx + ky * ky <= R * R;
};
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
  if (!inTile(x, y)) continue;
  const edge = !inTile(x - 1, y) || !inTile(x + 1, y) || !inTile(x, y - 1) || !inTile(x, y + 1);
  put(x, y, edge ? hex('#2b3a66') : y < G / 2 ? hex('#141d38') : hex('#0f1630'));
}

// globe: continents (unions of blobs) carved into nations (nearest capital wins)
const C = 16, RAD = 10.6;
const continents = [[11, 11, 4.6], [21, 10.5, 3.6], [19.5, 19.5, 4.2], [10, 20.5, 2.6], [25, 16, 1.6]];
const nations: { x: number; y: number; c: RGB }[] = [
  { x: 10, y: 9, c: hex('#e63946') },
  { x: 9, y: 14, c: hex('#f77f00') },
  { x: 14, y: 12, c: hex('#ffd23f') },
  { x: 21, y: 9, c: hex('#3a86ff') },
  { x: 18, y: 18, c: hex('#9b5de5') },
  { x: 22, y: 22, c: hex('#ff4d8d') },
  { x: 10, y: 21, c: hex('#2ecc71') },
  { x: 25, y: 16, c: hex('#ffd23f') },
];
const jitter = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 100 / 100;
const ocean = hex('#1d4e89');
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
  const px = x + 0.5, py = y + 0.5;
  const dx = px - C, dy = py - C, d = Math.hypot(dx, dy);
  if (d > RAD + 1) continue;
  if (d > RAD) { put(x, y, hex('#05070c')); continue; }
  // light from the top-left: three flat bands, like hand-shaded pixel art
  const nz = Math.sqrt(Math.max(0, 1 - (d / RAD) ** 2));
  const light = (-dx * 0.55 - dy * 0.65) / RAD + nz * 0.5;
  const k = light > 0.55 ? 1.18 : light > -0.05 ? 1 : 0.7;
  const land = continents.some(([cx, cy, r]) => Math.hypot(px - cx, py - cy) < r + (jitter(x, y) - 0.5) * 1.2);
  let c = ocean;
  if (land) {
    let bd = Infinity;
    for (const n of nations) { const nd = Math.hypot(px - n.x, py - n.y); if (nd < bd) { bd = nd; c = n.c; } }
  }
  put(x, y, shade(c, k));
}
// specular glint, and a missile strike marker on the blue nation
put(9, 8, hex('#ffffff')); put(10, 8, hex('#d8ecff')); put(9, 9, hex('#d8ecff'));
const Y = hex('#ffd23f');
for (const [x, y] of [[20, 11], [22, 11], [21, 10], [21, 12]]) put(x, y, Y);
put(21, 11, hex('#ff4d5e'));

// rasterise + PNG encode
const W = 1024, rgba = Buffer.alloc(W * W * 4);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const c = grid[Math.floor(y / CELL) * G + Math.floor(x / CELL)];
  if (!c) continue;
  const o = (y * W + x) * 4;
  rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(ROOT, 'desktop/assets/icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${path.relative(ROOT, out)} (${(png.length / 1024).toFixed(1)} KB)`);
