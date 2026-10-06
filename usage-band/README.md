# usage-band

A Claude Code mod that draws a live usage band above the prompt, after
[Session Lens](../session-lens). It updates after every
model request.

```
Session spend       $4.10  est $4.00  ·  this turn $0.00        Details  Hide
Global spend        $11.77 of $75.00  15%  ███░░░░░░░░░░░░░░░░░  as of 14:02 UTC
                        total    yours  Claude's
Previous turn           $4.00    $2.00     $2.00  █████░░░░░
Per turn (average)      $4.00    $2.00     $2.00  █████░░░░░
Per turn (max)          $4.00    $2.00     $2.00
Total requests              3        1         2  ███░░░░░░░
```

Colors follow your theme: **yours** is always blue and **Claude's** always
orange, in the column headers, the amounts and the split bar beside each row,
which shows how that row divides between the two. The monthly bar and its
percentage go green, then yellow past 50%, then red past 80%. Zero and
not-yet values are dimmed, and the "as of" time turns yellow when the monthly
reading is over 15 minutes old.

| Row | Where it comes from |
|---|---|
| Session spend | The engine's own ledger (`$.session.usage().cost.usd`). `est` is this mod's sum of priced requests, so the gap between the two is visible. |
| Global spend | The month to date, from the app's `ccd_session_mgmt` `get_usage` (`plan.extraUsage`), asked at most once a minute. The time turns yellow when the reading is over 15 minutes old. `/usage-spend <spent> <limit>` sets it by hand. |
| Previous turn | The last finished prompt: its total, your prompt's own call ("yours") and everything after it ("Claude's": tool iterations, the answer, subagents). |
| Per turn (average), (max) | The same split over every prompt of the session. Each max is taken on its own, so the three can come from different prompts. |
| Total requests | Model requests counted, and their cost, split the same way. |

**Details** (or `/usage-details`) opens a pane with the context fill, a role bar,
cost by component (input, cache write, cache read, output), the `Seen:`
diagnostics, Session Lens's "who made the calls" table, and every request, newest
first. **Hide** folds the band to one line with a **Show** button.

## Install

In a terminal session:

```
/plugin install usage-band --marketplace pman13a/session-lens
```

Answer `y` to add the marketplace, then pick the user scope. While developing,
`claude --plugin-dir <path to this folder>` loads it for one session.

## How costs are estimated

Each request's tokens (from `turn.step`) times the price table in
`hooks/pricing.ts`, copied from Session Lens `session-lens/source/config/pricing.json`
(checked 2026-09-30). Model ids match by longest prefix. A model not in the table
is counted as unpriced and named in the pane, never guessed.

Known gaps: the hook reports one cache-write count, priced at the 5-minute rate,
so 1-hour cache writes run low. Fast mode and the US-only multiplier are not
visible to the mod and not applied.

## Develop

```
claude plugin validate .
claude plugin test .
```

`hooks/stats.ts` holds the pure functions (aggregation, roles, parsers, rows);
`hooks/register.tsx` the hooks; `types/index.d.ts` the `$.state` contract.
