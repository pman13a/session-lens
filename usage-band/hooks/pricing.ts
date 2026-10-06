// USD per million tokens, copied from Session Lens session-lens/source/config/pricing.json
// (checkedAt 2026-09-30). Re-copy when prices change.
export type Price = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  context: number
}

export const PRICES_CHECKED = '2026-09-30'

export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, context: 1000000 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, context: 1000000 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0, context: 1000000 },
  'claude-mythos-5': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0, context: 1000000 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, context: 1000000 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, context: 1000000 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, context: 1000000 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, context: 1000000 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, context: 1000000 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, context: 200000 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, context: 200000 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, context: 1000000 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, context: 1000000 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, context: 1000000 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, context: 200000 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08, context: 200000 },
}

export type Tokens = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type CostParts = { input: number; cacheWrite: number; cacheRead: number; output: number }

/** Drop what does not change a price: `[1m]`, a date suffix, a Bedrock prefix. */
export function normalizeModel(model: string): string {
  return model.replace(/\[.*?\]$/, '').replace(/-\d{8}$/, '').replace(/^(us\.|eu\.|apac\.)?anthropic\./, '')
}

/** Longest-prefix match; undefined for a model not in the table (never guessed). */
export function priceOf(model: string): Price | undefined {
  const id = normalizeModel(model)
  let best: string | undefined
  for (const key of Object.keys(PRICES)) {
    if ((id === key || id.startsWith(key + '-')) && (best === undefined || key.length > best.length)) best = key
  }
  return best === undefined ? undefined : PRICES[best]
}

/**
 * Dollars per component. The hook reports one cache-write count, priced at the
 * 5-minute rate: a session on 1-hour caching is under-counted on writes.
 */
export function costParts(model: string, u: Tokens): CostParts | undefined {
  const p = priceOf(model)
  if (p === undefined) return undefined
  return {
    input: (u.input_tokens * p.input) / 1e6,
    cacheWrite: (u.cache_creation_input_tokens * p.cacheWrite5m) / 1e6,
    cacheRead: (u.cache_read_input_tokens * p.cacheRead) / 1e6,
    output: (u.output_tokens * p.output) / 1e6,
  }
}

export function costOf(model: string, u: Tokens): number | undefined {
  const c = costParts(model, u)
  return c === undefined ? undefined : c.input + c.cacheWrite + c.cacheRead + c.output
}
