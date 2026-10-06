// Pure functions: no `$`. Aggregation, roles, parsers and the band's rows.
import type { Agg, Monthly, Parts, Req, Role, Stats } from '../types'
import { costParts } from './pricing'
import type { Tokens } from './pricing'

export const ROLES: readonly Role[] = ['prompt', 'iteration', 'answer', 'subagent']
export const ROLE_LABEL: Record<Role, string> = {
  prompt: 'yours',
  iteration: 'iterating',
  answer: 'answers',
  subagent: 'subagents',
}
/** Theme keys, so the colors follow the person's theme on every surface. */
export const ROLE_COLOR: Record<Role, string> = {
  prompt: 'suggestion',
  iteration: 'warning',
  answer: 'success',
  subagent: 'merged',
}
export const LOG_CAP = 200

export const emptyAgg = (): Agg => ({ n: 0, sum: 0, high: 0 })
const emptyParts = (): Parts => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })

export function emptyStats(): Stats {
  return {
    requests: emptyAgg(),
    byRole: { prompt: emptyAgg(), iteration: emptyAgg(), answer: emptyAgg(), subagent: emptyAgg() },
    parts: emptyParts(),
    turns: emptyAgg(),
    turnsYou: emptyAgg(),
    turnsWork: emptyAgg(),
    current: { usd: 0, youUsd: 0, workUsd: 0, requests: 0 },
    lastTurn: null,
    unpriced: 0,
    unpricedModels: [],
    seen: { main: 0, subagent: 0, noUsage: 0 },
    ctx: { tokens: 0, window: 0, percent: 0, peak: 0 },
    ledgerUsd: null,
    log: [],
  }
}

export function emptyMonthly(): Monthly {
  return { spent: null, limit: null, percent: null, asOf: null, source: null, error: null }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Takes `defaults`' shape and keeps each value of `saved` whose type matches. */
function fill<T>(defaults: T, saved: unknown): T {
  if (isObject(defaults)) {
    if (!isObject(saved)) return defaults
    const out: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(defaults)) out[k] = fill(d, saved[k])
    return out as T
  }
  if (Array.isArray(defaults)) return (Array.isArray(saved) ? saved : defaults) as T
  if (defaults === null) return (saved === undefined ? null : saved) as T
  return (typeof saved === typeof defaults ? saved : defaults) as T
}

/** State saved by an older version of the mod, filled out to this version's shape. */
export const normStats = (saved: unknown): Stats => fill(emptyStats(), saved)
export const normMonthly = (saved: unknown): Monthly => fill(emptyMonthly(), saved)

export function addAgg(a: Agg, x: number): Agg {
  return { n: a.n + 1, sum: a.sum + x, high: Math.max(a.high, x) }
}

export const avg = (a: Agg): number => (a.n === 0 ? 0 : a.sum / a.n)

/** Session Lens's roles: the prompt's own call, tool iterations, the answer, subagents. */
export function roleOf(index: number, stopReason: string | null, agentId: string | undefined): Role {
  if (agentId !== undefined) return 'subagent'
  if (index === 0) return 'prompt'
  return stopReason === 'tool_use' ? 'iteration' : 'answer'
}

export type Step = {
  at: number
  index: number
  stopReason: string | null
  agentId?: string
  usage: (Tokens & { model: string }) | null
}

