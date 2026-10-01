// Title screen and room lobby.

import { HUMAN_COLORS, MAP_SIZES } from '../../../shared/balance.ts';
import { DEFAULT_SETTINGS, type MatchSettings } from '../../../shared/protocol.ts';
import type { App } from '../main.ts';
import { cssColor, iconImg } from '../render/sprites.ts';
import { esc, el } from '../util.ts';
import { sfx } from '../audio.ts';
import { store } from '../net.ts';
import { desktop } from '../desktop.ts';
import { mountInvite } from './invite.ts';

export class Lobby {
  private app: App;
  private root: HTMLElement;
  constructor(app: App) {
    this.app = app;
    this.root = document.getElementById('ui')!;
  }

  showTitle(msg = '') {
    const a = this.app;
    const code = new URLSearchParams(location.search).get('room') ?? '';
    this.root.innerHTML = '';
    const s = el('div', 'screen');
    s.innerHTML = `<h1 class="logo">PIXEL<br>WAR</h1>
      <div class="subtitle">Conquer the real world, pixel by pixel.</div>
      <div class="titlerow"><div class="titlebox pix">
        <label>COMMANDER NAME</label>
        <input id="nm" maxlength="20" value="${esc(a.name)}" autocomplete="off" spellcheck="false">
        <label>NATION COLOUR</label>
        <div class="swatches">${HUMAN_COLORS.map((c) => `<button data-c="${c}" class="${c === a.color ? 'sel' : ''}" style="background:${cssColor(c)}" aria-label="colour"></button>`).join('')}</div>
        <button class="btn big hi" data-a="solo">${iconImg('troops')} Quick solo vs AI</button>
        <button class="btn big" data-a="create">${iconImg('pop')} Create room for friends</button>
        <div class="row"><input id="code" class="codeinput grow" maxlength="5" placeholder="CODE" value="${esc(code)}" autocomplete="off"><button class="btn" data-a="join">Join room</button></div>
        <div class="muted" id="status" style="font-size:8px;text-align:center">${esc(msg || (a.net.status === 'open' ? '' : 'Connecting to server...'))}</div>
      </div>
      ${desktop ? '<div class="titlebox hostbox pix"><label>HOST FROM THIS COMPUTER</label><div data-invite></div></div>' : ''}</div>
      <div class="foot">Map data © Natural Earth · Best in landscape on a tablet · <a href="#" data-a="help" style="color:inherit">How to play</a></div>`;
    this.root.append(s);
    const inv = s.querySelector<HTMLElement>('[data-invite]');
    if (inv) mountInvite(inv, null);
    const nm = s.querySelector<HTMLInputElement>('#nm')!;
    nm.addEventListener('change', () => { a.name = nm.value.trim().slice(0, 20) || 'Commander'; store.set('name', a.name); });
    s.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const sw = t.closest<HTMLElement>('[data-c]');
      if (sw) {
        a.color = Number(sw.dataset.c);
        store.set('color', String(a.color));
        s.querySelectorAll('.swatches button').forEach((b) => b.classList.toggle('sel', b === sw));
        sfx.click();
        return;
      }
      const b = t.closest<HTMLElement>('[data-a]');
      if (!b) return;
      e.preventDefault();
      sfx.unlock();
      sfx.click();
      a.name = nm.value.trim().slice(0, 20) || 'Commander';
      store.set('name', a.name);
      const who = { name: a.name, color: a.color };
      switch (b.dataset.a) {
        case 'solo': a.net.send({ t: 'create', ...who, settings: { ...DEFAULT_SETTINGS, aiCount: 150, spawnSeconds: 20 }, startNow: true }); this.status('Starting match...'); break;
        case 'create': a.net.send({ t: 'create', ...who }); this.status('Creating room...'); break;
        case 'join': {
          const c = s.querySelector<HTMLInputElement>('#code')!.value.trim().toUpperCase();
          if (c.length < 4) { this.status('Enter a room code'); sfx.error(); return; }
          a.net.send({ t: 'join', code: c, ...who });
          this.status('Joining...');
          break;
        }
        case 'help': a.hud.showHelp(); break;
      }
    });
  }

  status(msg: string) {
    const s = document.getElementById('status');
    if (s) s.textContent = msg;
  }

  showRoom(info: any) {
    const a = this.app;
    const host = info.host === info.you;
    const set: MatchSettings = info.settings;
    const me = info.players.find((p: any) => p.id === info.you);
    const used = new Set(info.players.filter((p: any) => p.id !== info.you).map((p: any) => p.color));
    const dis = host ? '' : 'disabled';
    const opt = (vals: [string | number, string][], cur: string | number) => vals.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('');
    this.root.innerHTML = '';
    const s = el('div', 'screen');
    s.innerHTML = `<div class="lobby-grid">
      <div class="pix">
        <div><div class="muted" style="font-size:8px">ROOM CODE</div><div class="roomcode">${info.code}</div></div>
        <div data-invite></div>
        <h3 style="font-size:10px">PLAYERS ${info.players.length}/20</h3>
        <ul class="plist">${info.players.map((p: any) => `<li><span class="dot ${p.on ? 'on' : ''}"></span><span class="sw" style="background:${cssColor(p.color)}"></span><span class="grow">${esc(p.name)}${p.id === info.you ? ' <span class="tag you">YOU</span>' : ''}</span>${p.host ? iconImg('crown', '#ffd23f') : ''}${p.team ? `<span class="tag">TEAM ${p.team}</span>` : ''}</li>`).join('')}</ul>
        <div class="section">YOUR COLOUR</div>
        <div class="swatches">${HUMAN_COLORS.map((c) => `<button data-c="${c}" class="${c === me?.color ? 'sel' : ''}" style="background:${cssColor(c)}" ${used.has(c) ? 'disabled' : ''}></button>`).join('')}</div>
        <div class="row"><span class="muted grow" style="font-size:8px">TEAM (teams start allied)</span>
          <select data-team>${opt([[0, 'None'], [1, 'Team 1'], [2, 'Team 2'], [3, 'Team 3'], [4, 'Team 4']], me?.team ?? 0)}</select></div>
      </div>
      <div class="pix">
        <h3 style="font-size:10px">MATCH SETTINGS ${host ? '' : '<span class="muted">(host decides)</span>'}</h3>
        <div class="settings">
          <label class="toggle full"><input type="checkbox" data-s="aiOn" ${set.aiCount > 0 ? 'checked' : ''} ${dis}> AI nations (PvE)</label>
          <label>AI COUNT <span class="hi-t" data-aiv>${set.aiCount}</span></label>
          <input type="range" min="0" max="500" step="10" value="${set.aiCount}" data-s="aiCount" ${dis}>
          <label>AI BEHAVIOUR</label><select data-s="aiDifficulty" ${dis}>${opt([['mixed', 'Mixed'], ['passive', 'Passive'], ['defensive', 'Defensive'], ['aggressive', 'Aggressive']], set.aiDifficulty)}</select>
          <label>MAP SIZE</label><select data-s="mapSize" ${dis}>${opt(Object.entries(MAP_SIZES).map(([k, w]) => [k, `${k[0].toUpperCase() + k.slice(1)} ${w}x${w / 2}`]), set.mapSize)}</select>
          <label>SPEED</label><select data-s="speed" ${dis}>${opt([[0.5, 'Slow x0.5'], [1, 'Normal'], [1.5, 'Fast x1.5'], [2, 'Blitz x2']], set.speed)}</select>
          <label>SPAWN TIME</label><select data-s="spawnSeconds" ${dis}>${opt([[10, '10s'], [20, '20s'], [30, '30s'], [45, '45s'], [60, '60s']], set.spawnSeconds)}</select>
          <label>PEACE TIME</label><select data-s="peaceSeconds" ${dis}>${opt([[0, 'None'], [30, '30s'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']], set.peaceSeconds)}</select>
          <label>TIME LIMIT</label><select data-s="timeLimitMin" ${dis}>${opt([[0, 'None'], [15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '60 min'], [90, '90 min'], [120, '2 hours']], set.timeLimitMin)}</select>
          <label>WIN AT LAND %</label><select data-s="winPercent" ${dis}>${opt([[50, '50%'], [60, '60%'], [70, '70%'], [80, '80%'], [90, '90%'], [100, '100%']], set.winPercent)}</select>
          <label class="toggle"><input type="checkbox" data-s="nukes" ${set.nukes ? 'checked' : ''} ${dis}> Nukes</label>
          <label class="toggle"><input type="checkbox" data-s="nuclearWinter" ${set.nuclearWinter ? 'checked' : ''} ${dis}> Nuclear winter</label>
          <label class="toggle"><input type="checkbox" data-s="sharedVictory" ${set.sharedVictory ? 'checked' : ''} ${dis}> Shared alliance victory</label>
          <label class="toggle"><input type="checkbox" data-s="fog" ${set.fog ? 'checked' : ''} ${dis}> Fog of war</label>
        </div>
      </div></div>
      <div class="lobby-actions"><button class="btn red" data-a="leave">Leave</button>
        ${host ? `<button class="btn hi big" style="width:auto;padding:0 28px" data-a="start">${iconImg('troops')} Start match</button>` : '<div class="muted" style="align-self:center">Waiting for the host to start...</div>'}</div>`;
    this.root.append(s);
    mountInvite(s.querySelector<HTMLElement>('[data-invite]')!, info.code);
    const send = (patch: Partial<MatchSettings>) => a.net.send({ t: 'settings', settings: { ...set, ...patch } });
    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach((inp) => {
      const k = inp.dataset.s!;
      if (k === 'aiCount') inp.addEventListener('input', () => { const v = s.querySelector('[data-aiv]'); if (v) v.textContent = inp.value; });
      inp.addEventListener('change', () => {
        sfx.click();
        if (k === 'aiOn') return send({ aiCount: (inp as HTMLInputElement).checked ? Math.max(50, set.aiCount) : 0 });
        if (inp instanceof HTMLInputElement && inp.type === 'checkbox') return send({ [k]: inp.checked } as any);
        const v = inp.value;
        send({ [k]: k === 'mapSize' || k === 'aiDifficulty' ? v : Number(v) } as any);
      });
    });
    s.querySelector<HTMLSelectElement>('[data-team]')!.addEventListener('change', (e) => a.net.send({ t: 'me', team: Number((e.target as HTMLSelectElement).value) }));
    s.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const sw = t.closest<HTMLElement>('[data-c]');
      if (sw && !(sw as HTMLButtonElement).disabled) { a.color = Number(sw.dataset.c); store.set('color', String(a.color)); a.net.send({ t: 'me', color: a.color }); sfx.click(); return; }
      const b = t.closest<HTMLElement>('[data-a]');
      if (!b) return;
      sfx.unlock();
      sfx.click();
      if (b.dataset.a === 'start') a.net.send({ t: 'start' });
      else if (b.dataset.a === 'leave') a.net.send({ t: 'leave' });
    });
  }
}
