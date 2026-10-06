// Verification harness for Task 17 (scratch only, never committed): drives the installed
// Chrome and Firefox with throwaway profiles against the local stack.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

export async function launch(kind, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), `penge-${kind}-`));
  if (kind === 'chrome') {
    return puppeteer.launch({
      browser: 'chrome',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: false,
      userDataDir: dir,
      defaultViewport: { width: 1100, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,1000', ...(opts.args ?? [])],
    });
  }
  return puppeteer.launch({
    browser: 'firefox',
    executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox',
    headless: false,
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
  return readdirSync(MAIL).sort().map((f) => ({ file: f, text: readFileSync(join(MAIL, f), 'utf8') }));
}
export function lastMail(kind, to) {
  const m = mails().filter((x) => x.file.endsWith(`-${kind}.txt`) && (!to || x.text.startsWith(`To: ${to}`)));
  return m.at(-1);
}
export function linkIn(text, path) {
  const m = new RegExp(`https?://[^\\s]*${path}#token=[A-Za-z0-9_.-]+`).exec(text);
  return m ? m[0].replace('http://localhost:4173', ORIGIN) : null;
}

export function valkey(...args) {
  return execFileSync('docker', ['exec', 'penge-local-valkey', 'valkey-cli', ...args], { encoding: 'utf8' }).trim();
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
  await clickText(page, 'button', 'Email alerts');
  await page.waitForSelector('[role="dialog"]');
}

export async function pushSwitch(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].some((e) => /notifications/i.test(e.textContent ?? '')), { timeout: 15_000 });
  return (await page.$$('[role="switch"]')).at(-1);
}
export async function emailSwitch(page) {
  return (await page.$$('[role="switch"]'))[0];
}
export const checked = (h) => h.evaluate((e) => e.getAttribute('aria-checked'));

/** Fills the email and sends the form (offices: the one already chosen, or Antipolo). */
export async function send(page, email) {
  const chips = await page.$$('.chips .chip');
  if (chips.length === 0) {
    await page.type('input[type="search"]', 'Antipolo');
    await page.click('.pick input[type="checkbox"]');
  }
  await page.type('input[type="email"]', email);
  // "As soon as possible": several alerts within the hour in these checks would otherwise wait for the pace.
  const pace = await page.$('select[id$="-pace"]');
  if (pace) await pace.select('asap');
  await clickText(page, 'button[type="submit"]', 'Send confirmation email');
  await waitText(page, 'Check your inbox');
}

/** Signs up in this page with the given channels, confirms in the same page, and returns to home. */
export async function signUpAndConfirm(page, email, { emailOn = true, pushOn = true } = {}) {
  await openSheet(page);
  if (pushOn) {
    const push = await pushSwitch(page);
    await push.click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true', { timeout: 20_000 });
  }
  if (!emailOn) await (await emailSwitch(page)).click();
  await send(page, email);
  const link = linkIn(lastMail('confirm', email).text, '/confirm');
  await page.goto(link, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm alert' && !b.disabled), { timeout: 15_000 });
  await clickText(page, 'button', 'Confirm alert');
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
export const mailMark = () => mails().length;
export function mailSince(mark, kind, to) {
  return mails().slice(mark).filter((m) => m.file.endsWith(`-${kind}.txt`) && m.text.startsWith(`To: ${to}`));
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
