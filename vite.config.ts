import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: true,
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
