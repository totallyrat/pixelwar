// Bridge to the PIXEL WAR desktop app. window.pwDesktop only exists when the game runs inside the app
// (see desktop/preload.ts); in a normal browser everything here falls back to plain web behaviour.

export type TunnelStatus = 'off' | 'download' | 'starting' | 'publishing' | 'online' | 'error';
export interface TunnelState { status: TunnelStatus; url: string; verified: boolean; progress: number; error: string }
export interface DesktopInfo { port: number; lan: string[]; tunnel: TunnelState; version: string; platform: string }

interface DesktopApi {
  info(): Promise<DesktopInfo | null>;
  setOnline(on: boolean): Promise<TunnelState | null>;
  onTunnel(fn: (s: TunnelState) => void): () => void;
  copy(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export const desktop: DesktopApi | undefined = (window as any).pwDesktop;

export const host = {
  info: null as DesktopInfo | null,
  tunnel: { status: 'off', url: '', verified: false, progress: 0, error: '' } as TunnelState,
};

const listeners = new Set<() => void>();
export function onHostChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const changed = () => { for (const f of [...listeners]) f(); };

if (desktop) {
  desktop.info().then((i) => { host.info = i; if (i) host.tunnel = i.tunnel; changed(); }).catch(() => {});
  desktop.onTunnel((s) => { host.tunnel = s; changed(); });
}

/** Origin for invite links: the public tunnel when online, in the app otherwise the Wi-Fi address, else this page. */
export function shareOrigin(): string {
  if (host.tunnel.status === 'online' && host.tunnel.url) return host.tunnel.url;
  if (desktop && host.info?.lan.length) return host.info.lan[0];
  return location.origin;
}

export function copyText(text: string): Promise<void> {
  if (desktop) return desktop.copy(text);
  return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
}
