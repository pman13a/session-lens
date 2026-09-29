import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Api, apportion, attribute, billingFor, billingPeriod, detectAccount, normalizeModel, Pricer, sanitizeSettings, sessionComposition, Store } from '../src/index.js';

/* ---------- fixture builder ---------- */

let n = 0;
const uid = () => `u${++n}`;
const T0 = Date.parse('2026-09-01T10:00:00Z');

interface Line {
  [k: string]: unknown;
}

class Transcript {
  lines: Line[] = [];
  last: string | null = null;
  t = T0;
  constructor(
    public sessionId: string,
    public extra: Line = {},
  ) {}
  private push(l: Line) {
    this.t += 1000;
    const uuid = uid();
    this.lines.push({ uuid, parentUuid: this.last, timestamp: new Date(this.t).toISOString(), sessionId: this.sessionId, cwd: '/work/demo', ...this.extra, ...l });
    this.last = uuid;
    return uuid;
  }
  prompt(text: string, promptId = uid()) {
    return this.push({ type: 'user', promptId, origin: { kind: 'human' }, message: { role: 'user', content: text } });
  }
  toolResult(id: string, text: string) {
    return this.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  }
  attachment(type: string, text: string) {
    return this.push({ type: 'attachment', attachment: { type }, rendered: [{ content: text }] });
  }
  /** One API response, written as one record per content block (as Claude Code does). */
  response(requestId: string, usage: Line, blocks: Line[], model = 'claude-opus-5-5') {
    for (const b of blocks) this.push({ type: 'assistant', requestId, message: { id: `msg_${requestId}`, model, role: 'assistant', content: [b], usage, stop_reason: 'end_turn' } });
  }
  text() {
    return this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }
}

const usage = (input: number, read: number, write: number, output: number, extra: Line = {}) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
  output_tokens: output,
  ...extra,
});

function writeProject(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'session-lens-'));
  const proj = join(root, '-work-demo');
  mkdirSync(proj, { recursive: true });
  let t = Date.now() / 1000 - 1000;
  for (const [name, text] of Object.entries(files)) {
    const p = join(proj, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
    utimesSync(p, t, t++);
  }
  return root;
}

function makeStore(files: Record<string, string>) {
  const store = new Store({ roots: [writeProject(files)], settings: { timeZone: 'UTC' } });
  store.refresh(0);
  return store;
}

/* ---------- tests ---------- */

describe('pricing', () => {
  it('reproduces Claude Code’s own cost-state figure for Opus 5.5', () => {
    // From a real cost-state record: 42 in, 9527 out, 2,096,412 cache read, 103,421 1h cache write → $1.4373584
    const p = new Pricer();
    const cost = p.cost('claude-opus-5-5', { input: 42, output: 9527, cacheRead: 2096412, cacheWrite1h: 103421, cacheWrite5m: 0, thinking: 0, webSearches: 0 });
    expect(cost).toBeCloseTo(1.4373584, 6);
  });

  it('prices Haiku web searches like Claude Code does', () => {
    const p = new Pricer();
    const cost = p.cost('claude-haiku-4-5-20251001', { input: 23173, output: 932, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, thinking: 0, webSearches: 2 });
    expect(cost).toBeCloseTo(0.047833, 6);
  });

  it('matches the longest id prefix and ignores date suffixes and [1m]', () => {
    const p = new Pricer();
    expect(normalizeModel('claude-sonnet-4-5-20250929[1m]')).toBe('claude-sonnet-4-5');
    expect(p.price('claude-opus-5-5').input).toBe(4);
    expect(p.price('claude-opus-5').input).toBe(5);
    expect(p.price('claude-opus-4-1-20250805').input).toBe(15);
    expect(p.price('claude-haiku-4-5-20251001').context).toBe(200000);
    expect(p.isKnown('gpt-9')).toBe(false);
  });

  it('applies settings overrides and discount', () => {
    const p = new Pricer({ discount: 0.25, prices: { 'claude-opus-5-5': { input: 8 } } });
    const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, thinking: 0, webSearches: 0 };
    expect(p.cost('claude-opus-5-5', u)).toBeCloseTo(6);
  });
});

