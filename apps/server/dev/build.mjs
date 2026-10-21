import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: { local: 'dev/local.ts', alert: 'dev/alert.ts' },
  outdir: '../../.local/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // The local stack runs from the repository, where wasmoon (the Lua engine for MemoryKv) and impit (native, see
  // build.mjs) are installed.
  external: ['wasmoon', 'impit'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
