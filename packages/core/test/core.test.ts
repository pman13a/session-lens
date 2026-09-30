import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Api, parseUsage, configDirs, planPriceFor, parsePricingMarkdown, modelIdFromName, apportion, attribute, billingFor, billingPeriod, detectAccount, normalizeModel, parseDailyPaste, Pricer, sanitizeSettings, sessionComposition, Store, usageView, utcPeriod, utcWeek } from '../src/index.js';

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

describe('dashboard view (matches Claude’s usage page)', () => {
  function store(settingsPath = join(mkdtempSync(join(tmpdir(), 'sl-u-')), 'settings.json')) {
    const t = new Transcript('s1', { entrypoint: 'claude-vscode' });
    t.t = Date.parse('2026-09-01T23:30:00Z'); // 6:30 PM CDT Sep 1, but Sep 1 in UTC
    t.prompt('a');
    t.response('u1', usage(1_000_000, 0, 0, 0), [{ type: 'tool_use', id: 'k1', name: 'Skill', input: { skill: 'dataviz' } }]);
    t.t = Date.parse('2026-09-02T00:30:00Z'); // still Sep 1 in CDT, Sep 2 in UTC
    t.prompt('b');
    t.response('u2', usage(500_000, 0, 0, 0), [{ type: 'text', text: 'ok' }]);
    t.t = Date.parse('2026-08-20T12:00:00Z'); // prior period
    const early = new Transcript('s0');
    early.t = Date.parse('2026-08-20T12:00:00Z');
    early.prompt('c');
    early.response('u0', usage(250_000, 0, 0, 0), [{ type: 'text', text: 'ok' }]);
    const st = new Store({ roots: [writeProject({ 's1.jsonl': t.text(), 's0.jsonl': early.text() })], settings: {}, settingsPath });
    st.refresh(0);
    return st;
  }
  const NOW = Date.parse('2026-09-03T15:00:00Z');

  it('buckets by UTC day, fills empty days, and compares with the prior period', () => {
    const v = usageView(store(), { from: '2026-09-01', to: '2026-09-03' }, NOW);
    expect(v.buckets).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    const cc = v.series.find((s) => s.key === 'claude_code')!;
    expect(cc.values.map((x) => +x.toFixed(2))).toEqual([4, 2, 0]); // Opus 5.5 input $4/M
    expect(v.series.map((s) => s.key)).toEqual(['claude_code', 'chat', 'cowork', 'chrome']);
    expect(v.series.find((s) => s.key === 'chat')!.local).toBe(false);
    expect(v.range.prior).toEqual({ from: '2026-08-29', to: '2026-08-31', incomplete: false });
    // Reaching back past the oldest transcript is incomplete, not "−100%".
    const far = usageView(store(), { from: '2026-08-01', to: '2026-08-31' }, NOW);
    expect(far.range.prior.incomplete).toBe(true);
    expect(far.series.find((s) => s.key === 'claude_code')!.change).toBeNull();
  });

  it('groups by surface and rolls days into Monday weeks', () => {
    const v = usageView(store(), { from: '2026-08-17', to: '2026-09-03', group: 'surface', interval: 'week' }, NOW);
    expect(v.buckets).toEqual(['2026-08-17', '2026-08-24', '2026-08-31']);
    expect(v.series.map((s) => s.label).sort()).toEqual(['Unknown', 'VS Code']);
    expect(utcWeek('2026-09-06')).toBe('2026-08-31'); // Sunday → its Monday
  });

  it('resets at 00:00 UTC on the period start day and counts top skills through yesterday', () => {
    expect(utcPeriod(NOW)).toEqual({ start: '2026-09-01', end: '2026-09-30', resetsAt: '2026-10-01T00:00:00.000Z' });
    const v = usageView(store(), {}, NOW);
    expect(v.range.from).toBe('2026-09-01');
    expect(v.period.spent).toBeCloseTo(6);
    expect(v.skills).toEqual([{ name: 'dataviz', uses: 1, sessions: 1 }]);
  });

  it('parses daily figures pasted in the usual shapes', () => {
    expect(parseDailyPaste('2026-09-01 58.20\nSep 3: $22.10\n9/7, 22.4\nSeptember 17\t$1,054.00\ngarbage', 2026)).toEqual({
      '2026-09-01': 58.2,
      '2026-09-03': 22.1,
      '2026-09-07': 22.4,
      '2026-09-17': 1054,
    });
    // A row copied from a comparison sheet (day, Session Lens, dashboard): the dashboard is the last number.
    expect(parseDailyPaste('day\tSession Lens\tDashboard\n9/1/2026\t47.4755\t58.69\n9/2/2026\t0\t0', 2026)).toEqual({ '2026-09-01': 58.69, '2026-09-02': 0 });
  });

  it('stores the dashboard’s own figures next to ours', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sl-r-')), 'settings.json');
    const st = store(path);
    const api = new Api(st);
    api.handle('/api/reference', new URLSearchParams(), { period: { start: '2026-09-01', spent: 300.04, limit: 300 }, range: { key: '2026-09-01..2026-09-03', values: { claude_code: 5.5, chat: 1.25, evil: 9 } }, paste: 'Sep 1 3.80\nSep 2 1.70', year: 2026 });
    const v = usageView(st, { from: '2026-09-01', to: '2026-09-03' }, NOW);
    expect(v.reference.period).toEqual({ spent: 300.04, limit: 300 });
    expect(v.reference.range).toEqual({ claude_code: 5.5, chat: 1.25 });
    expect(v.reference.days).toEqual({ '2026-09-01': 3.8, '2026-09-02': 1.7 });
    expect(v.period.limit).toBe(300);
  });
});

