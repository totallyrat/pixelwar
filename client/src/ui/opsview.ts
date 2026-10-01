// Operations panel: plan multi-step strikes, time them (all at once or in sequence), bring allies in,
// and launch them from an H-hour countdown.

import { OPS, TICK_RATE, U } from '../../../shared/balance.ts';
import { REL } from '../../../shared/protocol.ts';
import type { Hud } from './hud.ts';
import type { OpC } from '../world.ts';
import { icon, iconImg, cssColor } from '../render/sprites.ts';
import { OP_KIND_GLYPH } from '../render/renderer.ts';
import { esc, fmt } from '../util.ts';
import { sfx } from '../audio.ts';

export const OP_KINDS = ['attack', 'invade', 'missile', 'bomb', 'nuke', 'mega', 'fleet'];
export const OP_KIND_NAMES = ['Land attack', 'Naval invasion', 'Missile strike', 'Bomber strike', 'Medium Nuke', 'Mega Nuke', 'Fleet move'];
const KIND_LABEL: Record<string, string> = Object.fromEntries(OP_KINDS.map((k, i) => [k, OP_KIND_NAMES[i]]));
const STATUS: Record<string, [string, string]> = {
  planning: ['PLANNING', ''], countdown: ['COUNTDOWN', 'nap'], running: ['IN PROGRESS', 'war'], done: ['COMPLETE', 'ally'], cancelled: ['CANCELLED', ''],
};

export class OpsView {
  private hud: Hud;
  view = 0;
  private picking = false;
  private openOnMade = false;
  private timing = new Map<number, { mode: 'sync' | 'seq'; gap: number }>();
  private cd = 10;
  private neigh = new Map<number, number>();
  private neighAt = 0;

  constructor(hud: Hud) { this.hud = hud; }
  private get w() { return this.hud.app.world; }
  private get net() { return this.hud.app.net; }
  private get me() { return this.w.myId; }

  private isIn(op: OpC, pid = this.me) {
    return op.owner === pid || op.members.some((m) => m.pid === pid && m.status === 'joined');
  }
  private editable(op: OpC) { return op.status === 'planning' || op.status === 'countdown'; }
  private tm(op: OpC) {
    let t = this.timing.get(op.id);
    if (!t) { t = { mode: op.steps.some((s) => s.delay > 0) ? 'seq' : 'sync', gap: OPS.defaultGap }; this.timing.set(op.id, t); }
    return t;
  }

  pendingInvites(): number {
    let n = 0;
    for (const op of this.w.ops.values()) if (op.members.some((m) => m.pid === this.me && m.status === 'invited') && this.editable(op)) n++;
    return n;
  }
  /** The operation that new steps go into: the one on screen, else the latest one you can still edit. */
  active(): OpC | null {
    const v = this.view ? this.w.ops.get(this.view) : undefined;
    if (v && this.isIn(v) && this.editable(v)) return v;
    let best: OpC | null = null;
    for (const op of this.w.ops.values()) if (this.isIn(op) && this.editable(op) && (!best || op.created > best.created)) best = op;
    return best;
  }
  currentName() { return this.active()?.name ?? 'new operation'; }

  create(target: number) {
    this.openOnMade = true;
    this.net.act('opNew', { p: target });
    sfx.click();
  }

  addStepAt(kindIdx: number, tile: number) {
    const op = this.active();
    if (!op) { this.hud.toast('Plan an operation first (OPS panel).', 'bad', -1, 'noop'); sfx.error(); return; }
    const kind = OP_KINDS[kindIdx] ?? 'attack';
    const t = this.tm(op);
    const delay = t.mode === 'seq' && op.steps.length ? Math.max(...op.steps.map((s) => s.delay)) + t.gap : 0;
    this.net.act('opStep', { op: op.id, kind, tile, pct: this.hud.pct, delay });
    this.hud.app.renderer.burst(tile, 10, 1, 2, [120, 255, 140], 2, 0.6);
    sfx.build();
    if (this.hud.open !== 'ops' && !this.hud.app.renderer.mode) this.hud.toast(`${KIND_LABEL[kind]} added to ${esc(op.name)}${delay ? ` at +${delay}s` : ''}`, 'good', tile, '', 2200);
  }

  pickTargetAt(tile: number) {
    const o = this.w.owner[tile];
    if (!o || o === this.me) { this.hud.toast('Tap land owned by another nation', 'bad', -1, 'optgt'); sfx.error(); return; }
    this.hud.setMode('');
    this.create(o);
  }

