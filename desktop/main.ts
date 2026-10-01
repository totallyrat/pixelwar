// PIXEL WAR desktop app (Electron main process).
// Runs the game server in a background utility process, shows the game in a window, and can open a free
// Cloudflare quick tunnel so friends anywhere can join from their web browser.

import {
  app, BrowserWindow, Menu, clipboard, dialog, ipcMain, screen, session, shell, utilityProcess,
  type IpcMainInvokeEvent, type MenuItemConstructorOptions, type UtilityProcess,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuickTunnel, exeName } from './tunnel.ts';

const PREFERRED_PORT = 8080;
const isMac = process.platform === 'darwin';
const OS_KEY = isMac ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';

// Packaged: resources/game (client + maps) and resources/cloudflared. Dev: the repo's dist folder.
const REPO = path.resolve(__dirname, '../..');
const CLIENT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(REPO, 'dist/client');
const BUNDLED_CLOUDFLARED = app.isPackaged
  ? path.join(process.resourcesPath, 'cloudflared', exeName())
  : path.join(REPO, 'dist/vendor/cloudflared', `${OS_KEY}-${process.arch}`, exeName());

if (process.platform === 'win32') app.setAppUserModelId('com.pixelwar.game');
if (process.env.PW_USER_DATA) app.setPath('userData', path.resolve(process.env.PW_USER_DATA)); // tests, portable use
const USER = app.getPath('userData');

// ---- log file (server output, tunnel output, app events) ------------------------------------------------
const LOG_FILE = path.join(USER, 'logs', 'pixelwar.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
try { if (fs.statSync(LOG_FILE).size > 2_000_000) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log')); } catch { /* no log yet */ }
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.on('error', () => { /* logging must never take the app down */ });
function log(src: string, text: string) {
  if (logStream.writableEnded) return;
  for (const line of text.split(/\r?\n/)) if (line.trim()) logStream.write(`${new Date().toISOString()} [${src}] ${line}\n`);
}
log('app', `PIXEL WAR ${app.getVersion()} starting (${process.platform}-${process.arch}, electron ${process.versions.electron})`);

let win: BrowserWindow | null = null;
let server: UtilityProcess | null = null;
let port = 0;
let quitting = false;   // shutting down: don't restart the server
let closeOk = false;    // the player confirmed (or nothing needed confirming)
let cleanedUp = false;  // server saved and stopped, tunnel closed
let crashes = 0;

const tunnel = new QuickTunnel({
  bundled: [BUNDLED_CLOUDFLARED],
  downloadDir: path.join(USER, 'bin'),
  log: (line) => log('tunnel', line),
});
tunnel.on('state', (s) => {
  log('app', `tunnel ${s.status}${s.url ? ' ' + s.url : ''}${s.verified ? ' (verified)' : ''}${s.error ? ': ' + s.error : ''}`);
  if (win && !win.isDestroyed()) win.webContents.send('pw:tunnel', s);
});

const gameUrl = () => `http://127.0.0.1:${port}/`;
function isGame(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === port;
  } catch { return false; }
}
/** Addresses players on the same Wi-Fi can use, most likely home-network ones first. */
function lanUrls(): string[] {
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i!.address).sort((a, b) => rank(a) - rank(b)).map((ip) => `http://${ip}:${port}`);
}
function openExternal(url: string) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

