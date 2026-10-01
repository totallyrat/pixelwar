// Canvas renderer. The map is a W x H pixel image split into 128x128 chunk canvases; only chunks
// with changed tiles are re-uploaded. Everything else (buildings, ships, flights, effects, labels)
// is drawn as an overlay each frame, and frames are only drawn when something changed/animates.

import { TERRAIN, T, RES, LIMITS, NUKE_TIERS, MISSILE, AIR, B, SPAWN, TICK_MS, TICK_RATE, buildTime } from '../../../shared/balance.ts';
import type { World, OpC } from '../world.ts';
import { badge, shipSprite, star, cssColor, glyphCanvas } from './sprites.ts';
import { fmt, clamp } from '../util.ts';

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; grow: number; r: number; g: number; b: number; kind: number }
interface CamAnim { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t0: number; dur: number; done?: () => void }
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const OP_KIND_GLYPH: Record<string, string> = { attack: 'troops', invade: 'transport', missile: 'missile', bomb: 'bomber', nuke: 'nuke', mega: 'nuke', fleet: 'warship' };

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
export interface Fx { kind: 'boom' | 'nuke' | 'intercept' | 'ping' | 'sink' | 'land' | 'found'; tile: number; r: number; t0: number; dur: number; color?: string; text?: string; big?: boolean }
const hexRgb = (css: string): [number, number, number] => {
  const n = parseInt(css.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

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
  private shakeAmp = 0;
  private shakeDecay = 0.9;
  private lastFrame = 0;
  private particles: Particle[] = [];
  private camAnim: CamAnim | null = null;
  private follow: (() => { x: number; y: number; z: number } | null) | null = null;
  private cine = 0;          // letterbox amount 0..1
  cineOn = false;
  cineText = '';
  onCineChange: (on: boolean) => void = () => {};
  showOps = false;
  opFocus = 0;
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
  pan(dx: number, dy: number) { this.interrupt(); this.cam.x -= dx / this.cam.z; this.cam.y -= dy / this.cam.z; this.clampCam(); this.needs = true; }
  zoomAt(sx: number, sy: number, f: number) {
    this.interrupt();
    const c = this.cam;
    const wx = c.x + (sx - this.cw / 2) / c.z, wy = c.y + (sy - this.ch / 2) / c.z;
    c.z = clamp(c.z * f, this.minZoom(), 48);
    c.x = wx - (sx - this.cw / 2) / c.z;
    c.y = wy - (sy - this.ch / 2) / c.z;
    this.clampCam();
    this.needs = true;
  }
  centerOn(t: number, z?: number) {
    this.interrupt();
    this.cam.x = (t % this.W) + 0.5;
    this.cam.y = ((t / this.W) | 0) + 0.5;
    if (z) this.cam.z = z;
    this.clampCam();
    this.needs = true;
  }

  // ---- camera animation & cinematics --------------------------------------------------------------
  /** Smoothly fly the camera to a tile (or world point) and zoom. */
  flyTo(t: number | { x: number; y: number }, z: number, dur = 1000, done?: () => void) {
    const x1 = typeof t === 'number' ? (t % this.W) + 0.5 : t.x, y1 = typeof t === 'number' ? ((t / this.W) | 0) + 0.5 : t.y;
    let dx = x1 - this.cam.x;
    if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
    this.camAnim = { x0: this.cam.x, y0: this.cam.y, z0: this.cam.z, x1: this.cam.x + dx, y1, z1: clamp(z, this.minZoom(), 48), t0: performance.now(), dur, done };
    this.needs = true;
  }
  /** Letterboxed cinematic that tracks a moving target every frame; ends when `fn` returns null. */
  cinematic(fn: () => { x: number; y: number; z: number } | null, text: string) {
    this.camAnim = null;
    this.follow = fn;
    this.cineText = text;
    this.setCine(true);
  }
  setCine(on: boolean) {
    if (this.cineOn === on) return;
    this.cineOn = on;
    this.onCineChange(on);
    this.needs = true;
  }
  endCinematic() {
    this.follow = null;
    this.camAnim = null;
    this.setCine(false);
  }
  /** User input takes the camera back. */
  private interrupt() {
    if (this.follow || this.camAnim || this.cineOn) this.endCinematic();
  }
  private updateCamera(now: number, dt: number) {
    const c = this.cam;
    if (this.camAnim) {
      const a = this.camAnim;
      const t = clamp((now - a.t0) / a.dur, 0, 1), e = easeInOut(t);
      c.x = a.x0 + (a.x1 - a.x0) * e;
      c.y = a.y0 + (a.y1 - a.y0) * e;
      // zoom interpolates in log space so it feels even
      c.z = Math.exp(Math.log(a.z0) + (Math.log(a.z1) - Math.log(a.z0)) * e);
      this.clampCam();
      if (t >= 1) { this.camAnim = null; a.done?.(); }
    } else if (this.follow) {
      const tgt = this.follow();
      if (!tgt) { this.follow = null; return; }
      let dx = tgt.x - c.x;
      if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
      // exponential smoothing in real time, so slow devices track just as tightly
      const kp = 1 - Math.exp(-dt * 7), kz = 1 - Math.exp(-dt * 3.2);
      c.x += dx * kp;
      c.y += (tgt.y - c.y) * kp;
      c.z = Math.exp(Math.log(c.z) + (Math.log(tgt.z) - Math.log(c.z)) * kz);
      this.clampCam();
    }
  }

  /** Opening shot: dive into the capital, pyrotechnics, then settle at a playable zoom. */
  intro(tile: number, color: number) {
    this.setCine(true);
    this.cineText = 'YOUR NATION RISES';
    this.flyTo(tile, 22, 1500, () => {
      this.addFx({ kind: 'found', tile, r: 3, dur: 2600, color: cssColor(color) });
      this.shake(9, 0.93);
      setTimeout(() => {
        if (!this.cineOn) return;
        this.flyTo(tile, 7, 1300, () => this.setCine(false));
      }, 2300);
    });
  }

  shake(px: number, decay = 0.9) {
    if (px > this.shakeAmp) { this.shakeAmp = px; this.shakeDecay = decay; }
    this.needs = true;
  }

  // ---- particles -------------------------------------------------------------------------------------------
  /** Emit pixel particles at a tile. kind: 0 smoke, 1 spark, 2 debris. Speeds in tiles/s. */
  burst(tile: number, n: number, kind: number, speed: number, rgb: [number, number, number], size = 3, life = 1.5, spread = 0) {
    const W = this.W, cx = (tile % W) + 0.5, cy = ((tile / W) | 0) + 0.5;
    const room = 2600 - this.particles.length;
    n = Math.min(n, room);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.7);
      const r0 = spread * Math.sqrt(Math.random());
      this.particles.push({
        x: cx + Math.cos(a) * r0, y: cy + Math.sin(a) * r0,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - (kind === 0 ? speed * 0.6 : 0),
        life: 0, max: life * (0.6 + Math.random() * 0.8), size: size * (0.7 + Math.random() * 0.6), grow: kind === 0 ? 1.6 : 0,
        r: rgb[0], g: rgb[1], b: rgb[2], kind,
      });
    }
    this.needs = true;
  }
  private drawParticles(dt: number) {
    if (!this.particles.length) return;
    const ctx = this.ctx, z = this.cam.z, zs = clamp(z / 6, 0.6, 3);
    let w = 0;
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.max) continue;
      const drag = p.kind === 0 ? 0.985 : 0.95;
      p.vx *= drag; p.vy *= drag;
      if (p.kind === 0) p.vy -= 0.4 * dt; // smoke rises
      p.x += p.vx * dt; p.y += p.vy * dt;
      this.particles[w++] = p;
      const t = p.life / p.max;
      const x = this.sx(p.x), y = this.sy(p.y);
      if (x < -40 || y < -40 || x > this.cw + 40 || y > this.ch + 40) continue;
      const s = Math.max(1, Math.round((p.size + p.grow * t * 6) * zs));
      let r = p.r, g = p.g, b = p.b;
      if (p.kind === 1) { g = Math.round(g * (1 - t * 0.7)); b = Math.round(b * (1 - t)); }
      ctx.fillStyle = `rgba(${r},${g},${b},${p.kind === 0 ? (1 - t) * 0.55 : 1 - t * t})`;
      ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), s, s);
    }
    this.particles.length = w;
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
    const x = this.tx(f.tile), y = this.ty(f.tile);
    const onScreen = x > -150 && y > -150 && x < this.cw + 150 && y < this.ch + 150;
    const R = f.r;
    switch (f.kind) {
      case 'nuke': {
        const mega = !!f.big;
        // everyone feels it, wherever they are looking
        this.flash = Math.max(this.flash, onScreen ? 1 : 0.35);
        this.shake(mega ? 38 : 24, mega ? 0.978 : 0.967);
        this.burst(f.tile, mega ? 520 : 280, 0, R * 0.32, [118, 96, 84], 6, mega ? 7 : 5, R * 0.35);
        this.burst(f.tile, mega ? 320 : 170, 1, R * 1.25, [255, 226, 130], 2, 1.3, R * 0.1);
        this.burst(f.tile, mega ? 240 : 130, 2, R * 0.9, [58, 46, 40], 3, 2.6, R * 0.2);
        break;
      }
      case 'boom':
        this.burst(f.tile, 34, 1, R * 2.4, [255, 206, 96], 2, 0.8);
        this.burst(f.tile, 16, 0, R * 0.5, [128, 116, 104], 4, 1.8, R * 0.3);
        if (onScreen) this.shake(5, 0.88);
        break;
      case 'found': {
        const rgb = f.color ? hexRgb(f.color) : [255, 210, 63] as [number, number, number];
        this.burst(f.tile, 140, 1, 5, rgb, 2, 1.4);
        this.burst(f.tile, 90, 1, 3.5, [255, 236, 170], 2, 1.1);
        this.burst(f.tile, 110, 0, 1.4, [150, 140, 132], 6, 3.2, 1.2);
        this.burst(f.tile, 40, 2, 3, [70, 60, 52], 2, 1.6);
        this.flash = Math.max(this.flash, 0.35);
        break;
      }
    }
    this.needs = true;
  }

  // ---- frame ----------------------------------------------------------------------------------------------
  private animating(): boolean {
    const w = this.world;
    return this.fx.length > 0 || w.flights.size > 0 || w.nukes.size > 0 || this.flash > 0 || this.shakeAmp > 0 ||
      this.particles.length > 0 || !!this.camAnim || !!this.follow || Math.abs(this.cine - (this.cineOn ? 1 : 0)) > 0.01 ||
      (w.ships.size > 0 && performance.now() - w.tickAt < TICK_MS * 1.2) || !!this.mode || w.phase === 'spawn' ||
      (this.showOps && w.ops.size > 0);
  }

  private frame(now: number) {
    if (!this.ready) return;
    if (!this.needs && !this.animating()) return;
    // cap to ~40fps when only ambient animation is running (saves tablet battery)
    if (!this.needs && now - this.lastFrame < 24) return;
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    this.needs = false;
    this.updateCamera(now, dt);
    const ctx = this.ctx, dpr = this.dpr;
    for (const c of this.chunks) if (c.dirty) { c.ctx.putImageData(c.img, 0, 0); c.dirty = false; }

    // map layer in device pixels (integer-aligned chunks => no seams)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let shx = 0, shy = 0;
    if (this.shakeAmp > 0.4) {
      shx = Math.round((Math.random() - 0.5) * 2 * this.shakeAmp * dpr);
      shy = Math.round((Math.random() - 0.5) * 2 * this.shakeAmp * dpr);
      this.shakeAmp *= this.shakeDecay ** (dt * 60); // decay is per 60fps frame
    } else this.shakeAmp = 0;
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
    if (this.showOps || this.opFocus) this.drawOps();
    this.drawBuildings();
    this.drawShips();
    this.drawFlights();
    this.drawFx(now);
    this.drawParticles(dt);
    if (this.showLabels && !this.cineOn) this.drawLabels();
    this.drawSelection();
    if (this.flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255,255,240,${this.flash * 0.85})`;
      ctx.fillRect(0, 0, cwD, chD);
      this.flash = Math.max(0, this.flash - dt * 1.8);
    }
    this.drawLetterbox(dt);
    this.drawMinimap(now);
    this.onFrame();
  }

  private drawLetterbox(dt: number) {
    this.cine += ((this.cineOn ? 1 : 0) - this.cine) * Math.min(1, dt * 7);
    if (this.cine < 0.01) { this.cine = 0; return; }
    const ctx = this.ctx, bar = Math.round(this.ch * 0.12 * this.cine);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.cw, bar);
    ctx.fillRect(0, this.ch - bar, this.cw, bar);
    if (this.cineText && this.cine > 0.6) {
      ctx.globalAlpha = (this.cine - 0.6) / 0.4;
      this.text(this.cineText, this.cw / 2, this.ch - bar / 2, 12, '#ffd23f');
      this.text('TAP TO SKIP', this.cw / 2, bar / 2, 8, '#8d97bd');
      ctx.globalAlpha = 1;
    }
  }

  /** Operation plans on the map: an arrow from each executor to its target with the step number. */
  private drawOps() {
    const w = this.world, ctx = this.ctx, W = this.W;
    const blink = Math.floor(performance.now() / 300) % 2 === 0;
    for (const op of w.ops.values()) {
      if (op.status === 'cancelled' || (this.opFocus && op.id !== this.opFocus) || (!this.opFocus && op.status === 'done')) continue;
      const ordered = op.steps.slice().sort((a, b) => a.delay - b.delay || a.id - b.id);
      ordered.forEach((st, i) => {
        const p = w.P(st.by);
        const col = p ? cssColor(p.color) : '#fff';
        const tx = this.tx(st.tile), ty = this.ty(st.tile);
        if (p && p.capital >= 0 && st.kind !== 'fleet') {
          let ax = (p.capital % W) + 0.5;
          const bx = (st.tile % W) + 0.5;
          if (bx - ax > W / 2) ax += W; else if (ax - bx > W / 2) ax -= W;
          const sx = this.sx(ax), sy = this.sy(((p.capital / W) | 0) + 0.5);
          ctx.strokeStyle = col;
          ctx.globalAlpha = st.state === 'planned' ? 0.75 : 0.35;
          ctx.lineWidth = 2;
          ctx.setLineDash(st.kind === 'attack' || st.kind === 'invade' ? [8, 5] : [3, 4]);
          ctx.beginPath();
          const mx = (sx + tx) / 2, my = (sy + ty) / 2 - Math.hypot(tx - sx, ty - sy) * (st.kind === 'attack' ? 0.08 : 0.22);
          ctx.moveTo(sx, sy);
          ctx.quadraticCurveTo(mx, my, tx, ty);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        // target marker
        const live = op.status === 'countdown' || op.status === 'running';
        const r = 9 + (live && st.state === 'planned' && blink ? 3 : 0);
        ctx.strokeStyle = st.state === 'failed' ? '#ff4d5e' : st.state === 'done' ? '#5dff8a' : col;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(tx - r - 4, ty); ctx.lineTo(tx - r + 3, ty); ctx.moveTo(tx + r - 3, ty); ctx.lineTo(tx + r + 4, ty); ctx.stroke();
        const g = glyphCanvas(OP_KIND_GLYPH[st.kind] ?? 'target', st.kind === 'mega' || st.kind === 'nuke' ? '#9dff3c' : '#fff', 1);
        ctx.fillStyle = '#05070c';
        ctx.fillRect(Math.round(tx + r - 2), Math.round(ty - r - 12), 24, 12);
        ctx.drawImage(g, Math.round(tx + r), Math.round(ty - r - 10), 8, 8);
        this.text(String(i + 1), tx + r + 16, ty - r - 6, 8, st.state === 'failed' ? '#ff4d5e' : st.state === 'done' ? '#5dff8a' : '#ffd23f');
        if (st.delay && op.status !== 'done') this.text(`+${st.delay}s`, tx, ty + r + 9, 7, '#e8ecff');
      });
    }
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

  flightPos(f: { from: number; to: number; t0: number; t1: number; kind: number }, t: number) {
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
      ctx.lineWidth = f.kind === 1 ? (f.tier === 1 ? 6 : 3) : 2;
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
        const mega = f.tier === 1, hs = mega ? 7 : 4;
        ctx.fillStyle = blink ? '#ff2a2a' : '#ffd23f';
        ctx.fillRect(Math.round(x) - hs, Math.round(y) - hs, hs * 2, hs * 2);
        if (mega) { ctx.fillStyle = '#9dff3c'; ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4); }
        // target zone with countdown
        const tx = this.tx(f.to), ty = this.ty(f.to);
        const R = NUKE_TIERS[f.tier ?? 0].radius * w.map.ms * z;
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
          const R = Math.max(18, f.r * z), mega = !!f.big;
          // scorched ground covering the whole blast radius, glowing then cooling
          ctx.fillStyle = `rgba(${Math.round(90 - 60 * t)},${Math.round(30 - 20 * t)},10,${0.55 * (1 - t)})`;
          ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
          // fireball swelling out to the full impact zone
          const fire = Math.min(1, t / 0.3);
          const fr = R * (0.2 + fire * 0.85);
          const grd = ctx.createRadialGradient(x, y, 0, x, y, fr);
          grd.addColorStop(0, `rgba(255,255,235,${Math.max(0, 1 - t * 1.3)})`);
          grd.addColorStop(0.35, `rgba(255,200,70,${Math.max(0, 0.95 - t * 1.1)})`);
          grd.addColorStop(0.75, `rgba(220,70,25,${Math.max(0, 0.7 - t)})`);
          grd.addColorStop(1, 'rgba(120,20,10,0)');
          ctx.fillStyle = grd;
          ctx.beginPath(); ctx.arc(x, y, fr, 0, Math.PI * 2); ctx.fill();
          // shockwaves racing outward
          for (const [speed, a0, lw] of mega ? [[3.4, 0.9, 5], [5, 0.5, 3], [6.5, 0.3, 2]] : [[3, 0.85, 4], [4.2, 0.4, 2]]) {
            ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, (1 - t) * a0)})`;
            ctx.lineWidth = lw;
            ctx.beginPath(); ctx.arc(x, y, R * (0.4 + t * speed), 0, Math.PI * 2); ctx.stroke();
          }
          // mushroom cloud rising from the blast
          const rise = Math.min(1, t * 1.8), fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
          const hgt = R * (mega ? 1.9 : 1.6) * rise;
          ctx.fillStyle = `rgba(92,72,62,${0.75 * fade})`;
          ctx.fillRect(x - R * 0.13, y - hgt, R * 0.26, hgt);
          ctx.fillStyle = `rgba(128,96,76,${0.8 * fade})`;
          ctx.beginPath(); ctx.ellipse(x, y - hgt, R * 0.6 * rise, R * 0.33 * rise, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = `rgba(255,170,80,${0.35 * fade * (1 - rise * 0.6)})`;
          ctx.beginPath(); ctx.ellipse(x, y - hgt + R * 0.08, R * 0.4 * rise, R * 0.16 * rise, 0, 0, Math.PI * 2); ctx.fill();
          break;
        }
        case 'found': {
          const col = f.color ?? '#ffd23f';
          ctx.strokeStyle = col;
          ctx.globalAlpha = 1 - t;
          ctx.lineWidth = 4;
          ctx.beginPath(); ctx.arc(x, y, 12 + t * 140, 0, Math.PI * 2); ctx.stroke();
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, 6 + t * 80, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
          const fb = Math.max(0, 1 - t * 3);
          if (fb > 0) {
            ctx.fillStyle = `rgba(255,240,190,${fb})`;
            ctx.beginPath(); ctx.arc(x, y, 30 * (1 - fb) + 8, 0, Math.PI * 2); ctx.fill();
          }
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
    if (this.mode === 'nuke') this.circle(focus, NUKE_TIERS[this.modeArg === 1 ? 1 : 0].radius * ms, 'rgba(255,40,40,.95)', 'rgba(255,40,40,.15)', false);
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
