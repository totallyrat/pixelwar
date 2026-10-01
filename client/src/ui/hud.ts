// In-game HUD (DOM overlay).

import {
  BUILDINGS, BUILDING_COUNT, B, UNITS, U, UNIT_COUNT, TECH, TERRAIN, RES, TICK_RATE, NUKE_TIERS, BUILDING_SPACING,
  buildCost, buildTime, unitCost, type Cost, AI_LEVELS,
} from '../../../shared/balance.ts';
import { REL, REL_NAMES } from '../../../shared/protocol.ts';
import type { App } from '../main.ts';
import { icon, iconImg, BUILDING_GLYPH, UNIT_GLYPH, cssColor } from '../render/sprites.ts';
import { fmt, fmtRate, esc, el, mmss, clamp } from '../util.ts';
import { sfx } from '../audio.ts';
import { store } from '../net.ts';
import { QuickMenu, type QItem } from './quickmenu.ts';
import { OpsView, OP_KIND_NAMES } from './opsview.ts';
import { mountInvite } from './invite.ts';

type PanelName = 'build' | 'army' | 'ops' | 'diplo' | 'chat' | 'ranks';
const PING_KINDS: [string, string, string][] = [['attack', 'Attack here', '#ff4d5e'], ['defend', 'Defend here', '#5aa9ff'], ['look', 'Look here', '#ffd23f'], ['help', 'Need help', '#5dff8a']];

/** Short single-resource price tag for compact buttons (the scarcest resource wins). */
export function shortCost(c: Cost, me: any): string {
  const miss = (v?: number, have = 0) => !!v && have + 1e-6 < v;
  if (miss(c.uranium, me?.ura)) return `<span class="no">U${fmt(c.uranium!)}</span>`;
  if (miss(c.oil, me?.oil)) return `<span class="no">oil ${fmt(c.oil!)}</span>`;
  if (miss(c.prod, me?.prod)) return `<span class="no">P${fmt(c.prod!)}</span>`;
  return `<span class="${miss(c.money, me?.money) ? 'no' : ''}">$${fmt(c.money ?? 0)}</span>`;
}

export function costHtml(c: Cost, me: any): string {
  const parts: string[] = [];
  const f = (v: number | undefined, have: number, ic: string, col: string) => {
    if (!v) return;
    parts.push(`<span class="${have + 1e-6 < v ? 'no' : ''}">${iconImg(ic, col)}${fmt(v)}</span>`);
  };
  f(c.money, me?.money ?? 0, 'money', '#ffd23f');
  f(c.prod, me?.prod ?? 0, 'prod', '#b9c2e0');
  f(c.oil, me?.oil ?? 0, 'drop', '#a0a0a0');
  f(c.uranium, me?.ura ?? 0, 'uranium', '#9dff3c');
  return parts.join(' ') || 'free';
}
export function affordable(c: Cost, me: any): boolean {
  if (!me) return false;
  return (c.money ?? 0) <= me.money + 1e-6 && (c.prod ?? 0) <= me.prod + 1e-6 && (c.oil ?? 0) <= me.oil + 1e-6 && (c.uranium ?? 0) <= me.ura + 1e-6;
}

export class Hud {
  private root: HTMLElement;
  readonly app: App;
  readonly qm: QuickMenu;
  readonly ops: OpsView;
  private cineNuke = 0;
  private top!: HTMLElement;
  private resEls: Record<string, { v: HTMLElement; r?: HTMLElement; box: HTMLElement }> = {};
  private phaseEl!: HTMLElement;
  private bottom!: HTMLElement;
  private panel!: HTMLElement;
  private panelBody!: HTMLElement;
  private panelTitle!: HTMLElement;
  private panelExtra!: HTMLElement;
  private card!: HTMLElement;
  private toasts!: HTMLElement;
  private alerts!: HTMLElement;
  private modebar!: HTMLElement;
  private banner!: HTMLElement;
  private minimap!: HTMLCanvasElement;
  private conn!: HTMLElement;
  private spectate!: HTMLElement;
  private overlay: HTMLElement | null = null;
  private badges: Record<string, HTMLElement> = {};
  open: PanelName | null = null;
  pct = Number(store.get('pct') ?? 30) / 100;
  private pctLabel!: HTMLElement;
  private lastPanel = 0;
  private lastCard = 0;
  private lastAlerts = 0;
  private unread = 0;
  private chatCh: 'g' | 'a' = 'g';
  private diploFilter: 'near' | 'humans' | 'all' = 'near';
  private diploSearch = '';
  private neighbours = new Map<number, number>();
  private neighAt = 0;
  private toastKeys = new Map<string, number>();
  private wasAlive = true;
  private bannerUntil = 0;
  private peaceAnnounced = false;
  private endShown = false;
  // don't rebuild DOM under a finger: a tap straddling a re-render would be lost
  private touchAt = 0;
  private touching = 0;
  private lastHtml = new WeakMap<HTMLElement, string>();
  private alertSig = '';

  private guard(elm: HTMLElement) {
    elm.addEventListener('pointerdown', () => { this.touching++; this.touchAt = performance.now(); });
    const up = () => { this.touching = Math.max(0, this.touching - 1); this.touchAt = performance.now(); };
    elm.addEventListener('pointerup', up);
    elm.addEventListener('pointercancel', up);
    elm.addEventListener('pointerleave', () => { if (this.touching) up(); });
  }
  private busy() { return this.touching > 0 || performance.now() - this.touchAt < 350; }
  /** Set innerHTML only when it actually changed. */
  private setHtml(elm: HTMLElement, html: string): boolean {
    if (this.lastHtml.get(elm) === html) return false;
    this.lastHtml.set(elm, html);
    elm.innerHTML = html;
    return true;
  }

  constructor(app: App) {
    this.app = app;
    this.root = document.getElementById('ui')!;
    this.qm = new QuickMenu(this.root);
    this.qm.onError = (msg) => this.toast(esc(msg), 'bad', -1, 'qm:' + msg, 2500);
    this.ops = new OpsView(this);
  }

  get w() { return this.app.world; }
  get r() { return this.app.renderer; }
  get me() { return this.app.world.me; }

  // ---- DOM skeleton ------------------------------------------------------------------------------
  mount() {
    this.unmount();
    const R = this.root;
    this.top = el('div', 'topbar');
    const resDefs: [string, string, string, string][] = [
      ['money', 'money', '#ffd23f', 'Money'], ['prod', 'prod', '#b9c2e0', 'Production'], ['food', 'food', '#e8c75a', 'Food'],
      ['oil', 'drop', '#9a9a9a', 'Oil'], ['ura', 'uranium', '#9dff3c', 'Uranium'], ['pop', 'pop', '#ffffff', 'Population / capacity'],
      ['troops', 'troops', '#ff8080', 'Troops (+tanks)'], ['happy', 'happy', '#ffd23f', 'Happiness'], ['land', 'score', '#ffd23f', 'Territory / rank'],
    ];
    for (const [k, ic, col, title] of resDefs) {
      const box = el('div', 'res');
      box.title = title;
      box.innerHTML = `<img class="ico big" src="${icon(ic, col)}" alt=""><div><span class="v">-</span><span class="r muted"></span></div>`;
      this.resEls[k] = { box, v: box.querySelector<HTMLElement>('.v')!, r: box.querySelector<HTMLElement>('.r')! };
      this.top.append(box);
    }
    this.top.append(el('div', 'spacer'));
    this.phaseEl = el('div', 'phase');
    this.top.append(this.phaseEl);

    this.bottom = el('div', 'bottombar');
    const ctl = el('div', 'troopctl');
    ctl.innerHTML = `<div class="lab">SEND<br>TROOPS</div><input type="range" min="5" max="100" step="5" value="${Math.round(this.pct * 100)}"><span class="pct">${Math.round(this.pct * 100)}%</span>`;
    const range = ctl.querySelector('input')!;
    this.pctLabel = ctl.querySelector('.pct')!;
    range.addEventListener('input', () => { this.pct = Number(range.value) / 100; this.pctLabel.textContent = range.value + '%'; store.set('pct', range.value); });
    this.bottom.append(ctl);
    const btn = (name: string, ic: string, label: string, fn: () => void) => {
      const b = el('button', 'btn', `<img class="ico" src="${icon(ic, '#fff')}" alt="">${label}`);
      b.addEventListener('click', () => { sfx.click(); fn(); });
      const badge = el('span', 'badge hidden');
      b.append(badge);
      this.badges[name] = badge;
      this.bottom.append(b);
      return b;
    };
    btn('build', 'build', 'Build', () => this.toggle('build'));
    btn('army', 'troops', 'Army', () => this.toggle('army'));
    btn('ops', 'target', 'Ops', () => this.toggle('ops'));
    btn('diplo', 'diplo', 'Diplo', () => this.toggle('diplo'));
    btn('chat', 'chat', 'Chat', () => this.toggle('chat'));
    btn('ranks', 'score', 'Ranks', () => this.toggle('ranks'));
    btn('ping', 'ping', 'Ping', () => this.setMode('ping', 0));
    btn('menu', 'menu', 'Menu', () => this.showMenu());

    this.panel = el('div', 'panel pix hidden');
    this.panel.innerHTML = `<div class="ph"><h2></h2><button class="btn small" data-close>${iconImg('close')}</button></div><div class="pextra"></div><div class="pb"></div>`;
    this.panelTitle = this.panel.querySelector('h2')!;
    this.panelBody = this.panel.querySelector('.pb')!;
    this.panelExtra = this.panel.querySelector('.pextra')!;
    this.panel.querySelector('[data-close]')!.addEventListener('click', () => this.toggle(null));
    this.panel.addEventListener('click', (e) => this.onAct(e));

    this.card = el('div', 'card pix hidden');
    this.card.addEventListener('click', (e) => this.onAct(e));
    this.toasts = el('div', 'toasts');
    this.alerts = el('div', 'alerts');
    this.alerts.addEventListener('click', (e) => this.onAct(e));
    this.modebar = el('div', 'modebar pix hidden');
    this.modebar.addEventListener('click', (e) => this.onAct(e));
    this.banner = el('div', 'banner hidden');
    this.minimap = el('canvas', 'minimap pix');
    this.minimap.width = 240 * 2; this.minimap.height = 120 * 2;
    this.minimap.addEventListener('pointerdown', (e) => this.mmClick(e));
    this.minimap.addEventListener('pointermove', (e) => { if (e.buttons) this.mmClick(e); });
    this.r.minimap = this.minimap;
    this.r.onCineChange = (on) => this.root.classList.toggle('cine', on);
    this.conn = el('div', 'conn pix hidden', 'RECONNECTING...');
    this.spectate = el('div', 'spectate pix hidden', 'ELIMINATED - SPECTATING');
    this.guard(this.panel);
    this.guard(this.card);
    this.guard(this.alerts);
    R.append(this.top, this.bottom, this.card, this.panel, this.minimap, this.toasts, this.alerts, this.modebar, this.banner, this.conn, this.spectate);
    this.wasAlive = true;
    this.endShown = false;
    this.peaceAnnounced = this.w.phase === 'running' && this.w.tick >= this.w.peaceUntil;
    this.update(true);
    if (this.w.phase === 'ended' && this.w.winner) this.showEnd({ ids: this.w.winner.ids, reason: this.w.winner.reason, stats: [] });
  }

