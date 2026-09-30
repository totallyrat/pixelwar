// Canvas renderer. The map is a W x H pixel image split into 128x128 chunk canvases; only chunks
// with changed tiles are re-uploaded. Everything else (buildings, ships, flights, effects, labels)
// is drawn as an overlay each frame, and frames are only drawn when something changed/animates.

import { TERRAIN, T, RES, LIMITS, NUKE, MISSILE, AIR, B, SPAWN, TICK_MS, TICK_RATE, buildTime } from '../../../shared/balance.ts';
import type { World } from '../world.ts';
import { badge, shipSprite, star, cssColor, glyphCanvas } from './sprites.ts';
import { fmt, clamp } from '../util.ts';

const CS = 128;
const MAXP = LIMITS.maxPlayers;
const OCEAN_CSS = '#173a61';

const abgr = (c: number) => (0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)) >>> 0;
function mix(a: number, b: number, f: number): number {
  const ar = a & 255, ag = (a >>> 8) & 255, ab = (a >>> 16) & 255;
  const br = b & 255, bg = (b >>> 8) & 255, bb = (b >>> 16) & 255;
  return (0xff000000 | (((ab + (bb - ab) * f) | 0) << 16) | (((ag + (bg - ag) * f) | 0) << 8) | ((ar + (br - ar) * f) | 0)) >>> 0;
}
const BLACK = 0xff000000;
const WHITE = 0xffffffff;
const FALLOUT = abgr(0x7dff3a);

