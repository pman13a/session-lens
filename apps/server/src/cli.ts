#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, Store } from '@session-lens/core';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('help')) {
  console.log(`session-lens — Claude Code usage, day → session → request → context

  --port <n>        port to listen on (default 4317, 0 = any free port)
  --host <addr>     interface to bind (default 127.0.0.1)
  --projects <dir>  transcripts folder (default ~/.claude/projects; comma-separate several)
  --no-open         don't open a browser`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = [join(here, 'ui'), join(here, '../../../packages/ui/dist')].find((d) => existsSync(join(d, 'index.html')));
if (!uiDir) {
  console.error('Dashboard bundle not found. Run `npm run build` in the session-lens folder first.');
  process.exit(1);
}

const roots = opt('projects')?.split(',');
const store = new Store(roots ? { roots } : {});
if (!store.roots.length) {
  console.error('No Claude Code transcripts found (looked for ~/.claude/projects). Pass --projects <dir>.');
  process.exit(1);
}

const port = Number(opt('port') ?? 4317);
const start = (p: number) =>
  createServer({ uiDir, store, port: p, host: opt('host') }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && p !== 0) return createServer({ uiDir, store, port: 0, host: opt('host') });
    throw e;
  });

const { url } = await start(port);
console.log(`Session Lens: ${url}  (${store.requests.size} requests across ${store.sessions.size} sessions)`);
if (!flag('no-open')) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const cargs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, cargs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
