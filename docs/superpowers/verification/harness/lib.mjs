// Verification harness for Task 17 (scratch only, never committed): drives the installed
// Chrome and Firefox with throwaway profiles against the local stack.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

// The repository: REPO when the harness runs from a copy elsewhere, else four levels up from here.
export const REPO = process.env.REPO ?? fileURLToPath(new URL('../../../../', import.meta.url));
export const SITE = 'http://localhost:4173/pengepassportph/';
export const ORIGIN = 'http://localhost:4173';
export const IMG = join(REPO, 'docs/superpowers/verification/img');
const MAIL = join(REPO, '.local/mail');

/** Headless unless HEADED=1: the runs never open windows over the person's work. */
const HEADLESS = process.env.HEADED !== '1';
export async function launch(kind, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), `penge-${kind}-`));
  if (kind === 'chrome') {
    return puppeteer.launch({
      browser: 'chrome',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: HEADLESS,
      userDataDir: dir,
      defaultViewport: { width: 1100, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,1000', ...(opts.args ?? [])],
    });
  }
  return puppeteer.launch({
    browser: 'firefox',
    executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox',
    headless: HEADLESS,
    userDataDir: dir,
    defaultViewport: { width: 1100, height: 900 },
    // Remote control turns Firefox's push connection off; a person's Firefox has it on.
    extraPrefsFirefox: { 'dom.push.enabled': true, 'dom.push.connection.enabled': true, 'dom.push.serverURL': 'wss://push.services.mozilla.com/', 'dom.serviceWorkers.enabled': true, ...(opts.prefs ?? {}) },
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function shot(page, name) {
  await page.screenshot({ path: join(IMG, `${name}.png`) });
  console.log('  shot', name);
}

/** Every captured email, oldest first. */
export function mails() {
  return readdirSync(MAIL).sort().map((f) => ({ file: f, at: statSync(join(MAIL, f)).mtimeMs, text: readFileSync(join(MAIL, f), 'utf8') }));
}
export function lastMail(kind, to) {
  const m = mails().filter((x) => x.file.endsWith(`-${kind}.txt`) && (!to || x.text.startsWith(`To: ${to}`)));
  return m.at(-1);
}
export function linkIn(text, path) {
  const m = new RegExp(`https?://[^\\s]*${path}#token=[A-Za-z0-9_.-]+`).exec(text);
  return m ? m[0].replace('http://localhost:4173', ORIGIN) : null;
}

/**
 * Docker on this machine only, found and pinned as scripts/local-stack.sh does (DOCKER_CONTEXT wins over DOCKER_HOST,
 * which wins over the current context): a remote daemon is never asked to change anything.
 */
let dockerHost = null;
function localDocker() {
  if (dockerHost) return dockerHost;
  const inspect = (...ctx) => {
    try {
      return execFileSync('docker', ['context', 'inspect', ...ctx, '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  };
  const host = process.env.DOCKER_CONTEXT ? inspect(process.env.DOCKER_CONTEXT) : (process.env.DOCKER_HOST ?? inspect());
  if (!host.startsWith('unix://')) throw new Error(`Docker points at ${host}, not this machine; refusing`);
  return (dockerHost = host);
}
let marked = false;
/** valkey-cli in the local stack's container, once it is known to carry the disposable mark local-stack.sh sets. */
export function valkey(...args) {
  const { DOCKER_CONTEXT: _, ...env } = process.env;
  const cli = (a) => execFileSync('docker', ['exec', 'penge-local-valkey', 'valkey-cli', ...a], { encoding: 'utf8', env: { ...env, DOCKER_HOST: localDocker() } }).trim();
  if (!marked) {
    if (cli(['GET', 'pp:test:disposable']) !== '1') throw new Error('the local Valkey is not marked disposable; refusing');
    marked = true;
  }
  return cli(args);
}
export const scan = (pattern) => valkey('--scan', '--pattern', pattern).split('\n').filter(Boolean);

/** A published day of the fake DFA (today + 3, in UTC). */
export const publishedDay = (n = 3) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export async function devOpen(office, date) {
  const res = await fetch('http://127.0.0.1:8787/dev/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ office, date }) });
  return res.json();
}

/** The notifications this page's service worker is showing. */
export function shown(page) {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }));
  });
}

export async function clickText(page, selector, text) {
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = await h.evaluate((e) => e.textContent ?? '');
    if (t.includes(text)) {
      await h.click();
      return;
    }
  }
  throw new Error(`no ${selector} with "${text}"`);
}

export async function waitText(page, text, timeout = 15_000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

export async function openSheet(page) {
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Alerts');
  await page.waitForSelector('[role="dialog"]');
}

/** The switch in the open sheet whose name matches, once it shows. */
async function namedSwitch(page, pattern) {
  await page.waitForFunction((src) => [...document.querySelectorAll('[role="switch"]')].some((e) => new RegExp(src).test((e.textContent ?? '').trim())), { timeout: 15_000 }, pattern.source);
  for (const h of await page.$$('[role="switch"]')) {
    if (pattern.test((await h.evaluate((e) => e.textContent ?? '')).trim())) return h;
  }
  throw new Error(`no switch named ${pattern}`);
}
export const pushSwitch = (page) => namedSwitch(page, /^(Browser notifications|Notifications on this device)$/);
export const emailSwitch = (page) => namedSwitch(page, /^Email$/);
export const checked = (h) => h.evaluate((e) => e.getAttribute('aria-checked'));

/** In the open sheet: picks Antipolo if no office is chosen. */
export async function pickOffice(page) {
  const chips = await page.$$('.chips .chip');
  if (chips.length > 0) return;
  await page.type('input[type="search"]', 'Antipolo');
  await page.click('.pick input[type="checkbox"]');
}

/** "As soon as possible": several alerts within the hour in these checks would otherwise wait for the pace. */
async function paceAsap(page) {
  const pace = await page.$('select[id$="-pace"]');
  if (pace) await pace.select('asap');
}

const SUBMITS = ['Turn on notifications and send confirmation email', 'Turn on notifications', 'Send confirmation email'];
async function submit(page) {
  for (const h of await page.$$('button[type="submit"]')) {
    const t = (await h.evaluate((e) => e.textContent ?? '')).trim();
    if (SUBMITS.includes(t)) return h.click();
  }
  throw new Error('no submit button');
}

/** Fills the email (switching Email on first) and sends the form; the caller waits for what it expects. */
export async function send(page, email) {
  await pickOffice(page);
  const mail = await emailSwitch(page);
  if ((await checked(mail)) !== 'true') {
    await mail.click();
    await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 5_000 }, mail);
  }
  await page.type('input[type="email"]', email);
  await paceAsap(page);
  await submit(page);
}

/** Opens the sheet, turns on a notification alert for this device alone, and closes the sheet; `beforePress` runs just before the press. */
export async function notifyOnly(page, { beforePress } = {}) {
  await openSheet(page);
  await pickOffice(page);
  await paceAsap(page);
  const mail = await emailSwitch(page);
  if ((await checked(mail)) === 'true') await mail.click();
  const push = await pushSwitch(page);
  if ((await checked(push)) !== 'true') await push.click();
  await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 20_000 }, push);
  // The form as it is about to be sent (a caller checks what it shows or asks for).
  if (beforePress) await beforePress();
  await clickText(page, 'button[type="submit"]', 'Turn on notifications');
  await waitText(page, 'Notifications are on for this device.', 60_000);
  // Closed, so the row's buttons are not behind the sheet.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5_000 });
}

