export type Role = 'prompt' | 'iteration' | 'answer' | 'subagent'

/** A running count, total and maximum of dollar amounts. */
export type Agg = { n: number; sum: number; high: number }

export type Parts = { input: number; cacheWrite: number; cacheRead: number; output: number }

/** One model request as the band saw it; `usd` null when its model has no price. */
export type Req = {
  at: number
  turn: number
  role: Role
  model: string
  usd: number | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  agentId: string | null
}

export type Stats = {
  requests: Agg
  byRole: Record<Role, Agg>
  parts: Parts
  /** Per prompt, banked at the main loop's turn.complete. */
  turns: Agg
  turnsYou: Agg
  turnsWork: Agg
  /** The prompt now running (subagent requests included). */
  current: { usd: number; youUsd: number; workUsd: number; requests: number }
  /** The last banked prompt; null before the first. */
  lastTurn: { usd: number; youUsd: number; workUsd: number } | null
  unpriced: number
  unpricedModels: string[]
  seen: { main: number; subagent: number; noUsage: number }
  ctx: { tokens: number; window: number; percent: number; peak: number }
  ledgerUsd: number | null
  /** The last requests, newest last, for the pane. */
  log: Req[]
}

export type Monthly = {
  spent: number | null
  limit: number | null
  percent: number | null
  /** `$.clock.now()` ms of the last good reading. */
  asOf: number | null
  source: 'mcp' | 'manual' | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { stats: Stats; monthly: Monthly; isHidden: boolean }
  }
}