  // ---- rendering --------------------------------------------------------------------------------
  html(): string {
    if (this.picking) return this.pickerHtml();
    const op = this.view ? this.w.ops.get(this.view) : undefined;
    if (op) return this.detailHtml(op);
    this.view = 0;
    return this.listHtml();
  }

  private statusTag(op: OpC) {
    const [label, cls] = STATUS[op.status] ?? [op.status, ''];
    let extra = '';
    if (op.status === 'countdown') extra = ' ' + Math.ceil(this.w.secondsLeft(op.launchAt)) + 's';
    return `<span class="tag ${cls}">${label}${extra}</span>`;
  }

  private listHtml(): string {
    const w = this.w, me = this.me;
    const ops = [...w.ops.values()].sort((a, b) => b.created - a.created);
    const invites = ops.filter((o) => o.members.some((m) => m.pid === me && m.status === 'invited') && this.editable(o));
    const mine = ops.filter((o) => this.isIn(o));
    let h = `<button class="btn big hi" data-act="opNew">${iconImg('target')} New operation</button>
      <div class="muted" style="font-size:7px">Chain land attacks, invasions, missile, bomber and nuclear strikes. Fire them all at once or one after another, and bring allies along.</div>`;
    if (invites.length) {
      h += '<div class="section">INVITATIONS</div>';
      for (const op of invites) {
        h += `<div class="drow"><span class="nm">${esc(op.name)}</span><span class="muted" style="font-size:7px">by ${esc(w.name(op.owner))} vs ${esc(w.name(op.target))} ${op.status === 'countdown' ? '· H-hour in ' + Math.ceil(w.secondsLeft(op.launchAt)) + 's' : ''}</span>
          <div class="btns"><button class="btn small green" data-act="opJoin" data-op="${op.id}">Join</button><button class="btn small red" data-act="opDecline" data-op="${op.id}">Decline</button><button class="btn small" data-act="opOpen" data-op="${op.id}">View</button></div></div>`;
      }
    }
    h += `<div class="section">OPERATIONS (${mine.length})</div>`;
    if (!mine.length) h += '<div class="muted">No operations yet.</div>';
    for (const op of mine) {
      h += `<div class="drow" data-act="opOpen" data-op="${op.id}" style="cursor:pointer"><span class="nm">${esc(op.name)}</span>${this.statusTag(op)}
        <span class="muted" style="font-size:7px">vs ${esc(w.name(op.target))} · ${op.steps.length} steps${op.members.some((m) => m.status === 'joined') ? ' · allied' : ''}</span></div>`;
    }
    return h;
  }

  private pickerHtml(): string {
    const w = this.w;
    const now = performance.now();
    if (now - this.neighAt > 3000) { this.neigh = w.neighbours(this.me); this.neighAt = now; }
    const cands = w.players.filter((p) => p && p.alive && p.id !== this.me && w.rel[p.id] !== REL.ALLY)
      .map((p) => ({ p, score: (w.rel[p.id] === REL.WAR ? 1e7 : 0) + (this.neigh.get(p.id) ?? 0) * 1e3 + (p.human ? 5e5 : 0) + w.tileCount[p.id] / 1e3 }))
      .sort((a, b) => b.score - a.score).slice(0, 24);
    let h = `<div class="row"><button class="btn small" data-act="opBack">${iconImg('close')} Back</button><span class="grow muted">Choose the target nation</span></div>
      <button class="btn big" data-act="opPickMap">${iconImg('target')} Pick on the map</button><div class="section">ENEMIES & NEIGHBOURS</div>`;
    for (const { p } of cands) {
      h += `<div class="drow" data-act="opTarget" data-p="${p.id}" style="cursor:pointer"><span class="nm">${this.hud.pname(p.id)}</span>${this.hud.relTag(p.id)}
        <span class="muted" style="font-size:7px">${((w.tileCount[p.id] / w.map.landCount) * 100).toFixed(1)}%${this.neigh.has(p.id) ? ' · border' : ''}</span></div>`;
    }
    return h;
  }