describe('live updates', () => {
  function configDir() {
    const dir = mkdtempSync(join(tmpdir(), 'sl-live-'));
    mkdirSync(join(dir, 'projects', '-work-demo'), { recursive: true });
    return dir;
  }

  it('reads only what was appended, holding a half-written line and a split UTF-8 character', () => {
    const dir = configDir();
    const file = join(dir, 'projects', '-work-demo', 's1.jsonl');
    const t = new Transcript('s1');
    t.prompt('héllo wörld');
    t.response('l1', usage(10, 0, 100, 5), [{ type: 'text', text: 'first' }]);
    writeFileSync(file, t.text());
    const store = new Store({ roots: [join(dir, 'projects')], settings: {}, settingsPath: join(dir, 'sl.json') });
    store.refresh(0);
    expect(store.requests.size).toBe(1);
    t.lines = [];
    t.prompt('naïve café ✓');
    t.response('l2', usage(10, 100, 50, 5), [{ type: 'text', text: 'second' }]);
    const more = Buffer.from(t.text());
    const cut = more.indexOf(Buffer.from('✓')) + 1; // mid-character, mid-line
    appendFileSync(file, more.subarray(0, cut));
    store.refresh(0);
    expect(store.requests.size).toBe(1);
    appendFileSync(file, more.subarray(cut));
    store.refresh(0);
    expect(store.requests.size).toBe(2);
    const rec = [...store.files.values()][0].records.find((r) => r.type === 'user' && r.pieces[0]?.label.includes('café'))!;
    expect(rec.pieces[0].label).toBe('naïve café ✓');
    expect(JSON.parse(store.readRecord(file, rec)).message.content).toBe('naïve café ✓');
  });

  it('emits a change when a transcript grows, and when settings change on disk', async () => {
    const dir = configDir();
    const file = join(dir, 'projects', '-work-demo', 's1.jsonl');
    const t = new Transcript('s1');
    t.prompt('go');
    t.response('w1', usage(1_000_000, 0, 0, 0), [{ type: 'text', text: 'ok' }]);
    writeFileSync(file, t.text());
    const settingsPath = join(dir, 'lens', 'settings.json');
    const store = new Store({ roots: [join(dir, 'projects')], settingsPath }).watch(100);
    const next = () => new Promise<void>((resolve) => store.once('change', () => resolve()));
    try {
      expect(store.requests.size).toBe(1);
      let p = next();
      t.lines = [];
      t.response('w2', usage(1_000_000, 0, 0, 0), [{ type: 'text', text: 'more' }]);
      appendFileSync(file, t.text());
      await p;
      expect(store.requests.size).toBe(2);
      // Another shell saves a discount: this one reprices without a restart.
      p = next();
      mkdirSync(join(dir, 'lens'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ discount: 0.5 }));
      await p;
      expect(store.requests.get('w1')!.cost).toBeCloseTo(2);
    } finally {
      store.close();
    }
  });

  it('knows which sessions are running from the registry', () => {
    const dir = configDir();
    const t = new Transcript('s-live');
    t.prompt('go');
    t.response('r-live', usage(1, 0, 0, 1), [{ type: 'text', text: 'ok' }]);
    writeFileSync(join(dir, 'projects', '-work-demo', 's-live.jsonl'), t.text());
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's-live', entrypoint: 'cli' }));
    writeFileSync(join(dir, 'sessions', '999999.json'), JSON.stringify({ pid: 999999, sessionId: 's-dead' }));
    writeFileSync(join(dir, 'sessions', `${process.pid}.abc.key`), 'secret');
    const store = new Store({ roots: [join(dir, 'projects')], settings: {}, settingsPath: join(dir, 'sl.json') });
    store.tick();
    expect([...store.live.keys()]).toEqual(['s-live']);
    const api = new Api(store);
    expect(api.sessions({}).sessions[0].live).toBe(true);
    expect(api.summary({}).live.map((l) => l.id)).toEqual(['s-live']);
  });
});

