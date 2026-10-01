// Invite block: the link friends open (with a QR code for tablets and phones) and, inside the desktop app, the
// "Go online" switch for the free Cloudflare tunnel. Re-renders itself whenever the tunnel state changes.

import qrcode from 'qrcode-generator';
import { copyText, desktop, host, onHostChange, shareOrigin } from '../desktop.ts';
import { esc } from '../util.ts';
import { sfx } from '../audio.ts';

const isLoopback = (url: string) => /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);

function drawQr(canvas: HTMLCanvasElement, text: string, px: number) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), quiet = 3;
  const cell = Math.max(2, Math.floor(px / (n + quiet * 2)));
  canvas.width = canvas.height = cell * (n + quiet * 2);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#0b1020';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
}

function statusRow(): string {
  const t = host.tunnel;
  const wifi = (host.info?.lan.length ?? 0) > 0;
  switch (t.status) {
    case 'download':
      return `<span class="hdot busy"></span><span class="grow">Getting the Cloudflare tool... ${Math.round(t.progress * 100)}%</span><button class="btn small" data-h="off">Cancel</button>`;
    case 'starting':
      return '<span class="hdot busy"></span><span class="grow">Connecting to Cloudflare...</span><button class="btn small" data-h="off">Cancel</button>';
    case 'publishing':
      return '<span class="hdot busy"></span><span class="grow">Publishing your link...</span><button class="btn small" data-h="off">Cancel</button>';
    case 'online':
      return `<span class="hdot on"></span><span class="grow good">ONLINE${t.verified ? ' · LINK WORKS' : ''}</span><button class="btn small red" data-h="off">Stop</button>`;
    case 'error':
      return `<span class="hdot bad"></span><span class="grow bad">${esc(t.error)}</span><button class="btn small green" data-h="on">Try again</button>`;
    default:
      return `<span class="hdot"></span><span class="grow">${wifi ? 'OFFLINE · only your Wi-Fi can join' : 'OFFLINE'}</span><button class="btn small green" data-h="on">Go online</button>`;
  }
}

function note(room: string | null): string {
  const t = host.tunnel;
  if (t.status === 'online') {
    return `Anyone with this link can join from any web browser, nothing to install. The link stops working when you stop hosting, and you get a new one each time.${room ? '' : ' Create a room and share its invite link.'}`;
  }
  if (t.status === 'error' || t.status === 'off') return 'GO ONLINE opens a free Cloudflare link so friends anywhere can join. No account or router setup needed.';
  if (t.status === 'publishing') return 'Cloudflare is publishing your new link, which can take up to a minute. It appears here once it works everywhere, so nobody opens it too early.';
  return 'This usually takes a few seconds.';
}

/** Render the invite block into box (which must already be in the page) and keep it up to date. */
export function mountInvite(box: HTMLElement, room: string | null) {
  let copied = 0;
  const link = () => `${shareOrigin()}/${room ? `?room=${room}` : ''}`;
  const render = () => {
    const url = link();
    const qr = room && !isLoopback(url);
    box.innerHTML = `<div class="invite">
      <div class="row"><div class="invlink grow">${esc(url)}</div><button class="btn small" data-h="copy">${Date.now() - copied < 1500 ? 'Copied!' : 'Copy link'}</button></div>
      ${desktop ? `<div class="row hoststatus">${statusRow()}</div>` : ''}
      ${qr ? '<div class="qrwrap"><canvas class="qr"></canvas><span class="muted">Scan to join<br>on a tablet<br>or phone</span></div>' : ''}
      ${desktop ? `<div class="muted invnote">${note(room)}</div>` : ''}
    </div>`;
    const cv = box.querySelector<HTMLCanvasElement>('canvas.qr');
    if (cv) drawQr(cv, url, 132);
  };
  render();
  const off = onHostChange(() => { if (box.isConnected) render(); else off(); });
  box.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-h]');
    if (!b) return;
    sfx.click();
    switch (b.dataset.h) {
      case 'copy': {
        const url = link();
        copyText(url).then(() => { copied = Date.now(); render(); setTimeout(() => box.isConnected && render(), 1600); }, () => prompt('Invite link', url));
        break;
      }
      case 'on': void desktop?.setOnline(true); break;
      case 'off': void desktop?.setOnline(false); break;
    }
  });
}
