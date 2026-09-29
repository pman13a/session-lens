/**
 * The "dashboard view": the same numbers, grouping and date conventions as Claude's own usage page
 * (Enterprise/Team "Your usage limits"), so the two can be compared side by side.
 *
 * Conventions copied from that page: dates are UTC days, the spend period is a UTC month that resets
 * at 00:00 UTC, "vs prior period" compares with the same number of days immediately before.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Store } from './store.js';
import type { Request } from './types.js';

export const PRODUCTS = [
  { key: 'claude_code', label: 'Claude Code' },
  { key: 'chat', label: 'Chat' },
  { key: 'cowork', label: 'Cowork' },
  { key: 'chrome', label: 'Claude in Chrome' },
] as const;
export type ProductKey = (typeof PRODUCTS)[number]['key'];

export type GroupBy = 'product' | 'model' | 'project' | 'surface';

const SURFACES: Record<string, string> = {
  cli: 'Terminal',
  'claude-vscode': 'VS Code',
  'claude-jetbrains': 'JetBrains',
  'claude-desktop': 'Desktop app',
  remote_mobile: 'Remote / mobile',
  remote: 'Remote',
  'sdk-cli': 'Agent SDK',
  'sdk-ts': 'Agent SDK',
  'sdk-py': 'Agent SDK',
};
export const surfaceLabel = (e?: string) => (e ? SURFACES[e] ?? e : 'Unknown');

/* ---------- UTC date helpers ---------- */

const DAY = 86_400_000;
export const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const parseDay = (d: string) => Date.parse(d + 'T00:00:00Z');
const addDays = (d: string, n: number) => utcDay(parseDay(d) + n * DAY);
/** Monday of the UTC week containing `d`. */
export const utcWeek = (d: string) => addDays(d, -((new Date(parseDay(d)).getUTCDay() + 6) % 7));

/** The UTC spend period containing `now`, starting on `startDay` of the month at 00:00 UTC. */
export function utcPeriod(now: number, startDay = 1) {
  const n = new Date(now);
  const sd = Math.min(Math.max(Math.round(startDay), 1), 28);
  let start = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), sd);
  if (start > now) start = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, sd);
  const s = new Date(start);
  const end = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, sd);
  return { start: utcDay(start), end: utcDay(end - DAY), resetsAt: new Date(end).toISOString() };
}

/* ---------- figures read off the real dashboard, typed in by the user ---------- */

export interface Reference {
  /** Per spend period (keyed by its start day): the header "$X of $Y spent". */
  periods?: Record<string, { spent?: number; limit?: number }>;
  /** Per selected range (`from..to`): the product table's Spend column. */
  ranges?: Record<string, Partial<Record<ProductKey, number>>>;
  /** Per UTC day: Claude Code spend read off the daily chart. */
  days?: Record<string, number>;
}

export function referencePath(settingsPath: string) {
  return join(dirname(settingsPath), 'reference.json');
}

export function loadReference(path: string): Reference {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Reference;
  } catch {
    return {};
  }
}

const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : undefined);

/** Merge a patch from the UI. `null` clears a value. Only known keys and sane numbers are kept. */
export function saveReference(path: string, patch: unknown): Reference {
  const cur = loadReference(path);
  if (!patch || typeof patch !== 'object') return cur;
  const p = patch as Record<string, unknown>;
  const isDay = (k: string) => /^\d{4}-\d{2}-\d{2}$/.test(k);
  if (p.period && typeof p.period === 'object') {
    const { start, spent, limit } = p.period as Record<string, unknown>;
    if (typeof start === 'string' && isDay(start)) {
      cur.periods ??= {};
      const entry = { ...(cur.periods[start] ?? {}) };
      if (spent !== undefined) (spent === null ? delete entry.spent : (entry.spent = money(spent)));
      if (limit !== undefined) (limit === null ? delete entry.limit : (entry.limit = money(limit)));
      cur.periods[start] = entry;
    }
  }
  if (p.range && typeof p.range === 'object') {
    const { key, values } = p.range as { key?: unknown; values?: Record<string, unknown> };
    if (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(key) && values && typeof values === 'object') {
      cur.ranges ??= {};
      const entry = { ...(cur.ranges[key] ?? {}) };
      for (const { key: pk } of PRODUCTS) {
        if (!(pk in values)) continue;
        const v = values[pk];
        if (v === null) delete entry[pk];
        else if (money(v) !== undefined) entry[pk] = money(v);
      }
      cur.ranges[key] = entry;
    }
  }
  if (p.days && typeof p.days === 'object') {
    cur.days ??= {};
    for (const [k, v] of Object.entries(p.days as Record<string, unknown>)) {
      if (!isDay(k)) continue;
      if (v === null) delete cur.days[k];
      else if (money(v) !== undefined) cur.days[k] = money(v)!;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cur, null, 2) + '\n');
  return cur;
}

/**
 * Parse daily figures pasted from anywhere: `2026-09-01 58.20`, `Sep 1: $58.20`, `9/1, 58.2`, CSV or TSV.
 * Dates without a year take `year`.
 */
export function parseDailyPaste(text: string, year: number): Record<string, number> {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const out: Record<string, number> = {};
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let y = year;
    let m: number | undefined;
    let d: number | undefined;
    let rest = line;
    let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(line);
    if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    else if ((hit = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(line))) {
      m = months.indexOf(hit[1].toLowerCase()) + 1 || undefined;
      d = Number(hit[2]);
      if (hit[3]) y = Number(hit[3]);
    } else if ((hit = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(line))) {
      [m, d] = [Number(hit[1]), Number(hit[2])];
      if (hit[3]) y = hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3]);
    }
    if (!hit || !m || !d || m > 12 || d > 31) continue;
    rest = line.slice(hit[0].length);
    const num = /\$?\s*(\d[\d,]*(?:\.\d+)?)/.exec(rest);
    if (!num) continue;
    const v = Number(num[1].replace(/,/g, ''));
    if (Number.isFinite(v)) out[`${y}-${pad(m)}-${pad(d)}`] = Math.round(v * 100) / 100;
  }
  return out;
}

