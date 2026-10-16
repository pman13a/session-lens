import { expect, mock, test } from 'claude-code/testing'

const u = (input: number, output: number) => ({
  model: 'claude-sonnet-5-5',
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const BAND = {
  component: 'AbovePrompt',
  // scroll and view are the surface's; the band reads none of them
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160 } as never,
} as const

test('a turn through the real hooks draws the band table', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 6, 14, 2) })
  const replies = [
    { stopReason: 'tool_use' as const, usage: u(1_000_000, 0) },
    { stopReason: 'tool_use' as const, usage: u(0, 100_000) },
    { stopReason: 'end_turn' as const, usage: u(0, 100_000) },
  ]
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    const r = replies[e.index]!
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: r.stopReason, usage: r.usage }
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 250_000, window: 1_000_000, percent: 25 }, rateLimits: [], cost: { usd: 4.1 } } }))
  on('mcp.call', () => ({
    value: {
      content: [{ type: 'text', text: JSON.stringify({ plan: { extraUsage: { spent: '11.77', monthlyLimit: '75.00', percentUsed: 15 } } }) }],
      isError: false,
    },
  }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/' }))
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (let index = 0; index < 3; index++) {
    const stream = $.turn.step({ turnId: 't1', index, model: 'claude-sonnet-5-5', messageCount: 1 })
    for await (const _ of stream) {
      /* drain */
    }
  }
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  const row = async (key: string) => (await ui.find({ key }))?.text ?? ''
  expect(await row('session')).toContain('Session spend')
  expect(await row('session')).toContain('$4.10')
  expect(await row('session')).toContain('est $4.00')
  expect(await row('global')).toContain('$11.77 of $75.00')
  expect(await row('global')).toContain('15%')
  expect(await row('global')).toContain('as of 14:02 UTC')
  expect(await row('head')).toContain("Claude's")
  // cells are separate Boxes, so their texts join with no spaces
  // yours, Claude's, the bar, then the total at the right
  expect(await row('head')).toContain("yoursClaude's")
  expect((await row('head')).indexOf('total')).toBeGreaterThan((await row('head')).indexOf("Claude's"))
  expect(await row('previous')).toContain('Previous turn$2.00$2.00')
  expect(await row('previous')).toContain('█$4.00')
  const keys = async () => (await ui.findAll({ type: 'Box' })).map(b => b.key).filter(Boolean)
  // Compact by default: the previous turn alone. More adds the per-turn and total rows; Less folds them.
  expect(await keys()).toEqual(['session', 'global', 'head', 'previous'])
  expect((await ui.find({ key: 'more' }))?.text).toContain('More')
  await ui.press({ key: 'more' })
  expect(await keys()).toEqual(['session', 'global', 'head', 'previous', 'average', 'max', 'requests'])
  expect((await ui.find({ key: 'more' }))?.text).toContain('Less')
  expect(await row('max')).toContain('Per turn (max)$2.00$2.00$4.00')
  expect(await row('requests')).toContain('Total requests12')
  expect(await row('requests')).toContain('█3')
  await ui.press({ key: 'more' })
  expect(await keys()).toEqual(['session', 'global', 'head', 'previous'])

  for (const surface of ['desktop', 'vscode'] as const) {
    const other = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
    const t = (await other.findAll({ type: 'Text' })).map(x => x.text ?? '').join('\n')
    expect(t).toContain('Previous turn')
    await other.unmount()
  }

  const pane = await $.ui.mount({
    plugin: 'usage-band',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'usage-band-details',
    props: {} as never,
  })
  const paneText = (await pane.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
  expect(paneText).toContain('Context')
  expect(paneText).toContain('Seen: 3 main + 0 subagent requests, 0 without usage')
  expect(paneText).toContain('Who made the calls')
  expect(paneText).toContain('sonnet-5-5')
  await pane.unmount()

  const answered = await $.command.run({ command: 'usage-band', args: '' } as never)
  expect(answered.text).toContain("yours  Claude's    total")
  expect(answered.text).toContain('Total requests')

  await ui.press({ key: 'hide' })
  expect((await ui.find({ key: 'show' }))).toBeDefined()
})
