// The installable app: the manifest, its icons, and the service worker's rules
// (src/sw.js), run here against a fake cache and network.
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_SHELL, serviceWorker } from '../sw-plugin.ts';

const web = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(web, 'public/manifest.webmanifest'), 'utf8')) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  description: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

/** Width and height from a PNG's header. */
function pngSize(file: string) {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

describe('manifest', () => {
  it('stays inside the site path wherever it is served', () => {
    // Relative to the manifest, so /pengepassportph/ in production and / in development.
    expect([manifest.id, manifest.start_url, manifest.scope]).toEqual(['./', './', './']);
    expect(manifest.display).toBe('standalone');
  });

  it('says it is unofficial', () => {
    expect(manifest.description).toMatch(/Unofficial: not run by or affiliated with the Department of Foreign Affairs\.$/);
  });

  it('has icons that exist at the sizes it names, including a maskable one', () => {
    for (const icon of manifest.icons) {
      const file = join(web, 'public', icon.src);
      expect(existsSync(file)).toBe(true);
      expect(pngSize(file)).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
    expect(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    expect(manifest.icons.some((i) => i.purpose === 'any' && i.sizes === '512x512')).toBe(true);
    expect(pngSize(join(web, 'public/icons/apple-touch-icon.png'))).toBe('180x180');
  });

  it('is linked from the page', () => {
    const html = readFileSync(join(web, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    for (const name of PUBLIC_SHELL) expect(existsSync(join(web, 'public', name))).toBe(true);
  });
});

type Bundle = Record<string, { type: 'asset'; source: string } | { type: 'chunk'; code: string }>;

/** What the plugin writes for a build with these files (and src/sw.js from `root`). */
function built(bundle: Bundle, root = web) {
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

const BUILD: Bundle = {
  'index.html': { type: 'asset', source: '<html>' },
  'assets/index-abc.js': { type: 'chunk', code: 'app()' },
  'assets/index-def.css': { type: 'asset', source: 'body{}' },
};

describe('service worker build', () => {
  it('keeps the page, this build’s assets and the public files, relative to the worker', () => {
    const { shell } = built(BUILD);
    expect(shell).toEqual(['./', 'assets/index-abc.js', 'assets/index-def.css', ...PUBLIC_SHELL]);
    expect(shell).not.toContain('');
  });

  it('gets a new version when any file changes, even one keeping its name', () => {
    const a = built(BUILD).version;
    expect(built(BUILD).version).toBe(a);
    expect(built({ ...BUILD, 'index.html': { type: 'asset', source: '<html lang>' } }).version).not.toBe(a);
    expect(built({ ...BUILD, 'assets/index-abc.js': { type: 'chunk', code: 'app2()' } }).version).not.toBe(a);
  });

  it('gets a new version when only the worker changes, so the new one never reuses the old cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'penge-sw-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/sw.js'), `${readFileSync(join(web, 'src/sw.js'), 'utf8')}\n// changed\n`);
    mkdirSync(join(root, 'src/notify'), { recursive: true });
    writeFileSync(join(root, 'src/notify/shared.js'), readFileSync(join(web, 'src/notify/shared.js'), 'utf8'));
    expect(built(BUILD, root).version).not.toBe(built(BUILD).version);
  });

  it('writes plain JavaScript with every placeholder filled', () => {
    const { source } = built(BUILD);
    expect(source).not.toMatch(/__[A-Z]+__/);
    expect(() => new Function('self', 'caches', 'fetch', 'Response', source)).not.toThrow();
  });

    it('gets a new version when only the shared push code changes', () => {
      const root = mkdtempSync(join(tmpdir(), 'penge-sw-'));
      mkdirSync(join(root, 'src/notify'), { recursive: true });
      writeFileSync(join(root, 'src/sw.js'), readFileSync(join(web, 'src/sw.js'), 'utf8'));
      writeFileSync(join(root, 'src/notify/shared.js'), `${readFileSync(join(web, 'src/notify/shared.js'), 'utf8')}\n// changed\n`);
      expect(built(BUILD, root).version).not.toBe(built(BUILD).version);
    });

    it('inlines the shared push code without export statements', () => {
      const { source } = built(BUILD);
      expect(source).toMatch(/const withPushLock = /);
      expect(source).not.toMatch(/^export /m);
    });
});

const SCOPE = 'https://alphaexperiments.com/pengepassportph/';

/** Runs the built worker with a fake cache and network. */
function worker(opts: { online?: boolean; oldCaches?: string[]; indexedDB?: IDBFactory; locks?: unknown; fetch?: typeof fetch } = {}) {
  const { source, shell, version } = built(BUILD);
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const stored = new Map<string, Map<string, string>>();
  for (const name of opts.oldCaches ?? []) stored.set(name, new Map([[`${SCOPE}old`, 'old']]));
  type Req = string | { url: string; headers?: Record<string, string> };
  const urlOf = (r: Req) => new URL(typeof r === 'string' ? r : r.url, `${SCOPE}sw.js`).href;
  const network = vi.fn(async (r: { url: string }) => {
    if (opts.online === false) throw new TypeError('Failed to fetch');
    return new Response(`network ${r.url}`);
  });
  const caches = {
    open: async (name: string) => {
      const cache = stored.get(name) ?? new Map<string, string>();
      stored.set(name, cache);
      return { addAll: async (urls: string[]) => urls.forEach((u) => cache.set(urlOf(u), `cached ${urlOf(u)}`)) };
    },
    keys: async () => [...stored.keys()],
    delete: async (name: string) => stored.delete(name),
    // Stored as a server sending "Vary: Origin" answers a request without one (vite preview does).
    match: async (r: Req, o: { cacheName: string; ignoreVary?: boolean }) => {
      const origin = typeof r === 'string' ? undefined : r.headers?.origin;
      if (origin !== undefined && !o.ignoreVary) return undefined;
      const body = stored.get(o.cacheName)?.get(urlOf(r));
      return body === undefined ? undefined : new Response(body);
    },
  };
  const self = {
    registration: { scope: SCOPE, showNotification: vi.fn(async (_title: string, _options: unknown) => {}), pushManager: { getSubscription: vi.fn(async (): Promise<unknown> => null), subscribe: vi.fn() } },
    location: new URL(`${SCOPE}sw.js`),
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] ??= []).push(fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async (_o?: unknown): Promise<unknown[]> => []), openWindow: vi.fn(async (_url: string) => null) },
    indexedDB: opts.indexedDB,
    navigator: { locks: opts.locks },
    crypto: webcrypto,
  };
  new Function('self', 'caches', 'fetch', 'Response', source)(self, caches, opts.fetch ?? network, Response);

  /** Runs the worker's listeners for one event and waits for what they handed to waitUntil. */
  async function fire(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners[type] ?? []) fn({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }

  const lifecycle = async (type: 'install' | 'activate') => {
    let done: Promise<unknown> = Promise.resolve();
    listeners[type]![0]!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  /** The response the worker gives, or null when it leaves the request to the browser. */
  const request = async (url: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}) => {
    let answer: Promise<Response> | null = null;
    listeners.fetch![0]!({
      request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors', headers: init.headers ?? {} },
      respondWith: (p: Promise<Response>) => (answer = p),
    });
    return answer === null ? null : ((await answer) as Response);
  };
  return { lifecycle, request, network, stored, shell, cacheName: `pengepassportph-${version}`, self, fire };
}

describe('service worker', () => {
  it('stores the shell on install, then drops only the last build’s cache', async () => {
    // Caches are shared by the whole origin: another app on alphaexperiments.com keeps its own.
    const others = ['someone-else', 'penge-other-app', 'pengepassport-other'];
    const w = worker({ oldCaches: ['pengepassportph-000000000000', ...others] });
    await w.lifecycle('install');
    expect([...w.stored.get(w.cacheName)!.keys()]).toEqual(w.shell.map((u) => new URL(u, SCOPE).href));
    expect(w.self.skipWaiting).toHaveBeenCalled();
    await w.lifecycle('activate');
    expect([...w.stored.keys()].sort()).toEqual([w.cacheName, ...others].sort());
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it('never answers for the API, even offline: dates always come from the server', async () => {
    const w = worker({ online: false });
    await w.lifecycle('install');
    for (const path of ['api/status', 'api/abroad', 'api/offices/486/times?date=2026-10-07', 'api/'])
      expect(await w.request(`${SCOPE}${path}`)).toBeNull();
    expect(await w.request(`${SCOPE}api/status`, { mode: 'navigate' })).toBeNull();
    expect(await w.request(`${SCOPE}api/subscribe`, { method: 'POST' })).toBeNull();
    expect(w.network).not.toHaveBeenCalled();
  });

  it('leaves other sites and other paths on this host alone', async () => {
    const w = worker();
    await w.lifecycle('install');
    expect(await w.request('https://passport.gov.ph/appointment', { mode: 'navigate' })).toBeNull();
    expect(await w.request('https://alphaexperiments.com/other/', { mode: 'navigate' })).toBeNull();
    expect(await w.request('https://alphaexperiments.com/.well-known/assetlinks.json')).toBeNull();
    expect(await w.request('https://alphaexperiments.com/pengepassportphx/', { mode: 'navigate' })).toBeNull();
  });

  it('loads pages from the network when it can, so a deploy shows at once', async () => {
    const w = worker();
    await w.lifecycle('install');
    const page = await w.request(`${SCOPE}?office=486&date=2026-10-07`, { mode: 'navigate' });
    expect(await page!.text()).toBe(`network ${SCOPE}?office=486&date=2026-10-07`);
  });

  it('opens the stored app offline, at any page', async () => {
    const w = worker({ online: false });
    await w.lifecycle('install');
    for (const path of ['', '?in=abroad', 'privacy', 'confirm'])
      expect(await (await w.request(`${SCOPE}${path}`, { mode: 'navigate' }))!.text()).toBe(`cached ${SCOPE}`);
  });

  it('fails a page plainly offline before anything is stored', async () => {
    const w = worker({ online: false });
    const page = await w.request(SCOPE, { mode: 'navigate' });
    expect(page!.type).toBe('error');
  });

  it('serves this build’s files from the device, and anything else it does not know from the network', async () => {
    const w = worker();
    await w.lifecycle('install');
    expect(await (await w.request(`${SCOPE}assets/index-abc.js`))!.text()).toBe(`cached ${SCOPE}assets/index-abc.js`);
    expect(await (await w.request(`${SCOPE}icons/icon-192.png`))!.text()).toBe(`cached ${SCOPE}icons/icon-192.png`);
    expect(w.network).not.toHaveBeenCalled();
    expect(await (await w.request(`${SCOPE}assets/index-new.js`))!.text()).toBe(`network ${SCOPE}assets/index-new.js`);
    expect(await w.request(`${SCOPE}robots.txt`)).toBeNull();
  });

  it('serves the stored script offline though a module script sends an Origin header', async () => {
    const w = worker({ online: false });
    await w.lifecycle('install');
    const script = await w.request(`${SCOPE}assets/index-abc.js`, { headers: { origin: 'https://alphaexperiments.com' } });
    expect(await script!.text()).toBe(`cached ${SCOPE}assets/index-abc.js`);
  });

  it('shows a notification for every push, even an unreadable one', async () => {
    const w = worker();
    await w.fire('push', { data: { json: () => ({ v: 1, title: 'Dates open at Antipolo', body: 'Fri 9 Oct · for 1 person', tag: 'alert-d1', url: { office: 486, date: '2026-10-09', people: 1 } }) } });
    expect(w.self.registration.showNotification).toHaveBeenCalledWith('Dates open at Antipolo', expect.objectContaining({ body: 'Fri 9 Oct · for 1 person', tag: 'alert-d1' }));
    await w.fire('push', { data: { json: () => { throw new Error('bad'); } } });
    expect(w.self.registration.showNotification).toHaveBeenLastCalledWith('New dates are open', expect.objectContaining({ body: expect.any(String) }));
  });

  it('navigates an open window to the office instead of opening another (Review Focus 5)', async () => {
    const w = worker();
    const client = { url: `${SCOPE}?office=693`, navigate: vi.fn(async () => client), focus: vi.fn(async () => client) };
    w.self.clients.matchAll = vi.fn(async () => [client]);
    await w.fire('notificationclick', { notification: { data: { office: 486, date: '2026-10-09', people: 2 }, close: vi.fn() } });
    expect(client.navigate).toHaveBeenCalledWith(`${SCOPE}?office=486&date=2026-10-09&people=2`);
    expect(client.focus).toHaveBeenCalled();
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window when the open tab cannot be moved (a tab this worker does not control)', async () => {
    const w = worker();
    const client = { url: `${SCOPE}`, navigate: vi.fn(async () => { throw new TypeError('not controlled'); }), focus: vi.fn(async () => client) };
    w.self.clients.matchAll = vi.fn(async () => [client]);
    await w.fire('notificationclick', { notification: { data: { office: 486 }, close: vi.fn() } });
    expect(w.self.clients.openWindow).toHaveBeenCalledWith(`${SCOPE}?office=486`);
  });

  it('opens the app when no window is open, and ignores a bad link in the payload', async () => {
    const w = worker();
    await w.fire('notificationclick', { notification: { data: { office: 'javascript:alert(1)', date: 'x', people: 99 }, close: vi.fn() } });
    expect(w.self.clients.openWindow).toHaveBeenCalledWith(SCOPE);
  });

  it('re-registers with the server when the browser renews the subscription', async () => {
    const locks = { request: (_n: string, fn: () => Promise<unknown>) => fn() };
    const idb = new IDBFactory();
    const posted: unknown[] = [];
    // The worker's own fetch (the harness passes it into the worker's scope).
    const renewFetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      posted.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify({ state: 'registered' }));
    }) as unknown as typeof fetch;
    const w = worker({ indexedDB: idb, locks, fetch: renewFetch });
    // This browser had push on: a credential and the key, as the page stores them.
    const { writeState } = await import('../src/notify/shared.js');
    await writeState({ indexedDB: idb, locks: locks as unknown as LockManager, crypto: webcrypto as unknown as Crypto }, { credential: 'c'.repeat(43), confirmed: true, revision: 1, fingerprint: 'old', applicationServerKey: `B${'A'.repeat(86)}` });
    const renewed = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/renewed', keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'AQEBAQEBAQEBAQEBAQEBAQ' } }), unsubscribe: vi.fn() };
    w.self.registration.pushManager.getSubscription = vi.fn(async () => renewed);
    await w.fire('pushsubscriptionchange', {});
    expect(posted).toEqual([expect.objectContaining({ credential: 'c'.repeat(43), revision: 2, subscription: expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/renewed' }) })]);
  });

  it('answers the capabilities handshake', async () => {
    const w = worker();
    const port = { postMessage: vi.fn() };
    await w.fire('message', { data: { type: 'capabilities' }, ports: [port] });
    expect(port.postMessage).toHaveBeenCalledWith({ version: expect.stringMatching(/^[0-9a-f]{12}$/), push: true });
  });

  it('keeps the notification mark the same drawing as the Android monochrome icon', () => {
    const svg = readFileSync(join(web, 'public/icons/mark-monochrome.svg'), 'utf8');
    const xml = readFileSync(join(web, '../../android/res/drawable/ic_launcher_monochrome.xml'), 'utf8');
    const paths = (text: string, attr: RegExp) => [...text.matchAll(attr)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
    expect(paths(svg, / d="([^"]+)"/g)).toEqual(paths(xml, /android:pathData="([^"]+)"/g));
    for (const size of [96, 512]) {
      const png = readFileSync(join(web, `public/icons/${size === 96 ? 'badge-96' : 'monochrome-512'}.png`));
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(`${size}x${size}`);
    }
  });
});