  unmount() {
    this.qm?.close();
    this.root.innerHTML = '';
    this.root.classList.remove('cine');
    this.overlay = null;
    this.open = null;
    if (this.r) { this.r.minimap = null; this.r.showOps = false; this.r.opFocus = 0; }
  }

  setConn(ok: boolean) { this.conn?.classList.toggle('hidden', ok); }

  private mmClick(e: PointerEvent) {
    const rect = this.minimap.getBoundingClientRect();
    this.r.minimapClick((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  }

  // ---- per-tick update -------------------------------------------------------------------------------
  update(force = false) {
    const me = this.me, w = this.w;
    if (!me || !this.top) return;
    const R = this.resEls;
    const set = (k: string, v: string, r?: string, warn = false) => {
      const e = R[k];
      if (e.v.textContent !== v) e.v.textContent = v;
      if (e.r && r !== undefined && e.r.textContent !== r) e.r.textContent = r;
      e.box.classList.toggle('warn', warn);
    };
    set('money', fmt(me.money), fmtRate(me.rates[2]) + '/s');
    set('prod', fmt(me.prod), fmtRate(me.rates[1]) + '/s');
    set('food', fmt(me.food), fmtRate(me.rates[0]) + '/s', !!me.starving);
    set('oil', fmt(me.oil), fmtRate(me.rates[3]) + '/s');
    set('ura', fmt(me.ura), fmtRate(me.rates[4]) + '/s');
    set('pop', fmt(me.pop), '/' + fmt(me.cap));
    set('troops', fmt(me.troops), me.tanks ? `+${fmt(me.tanks)} tanks` : fmtRate(me.rates[6]) + '/s');
    set('happy', me.happy + '%', me.happy < 25 ? 'UNREST!' : me.traitor ? 'TRAITOR' : '', me.happy < 25);
    const pct = w.map ? (me.tiles / w.map.landCount) * 100 : 0;
    set('land', pct.toFixed(pct < 10 ? 2 : 1) + '%', me.rank ? `#${me.rank} ${fmt(me.score)}pts` : '');
    // phase
    let ph = '';
    if (w.phase === 'spawn') ph = `SPAWN ${Math.ceil(w.secondsLeft(w.phaseEnd))}s`;
    else if (w.phase === 'running' && w.tick < w.peaceUntil) ph = `PEACE ${Math.ceil(w.secondsLeft(w.peaceUntil))}s`;
    else if (w.phase === 'running' && w.settings.timeLimitMin) ph = mmss(w.settings.timeLimitMin * 60 - (w.tick - w.startTick) / TICK_RATE);
    if (w.winter > 3 && w.settings.nuclearWinter) ph = `WINTER ${ph}`;
    if (this.phaseEl.textContent !== ph) this.phaseEl.textContent = ph;
    this.updateBanner();
    if (!this.peaceAnnounced && w.phase === 'running' && w.tick >= w.peaceUntil) {
      this.peaceAnnounced = true;
      if (w.peaceUntil > w.startTick) { this.flashBanner('WAR IS ON', 'Peace time is over. Nations may now attack each other.'); sfx.underAttack(); }
    }
    // badges
    this.badge('chat', this.unread);
    this.badge('diplo', w.proposals.length);
    this.badge('ops', this.ops.pendingInvites());
    this.r.showOps = this.open === 'ops';
    this.r.opFocus = this.open === 'ops' ? this.ops.view : 0;
    if (this.cineNuke && this.r.cineOn) {
      const n = w.nukes.get(this.cineNuke);
      this.r.cineText = n ? `${NUKE_TIERS[n.tier].name.toUpperCase()} · IMPACT IN ${w.secondsLeft(n.t1).toFixed(1)}s` : 'DETONATION';
    }
    // death
    if (this.wasAlive && !me.alive && w.phase !== 'spawn') {
      this.wasAlive = false;
      this.spectate.classList.remove('hidden');
      if (w.phase === 'running') { this.toast('Your nation has fallen. You are now spectating.', 'bad'); sfx.defeat(); }
    }
    const now = performance.now();
    const busy = !force && this.busy();
    if (this.open && !busy && (force || now - this.lastPanel > 450)) this.renderPanel();
    if (!this.card.classList.contains('hidden') && !busy && (force || now - this.lastCard > 450)) this.renderCard();
    if (force || now - this.lastAlerts > 200) this.renderAlerts();
  }

  private badge(name: string, n: number) {
    const b = this.badges[name];
    if (!b) return;
    b.classList.toggle('hidden', !n);
    const s = n > 99 ? '99+' : String(n);
    if (b.textContent !== s) b.textContent = s;
  }

  private updateBanner() {
    const w = this.w;
    if (w.phase === 'spawn') {
      const sec = Math.ceil(w.secondsLeft(w.phaseEnd));
      const me = w.P(w.myId);
      this.banner.classList.remove('hidden');
      this.banner.innerHTML = `<div class="big">${me && me.capital >= 0 ? 'CAPITAL PLACED' : 'CHOOSE YOUR CAPITAL'}</div><div class="small">${me && me.capital >= 0 ? 'Tap elsewhere to move it.' : 'Tap anywhere on land to found your nation.'} ${sec}s</div>`;
    } else if (performance.now() < this.bannerUntil) {
      this.banner.classList.remove('hidden');
    } else this.banner.classList.add('hidden');
  }
  flashBanner(big: string, small: string, ms = 3500) {
    this.banner.innerHTML = `<div class="big">${esc(big)}</div><div class="small">${esc(small)}</div>`;
    this.bannerUntil = performance.now() + ms;
    this.banner.classList.remove('hidden');
  }

  // ---- panels ---------------------------------------------------------------------------------------------
  toggle(p: PanelName | null) {
    this.open = p === this.open ? null : p;
    this.panel.classList.toggle('hidden', !this.open);
    this.panelExtra.innerHTML = '';
    if (this.open === 'chat') { this.unread = 0; this.mountChat(); }
    if (this.open === 'diplo') this.mountDiploExtra();
    if (this.open) this.renderPanel(true);
  }

  renderPanel(reset = false) {
    this.lastPanel = performance.now();
    const body = this.panelBody, scroll = body.scrollTop;
    const titles: Record<PanelName, string> = { build: 'Build', army: 'Army & Weapons', ops: 'Operations', diplo: 'Diplomacy', chat: 'Chat', ranks: 'Leaderboard' };
    if (!this.open) return;
    this.panelTitle.textContent = titles[this.open];
    let html = '';
    switch (this.open) {
      case 'build': html = this.buildHtml(); break;
      case 'army': html = this.armyHtml(); break;
      case 'ops': html = this.ops.html(); break;
      case 'diplo': html = this.diploHtml(); break;
      case 'chat': this.renderChat(); return;
      case 'ranks': html = this.ranksHtml(); break;
    }
    if (reset) this.lastHtml.delete(body);
    if (!this.setHtml(body, html)) return;
    body.scrollTop = reset ? 0 : scroll;
    const mob = body.querySelector<HTMLInputElement>('input[data-mob]');
    if (mob) mob.addEventListener('change', () => this.app.net.act('mob', { v: Number(mob.value) / 100 }));
    if (mob) mob.addEventListener('input', () => { const l = body.querySelector('[data-mobl]'); if (l) l.textContent = mob.value + '%'; });
  }

  private buildHtml(): string {
    const me = this.me, w = this.w;
    if (!me) return '';
    const sel = this.r.sel;
    const direct = sel >= 0 && w.owner[sel] === w.myId && w.bldAt[sel] < 0;
    let h = `<div class="muted">Building slots: <span class="${me.used >= me.slots ? 'bad' : 'hi-t'}">${me.used}/${me.slots}</span> <span style="font-size:7px">(cities add more)</span></div>
      <div class="muted" style="font-size:7px">${direct ? 'Tap a building to place it on the selected tile.' : 'Pick a building, then tap your land. Or select a tile first.'}</div><div class="bgrid">`;
    for (let t = 1; t < BUILDING_COUNT; t++) {
      const d = BUILDINGS[t];
      if (t === B.NUCLEAR_FACILITY && !w.settings.nukes) continue;
      const c = buildCost(t, 0, me.nb[t]);
      const ok = affordable(c, me);
      h += `<button class="btn bbtn ${this.r.mode === 'build' && this.r.modeArg === t ? 'on' : ''}" data-act="bmode" data-b="${t}" ${ok ? '' : 'style="opacity:.6"'}>
        <span class="nm">${iconImg(BUILDING_GLYPH[t], '#fff')}${d.name}</span>
        <span class="cost">${costHtml(c, me)} · ${d.time}s${me.nb[t] ? ` <span class="muted">(+${Math.round(d.scale * 100)}% each)</span>` : ''}</span>
        <span class="cost">${d.desc}</span>
        ${me.nb[t] ? `<span class="cnt">owned: ${me.nb[t]}</span>` : ''}</button>`;
    }
    return h + '</div>';
  }

  private armyHtml(): string {
    const me = this.me, w = this.w;
    if (!me) return '';
    let h = `<div class="section">MOBILIZATION <span class="muted">(share of population under arms)</span></div>
      <div class="row"><input class="grow" type="range" min="0" max="90" step="5" value="${Math.round(me.mob * 100)}" data-mob><span data-mobl class="hi-t">${Math.round(me.mob * 100)}%</span></div>
      <div class="muted" style="font-size:7px">More troops = less tax & growth. Above 40% people get unhappy.</div>
      <div class="row wrap"><span>${iconImg('troops', '#ff8080')} ${fmt(me.troops)} troops</span><span>${iconImg('tank', '#c9d48a')} ${fmt(me.tanks)} tanks</span><span>${iconImg('warship', '#9ec9ff')} ${me.ships} warships</span></div>`;
    if (me.atk.length) {
      h += `<div class="section">ACTIVE FRONTS</div>`;
      for (const [id, target, tr, tk] of me.atk) {
        h += `<div class="drow"><span class="nm">${target ? this.pname(target) : 'Expanding into unclaimed land'}</span><span class="muted">${fmt(tr)}${tk ? ' +' + fmt(tk) + 'tk' : ''}</span><div class="btns"><button class="btn small red" data-act="cancel" data-id="${id}">Recall</button></div></div>`;
      }
    }
    h += `<div class="section">PRODUCTION</div>`;
    for (let u = 0; u < UNIT_COUNT; u++) {
      const d = UNITS[u];
      const warhead = u === U.NUKE || u === U.MEGA_NUKE;
      if (warhead && !w.settings.nukes) continue;
      const lvlOk = !d.minLevel || (me.nfl ?? 0) >= d.minLevel;
      const has = me.nb[d.building] > 0 && lvlOk;
      const c = unitCost(u, (me.stock[u] ?? 0) + (me.queue[u] ?? 0));
      const q = me.queue[u], prog = q ? clamp(me.qprog[u] / d.time, 0, 1) : 0;
      const stock = u === U.TANK ? me.tanks : u === U.WARSHIP ? me.ships : me.stock[u];
      const need = me.nb[d.building] > 0 ? `Needs a Lv ${d.minLevel} ${BUILDINGS[d.building].name}` : 'Needs ' + BUILDINGS[d.building].name;
      h += `<div class="urow"><img class="ico big" src="${icon(UNIT_GLYPH[u], warhead ? (u === U.MEGA_NUKE ? '#ff4d5e' : '#9dff3c') : '#fff')}" alt="">
        <div><div class="nm">${d.name} <span class="hi-t">x${fmt(stock)}</span>${q ? ` <span class="muted">+${q} queued</span>` : ''}</div>
        <div class="sub">${has ? costHtml(c, me) + ' · ' + d.time + 's' : need}</div>
        ${q ? `<div class="bar"><i style="width:${(prog * 100).toFixed(0)}%"></i></div>` : ''}</div>
        <div class="btns">${q ? `<button class="btn small" data-act="untrain" data-u="${u}">-</button>` : ''}
        <button class="btn small" data-act="train" data-u="${u}" data-n="1" ${has && affordable(c, me) ? '' : 'disabled'}>+1</button>
        ${u === U.TANK || u === U.MISSILE || u === U.TRANSPORT ? `<button class="btn small" data-act="train" data-u="${u}" data-n="5" ${has && affordable(c, me) ? '' : 'disabled'}>+5</button>` : ''}</div></div>`;
    }
    h += `<div class="section">STRATEGIC ORDERS</div><div class="strat">
      <button class="btn" data-act="mode" data-m="missile" ${me.stock[U.MISSILE] ? '' : 'disabled'}>${iconImg('missile')} Missile (${me.stock[U.MISSILE]})</button>
      <button class="btn" data-act="mode" data-m="bomb" ${me.stock[U.BOMBER] ? '' : 'disabled'}>${iconImg('bomber')} Bomber (${me.stock[U.BOMBER]})</button>
      ${w.settings.nukes ? `<button class="btn red" data-act="mode" data-m="nuke" data-a="0" ${me.stock[U.NUKE] ? '' : 'disabled'}>${iconImg('nuke', '#9dff3c')} M. Nuke (${me.stock[U.NUKE]})</button>
        <button class="btn red" data-act="mode" data-m="nuke" data-a="1" ${me.stock[U.MEGA_NUKE] ? '' : 'disabled'}>${iconImg('nuke', '#ff4d5e')} Mega (${me.stock[U.MEGA_NUKE]})</button>` : ''}
      <button class="btn" data-act="mode" data-m="invade" ${me.stock[U.TRANSPORT] ? '' : 'disabled'}>${iconImg('transport')} Invade (${me.stock[U.TRANSPORT]})</button>
      <button class="btn" data-act="mode" data-m="ships" ${me.ships ? '' : 'disabled'}>${iconImg('warship')} Move fleet</button>
      </div>`;
    h += `<div class="section">TECHNOLOGY</div>`;
    for (const [k, i, name] of [['off', 0, 'Offense'], ['def', 1, 'Defense']] as const) {
      const lvl = me.tech[i];
      const c = TECH.cost(lvl);
      h += `<div class="drow"><span class="nm">${name} Lv ${lvl}/${TECH.maxLevel} <span class="muted">+${lvl * 10}%</span></span>${lvl < TECH.maxLevel ? `<span class="muted" style="font-size:7px">${costHtml(c, me)}</span><div class="btns"><button class="btn small" data-act="tech" data-w="${k}" ${affordable(c, me) ? '' : 'disabled'}>Research</button></div>` : '<span class="hi-t">MAX</span>'}</div>`;
    }
    return h;
  }

  relTag(id: number): string {
    const w = this.w;
    if (id === w.myId) return '<span class="tag you">YOU</span>';
    const r = w.rel[id];
    const cls = ['', 'war', 'nap', 'ally'][r];
    let extra = '';
    if (r === REL.NAP) { const u = w.relUntil.get(id); if (u) extra = ' ' + mmss(w.secondsLeft(u)); }
    return `<span class="tag ${cls}">${REL_NAMES[r].toUpperCase()}${extra}</span>`;
  }
  pname(id: number): string {
    const p = this.w.P(id);
    if (!p) return 'Unclaimed land';
    return `<span class="sw" style="background:${cssColor(p.color)}"></span> ${esc(p.name)}`;
  }

  private mountDiploExtra() {
    this.panelExtra.innerHTML = `<div style="padding:10px 12px 0;display:flex;flex-direction:column;gap:8px">
      <div class="chips"><button class="btn small" data-f="near">Neighbours</button><button class="btn small" data-f="humans">Humans</button><button class="btn small" data-f="all">All</button></div>
      <input placeholder="Search nations..." value="${esc(this.diploSearch)}"></div>`;
    const inp = this.panelExtra.querySelector('input')!;
    inp.addEventListener('input', () => { this.diploSearch = inp.value.toLowerCase(); this.renderPanel(true); });
    this.panelExtra.querySelectorAll<HTMLButtonElement>('[data-f]').forEach((b) => {
      b.classList.toggle('on', b.dataset.f === this.diploFilter);
      b.addEventListener('click', () => {
        this.diploFilter = b.dataset.f as any;
        this.panelExtra.querySelectorAll<HTMLButtonElement>('[data-f]').forEach((x) => x.classList.toggle('on', x === b));
        this.renderPanel(true);
      });
    });
  }

  private diploHtml(): string {
    const w = this.w;
    let h = '';
    if (w.proposals.length) {
      h += '<div class="section">INCOMING PROPOSALS</div>';
      for (const p of w.proposals) {
        h += `<div class="drow"><span class="nm">${this.pname(p.from)}</span><span class="hi-t">${p.kind === 'nap' ? 'Non-aggression pact' : p.kind === 'ally' ? 'Alliance' : 'Peace'}</span>
          <div class="btns"><button class="btn small green" data-act="respond" data-p="${p.from}" data-k="${p.kind}" data-y="1">Accept</button><button class="btn small red" data-act="respond" data-p="${p.from}" data-k="${p.kind}" data-y="0">Decline</button></div></div>`;
      }
    }
    const now = performance.now();
    if (now - this.neighAt > 3000) { this.neighbours = w.neighbours(w.myId); this.neighAt = now; }
    let list = w.players.filter((p) => p && p.alive && p.id !== w.myId);
    if (this.diploSearch) list = list.filter((p) => p.name.toLowerCase().includes(this.diploSearch));
    else if (this.diploFilter === 'near') list = list.filter((p) => this.neighbours.has(p.id) || w.rel[p.id] !== REL.PEACE);
    else if (this.diploFilter === 'humans') list = list.filter((p) => p.human);
    list.sort((a, b) => (b.human ? 1 : 0) - (a.human ? 1 : 0) || (w.rel[b.id] ? 1 : 0) - (w.rel[a.id] ? 1 : 0) || w.tileCount[b.id] - w.tileCount[a.id]);
    h += `<div class="section">NATIONS (${list.length})</div>`;
    if (!list.length) h += `<div class="muted">${this.diploFilter === 'near' && !this.diploSearch ? 'No neighbours yet. Expand!' : 'Nobody here.'}</div>`;
    const land = w.map.landCount;
    for (const p of list.slice(0, 60)) {
      const r = w.rel[p.id];
      const pct = (w.tileCount[p.id] / land) * 100;
      const who = p.human ? '<span class="tag">HUMAN</span>' : `<span class="tag">AI ${(AI_LEVELS[p.diff] ?? '').slice(0, 3).toUpperCase()}</span>`;
      let btns = '';
      const b = (act: string, label: string, cls = '') => `<button class="btn small ${cls}" data-act="${act}" data-p="${p.id}">${label}</button>`;
      if (r === REL.PEACE) btns = b('nap', 'Pact') + b('ally', 'Ally', 'green') + b('war', 'War', 'red');
      else if (r === REL.NAP) btns = b('ally', 'Ally', 'green') + b('break', 'Betray', 'red');
      else if (r === REL.ALLY) btns = b('aidT', '+Troops') + b('aidM', '+$') + b('break', 'Betray', 'red');
      else if (r === REL.WAR) btns = b('peace', 'Peace', 'green');
      h += `<div class="drow"><span class="nm">${this.pname(p.id)}</span>${who}${this.relTag(p.id)}
        <span class="muted" style="font-size:7px">${pct.toFixed(pct < 1 ? 2 : 1)}%${p.troops !== null ? ' · ' + fmt(p.troops) + ' troops' : ''}</span>
        <div class="btns">${btns}<button class="btn small" data-act="locate" data-p="${p.id}">${iconImg('target')}</button></div></div>`;
    }
    return h;
  }

  private mountChat() {
    this.panelBody.innerHTML = '';
    this.lastHtml.delete(this.panelBody);
    this.panelExtra.innerHTML = `<div style="padding:10px 12px 0" class="chips"><button class="btn small" data-ch="g">Global</button><button class="btn small" data-ch="a">Alliance</button></div>`;
    this.panelExtra.querySelectorAll<HTMLButtonElement>('[data-ch]').forEach((b) => {
      b.classList.toggle('on', b.dataset.ch === this.chatCh);
      b.addEventListener('click', () => {
        this.chatCh = b.dataset.ch as 'g' | 'a';
        this.panelExtra.querySelectorAll<HTMLButtonElement>('[data-ch]').forEach((x) => x.classList.toggle('on', x === b));
        this.renderChat();
      });
    });
    const log = el('div', 'chatlog');
    const form = el('form', 'row');
    form.innerHTML = `<input class="grow" maxlength="200" placeholder="Message..." enterkeyhint="send"><button class="btn">Send</button>`;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = form.querySelector('input')!;
      const text = inp.value.trim();
      if (!text) return;
      this.app.net.act('chat', { ch: this.chatCh, text });
      inp.value = '';
    });
    this.panelBody.append(log, form);
    this.renderChat();
  }
  private renderChat() {
    const log = this.panelBody.querySelector('.chatlog');
    if (!log) return;
    const w = this.w;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    log.innerHTML = w.chat.filter((c) => c.ch === this.chatCh).slice(-100).map((c) => {
      const p = w.P(c.from);
      return `<div class="msg"><b style="color:${p ? cssColor(p.color) : '#fff'}">${esc(c.name)}:</b> ${esc(c.text)}</div>`;
    }).join('') || `<div class="muted">${this.chatCh === 'a' ? 'Messages here reach only your allies.' : 'Say hello to the world.'}</div>`;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  private ranksHtml(): string {
    const w = this.w, lb = w.lb;
    if (!lb) return '<div class="muted">Waiting for data...</div>';
    let h = `<div class="muted">${lb.n} nations alive · win at ${w.settings.winPercent}% of land</div><div class="lbrow muted"><span>#</span><span></span><span>NATION</span><span>LAND</span><span>SCORE</span></div>`;
    let meIn = false;
    lb.top.forEach(([id, score, tiles], i) => {
      const p = w.P(id);
      if (id === w.myId) meIn = true;
      h += `<div class="lbrow ${id === w.myId ? 'me' : ''}"><span>${i + 1}</span><span class="sw" style="background:${cssColor(p?.color ?? 0)}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p?.name ?? '?')}${p?.human ? ' ' + iconImg('pop', '#ffe9a8') : ''}</span><span>${((tiles / lb.land) * 100).toFixed(1)}%</span><span>${fmt(score)}</span></div>`;
    });
    const me = this.me;
    if (!meIn && me && me.alive) h += `<div class="lbrow me"><span>${me.rank}</span><span class="sw" style="background:${cssColor(w.P(w.myId)?.color ?? 0)}"></span><span>You</span><span>${((me.tiles / lb.land) * 100).toFixed(2)}%</span><span>${fmt(me.score)}</span></div>`;
    return h;
  }

  // ---- tile card -------------------------------------------------------------------------------------------
  select(t: number) {
    this.r.sel = t;
    this.r.needs = true;
    if (t < 0) { this.card.classList.add('hidden'); return; }
    this.card.classList.remove('hidden');
    this.renderCard();
    if (this.open === 'build') this.renderPanel();
  }

  private renderCard() {
    this.lastCard = performance.now();
    const w = this.w, m = w.map, me = this.me, t = this.r.mode && this.r.target >= 0 ? this.r.target : this.r.sel;
    if (t < 0 || !m) { this.card.classList.add('hidden'); return; }
    const ter = TERRAIN[m.terrain[t]];
    const o = w.owner[t];
    const p = w.P(o);
    const res = m.resource[t] === RES.OIL ? ' · <span class="hi-t">Oil deposit</span>' : m.resource[t] === RES.URANIUM ? ' · <span class="good">Uranium deposit</span>' : '';
    let h = `<div class="title">${o ? this.pname(o) : m.isWater(t) ? 'Open water' : 'Unclaimed land'} ${o ? this.relTag(o) : ''}<button class="btn small x" data-act="closecard">${iconImg('close')}</button></div>`;
    h += `<div class="meta">${ter.name}${ter.water ? '' : ` · def x${ter.def}`}${res}<br>${esc(m.countryName(t))}${w.fallout[t] ? ' · <span class="good">RADIOACTIVE</span>' : ''}`;
    if (p && o !== w.myId) h += `<br>${p.troops !== null ? `Troops: ${fmt(p.troops)}${p.tanks ? ` + ${fmt(p.tanks)} tanks` : ''} · ` : 'Troops: hidden (fog) · '}Land: ${((w.tileCount[o] / m.landCount) * 100).toFixed(2)}%`;
    h += '</div>';
    const bid = w.bldAt[t];
    const bld = bid >= 0 ? w.bld.get(bid) : undefined;
    if (bld) {
      const d = BUILDINGS[bld.type];
      const cap = p && p.capital === t;
      h += `<div class="row">${iconImg(BUILDING_GLYPH[bld.type], '#fff', 'ico big')}<span>${cap ? 'Capital ' : ''}${d.name} <span class="hi-t">Lv ${bld.level}${bld.done ? ' (building...)' : ''}</span></span></div>`;
      if (bld.owner === w.myId && me) {
        const up = bld.level < d.maxLevel && !bld.done;
        const c = buildCost(bld.type, bld.level);
        h += `<div class="acts">${up ? `<button class="btn small" data-act="upgrade" ${affordable(c, me) ? '' : 'disabled'}>Upgrade ${costHtml(c, me)} · ${buildTime(bld.type, bld.level)}s</button>` : ''}${cap ? '' : '<button class="btn small red" data-act="demolish">Demolish</button>'}</div>`;
        if (up) h += `<div class="muted" style="font-size:7px">Upgrades take half the time of a new ${d.name.toLowerCase()} and don't get pricier as you build more.</div>`;
      }
    }
    // actions
    const mode = this.r.mode;
    if (mode && ['missile', 'nuke', 'bomb', 'invade'].includes(mode) && this.r.target >= 0) {
      const nukeName = NUKE_TIERS[this.r.modeArg === 1 ? 1 : 0].name.toUpperCase();
      const label = { missile: 'LAUNCH MISSILE', nuke: `LAUNCH ${nukeName}`, bomb: 'SEND BOMBER', invade: `INVADE (${Math.round(this.pct * 100)}% troops)` }[mode as 'missile'];
      h += `<div class="acts"><button class="btn ${mode === 'nuke' ? 'red' : 'hi'}" data-act="confirm">${label}</button><button class="btn" data-act="cancelmode">Cancel</button></div>`;
    } else if (w.phase === 'running' && me?.alive && !mode) {
      const acts: string[] = [];
      if (o === w.myId) {
        if (!bld) acts.push(`<button class="btn" data-act="openbuild">${iconImg('build')} Build here</button>`);
      } else if (m.isLand(t)) {
        const r = w.rel[o];
        if (!o) acts.push(`<button class="btn hi" data-act="attack">${iconImg('troops')} Expand ${Math.round(this.pct * 100)}%</button>`);
        else if (r !== REL.ALLY && r !== REL.NAP) acts.push(`<button class="btn hi" data-act="attack">${iconImg('troops')} Attack ${Math.round(this.pct * 100)}%</button>`);
        if (m.coastal[t] && me.stock[U.TRANSPORT] > 0 && r !== REL.ALLY && r !== REL.NAP) acts.push(`<button class="btn" data-act="invadehere">${iconImg('transport')} Invade by sea</button>`);
        if (o && r !== REL.ALLY && r !== REL.NAP) {
          if (me.stock[U.MISSILE] > 0) acts.push(`<button class="btn" data-act="target" data-m="missile">${iconImg('missile')} Missile</button>`);
          if (me.stock[U.BOMBER] > 0) acts.push(`<button class="btn" data-act="target" data-m="bomb">${iconImg('bomber')} Bomb</button>`);
          if (me.stock[U.NUKE] > 0 && w.settings.nukes) acts.push(`<button class="btn red" data-act="target" data-m="nuke" data-a="0">${iconImg('nuke', '#9dff3c')} Nuke</button>`);
          if (me.stock[U.MEGA_NUKE] > 0 && w.settings.nukes) acts.push(`<button class="btn red" data-act="target" data-m="nuke" data-a="1">${iconImg('nuke', '#ff4d5e')} Mega</button>`);
        }
        if (o) acts.push(`<button class="btn" data-act="diplowith" data-p="${o}">${iconImg('diplo')} Diplomacy</button>`);
      } else if (me.ships > 0) acts.push(`<button class="btn" data-act="shipshere">${iconImg('warship')} Move fleet here</button>`);
      if (acts.length) h += `<div class="acts">${acts.join('')}</div>`;
    }
    this.setHtml(this.card, h);
  }

  // ---- modes ---------------------------------------------------------------------------------------------------
  setMode(mode: string, arg = 0) {
    const r = this.r;
    r.mode = mode;
    r.modeArg = arg;
    r.target = -1;
    r.needs = true;
    if (!mode) { this.modebar.classList.add('hidden'); this.renderCard(); return; }
    const hints: Record<string, string> = {
      build: `Tap your land to build: ${BUILDINGS[arg]?.name}`,
      missile: 'Tap a target within range of your silos',
      nuke: `Tap a target for the ${NUKE_TIERS[arg === 1 ? 1 : 0].name}. Everyone will see the launch!`,
      bomb: 'Tap a target within bomber range',
      invade: 'Tap a coastal tile to invade by sea',
      ships: 'Tap water to move your fleet',
      ping: 'Tap the map to ping your allies',
      opstep: `Tap the map to add: ${OP_KIND_NAMES[arg] ?? ''} (${this.ops.currentName()})`,
      optarget: 'Tap the nation your operation is aimed at',
    };
    let extra = '';
    if (mode === 'ping') extra = PING_KINDS.map(([k, label, col], i) => `<button class="btn small ${i === arg ? 'on' : ''}" data-act="pingkind" data-i="${i}" style="color:${col}">${label}</button>`).join('');
    const done = mode === 'build' || mode === 'opstep';
    this.modebar.innerHTML = `<span>${hints[mode] ?? mode}</span>${extra}<button class="btn small hi" data-act="cancelmode">${done ? 'Done' : 'Cancel'}</button>`;
    this.modebar.classList.remove('hidden');
    if (window.innerWidth < 900 && this.open) this.toggle(null);
  }

  /** Map tap routed by main. */
  tap(t: number) {
    const w = this.w, r = this.r, net = this.app.net;
    if (r.cineOn) { r.endCinematic(); return; }
    if (t < 0) return;
    if (w.phase === 'spawn') {
      net.act('spawn', { tile: t });
      sfx.spawn();
      if (w.map.isLand(t)) r.burst(t, 26, 0, 1, [200, 200, 200], 4, 1.2, 0.6);
      return;
    }
    switch (r.mode) {
      case 'build': net.act('build', { tile: t, b: r.modeArg }); sfx.build(); return;
      case 'missile': case 'nuke': case 'bomb': case 'invade':
        r.target = t; r.needs = true; this.card.classList.remove('hidden'); this.renderCard(); sfx.click(); return;
      case 'ships': net.act('ships', { tile: t }); sfx.click(); this.setMode(''); return;
      case 'ping': net.act('ping', { tile: t, kind: PING_KINDS[r.modeArg][0] }); this.setMode(''); return;
      case 'opstep': this.ops.addStepAt(r.modeArg, t); return;
      case 'optarget': this.ops.pickTargetAt(t); return;
    }
    this.select(t === r.sel ? -1 : t);
  }

  // ---- quick menu (hold a pixel) ------------------------------------------------------------------------------
  /** Nearest tile (around `t`) where the building type can go, judged from what this client knows. */
  siteNear(t: number, type: number): number {
    const w = this.w, m = w.map, me = w.myId, def = BUILDINGS[type];
    const gap = Math.max(1, Math.round(BUILDING_SPACING * m.ms));
    // same spacing rule as the server: no building within `gap` tiles in any direction
    const clear = (u: number) => {
      const x0 = u % m.W, y0 = (u / m.W) | 0;
      for (let dy = -gap; dy <= gap; dy++) {
        const y = y0 + dy;
        if (y < 0 || y >= m.H) continue;
        for (let dx = -gap; dx <= gap; dx++) if (w.bldAt[m.idx(x0 + dx, y)] >= 0) return false;
      }
      return true;
    };
    let best = -1, bd = Infinity;
    m.forRadius(t, 9 * Math.max(1, m.ms), (u, d2) => {
      if (d2 >= bd || w.owner[u] !== me || !m.isLand(u) || w.fallout[u] || w.bldAt[u] >= 0) return;
      if (def.req === 'oil' && m.resource[u] !== RES.OIL) return;
      if (def.req === 'uranium' && m.resource[u] !== RES.URANIUM) return;
      if (def.req === 'coast' && !m.coastal[u]) return;
      if (clear(u)) { bd = d2; best = u; }
    });
    return best;
  }

  hold(t: number, x: number, y: number) {
    const w = this.w, m = w.map, me = this.me, net = this.app.net, r = this.r;
    if (t < 0 || !m || !me) return;
    if (w.phase === 'spawn' || r.mode) { this.tap(t); return; }
    if (w.phase !== 'running' || !me.alive) return;
    const o = w.owner[t];
    const items: QItem[] = [];
    let title: string, sub = '';
    const pctTxt = `${Math.round(this.pct * 100)}%`;
    if (o === w.myId && m.isLand(t)) {
      title = 'QUICK BUILD';
      const bid = w.bldAt[t], bld = bid >= 0 ? w.bld.get(bid) : undefined;
      if (bld && bld.owner === w.myId && bld.level < BUILDINGS[bld.type].maxLevel && !bld.done) {
        const c = buildCost(bld.type, bld.level);
        items.push({ id: 'up', label: `Upgrade ${BUILDINGS[bld.type].name}`, icon: BUILDING_GLYPH[bld.type], tone: 'hi', sub: `${shortCost(c, me)} ${buildTime(bld.type, bld.level)}s`, disabled: !affordable(c, me), why: 'Not enough resources to upgrade', act: () => { net.act('upgrade', { tile: t }); sfx.build(); } });
      }
      const quick: number[] = [B.CITY, B.FARM, B.FACTORY, B.BARRACKS, B.BUNKER, B.AIR_DEFENSE];
      if (m.resource[t] === RES.OIL || this.siteNear(t, B.OIL_WELL) >= 0) quick.push(B.OIL_WELL);
      else if (this.siteNear(t, B.URANIUM_MINE) >= 0) quick.push(B.URANIUM_MINE);
      else if (m.coastal[t]) quick.push(B.SHIPYARD);
      for (const type of quick) {
        if (items.length >= 7) break;
        const c = buildCost(type, 0, me.nb[type]);
        const site = this.siteNear(t, type);
        const slotless = BUILDINGS[type].slot && me.used >= me.slots;
        items.push({
          id: 'b' + type, label: BUILDINGS[type].name, icon: BUILDING_GLYPH[type], sub: shortCost(c, me),
          disabled: !affordable(c, me) || site < 0 || slotless,
          why: slotless ? 'No free building slots: build or upgrade cities' : site < 0 ? 'No free spot nearby' : 'Not enough resources',
          act: () => { net.act('build', { tile: site, b: type }); sfx.build(); },
        });
      }
      items.push({ id: 'more', label: 'More...', icon: 'build', act: () => { this.select(t); if (this.open !== 'build') this.toggle('build'); } });
    } else if (m.isWater(t)) {
      title = 'OPEN WATER';
      items.push({ id: 'fleet', label: 'Move fleet', icon: 'warship', disabled: !me.ships, why: 'You have no warships', act: () => net.act('ships', { tile: t }) });
      if (this.ops.active()) items.push({ id: 'opfleet', label: 'Op: fleet', icon: 'target', act: () => this.ops.addStepAt(6, t) });
      items.push({ id: 'ping', label: 'Ping', icon: 'ping', act: () => net.act('ping', { tile: t, kind: 'look' }) });
    } else {
      const p = w.P(o), r2 = w.rel[o];
      const friendly = !!o && (r2 === REL.ALLY || r2 === REL.NAP);
      title = o ? (p?.name ?? '?') : 'UNCLAIMED LAND';
      sub = o ? REL_NAMES[r2] + (p?.troops !== null && p?.troops !== undefined ? ` · ${fmt(p.troops)} troops` : '') : m.countryName(t);
      if (friendly) {
        items.push({ id: 'dip', label: 'Diplomacy', icon: 'diplo', act: () => this.openDiploWith(o) });
        if (r2 === REL.ALLY) items.push({ id: 'aid', label: 'Send 10% troops', icon: 'troops', act: () => net.act('donate', { p: o, troops: 0.1 }) });
        items.push({ id: 'ping', label: 'Ping', icon: 'ping', act: () => net.act('ping', { tile: t, kind: 'look' }) });
      } else {
        const attack = (pct: number) => () => { net.act('attack', { tile: t, pct }); sfx.attack(); r.addFx({ kind: 'ping', tile: t, r: 1, dur: 700, color: '#ff4d5e' }); };
        items.push({ id: 'atk', label: `${o ? 'Attack' : 'Expand'} ${pctTxt}`, icon: 'troops', tone: 'hi', act: attack(this.pct) });
        items.push({ id: 'atk100', label: o ? 'All-out 100%' : 'Expand 100%', icon: 'troops', iconColor: '#ff8080', act: attack(1) });
        if (m.coastal[t]) items.push({ id: 'inv', label: `Invade ${pctTxt}`, icon: 'transport', sub: `x${me.stock[U.TRANSPORT]}`, disabled: !me.stock[U.TRANSPORT], why: 'Build transports at a shipyard first', act: () => { net.act('invade', { tile: t, pct: this.pct }); sfx.launch(); } });
        if (o) {
          items.push({ id: 'msl', label: 'Missile', icon: 'missile', sub: `x${me.stock[U.MISSILE]}`, disabled: !me.stock[U.MISSILE], why: 'Build missiles at a Missile Silo', act: () => { net.act('missile', { tile: t }); sfx.launch(); } });
          items.push({ id: 'bomb', label: 'Bomber', icon: 'bomber', sub: `x${me.stock[U.BOMBER]}`, disabled: !me.stock[U.BOMBER], why: 'Build bombers at an Airbase', act: () => { net.act('bomb', { tile: t }); sfx.launch(); } });
          if (w.settings.nukes && (me.stock[U.NUKE] || me.stock[U.MEGA_NUKE] || me.nb[B.NUCLEAR_FACILITY])) {
            items.push({ id: 'nuke', label: 'M. Nuke', icon: 'nuke', iconColor: '#9dff3c', tone: 'red', confirm: true, sub: `x${me.stock[U.NUKE]}`, disabled: !me.stock[U.NUKE], why: 'No Medium Nuke ready', act: () => { net.act('nuke', { tile: t, tier: 0 }); sfx.launch(); } });
            items.push({ id: 'mega', label: 'Mega Nuke', icon: 'nuke', iconColor: '#ff4d5e', tone: 'red', confirm: true, sub: `x${me.stock[U.MEGA_NUKE]}`, disabled: !me.stock[U.MEGA_NUKE], why: 'No Mega Nuke ready (needs a Lv 2 Nuclear Facility)', act: () => { net.act('nuke', { tile: t, tier: 1 }); sfx.launch(); } });
          }
          const act = this.ops.active();
          if (act) items.push({ id: 'opstep', label: 'Add to op', icon: 'target', tone: 'green', sub: esc(act.name.replace('Operation ', '')).slice(0, 12), act: () => this.ops.addStepAt(0, t) });
          else items.push({ id: 'opnew', label: 'Plan op', icon: 'target', tone: 'green', act: () => this.ops.create(o) });
          items.push({ id: 'dip', label: 'Diplomacy', icon: 'diplo', act: () => this.openDiploWith(o) });
        }
      }
    }
    // keep the ring readable: at most 8 buttons, dropping the least important ones
    while (items.length > 8) {
      const drop = ['atk100', 'dip', 'bomb', 'ping'].find((id) => items.some((i) => i.id === id));
      if (!drop) break;
      items.splice(items.findIndex((i) => i.id === drop), 1);
    }
    this.qm.show(x, y, title, sub, items, true);
    this.r.hover = t;
    this.r.needs = true;
  }

  private openDiploWith(pid: number) {
    this.diploSearch = this.w.name(pid).toLowerCase();
    if (this.open !== 'diplo') this.toggle('diplo');
    this.mountDiploExtra();
    this.renderPanel(true);
  }
  quickAttack(t: number) {
    const w = this.w, net = this.app.net;
    if (t < 0 || !w.map) return;
    if (w.phase === 'spawn') { this.tap(t); return; }
    if (this.r.mode) { this.tap(t); return; }
    const m = w.map;
    if (m.isWater(t)) { if (this.me?.ships) { net.act('ships', { tile: t }); sfx.click(); } return; }
    const o = w.owner[t];
    if (o === w.myId) { this.select(t); return; }
    net.act('attack', { tile: t, pct: this.pct });
    sfx.attack();
    this.r.addFx({ kind: 'ping', tile: t, r: 1, dur: 700, color: '#ff4d5e' });
  }
  escape() {
    if (this.qm.isOpen) { this.qm.close(); return; }
    if (this.r.cineOn) { this.r.endCinematic(); return; }
    if (this.overlay) { this.closeOverlay(); return; }
    if (this.r.mode) { this.setMode(''); return; }
    if (this.open) { this.toggle(null); return; }
    this.select(-1);
  }
  key(k: string) {
    if (k === 'b') this.toggle('build');
    else if (k === 'r') this.toggle('army');
    else if (k === 'g') this.toggle('diplo');
    else if (k === 't' || k === 'enter') this.toggle('chat');
    else if (k === 'l') this.toggle('ranks');
    else if (k === 'o') this.toggle('ops');
    else if (k === 'h' || k === ' ') { const p = this.w.P(this.w.myId); if (p && p.capital >= 0) this.r.centerOn(p.capital); }
    else if (k === 'p') this.setMode('ping', 2);
    else if (/^[1-9]$/.test(k)) { const v = Number(k) * 10; this.pct = v / 100; this.pctLabel.textContent = v + '%'; const inp = this.bottom.querySelector<HTMLInputElement>('.troopctl input'); if (inp) inp.value = String(v); }
  }

  // ---- actions (event delegation) ------------------------------------------------------------------------------
  private onAct(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b || (b as HTMLButtonElement).disabled) return;
    const act = b.dataset.act!, net = this.app.net, r = this.r, w = this.w;
    const t = r.sel;
    const pid = Number(b.dataset.p ?? 0);
    sfx.click();
    if (act.startsWith('op') && this.ops.act(act, b)) { if (this.open === 'ops') setTimeout(() => this.renderPanel(), 60); return; }
    switch (act) {
      case 'bmode': {
        const type = Number(b.dataset.b);
        if (t >= 0 && w.owner[t] === w.myId && w.bldAt[t] < 0 && r.mode !== 'build') { net.act('build', { tile: t, b: type }); sfx.build(); }
        else this.setMode('build', type);
        this.renderPanel();
        break;
      }
      case 'openbuild': this.open !== 'build' && this.toggle('build'); break;
      case 'upgrade': net.act('upgrade', { tile: t }); sfx.build(); break;
      case 'demolish': net.act('demolish', { tile: t }); break;
      case 'attack': net.act('attack', { tile: t, pct: this.pct }); sfx.attack(); break;
      case 'invadehere': net.act('invade', { tile: t, pct: this.pct }); sfx.launch(); break;
      case 'shipshere': net.act('ships', { tile: t }); break;
      case 'target': this.setMode(b.dataset.m!, Number(b.dataset.a ?? 0)); r.target = t; this.renderCard(); break;
      case 'mode': this.setMode(b.dataset.m!, Number(b.dataset.a ?? 0)); break;
      case 'confirm': {
        const m = r.mode, tile = r.target;
        if (tile < 0) break;
        if (m === 'invade') net.act('invade', { tile, pct: this.pct });
        else if (m === 'nuke') net.act('nuke', { tile, tier: r.modeArg === 1 ? 1 : 0 });
        else net.act(m, { tile });
        sfx.launch();
        this.setMode('');
        break;
      }
      case 'cancelmode': this.setMode(''); break;
      case 'pingkind': this.setMode('ping', Number(b.dataset.i)); break;
      case 'closecard': this.select(-1); break;
      case 'diplowith': this.diploSearch = w.name(pid).toLowerCase(); this.open !== 'diplo' && this.toggle('diplo'); this.mountDiploExtra(); this.renderPanel(true); break;
      case 'cancel': net.act('cancel', { id: Number(b.dataset.id) }); break;
      case 'train': net.act('train', { u: Number(b.dataset.u), n: Number(b.dataset.n) }); sfx.build(); break;
      case 'untrain': net.act('untrain', { u: Number(b.dataset.u) }); break;
      case 'tech': net.act('tech', { w: b.dataset.w }); sfx.built(); break;
      case 'nap': net.act('propose', { p: pid, kind: 'nap' }); break;
      case 'ally': net.act('propose', { p: pid, kind: 'ally' }); break;
      case 'peace': net.act('propose', { p: pid, kind: 'peace' }); break;
      case 'war': net.act('war', { p: pid }); break;
      case 'break': if (confirm(`Betray ${w.name(pid)}? Everyone will remember it.`)) net.act('break', { p: pid }); break;
      case 'aidT': net.act('donate', { p: pid, troops: 0.1 }); break;
      case 'aidM': net.act('donate', { p: pid, money: 0.1 }); break;
      case 'respond': {
        net.act('respond', { p: pid, kind: b.dataset.k, yes: b.dataset.y === '1' });
        w.proposals = w.proposals.filter((x) => !(x.from === pid && x.kind === b.dataset.k));
        b.closest('.toast')?.remove();
        break;
      }
      case 'locate': { const p = w.P(pid); if (p && p.capital >= 0) { r.centerOn(p.capital); this.select(p.capital); } break; }
      case 'intercept': net.act('intercept', { id: Number(b.dataset.id) }); sfx.launch(); break;
      case 'view': if (b.dataset.id) this.watchNuke(Number(b.dataset.id)); else r.centerOn(Number(b.dataset.t)); break;
    }
    if (this.open && act !== 'bmode') setTimeout(() => this.renderPanel(), 120);
  }

