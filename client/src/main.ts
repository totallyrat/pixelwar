import '@fontsource/press-start-2p/400.css';
import './style.css';
import { Net, store } from './net.ts';
import { World, fetchMap } from './world.ts';
import { Renderer } from './render/renderer.ts';
import { Input } from './input.ts';
import { Hud } from './ui/hud.ts';
import { Lobby } from './ui/lobby.ts';
import { sfx } from './audio.ts';
import { HUMAN_COLORS, MAP_SIZES } from '../../shared/balance.ts';

export class App {
  net = new Net();
  world = new World();
  renderer: Renderer;
  hud: Hud;
  lobby: Lobby;
  input: Input;
  screen: 'title' | 'room' | 'game' = 'title';
  lobbyInfo: any = null;
  name = store.get('name') ?? '';
  color = Number(store.get('color') ?? HUMAN_COLORS[Math.floor(Math.random() * HUMAN_COLORS.length)]);
  private demo = true;

  constructor() {
    const canvas = document.getElementById('map') as HTMLCanvasElement;
    this.renderer = new Renderer(canvas, this.world);
    this.hud = new Hud(this);
    this.lobby = new Lobby(this);
    this.input = new Input(canvas, this.renderer, {
      tap: (t) => { if (this.screen === 'game') this.hud.tap(t); },
      doubleTap: (t) => { if (this.screen === 'game') this.hud.quickAttack(t); },
      secondary: (t) => { if (this.screen === 'game') this.hud.quickAttack(t); },
      hold: (t, x, y) => { if (this.screen === 'game') this.hud.hold(t, x, y); },
      hover: (t) => { if (this.renderer.hover !== t) { this.renderer.hover = t; if (this.renderer.mode || this.world.phase === 'spawn') this.renderer.needs = true; } },
      escape: () => { if (this.screen === 'game') this.hud.escape(); },
      key: (k) => { if (this.screen === 'game') this.hud.key(k); },
    });

    const w = this.world;
    w.onInit = () => this.enterGame();
    w.onTiles = (list) => this.renderer.updateTiles(list);
    w.onVis = (blocks) => this.renderer.updateBlocks(blocks);
    w.onEvent = (e) => { if (this.screen === 'game') this.hud.onEvent(e); };
    w.onTick = () => { if (this.screen === 'game') this.hud.update(); };

    const net = this.net;
    net.hello = () => ({ name: this.name || 'Commander', color: this.color });
    net.onStatus = (s) => {
      if (s === 'replaced') {
        if (this.screen === 'game') this.leaveGame();
        this.screen = 'title';
        this.lobby.showTitle('This session was opened in another tab. Reload to take it back.');
        return;
      }
      if (this.screen === 'game') this.hud.setConn(s === 'open');
      if (this.screen === 'title') this.lobby.status(s === 'open' ? '' : 'Connecting to server...');
    };
    net.onBinary = (b) => { void w.handleBinary(b).catch((e) => console.error(e)); };
    net.onJson = (m) => this.onJson(m);

    // unlock audio on the first interaction anywhere
    const unlock = () => sfx.unlock();
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('keydown', unlock, { once: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.renderer.needs = true; });

    if (!this.name) this.name = 'Commander' + Math.floor(Math.random() * 900 + 100);
    this.lobby.showTitle();
    this.startDemo();
    net.connect();
  }

  /** Slowly drifting world map behind the title/lobby screens. */
  private async startDemo() {
    try {
      const map = await fetchMap(MAP_SIZES.medium);
      if (this.screen === 'game') return;
      const w = this.world;
      w.map = map;
      w.W = map.W; w.H = map.H; w.N = map.N;
      w.owner = new Uint16Array(map.N);
      w.fallout = new Uint8Array(map.N);
      w.bldAt = new Int32Array(map.N).fill(-1);
      w.vis = null;
      this.renderer.setup();
      this.renderer.cam.z = this.renderer.minZoom() * 1.25;
      this.renderer.cam.y = map.H * 0.42;
      const drift = () => {
        if (!this.demo) return;
        this.renderer.cam.x += 0.05;
        this.renderer.clampCam();
        this.renderer.needs = true;
        requestAnimationFrame(drift);
      };
      drift();
    } catch (e) { console.warn('demo map failed', e); }
  }

  private onJson(m: any) {
    switch (m.t) {
      case 'welcome': {
        const code = new URLSearchParams(location.search).get('room');
        if (code && this.screen === 'title') {
          history.replaceState(null, '', location.pathname);
          this.net.send({ t: 'join', code: code.toUpperCase(), name: this.name, color: this.color });
        }
        break;
      }
      case 'lobby':
        this.lobbyInfo = m;
        fetchMap(MAP_SIZES[m.settings.mapSize as keyof typeof MAP_SIZES]).catch(() => {});
        if (m.state === 'lobby') {
          if (this.screen === 'game') this.leaveGame();
          this.screen = 'room';
          this.lobby.showRoom(m);
        }
        break;
      case 'left':
        if (this.screen === 'game') this.leaveGame();
        this.screen = 'title';
        this.lobbyInfo = null;
        this.lobby.showTitle();
        break;
      case 'error':
        if (this.screen === 'game') this.hud.toast(m.msg, 'bad');
        else this.lobby.status(m.msg);
        sfx.error();
        break;
    }
  }

  private enterGame() {
    const first = this.screen !== 'game';
    this.demo = false;
    this.screen = 'game';
    const r = this.renderer, w = this.world;
    r.setup();
    if (first) {
      const me = w.P(w.myId);
      if (me && me.capital >= 0) r.centerOn(me.capital, Math.max(r.minZoom(), 4));
      else { r.cam.x = w.W / 2; r.cam.y = w.H * 0.45; r.cam.z = r.minZoom(); r.clampCam(); }
    }
    this.hud.mount();
    this.hud.setConn(this.net.status === 'open');
    if (first && w.phase === 'spawn') sfx.spawn();
    if (first && !store.get('seenHelp')) { store.set('seenHelp', '1'); this.hud.showHelp(); }
  }

  private leaveGame() {
    this.hud.unmount();
    this.renderer.sel = -1;
    this.renderer.mode = '';
    this.world.ready = false;
    this.demo = true;
    this.startDemo();
  }

  overlayAction(a: string) {
    const h = this.hud;
    switch (a) {
      case 'sound': sfx.toggle(); h.showMenu(); break;
      case 'labels': this.renderer.showLabels = !this.renderer.showLabels; this.renderer.needs = true; h.showMenu(); break;
      case 'fullscreen': document.documentElement.requestFullscreen?.().catch(() => {}); h.closeOverlay(); break;
      case 'help': h.showHelp(); break;
      case 'invite': h.showInvite(); break;
      case 'surrender': if (confirm('Surrender your nation? You will become a spectator.')) { this.net.act('surrender'); h.closeOverlay(); } break;
      case 'leave': if (confirm('Leave this match?')) { h.closeOverlay(); this.net.send({ t: 'leave' }); } break;
      case 'lobby': {
        const info = this.lobbyInfo;
        if (info && info.host === info.you) this.net.send({ t: 'lobbyReturn' });
        else { h.closeOverlay(); h.toast('Waiting for the host to return to the lobby... (Menu > Leave to quit)', 'info'); }
        break;
      }
      case 'close': h.closeOverlay(); break;
    }
  }
}

(window as any).pixelwar = new App();