interface Chunk { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData; u32: Uint32Array; x0: number; y0: number; w: number; h: number; dirty: boolean }
export interface Fx { kind: 'boom' | 'nuke' | 'intercept' | 'ping' | 'sink' | 'land'; tile: number; r: number; t0: number; dur: number; color?: string; text?: string; big?: boolean }

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly world: World;
  dpr = 1;
  cw = 0;
  ch = 0;
  cam = { x: 512, y: 256, z: 2 };
  W = 0; H = 0; N = 0;
  private chunks: Chunk[] = [];
  private CX = 0;
  private terr = new Uint32Array(0);
  private land = new Uint8Array(0);
  private pFill = new Uint32Array(MAXP);
  private pBorder = new Uint32Array(MAXP);
  private ready = false;
  needs = true;
  fx: Fx[] = [];
  sel = -1;
  hover = -1;
  mode = '';
  modeArg = 0;
  target = -1;
  spawnPreview = -1;
  showLabels = true;
  private labelCache = new Map<string, HTMLCanvasElement>();
  minimap: HTMLCanvasElement | null = null;
  private mmBase: HTMLCanvasElement | null = null;
  private mmAt = 0;
  private mapChanged = true;
  private flash = 0;
  private shake = 0;
  private lastFrame = 0;
  onFrame: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.world = world;
    this.resize();
    addEventListener('resize', () => this.resize());
    document.fonts?.load('16px "Press Start 2P"').then(() => { this.labelCache.clear(); this.needs = true; }).catch(() => {});
    const loop = (t: number) => { this.frame(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = window.innerWidth;
    this.ch = window.innerHeight;
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
    this.canvas.style.width = this.cw + 'px';
    this.canvas.style.height = this.ch + 'px';
    this.clampCam();
    this.needs = true;
  }

  // ---- setup -----------------------------------------------------------------------------------
  setup() {
    const w = this.world, m = w.map;
    const fresh = this.W !== m.W;
    this.W = m.W; this.H = m.H; this.N = m.N;
    if (fresh || !this.chunks.length) {
      this.buildTerrain();
      this.chunks = [];
      this.CX = Math.ceil(m.W / CS);
      const CY = Math.ceil(m.H / CS);
      for (let cy = 0; cy < CY; cy++) for (let cx = 0; cx < this.CX; cx++) {
        const cw = Math.min(CS, m.W - cx * CS), ch = Math.min(CS, m.H - cy * CS);
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d')!;
        const img = ctx.createImageData(cw, ch);
        this.chunks.push({ canvas, ctx, img, u32: new Uint32Array(img.data.buffer), x0: cx * CS, y0: cy * CS, w: cw, h: ch, dirty: true });
      }
      const me = w.P(w.myId);
      const cap = me && me.capital >= 0 ? me.capital : -1;
      this.cam.z = Math.max(this.minZoom(), 3);
      if (cap >= 0) { this.cam.x = (cap % m.W) + 0.5; this.cam.y = ((cap / m.W) | 0) + 0.5; }
      else { this.cam.x = m.W / 2; this.cam.y = m.H * 0.42; this.cam.z = this.minZoom(); }
    }
    this.ready = true;
    this.refreshPlayers();
    this.recolorAll();
    this.clampCam();
  }

  private buildTerrain() {
    const m = this.world.map, N = m.N, W = m.W;
    this.terr = new Uint32Array(N);
    this.land = new Uint8Array(N);
    for (let t = 0; t < N; t++) {
      const ter = m.terrain[t];
      this.land[t] = ter > T.SHALLOW ? 1 : 0;
      let c = abgr(TERRAIN[ter].color);
      const x = t % W, y = (t / W) | 0;
      const h = ((x * 374761393) ^ (y * 668265263)) >>> 0;
      const n = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
      const v = ((n >>> 24) & 255) / 255;
      c = mix(c, v > 0.5 ? WHITE : BLACK, Math.abs(v - 0.5) * (ter <= T.SHALLOW ? 0.06 : 0.14));
      if (ter > T.SHALLOW) {
        const res = m.resource[t];
        if (res === RES.OIL) c = mix(c, 0xff141414, 0.8);
        else if (res === RES.URANIUM) c = abgr(0x9dff3c);
        // faint real-world country borders
        const r = x === W - 1 ? t - W + 1 : t + 1, d = t + W;
        if ((this.landAt(r) && m.country[r] !== m.country[t]) || (d < N && this.landAt(d) && m.country[d] !== m.country[t])) c = mix(c, BLACK, 0.22);
      }
      this.terr[t] = c;
    }
  }
  private landAt(t: number) { return this.world.map.terrain[t] > T.SHALLOW; }

  refreshPlayers() {
    const w = this.world;
    for (const p of w.players) {
      if (!p) continue;
      const c = abgr(p.color);
      this.pFill[p.id] = c;
      this.pBorder[p.id] = p.id === w.myId ? mix(c, WHITE, 0.45) : mix(c, BLACK, 0.3);
    }
  }

  // ---- tile colouring --------------------------------------------------------------------------------
  private colorAt(t: number): number {
    const w = this.world, own = w.owner, o = own[t], W = this.W, N = this.N, land = this.land;
    let c = this.terr[t];
    if (o) {
      const x = t % W;
      const l = x === 0 ? t + W - 1 : t - 1, r = x === W - 1 ? t - W + 1 : t + 1, u = t - W, d = t + W;
      if ((own[l] !== o && land[l]) || (own[r] !== o && land[r]) || (u >= 0 && own[u] !== o && land[u]) || (d < N && own[d] !== o && land[d])) c = this.pBorder[o];
      else c = mix(c, this.pFill[o], 0.58);
    }
    if (w.fallout[t]) c = mix(c, FALLOUT, 0.42);
    const vis = w.vis;
    if (vis && !vis[w.block(t)]) c = mix(c, 0xff0a0608, 0.42);
    return c;
  }
  private paint(t: number) {
    const W = this.W, x = t % W, y = (t / W) | 0;
    const ch = this.chunks[((y / CS) | 0) * this.CX + ((x / CS) | 0)];
    ch.u32[(y - ch.y0) * ch.w + (x - ch.x0)] = this.colorAt(t);
    ch.dirty = true;
  }
  recolorAll() {
    if (!this.ready) return;
    for (let t = 0; t < this.N; t++) this.paint(t);
    this.mapChanged = this.needs = true;
  }
  updateTiles(list: number[]) {
    if (!this.ready) return;
    const W = this.W, N = this.N;
    for (const t of list) {
      this.paint(t);
      const x = t % W;
      this.paint(x === 0 ? t + W - 1 : t - 1);
      this.paint(x === W - 1 ? t - W + 1 : t + 1);
      if (t >= W) this.paint(t - W);
      if (t < N - W) this.paint(t + W);
    }
    this.mapChanged = this.needs = true;
  }
  updateBlocks(blocks: number[]) {
    if (!this.ready) return;
    const w = this.world, B = w.B, W = this.W, H = this.H;
    for (const bk of blocks) {
      const bx = (bk % w.BW) * B, by = ((bk / w.BW) | 0) * B;
      for (let y = by; y < Math.min(H, by + B); y++) for (let x = bx; x < Math.min(W, bx + B); x++) this.paint(y * W + x);
    }
    this.mapChanged = this.needs = true;
  }

  // ---- camera ---------------------------------------------------------------------------------------
  minZoom() { return this.H ? Math.max(this.ch / this.H, this.cw / this.W / 1.6) : 1; }
  clampCam() {
    if (!this.W) return;
    const c = this.cam;
    c.z = clamp(c.z, this.minZoom(), 48);
    c.x = ((c.x % this.W) + this.W) % this.W;
    const half = this.ch / 2 / c.z;
    c.y = this.H <= half * 2 ? this.H / 2 : clamp(c.y, half, this.H - half);
  }
  pan(dx: number, dy: number) { this.cam.x -= dx / this.cam.z; this.cam.y -= dy / this.cam.z; this.clampCam(); this.needs = true; }
  zoomAt(sx: number, sy: number, f: number) {
    const c = this.cam;
    const wx = c.x + (sx - this.cw / 2) / c.z, wy = c.y + (sy - this.ch / 2) / c.z;
    c.z = clamp(c.z * f, this.minZoom(), 48);
    c.x = wx - (sx - this.cw / 2) / c.z;
    c.y = wy - (sy - this.ch / 2) / c.z;
    this.clampCam();
    this.needs = true;
  }
  centerOn(t: number, z?: number) {
    this.cam.x = (t % this.W) + 0.5;
    this.cam.y = ((t / this.W) | 0) + 0.5;
    if (z) this.cam.z = z;
    this.clampCam();
    this.needs = true;
  }
  tileAt(sx: number, sy: number): number {
    if (!this.W) return -1;
    const c = this.cam;
    const wx = Math.floor(c.x + (sx - this.cw / 2) / c.z), wy = Math.floor(c.y + (sy - this.ch / 2) / c.z);
    if (wy < 0 || wy >= this.H) return -1;
    return wy * this.W + (((wx % this.W) + this.W) % this.W);
  }
  /** screen position (css px) of a world point, choosing the wrap copy nearest the view centre */
  sx(wx: number): number {
    let d = wx - this.cam.x;
    const W = this.W;
    if (d > W / 2) d -= W; else if (d < -W / 2) d += W;
    return this.cw / 2 + d * this.cam.z;
  }
  sy(wy: number): number { return this.ch / 2 + (wy - this.cam.y) * this.cam.z; }
  tx(t: number) { return this.sx((t % this.W) + 0.5); }
  ty(t: number) { return this.sy(((t / this.W) | 0) + 0.5); }

  // ---- effects ------------------------------------------------------------------------------------------
  addFx(f: Omit<Fx, 't0'>) {
    this.fx.push({ ...f, t0: performance.now() });
    if (f.kind === 'nuke') { this.flash = 1; this.shake = 1; }
    this.needs = true;
  }

  // ---- frame ----------------------------------------------------------------------------------------------
  private animating(): boolean {
    const w = this.world;
    return this.fx.length > 0 || w.flights.size > 0 || w.nukes.size > 0 || this.flash > 0 || this.shake > 0 ||
      (w.ships.size > 0 && performance.now() - w.tickAt < TICK_MS * 1.2) || !!this.mode || w.phase === 'spawn';
  }

  private frame(now: number) {
    if (!this.ready) return;
    if (!this.needs && !this.animating()) return;
    // cap to ~40fps when only ambient animation is running (saves tablet battery)
    if (!this.needs && now - this.lastFrame < 24) return;
    this.lastFrame = now;
    this.needs = false;
    const ctx = this.ctx, dpr = this.dpr;
    for (const c of this.chunks) if (c.dirty) { c.ctx.putImageData(c.img, 0, 0); c.dirty = false; }

    // map layer in device pixels (integer-aligned chunks => no seams)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let shx = 0, shy = 0;
    if (this.shake > 0) { shx = (Math.random() - 0.5) * 14 * this.shake * dpr; shy = (Math.random() - 0.5) * 14 * this.shake * dpr; this.shake = Math.max(0, this.shake - 0.02); }
    ctx.fillStyle = OCEAN_CSS;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    const z = this.cam.z * dpr;
    const left = this.cam.x - this.cw / 2 / this.cam.z, top = this.cam.y - this.ch / 2 / this.cam.z;
    const cwD = this.canvas.width, chD = this.canvas.height;
    for (let k = -1; k <= 1; k++) {
      const off = k * this.W;
      for (const c of this.chunks) {
        const x0 = c.x0 + off - left, y0 = c.y0 - top;
        const sx0 = Math.round(x0 * z + shx), sx1 = Math.round((x0 + c.w) * z + shx);
        if (sx1 < 0 || sx0 > cwD) continue;
        const sy0 = Math.round(y0 * z + shy), sy1 = Math.round((y0 + c.h) * z + shy);
        if (sy1 < 0 || sy0 > chD) continue;
        ctx.drawImage(c.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0);
      }
    }
    // overlays in css pixels
    ctx.setTransform(dpr, 0, 0, dpr, shx, shy);
    this.drawModeUnder();
    this.drawBuildings();
    this.drawShips();
    this.drawFlights();
    this.drawFx(now);
    if (this.showLabels) this.drawLabels();
    this.drawSelection();
    if (this.flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255,255,240,${this.flash * 0.85})`;
      ctx.fillRect(0, 0, cwD, chD);
      this.flash = Math.max(0, this.flash - 0.035);
    }
    this.drawMinimap(now);
    this.onFrame();
  }

  private drawBuildings() {
    const w = this.world, ctx = this.ctx, z = this.cam.z;
    const nowT = w.now();
    if (z < 3.2) {
      // zoomed out: only capitals
      for (const p of w.players) {
        if (!p || !p.alive || p.capital < 0) continue;
        const x = this.tx(p.capital), y = this.ty(p.capital);
        if (x < -10 || y < -10 || x > this.cw + 10 || y > this.ch + 10) continue;
        if (z < 1.2 && !p.human) continue;
        ctx.drawImage(star(p.human ? '#ffd23f' : '#e8e8e8'), Math.round(x - 4.5), Math.round(y - 4.5));
      }
      return;
    }
    const s = clamp(Math.round(Math.min(z * 2.1, 36) / 11), 1, 3);
    const size = 11 * s, half = size / 2;
    for (const b of w.bld.values()) {
      const x = this.tx(b.tile), y = this.ty(b.tile);
      if (x < -size || y < -size || x > this.cw + size || y > this.ch + size) continue;
      const p = w.players[b.owner];
      const col = p ? p.color : 0x888888;
      const building = b.done > 0;
      ctx.globalAlpha = b.level === 0 ? 0.55 : 1;
      ctx.drawImage(badge(b.type, col), Math.round(x - half), Math.round(y - half), size, size);
      ctx.globalAlpha = 1;
      if (building) {
        const total = (buildTime(b.type, b.level) * TICK_RATE) / (w.settings?.speed || 1);
        const prog = clamp(1 - (b.done - nowT) / total, 0, 1);
        ctx.fillStyle = '#05070c';
        ctx.fillRect(Math.round(x - half), Math.round(y + half + 1), size, 3);
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(Math.round(x - half), Math.round(y + half + 1), Math.round(size * prog), 3);
      } else if (b.level > 1) {
        for (let i = 0; i < b.level; i++) {
          ctx.fillStyle = '#05070c';
          ctx.fillRect(Math.round(x - half + i * 4 * s / 1.5), Math.round(y + half), 3, 3);
          ctx.fillStyle = '#ffd23f';
          ctx.fillRect(Math.round(x - half + i * 4 * s / 1.5) + 0.5, Math.round(y + half) + 0.5, 2, 2);
        }
      }
      if (p && p.capital === b.tile) ctx.drawImage(star('#ffd23f'), Math.round(x - 4.5), Math.round(y - half - 9));
    }
  }

  private drawShips() {
    const w = this.world, ctx = this.ctx, z = this.cam.z, W = this.W;
    if (!w.ships.size) return;
    const now = performance.now();
    const s = clamp(Math.round(z / 3), 1, 4);
    for (const sh of w.ships.values()) {
      const f = clamp((now - sh.at) / TICK_MS, 0, 1);
      const ax = (sh.prev % W) + 0.5, ay = ((sh.prev / W) | 0) + 0.5;
      let bx = (sh.tile % W) + 0.5;
      const by = ((sh.tile / W) | 0) + 0.5;
      if (bx - ax > W / 2) bx -= W; else if (ax - bx > W / 2) bx += W;
      const x = this.sx(ax + (bx - ax) * f), y = this.sy(ay + (by - ay) * f);
      if (x < -30 || y < -30 || x > this.cw + 30 || y > this.ch + 30) continue;
      const col = w.players[sh.owner]?.color ?? 0x888888;
      if (z < 1.6) {
        ctx.fillStyle = '#05070c';
        ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4);
        ctx.fillStyle = cssColor(col);
        ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
        continue;
      }
      const spr = shipSprite(sh.type, col);
      const flip = bx < ax;
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(spr, Math.round(-spr.width * s / 2), Math.round(-spr.height * s / 2), spr.width * s, spr.height * s);
      ctx.restore();
      if (sh.hp < 0.99) {
        const bw = 10 * s;
        ctx.fillStyle = '#05070c';
        ctx.fillRect(Math.round(x - bw / 2), Math.round(y - 5 * s), bw, 2);
        ctx.fillStyle = sh.hp > 0.5 ? '#6cff6c' : sh.hp > 0.25 ? '#ffd23f' : '#ff4040';
        ctx.fillRect(Math.round(x - bw / 2), Math.round(y - 5 * s), Math.round(bw * sh.hp), 2);
      }
    }
  }

  private flightPos(f: { from: number; to: number; t0: number; t1: number; kind: number }, t: number) {
    const W = this.W;
    const ax = (f.from % W) + 0.5, ay = ((f.from / W) | 0) + 0.5;
    let bx = (f.to % W) + 0.5;
    const by = ((f.to / W) | 0) + 0.5;
    if (bx - ax > W / 2) bx -= W; else if (ax - bx > W / 2) bx += W;
    const p = clamp((t - f.t0) / Math.max(1, f.t1 - f.t0), 0, 1);
    const dist = Math.hypot(bx - ax, by - ay);
    const arc = f.kind === 2 || f.kind === 3 ? 0 : dist * (f.kind === 1 ? 0.28 : 0.18);
    return { x: ax + (bx - ax) * p, y: ay + (by - ay) * p - Math.sin(Math.PI * p) * arc, p, ax, ay, bx, by, arc };
  }

  private drawFlights() {
    const w = this.world, ctx = this.ctx, z = this.cam.z;
    if (!w.flights.size) return;
    const t = w.now();
    const blink = Math.floor(performance.now() / 150) % 2 === 0;
    for (const f of w.flights.values()) {
      if (f.kind === 4) {
        const n = w.flights.get(f.ref);
        const target = n ? this.flightPos(n, f.t1) : null;
        const ax = (f.from % this.W) + 0.5, ay = ((f.from / this.W) | 0) + 0.5;
        const bx = target ? target.x : (f.to % this.W) + 0.5, by = target ? target.y : ((f.to / this.W) | 0) + 0.5;
        const p = clamp((t - f.t0) / Math.max(1, f.t1 - f.t0), 0, 1);
        let dx = bx - ax; if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
        const x = this.sx(ax + dx * p), y = this.sy(ay + (by - ay) * p);
        ctx.strokeStyle = 'rgba(120,230,255,.8)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(this.sx(ax), this.sy(ay)); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = '#bff4ff'; ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4);
        continue;
      }
      const pos = this.flightPos(f, t);
      // trail
      const steps = 14, p0 = Math.max(0, pos.p - (f.kind === 1 ? 0.5 : 0.3));
      ctx.lineWidth = f.kind === 1 ? 3 : 2;
      let px = 0, py = 0;
      for (let i = 0; i <= steps; i++) {
        const q = p0 + ((pos.p - p0) * i) / steps;
        const wx = pos.ax + (pos.bx - pos.ax) * q, wy = pos.ay + (pos.by - pos.ay) * q - Math.sin(Math.PI * q) * pos.arc;
        const x = this.sx(wx), y = this.sy(wy);
        if (i > 0) {
          const a = i / steps;
          ctx.strokeStyle = f.kind === 1 ? `rgba(255,${80 + 120 * a},60,${a})` : f.kind >= 2 ? `rgba(220,220,220,${a * 0.5})` : `rgba(255,240,200,${a * 0.8})`;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
        }
        px = x; py = y;
      }
      const x = this.sx(pos.x), y = this.sy(pos.y);
      if (f.kind === 1) {
        ctx.fillStyle = blink ? '#ff2a2a' : '#ffd23f';
        ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8);
        // target zone with countdown
        const tx = this.tx(f.to), ty = this.ty(f.to);
        const R = NUKE.radius * w.map.ms * z;
        ctx.strokeStyle = blink ? 'rgba(255,40,40,.95)' : 'rgba(255,200,40,.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.arc(tx, ty, Math.max(10, R), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        const secs = Math.max(0, ((f.t1 - t) * TICK_MS) / 1000);
        this.text(secs.toFixed(1) + 's', tx, ty - Math.max(10, R) - 8, 10, '#ff4040');
      } else if (f.kind === 0) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4);
      } else {
        const g = glyphCanvas('bomber', '#e0e0e0', 1);
        ctx.drawImage(g, Math.round(x) - 7, Math.round(y) - 7, 14, 14);
      }
    }
  }

  private drawFx(now: number) {
    const ctx = this.ctx, z = this.cam.z;
    this.fx = this.fx.filter((f) => now - f.t0 < f.dur);
    for (const f of this.fx) {
      const t = (now - f.t0) / f.dur;
      const x = this.tx(f.tile), y = this.ty(f.tile);
      switch (f.kind) {
        case 'boom': {
          const r = Math.max(6, f.r * z) * (0.4 + t * 0.9);
          ctx.fillStyle = `rgba(255,${Math.round(220 - 160 * t)},60,${(1 - t) * 0.85})`;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = `rgba(255,255,220,${Math.max(0, 1 - t * 2.5)})`;
          ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, Math.PI * 2); ctx.fill();
          for (let i = 0; i < 8; i++) {
            const a = i * 0.785 + f.tile, d = r * (0.6 + t * 1.2);
            ctx.fillStyle = `rgba(80,70,60,${1 - t})`;
            ctx.fillRect(Math.round(x + Math.cos(a) * d) - 2, Math.round(y + Math.sin(a) * d) - 2, 4, 4);
          }
          break;
        }
        case 'nuke': {
          const R = Math.max(14, f.r * z);
          const fire = t < 0.5 ? t / 0.5 : 1;
          const grd = ctx.createRadialGradient(x, y, 0, x, y, R * (0.3 + fire * 0.9));
          grd.addColorStop(0, `rgba(255,255,230,${1 - t})`);
          grd.addColorStop(0.4, `rgba(255,190,60,${(1 - t) * 0.9})`);
          grd.addColorStop(1, 'rgba(160,40,20,0)');
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(x, y, R * (0.3 + fire * 0.9), 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.8})`;
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(x, y, R * (0.5 + t * 2.6), 0, Math.PI * 2); ctx.stroke();
          // mushroom column
          const hgt = R * 1.6 * Math.min(1, t * 2);
          ctx.fillStyle = `rgba(90,70,60,${(1 - t) * 0.7})`;
          ctx.fillRect(x - R * 0.12, y - hgt, R * 0.24, hgt);
          ctx.fillStyle = `rgba(120,90,70,${(1 - t) * 0.75})`;
          ctx.beginPath(); ctx.ellipse(x, y - hgt, R * 0.55 * Math.min(1, t * 2.5), R * 0.3 * Math.min(1, t * 2.5), 0, 0, Math.PI * 2); ctx.fill();
          break;
        }
        case 'intercept': {
          ctx.strokeStyle = `rgba(150,240,255,${1 - t})`;
          ctx.lineWidth = 2;
          for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(x, y - 20, 6 + t * 30 + i * 6, 0, Math.PI * 2); ctx.stroke(); }
          this.text('INTERCEPTED', x, y - 40 - t * 20, 9, `rgba(150,240,255,${1 - t})`);
          break;
        }
        case 'ping': {
          const col = f.color ?? '#ffd23f';
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          for (let i = 0; i < 2; i++) {
            const q = (t * 3 + i * 0.5) % 1;
            ctx.globalAlpha = 1 - q;
            ctx.beginPath(); ctx.arc(x, y, 6 + q * 28, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.globalAlpha = 1;
          if (f.text) this.text(f.text, x, y - 30, 8, col);
          break;
        }
        case 'sink':
        case 'land': {
          ctx.strokeStyle = f.kind === 'sink' ? `rgba(180,220,255,${1 - t})` : `rgba(230,200,140,${1 - t})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, 4 + t * 16, 0, Math.PI * 2); ctx.stroke();
          break;
        }
      }
    }
  }

  private label(text: string, px: number, color: string): HTMLCanvasElement {
    const k = `${text}|${px}|${color}`;
    let c = this.labelCache.get(k);
    if (c) return c;
    if (this.labelCache.size > 3000) this.labelCache.clear();
    c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    const font = `${px}px "Press Start 2P", monospace`;
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 4;
    c.width = w; c.height = px + 5;
    g.font = font;
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(5,7,12,.85)';
    for (const [dx, dy] of [[1, 1], [2, 2], [1, 2], [2, 1], [0, 1], [1, 0], [2, 3], [3, 2]]) g.fillText(text, dx, dy);
    g.fillStyle = color;
    g.fillText(text, 1, 1);
    this.labelCache.set(k, c);
    return c;
  }
  text(s: string, x: number, y: number, px: number, color: string) {
    const c = this.label(s, px, color);
    this.ctx.drawImage(c, Math.round(x - c.width / 2), Math.round(y - c.height / 2));
  }

  private drawLabels() {
    const w = this.world, z = this.cam.z, ctx = this.ctx;
    const tc = w.tileCount, W = this.W;
    for (const p of w.players) {
      if (!p || !p.alive) continue;
      const n = tc[p.id];
      if (n < 4) continue;
      // fit the name inside the territory: Press Start 2P glyphs are 1em wide
      const span = Math.sqrt(n) * z * 1.25;
      let px = Math.floor(clamp(span / Math.max(5, p.name.length), 0, 28));
      if (px < 7) { if (p.human && px >= 4) px = 7; else continue; }
      px = px - (px % 2);
      let wx = w.sumX[p.id] / n + 0.5, wy = w.sumY[p.id] / n + 0.5;
      const ct = Math.floor(wy) * W + (Math.floor(wx) % W);
      if (w.owner[ct] !== p.id && p.capital >= 0 && w.owner[p.capital] === p.id) { wx = (p.capital % W) + 0.5; wy = ((p.capital / W) | 0) + 1.5; }
      const x = this.sx(wx), y = this.sy(wy);
      if (x < -200 || x > this.cw + 200 || y < -40 || y > this.ch + 40) continue;
      const color = p.id === w.myId ? '#ffffff' : p.human ? '#ffe9a8' : '#e6e6e6';
      const c = this.label(p.name, px, color);
      ctx.drawImage(c, Math.round(x - c.width / 2), Math.round(y - c.height / 2));
      const tr = p.id === w.myId ? w.me?.troops : p.troops;
      if (tr !== null && tr !== undefined && px >= 9) {
        const c2 = this.label(fmt(tr), Math.max(7, px - 4 - ((px - 4) % 2)), '#ffb4b4');
        ctx.drawImage(c2, Math.round(x - c2.width / 2), Math.round(y + c.height / 2));
      }
    }
  }

  private box(t: number, color: string, lw = 2) {
    const z = this.cam.z, x = this.sx(t % this.W), y = this.sy((t / this.W) | 0);
    const s = Math.max(z, 6);
    const off = (s - z) / 2;
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lw;
    this.ctx.strokeRect(Math.round(x - off) - 1, Math.round(y - off) - 1, Math.round(s) + 2, Math.round(s) + 2);
  }
  private circle(t: number, rTiles: number, stroke: string, fill?: string, dash = true) {
    const ctx = this.ctx, r = rTiles * this.cam.z;
    ctx.beginPath();
    ctx.arc(this.tx(t), this.ty(t), r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    if (dash) ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawModeUnder() {
    const w = this.world, ms = w.map.ms;
    const focus = this.target >= 0 ? this.target : this.hover;
    if (w.phase === 'spawn') {
      const prot = SPAWN.humanProtect * ms;
      for (const p of w.players) if (p && p.capital >= 0 && p.id !== w.myId) this.circle(p.capital, prot, 'rgba(255,80,80,.7)', 'rgba(255,60,60,.08)');
      if (focus >= 0 && w.map.isLand(focus)) this.circle(focus, Math.max(2, SPAWN.radius * ms) + 0.5, '#ffffff', 'rgba(255,255,255,.18)', false);
      return;
    }
    if (this.mode === 'missile' || this.mode === 'intercept') {
      for (const b of w.bld.values()) if (b.owner === w.myId && b.type === B.MISSILE_SILO && b.level > 0) this.circle(b.tile, (MISSILE.range + (b.level - 1) * MISSILE.rangePerLevel) * ms, 'rgba(255,120,80,.8)', 'rgba(255,120,80,.05)');
    } else if (this.mode === 'bomb') {
      for (const b of w.bld.values()) if (b.owner === w.myId && b.type === B.AIRBASE && b.level > 0) this.circle(b.tile, AIR.bomberRange * ms, 'rgba(220,220,255,.8)', 'rgba(220,220,255,.05)');
    }
    if (focus < 0) return;
    if (this.mode === 'nuke') this.circle(focus, NUKE.radius * ms, 'rgba(255,40,40,.95)', 'rgba(255,40,40,.15)', false);
    else if (this.mode === 'missile') this.circle(focus, MISSILE.radius * ms, 'rgba(255,160,60,.95)', 'rgba(255,160,60,.2)', false);
    else if (this.mode === 'bomb') this.circle(focus, AIR.bombRadius * ms, 'rgba(255,255,255,.95)', 'rgba(255,255,255,.2)', false);
    else if (this.mode === 'build') {
      const ok = w.owner[focus] === w.myId && w.bldAt[focus] < 0;
      this.box(focus, ok ? '#6cff6c' : '#ff4040', 2);
      if (ok && this.cam.z >= 3) {
        const s = clamp(Math.round(Math.min(this.cam.z * 2.1, 36) / 11), 1, 3), size = 11 * s;
        this.ctx.globalAlpha = 0.6;
        this.ctx.drawImage(badge(this.modeArg, w.players[w.myId]?.color ?? 0xffffff), Math.round(this.tx(focus) - size / 2), Math.round(this.ty(focus) - size / 2), size, size);
        this.ctx.globalAlpha = 1;
      }
    }
  }

  private drawSelection() {
    if (this.sel >= 0) this.box(this.sel, '#ffffff', 2);
    if (this.target >= 0 && this.target !== this.sel) this.box(this.target, '#ffd23f', 2);
    else if (this.hover >= 0 && this.mode && this.mode !== 'build') this.box(this.hover, 'rgba(255,255,255,.6)', 1);
  }

  // ---- minimap -----------------------------------------------------------------------------------------
  private drawMinimap(now: number) {
    const mm = this.minimap;
    if (!mm || !mm.isConnected || mm.style.display === 'none') return;
    const mw = mm.width, mh = mm.height;
    if (!this.mmBase || this.mmBase.width !== mw) { this.mmBase = document.createElement('canvas'); this.mmBase.width = mw; this.mmBase.height = mh; this.mapChanged = true; }
    if (this.mapChanged && now - this.mmAt > 700) {
      const b = this.mmBase.getContext('2d')!;
      b.imageSmoothingEnabled = true;
      b.fillStyle = OCEAN_CSS;
      b.fillRect(0, 0, mw, mh);
      const sx = mw / this.W, sy = mh / this.H;
      for (const c of this.chunks) b.drawImage(c.canvas, c.x0 * sx, c.y0 * sy, c.w * sx + 0.5, c.h * sy + 0.5);
      this.mmAt = now;
      this.mapChanged = false;
    }
    const ctx = mm.getContext('2d')!;
    ctx.drawImage(this.mmBase, 0, 0);
    const vw = (this.cw / this.cam.z / this.W) * mw, vh = (this.ch / this.cam.z / this.H) * mh;
    const vx = ((this.cam.x / this.W) * mw) - vw / 2, vy = ((this.cam.y / this.H) * mh) - vh / 2;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    for (const off of [-mw, 0, mw]) ctx.strokeRect(Math.round(vx + off) + 0.5, Math.round(vy) + 0.5, Math.round(vw), Math.round(vh));
    // nukes in flight
    for (const n of this.world.nukes.values()) {
      ctx.fillStyle = Math.floor(now / 200) % 2 ? '#ff2a2a' : '#ffd23f';
      ctx.fillRect(((n.tile % this.W) / this.W) * mw - 2, (((n.tile / this.W) | 0) / this.H) * mh - 2, 5, 5);
    }
  }
  minimapClick(fx: number, fy: number) {
    this.cam.x = fx * this.W;
    this.cam.y = fy * this.H;
    this.clampCam();
    this.needs = true;
  }
}