export function recordStep(s: Stats, step: Step): Stats {
  const isSub = step.agentId !== undefined
  const seen = {
    main: s.seen.main + (isSub ? 0 : 1),
    subagent: s.seen.subagent + (isSub ? 1 : 0),
    noUsage: s.seen.noUsage + (step.usage === null ? 1 : 0),
  }
  if (step.usage === null) return { ...s, seen }

  const u = step.usage
  const role = roleOf(step.index, step.stopReason, step.agentId)
  const parts = costParts(u.model, u)
  const req: Req = {
    at: step.at,
    turn: s.turns.n + 1,
    role,
    model: u.model,
    usd: parts === undefined ? null : parts.input + parts.cacheWrite + parts.cacheRead + parts.output,
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
    agentId: step.agentId ?? null,
  }
  const log = [...s.log, req].slice(-LOG_CAP)

  if (parts === undefined || req.usd === null) {
    const unpricedModels = s.unpricedModels.includes(u.model) ? s.unpricedModels : [...s.unpricedModels, u.model]
    return { ...s, seen, log, unpriced: s.unpriced + 1, unpricedModels }
  }
  const usd = req.usd
  const isYours = role === 'prompt'
  return {
    ...s,
    seen,
    log,
    requests: addAgg(s.requests, usd),
    byRole: { ...s.byRole, [role]: addAgg(s.byRole[role], usd) },
    parts: {
      input: s.parts.input + parts.input,
      cacheWrite: s.parts.cacheWrite + parts.cacheWrite,
      cacheRead: s.parts.cacheRead + parts.cacheRead,
      output: s.parts.output + parts.output,
    },
    current: {
      usd: s.current.usd + usd,
      youUsd: s.current.youUsd + (isYours ? usd : 0),
      workUsd: s.current.workUsd + (isYours ? 0 : usd),
      requests: s.current.requests + 1,
    },
  }
}

/** Banks the running prompt at the main loop's turn.complete. */
export function bankTurn(s: Stats): Stats {
  if (s.current.requests === 0) return s
  return {
    ...s,
    turns: addAgg(s.turns, s.current.usd),
    turnsYou: addAgg(s.turnsYou, s.current.youUsd),
    turnsWork: addAgg(s.turnsWork, s.current.workUsd),
    lastTurn: { usd: s.current.usd, youUsd: s.current.youUsd, workUsd: s.current.workUsd },
    current: { usd: 0, youUsd: 0, workUsd: 0, requests: 0 },
  }
}

export type Ledger = {
  context: { tokens?: number; window: number; percent?: number }
  cost?: { usd: number }
}

export function applyLedger(s: Stats, u: Ledger): Stats {
  const tokens = u.context.tokens ?? s.ctx.tokens
  const window = u.context.window || s.ctx.window
  const percent = u.context.percent ?? (window > 0 ? (100 * tokens) / window : 0)
  return {
    ...s,
    ctx: { tokens, window, percent, peak: Math.max(s.ctx.peak, percent) },
    ledgerUsd: u.cost?.usd ?? s.ledgerUsd,
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * The month-to-date reading from `ccd_session_mgmt`'s `get_usage`:
 * `plan.extraUsage { spent, monthlyLimit, percentUsed }`, as text or structured.
 */
export function parseUsage(result: unknown): { spent: number; limit: number; percent: number } | null {
  const candidates: unknown[] = []
  if (isObject(result)) {
    candidates.push(result.structuredContent)
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (isObject(block) && typeof block.text === 'string') {
          try {
            candidates.push(JSON.parse(block.text))
          } catch {
            /* not JSON */
          }
        }
      }
    }
  }
  for (const c of candidates) {
    if (!isObject(c)) continue
    const plan = isObject(c.plan) ? c.plan : c
    const extra = isObject(plan.extraUsage) ? plan.extraUsage : null
    if (extra === null) continue
    const spent = num(extra.spent)
    const limit = num(extra.monthlyLimit)
    if (spent === null || limit === null) continue
    const percent = num(extra.percentUsed) ?? (limit > 0 ? (100 * spent) / limit : 0)
    return { spent, limit, percent }
  }
  return null
}

/** `/usage-spend <spent> <limit> [percent]`. */
export function parseSpendArgs(args: string): { spent: number; limit: number; percent: number } | null {
  const parts = args.trim().split(/\s+/).map(num)
  const [spent, limit, percent] = parts
  if (spent == null || limit == null || limit <= 0) return null
  return { spent, limit, percent: percent ?? (100 * spent) / limit }
}

export function money(x: number): string {
  if (x >= 100) return `$${x.toFixed(0)}`
  if (x >= 1) return `$${x.toFixed(2)}`
  return `$${x.toFixed(3)}`
}

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export const pct = (x: number): string => `${Math.round(x)}%`

