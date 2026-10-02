#!/bin/sh
# Session Lens: opens your Claude Code usage in the browser. Ctrl+C to stop.
command -v node >/dev/null 2>&1 || { echo "Session Lens needs Node.js 20 or newer: https://nodejs.org"; exit 1; }
exec node "$(dirname "$0")/session-lens.mjs" "$@"
