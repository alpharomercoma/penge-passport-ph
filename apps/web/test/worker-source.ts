// The service worker as the build writes it, for the tests that run it (pwa.test.ts, notify.test.ts).
import { join } from 'node:path';
import { serviceWorker } from '../sw-plugin.ts';

const web = join(__dirname, '..');

export type Bundle = Record<string, { type: 'asset'; source: string } | { type: 'chunk'; code: string }>;

/** What the plugin writes for a build with these files (and src/sw.js from `root`). */
export function built(bundle: Bundle, root = web) {
  const plugin = serviceWorker() as unknown as {
    configResolved(c: { root: string; publicDir: string }): void;
    generateBundle(this: { emitFile(f: { fileName: string; source: string }): void }, o: unknown, b: Bundle): void;
  };
  plugin.configResolved({ root, publicDir: join(web, 'public') });
  let source = '';
  plugin.generateBundle.call({ emitFile: (f) => (source = f.source) }, {}, bundle);
  const shell = JSON.parse(/const SHELL = (.*);/.exec(source)![1]!) as string[];
  const version = /const VERSION = '([0-9a-f]+)';/.exec(source)![1]!;
  return { source, shell, version };
}

export const BUILD: Bundle = {
  'index.html': { type: 'asset', source: '<html>' },
  'assets/index-abc.js': { type: 'chunk', code: 'app()' },
  'assets/index-def.css': { type: 'asset', source: 'body{}' },
};

/** The built worker's source, as a browser would get it. */
export const builtWorkerSource = () => built(BUILD).source;