describe('fixes from the claude-usage review', () => {
  it('reconciles side calls from Claude Code’s own cost-state checkpoint', () => {
    const t = new Transcript('s1');
    t.prompt('go');
    t.response('c1', usage(0, 1_000_000, 0, 0), [{ type: 'text', text: 'ok' }]); // $0.20 at Opus 5.5
    t.lines.push({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0.23 }); // Claude Code saw $0.03 more
    t.response('c2', usage(0, 1_000_000, 0, 0), [{ type: 'text', text: 'later' }]); // after the checkpoint
    const store = makeStore({ 's1.jsonl': t.text() });
    const s = store.sessions.get('s1')!;
    expect(s.sideCost).toBeCloseTo(0.03);
    expect(store.requests.get('c1')!.side).toBeCloseTo(0.03);
    expect(store.requests.get('c2')!.side).toBe(0);
    expect(new Api(store).summary({}).totals.cost).toBeCloseTo(0.43);
  });

  it('reconciles each run of the app separately (the total restarts when the app restarts)', () => {
    const t = new Transcript('s1');
    t.prompt('go');
    t.response('r1', usage(0, 1_000_000, 0, 0), [{ type: 'text', text: 'a' }]); // $0.20
    t.lines.push({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0.22 }); // run 1: $0.02 of side calls
    // The app restarts: its total starts again from zero.
    t.response('r2', usage(0, 2_000_000, 0, 0), [{ type: 'text', text: 'b' }]); // $0.40
    t.lines.push({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0.2 }); // mid-run checkpoint
    t.response('r3', usage(0, 1_000_000, 0, 0), [{ type: 'text', text: 'c' }]); // $0.20
    t.lines.push({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0.65 }); // run 2: $0.60 recorded, $0.05 side
    const store = makeStore({ 's1.jsonl': t.text() });
    const s = store.sessions.get('s1')!;
    expect(s.checkpoint).toMatchObject({ runs: 2, checkedRuns: 2 });
    expect(s.checkpoint!.claudeCodeUSD).toBeCloseTo(0.87);
    expect(s.sideCost).toBeCloseTo(0.07);
    expect(store.requests.get('r1')!.side).toBeCloseTo(0.02);
    expect(store.requests.get('r2')!.side + store.requests.get('r3')!.side).toBeCloseTo(0.05);
  });

  it('never guesses a price for an unknown model', () => {
    const t = new Transcript('s1');
    t.prompt('go');
    t.response('u1', usage(1000, 0, 0, 1000), [{ type: 'text', text: 'ok' }], 'gpt-9-turbo');
    const store = makeStore({ 's1.jsonl': t.text() });
    const r = store.requests.get('u1')!;
    expect(r.priced).toBe(false);
    expect(r.cost).toBe(0);
    const sum = new Api(store).summary({});
    expect(sum.unknownModels).toEqual(['gpt-9-turbo']);
    expect(sum.unpricedRequests).toBe(1);
  });

  it('applies per-model discounts, longest prefix first', () => {
    const p = new Pricer({ discount: 0.1, modelDiscounts: { 'claude-opus': 0.2, 'claude-opus-5-5': 0.5 } });
    const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, thinking: 0, webSearches: 0 };
    expect(p.cost('claude-opus-5-5', u)).toBeCloseTo(2);
    expect(p.cost('claude-opus-5', u)).toBeCloseTo(4);
    expect(p.cost('claude-sonnet-5-5', u)).toBeCloseTo(1.8);
    expect(p.listCost('claude-opus-5-5', u)).toBeCloseTo(4);
  });

  it('tells Max 5× from Max 20× by the rate-limit tier', () => {
    expect(planPriceFor('max', 'default_claude_max_20x')).toBe(200);
    expect(planPriceFor('max', 'default_claude_max_5x')).toBe(100);
    expect(planPriceFor('pro', undefined)).toBe(20);
    expect(planPriceFor('max', undefined)).toBeUndefined();
  });

  it('resolves config dirs like Claude Code, including XDG_CONFIG_HOME', () => {
    const env = { ...process.env };
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      process.env.XDG_CONFIG_HOME = '/x/cfg';
      expect(configDirs()[0]).toBe('/x/cfg/claude');
      process.env.CLAUDE_CONFIG_DIR = '/a, /b';
      expect(configDirs()).toEqual(['/a', '/b']);
    } finally {
      process.env = env;
    }
  });
});

