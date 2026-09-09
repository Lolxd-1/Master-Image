import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020',
    // The catalog payload dwarfs the bundle; inlining small assets keeps requests down.
    assetsInlineLimit: 8192,
  },
  server: {
    port: 5173,
    // `npm run dev` serves the UI here and forwards the API to `npm run dev:api`.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