describe('apportion', () => {
  it('always sums to the total exactly', () => {
    for (const total of [0, 1, 7, 1000, 123457]) {
      const out = apportion(total, [3, 1, 4, 1, 5, 9, 2, 6]);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(apportion(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('store', () => {
  it('counts a response split across several records once', () => {
    const t = new Transcript('s1');
    t.prompt('hello');
    t.response('req_a', usage(10, 0, 5000, 300), [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi there' }]);
    const store = makeStore({ 's1.jsonl': t.text() });
    expect(store.requests.size).toBe(1);
    const r = store.requests.get('req_a')!;
    expect(r.uuids).toHaveLength(2);
    expect(r.contextTokens).toBe(5010);
  });

  it('deduplicates request ids ACROSS files: a fork copies its parent’s history', () => {
    const a = new Transcript('parent');
    a.prompt('first');
    a.response('req_1', usage(5, 0, 1000, 100), [{ type: 'text', text: 'one' }]);
    a.prompt('second');
    a.response('req_2', usage(5, 1000, 500, 100), [{ type: 'text', text: 'two' }]);
    // The fork re-writes both parent requests, then continues.
    const fork = new Transcript('child');
    fork.lines = a.lines.map((l) => ({ ...l, sessionId: 'child' }));
    fork.last = a.last;
    fork.t = a.t + 60_000;
    fork.prompt('forked question');
    fork.response('req_3', usage(5, 1500, 200, 50), [{ type: 'text', text: 'three' }]);
    const store = makeStore({ 'parent.jsonl': a.text(), 'child.jsonl': fork.text() });
    expect(store.requests.size).toBe(3);
    expect(store.requests.get('req_1')!.sessionId).toBe('parent');
    expect(store.requests.get('req_3')!.sessionId).toBe('child');
    const total = [...store.requests.values()].reduce((s, r) => s + r.cost, 0);
    const naive = 2 * (store.requests.get('req_1')!.cost + store.requests.get('req_2')!.cost) + store.requests.get('req_3')!.cost;
    expect(total).toBeLessThan(naive);
  });

  it('ignores <synthetic> records', () => {
    const t = new Transcript('s1');
    t.prompt('hello');
    t.response('req_a', usage(10, 0, 100, 10), [{ type: 'text', text: 'ok' }]);
    t.lines.push({ type: 'assistant', uuid: uid(), parentUuid: t.last, timestamp: new Date(t.t + 5000).toISOString(), sessionId: 's1', message: { id: 'x', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: usage(0, 0, 0, 0) } });
    const store = makeStore({ 's1.jsonl': t.text() });
    expect(store.requests.size).toBe(1);
  });

  it('attaches subagent transcripts to their parent session', () => {
    const main = new Transcript('s1');
    main.prompt('go');
    main.response('req_m', usage(5, 0, 2000, 100), [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'look around', prompt: 'x' } }]);
    const sub = new Transcript('s1', { isSidechain: true, agentId: 'abc' });
    sub.prompt('look around');
    sub.response('req_s', usage(5, 0, 900, 40), [{ type: 'text', text: 'found it' }], 'claude-haiku-4-5-20251001');
    const store = makeStore({
      's1.jsonl': main.text(),
      's1/subagents/agent-abc.jsonl': sub.text(),
      's1/subagents/agent-abc.meta.json': JSON.stringify({ agentType: 'Explore', description: 'look around', toolUseId: 'toolu_1' }),
    });
    const s = store.sessions.get('s1')!;
    expect(s.requestIds).toEqual(['req_m']);
    expect(s.subagents[0]).toMatchObject({ agentId: 'abc', agentType: 'Explore', requestIds: ['req_s'] });
    const api = new Api(store);
    const detail = api.session('s1')!;
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].requestIds.sort()).toEqual(['req_m', 'req_s']);
  });

  it('buckets days in the configured time zone', () => {
    const t = new Transcript('s1');
    t.t = Date.parse('2026-09-01T23:30:00Z');
    t.prompt('late');
    t.response('req_a', usage(10, 0, 100, 10), [{ type: 'text', text: 'ok' }]);
    const store = new Store({ roots: [writeProject({ 's1.jsonl': t.text() })], settings: { timeZone: 'Asia/Tokyo' } });
    store.refresh(0);
    expect(new Api(store).summary({}).days.map((d) => d.day)).toEqual(['2026-09-02']);
  });
});

describe('attribution', () => {
  function conversation() {
    const t = new Transcript('s1');
    t.attachment('skill_listing', 'x'.repeat(4000));
    t.prompt('read the file please');
    t.response('r1', usage(5, 0, 20000, 100), [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/demo/big.ts' } }]);
    t.toolResult('t1', 'y'.repeat(30000));
    t.response('r2', usage(5, 20000, 10000, 200), [{ type: 'tool_use', id: 't2', name: 'ToolSearch', input: { query: 'select:WebFetch' } }]);
    t.toolResult('t2', 'loaded');
    // ToolSearch loads schemas into the tool list: +8000 measured tokens that no transcript line explains.
    t.response('r3', usage(5, 30000, 8100, 200), [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls', description: 'List files' } }]);
    t.toolResult('t3', 'z'.repeat(9000));
    t.response('r4', usage(5, 38100, 3000, 80), [{ type: 'text', text: 'done' }]);
    t.toolResult('t9', 'w'.repeat(6000));
    t.response('r5', usage(5, 41100, 2000, 80), [{ type: 'text', text: 'really done' }]);
    return makeStore({ 's1.jsonl': t.text() });
  }

  it('line items sum exactly to the measured input of every request', () => {
    const store = conversation();
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      const a = attribute(store, id)!;
      expect(a.items.reduce((s, i) => s + i.tokens, 0)).toBe(a.measuredInput);
      expect(a.output.reduce((s, i) => s + i.tokens, 0)).toBe(store.requests.get(id)!.usage.output);
    }
  });

  it('measures the baseline once and keeps it fixed', () => {
    const store = conversation();
    const base = attribute(store, 'r1')!.baselineTokens;
    expect(base).toBeGreaterThan(0);
    for (const id of ['r2', 'r3', 'r4', 'r5']) expect(attribute(store, id)!.baselineTokens).toBe(base);
  });

  it('puts growth the transcript cannot explain on the step where it happened', () => {
    const store = conversation();
    const a = attribute(store, 'r5')!;
    const un = a.items.filter((i) => i.kind === 'unattributed');
    expect(un.length).toBeGreaterThan(0);
    const biggest = un.sort((x, y) => y.tokens - x.tokens)[0];
    expect(biggest.label).toContain('ToolSearch');
  });

  it('flags what each turn added', () => {
    const store = conversation();
    const a = attribute(store, 'r4')!;
    const added = a.items.filter((i) => i.added && i.kind !== 'unattributed');
    expect(added.map((i) => i.kind).sort()).toEqual(['tool_result', 'tool_use']);
    expect(a.items.find((i) => i.kind === 'tool_result' && i.label === 'Bash')?.detail).toBe('List files');
  });
});

describe('server', () => {
  it('serves the API on loopback and refuses other Host headers (DNS rebinding)', async () => {
    const { createServer } = await import('../src/index.js');
    const http = await import('node:http');
    const t = new Transcript('s1');
    t.prompt('hi');
    t.response('req_a', usage(10, 0, 100, 10), [{ type: 'text', text: 'ok' }]);
    const store = new Store({ roots: [writeProject({ 's1.jsonl': t.text() })], settings: { timeZone: 'UTC' }, settingsPath: join(mkdtempSync(join(tmpdir(), 'sl-')), 'settings.json') });
    const ui = mkdtempSync(join(tmpdir(), 'session-lens-ui-'));
    writeFileSync(join(ui, 'index.html'), '<!doctype html><title>x</title>');
    const { server, url } = await createServer({ uiDir: ui, store, port: 0 });
    const port = new URL(url).port;
    const get = (host: string, path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          })
          .on('error', reject);
      });
    try {
      const ok = await get(`127.0.0.1:${port}`, '/api/summary');
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).totals.requests).toBe(1);
      expect((await get(`localhost:${port}`, '/')).status).toBe(200);
      expect((await get(`evil.example:${port}`, '/api/summary')).status).toBe(403);
      expect((await get(`127.0.0.1:${port}`, '/../../etc/passwd')).body).toContain('<title>x</title>');
      const post = (headers: Record<string, string>, body: string) =>
        new Promise<number>((resolve, reject) => {
          const r = http.request({ host: '127.0.0.1', port, path: '/api/settings', method: 'POST', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          r.on('error', reject);
          r.end(body);
        });
      // A cross-site "simple" POST (text/plain, foreign Origin) must not change settings.
      expect(await post({ 'content-type': 'text/plain', origin: 'https://evil.example' }, '{"billing":"api"}')).toBe(403);
      expect(await post({ 'content-type': 'application/json', origin: 'https://evil.example' }, '{"billing":"api"}')).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('context composition over time', () => {
  it('splits every request’s measured input by kind, summing exactly', () => {
    const t = new Transcript('s1');
    t.attachment('skill_listing', 'x'.repeat(3000));
    t.prompt('go');
    t.response('c1', usage(5, 0, 10000, 50), [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }]);
    t.toolResult('t1', 'y'.repeat(20000));
    t.response('c2', usage(5, 10000, 9000, 50), [{ type: 'text', text: 'done' }]);
    const store = makeStore({ 's1.jsonl': t.text() });
    const pts = sessionComposition(store, 's1');
    expect(pts.map((p) => p.id)).toEqual(['c1', 'c2']);
    for (const p of pts) expect(Object.values(p.byKind).reduce((a, b) => a + (b ?? 0), 0)).toBe(p.total);
    expect(pts[1].byKind.tool_result ?? 0).toBeGreaterThan(pts[0].byKind.tool_result ?? 0);
  });
});

describe('billing', () => {
  it('maps the logged-in account to a billing mode', () => {
    expect(billingFor({ authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }).mode).toBe('subscription');
    expect(billingFor({ authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'enterprise', orgName: 'Acme' })).toEqual({ mode: 'team', label: 'Enterprise · Acme' });
    expect(billingFor({ authMethod: 'api_key', apiProvider: 'firstParty' }).mode).toBe('api');
    expect(billingFor({ authMethod: 'none', apiProvider: 'bedrock' }).mode).toBe('api');
  });

  it('reads `claude auth status --json`, and falls back when the CLI is missing', () => {
    const cli = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', orgId: 'o', orgName: 'Me', subscriptionType: 'pro' });
    const a = detectAccount(() => cli);
    expect(a).toMatchObject({ source: 'claude-cli', detected: 'subscription', label: 'Pro plan', subscriptionType: 'pro' });
    const b = detectAccount(() => undefined);
    expect(['config', 'none']).toContain(b.source);
  });

  it('only accepts known settings with sane values', () => {
    expect(sanitizeSettings({ billing: 'team', planPrice: 200, evil: 1, periodStartDay: 40 })).toEqual({ billing: 'team', planPrice: 200, periodStartDay: undefined });
    expect(sanitizeSettings({ billing: 'auto' })).toEqual({ billing: undefined });
    expect(sanitizeSettings({ billing: 'free-money' })).toEqual({ billing: undefined });
  });

  it('computes the billing period around today', () => {
    expect(billingPeriod(new Date(2026, 8, 29), 1)).toMatchObject({ start: '2026-09-01', end: '2026-09-30', days: 30, daysElapsed: 29 });
    expect(billingPeriod(new Date(2026, 8, 10), 15)).toMatchObject({ start: '2026-08-15', end: '2026-09-14', days: 31 });
  });

  it('saves overrides from the UI and reports spend in the period', () => {
    const t = new Transcript('s1');
    t.t = Date.now() - 60_000;
    t.prompt('hi');
    t.response('b1', usage(1_000_000, 0, 0, 0), [{ type: 'text', text: 'ok' }]);
    const settingsPath = join(mkdtempSync(join(tmpdir(), 'session-lens-settings-')), 'settings.json');
    const store = new Store({ roots: [writeProject({ 's1.jsonl': t.text() })], settings: {}, settingsPath });
    store.refresh(0);
    const api = new Api(store);
    const res = api.updateSettings({ billing: 'subscription', planPrice: 100, discount: 0.5 }) as { mode: string; settings: { planPrice: number }; period: { cost: number } };
    expect(res.mode).toBe('subscription');
    expect(res.settings.planPrice).toBe(100);
    expect(res.period.cost).toBeCloseTo(2); // 1M Opus 5.5 input at $4, half off
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ billing: 'subscription', planPrice: 100, discount: 0.5 });
    const back = api.updateSettings({ billing: 'auto' }) as { overridden: boolean };
    expect(back.overridden).toBe(false);
  });
});