describe('settings: prices from Anthropic', () => {
  const md = readFileSync(join(__dirname, 'fixtures', 'anthropic-pricing.md'), 'utf8');

  it('parses the published model price table', () => {
    const rows = parsePricingMarkdown(md);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['claude-opus-5-5']).toMatchObject({ input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 });
    expect(byId['claude-fable-5-1']).toMatchObject({ input: 10, cacheRead: 0.25, output: 50 });
    expect(byId['claude-3-5-haiku']).toMatchObject({ input: 0.8, output: 4 });
    expect(byId['claude-opus-4-1'].note).toMatch(/retired/);
    expect(modelIdFromName('Claude Sonnet 5.5')).toBe('claude-sonnet-5-5');
    expect(modelIdFromName('Claude Opus 4')).toBe('claude-opus-4');
  });

  it('agrees with the bundled table for every model it lists', () => {
    const p = new Pricer();
    for (const r of parsePricingMarkdown(md)) {
      const cur = p.price(r.id);
      expect([r.id, cur.input, cur.output, cur.cacheRead]).toEqual([r.id, r.input, r.output, r.cacheRead]);
    }
  });

  it('layers bundled → applied from Anthropic → your edits, and reset removes an edit', () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), 'sl-p-')), 'settings.json');
    const t = new Transcript('s1');
    t.prompt('go');
    t.response('p1', usage(1_000_000, 0, 0, 0), [{ type: 'text', text: 'ok' }], 'claude-nova-1');
    const store = new Store({ roots: [writeProject({ 's1.jsonl': t.text() })], settings: {}, settingsPath });
    store.refresh(0);
    const api = new Api(store);
    expect(api.pricing().unpriced.map((u) => u.model)).toEqual(['claude-nova-1']);
    // Anthropic publishes a new model and a price change.
    api.applyPublished({ fetchedAt: '2026-10-01T00:00:00Z', models: [
      { id: 'claude-nova-1', name: 'Claude Nova 1', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', input: 3, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
    ] });
    expect(store.requests.get('p1')!.cost).toBeCloseTo(3);
    const rows = Object.fromEntries(api.pricing().models.map((m) => [m.id, m]));
    expect(rows['claude-nova-1'].source).toBe('anthropic');
    expect(rows['claude-opus-5-5'].price.input).toBe(3);
    expect(rows['claude-haiku-4-5'].source).toBe('bundled');
    // Your edit wins, and reset brings back the Anthropic layer.
    api.updateSettings({ prices: { 'claude-nova-1': { input: 2 } } });
    expect(store.requests.get('p1')!.cost).toBeCloseTo(2);
    expect(Object.fromEntries(api.pricing().models.map((m) => [m.id, m.source]))['claude-nova-1']).toBe('custom');
    api.updateSettings({ prices: { 'claude-nova-1': null } });
    expect(store.requests.get('p1')!.cost).toBeCloseTo(3);
    // Applying Anthropic's price over your edit replaces the edited price fields, keeps a context edit.
    api.updateSettings({ prices: { 'claude-nova-1': { input: 2, context: 500_000 } } });
    api.applyPublished({ models: [{ id: 'claude-nova-1', name: 'Claude Nova 1', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 }] });
    expect(store.requests.get('p1')!.cost).toBeCloseTo(3);
    expect(store.settings.prices).toEqual({ 'claude-nova-1': { context: 500_000 } });
    api.updateSettings({ prices: { 'claude-nova-1': null } });
    // Junk is refused.
    api.updateSettings({ prices: { 'bad id!': { input: 1 }, 'claude-x': { input: -5 } }, timeZone: 'Mars/Olympus' });
    expect(Object.keys(store.settings.prices ?? {})).toEqual([]);
    expect(store.settings.timeZone).toBeUndefined();
  });

  it('a new model priced by hand gets the standard cache multipliers', () => {
    const p = new Pricer({ prices: { 'claude-nova-2': { input: 2, output: 10 } } });
    expect(p.price('claude-nova-2')).toMatchObject({ input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 });
    expect(p.sources['claude-nova-2']).toBe('custom');
  });
});

