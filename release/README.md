# Session Lens 0.2.0: ready to run

Nothing to build. Pick one:

| | Needs | Do this |
|---|---|---|
| **Browser** | [Node.js](https://nodejs.org) 20+ (LTS installer) | Open `session-lens/` and double-click **Start Session Lens.cmd** (Windows) or run `./start-session-lens.sh` (macOS/Linux). Your browser opens on http://127.0.0.1:4317. Close the window to stop. |
| **VS Code** | VS Code | `code --install-extension session-lens.vsix`, then run **Session Lens: Open** from the command palette. |
| **Share it** | | Send `session-lens-portable.zip` (the browser version, zipped) or `session-lens.vsix`. |

**Updating:** `git pull` (or replace these files with newer ones). Your prices, discounts and plan live in
`~/.session-lens/` and carry over. After updating the VS Code extension, run *Developer: Reload Window*.

**Options** for the browser version, added after the script name: `--port <n>`, `--projects <dir>` (another
transcripts folder; comma-separate several), `--no-open`.

Read **About** in the app for what the numbers mean and their limits. Model prices go stale when Anthropic
changes them: **Settings → Check Anthropic’s prices**.

These files are built from `../source` with `npm run release`; don't edit them by hand.
