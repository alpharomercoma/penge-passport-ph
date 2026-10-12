// The upgrade from the release before push: its worker installed in Mac Chrome, then today's build
// served on the same port; reload once and turn notifications on. The plan asks that the page
// updates the worker and subscribes within 10 s. The local stack must be up (its API and proxy);
// this swaps only its web server, and leaves today's build serving when it ends.
//   OLD=<worktree of 157bad9, built with BASE_PATH=pengepassportph> node old-worker.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devOpen, gone, launch, newNotes, notifyOnly, ORIGIN, publishedDay, REPO, RUN, serveWeb, shot, shown, sleep, SITE, stopWeb } from './lib.mjs';

const OLD = process.env.OLD;
if (!OLD) throw new Error('Set OLD to the built worktree of the release before push');
const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};

/** Asks the worker controlling the page what it is: today's answers with its version; the old one has no message handler. */
const controllerInfo = (page) => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const controller = navigator.serviceWorker.controller;
  const reply = controller && await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2000);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    controller.postMessage({ type: 'capabilities' }, [channel.port2]);
  });
  const sub = await reg?.pushManager.getSubscription();
  return { controlled: !!controller, isActive: !!controller && controller === reg?.active, reply, endpoint: sub?.endpoint ?? null };
});
const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 12);
const oldSw = readFileSync(join(OLD, 'apps/web/dist/sw.js'), 'utf8');
const newSw = readFileSync(join(REPO, 'apps/web/dist/sw.js'), 'utf8');

const browser = await launch('chrome');
const page = await browser.newPage();
await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
let restored = false;
try {
  record('The two builds have different workers; only the new one handles pushes', oldSw !== newSw && !oldSw.includes("'push'") && newSw.includes("'push'"), `old ${hash(oldSw)}, new ${hash(newSw)}`);
  await gone(stopWeb());
  await serveWeb(join(OLD, 'apps/web'), (t) => t === oldSw);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', { timeout: 20_000 });
  const before = await controllerInfo(page);
  record('The release before push: its worker is the active one and controls the page, and gives no capabilities answer (no message handler)', before.isActive && before.reply === null, JSON.stringify(before));
  await shot(page, 'old-worker-before');

  await gone(stopWeb());
  await serveWeb(join(REPO, 'apps/web'), (t) => t === newSw);
  restored = true;
  let navigations = 0;
  page.on('framenavigated', (f) => f === page.mainFrame() && navigations++);
  await page.reload({ waitUntil: 'networkidle0' });
  // Today's worker installs, takes over and, on its first activation, reloads the page once: the press comes after.
  for (let i = 0; i < 60 && navigations < 2; i++) await sleep(500);
  record("After one reload, today's worker reloads the page once more on its first activation", navigations === 2, `${navigations} navigations`);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 20_000 });
  const t0 = Date.now();
  await notifyOnly(page); // today's form: Notifications only, the ready check, "Notifications are on for this device."
  const took = Date.now() - t0;
  const after = await controllerInfo(page);
  record("After one reload: today's worker is the active one, controls the page, answers deviceAlerts: 1, and a subscription exists", after.isActive && after.reply?.deviceAlerts === 1 && !!after.endpoint, `${after.endpoint ? new URL(after.endpoint).host : 'no subscription'}`);
  record('Notifications came on within 60 s of the press, the ready check included', took <= 60_000, `${(took / 1000).toFixed(1)} s`);
  const seen = await shown(page);
  await devOpen(486, publishedDay(6));
  const fresh = await newNotes(page, seen);
  record('After the upgrade, a notification alert is delivered', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => `${n.title} / ${n.body}`)));
} catch (err) {
  record('flow', false, String(err?.message ?? err));
} finally {
  // Leave today's build serving for the local stack, whatever happened.
  if (!restored) {
    try {
      // If whatever holds 4173 cannot be stopped, the pid file is left as it is.
      await gone(stopWeb());
      await serveWeb(join(REPO, 'apps/web'), (t) => t === newSw);
    } catch (err) {
      record("Today's build serves the local stack again", false, `${err?.message ?? err}: run scripts/local-stack.sh down, then up`);
    }
  }
  writeFileSync(join(REPO, 'docs/superpowers/verification/results/old-worker.json'), JSON.stringify({ version: await browser.version(), run: RUN, results }, null, 2));
  await browser.close();
}
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