describe('who made each call', () => {
  function session() {
    const t = new Transcript('s1');
    t.prompt('fix the build');
    t.response('r1', usage(5, 0, 3000, 50), [{ type: 'tool_use', id: 'tb', name: 'Bash', input: { command: 'npm test' } }]);
    t.toolResult('tb', 'FAIL x'.repeat(200));
    t.response('r2', usage(5, 3000, 600, 50), [{ type: 'tool_use', id: 'ta', name: 'Agent', input: { description: 'find the bug', prompt: 'look' } }]);
    t.toolResult('ta', 'the bug is in parse.ts '.repeat(40));
    t.response('r3', usage(5, 3600, 400, 80), [{ type: 'text', text: 'Fixed it.' }]);
    // A background task finishing wakes Claude with no message from you.
    t.lines.push({ type: 'user', uuid: 'tn', parentUuid: t.last, isMeta: true, origin: { kind: 'task-notification' }, timestamp: new Date((t.t += 1000)).toISOString(), sessionId: 's1', message: { role: 'user', content: '<task-notification>done</task-notification>' } });
    t.last = 'tn';
    t.response('r4', usage(5, 4000, 100, 20), [{ type: 'text', text: 'The build finished.' }]);
    const sub = new Transcript('s1', { isSidechain: true, agentId: 'a1' });
    sub.prompt('look');
    sub.response('rs', usage(5, 0, 900, 40), [{ type: 'text', text: 'found it' }]);
    return makeStore({
      's1.jsonl': t.text(),
      's1/subagents/agent-a1.jsonl': sub.text(),
      's1/subagents/agent-a1.meta.json': JSON.stringify({ agentType: 'Explore', description: 'find the bug', toolUseId: 'ta' }),
    });
  }

  it('tells your prompt, Claude’s iterations, the final answer, subagents and automatic calls apart', () => {
    const store = session();
    const role = (id: string) => store.requests.get(id)!.role;
    expect(['r1', 'r2', 'r3', 'r4', 'rs'].map(role)).toEqual(['prompt', 'iteration', 'answer', 'auto', 'subagent']);
    expect(store.requests.get('r2')!.trigger).toEqual(['Bash']);
    expect(store.requests.get('r4')!.trigger).toEqual(['task-notification']);
    expect(store.sessions.get('s1')!.subagents[0].launchedBy).toBe('r2');
    const api = new Api(store);
    const d = api.session('s1')!;
    expect(Object.keys(d.session.byRole).sort()).toEqual(['answer', 'auto', 'iteration', 'prompt', 'subagent']);
    expect(api.request('r2')!.request.launched.map((x) => x.agentType)).toEqual(['Explore']);
  });

  it('labels each line item by who put it in the context', () => {
    const store = session();
    const a = attribute(store, 'r3')!;
    const result = (tool: string) => a.items.find((i) => i.kind === 'tool_result' && i.toolName === tool)!.origin;
    expect(a.items.find((i) => i.kind === 'prompt')!.origin).toBe('you');
    expect(result('Bash')).toBe('tool');
    expect(result('Agent')).toBe('subagent');
    expect(a.items.find((i) => i.kind === 'baseline')!.origin).toBe('system');
    expect(a.items.filter((i) => i.kind === 'tool_use').every((i) => i.origin === 'claude')).toBe(true);
    const point = sessionComposition(store, 's1').find((p) => p.id === 'r3')!;
    expect(Object.values(point.byOrigin).reduce((x, y) => x + (y ?? 0), 0)).toBe(point.total);
  });
});

