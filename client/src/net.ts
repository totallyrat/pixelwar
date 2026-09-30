// WebSocket connection with automatic reconnect. The server hands out a session token; presenting it
// again reattaches us to our room/nation after a disconnect, reload or server restart.
// Each browser tab gets its own identity (so several tabs = several players on one machine):
// the token lives in sessionStorage, and a new tab adopts the last saved token only if no other
// live tab is currently using it.

export const store = {
  get(k: string): string | null { try { return localStorage.getItem('pw.' + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem('pw.' + k, v); } catch { /* private mode */ } },
  del(k: string) { try { localStorage.removeItem('pw.' + k); } catch { /* ignore */ } },
};
const session = {
  get(k: string): string | null { try { return sessionStorage.getItem('pw.' + k); } catch { return null; } },
  set(k: string, v: string) { try { sessionStorage.setItem('pw.' + k, v); } catch { /* ignore */ } },
};

function initialToken(): string {
  if (new URLSearchParams(location.search).has('new')) return ''; // force a fresh player (testing)
  const own = session.get('token');
  if (own) return own;
  const saved = store.get('token');
  if (!saved) return '';
  const alive = Number(store.get('alive.' + saved) ?? 0);
  return Date.now() - alive < 6000 ? '' : saved; // in use by another open tab
}

export type NetStatus = 'connecting' | 'open' | 'closed' | 'replaced';

export class Net {
  private ws: WebSocket | null = null;
  private backoff = 400;
  private pending: string[] = [];
  token = initialToken();
  status: NetStatus = 'closed';
  onJson: (m: any) => void = () => {};
  onBinary: (b: Uint8Array) => void = () => {};
  onStatus: (s: NetStatus) => void = () => {};
  hello: () => Record<string, unknown> = () => ({});

  constructor() {
    setInterval(() => { if (this.token) store.set('alive.' + this.token, String(Date.now())); }, 2000);
    addEventListener('pagehide', () => { if (this.token) store.del('alive.' + this.token); });
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.backoff = 400;
      this.setStatus('open');
      ws.send(JSON.stringify({ t: 'hello', token: this.token, ...this.hello() }));
      for (const p of this.pending) ws.send(p);
      this.pending = [];
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'welcome') {
          this.token = m.token;
          session.set('token', m.token);
          store.set('token', m.token);
          store.set('alive.' + m.token, String(Date.now()));
        }
        this.onJson(m);
      } else this.onBinary(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4000) { this.setStatus('replaced'); return; } // same identity opened elsewhere
      this.setStatus('closed');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 1.7, 5000);
    };
    ws.onerror = () => { /* onclose handles retry */ };
  }

  private setStatus(s: NetStatus) { this.status = s; this.onStatus(s); }

  send(m: Record<string, unknown>) {
    const s = JSON.stringify(m);
    if (this.ws && this.ws.readyState === 1) this.ws.send(s);
    else if (m.t !== 'i') this.pending.push(s); // don't replay stale game orders after reconnect
  }

  /** In-game intent. */
  act(k: string, data: Record<string, unknown> = {}) { this.send({ t: 'i', k, ...data }); }
}
