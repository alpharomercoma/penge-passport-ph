// The upgrade from the release before push: its worker installed in Mac Chrome, then today's build
// served on the same port; reload once and turn notifications on. The plan asks that the page
// updates the worker and subscribes within 10 s. The local stack must be up (its API and proxy);
// this swaps only its web server, and leaves today's build serving when it ends.
//   OLD=<worktree of 157bad9, built with BASE_PATH=pengepassportph> node old-worker.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clickText, devOpen, emailSwitch, launch, linkIn, mailMark, mailSince, newNotes, ORIGIN, publishedDay, pushSwitch, REPO, resetRateLimits, RUN, send, shot, shown, sleep, SITE,
  waitText,
} from './lib.mjs';

const OLD = process.env.OLD;
if (!OLD) throw new Error('Set OLD to the built worktree of the release before push');
const PIDS = join(REPO, '.local/pids');
const MARKER = 'vite preview --host 127.0.0.1 --port 4173';
const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
/** Stops the web server on 4173, only if it is the one the pid file names and still what it says (null: already gone). */
function stopWeb() {
  const [pid, ...marker] = readFileSync(join(PIDS, 'web.pid'), 'utf8').trim().split(' ');
  if (!alive(Number(pid))) return null;
  const command = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).trim();
  if (!command.includes(marker.join(' '))) throw new Error(`pid ${pid} is not the web server: ${command}`);
  process.kill(Number(pid));
  return Number(pid);
}
/** Waits until a process has exited, so its port is free. */
async function gone(pid) {
  if (pid === null) return;
  for (let i = 0; i < 40; i++) {
    if (!alive(pid)) return;
    await sleep(250);
  }
  throw new Error(`pid ${pid} did not exit`);
}
/**
 * Serves a build on 4173 from an apps/web directory and, once that process is the one listening and
 * serving the expected worker, records it where local-stack.sh looks.
 */
async function serveWeb(webDir, want) {
  const log = openSync(join(REPO, '.local/web.log'), 'a');
  const child = spawn(join(REPO, 'node_modules/.bin/vite'), ['preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
    cwd: webDir, env: { ...process.env, BASE_PATH: 'pengepassportph' }, detached: true, stdio: ['ignore', log, log],
  });
  child.unref();
  await waitServing(want);
  const listener = execFileSync('lsof', ['-nP', '-iTCP:4173', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n');
  if (!alive(child.pid) || !listener.includes(String(child.pid))) throw new Error(`the new server (pid ${child.pid}) is not the one on 4173 (${listener.join(', ')})`);
  writeFileSync(join(PIDS, 'web.pid'), `${child.pid} ${MARKER}\n`);
}
async function waitServing(want) {
  for (let i = 0; i < 60; i++) {
    const text = await fetch(new URL('sw.js', SITE)).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    if (text && want(text)) return text;
    await sleep(500);
  }
  throw new Error('4173 did not serve the expected build');
}
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
  await page.reload({ waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Email alerts');
  await page.waitForSelector('[role="dialog"]');
  const push = await pushSwitch(page);
  const t0 = Date.now();
  await push.evaluate((e) => e.click());
  await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true', { timeout: 30_000 });
  const took = Date.now() - t0;
  const after = await controllerInfo(page);
  record("After one reload and the switch: today's worker is the active one, controls the page and answers with its version, and a subscription exists", after.isActive && after.reply?.push === true && !!after.reply?.version && !!after.endpoint, `version ${after.reply?.version}, ${after.endpoint ? new URL(after.endpoint).host : 'no subscription'}`);
  record('The switch came on within 10 s of the flip', took <= 10_000, `${(took / 1000).toFixed(1)} s`);
  await shot(page, 'old-worker-after');

  // And it works end to end: notifications only, confirmed, then an alert arrives.
  resetRateLimits();
  await (await emailSwitch(page)).evaluate((e) => e.click());
  const email = `old-worker-${RUN}@example.com`;
  const mark = mailMark();
  await send(page, email);
  await page.goto(linkIn(mailSince(mark, 'confirm', email)[0].text, '/confirm'), { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm alert' && !b.disabled), { timeout: 15_000 });
  await clickText(page, 'button', 'Confirm alert');
  await waitText(page, 'Notifications are on for this device.', 20_000);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  const seen = await shown(page);
  await devOpen(486, publishedDay(6));
  const fresh = await newNotes(page, seen);
  record('After the upgrade, a notifications-only alert is confirmed and delivered', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => `${n.title} / ${n.body}`)));
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