/** The device row's text, or null when there is none. */
export function rowText(page) {
  return page.evaluate(() => document.querySelector('.device-row')?.textContent ?? null);
}

/** Signs up for email alerts in this page, confirms in the same page, and returns to home. */
export async function signUpAndConfirm(page, email) {
  await openSheet(page);
  await send(page, email);
  await waitText(page, 'Check your inbox');
  const link = linkIn(lastMail('confirm', email).text, '/confirm');
  await page.goto(link, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm email alert' && !b.disabled), { timeout: 15_000 });
  await clickText(page, 'button', 'Confirm email alert');
  await page.waitForFunction(() => /You are subscribed|Your alert is updated/.test(document.body.innerText), { timeout: 15_000 });
  await sleep(1000);
  return link;
}

/** This browser's push credential, read the way the page stores it. */
export function storedCredential(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('pengepassportph-push', 1);
        req.onsuccess = () => {
          const get = req.result.transaction('state').objectStore('state').get('device');
          get.onsuccess = () => resolve(get.result?.credential ?? null);
        };
        req.onerror = () => resolve(null);
      }),
  );
}

export function resetRateLimits() {
  for (const key of scan('pp:rate:*')) valkey('DEL', key);
}

export async function waitNotes(page, count, ms = 20_000) {
  let notes = [];
  for (let i = 0; i < ms / 500; i++) {
    notes = await shown(page);
    if (notes.length >= count) break;
    await sleep(500);
  }
  return notes;
}