  /** Cinematic: ride along with a warhead, then hold on the impact until the dust settles. */
  watchNuke(id: number) {
    const w = this.w, r = this.r, W = w.W;
    const n = w.nukes.get(id), f0 = w.flights.get(id);
    if (!n && !f0) return;
    const tile = n?.tile ?? f0!.to, tier = n?.tier ?? f0?.tier ?? 0;
    const R = NUKE_TIERS[tier].radius * w.map.ms;
    const zFly = tier ? 5 : 8, zImpact = clamp(Math.min(r.cw, r.ch) / (R * 4.2), r.minZoom(), 12);
    let impactAt = 0;
    this.cineNuke = id;
    if (this.open && window.innerWidth < 900) this.toggle(null);
    r.cinematic(() => {
      const fl = w.flights.get(id);
      if (fl) { const p = r.flightPos(fl, w.now()); return { x: p.x, y: p.y, z: zFly }; }
      if (!impactAt) impactAt = performance.now();
      if (performance.now() - impactAt > (tier ? 6000 : 4500)) {
        this.cineNuke = 0;
        setTimeout(() => r.endCinematic(), 0);
        return null;
      }
      return { x: (tile % W) + 0.5, y: ((tile / W) | 0) + 0.5, z: zImpact };
    }, `${NUKE_TIERS[tier].name.toUpperCase()} INBOUND`);
  }

