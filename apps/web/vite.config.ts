import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { serviceWorker } from './sw-plugin.ts';

// The path the site is served under, e.g. /pengepassportph/ at alphaexperiments.com.
// deploy/release.sh sets it from deploy/site.conf; it must end with a slash.
const base = `/${(process.env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
// The local stack's API (apps/server/dev/local.ts), for both `vite dev` and `vite preview`.
const apiProxy = { [`${base}api`]: { target: 'http://127.0.0.1:8787', rewrite: (p: string) => p.slice(base.length - 1) } };

const config = {
  base,
  plugins: [react(), serviceWorker()],
  build: {
    // No source maps in production, and nothing inlined: the Content-Security-Policy
    // Caddy sends allows scripts and styles from this origin only.
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  // `npm run dev` or `vite preview` with the API running locally (apps/server/dev/README.md).
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
};

export default defineConfig(({ mode }) => {
  // A release must never carry the local debug line, whether the flag comes from the
  // shell or from one of Vite's .env files (which process.env does not show here).
  if (process.env.RELEASE === '1' && (process.env.VITE_LOCAL_DEBUG === '1' || loadEnv(mode, process.cwd(), 'VITE_').VITE_LOCAL_DEBUG === '1')) {
    throw new Error('VITE_LOCAL_DEBUG must not be set for a release build');
  }
  return config;
});
