import { attribute, threadRequests } from './attribution.js';
import { blockText } from './parse.js';
import type { Store } from './store.js';
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
  costParts: { input: number; cacheWrite: number; cacheRead: number; output: number };
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
        row = { day: d, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, costParts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, requests: 0, sessions: 0, costByModel: {}, _sessions: new Set() };
        rows.set(d, row);
      }
      row.input += r.usage.input;
      row.cacheWrite += r.usage.cacheWrite5m + r.usage.cacheWrite1h;
      row.cacheRead += r.usage.cacheRead;
      row.output += r.usage.output;
      row.cost += r.cost;
      const parts = this.store.pricer.costParts(r.model, r.usage);
      row.costParts.input += parts.input;
      row.costParts.cacheWrite += parts.cacheWrite;
      row.costParts.cacheRead += parts.cacheRead;
      row.costParts.output += parts.output;
      row.requests++;
      row._sessions.add(r.sessionId);
      const m = shortModel(r.model);
      row.costByModel[m] = (row.costByModel[m] ?? 0) + r.cost;
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
      unknownModels: [...new Set(all.map((r) => r.model).filter((m) => !this.store.pricer.isKnown(m)))],
    };
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
        if (r.contextTokens > peak) peak = r.contextTokens;
        peakPct = Math.max(peakPct, r.contextTokens / r.contextLimit);
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
        cost: sum(reqs, (r) => r.cost),
        totalCost: sum(all, (r) => r.cost),
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
        cost: sum(reqs, (r) => r.cost),
      },
      requests: reqs.map((r) => ({
        id: r.id,
        ts: r.ts,
        day: this.day(r.ts),
        model: shortModel(r.model),
        agentId: r.agentId,
        usage: r.usage,
        cost: r.cost,
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
    const text = blockText(this.store.readLine(r.file, rec.line), block);
    const LIMIT = 200_000;
    return { text: text.length > LIMIT ? text.slice(0, LIMIT) + `\n… (${text.length - LIMIT} more characters)` : text };
  }

  /** One entry point for every shell: HTTP server, VS Code message bridge, Electron. */
  handle(path: string, params: URLSearchParams): unknown {
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