  // ---- alerts & toasts ------------------------------------------------------------------------------------------
  private renderAlerts() {
    this.lastAlerts = performance.now();
    const w = this.w;
    if (!w.nukes.size) { if (this.alerts.childElementCount) { this.alerts.innerHTML = ''; this.alertSig = ''; } return; }
    const canIntercept = (this.me?.stock?.[U.MISSILE] ?? 0) > 0;
    const sig = [...w.nukes.keys()].join(',') + '|' + canIntercept;
    if (sig !== this.alertSig && !this.busy()) {
      this.alertSig = sig;
      let h = '';
      for (const n of w.nukes.values()) {
        const tgt = n.target === w.myId ? '<span class="hi-t">YOU</span>' : n.target ? esc(w.name(n.target)) : 'open land';
        const mine = n.o === w.myId;
        h += `<div class="alert ${n.tier ? 'mega' : ''}" data-nuke="${n.id}"><div class="t">${iconImg('nuke', n.tier ? '#ff4d5e' : '#9dff3c')} ${NUKE_TIERS[n.tier].name.toUpperCase()} by ${esc(w.name(n.o))} → ${tgt}</div>
          <div class="row"><span class="cd grow"></span>
          ${!mine && canIntercept ? `<button class="btn small hi" data-act="intercept" data-id="${n.id}">Intercept</button>` : ''}
          <button class="btn small" data-act="view" data-id="${n.id}" data-t="${n.tile}">View</button></div></div>`;
      }
      this.alerts.innerHTML = h;
    }
    // countdowns update in place so buttons stay tappable
    for (const box of this.alerts.querySelectorAll<HTMLElement>('[data-nuke]')) {
      const n = w.nukes.get(Number(box.dataset.nuke));
      const cd = box.querySelector('.cd');
      if (n && cd) cd.textContent = w.secondsLeft(n.t1).toFixed(1) + 's';
    }
  }

