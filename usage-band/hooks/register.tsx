import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Monthly, Stats } from '../types'
import {
  applyLedger,
  bandRows,
  bankTurn,
  detailRows,
  emptyMonthly,
  emptyStats,
  logRows,
  money,
  normMonthly,
  normStats,
  parseSpendArgs,
  parseUsage,
  recordStep,
  whoRows,
} from './stats'
import type { Row } from './stats'

const PANE = 'usage-band-details'
const MONTHLY_EVERY_MS = 60 * 1000

const stats = atom({ plugin: 'usage-band', key: 'stats' } as const, emptyStats())
const monthly = atom({ plugin: 'usage-band', key: 'monthly' } as const, emptyMonthly())
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)

/** When get_usage was last asked; a reload asks again, which is harmless. */
let lastAsked = -Infinity

async function editStats($: EngineInterface, fn: (s: Stats) => Stats): Promise<void> {
  await update($, stats, saved => fn(normStats(saved)))
}

async function editMonthly($: EngineInterface, fn: (m: Monthly) => Monthly): Promise<void> {
  await update($, monthly, saved => fn(normMonthly(saved)))
}

/** Reads the engine's ledger and context fill into the stats. */
async function readLedger($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage()
    await editStats($, s => applyLedger(s, usage))
  } catch {
    /* the band keeps what it had */
  }
}

/** Month to date from the app's get_usage, at most once a minute. */
async function refreshMonthly($: EngineInterface, force: boolean): Promise<void> {
  const now = await $.clock.now()
  if (!force && now - lastAsked < MONTHLY_EVERY_MS) return
  lastAsked = now
  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'get_usage')
    const got = parseUsage(result)
    if (got === null) {
      await editMonthly($, m => ({ ...m, error: 'get_usage had no extraUsage' }))
      return
    }
    await editMonthly($, () => ({ ...got, asOf: now, source: 'mcp', error: null }))
  } catch {
    await editMonthly($, m => ({ ...m, error: m.spent === null ? 'get_usage unavailable' : null }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-spend',
      description: 'Set the month-to-date spend by hand: /usage-spend <spent> <limit> [percent]',
      argumentHint: '<spent> <limit> [percent]',
    })
    await $.command.register({
      name: 'usage-details',
      description: 'Open the usage details pane: context, roles, cost parts, every request',
    })
    await refreshMonthly($, true)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const at = await $.clock.now()
    await editStats($, s =>
      recordStep(s, {
        at,
        index: e.index,
        stopReason: response.stopReason,
        agentId: e.agentId,
        usage: response.usage,
      }),
    )
    await readLedger($)
    return response
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await editStats($, bankTurn)
      await readLedger($)
      await refreshMonthly($, false)
    }
    return done
  })

  on('command.run', { command: 'usage-spend' }, async ($, e) => {
    const got = parseSpendArgs(e.args)
    if (got === null) return { text: 'Usage: /usage-spend <spent> <limit> [percent], e.g. /usage-spend 11.77 75' }
    const now = await $.clock.now()
    await editMonthly($, () => ({ ...got, asOf: now, source: 'manual', error: null }))
    return { text: `Month to date set to ${money(got.spent)} of ${money(got.limit)}.` }
  })

  on('command.run', { command: 'usage-details' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage details' })
    return { text: 'Usage details pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (await read($, isHidden)) {
      return (
        <Box flexDirection="row">
          <Text dimColor>Usage band hidden </Text>
          <Button key="show" label="Show" plain onPress={() => update($, isHidden, () => false)} />
        </Box>
      )
    }

    const s = normStats(await read($, stats))
    const m = normMonthly(await read($, monthly))
    const now = await $.clock.now()
    const rows = bandRows(s, m, now, e.props.bodyColumns).slice(0, Math.max(1, e.props.maxRows))

    const line = (row: Row) => (
      <Text key={row.key} wrap="truncate-end">
        {row.segs.map(g => (
          <Text color={g.color} dimColor={g.dim} bold={g.bold}>
            {g.t}
          </Text>
        ))}
      </Text>
    )
    const [first, ...rest] = rows

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {first !== undefined && line(first)}
          <Text> </Text>
          <Button
            key="details"
            label="Details"
            plain
            onPress={() => $.ui.open({ id: PANE, title: 'Usage details' })}
          />
          <Text> </Text>
          <Button key="hide" label="Hide" plain onPress={() => update($, isHidden, () => true)} />
        </Box>
        {rest.map(line)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = normStats(await read($, stats))
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const details = detailRows(s, columns)
    const who = whoRows(s)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - details.length - who.length - 6)

    return (
      <Box flexDirection="column">
        {details.map(row => (
          <Text key={row.key} wrap="truncate-end">
            {row.segs.map(g => (
              <Text color={g.color} dimColor={g.dim} bold={g.bold}>
                {g.t}
              </Text>
            ))}
          </Text>
        ))}
        <Text bold>Who made the calls</Text>
        {who.map(w => (
          <Text color={w.color} wrap="truncate-end">
            {`${w.label.padEnd(20)} ${String(w.n).padStart(5)} ${money(w.usd).padStart(9)} ${`${Math.round(w.share)}%`.padStart(5)}`}
          </Text>
        ))}
        <Text bold>Requests, newest first</Text>
        {logRows(s, room).map(l => (
          <Text wrap="truncate-end">{l}</Text>
        ))}
      </Box>
    )
  })
}
