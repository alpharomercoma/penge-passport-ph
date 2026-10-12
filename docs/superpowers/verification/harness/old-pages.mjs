// node old-pages.mjs — pages of the channel release and of the release before push, open in a browser after the
// deploy, against the new server: email works as it did; anything about notifications says to reload.
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { clickText, gone, lastMail, launch, linkIn, notifyOnly, ORIGIN, REPO, resetRateLimits, serveWeb, SITE, sleep, stopWeb, waitText, workerReady } from './lib.mjs';

// Any P-256 key binds a subscription (as the old page's own key did); the last 65 bytes of its SPKI form are the point.
const ANY_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).subarray(-65).toString('base64url');
const hasSub = (p) => p.evaluate(async () => !!(await (await navigator.serviceWorker.ready).pushManager.getSubscription()));
/** A subscription in the page's registration, if it has none. */
const subscribeAny = (p) =>
  p.evaluate(async (k) => {
    const reg = await navigator.serviceWorker.ready;
    const raw = Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    if (!(await reg.pushManager.getSubscription())) await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
  }, ANY_KEY);
/** The 05cee09 database's state ('pengepassportph-push', store 'state', key 'device'), as that release wrote it. */
const putOldState = (p, state) =>
  p.evaluate(
    (k, st) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('pengepassportph-push', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('state');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('state', 'readwrite');
          tx.objectStore('state').put({ credential: 'c'.repeat(43), revision: 1, fingerprint: null, applicationServerKey: k, ...st }, 'device');
          tx.oncomplete = () => (req.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    ANY_KEY,
    state,
  );
/**
 * Answers the old page's POST /api/push/device with "missing" (what the new server's answer means to it); counts them.
 * With `hold`, the answers wait until `release()`: the old page's reconcile stays suspended mid-call, as a frozen tab's.
 */
async function answerMissing(p, o = {}) {
  const held = [];
  const asked = { count: 0, release: () => held.splice(0).forEach((f) => f()) };
  const answer = (req) => void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'missing' }) });
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/push/device')) {
      asked.count++;
      if (o.hold) return void held.push(() => answer(req));
      return answer(req);
    }
    return void req.continue();
  });
  return asked;
}
/** Waits for the old page to be asked, then for its subscription to be (or stay) `want`. */
async function settleSub(p, asked, want) {
  for (let i = 0; i < 40 && asked.count === 0; i++) await sleep(250);
  let has = await hasSub(p);
  for (let i = 0; i < 20 && has !== want; i++) {
    await sleep(250);
    has = await hasSub(p);
  }
  if (want) {
    await sleep(1500); // and still kept a moment later
    has = await hasSub(p);
  }
  return has;
}