  private detailHtml(op: OpC): string {
    const w = this.w, me = this.me, hud = this.hud;
    const owner = op.owner === me, inOp = this.isIn(op), ed = this.editable(op);
    const invited = op.members.find((m) => m.pid === me && m.status === 'invited');
    const t = this.tm(op);
    let h = `<div class="row"><button class="btn small" data-act="opBack">${iconImg('close')} All ops</button><span class="grow"></span>${this.statusTag(op)}</div>
      <div class="opname">${esc(op.name)}</div>
      <div class="muted" style="font-size:8px">Target: ${hud.pname(op.target)} ${op.target ? hud.relTag(op.target) : ''}<br>Planner: ${hud.pname(op.owner)}</div>`;
    if (invited && ed) h += `<div class="row"><button class="btn green grow" data-act="opJoin" data-op="${op.id}">Join operation</button><button class="btn red" data-act="opDecline" data-op="${op.id}">Decline</button></div>`;
    // forces
    h += '<div class="section">FORCES</div><div class="chips">';
    h += `<span class="opchip">${hud.pname(op.owner)} <span class="tag you">LEAD</span></span>`;
    for (const m of op.members) if (m.status !== 'declined') h += `<span class="opchip">${hud.pname(m.pid)} <span class="tag ${m.status === 'joined' ? 'ally' : ''}">${m.status.toUpperCase()}</span></span>`;
    h += '</div>';
    if (owner && ed) {
      const allies = w.players.filter((p) => p && p.alive && w.rel[p.id] === REL.ALLY && p.id !== op.target && !op.members.some((m) => m.pid === p.id && m.status !== 'declined'));
      if (allies.length) h += `<div class="chips">${allies.slice(0, 8).map((p) => `<button class="btn small" data-act="opInvite" data-p="${p.id}">+ Invite ${esc(p.name).slice(0, 16)}</button>`).join('')}</div>`;
      else h += '<div class="muted" style="font-size:7px">Form alliances (Diplomacy) to invite partners into your operations.</div>';
    } else if (inOp && !owner && ed) h += `<button class="btn small red" data-act="opLeave">Pull out of the operation</button>`;
    // timing
    if (owner && ed) {
      h += `<div class="section">TIMING</div><div class="chips">
        <button class="btn small ${t.mode === 'sync' ? 'on' : ''}" data-act="opMode" data-m="sync">All at once</button>
        <button class="btn small ${t.mode === 'seq' ? 'on' : ''}" data-act="opMode" data-m="seq">In sequence</button>
        ${t.mode === 'seq' ? [2, 5, 10, 20].map((g) => `<button class="btn small ${t.gap === g ? 'on' : ''}" data-act="opGap" data-g="${g}">${g}s apart</button>`).join('') : ''}</div>`;
    }
    // timeline
    const ordered = op.steps.slice().sort((a, b) => a.delay - b.delay || a.id - b.id);
    const maxT = Math.max(10, ...ordered.map((s) => s.delay));
    const elapsed = op.status === 'running' || op.status === 'done' ? Math.max(0, (w.now() - op.launchAt) / TICK_RATE) : -1;
    h += `<div class="optl"><div class="optl-bar"></div>${ordered.map((s, i) => {
      const p = w.P(s.by);
      return `<span class="optl-m ${s.state}" style="left:${(s.delay / maxT) * 100}%;background:${p ? cssColor(p.color) : '#fff'}">${i + 1}</span>`;
    }).join('')}${elapsed >= 0 && op.status === 'running' ? `<span class="optl-now" style="left:${Math.min(100, (elapsed / maxT) * 100)}%"></span>` : ''}
      <span class="optl-l">H</span><span class="optl-r">+${maxT}s</span></div>`;
    // steps
    h += `<div class="section">STEPS (${op.steps.length}/${OPS.maxSteps})</div>`;
    if (!ordered.length) h += '<div class="muted" style="font-size:7px">No steps yet. Pick an action below, then tap its target on the map. Tip: hold a pixel on the map and choose "Add to op".</div>';
    if (ed && ordered.some((s) => s.by === me && s.kind === 'attack') && performance.now() - this.neighAt > 3000) {
      this.neigh = w.neighbours(me);
      this.neighAt = performance.now();
    }
    ordered.forEach((s, i) => {
      const p = w.P(s.by), canEdit = ed && (s.by === me || owner);
      const where = w.owner[s.tile] ? w.name(w.owner[s.tile]) : w.map.countryName(s.tile);
      const state = s.state === 'done' ? '<span class="good">DONE</span>' : s.state === 'failed' ? '<span class="bad">FAILED</span>' : '';
      const noBorder = ed && s.state === 'planned' && s.by === me && s.kind === 'attack' && w.owner[s.tile] && !this.neigh.has(w.owner[s.tile]);
      h += `<div class="opstep ${s.state}"><span class="opnum" style="background:${p ? cssColor(p.color) : '#fff'}">${i + 1}</span>
        <img class="ico big" src="${icon(OP_KIND_GLYPH[s.kind] ?? 'target', s.kind === 'mega' ? '#ff4d5e' : s.kind === 'nuke' ? '#9dff3c' : '#fff')}" alt="">
        <div class="grow"><div class="nm">${KIND_LABEL[s.kind]} ${state}</div>
          <div class="sub">${esc(where)} · by ${esc(p?.name ?? '?')}${s.kind === 'attack' || s.kind === 'invade' ? ` · ${Math.round(s.pct * 100)}% troops` : ''}</div>
          ${s.note ? `<div class="sub bad">${esc(s.note)}</div>` : ''}
          ${noBorder ? '<div class="sub hi-t">No land border with them yet: expand toward them or use a naval invasion.</div>' : ''}</div>
        <div class="opctl">
          ${canEdit ? `<button class="btn small" data-act="opDelay" data-s="${s.id}" data-d="-5">-5</button><button class="btn small" data-act="opDelay" data-s="${s.id}" data-d="-1">-1</button>` : ''}
          <b class="hi-t">T+${s.delay}s</b>
          ${canEdit ? `<button class="btn small" data-act="opDelay" data-s="${s.id}" data-d="1">+1</button><button class="btn small" data-act="opDelay" data-s="${s.id}" data-d="5">+5</button>` : ''}
          ${canEdit && (s.kind === 'attack' || s.kind === 'invade') ? `<button class="btn small" data-act="opPct" data-s="${s.id}" data-d="-0.1">-%</button><button class="btn small" data-act="opPct" data-s="${s.id}" data-d="0.1">+%</button>` : ''}
          <button class="btn small" data-act="opLocate" data-t="${s.tile}">${iconImg('target')}</button>
          ${canEdit ? `<button class="btn small red" data-act="opDel" data-s="${s.id}">${iconImg('close')}</button>` : ''}
        </div></div>`;
    });
    // add steps
    if (inOp && ed) {
      const st = hud.app.world.me?.stock ?? [];
      const have = [null, st[U.TRANSPORT], st[U.MISSILE], st[U.BOMBER], st[U.NUKE], st[U.MEGA_NUKE], hud.app.world.me?.ships];
      h += `<div class="section">ADD A STEP · then tap the target</div><div class="opadd">${OP_KINDS.map((k, i) => {
        if ((k === 'nuke' || k === 'mega') && !w.settings.nukes) return '';
        return `<button class="btn small ${k === 'nuke' || k === 'mega' ? 'red' : ''}" data-act="opAdd" data-k="${i}">${iconImg(OP_KIND_GLYPH[k], k === 'mega' ? '#ff4d5e' : k === 'nuke' ? '#9dff3c' : '#fff')} ${OP_KIND_NAMES[i]}${have[i] !== null && have[i] !== undefined ? ` <span class="muted">x${fmt(have[i])}</span>` : ''}</button>`;
      }).join('')}</div>`;
    }
    // launch controls
    if (owner && op.status === 'planning') {
      h += `<div class="section">LAUNCH</div><div class="chips">${[0, 10, 30, 60].map((c) => `<button class="btn small ${this.cd === c ? 'on' : ''}" data-act="opCd" data-c="${c}">${c ? `H-hour in ${c}s` : 'Launch now'}</button>`).join('')}</div>
        <div class="row"><button class="btn hi grow" data-act="opLaunch" ${op.steps.length ? '' : 'disabled'}>${iconImg('target')} Launch operation</button><button class="btn red" data-act="opCancel">Scrap</button></div>
        <div class="muted" style="font-size:7px">Steps are carried out by whoever added them, using their own troops and weapons. Allies can keep adding steps during the countdown.</div>`;
    } else if (op.status === 'countdown') {
      h += `<div class="ophour">H-HOUR IN ${Math.ceil(w.secondsLeft(op.launchAt))}s</div>${owner ? '<button class="btn red" data-act="opCancel">Abort operation</button>' : ''}`;
    } else if (op.status === 'running') {
      h += `<div class="ophour">IN PROGRESS · T+${Math.floor(elapsed)}s</div>`;
    } else if (op.status === 'done') {
      const ok = op.steps.filter((s) => s.state === 'done').length;
      h += `<div class="ophour ${ok === op.steps.length ? 'good' : ''}">${ok}/${op.steps.length} STEPS SUCCEEDED</div>`;
    }
    return h;
  }

