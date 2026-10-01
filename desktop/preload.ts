// Exposes a small, fixed API to the game page as window.pwDesktop (the page has no Node access).
// The main process ignores these calls unless they come from the local game server's page.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pwDesktop', {
  info: () => ipcRenderer.invoke('pw:info'),
  setOnline: (on: boolean) => ipcRenderer.invoke('pw:online', !!on),
  onTunnel: (fn: (state: unknown) => void) => {
    const h = (_e: unknown, state: unknown) => fn(state);
    ipcRenderer.on('pw:tunnel', h);
    return () => { ipcRenderer.removeListener('pw:tunnel', h); };
  },
  copy: (text: string) => ipcRenderer.invoke('pw:copy', String(text)),
  openExternal: (url: string) => ipcRenderer.invoke('pw:open', String(url)),
});