// ---- game server ----------------------------------------------------------------------------------------
function startServer(preferred: number): Promise<number> {
  return new Promise((ok, fail) => {
    const child = utilityProcess.fork(path.join(__dirname, 'server.cjs'), [], {
      serviceName: 'PIXEL WAR server',
      stdio: 'pipe',
      env: {
        ...process.env,
        PW_PORT: String(preferred),
        PW_CLIENT_DIR: CLIENT_DIR,
        PW_MAP_DIR: path.join(CLIENT_DIR, 'maps'),
        PW_DATA_DIR: path.join(USER, 'rooms'),
      },
    });
    server = child;
    let settled = false;
    const done = (e: Error | null, p = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e) fail(e); else ok(p);
    };
    const timer = setTimeout(() => { done(new Error('The game server did not start within 30 seconds.')); child.kill(); }, 30_000);
    child.stdout?.on('data', (b: Buffer) => log('server', b.toString()));
    child.stderr?.on('data', (b: Buffer) => log('server', b.toString()));
    child.on('message', (m: { t?: string; port?: number; error?: string }) => {
      if (m?.t === 'ready') done(null, m.port ?? preferred);
      else if (m?.t === 'fatal') done(new Error(m.error ?? 'unknown error'));
    });
    child.on('exit', (code) => {
      log('app', `server exited (${code})`);
      if (server === child) server = null;
      const wasRunning = settled;
      done(new Error(`The game server stopped during startup (exit code ${code}).`));
      if (wasRunning && !quitting) void restartServer();
    });
  });
}

async function restartServer() {
  if (++crashes > 3) {
    dialog.showErrorBox('PIXEL WAR', `The game server keeps stopping. Details are in the log file:\n${LOG_FILE}`);
    closeOk = true;
    app.quit();
    return;
  }
  try {
    const old = port;
    port = await startServer(old);
    if (port !== old && tunnel.active) { tunnel.stop(); void tunnel.start(port); }
    win?.loadURL(gameUrl());
  } catch (e) {
    dialog.showErrorBox('PIXEL WAR', `The game server could not restart: ${(e as Error).message}\n\nLog: ${LOG_FILE}`);
    closeOk = true;
    app.quit();
  }
}

function stopServer(): Promise<void> {
  const s = server;
  if (!s) return Promise.resolve();
  return new Promise((ok) => {
    const t = setTimeout(() => { s.kill(); ok(); }, 5000);
    s.once('exit', () => { clearTimeout(t); ok(); });
    s.postMessage({ t: 'shutdown' }); // saves every room first
  });
}

async function onlineCount(): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return ((await r.json()) as { online?: number }).online ?? 0;
  } catch { return 0; }
}

// ---- window -----------------------------------------------------------------------------------------------
interface WinState { x?: number; y?: number; width: number; height: number; maximized?: boolean; fullscreen?: boolean }
const WIN_FILE = path.join(USER, 'window.json');

function loadWinState(): WinState {
  const def: WinState = { width: 1280, height: 800 };
  try {
    const s = JSON.parse(fs.readFileSync(WIN_FILE, 'utf8')) as WinState;
    if (!(s.width >= 400 && s.height >= 300)) return def;
    // forget the position if that monitor is gone
    const visible = s.x !== undefined && s.y !== undefined && screen.getAllDisplays().some(({ workArea: a }) =>
      s.x! < a.x + a.width - 80 && s.x! + s.width > a.x + 80 && s.y! >= a.y - 20 && s.y! < a.y + a.height - 80);
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized, fullscreen: s.fullscreen };
  } catch { return def; }
}

function saveWinState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  const s: WinState = { ...b, maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
  try { fs.writeFileSync(WIN_FILE, JSON.stringify(s)); } catch { /* not important */ }
}

