// Electron shell: runs the same local server as the CLI and shows it in a window.
import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, Store } from '@session-lens/core';

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = [join(here, 'ui'), join(here, '../../packages/ui/dist')].find((d) => existsSync(join(d, 'index.html')));

// One window per checkout: a second launch of THIS build focuses it, and another checkout
// (e.g. a git worktree) gets its own userData so it can't hijack the lock.
app.setPath('userData', join(app.getPath('appData'), 'session-lens', Buffer.from(here).toString('base64url').slice(-24)));
if (!app.requestSingleInstanceLock()) app.quit();

let win;
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (!uiDir) {
    console.error('Dashboard bundle not found. Run `npm run build` in the session-lens folder first.');
    app.quit();
    return;
  }
  const roots = process.env.SESSION_LENS_PROJECTS?.split(',');
  const { url } = await createServer({ uiDir, store: new Store(roots ? { roots } : {}), port: 0 });
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 480,
    title: 'Session Lens',
    backgroundColor: '#f9f9f7',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links out of the dashboard open in the browser, not in the app window.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    void shell.openExternal(u);
    return { action: 'deny' };
  });
  await win.loadURL(url);
  if (process.env.SESSION_LENS_SCREENSHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      (await import('node:fs')).writeFileSync(process.env.SESSION_LENS_SCREENSHOT, img.toPNG());
      app.quit();
    }, 2500);
  }
});

app.on('window-all-closed', () => app.quit());