export function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`
}

/** A run of text with an optional color (a theme key) and weight. */
export type Seg = { t: string; color?: string; dim?: boolean; bold?: boolean }
export type Row = { key: string; segs: Seg[] }

/** A bar `width` cells wide, split among `parts` by value; the rest drawn dim. */
export function bar(parts: { value: number; color: string }[], width: number, total?: number): Seg[] {
  const sum = total ?? parts.reduce((t, p) => t + p.value, 0)
  if (width <= 0) return []
  if (sum <= 0) return [{ t: '░'.repeat(width), dim: true }]
  const segs: Seg[] = []
  let used = 0
  let carry = 0
  for (const p of parts) {
    const exact = (p.value / sum) * width + carry
    const cells = Math.min(width - used, Math.round(exact))
    carry = exact - cells
    if (cells > 0) segs.push({ t: '█'.repeat(cells), color: p.color })
    used += cells
  }
  if (used < width) segs.push({ t: '░'.repeat(width - used), dim: true })
  return segs
}

export function fillColor(percent: number): string {
  return percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success'
}

/** Requests and dollars split into the person's own calls and Claude's work. */
export function split(s: Stats): { you: Agg; claude: Agg } {
  const you = s.byRole.prompt
  const claude = ROLES.filter(r => r !== 'prompt').reduce(
    (t, r) => ({ n: t.n + s.byRole[r].n, sum: t.sum + s.byRole[r].sum, high: Math.max(t.high, s.byRole[r].high) }),
    emptyAgg(),
  )
  return { you, claude }
}

const YOU = ROLE_COLOR.prompt
const CLAUDE = 'claude'

function youClaude(you: string, claude: string): Seg[] {
  return [
    { t: ' | ' },
    { t: `yours ${you}`, color: YOU },
    { t: ' | ' },
    { t: `Claude's ${claude}`, color: CLAUDE },
  ]
}

/**
 * The band's six rows, in the order asked for: session spend, global (monthly)
 * spend, the previous turn, per-turn average, per-turn max, total requests.
 * Most important first, so a short band drops from the bottom.
 */
export function bandRows(s: Stats, m: Monthly, now: number, columns: number): Row[] {
  const rows: Row[] = []
  const barWidth = Math.max(6, Math.min(20, Math.floor(columns / 8)))

  rows.push({
    key: 'session',
    segs: [
      { t: `Session spend ${s.ledgerUsd === null ? 'n/a' : money(s.ledgerUsd)}`, bold: true },
      { t: ` (est ${money(s.requests.sum)})`, dim: true },
      { t: ` | this turn ${money(s.current.usd)}` },
      ...(s.unpriced > 0 ? [{ t: ` | ${s.unpriced} unpriced`, color: 'warning' }] : []),
    ],
  })

  if (m.spent !== null && m.limit !== null) {
    const percent = m.percent ?? (m.limit > 0 ? (100 * m.spent) / m.limit : 0)
    const asOf = m.asOf === null ? '' : ` as of ${clock(m.asOf)}`
    const stale = m.asOf !== null && now - m.asOf > 15 * 60 * 1000
    rows.push({
      key: 'global',
      segs: [
        { t: `Global spend ${money(m.spent)} of ${money(m.limit)} (${pct(percent)}) `, bold: true },
        ...bar([{ value: Math.min(percent, 100), color: fillColor(percent) }], barWidth, 100),
        { t: asOf + (m.source === 'manual' ? ' (set by hand)' : ''), dim: !stale, color: stale ? 'warning' : undefined },
      ],
    })
  } else {
    rows.push({
      key: 'global',
      segs: [{ t: `Global spend unknown${m.error ? ` (${m.error})` : ''}; /usage-spend <spent> <limit> sets it`, dim: true }],
    })
  }

  const last = s.lastTurn
  rows.push({
    key: 'previous',
    segs:
      last === null
        ? [{ t: 'Previous turn: none yet', dim: true }]
        : [{ t: `Previous turn ${money(last.usd)}` }, ...youClaude(money(last.youUsd), money(last.workUsd))],
  })

  rows.push({
    key: 'average',
    segs: [
      { t: `Per turn (average) ${money(avg(s.turns))}` },
      ...youClaude(money(avg(s.turnsYou)), money(avg(s.turnsWork))),
    ],
  })

  rows.push({
    key: 'max',
    segs: [
      { t: `Per turn (max) ${money(s.turns.high)}` },
      ...youClaude(money(s.turnsYou.high), money(s.turnsWork.high)),
    ],
  })

  const { you, claude } = split(s)
  rows.push({
    key: 'requests',
    segs: [
      { t: `Total requests ${s.requests.n}` },
      ...youClaude(`${you.n} (${money(you.sum)})`, `${claude.n} (${money(claude.sum)})`),
    ],
  })
  return rows
}