// ---- Stricter helpers (after the Codex read of the first checklist) ----

export const RUN = Date.now().toString(36);
/** How many emails were captured before this point: later reads look only after it. */
/**
 * The mail captured so far, each file with the time it was written: the local stack numbers its files
 * afresh after a restart and writes over old files of the same name.
 */
export const mailMark = () => new Map(mails().map((m) => [m.file, m.at]));
/** The first email of a kind to an address since the mark, waiting for it: sending follows the page's answer. */
export async function waitMail(mark, kind, to, ms = 15_000) {
  for (let waited = 0; waited <= ms; waited += 250) {
    const [mail] = mailSince(mark, kind, to);
    if (mail) return mail;
    await sleep(250);
  }
  throw new Error(`no ${kind} email to ${to} within ${ms / 1000} s`);
}
export function mailSince(mark, kind, to) {
  return mails().filter((m) => mark.get(m.file) !== m.at && m.file.endsWith(`-${kind}.txt`) && m.text.startsWith(`To: ${to}`));
}

/** Waits for the page's service worker to be active. */
export const workerReady = (page) => page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

/** The subscriber ids that have push metadata now. */
export const pushIds = () => new Set(scan('pp:push:meta:*').map((k) => k.slice('pp:push:meta:'.length)));
/** The devices of one subscriber: field → "state|revision|…". */
export function devicesOf(id) {
  const flat = valkey('HGETALL', `pp:push:meta:${id}`).split('\n').filter(Boolean);
  const out = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}
/** Every key that still names this subscriber: its hashes, and credential or endpoint entries pointing at it. */
export function keysNaming(id) {
  const direct = [`pp:push:meta:${id}`, `pp:push:${id}`, `pp:push:address:${id}`, `pp:sub:${id}`].filter((k) => valkey('EXISTS', k) === '1');
  const pointing = [...scan('pp:push:cred:*'), ...scan('pp:push:endpoint:*')].filter((k) => valkey('GET', k).startsWith(`${id}/`));
  const reserved = scan('pp:reserved:*').filter((k) => valkey('GET', k) === id);
  return [...direct, ...pointing, ...reserved];
}

/** Notifications shown now whose tags were not in `before`. */
export async function newNotes(page, before, ms = 20_000) {
  const known = new Set(before.map((n) => n.tag));
  let fresh = [];
  for (let i = 0; i < ms / 500; i++) {
    fresh = (await shown(page)).filter((n) => !known.has(n.tag));
    if (fresh.length > 0) break;
    await sleep(500);
  }
  return fresh;
}

export const PIDS = join(REPO, '.local/pids');
export const MARKER = 'vite preview --host 127.0.0.1 --port 4173';

export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
/** Stops the web server on 4173, only if it is the one the pid file names and still what it says (null: already gone). */
export function stopWeb() {
  const [pid, ...marker] = readFileSync(join(PIDS, 'web.pid'), 'utf8').trim().split(' ');
  if (!alive(Number(pid))) return null;
  const command = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).trim();
  if (!command.includes(marker.join(' '))) throw new Error(`pid ${pid} is not the web server: ${command}`);
  process.kill(Number(pid));
  return Number(pid);
}
/** Waits until a process has exited, so its port is free. */
export async function gone(pid) {
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
export async function serveWeb(webDir, want) {
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
export async function waitServing(want) {
  for (let i = 0; i < 60; i++) {
    const text = await fetch(new URL('sw.js', SITE)).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    if (text && want(text)) return text;
    await sleep(500);
  }
  throw new Error('4173 did not serve the expected build');
}
