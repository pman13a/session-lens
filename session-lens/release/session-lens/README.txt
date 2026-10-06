Session Lens 0.2.0: your Claude Code usage, day > session > prompt > request > tool call.

Needs: Node.js 20 or newer (https://nodejs.org, the LTS installer). Nothing else to install.

Windows:  double-click "Start Session Lens.cmd". Your browser opens on http://127.0.0.1:4317.
          Close the black window to stop it.
Mac/Linux: run ./start-session-lens.sh

It reads the Claude Code transcripts on this computer (~/.claude/projects), updates live, and
sends nothing anywhere. Options (add after the script name):
  --port <n>         another port
  --projects <dir>   another transcripts folder (comma-separate several)
  --no-open          don't open the browser

Read "About" in the app for what the numbers mean and their limits. Model prices go stale when
Anthropic changes them: Settings > Check Anthropic's prices.

Source and VS Code extension: https://github.com/pman13a/session-lens (MIT licence).
