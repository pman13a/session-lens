@echo off
rem Session Lens: opens your Claude Code usage in the browser. Close this window to stop it.
where node >nul 2>nul
if errorlevel 1 (
  echo Session Lens needs Node.js 20 or newer: https://nodejs.org  ^(the LTS installer^)
  pause
  exit /b 1
)
node "%~dp0session-lens.mjs" %*
if errorlevel 1 pause