function splash(text: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>PIXEL WAR</title>
    <body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b1020;color:#ffd23f;font:bold 42px monospace;letter-spacing:4px">
    <div style="text-shadow:4px 4px 0 #b3261e">PIXEL WAR</div>
    <div style="margin-top:22px;color:#8a93b8;font-size:14px;letter-spacing:1px">${text}</div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow() {
  const st = loadWinState();
  const w = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height,
    minWidth: 760, minHeight: 480,
    show: false,
    title: 'PIXEL WAR',
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win = w;
  if (st.maximized) w.maximize();
  if (st.fullscreen) w.setFullScreen(true);
  w.once('ready-to-show', () => w.show());
  void w.loadURL(splash('Starting the game server...'));

  // stay on the local game; anything else opens in the normal browser
  w.webContents.on('will-navigate', (e, url) => { if (!isGame(url)) { e.preventDefault(); openExternal(url); } });
  w.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  w.webContents.on('render-process-gone', (_e, d) => {
    log('app', `renderer gone: ${d.reason}`);
    if (d.reason !== 'clean-exit' && !quitting && port) setTimeout(() => w.isDestroyed() || w.loadURL(gameUrl()), 500);
  });

  w.on('close', (e) => {
    saveWinState();
    if (closeOk) return;
    e.preventDefault();
    void confirmQuit().then((ok) => { if (ok) { closeOk = true; app.quit(); } });
  });
  w.on('closed', () => { if (win === w) win = null; });
}

async function confirmQuit(): Promise<boolean> {
  const others = Math.max(0, (await onlineCount()) - 1); // minus this window
  if (!tunnel.active && others === 0) return true;
  if (!win || win.isDestroyed()) return true;
  const who = others === 1 ? '1 other player is' : `${others} other players are`;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Keep playing', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    title: 'PIXEL WAR',
    message: tunnel.active ? 'Stop hosting and quit?' : 'Quit PIXEL WAR?',
    detail: `${others ? `${who} connected to your game. ` : ''}Quitting closes your server${tunnel.active ? ' and the online link' : ''} for everyone. `
      + 'Running matches are saved and continue the next time you open PIXEL WAR.',
  });
  return response === 1;
}

// ---- menu ---------------------------------------------------------------------------------------------------
function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'Game',
      submenu: [
        { label: 'Back to title screen', accelerator: 'CmdOrCtrl+Shift+H', click: () => port && win?.loadURL(gameUrl()) },
        { label: 'Open in web browser', click: () => port && openExternal(gameUrl()) },
        { type: 'separator' },
        { label: 'Open saved games folder', click: () => void shell.openPath(path.join(USER, 'rooms')) },
        { label: 'Open log file', click: () => void shell.openPath(LOG_FILE) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'About Cloudflare quick tunnels', click: () => openExternal('https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- bridge to the game page (see preload.ts) -----------------------------------------------------------------
const fromGame = (e: IpcMainInvokeEvent) => isGame(e.senderFrame?.url ?? '');

ipcMain.handle('pw:info', (e) => fromGame(e)
  ? { port, lan: lanUrls(), tunnel: tunnel.state, version: app.getVersion(), platform: process.platform }
  : null);
ipcMain.handle('pw:online', (e, on: unknown) => {
  if (!fromGame(e)) return null;
  if (on) void tunnel.start(port); else tunnel.stop();
  return tunnel.state;
});
ipcMain.handle('pw:copy', (e, text: unknown) => {
  if (fromGame(e) && typeof text === 'string' && text.length <= 2000) clipboard.writeText(text);
});
ipcMain.handle('pw:open', (e, url: unknown) => {
  if (fromGame(e) && typeof url === 'string') openExternal(url);
});

// ---- lifecycle ------------------------------------------------------------------------------------------------
async function boot() {
  await app.whenReady();
  buildMenu();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'clipboard-sanitized-write'));
  createWindow();
  try {
    port = await startServer(PREFERRED_PORT);
  } catch (e) {
    log('app', `startup failed: ${(e as Error).stack ?? e}`);
    dialog.showErrorBox('PIXEL WAR could not start', `${(e as Error).message}\n\nDetails are in the log file:\n${LOG_FILE}`);
    closeOk = true;
    app.exit(1);
    return;
  }
  log('app', `game at ${gameUrl()}`);
  if (win && !win.isDestroyed()) await win.loadURL(gameUrl());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    // Cmd+Q / menu quit: route through the window's close confirmation
    if (!closeOk && win && !win.isDestroyed()) { e.preventDefault(); win.close(); }
  });
  app.on('will-quit', (e) => {
    if (cleanedUp) return;
    e.preventDefault();
    quitting = true;
    tunnel.stop();
    void stopServer().finally(() => {
      cleanedUp = true;
      log('app', 'bye');
      logStream.end(() => app.quit());
    });
  });
  void boot();
}
