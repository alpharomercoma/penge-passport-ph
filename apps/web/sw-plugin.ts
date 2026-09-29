import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Files from public/ the app needs offline, beside the page and its built assets. */
export const PUBLIC_SHELL = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'favicon.svg'];

/**
 * Writes sw.js from src/sw.js with this build's files to keep on the device (the
 * page, its script and styles, the manifest and icons) and a version made from
 * their contents and the worker's own, so any change to them replaces the copy
 * on the device.
 */
export function serviceWorker(): Plugin {
  let root = '';
  let publicDir = '';
  return {
    name: 'penge-service-worker',
    apply: 'build',
    // After Vite writes index.html, so the version covers the page too.
    enforce: 'post',
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
    },
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).filter((name) => name.startsWith('assets/')).sort();
      // Relative to sw.js, which sits at the root of the site's path: "./" is the page itself.
      const shell = ['./', ...built, ...PUBLIC_SHELL];
      const worker = readFileSync(join(root, 'src/sw.js'), 'utf8');
      const hash = createHash('sha256').update(worker);
      for (const name of Object.keys(bundle).sort()) {
        const file = bundle[name]!;
        hash.update(`${name}\n`).update(file.type === 'chunk' ? file.code : file.source);
      }
      for (const name of PUBLIC_SHELL) hash.update(`${name}\n`).update(readFileSync(join(publicDir, name)));
      const source = worker
        .replace('__VERSION__', () => hash.digest('hex').slice(0, 12))
        .replace('__SHELL__', () => JSON.stringify(shell));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
