import { describe, expect, test } from 'claude-code/testing'

import { costOf, priceOf } from './pricing'
import {
  bandRows,
  bankTurn,
  emptyMonthly,
  emptyStats,
  normStats,
  parseSpendArgs,
  parseUsage,
  recordStep,
  roleOf,
  rowText,
} from './stats'
import type { Step } from './stats'

const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)

const usage = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

const step = (index: number, stopReason: string | null, u: Step['usage'], agentId?: string): Step => ({
  at: 0,
  index,
  stopReason,
  agentId,
  usage: u,
})

describe('pricing', () => {
  test('hand-computed sonnet request is $0.032', () => {
    near(costOf('claude-sonnet-5-5', usage('', 1000, 500, 100000, 2000))!, 0.032)
  })
  test('longest prefix wins, suffixes ignored, unknown left unpriced', () => {
    expect(priceOf('claude-opus-5-5[1m]')?.input).toBe(4)
    expect(priceOf('claude-opus-5-20260101')?.input).toBe(5)
    expect(priceOf('claude-opus-4-1')?.input).toBe(15)
    expect(priceOf('gpt-9')).toBeUndefined()
  })
})

describe('roles', () => {
  test('prompt, iteration, answer, subagent', () => {
    expect(roleOf(0, 'tool_use', undefined)).toBe('prompt')
    expect(roleOf(1, 'tool_use', undefined)).toBe('iteration')
    expect(roleOf(2, 'end_turn', undefined)).toBe('answer')
    expect(roleOf(0, 'end_turn', 'a1')).toBe('subagent')
  })
})

describe('turns', () => {
  test('a turn splits into yours and Claude\'s work and banks as previous', () => {
    let s = emptyStats()
    s = recordStep(s, step(0, 'tool_use', usage('claude-sonnet-5-5', 1_000_000, 0)))
    s = recordStep(s, step(1, 'tool_use', usage('claude-sonnet-5-5', 0, 100_000)))
    s = recordStep(s, step(0, 'end_turn', usage('claude-sonnet-5-5', 500_000, 0), 'agent-1'))
    s = recordStep(s, step(2, 'end_turn', null))
    s = recordStep(s, step(3, 'end_turn', usage('gpt-9', 1, 1)))
    near(s.current.usd, 2 + 1 + 1)
    near(s.current.youUsd, 2)
    near(s.current.workUsd, 2)
    expect(s.seen).toEqual({ main: 4, subagent: 1, noUsage: 1 })
    expect(s.unpricedModels).toEqual(['gpt-9'])
    s = bankTurn(s)
    expect(s.lastTurn).toEqual({ usd: 4, youUsd: 2, workUsd: 2 })
    expect(s.current.usd).toBe(0)
    expect(s.turns.n).toBe(1)
    expect(bankTurn(s).turns.n).toBe(1)
  })

  test('state from an older version is filled out', () => {
    const s = normStats({ requests: { n: 3, sum: 1, high: 0.5 }, turns: 'junk' })
    expect(s.requests.n).toBe(3)
    expect(s.turns).toEqual({ n: 0, sum: 0, high: 0 })
    expect(s.lastTurn).toBeNull()
    expect(s.byRole.subagent.n).toBe(0)
  })
})

describe('parsers', () => {
  test('get_usage text block', () => {
    const r = { content: [{ type: 'text', text: JSON.stringify({ plan: { extraUsage: { spent: '11.77', monthlyLimit: '75.00', percentUsed: 15 } } }) }], isError: false }
    expect(parseUsage(r)).toEqual({ spent: 11.77, limit: 75, percent: 15 })
    expect(parseUsage({ content: [{ type: 'text', text: 'nope' }] })).toBeNull()
  })
  test('/usage-spend args', () => {
    expect(parseSpendArgs('$11.77 75')).toEqual({ spent: 11.77, limit: 75, percent: (100 * 11.77) / 75 })
    expect(parseSpendArgs('11.77')).toBeNull()
  })
})

describe('band', () => {
  test('rows come in the order asked for', () => {
    const rows = bandRows(emptyStats(), emptyMonthly(), 0, 120)
    expect(rows.map(r => r.key)).toEqual(['session', 'global', 'previous', 'average', 'max', 'requests'])
    expect(rowText(rows[0]!)).toContain('Session spend')
    expect(rowText(rows[1]!)).toContain('Global spend unknown')
    expect(rowText(rows[2]!)).toContain('Previous turn: none yet')
  })
})