  toast(text: string, kind: 'info' | 'good' | 'bad' | 'warn' = 'info', tile = -1, key = '', ms = 4500, actions = '') {
    if (!this.toasts) return;
    if (key) {
      const last = this.toastKeys.get(key) ?? 0;
      if (performance.now() - last < 4000) return;
      this.toastKeys.set(key, performance.now());
    }
    const t = el('div', `toast pix ${kind}`, `<span>${text}</span>${actions ? `<span class="acts">${actions}</span>` : ''}`);
    t.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act]')) return this.onAct(e);
      if (tile >= 0) this.r.centerOn(tile);
      t.remove();
    });
    this.toasts.prepend(t);
    while (this.toasts.childElementCount > 5) this.toasts.lastElementChild!.remove();
    setTimeout(() => t.remove(), ms);
  }

  // ---- server events ------------------------------------------------------------------------------------------------
  onEvent(e: any) {
    const w = this.w, r = this.r, me = w.myId;
    const nm = (id: number) => esc(w.name(id));
    switch (e.e) {
      case 'err': this.toast(esc(e.msg), 'bad', -1, 'err:' + e.msg, 3000); sfx.error(); break;
      case 'built': sfx.built(); this.toast(`${BUILDINGS[e.type].name} ${e.level > 1 ? 'upgraded to Lv ' + e.level : 'complete'}`, 'good', e.tile, '', 2500); break;
      case 'atk': this.toast(`${nm(e.from)} is attacking you with ${fmt(e.troops)} troops!`, 'bad', -1, 'atk' + e.from); sfx.underAttack(); break;
      case 'warn': {
        const what = e.kind === 'missile' ? 'Incoming missile' : e.kind === 'bomber' ? 'Enemy bombers inbound' : 'Naval invasion incoming';
        this.toast(`${what} from ${nm(e.from)}!`, 'bad', e.tile, 'warn' + e.kind + e.from);
        sfx.underAttack();
        break;
      }
      case 'fl': if (e.f[1] === 0 || e.f[1] === 2) { if (w.visible(e.f[3]) || e.f[2] === me) sfx.launch(); } break;
      case 'nl': {
        sfx.siren();
        const T = NUKE_TIERS[e.tier ?? 0];
        this.toast(`${iconImg('nuke', e.tier ? '#ff4d5e' : '#9dff3c')} ${nm(e.o)} launched a ${T.name.toUpperCase()}${e.target ? ' at ' + nm(e.target) : ''}!`, 'bad', e.tile, '', 8000,
          `<button class="btn small" data-act="view" data-id="${e.id}" data-t="${e.tile}">View</button>`);
        break;
      }
      case 'hit':
        if (e.x) { r.addFx({ kind: 'intercept', tile: e.tile, r: 1, dur: 1400 }); if (e.k === 1 || w.visible(e.tile)) sfx.intercept(); }
        else { r.addFx({ kind: 'boom', tile: e.tile, r: e.r ?? 2, dur: 900 }); if (w.visible(e.tile)) sfx.explosion(); }
        break;
      case 'nuke': {
        const mega = e.tier === 1;
        r.addFx({ kind: 'nuke', tile: e.tile, r: e.r, dur: mega ? 7500 : 5200, big: mega });
        sfx.nuke(mega);
        navigator.vibrate?.(mega ? [180, 60, 260, 60, 400] : [120, 50, 220]);
        this.toast(`${mega ? 'MEGA ' : ''}NUCLEAR DETONATION by ${nm(e.by)}`, 'bad', e.tile, '', 6000);
        break;
      }
      case 'op': case 'opx': case 'opInvite': case 'opAns': case 'opStep': case 'opGo': case 'opMade':
        this.ops.onEvent(e);
        break;
      case 'ic': this.toast(e.ok ? `Warhead intercepted${e.by ? ' by ' + nm(e.by) : ''}!` : `Interception by ${nm(e.by)} FAILED`, e.ok ? 'good' : 'bad', -1, '', 3500); break;
      case 'elim': {
        const p = w.P(e.id);
        if (e.id === me) break;
        if (p?.human || e.by === me || w.rel[e.id]) this.toast(`${nm(e.id)} was eliminated${e.by ? ' by ' + nm(e.by) : ''}`, e.by === me ? 'good' : 'info', -1, '', 4000);
        break;
      }
      case 'news': if (e.a === me || e.b === me) { this.toast(esc(e.text), e.r === 1 || e.r === -1 ? 'bad' : 'good'); sfx.notify(); } else this.toast(esc(e.text), 'info', -1, '', 3500); break;
      case 'prop': {
        const kinds: Record<string, string> = { nap: 'a non-aggression pact', ally: 'an alliance', peace: 'peace' };
        this.toast(`${nm(e.from)} proposes ${kinds[e.kind]}`, 'warn', -1, '', 15000,
          `<button class="btn small green" data-act="respond" data-p="${e.from}" data-k="${e.kind}" data-y="1">Yes</button><button class="btn small red" data-act="respond" data-p="${e.from}" data-k="${e.kind}" data-y="0">No</button>`);
        sfx.notify();
        break;
      }
      case 'propAns': if (e.from === me) this.toast(`${nm(e.to)} ${e.yes ? 'accepted' : 'declined'} your ${e.kind === 'nap' ? 'pact' : e.kind === 'ally' ? 'alliance' : 'peace'} proposal`, e.yes ? 'good' : 'info'); break;
      case 'propSent': this.toast(`Proposal sent to ${nm(e.to)}`, 'info', -1, '', 2000); break;
      case 'aid': if (e.to === me) this.toast(`${nm(e.from)} sent you ${e.troops ? fmt(e.troops) + ' troops' : ''}${e.money ? ' $' + fmt(e.money) : ''}`, 'good'); break;
      case 'chat':
        if (e.from !== me && this.open !== 'chat') { this.unread++; sfx.chat(); }
        if (this.open === 'chat') this.renderChat();
        break;
      case 'ping': {
        const k = PING_KINDS.find((x) => x[0] === e.kind) ?? PING_KINDS[2];
        r.addFx({ kind: 'ping', tile: e.tile, r: 1, dur: 4000, color: k[2], text: w.name(e.from) });
        sfx.ping();
        if (e.from !== me) this.toast(`${nm(e.from)}: ${k[1]}`, 'warn', e.tile, '', 4000);
        break;
      }
      case 'land': r.addFx({ kind: 'land', tile: e.tile, r: 1, dur: 800 }); if (e.by !== me) this.toast(`${nm(e.by)} landed troops on your coast!`, 'bad', e.tile, 'land' + e.by); break;
      case 'sunk': r.addFx({ kind: 'sink', tile: e.tile, r: 1, dur: 900 }); sfx.splash(); break;
      case 'caplost': this.toast('Your capital has fallen! The government relocated.', 'bad', e.now, '', 6000); sfx.underAttack(); break;
      case 'rebel': if (e.from === me) this.toast('Rebellion! Unhappy provinces declared independence.', 'bad', e.tile, '', 6000); break;
      case 'winter': if (w.settings.nuclearWinter && e.v > 3) this.toast(`Nuclear winter deepens: world food output -${Math.min(60, (e.v - 3) * 10)}%`, 'warn', -1, 'winter'); break;
      case 'unit': this.toast(`${UNITS[e.u].name} ready`, 'good', -1, 'unit' + e.u, 2000); break;
      case 'phase':
        if (e.phase === 'running') {
          const p = w.P(me);
          if (p && p.capital >= 0) { r.intro(p.capital, p.color); sfx.founded(); }
          setTimeout(() => this.flashBanner('THE WAR BEGINS', w.peaceUntil > w.tick ? `Peace time: ${Math.round(w.secondsLeft(w.peaceUntil))}s. Expand into unclaimed land!` : 'Expand and conquer!'), p && p.capital >= 0 ? 1600 : 0);
        }
        break;
      case 'end': this.showEnd(e); break;
      case 'pl': case 'roster': r.refreshPlayers(); break;
    }
  }

  // ---- overlays ----------------------------------------------------------------------------------------------------
  private showOverlay(html: string) {
    this.closeOverlay();
    const o = el('div', 'overlay');
    o.innerHTML = `<div class="box pix">${html}</div>`;
    o.addEventListener('click', (e) => {
      if (e.target === o) this.closeOverlay();
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-o]');
      if (!b) return;
      sfx.click();
      this.app.overlayAction(b.dataset.o!);
    });
    this.root.append(o);
    this.overlay = o;
  }
  closeOverlay() { this.overlay?.remove(); this.overlay = null; }

  showMenu() {
    this.showOverlay(`<h2>MENU</h2>
      <button class="btn big green" data-o="invite">Invite friends</button>
      <button class="btn big" data-o="sound">Sound: ${sfx.muted ? 'OFF' : 'ON'}</button>
      <button class="btn big" data-o="labels">Nation names: ${this.r.showLabels ? 'ON' : 'OFF'}</button>
      <button class="btn big" data-o="fullscreen">Fullscreen</button>
      <button class="btn big" data-o="help">How to play</button>
      ${this.me?.alive && this.w.phase === 'running' ? '<button class="btn big red" data-o="surrender">Surrender</button>' : ''}
      <button class="btn big red" data-o="leave">Leave match</button>
      <button class="btn big hi" data-o="close">Back to game</button>`);
  }
  showInvite() {
    const code = String(this.app.lobbyInfo?.code ?? '');
    this.showOverlay(`<h2>INVITE FRIENDS</h2>
      <div class="row"><span class="muted grow" style="font-size:8px">ROOM CODE</span><span class="roomcode">${esc(code)}</span></div>
      <div data-invite></div>
      <div class="muted" style="font-size:8px">Friends who join now start as a new nation in a free spot.</div>
      <button class="btn big hi" data-o="close">Back to game</button>`);
    const box = this.overlay?.querySelector<HTMLElement>('[data-invite]');
    if (box) mountInvite(box, code || null);
  }
  showHelp() {
    this.showOverlay(`<h2>HOW TO PLAY</h2><div class="help">
      <b>Goal:</b> control ${this.w.settings?.winPercent ?? 70}% of the world's land, be the last human nation (or alliance) standing, or have the top score when time runs out.<br><br>
      <b>Hold any pixel</b> to open the quick menu. On your land: Quick Build (placed on the nearest free spot). On other land: attack, invade, missile, bomber, nukes, add to an operation, diplomacy.<br>
      <b>Expand & attack:</b> set the SEND TROOPS slider, then <b>double-tap</b> any land next to you (right-click on desktop). Troops advance as a wave. Mountains and forests are slower and harder to take, bunkers make it much harder.<br>
      <b>Tap</b> a tile to inspect it. <b>Pinch/scroll</b> to zoom, drag to pan.<br><br>
      <b>Economy:</b> Farms feed your people (starvation = revolt), Cities raise population, money and building slots, Factories give production. Oil and Uranium need wells/mines on deposits (black and green dots). Every extra copy of a building costs more, while upgrading one takes half the time of building new.<br>
      <b>Army:</b> Mobilization sets how many people serve. Barracks recruit faster. Tanks don't cost population and crush open terrain.<br>
      <b>Navy:</b> Shipyards build warships and transports. Use transports to invade overseas.<br>
      <b>Strategic:</b> Silos launch missiles, Air Defense shoots them down. Nuclear Facilities build Medium Nukes; at Lv 2 they build Mega Nukes that erase whole regions. Every launch is broadcast to the world with a 15-20s window to intercept, press VIEW to ride along with the warhead.<br><br>
      <b>Operations (OPS):</b> plan several attacks and strikes against one nation, fire them all at once or in a timed sequence, and invite allies to add their own forces.<br>
      <b>Diplomacy:</b> pacts (5 min), alliances (shared vision, shared victory), aid, and... betrayal.<br><br>
      <b>Keys:</b> WASD/arrows pan · +/- zoom · 1-9 troop % · B build · R army · O operations · G diplomacy · T chat · L ranks · H home · P ping · Esc cancel
      </div><button class="btn big hi" data-o="close">Got it</button>`);
  }

  showEnd(e: { ids: number[]; reason: string; stats: any[] }) {
    if (this.endShown) return;
    this.endShown = true;
    const w = this.w, me = w.myId;
    const won = e.ids.includes(me);
    if (won) sfx.victory(); else sfx.defeat();
    const rows = (e.stats ?? []).map((s: any) => `<tr><td>${this.pname(s.id)}${e.ids.includes(s.id) ? ' ' + iconImg('crown', '#ffd23f') : ''}</td><td>${fmt(s.score)}</td><td>${((s.tiles / w.map.landCount) * 100).toFixed(1)}%</td><td>${s.kills}</td><td>${s.nukes}</td></tr>`).join('');
    this.showOverlay(`<h2 class="endtitle">${won ? 'VICTORY' : 'GAME OVER'}</h2>
      <div style="text-align:center" class="hi-t">${esc(e.reason)}</div>
      <div style="text-align:center">Winner: ${e.ids.map((id) => this.pname(id)).join(', ') || '-'}</div>
      ${rows ? `<table class="stats"><tr><th>Nation</th><th>Score</th><th>Land</th><th>Kills</th><th>Nukes</th></tr>${rows}</table>` : ''}
      <button class="btn big hi" data-o="lobby">Back to lobby</button>
      <button class="btn big" data-o="close">Look at the map</button>`);
  }
}
