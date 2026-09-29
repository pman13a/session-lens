# Session Lens

Claude's usage report shows spend per day. Session Lens starts at the same daily view and lets you click down four levels:

**Day → Session → Request → what was in the context**

At the bottom level you see every line item the model was carrying on that call: the system prompt, each file read, each tool result, each reminder. Items are sized in tokens, flagged when they were new that turn, and clickable to read the raw content.

It reads the transcripts Claude Code already writes to `~/.claude/projects`. Everything runs locally, and nothing is uploaded.

## Run it

```sh
git clone https://github.com/pman13a/session-lens.git
cd session-lens
npm install
npm run build
npm start               # opens http://127.0.0.1:4317
```

- `npm run demo`: generates two weeks of synthetic transcripts and opens the dashboard on them.
- `node apps/server/dist/cli.js --projects <dir>[,<dir>] --port <n> --no-open`
- **VS Code:** `npm run package:vscode`, then *Extensions → … → Install from VSIX* and pick `apps/vscode/session-lens.vsix`. Run **Session Lens: Open**, or use the **Session Lens** tab in the bottom panel next to Terminal. Drag either one to the secondary sidebar to keep it on the far right. The status bar shows today's spend.
- **Desktop window:** `npm run desktop` (Electron; installed separately so the CLI never downloads it).

## The four levels

| Overview | Session | Request |
|---|---|---|
| ![Overview](docs/1-overview.png) | ![Session](docs/3-session.png) | ![Request](docs/4-request.png) |

*(Screenshots use `npm run demo` data.)*

| Level | Shows | Click |
|---|---|---|
| Overview | Cost or tokens per day, stacked by input / cache write / cache read / output. Totals, sessions in range, CSV/JSON export | a day |
| Day | That day's sessions: context-growth sparkline, peak context %, tokens, cost | a session |
| Session | **What filled the context over time** (stacked by kind, in tokens or % of context, per thread), context size per request against the limit, cost per request split by component, each prompt with the requests that answered it, subagents | a request |
| Request | Measured totals, a composition bar, a treemap and ranked table of every context line item, "added this turn" filter, prev/next, and the response's own blocks | an item, to read its raw text |

## How the numbers are made

- **Totals are measured.** Every request's `usage` block (input, cache read, cache write 5m/1h, output, thinking, web searches) comes straight from the transcript.
- **Cost** = those tokens × `config/pricing.json`. The Opus 5.5 rates reproduce Claude Code's own `cost-state` figure to the cent (see `packages/core/test/core.test.ts`). Estimates are at API list prices; subscription plans bill differently.
- **Per-item tokens are estimates** that always add up to the measured total:
  - *System prompt + tools* never appear in the transcript. They are measured **once**, on a thread's first request, as measured input minus visible content.
  - Visible items are sized by text length at a **calibrated** chars-per-token rate: the median of Δchars/Δtokens between consecutive requests on that thread, about 2.2 on current models. A fixed chars/4 would under-count by nearly half.
  - What the transcript can't explain is shown as **Not in transcript**, pinned to the step where it appeared. The usual cause is tool schemas that ToolSearch or MCP loaded mid-session. Spreading it over every item would hide where it came from.

### Transcript quirks handled (each has a test)

- One API response is written as several records (one per content block) that share one `requestId` and one `usage`. It is counted once.
- Forked or resumed sessions copy the parent's history into a new file. Request IDs are deduplicated **across all files**, and the oldest file owns them.
- `<synthetic>` records are not API calls.
- Subagent transcripts live in `<session>/subagents/agent-*.jsonl` with a `.meta.json`. They stay on their own thread (never merged into the parent's context) and are grouped under the prompt whose tool call launched them.
- Current models have a 1M context window (Haiku 4.5 has 200K). Nothing assumes 200K.

## Plan-aware cost

Session Lens asks Claude Code which account is logged in (`claude auth status --json`, which never exposes credentials) and labels cost to match:

| Account | Headline | Billing period card |
|---|---|---|
| API key, Bedrock, Vertex | **Spend** at API prices | Spend against your monthly budget, if you set one |
| Pro / Max | **API-equivalent value**: what the usage would cost on the API | Value so far against your plan fee |
| Team / Enterprise | **Usage at API rates** | Spend against the monthly allowance |

The **Billing** menu in the header overrides the detected mode, and **Plan…** sets the plan price, monthly limit, period start day and discount. Changes are saved to `~/.session-lens/settings.json` and shared by the browser, VS Code and desktop versions.

Pro and Max limits are 5-hour and weekly usage windows. Transcripts don't record the percentage used; only claude.ai → Settings → Usage shows it.

## What it covers

It covers Claude Code sessions that ran **on this computer**: the terminal, VS Code, JetBrains, the desktop app's Code tab, and Remote Control sessions hosted here. It does not see:

- Claude Code on the web or cloud sessions started from the phone app, which run in Anthropic's cloud, so their transcripts never reach this machine.
- Other computers, unless you copy or sync their `~/.claude/projects` and pass every folder with `--projects a,b`. Duplicates are removed automatically.
- claude.ai chat, the desktop or mobile chat apps, and Cowork. On Pro/Max these draw on the same limits but leave no local transcripts.
- Small internal calls, such as the model that summarizes WebFetch results, which Claude Code bills but doesn't write to the transcript.

## Settings

`~/.session-lens/settings.json` (optional):

```json
{
  "billing": "subscription",
  "planPrice": 200,
  "monthlyLimit": 500,
  "periodStartDay": 1,
  "discount": 0.1,
  "timeZone": "America/Chicago",
  "prices": { "claude-opus-5-5": { "input": 4, "output": 20 } }
}
```

## Layout

```
packages/core   parse, dedupe, price, aggregate, context attribution, JSON API, HTTP server
packages/ui     the dashboard (Vite + ECharts), one bundle for every shell
apps/server     `session-lens` CLI
apps/vscode     editor tab + bottom-panel view + status bar, bridged over postMessage
apps/desktop    Electron window
scripts/        demo-data generator
```

`npm test` runs the core tests.

## License

MIT. See [LICENSE](LICENSE).
