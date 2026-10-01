// Touch-first input: one finger pans, two fingers pinch-zoom, tap selects, double-tap attacks and
// holding a pixel opens the quick menu. Mouse: drag pans, wheel zooms, hold the left button for the
// quick menu, right-click (or right-drag release) attacks.

import type { Renderer } from './render/renderer.ts';

const HOLD_MS = 430;

export interface InputHandlers {
  tap(t: number): void;
  doubleTap(t: number): void;
  secondary(t: number): void;
  hold(t: number, x: number, y: number): void;
  hover(t: number): void;
  escape(): void;
  key(k: string): void;
}

interface Ptr { x: number; y: number; x0: number; y0: number; t0: number; button: number; touch: boolean }

export class Input {
  private ptrs = new Map<number, Ptr>();
  private moved = false;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };
  private longTimer = 0;
  private longFired = false;
  private keys = new Set<string>();
  private canvas: HTMLCanvasElement;
  private r: Renderer;
  private h: InputHandlers;

  constructor(canvas: HTMLCanvasElement, r: Renderer, h: InputHandlers) {
    this.canvas = canvas;
    this.r = r;
    this.h = h;
    const c = canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e, false));
    c.addEventListener('pointercancel', (e) => this.up(e, true));
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.ptrs.size) this.h.hover(-1); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.r.zoomAt(e.clientX, e.clientY, Math.exp(-d * 0.0016));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('keydown', (e) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'Escape') return this.h.escape();
      this.keys.add(e.key.toLowerCase());
      if (e.key === '+' || e.key === '=') this.r.zoomAt(this.r.cw / 2, this.r.ch / 2, 1.25);
      else if (e.key === '-' || e.key === '_') this.r.zoomAt(this.r.cw / 2, this.r.ch / 2, 0.8);
      else this.h.key(e.key.toLowerCase());
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
    const pan = () => {
      const k = this.keys, s = 14;
      let dx = 0, dy = 0;
      if (k.has('arrowleft') || k.has('a')) dx += s;
      if (k.has('arrowright') || k.has('d')) dx -= s;
      if (k.has('arrowup') || k.has('w')) dy += s;
      if (k.has('arrowdown') || k.has('s')) dy -= s;
      if (dx || dy) this.r.pan(dx, dy);
      requestAnimationFrame(pan);
    };
    requestAnimationFrame(pan);
  }

  private down(e: PointerEvent) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    const touch = e.pointerType !== 'mouse';
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), button: e.button, touch });
    if (this.ptrs.size === 1) {
      this.moved = false;
      this.longFired = false;
      clearTimeout(this.longTimer);
      if (touch || e.button === 0) {
        const x = e.clientX, y = e.clientY;
        this.longTimer = window.setTimeout(() => {
          if (!this.moved && this.ptrs.size === 1) {
            this.longFired = true;
            navigator.vibrate?.(18);
            this.h.hold(this.r.tileAt(x, y), x, y);
          }
        }, HOLD_MS);
      }
    } else if (this.ptrs.size === 2) {
      clearTimeout(this.longTimer);
      const [a, b] = [...this.ptrs.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      this.moved = true;
    }
  }

  private move(e: PointerEvent) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.h.hover(this.r.tileAt(e.clientX, e.clientY));
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.longFired) return; // the quick menu is open under this finger
    if (this.ptrs.size === 1) {
      if (!this.moved && Math.hypot(p.x - p.x0, p.y - p.y0) > (p.touch ? 10 : 6)) { this.moved = true; clearTimeout(this.longTimer); }
      if (this.moved && p.button !== 2) this.r.pan(dx, dy);
      if (!p.touch) this.h.hover(this.r.tileAt(e.clientX, e.clientY));
    } else if (this.ptrs.size === 2 && this.pinch) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this.pinch.d > 0) this.r.zoomAt(mx, my, d / this.pinch.d);
      this.r.pan(mx - this.pinch.mx, my - this.pinch.my);
      this.pinch = { d, mx, my };
    }
  }

  private up(e: PointerEvent, cancel: boolean) {
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    clearTimeout(this.longTimer);
    if (!p) return;
    if (this.pinch) {
      if (this.ptrs.size < 2) this.pinch = null;
      for (const q of this.ptrs.values()) { q.x0 = q.x; q.y0 = q.y; }
      return;
    }
    if (cancel || this.longFired) return;
    const t = this.r.tileAt(e.clientX, e.clientY);
    if (p.button === 2) { this.h.secondary(t); return; }
    if (this.moved) return;
    const now = performance.now();
    if (now - this.lastTap.t < 330 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 28) {
      this.lastTap.t = 0;
      this.h.doubleTap(t);
    } else {
      this.lastTap = { t: now, x: e.clientX, y: e.clientY };
      this.h.tap(t);
    }
  }
}
