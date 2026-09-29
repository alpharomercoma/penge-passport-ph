import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { serviceWorker } from './sw-plugin.ts';

// The path the site is served under, e.g. /pengepassportph/ at alphaexperiments.com.
// deploy/release.sh sets it from deploy/site.conf; it must end with a slash.
const base = `/${(process.env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');

export default defineConfig({
  base,
  plugins: [react(), serviceWorker()],
  build: {
    // No source maps in production, and nothing inlined: the Content-Security-Policy
    // Caddy sends allows scripts and styles from this origin only.
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    // `npm run dev` with the API running locally (`node apps/server/dist/server.mjs`).
    proxy: { [`${base}api`]: { target: 'http://127.0.0.1:8787', rewrite: (p) => p.slice(base.length - 1) } },
  },
});
