import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { Api } from './api.js';
import { Store } from './store.js';

export interface ServerOptions {
  /** Directory holding the built dashboard (packages/ui/dist). */
  uiDir: string;
  store?: Store;
  /** Follow transcripts and push changes to open pages (default true). */
  live?: boolean;
  port?: number;
  host?: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

/** Local-only HTTP server: the JSON API plus the static dashboard. Binds to 127.0.0.1 by default. */
export function createServer(opts: ServerOptions): Promise<{ server: http.Server; url: string; api: Api }> {
  const owned = !opts.store;
  const store = opts.store ?? new Store();
  store.refresh(0);
  if (opts.live !== false) store.watch();
  const api = new Api(store);
  // Server-sent events: every open page hears about new data within a second and redraws in place.
  const listeners = new Set<http.ServerResponse>();
  const onChange = (e: { changeId: number }) => {
    for (const res of listeners) res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
  };
  store.on('change', onChange);
  const heartbeat = setInterval(() => {
    for (const res of listeners) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref?.();
  const host = opts.host ?? '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const server = http.createServer(async (req, res) => {
    try {
      // Bound to loopback, only answer requests addressed to loopback: blocks DNS-rebinding pages
      // from reading transcripts through this server.
      const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (loopback && !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ changeId: store.changeId })}\n\n`);
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        let payload: unknown;
        if (req.method === 'POST') {
          // Writes must be JSON (forces a CORS preflight a foreign page can't pass) from our own origin.
          const origin = req.headers.origin;
          const originHost = origin ? new URL(origin).hostname.replace(/^\[|\]$/g, '') : undefined;
          if (!(req.headers['content-type'] ?? '').startsWith('application/json') || (originHost && !['127.0.0.1', 'localhost', '::1'].includes(originHost))) {
            res.writeHead(403).end();
            return;
          }
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 65_536) {
              res.writeHead(413).end();
              return;
            }
          }
          try {
            payload = JSON.parse(raw || 'null');
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON' }));
            return;
          }
        } else if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        const body = JSON.stringify(await api.handle(url.pathname, url.searchParams, payload));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(body);
        return;
      }
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      if (rel.includes('..')) {
        res.writeHead(400).end();
        return;
      }
      const file = join(opts.uiDir, rel || 'index.html');
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(data);
      } catch {
        const data = await readFile(join(opts.uiDir, 'index.html'));
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(data);
      }
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.on('close', () => {
      clearInterval(heartbeat);
      store.off('change', onChange);
      for (const res of listeners) res.end();
      if (owned) store.close();
    });
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${host}:${port}/`, api });
    });
  });
}
