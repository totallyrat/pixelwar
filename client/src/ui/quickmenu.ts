// Radial quick menu that opens where you hold a pixel. Pick an item by sliding onto it and letting
// go, or by lifting the finger and tapping. Dangerous items (nukes) need a second tap.

import { icon } from '../render/sprites.ts';
import { esc, el, clamp } from '../util.ts';
import { sfx } from '../audio.ts';

export interface QItem {
  id: string;
  label: string;
  icon: string;
  iconColor?: string;
  sub?: string;
  disabled?: boolean;
  why?: string;        // shown when a disabled item is tapped
  tone?: 'hi' | 'red' | 'green';
  confirm?: boolean;
  act: () => void;
}

export class QuickMenu {
  private root: HTMLElement;
  private box: HTMLElement | null = null;
  private items: QItem[] = [];
  private armed = '';
  private origin = { x: 0, y: 0 };
  private cleanup: (() => void)[] = [];
  onError: (msg: string) => void = () => {};

  constructor(root: HTMLElement) { this.root = root; }
  get isOpen() { return !!this.box; }

  show(x: number, y: number, title: string, subtitle: string, items: QItem[], fromHold: boolean) {
    this.close();
    if (!items.length) return;
    this.items = items;
    this.armed = '';
    this.origin = { x, y };
    const n = items.length;
    const R = n <= 4 ? 78 : n <= 6 ? 92 : 108;
    const W = window.innerWidth, H = window.innerHeight;
    const cx = clamp(x, R + 46, W - R - 46), cy = clamp(y, R + 90, H - R - 110);
    const box = el('div', 'qmenu');
    box.innerHTML = `<div class="qm-title pix" style="left:${cx}px;top:${cy - R - 74}px">${esc(title)}${subtitle ? `<span>${esc(subtitle)}</span>` : ''}</div>
      <div class="qm-dot" style="left:${cx}px;top:${cy}px"></div>`;
    items.forEach((it, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const b = el('button', `qm-item pix ${it.tone ?? ''} ${it.disabled ? 'off' : ''}`);
      b.dataset.qi = String(i);
      b.style.left = `${cx + Math.cos(a) * R}px`;
      b.style.top = `${cy + Math.sin(a) * R}px`;
      b.style.animationDelay = `${i * 18}ms`;
      b.innerHTML = `<img src="${icon(it.icon, it.iconColor ?? '#fff')}" alt=""><b>${esc(it.label)}</b>${it.sub ? `<i>${it.sub}</i>` : ''}`;
      box.append(b);
    });
    box.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-qi]');
      if (b) this.pick(Number(b.dataset.qi), b);
      else if (!(e.target as HTMLElement).closest('.qm-title')) this.close();
    });
    box.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.append(box);
    this.box = box;
    if (fromHold) {
      // slide-to-select while the finger is still down
      const move = (e: PointerEvent) => {
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-qi]');
        box.querySelectorAll('.qm-item.hot').forEach((x) => x !== hit && x.classList.remove('hot'));
        hit?.classList.add('hot');
      };
      const up = (e: PointerEvent) => {
        this.cleanupListeners();
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-qi]');
        if (hit && Math.hypot(e.clientX - this.origin.x, e.clientY - this.origin.y) > 26) this.pick(Number(hit.dataset.qi), hit);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up, { once: true });
      this.cleanup.push(() => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); });
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };
    addEventListener('keydown', key);
    this.offKey = () => removeEventListener('keydown', key);
  }
  private offKey: () => void = () => {};

  private pick(i: number, btn: HTMLElement) {
    const it = this.items[i];
    if (!it) return;
    if (it.disabled) {
      sfx.error();
      btn.classList.remove('shake');
      void btn.offsetWidth;
      btn.classList.add('shake');
      if (it.why) this.onError(it.why);
      return;
    }
    if (it.confirm && this.armed !== it.id) {
      this.armed = it.id;
      sfx.underAttack();
      btn.classList.add('armed');
      btn.querySelector('b')!.textContent = 'TAP AGAIN';
      return;
    }
    sfx.click();
    this.close();
    it.act();
  }

  private cleanupListeners() {
    for (const f of this.cleanup) f();
    this.cleanup = [];
  }

  close() {
    this.cleanupListeners();
    this.offKey();
    this.offKey = () => {};
    this.box?.remove();
    this.box = null;
  }
}