  // ---- actions ------------------------------------------------------------------------------------
  act(act: string, b: HTMLElement): boolean {
    const net = this.net, hud = this.hud;
    const op = this.view ? this.w.ops.get(this.view) : undefined;
    const opId = Number(b.dataset.op ?? op?.id ?? 0);
    const step = op?.steps.find((s) => s.id === Number(b.dataset.s));
    switch (act) {
      case 'opNew': this.picking = true; break;
      case 'opBack': this.picking = false; this.view = 0; break;
      case 'opOpen': this.view = opId; this.picking = false; if (hud.open !== 'ops') hud.toggle('ops'); break;
      case 'opPickMap': hud.setMode('optarget'); break;
      case 'opTarget': this.create(Number(b.dataset.p)); break;
      case 'opJoin': net.act('opAnswer', { op: opId, yes: true }); this.view = opId; b.closest('.toast')?.remove(); sfx.notify(); break;
      case 'opDecline': net.act('opAnswer', { op: opId, yes: false }); b.closest('.toast')?.remove(); if (this.view === opId) this.view = 0; break;
      case 'opLeave': if (confirm('Pull out of this operation?')) { net.act('opLeave', { op: opId }); this.view = 0; } break;
      case 'opInvite': net.act('opInvite', { op: opId, p: Number(b.dataset.p) }); break;
      case 'opMode': case 'opGap': {
        if (!op) break;
        const t = this.tm(op);
        if (act === 'opMode') t.mode = b.dataset.m === 'seq' ? 'seq' : 'sync';
        else t.gap = Number(b.dataset.g) || OPS.defaultGap;
        net.act('opTime', { op: op.id, mode: t.mode, gap: t.gap });
        break;
      }
      case 'opAdd': {
        if (!op) break;
        this.view = op.id;
        hud.setMode('opstep', Number(b.dataset.k));
        break;
      }
      case 'opDelay': if (op && step) net.act('opEdit', { op: op.id, step: step.id, delay: Math.max(0, step.delay + Number(b.dataset.d)) }); break;
      case 'opPct': if (op && step) net.act('opEdit', { op: op.id, step: step.id, pct: Math.max(0.05, Math.min(1, step.pct + Number(b.dataset.d))) }); break;
      case 'opDel': if (op && step) net.act('opDel', { op: op.id, step: step.id }); break;
      case 'opLocate': hud.app.renderer.flyTo(Number(b.dataset.t), Math.max(hud.app.renderer.cam.z, 5), 700); break;
      case 'opCd': this.cd = Number(b.dataset.c); break;
      case 'opLaunch': if (op) { net.act('opLaunch', { op: op.id, cd: this.cd }); sfx.underAttack(); } break;
      case 'opCancel': if (op && confirm(`Cancel ${op.name}?`)) net.act('opCancel', { op: op.id }); break;
      default: return false;
    }
    return true;
  }