const results = [];
const record = (item, pass, note = '') => (results.push({ item, pass, note }), console.log(pass ? 'PASS' : 'FAIL', item, note));
resetRateLimits();
function serve(commit, port) {
  const dir = `/tmp/penge-old-${commit}`;
  if (!existsSync(dir)) execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', dir, commit], { stdio: 'inherit' });
  // npm's cache and logs stay inside the throwaway worktree, not in the home directory.
  const npmEnv = { ...process.env, npm_config_cache: `${dir}/.npm-cache` };
  execFileSync('npm', ['ci'], { cwd: dir, stdio: 'inherit', env: npmEnv });
  // The same BASE_PATH for the build and the preview: vite.config.ts derives the /api proxy's path from it.
  const env = { ...npmEnv, BASE_PATH: 'pengepassportph' };
  execFileSync('npm', ['run', 'build', '-w', '@penge/web'], { cwd: dir, stdio: 'inherit', env });
  return spawn(`${dir}/node_modules/.bin/vite`, ['preview', '--port', String(port), '--strictPort'], { cwd: `${dir}/apps/web`, stdio: 'ignore', env });
}
const servers = [serve('05cee09', 4174), serve('157bad9', 4175)];
// Ready when each preview serves the page and proxies the API.
for (const port of [4174, 4175]) {
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://localhost:${port}/pengepassportph/api/status`).then((r) => r.ok, () => false);
    if (ok) break;
    if (i === 59) throw new Error(`preview on ${port} did not come up`);
    await sleep(500);
  }
}
// node old-pages.mjs [chrome|firefox]
const kind = process.argv[2] ?? 'chrome';
const browser = await launch(kind, { prefs: { 'permissions.default.desktop-notification': 1 } });
try {
  for (const [commit, port] of [['05cee09', 4174], ['157bad9', 4175]]) {
    const page = await browser.newPage();
    const site = `http://localhost:${port}/pengepassportph/`;
    const email = `old-${commit}-${Date.now()}@example.com`;
    await page.goto(site, { waitUntil: 'networkidle0' });
    await clickText(page, 'button', 'Email alerts');
    await page.type('input[type="search"]', 'Antipolo');
    await page.click('.pick input[type="checkbox"]');
    await page.type('input[type="email"]', email);
    await clickText(page, 'button[type="submit"]', 'Send confirmation email');
    await waitText(page, 'Check your inbox');
    const link = linkIn(lastMail('confirm', email).text, '/confirm').replace(/localhost:\d+/, `localhost:${port}`);
    await page.goto(link, { waitUntil: 'networkidle0' });
    await clickText(page, 'button', commit === '05cee09' ? 'Confirm alert' : 'Confirm email alert');
    await waitText(page, 'We will email you');
    record(`A ${commit} page signs up and confirms an email alert`, true);
    await page.close();
  }
  // A 05cee09 page asking for notifications (owner link in the old way) is told to reload, and nothing is written.
  const page = await browser.newPage();
  await page.goto('http://localhost:4174/pengepassportph/?push=owner', { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() =>
    fetch('/pengepassportph/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null } }) }).then(async (res) => ({ status: res.status, body: await res.json() })),
  );
  record('A 05cee09 page asking for notifications is told to reload', r.status === 409 && r.body.error === 'This page is out of date. Reload it.', JSON.stringify(r));
  await page.close();

  // ---- The 05cee09 page's own reconcile, told "missing" (spec: the old page's 48-hour protection). ----
  // On its preview origin: it drops the subscription when its state was confirmed or asked over 48 hours ago, and keeps
  // it when asked under 48 hours ago.
  const OLD_ORIGIN = 'http://localhost:4174';
  await browser.defaultBrowserContext().overridePermissions(OLD_ORIGIN, ['notifications']);
  const cases = [
    { name: 'confirmed', state: { confirmed: true, askedAt: null }, kept: false },
    { name: 'unconfirmed, asked 49 hours ago', state: { confirmed: false, askedAt: Date.now() - 49 * 3_600_000 }, kept: false },
    { name: 'unconfirmed, asked 1 hour ago', state: { confirmed: false, askedAt: Date.now() - 3_600_000 }, kept: true },
  ];
  for (const c of cases) {
    const old = await browser.newPage();
    const asked = await answerMissing(old);
    await old.goto(`${OLD_ORIGIN}/pengepassportph/`, { waitUntil: 'networkidle0' });
    await subscribeAny(old);
    await putOldState(old, c.state);
    const before = await hasSub(old);
    await old.evaluate(() => window.dispatchEvent(new Event('focus'))); // resumed: the old row reconciles on focus
    const after = await settleSub(old, asked, c.kept);
    record(`A resumed 05cee09 page, ${c.name}, told "missing": ${c.kept ? 'keeps' : 'drops'} its subscription`, before && asked.count > 0 && after === c.kept, JSON.stringify({ before, asked: asked.count, after }));
    await old.evaluate(async () => {
      await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
      await new Promise((r) => {
        const d = indexedDB.deleteDatabase('pengepassportph-push');
        d.onsuccess = d.onerror = d.onblocked = r;
      });
    });
    await old.close();
  }

  // ---- One origin (spec: "Old pages and the shared subscription"): today's worker, a new alert, and an old page. ----
  // The 05cee09 page is served beside today's build on the local stack's own origin, so it shares today's worker and the
  // new alert's subscription. Today's worker fetches navigations from the network first, so /old-05cee09.html is the
  // old page, and its hashed assets load beside today's.
  const OLD_DIST = '/tmp/penge-old-05cee09/apps/web/dist';
  const NEW_DIST = `${REPO}/apps/web/dist`;
  const newSw = readFileSync(`${NEW_DIST}/sw.js`, 'utf8');
  const oldSw = readFileSync(`${OLD_DIST}/sw.js`, 'utf8');
  const newMain = /assets\/index-[\w-]+\.js/.exec(readFileSync(`${NEW_DIST}/index.html`, 'utf8'))?.[0] ?? 'missing';
  const added = [];
  try {
    for (const f of readdirSync(`${OLD_DIST}/assets`)) {
      if (existsSync(`${NEW_DIST}/assets/${f}`)) continue;
      copyFileSync(`${OLD_DIST}/assets/${f}`, `${NEW_DIST}/assets/${f}`);
      added.push(`${NEW_DIST}/assets/${f}`);
    }
    copyFileSync(`${OLD_DIST}/index.html`, `${NEW_DIST}/old-05cee09.html`);
    added.push(`${NEW_DIST}/old-05cee09.html`);
    await gone(stopWeb());
    await serveWeb(`${REPO}/apps/web`, (t) => t === newSw);
    await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
    // Today's worker installed first: its first activation reloads every open page (the case below, in a fresh
    // profile), which would also reload these old tabs and undo their freezing.
    const warm = await browser.newPage();
    await warm.goto(SITE, { waitUntil: 'networkidle0' });
    await warm.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', { timeout: 20_000 });
    await warm.close();
    // A frozen 05cee09 tab resumes after today's page retired its credential and set up a new alert (subscription B):
    // - frozen after reading its state but before reading its subscription, it reads B, is told "missing" and, unless
    //   its 48-hour protection holds, unsubscribes B: the spec's remaining case (the alert ends as gone);
    // - frozen with its request in flight, it holds the subscription it read before (A, which retirement replaced), and
    //   unsubscribes that: Chromium's unsubscribe acts on the registration, not on the endpoint it was read with, so B
    //   goes too, the same remaining case (seen 2026-10-13; the spec had expected A alone). Either outcome is accepted
    //   (B kept is better); the next send and the row must then follow it.
    const variants = [
      { name: 'confirmed, frozen before reading its subscription', state: { confirmed: true, askedAt: null }, freeze: 'subscription', removes: true },
      { name: 'unconfirmed, asked 49 hours ago, frozen before reading its subscription', state: { confirmed: false, askedAt: Date.now() - 49 * 3_600_000 }, freeze: 'subscription', removes: true },
      { name: 'unconfirmed, asked 1 hour ago, frozen before reading its subscription', state: { confirmed: false, askedAt: Date.now() - 3_600_000 }, freeze: 'subscription', removes: false },
      { name: 'confirmed, frozen with its request in flight', state: { confirmed: true, askedAt: null }, freeze: 'request', removes: 'either' },
      // Its database holds no credential (its switch never turned on): it never touches the subscription.
      { name: 'with an empty database', state: { credential: null, confirmed: false, askedAt: null }, freeze: 'none', removes: false, empty: true },
    ];
    const endpointOf = (p) => p.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null);
    for (const c of variants) {
      try {
        resetRateLimits();
        const old = await browser.newPage();
        const asked = await answerMissing(old, { hold: c.freeze === 'request' });
        // The old app routes by path: before it boots, the address becomes the site's own, so it shows its home page (and row).
        await old.evaluateOnNewDocument(() => {
          if (location.pathname.endsWith('/old-05cee09.html')) history.replaceState(null, '', location.pathname.replace(/old-05cee09\.html$/, ''));
        });
        await old.goto(`${SITE}old-05cee09.html`, { waitUntil: 'networkidle0' });
        await old.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Email alerts')), { timeout: 10_000 });
        if (!c.empty) await subscribeAny(old);
        const a = await endpointOf(old);
        await putOldState(old, c.state);
        if (c.freeze === 'subscription') {
          // Frozen at its first subscription read: the old reconcile (which has read its state) waits here.
          await old.evaluate(() => {
            const orig = PushManager.prototype.getSubscription;
            const gate = new Promise((r) => (window.__thaw = r));
            let first = true;
            PushManager.prototype.getSubscription = function (...args) {
              if (!first) return orig.apply(this, args);
              first = false;
              window.__frozen = true;
              return gate.then(() => orig.apply(this, args));
            };
          });
        }
        await old.evaluate(() => window.dispatchEvent(new Event('focus')));
        if (c.freeze === 'subscription') await old.waitForFunction(() => window.__frozen === true, { timeout: 10_000 });
        else if (c.freeze === 'request') for (let i = 0; i < 40 && asked.count === 0; i++) await sleep(250);
        else await sleep(2000);
        const frozenAsked = asked.count;
        // Meanwhile today's page opens: it retires the old credential (A goes) and sets up a new alert (B).
        const fresh = await browser.newPage();
        await fresh.goto(SITE, { waitUntil: 'networkidle0' });
        await workerReady(fresh);
        await notifyOnly(fresh);
        const b = await endpointOf(fresh);
        const credential = await fresh.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const req = indexedDB.open('pengepassportph-device-alerts', 1);
              req.onerror = () => reject(req.error);
              req.onsuccess = () => {
                const get = req.result.transaction('state').objectStore('state').get('device');
                get.onsuccess = () => (req.result.close(), resolve(get.result?.credential ?? null));
              };
            }),
        );
        // Closed: no page of today's build reconciles (and rotates) between the old tab's step and the next send.
        await fresh.close();
        // The old tab resumes.
        if (c.freeze === 'subscription') await old.evaluate(() => window.__thaw());
        else if (c.freeze === 'request') asked.release();
        else await old.evaluate(() => window.dispatchEvent(new Event('focus'))); // the empty page looks again
        if (!c.empty) for (let i = 0; i < 40 && asked.count === 0; i++) await sleep(250);
        await sleep(1500);
        const after = await endpointOf(old);
        const frozenOk = c.freeze === 'request' ? frozenAsked > 0 : frozenAsked === 0;
        const asks = c.empty ? asked.count === 0 : !!a && a !== b && asked.count > 0;
        record(
          c.empty
            ? 'One origin, a 05cee09 tab with an empty database beside a new setup: asks nothing and leaves the new subscription'
            : `One origin, a frozen 05cee09 tab (${c.name}) resumed with "missing": ${c.removes === 'either' ? 'removes or leaves' : c.removes ? 'removes' : 'leaves'} the new alert's subscription`,
          frozenOk && !!b && asks && (c.removes === 'either' ? after === null || after === b : c.removes ? after === null : after === b),
          JSON.stringify({ frozenOk, replaced: a !== b, asked: asked.count, after: after === null ? 'none' : after === b ? 'B' : 'other' }),
        );
        await old.evaluate(
          () =>
            new Promise((r) => {
              const d = indexedDB.deleteDatabase('pengepassportph-push');
              d.onsuccess = d.onerror = d.onblocked = r;
            }),
        );
        await old.close();
        const kept = c.removes === 'either' ? after === b : !c.removes;
        // The next send: a test push through the API, as the row's "Send a test" sends it (up to 3 tries, 20 s apart,
        // while the push service catches up with an unsubscribe).
        const call = (method, path) =>
          fetch(`${SITE}api/device-alerts/${path}`, { method, headers: { authorization: `Device ${credential}`, 'content-type': 'application/json', origin: ORIGIN }, body: method === 'GET' ? undefined : '{}' }).then((r) => r.json());
        let test = null;
        for (let i = 0; i < (kept ? 1 : 3) && test !== 'gone'; i++) {
          if (i > 0) await sleep(20_000);
          test = (await call('POST', 'mine/test').catch(() => null))?.test ?? null;
        }
        const mine = await call('GET', 'mine').catch(() => null);
        const back = await browser.newPage();
        await back.goto(SITE, { waitUntil: 'networkidle0' });
        if (kept) {
          record('Left: the next send is accepted and the alert stays on', test === 'accepted' && mine?.state === 'active', JSON.stringify({ test, state: mine?.state }));
          await clickText(back, '.device-row button', 'Turn off'); // clean for the next run
          await sleep(1500);
        } else {
          record('Removed: the next send gets gone, and the server ends the alert as gone', test === 'gone' && mine?.state === 'gone', JSON.stringify({ test, state: mine?.state }));
          await waitText(back, 'Notifications need setting up again on this device.');
          record('Reopened, the row asks to set up again', true);
        }
        await back.close();
      } catch (err) {
        // Recorded with what every open page shows; the next variant still runs.
        record(`One origin (${c.name}) ran to the end`, false, String(err?.stack ?? err).slice(0, 600));
        for (const [n, p] of (await browser.pages()).entries()) await p.screenshot({ path: `${REPO}/docs/superpowers/verification/img/old-pages-error-${n}.png` }).catch(() => {});
        for (const p of (await browser.pages()).slice(1)) await p.close().catch(() => {});
      }
    }

    // ---- Today's worker reloads an open 05cee09 tab once, on its first activation (a fresh profile). ----
    // Another launch, a throwaway profile of its own (an incognito context would refuse push subscriptions).
    const second = await launch(kind, { prefs: { 'permissions.default.desktop-notification': 1 } });
    const ctx = second.defaultBrowserContext();
    await gone(stopWeb());
    await serveWeb('/tmp/penge-old-05cee09/apps/web', (t) => t === oldSw);
    const tab = await ctx.newPage();
    await tab.goto(SITE, { waitUntil: 'networkidle0' });
    await tab.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', { timeout: 20_000 });
    await tab.evaluate(() => {
      window.__oldTab = true;
    });
    await gone(stopWeb());
    await serveWeb(`${REPO}/apps/web`, (t) => t === newSw);
    const other = await ctx.newPage();
    await other.goto(SITE, { waitUntil: 'networkidle0' }); // finds today's worker; it activates and reloads open pages
    await tab.waitForFunction(() => window.__oldTab === undefined, { timeout: 30_000 }).catch(() => undefined);
    // Reloaded: read its scripts once the new document has loaded (Firefox answers while it is still loading).
    await tab.waitForFunction(() => window.__oldTab !== undefined || (document.readyState === 'complete' && document.scripts.length > 0), { timeout: 30_000 }).catch(() => undefined);
    const scripts = await tab.evaluate(() => (window.__oldTab === undefined ? [...document.scripts].map((x) => x.src).join(' ') : 'not reloaded'));
    record("Today's worker reloads an open 05cee09 tab on its first activation", scripts.includes(newMain), scripts);

    // ---- A 05cee09 credential from a refused signup, with its subscription: retired before today's setup. ----
    await ctx.overridePermissions(ORIGIN, ['notifications']);
    await subscribeAny(other);
    const oldEndpoint = await other.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null);
    await putOldState(other, { credential: 'c'.repeat(43), confirmed: false, askedAt: Date.now() });
    await other.reload({ waitUntil: 'networkidle0' });
    resetRateLimits();
    await notifyOnly(other);
    const now = await other.evaluate(async () => ({
      endpoint: (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null,
      legacy: (await indexedDB.databases()).some((d) => d.name === 'pengepassportph-push'),
    }));
    record('A 05cee09 credential is retired before setup: its database deleted, its subscription replaced, and setup succeeds', !now.legacy && !!now.endpoint && now.endpoint !== oldEndpoint, JSON.stringify({ legacy: now.legacy, replaced: now.endpoint !== oldEndpoint }));
    await second.close();
  } finally {
    for (const f of added) rmSync(f, { force: true });
    await gone(stopWeb());
    await serveWeb(`${REPO}/apps/web`, (t) => t === newSw); // today's build, as the local stack serves it
  }
} finally {
  writeFileSync(`${REPO}/docs/superpowers/verification/results/old-pages${kind === 'chrome' ? '' : `-${kind}`}.json`, JSON.stringify({ browser: await browser.version(), results }, null, 2));
  await browser.close();
  for (const s of servers) s.kill();
}
process.exitCode = results.every((x) => x.pass) ? 0 : 1;
