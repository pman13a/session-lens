import { defineConfig } from 'vite';

// Relative base so the same bundle loads from the HTTP server, an Electron window and a VS Code webview.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500, assetsInlineLimit: 0 },
  server: { proxy: { '/api': 'http://127.0.0.1:4317' } },
});