  onEvent(e: any) {
    const w = this.w, hud = this.hud, me = this.me;
    const nm = (id: number) => esc(w.name(id));
    switch (e.e) {
      case 'opMade':
        this.picking = false;
        this.view = e.id;
        if (this.openOnMade && hud.open !== 'ops') hud.toggle('ops');
        this.openOnMade = false;
        sfx.notify();
        break;
      case 'opx': if (this.view === e.id) this.view = 0; break;
      case 'opInvite':
        hud.toast(`${nm(e.from)} invites you to <b>${esc(e.name)}</b> against ${nm(e.target)}`, 'warn', -1, '', 20000,
          `<button class="btn small green" data-act="opJoin" data-op="${e.op}">Join</button><button class="btn small" data-act="opOpen" data-op="${e.op}">View</button><button class="btn small red" data-act="opDecline" data-op="${e.op}">No</button>`);
        sfx.notify();
        break;
      case 'opAns': hud.toast(`${nm(e.from)} ${e.yes ? 'joined' : 'declined'} your operation`, e.yes ? 'good' : 'info'); break;
      case 'opGo': {
        const op = w.ops.get(e.op);
        if (e.started) { hud.flashBanner(e.name.toUpperCase(), 'H-HOUR: THE OPERATION HAS BEGUN', 2600); sfx.underAttack(); }
        else if (op && op.owner !== me) hud.toast(`${esc(e.name)}: H-hour in ${Math.ceil(w.secondsLeft(e.h))}s`, 'warn', -1, '', 5000);
        else hud.toast(`${esc(e.name)} launched. H-hour in ${Math.ceil(w.secondsLeft(e.h))}s`, 'good', -1, '', 3000);
        break;
      }
      case 'opStep': {
        const op = w.ops.get(e.op);
        if (e.by !== me && op?.owner !== me) break;
        if (e.ok) hud.toast(`${esc(e.name)}: ${KIND_LABEL[e.kind]}${e.by !== me ? ' by ' + nm(e.by) : ''} underway`, 'good', e.tile, '', 2500);
        else hud.toast(`${esc(e.name)}: ${KIND_LABEL[e.kind]}${e.by !== me ? ' by ' + nm(e.by) : ''} failed. ${esc(e.note)}`, 'bad', e.tile, '', 4500);
        break;
      }
    }
  }
}