/* ---------- the view ---------- */

export interface UsageQuery {
  from?: string;
  to?: string;
  group?: GroupBy;
  interval?: 'day' | 'week';
  project?: string;
}

function keyOf(store: Store, r: Request, group: GroupBy): { key: string; label: string } {
  switch (group) {
    case 'model': {
      const m = r.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      return { key: m, label: m };
    }
    case 'project': {
      const p = store.sessions.get(r.sessionId)?.project ?? 'unknown';
      return { key: p, label: p };
    }
    case 'surface':
      return { key: r.entrypoint ?? 'unknown', label: surfaceLabel(r.entrypoint) };
    default:
      return { key: 'claude_code', label: 'Claude Code' };
  }
}

export function usageView(store: Store, q: UsageQuery, now = Date.now()) {
  store.refresh();
  const today = utcDay(now);
  const period = utcPeriod(now, store.settings.periodStartDay ?? 1);
  const from = q.from ?? period.start;
  const to = q.to ?? today;
  const group = q.group ?? 'product';
  const interval = q.interval ?? 'day';
  const nDays = Math.round((parseDay(to) - parseDay(from)) / DAY) + 1;
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(from, -nDays);

  // Buckets: every UTC day (or Monday) in range, including empty ones, as the dashboard does.
  const buckets: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const b = interval === 'week' ? utcWeek(d) : d;
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  }
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  const series = new Map<string, { key: string; label: string; values: number[]; total: number; prior: number; requests: number }>();
  const ensure = (k: { key: string; label: string }) => {
    let s = series.get(k.key);
    if (!s) {
      s = { ...k, values: buckets.map(() => 0), total: 0, prior: 0, requests: 0 };
      series.set(k.key, s);
    }
    return s;
  };
  if (group === 'product') for (const p of PRODUCTS) ensure(p);

  let periodSpent = 0;
  const skillUses = new Map<string, { uses: number; sessions: Set<string> }>();
  const yesterday = addDays(today, -1);
  for (const r of store.requests.values()) {
    const d = utcDay(r.ts);
    if (d >= period.start && d <= period.end) periodSpent += r.cost;
    if (q.project && store.sessions.get(r.sessionId)?.project !== q.project) continue;
    if (d >= from && d <= to) {
      const s = ensure(keyOf(store, r, group));
      const i = bucketIndex.get(interval === 'week' ? utcWeek(d) : d);
      if (i != null) s.values[i] += r.cost;
      s.total += r.cost;
      s.requests++;
    } else if (d >= priorFrom && d <= priorTo) {
      ensure(keyOf(store, r, group)).prior += r.cost;
    }
  }
  // Top skills, through yesterday (UTC) like the dashboard. Forks copy records, so count each uuid once.
  const seen = new Set<string>();
  for (const f of store.files.values()) {
    const s = store.sessions.get(f.sessionId);
    if (q.project && s?.project !== q.project) continue;
    for (const rec of f.records) {
      if (!rec.skills || seen.has(rec.uuid)) continue;
      seen.add(rec.uuid);
      const d = utcDay(rec.ts);
      if (d < from || d > to || d > yesterday) continue;
      for (const name of rec.skills) {
        const e = skillUses.get(name) ?? { uses: 0, sessions: new Set<string>() };
        e.uses++;
        e.sessions.add(f.sessionId);
        skillUses.set(name, e);
      }
    }
  }

  const ref = loadReference(referencePath(store.settingsPath));
  const rangeKey = `${from}..${to}`;
  const refDays: Record<string, number> = {};
  for (const [d, v] of Object.entries(ref.days ?? {})) if (d >= from && d <= to) refDays[d] = v;
  const refPeriod = ref.periods?.[period.start] ?? {};

  const list = [...series.values()];
  // Stable, entity-bound order: products in their fixed order; everything else by name.
  if (group === 'product') list.sort((a, b) => PRODUCTS.findIndex((p) => p.key === a.key) - PRODUCTS.findIndex((p) => p.key === b.key));
  else list.sort((a, b) => a.label.localeCompare(b.label));
  const total = list.reduce((a, s) => a + s.total, 0);

  return {
    range: { from, to, days: nDays, prior: { from: priorFrom, to: priorTo }, timeZone: 'UTC' },
    group,
    interval,
    buckets,
    series: list.map((s) => ({
      key: s.key,
      label: s.label,
      values: s.values,
      total: s.total,
      share: total ? s.total / total : 0,
      prior: s.prior,
      change: s.prior ? (s.total - s.prior) / s.prior : null,
      requests: s.requests,
      /** Products Claude Code never writes to disk: the dashboard is the only source for these. */
      local: group !== 'product' || s.key === 'claude_code',
    })),
    total,
    period: { ...period, spent: periodSpent, limit: store.settings.monthlyLimit ?? refPeriod.limit ?? null },
    skills: [...skillUses.entries()]
      .map(([name, e]) => ({ name, uses: e.uses, sessions: e.sessions.size }))
      .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
    skillsThrough: yesterday < to ? yesterday : to,
    reference: {
      period: refPeriod,
      range: ref.ranges?.[rangeKey] ?? {},
      rangeKey,
      days: refDays,
    },
  };
}
