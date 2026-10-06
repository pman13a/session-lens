# Session Lens

Tools for seeing how your Claude Code usage gets spent.

| Folder | What it is |
|---|---|
| [`session-lens/`](session-lens) | **Session Lens**: a drill-down explorer for Claude Code usage. It goes **day → session → prompt → request → tool call**, showing live cost, what filled the context on every call, and who made each call. It runs as a local web app, a desktop app or a VS Code extension. |
| [`usage-band/`](usage-band) | **usage-band**: a Claude Code mod that draws a live band above the prompt with session spend, month-to-date spend, and per-turn cost split into your calls and Claude's work. It updates after every request. |

| Overview | Session timeline | Prompts |
|---|---|---|
| ![Overview: cost by day, spend against your limit](session-lens/docs/1-overview.png) | ![Session: context, cost per request, cost per prompt and accumulated cost on one axis](session-lens/docs/3-session.png) | ![Prompts: your prompt vs Claude's work, heat-mapped, expanded to its requests](session-lens/docs/6-prompts.png) |

## Session Lens

Ready to run, with nothing to build: double-click
`session-lens/release/session-lens/Start Session Lens.cmd` (it needs Node.js 20+),
or install `session-lens/release/session-lens.vsix` in VS Code. See
[session-lens/README.md](session-lens/README.md).

## usage-band

In a Claude Code terminal session:

```
/plugin install usage-band --marketplace pman13a/session-lens
```

Answer `y` to add the marketplace, then pick the user scope. See
[usage-band/README.md](usage-band/README.md).

## License

MIT. See [LICENSE](LICENSE).
