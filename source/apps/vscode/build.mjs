// Bundles the extension (and @session-lens/core) into one CommonJS file, and copies the dashboard.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.cjs',
  external: ['vscode'],
  sourcemap: true,
  // core locates pricing.json via import.meta.url; give the CJS bundle an equivalent.
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
});
cpSync('../../config/pricing.json', 'dist/pricing.json');
cpSync('../../packages/ui/dist', 'dist/ui', { recursive: true });
console.log('built dist/extension.cjs + dist/ui');