/** The pane's detail rows: what the band used to show below its six. */
export function detailRows(s: Stats, columns: number): Row[] {
  const barWidth = Math.max(10, Math.min(30, Math.floor(columns / 4)))
  const rows: Row[] = []
  rows.push({
    key: 'ctx',
    segs: [
      { t: 'Context ' },
      ...bar([{ value: s.ctx.percent, color: fillColor(s.ctx.percent) }], barWidth, 100),
      { t: ` ${tokens(s.ctx.tokens)}/${tokens(s.ctx.window)} ${pct(s.ctx.percent)} (peak ${pct(s.ctx.peak)})` },
    ],
  })
  rows.push({ key: 'reqs', segs: [{ t: `Requests ${s.requests.n}, avg ${money(avg(s.requests))}, high ${money(s.requests.high)}` }] })
  rows.push({
    key: 'roles',
    segs: [{ t: 'By role ' }, ...bar(ROLES.map(r => ({ value: s.byRole[r].sum, color: ROLE_COLOR[r] })), barWidth)],
  })
  const p = s.parts
  const pt = p.input + p.cacheWrite + p.cacheRead + p.output
  const share = (x: number) => pct(pt > 0 ? (100 * x) / pt : 0)
  rows.push({
    key: 'parts',
    segs: [
      {
        t: `Spend: input ${share(p.input)} | cache write ${share(p.cacheWrite)} | cache read ${share(p.cacheRead)} | output ${share(p.output)}`,
        dim: true,
      },
    ],
  })
  rows.push({
    key: 'seen',
    segs: [
      {
        t: `Seen: ${s.seen.main} main + ${s.seen.subagent} subagent requests, ${s.seen.noUsage} without usage${
          s.unpricedModels.length > 0 ? ` | no price: ${s.unpricedModels.join(', ')}` : ''
        }`,
        dim: true,
      },
    ],
  })
  return rows
}

export function rowText(row: Row): string {
  return row.segs.map(g => g.t).join('')
}

/** The pane's per-request table, newest first, `room` rows at most. */
export function logRows(s: Stats, room: number): string[] {
  const head = 'prompt  role       model              cost     in/out           cache r/w'
  const lines = [head]
  for (const r of [...s.log].reverse().slice(0, Math.max(0, room - 1))) {
    lines.push(
      [
        `#${r.turn}`.padEnd(7),
        ROLE_LABEL[r.role].padEnd(10),
        r.model.replace(/^claude-/, '').slice(0, 18).padEnd(18),
        (r.usd === null ? 'n/a' : money(r.usd)).padStart(7),
        `${tokens(r.input)}/${tokens(r.output)}`.padStart(15),
        `${tokens(r.cacheRead)}/${tokens(r.cacheWrite)}`.padStart(15),
      ].join(' '),
    )
  }
  return lines
}

/** Session Lens's "who made the calls": cost and count per role and per model. */
export function whoRows(s: Stats): { label: string; n: number; usd: number; share: number; color?: string }[] {
  const total = s.requests.sum
  const share = (x: number) => (total > 0 ? (100 * x) / total : 0)
  const out: { label: string; n: number; usd: number; share: number; color?: string }[] = ROLES.map(r => ({
    label: ROLE_LABEL[r],
    n: s.byRole[r].n,
    usd: s.byRole[r].sum,
    share: share(s.byRole[r].sum),
    color: ROLE_COLOR[r],
  }))
  const byModel = new Map<string, { n: number; usd: number }>()
  for (const r of s.log) {
    if (r.usd === null) continue
    const m = byModel.get(r.model) ?? { n: 0, usd: 0 }
    byModel.set(r.model, { n: m.n + 1, usd: m.usd + r.usd })
  }
  for (const [model, m] of byModel) out.push({ label: model, n: m.n, usd: m.usd, share: share(m.usd) })
  return out
}
