import { attribute, sessionComposition, threadRequests } from './attribution.js';
import { account, billingPeriod, sanitizeSettings, type AccountInfo } from './account.js';
import { blockText } from './parse.js';
import { bundledPricing, deriveCache } from './pricing.js';
import { comparePrices, fetchPublishedPricing, type PublishedModel } from './published.js';
import { parseDailyPaste, referencePath, saveReference, usageView, type GroupBy } from './usage.js';
import type { Store } from './store.js';
import type { Settings } from './types.js';
import type { Request, Session } from './types.js';

export interface DayRow {
  day: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  requests: number;
  sessions: number;
  costByModel: Record<string, number>;
  costParts: { input: number; cacheWrite: number; cacheRead: number; output: number; side: number };
}

export interface SessionRow {
  id: string;
  project: string;
  title: string;
  firstTs: number;
  lastTs: number;
  models: string[];
  requests: number;
  subagents: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  /** Cost of the whole session, including requests outside the selected range. */
  totalCost: number;
  /** A Claude Code process for this session is running now. */
  live: boolean;
  peakContext: number;
  peakContextPct: number;
  /** Context size per main-thread request, for a sparkline. */
  spark: number[];
}

export interface Query {
  from?: string;
  to?: string;
  project?: string;
}

function dayFormatter(timeZone?: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (ts: number) => f.format(ts);
}

function inRange(day: string, q: Query) {
  return (!q.from || day >= q.from) && (!q.to || day <= q.to);
}

