// Electron shell. No web server: the window talks to the data engine over IPC (see preload.cjs), and the
// dashboard is served from a private `lens://` scheme. Nothing listens on a port.
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Api, Store } from '@session-lens/core';

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = [join(here, 'ui'), join(here, '../../packages/ui/dist')].find((d) => existsSync(join(d, 'index.html')));

// One window per checkout: a second launch of THIS build focuses it, and another checkout
// (e.g. a git worktree) gets its own userData so it can't hijack the lock.
app.setPath('userData', join(app.getPath('appData'), 'session-lens', Buffer.from(here).toString('base64url').slice(-24)));
if (!app.requestSingleInstanceLock()) app.quit();

// Module scripts need a standard, secure scheme (file:// would block them).
protocol.registerSchemesAsPrivileged([{ scheme: 'lens', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

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
  // Serve only files inside the dashboard bundle.
  protocol.handle('lens', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = normalize(join(uiDir, rel));
    if (!file.startsWith(uiDir + sep) && file !== join(uiDir, 'index.html')) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(existsSync(file) ? file : join(uiDir, 'index.html')).toString());
  });

  const roots = process.env.SESSION_LENS_PROJECTS?.split(',');
  const store = new Store(roots ? { roots } : {});
  store.refresh(0);
  store.watch();
  const api = new Api(store);

  ipcMain.handle('lens:api', (_e, path, query, body) => {
    try {
      return api.handle(`/api/${String(path)}`, new URLSearchParams(String(query ?? '')), body);
    } catch (err) {
      return { error: String(err) };
    }
  });
  ipcMain.on('lens:save', async (_e, name, content) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), String(name)) });
    if (!r.canceled && r.filePath) writeFileSync(r.filePath, String(content));
  });

  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 480,
    title: 'Session Lens',
    backgroundColor: '#f9f9f7',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(here, 'preload.cjs') },
  });
  // Push "new data" to the window; the page throttles its own redraws.
  const onChange = () => win && !win.isDestroyed() && win.webContents.send('lens:change');
  store.on('change', onChange);
  win.on('closed', () => {
    store.off('change', onChange);
    win = undefined;
  });
  // Links out of the dashboard open in the browser; the window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('lens://')) e.preventDefault();
  });
  await win.loadURL('lens://app/index.html');
  if (process.env.SESSION_LENS_SCREENSHOT) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      writeFileSync(process.env.SESSION_LENS_SCREENSHOT, img.toPNG());
      app.quit();
    }, 3000);
  }
});

app.on('window-all-closed', () => app.quit());