describe('what the dashboard bills that top-level usage leaves out', () => {
  const base = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
  const p = new Pricer();
  const plain = p.cost('claude-opus-5-5', parseUsage(base));

  it('adds compaction iterations, which the top-level counts exclude', () => {
    const u = parseUsage({ ...base, iterations: [{ type: 'compaction', input_tokens: 180_000, output_tokens: 3500 }, { type: 'message', ...base }] });
    expect(u.compaction).toMatchObject({ input: 180_000, output: 3500 });
    expect(u.input).toBe(10); // the context window itself is unchanged
    expect(p.cost('claude-opus-5-5', u) - plain).toBeCloseTo((180_000 * 4 + 3500 * 20) / 1e6);
  });

  it('bills fast mode at the fast rates, cache included', () => {
    const u = parseUsage({ ...base, speed: 'fast' });
    expect(p.cost('claude-opus-5-5', u)).toBeCloseTo(plain * 2);
    // Opus 4.7 has no fast mode: standard rates.
    expect(p.cost('claude-opus-4-7', u)).toBeCloseTo(p.cost('claude-opus-4-7', parseUsage(base)));
  });

  it('bills US-only inference at 1.1×, stacked on fast mode', () => {
    expect(p.cost('claude-opus-5-5', parseUsage({ ...base, inference_geo: 'us' }))).toBeCloseTo(plain * 1.1);
    expect(p.cost('claude-opus-5-5', parseUsage({ ...base, inference_geo: 'global' }))).toBeCloseTo(plain);
    expect(p.cost('claude-opus-5-5', parseUsage({ ...base, inference_geo: 'us', speed: 'fast' }))).toBeCloseTo(plain * 2.2);
    const parts = p.costParts('claude-opus-5-5', parseUsage({ ...base, inference_geo: 'us', speed: 'fast' }));
    expect(parts.input + parts.cacheWrite + parts.cacheRead + parts.output).toBeCloseTo(plain * 2.2);
  });
});
