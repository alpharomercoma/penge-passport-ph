import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The library from source, as tsconfig.json's `paths` does for types and esbuild for the bundle.
    alias: { 'penge-passport-ph': fileURLToPath(new URL('../../packages/penge-passport-ph/src/index.ts', import.meta.url)) },
  },
});