function shortModel(m: string) {
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export class Api {
  private day: (ts: number) => string;

  constructor(private store: Store) {
    this.day = dayFormatter(store.settings.timeZone);
  }

  private requestsIn(q: Query): Request[] {
    this.store.refresh();
    const out: Request[] = [];
    for (const r of this.store.requests.values()) {
      if (q.project && this.store.sessions.get(r.sessionId)?.project !== q.project) continue;
      if (inRange(this.day(r.ts), q)) out.push(r);
    }
    return out;
  }

  summary(q: Query) {
    const rows = new Map<string, DayRow & { _sessions: Set<string> }>();
    const reqs = this.requestsIn(q);
    for (const r of reqs) {
      const d = this.day(r.ts);
      let row = rows.get(d);
      if (!row) {
        row = { day: d, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, costParts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, side: 0 }, requests: 0, sessions: 0, costByModel: {}, _sessions: new Set() };
        rows.set(d, row);
      }
      row.input += r.usage.input;
      row.cacheWrite += r.usage.cacheWrite5m + r.usage.cacheWrite1h;
      row.cacheRead += r.usage.cacheRead;
      row.output += r.usage.output;
      row.cost += r.cost + r.side;
      row.costParts.side += r.side;
      const parts = this.store.pricer.costParts(r.model, r.usage);
      row.costParts.input += parts.input;
      row.costParts.cacheWrite += parts.cacheWrite;
      row.costParts.cacheRead += parts.cacheRead;
      row.costParts.output += parts.output;
      row.requests++;
      row._sessions.add(r.sessionId);
      const m = shortModel(r.model);
      row.costByModel[m] = (row.costByModel[m] ?? 0) + r.cost + r.side;
    }
    const days = [...rows.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(({ _sessions, ...row }) => ({ ...row, sessions: _sessions.size }));
    const totals = days.reduce(
      (t, d) => ({
        input: t.input + d.input,
        cacheWrite: t.cacheWrite + d.cacheWrite,
        cacheRead: t.cacheRead + d.cacheRead,
        output: t.output + d.output,
        cost: t.cost + d.cost,
        requests: t.requests + d.requests,
      }),
      { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, requests: 0 },
    );
    const all = [...this.store.requests.values()];
    const allDays = all.map((r) => this.day(r.ts)).sort();
    return {
      days,
      totals: { ...totals, sessions: new Set(reqs.map((r) => r.sessionId)).size },
      projects: [...new Set([...this.store.sessions.values()].map((s) => s.project))].sort(),
      models: [...new Set(reqs.map((r) => shortModel(r.model)))].sort(),
      range: { first: allDays[0], last: allDays[allDays.length - 1] },
      discount: this.store.pricer.discount,
      unknownModels: [...new Set(all.filter((r) => !r.priced).map((r) => r.model))],
      unpricedRequests: reqs.filter((r) => !r.priced).length,
      sideCost: sum(reqs, (r) => r.side),
      history: this.history(),
      live: this.liveSessions(),
    };
  }

  /** How far back transcripts go, and how far Claude Code keeps them (it deletes older ones). */
  history() {
    const ret = this.store.retention;
    let oldest = Infinity;
    for (const r of this.store.requests.values()) if (r.ts < oldest) oldest = r.ts;
    return {
      oldestDay: Number.isFinite(oldest) ? this.day(oldest) : undefined,
      retentionDays: ret.days,
      keptSince: this.day(ret.since),
    };
  }

  /** Sessions whose Claude Code process is running right now, most recently active first. */
  liveSessions() {
    const out = [];
    for (const [id, l] of this.store.live) {
      const s = this.store.sessions.get(id);
      const reqs = s ? this.store.sessionRequests(s) : [];
      const main = reqs.filter((r) => !r.agentId);
      const last = main[main.length - 1];
      out.push({
        id,
        title: s?.title ?? l.name ?? '(new session)',
        project: s?.project,
        entrypoint: l.entrypoint,
        pid: l.pid,
        lastTs: s?.lastTs ?? 0,
        cost: sum(reqs, (r) => r.cost + r.side),
        contextTokens: last?.contextTokens ?? 0,
        contextLimit: last?.contextLimit ?? 0,
        requests: reqs.length,
      });
    }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }

  sessions(q: Query): { sessions: SessionRow[] } {
    const byS = new Map<string, Request[]>();
    for (const r of this.requestsIn(q)) {
      const list = byS.get(r.sessionId) ?? [];
      list.push(r);
      byS.set(r.sessionId, list);
    }
    const rows: SessionRow[] = [];
    for (const [id, reqs] of byS) {
      const s = this.store.sessions.get(id);
      if (!s) continue;
      const all = this.store.sessionRequests(s);
      const main = reqs.filter((r) => !r.agentId).sort((a, b) => a.ts - b.ts);
      let peak = 0;
      let peakPct = 0;
      for (const r of reqs) {
        if (r.contextTokens > peak) {
          peak = r.contextTokens;
          peakPct = r.contextTokens / r.contextLimit;
        }
      }
      rows.push({
        id,
        project: s.project,
        title: s.title,
        firstTs: Math.min(...reqs.map((r) => r.ts)),
        lastTs: Math.max(...reqs.map((r) => r.ts)),
        models: [...new Set(reqs.map((r) => shortModel(r.model)))],
        requests: reqs.length,
        subagents: new Set(reqs.filter((r) => r.agentId).map((r) => r.agentId)).size,
        input: sum(reqs, (r) => r.usage.input),
        cacheWrite: sum(reqs, (r) => r.usage.cacheWrite5m + r.usage.cacheWrite1h),
        cacheRead: sum(reqs, (r) => r.usage.cacheRead),
        output: sum(reqs, (r) => r.usage.output),
        cost: sum(reqs, (r) => r.cost + r.side),
        totalCost: sum(all, (r) => r.cost + r.side),
        live: this.store.live.has(id),
        peakContext: peak,
        peakContextPct: peakPct,
        spark: main.map((r) => r.contextTokens),
      });
    }
    rows.sort((a, b) => b.cost - a.cost);
    return { sessions: rows };
  }

  session(id: string) {
    this.store.refresh();
    const s = this.store.sessions.get(id);
    if (!s) return undefined;
    const reqs = this.store.sessionRequests(s);
    const turns = this.turns(s, reqs);
    return {
      session: {
        id: s.id,
        project: s.project,
        cwd: s.cwd,
        title: s.title,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        reportedCostUSD: s.reportedCostUSD,
        cost: sum(reqs, (r) => r.cost + r.side),
        sideCost: s.sideCost,
        checkpoint: s.checkpoint,
        live: this.store.live.has(s.id),
        unpriced: reqs.filter((r) => !r.priced).length,
      },
      requests: reqs.map((r) => ({
        id: r.id,
        ts: r.ts,
        day: this.day(r.ts),
        model: shortModel(r.model),
        agentId: r.agentId,
        usage: r.usage,
        cost: r.cost,
        priced: r.priced,
        side: r.side,
        costParts: this.store.pricer.costParts(r.model, r.usage),
        contextTokens: r.contextTokens,
        contextLimit: r.contextLimit,
        tools: r.tools,
        promptId: r.promptId,
        stopReason: r.stopReason,
      })),
      turns,
      subagents: s.subagents
        .filter((a) => a.requestIds.length)
        .map((a) => {
          const rs = a.requestIds.map((rid) => this.store.requests.get(rid)!).filter(Boolean);
          return {
            agentId: a.agentId,
            agentType: a.agentType,
            description: a.description,
            toolUseId: a.toolUseId,
            requests: rs.length,
            cost: sum(rs, (r) => r.cost),
            firstTs: Math.min(...rs.map((r) => r.ts)),
            model: rs[0] ? shortModel(rs[0].model) : undefined,
          };
        }),
    };
  }

  /** A turn = one human prompt and every request (main + subagent) that answered it. */
  private turns(s: Session, reqs: Request[]) {
    const file = s.mainFile;
    const prompts = new Map<string, { text: string; ts: number }>();
    if (file) {
      const f = this.store.files.get(file);
      for (const r of f?.records ?? []) {
        if (r.type === 'user' && r.promptId && r.isHuman && !prompts.has(r.promptId)) {
          const p = r.pieces.find((x) => x.kind === 'prompt' || x.kind === 'meta');
          if (p) prompts.set(r.promptId, { text: p.label, ts: r.ts });
        }
      }
    }
    // Subagent requests belong to the turn of the parent's tool call that spawned them.
    const agentPrompt = new Map<string, string | undefined>();
    for (const a of s.subagents) {
      const parent = s.requestIds.map((id) => this.store.requests.get(id)!).find((r) => {
        const recs = r?.uuids.map((u) => this.store.record(r.file, u));
        return recs?.some((rec) => rec?.pieces.some((p) => p.toolUseId && p.toolUseId === a.toolUseId));
      });
      agentPrompt.set(a.agentId, parent?.promptId);
    }
    const groups = new Map<string, Request[]>();
    for (const r of reqs) {
      const key = (r.agentId ? agentPrompt.get(r.agentId) : r.promptId) ?? 'unknown';
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([promptId, rs]) => ({
        promptId,
        text: prompts.get(promptId)?.text ?? (promptId === 'unknown' ? '(no prompt found)' : '(prompt not in this file)'),
        ts: prompts.get(promptId)?.ts ?? rs[0].ts,
        requestIds: rs.map((r) => r.id),
        cost: sum(rs, (r) => r.cost),
        output: sum(rs, (r) => r.usage.output),
      }))
      .sort((a, b) => a.ts - b.ts);
  }

  request(id: string) {
    this.store.refresh();
    const r = this.store.requests.get(id);
    if (!r) return undefined;
    const a = attribute(this.store, id)!;
    const s = this.store.sessions.get(r.sessionId);
    const thread = threadRequests(this.store, r);
    const pos = thread.findIndex((x) => x.id === id);
    return {
      request: {
        id: r.id,
        ts: r.ts,
        model: shortModel(r.model),
        agentId: r.agentId,
        usage: r.usage,
        cost: r.cost,
        priced: r.priced,
        side: r.side,
        costParts: this.store.pricer.costParts(r.model, r.usage),
        contextTokens: r.contextTokens,
        contextLimit: r.contextLimit,
        tools: r.tools,
        stopReason: r.stopReason,
      },
      session: s ? { id: s.id, title: s.title, project: s.project } : undefined,
      thread: { index: pos, count: thread.length, prev: thread[pos - 1]?.id, next: thread[pos + 1]?.id },
      attribution: a,
    };
  }

  /** Raw text of one context item (a record uuid + block within the request's file). */
  raw(requestId: string, uuid: string, block: number): { text: string } | undefined {
    const r = this.store.requests.get(requestId);
    if (!r) return undefined;
    const rec = this.store.record(r.file, uuid);
    if (!rec) return undefined;
    const text = blockText(this.store.readRecord(r.file, rec), block);
    const LIMIT = 200_000;
    return { text: text.length > LIMIT ? text.slice(0, LIMIT) + `\n… (${text.length - LIMIT} more characters)` : text };
  }

  /** Detected login, saved overrides, and spend in the current billing period. */
  account(detect: () => AccountInfo = account) {
    this.store.refresh();
    const info = detect();
    const st = this.store.settings;
    const mode = st.billing ?? info.detected;
    const period = billingPeriod(new Date(), st.periodStartDay ?? 1);
    let cost = 0;
    for (const r of this.store.requests.values()) {
      const d = this.day(r.ts);
      if (d >= period.start && d <= period.end) cost += r.cost + r.side;
    }
    return {
      account: info,
      mode,
      overridden: st.billing != null,
      // The plan fee: what you typed under Plan…, else what the detected plan implies.
      planPrice: st.planPrice ?? info.impliedPlanPrice ?? null,
      planPriceSource: st.planPrice != null ? 'settings' : info.impliedPlanPrice != null ? 'plan' : null,
      settings: { billing: st.billing ?? 'auto', planPrice: st.planPrice ?? null, monthlyLimit: st.monthlyLimit ?? null, periodStartDay: st.periodStartDay ?? 1, discount: st.discount ?? 0 },
      period: { ...period, cost, projected: period.daysElapsed ? (cost / period.daysElapsed) * period.days : cost },
    };
  }

  /** Save a settings patch from the UI to the shared settings file and re-price everything. */
  updateSettings(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected a JSON object' };
    const raw = body as Record<string, unknown>;
    const patch = sanitizeSettings(raw);
    const next = { ...this.store.settings } as Record<string, unknown>;
    // Price edits merge per model (null removes the edit, restoring the layer underneath).
    if (raw.prices && typeof raw.prices === 'object') {
      const merged = { ...(this.store.settings.prices ?? {}) };
      for (const [id, v] of Object.entries(raw.prices as Record<string, unknown>)) {
        if (v === null) delete merged[id];
        else if (patch.prices?.[id]) merged[id] = { ...(merged[id] ?? {}), ...patch.prices[id] };
      }
      patch.prices = Object.keys(merged).length ? merged : undefined;
    }
    for (const [k, v] of Object.entries(patch)) (v === undefined ? delete next[k] : (next[k] = v));
    this.store.writeSettings(next as Settings);
    this.day = dayFormatter(this.store.settings.timeZone);
    return this.account();
  }

  /** The price table: every priced model, where its price came from, and whether your data uses it. */
  pricing() {
    this.store.refresh();
    const file = bundledPricing();
    const usage = new Map<string, { requests: number; lastTs: number; models: Set<string> }>();
    const unpriced = new Map<string, { requests: number; lastTs: number }>();
    for (const r of this.store.requests.values()) {
      const key = this.store.pricer.keyFor(r.model);
      if (!key) {
        const u = unpriced.get(r.model) ?? { requests: 0, lastTs: 0 };
        u.requests++;
        u.lastTs = Math.max(u.lastTs, r.ts);
        unpriced.set(r.model, u);
        continue;
      }
      const u = usage.get(key) ?? { requests: 0, lastTs: 0, models: new Set<string>() };
      u.requests++;
      u.lastTs = Math.max(u.lastTs, r.ts);
      u.models.add(r.model);
      usage.set(key, u);
    }
    const st = this.store.settings;
    return {
      checkedAt: file.checkedAt,
      sourceUrl: file.sourceUrl,
      webSearchPerRequest: file.webSearchPerRequest,
      appliedFromAnthropic: st.published?.fetchedAt,
      models: this.store.pricer.table().map((m) => ({
        ...m,
        bundled: file.models[m.id],
        edited: st.prices?.[m.id] ?? null,
        usage: usage.has(m.id) ? { requests: usage.get(m.id)!.requests, lastTs: usage.get(m.id)!.lastTs, ids: [...usage.get(m.id)!.models] } : null,
      })),
      unpriced: [...unpriced.entries()].map(([model, u]) => ({ model, ...u })),
      discount: st.discount ?? 0,
      modelDiscounts: st.modelDiscounts ?? {},
      defaults: deriveCache(1),
    };
  }

  /** Fetch Anthropic's pricing page and compare it with what is in effect. The only network request. */
  async checkPublished(fetchImpl?: typeof fetch) {
    const pub = await fetchPublishedPricing(fetchImpl);
    const pricer = this.store.pricer;
    const rows = comparePrices(pub.models, (id) => ({ price: pricer.price(id), known: pricer.isKnown(id) }));
    return { fetchedAt: pub.fetchedAt, url: pub.url, models: rows.map((r) => ({ ...r, source: pricer.sources[pricer.keyFor(r.id) ?? ''] ?? null })) };
  }

  /** Apply published prices (all, or the ones listed) as the "from Anthropic" layer. */
  applyPublished(body: unknown) {
    const b = (body ?? {}) as { models?: unknown; fetchedAt?: unknown };
    if (!Array.isArray(b.models)) return { error: 'expected { models: [...] }' };
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000;
    const layer = { ...(this.store.settings.published?.models ?? {}) };
    for (const m of b.models as PublishedModel[]) {
      if (!m || typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9.\-]*$/i.test(m.id)) continue;
      if (![m.input, m.output, m.cacheWrite5m, m.cacheWrite1h, m.cacheRead].every(ok)) continue;
      const context = this.store.pricer.price(m.id).context;
      layer[m.id] = { input: m.input, output: m.output, cacheWrite5m: m.cacheWrite5m, cacheWrite1h: m.cacheWrite1h, cacheRead: m.cacheRead, context };
    }
    const fetchedAt = typeof b.fetchedAt === 'string' ? b.fetchedAt : new Date().toISOString();
    // Applying is a choice to use Anthropic's price, so it replaces your edit of the same fields.
    const prices = { ...(this.store.settings.prices ?? {}) };
    for (const m of b.models as PublishedModel[]) {
      const e = m && typeof m.id === 'string' ? prices[m.id] : undefined;
      if (!e || !layer[m.id]) continue;
      const rest = Object.fromEntries(Object.entries(e).filter(([k]) => k === 'context'));
      if (Object.keys(rest).length) prices[m.id] = rest;
      else delete prices[m.id];
    }
    this.store.writeSettings({ ...this.store.settings, prices: Object.keys(prices).length ? prices : undefined, published: { fetchedAt, models: layer } });
    return this.pricing();
  }

  /** What Session Lens reads and where it keeps things, for the Settings page. */
  config() {
    const st = this.store.settings;
    return {
      roots: this.store.roots,
      configDirs: this.store.configDirs,
      retentionDays: this.store.retention.days,
      settingsPath: this.store.settingsPath,
      timeZone: st.timeZone ?? null,
      systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      transcripts: this.store.files.size,
      sessions: this.store.sessions.size,
      requests: this.store.requests.size,
      live: this.store.live.size,
    };
  }

  /** One entry point for every shell: HTTP server, VS Code message bridge, Electron. May return a promise. */
  handle(path: string, params: URLSearchParams, body?: unknown): unknown {
    const q: Query = { from: params.get('from') ?? undefined, to: params.get('to') ?? undefined, project: params.get('project') ?? undefined };
    switch (path) {
      case '/api/summary':
        return this.summary(q);
      case '/api/sessions':
        return this.sessions(q);
      case '/api/session':
        return this.session(params.get('id') ?? '') ?? { error: 'not found' };
      case '/api/request':
        return this.request(params.get('id') ?? '') ?? { error: 'not found' };
      case '/api/account':
        return this.account();
      case '/api/pricing':
        return this.pricing();
      case '/api/pricing/check':
        return body === undefined ? { error: 'POST to check' } : this.checkPublished().catch((e) => ({ error: String(e?.message ?? e) }));
      case '/api/pricing/apply':
        return body === undefined ? { error: 'POST { models }' } : this.applyPublished(body);
      case '/api/config':
        return this.config();
      case '/api/settings':
        return body === undefined ? { error: 'POST a JSON object' } : this.updateSettings(body);
      case '/api/usage':
        return usageView(this.store, {
          from: params.get('from') ?? undefined,
          to: params.get('to') ?? undefined,
          group: (params.get('group') as GroupBy) ?? undefined,
          interval: params.get('interval') === 'week' ? 'week' : 'day',
          project: params.get('project') ?? undefined,
        });
      case '/api/reference': {
        if (body === undefined || body === null || typeof body !== 'object') return { error: 'POST a JSON object' };
        const b = body as { paste?: unknown; year?: unknown; days?: Record<string, unknown> };
        const patch: Record<string, unknown> = { ...b };
        if (typeof b.paste === 'string') {
          const parsed = parseDailyPaste(b.paste, typeof b.year === 'number' ? b.year : new Date().getUTCFullYear());
          patch.days = { ...(b.days ?? {}), ...parsed };
          delete patch.paste;
        }
        saveReference(referencePath(this.store.settingsPath), patch);
        return { ok: true };
      }
      case '/api/composition':
        this.store.refresh();
        return { points: sessionComposition(this.store, params.get('id') ?? '') };
      case '/api/raw':
        return this.raw(params.get('request') ?? '', params.get('uuid') ?? '', Number(params.get('block') ?? 0)) ?? { error: 'not found' };
      default:
        return { error: `unknown endpoint ${path}` };
    }
  }
}

function sum<T>(xs: T[], f: (x: T) => number) {
  let n = 0;
  for (const x of xs) n += f(x);
  return n;
}
