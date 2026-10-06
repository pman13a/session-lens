// Builds everything in the top-level release/ folder, for people who just want to run Session Lens:
//
//   release/session-lens/                 ready to run in place: double-click "Start Session Lens.cmd". Needs Node.
//   release/session-lens-portable.zip     the same folder, zipped, to share.
//   release/session-lens.vsix             the VS Code extension. Needs only VS Code.
//   release/README.md                     how to run and update.
//
// File names stay the same from release to release, so links and instructions keep working.
// Run from source/ (npm run release). The previous release is replaced; git history keeps old ones.
//
// Usage: npm run release            (both)
//        npm run release -- --no-vsix (zip only; the .vsix step downloads VS Code's packager)
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // source/
const repo = join(root, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const out = join(repo, 'release');
const name = 'session-lens';
const stage = join(out, name);
const withVsix = !process.argv.includes('--no-vsix');

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
};

console.log('› building');
run('npm', ['run', 'build']);

console.log('› bundling the server into one file');
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
await build({
  entryPoints: [join(root, 'apps/server/src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(stage, 'session-lens.mjs'),
  logLevel: 'warning',
});
// Found next to the script at run time: the dashboard and the price table.
cpSync(join(root, 'packages/ui/dist'), join(stage, 'ui'), { recursive: true });
cpSync(join(root, 'config/pricing.json'), join(stage, 'pricing.json'));
cpSync(join(repo, 'LICENSE'), join(stage, 'LICENSE'));

writeFileSync(
  join(stage, 'Start Session Lens.cmd'),
  [
    '@echo off',
    'rem Session Lens: opens your Claude Code usage in the browser. Close this window to stop it.',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Session Lens needs Node.js 20 or newer: https://nodejs.org  ^(the LTS installer^)',
    '  pause',
    '  exit /b 1',
    ')',
    'node "%~dp0session-lens.mjs" %*',
    'if errorlevel 1 pause',
    '',
  ].join('\r\n'),
);
writeFileSync(
  join(stage, 'start-session-lens.sh'),
  [
    '#!/bin/sh',
    '# Session Lens: opens your Claude Code usage in the browser. Ctrl+C to stop.',
    'command -v node >/dev/null 2>&1 || { echo "Session Lens needs Node.js 20 or newer: https://nodejs.org"; exit 1; }',
    'exec node "$(dirname "$0")/session-lens.mjs" "$@"',
    '',
  ].join('\n'),
);
chmodSync(join(stage, 'start-session-lens.sh'), 0o755);
writeFileSync(
  join(stage, 'README.txt'),
  `Session Lens ${version}: your Claude Code usage, day > session > prompt > request > tool call.

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
`.replace(/\n/g, '\r\n'),
);

console.log('› zipping');
const zipName = `${name}-portable.zip`;
writeFileSync(join(out, zipName), zip(stage, name));

if (withVsix) {
  console.log('› packaging the VS Code extension');
  run('npm', ['run', 'package', '-w', 'apps/vscode']);
  cpSync(join(root, 'apps/vscode/session-lens.vsix'), join(out, `${name}.vsix`));
}

writeFileSync(
  join(out, 'README.md'),
  `# Session Lens ${version}: ready to run

Nothing to build. Pick one:

| | Needs | Do this |
|---|---|---|
| **Browser** | [Node.js](https://nodejs.org) 20+ (LTS installer) | Open \`session-lens/\` and double-click **Start Session Lens.cmd** (Windows) or run \`./start-session-lens.sh\` (macOS/Linux). Your browser opens on http://127.0.0.1:4317. Close the window to stop. |
| **VS Code** | VS Code | \`code --install-extension session-lens.vsix\`, then run **Session Lens: Open** from the command palette. |
| **Share it** | | Send \`session-lens-portable.zip\` (the browser version, zipped) or \`session-lens.vsix\`. |

**Updating:** \`git pull\` (or replace these files with newer ones). Your prices, discounts and plan live in
\`~/.session-lens/\` and carry over. After updating the VS Code extension, run *Developer: Reload Window*.

**Options** for the browser version, added after the script name: \`--port <n>\`, \`--projects <dir>\` (another
transcripts folder; comma-separate several), \`--no-open\`.

Read **About** in the app for what the numbers mean and their limits. Model prices go stale when Anthropic
changes them: **Settings → Check Anthropic’s prices**.

These files are built from \`../source\` with \`npm run release\`; don't edit them by hand.
`,
);

console.log('\nReady to share:');
for (const f of readdirSync(out)) {
  const st = statSync(join(out, f));
  console.log(`  release/${f}${st.isDirectory() ? '/' : `  (${Math.max(1, Math.round(st.size / 1024))} KB)`}`);
}

/* ---------- a small zip writer (deflate), so releasing needs no extra tools on any OS ---------- */

function zip(dir, prefix) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(`${prefix}/${relative(dir, file).split('\\').join('/')}`, 'utf8');
    const crc = crc32(data);
    const exec = file.endsWith('.sh');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by Unix, so the .sh keeps its execute bit
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((exec ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

if (!existsSync(join(out, zipName))) process.exit(1);
