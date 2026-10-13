// Layout audit: every screen and state at phone-to-desktop widths. Flags horizontal page scroll,
// elements past the viewport's edges, and text clipped by its own box. Screenshots for eye review.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clickText, emailSwitch, launch, openSheet, ORIGIN, pickOffice, pushSwitch, resetRateLimits, RUN, send, sleep, SITE, waitText, workerReady,
} from './lib.mjs';

// Screenshots for eye review go outside the repository; audit.json is copied into results/.
const OUT = process.env.AUDIT_OUT ?? join(tmpdir(), 'penge-audit');
mkdirSync(OUT, { recursive: true });
const WIDTHS = [320, 360, 375, 390, 412, 768, 1280];
const findings = [];
const STATES = 33; // every audit() call below: 16 single states, 14 row states, 3 pages

/** Runs in the page: what sticks out or is clipped. */
function inspect() {
  const W = document.documentElement.clientWidth;
  const name = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };
  const scrollsX = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
    return false;
  };
  const hidden = (el, cs, r) => cs.display === 'none' || cs.visibility === 'hidden' || r.width < 2 || r.height < 2 || cs.position === 'fixed' && cs.clip !== 'auto' || cs.clipPath.includes('inset(50%');
  const out = [];
  const pageScroll = document.documentElement.scrollWidth - W;
  if (pageScroll > 0) out.push({ kind: 'page scrolls sideways', by: pageScroll });
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (hidden(el, cs, r)) continue;
    const parent = el.parentElement?.getBoundingClientRect();
    if ((r.right > W + 0.5 || r.left < -0.5) && !scrollsX(el) && !(parent && (parent.right > W + 0.5 || parent.left < -0.5))) {
      out.push({ kind: 'past the edge', el: name(el), left: Math.round(r.left), right: Math.round(r.right), W });
    }
    // A text field scrolls what is typed in it: a long address is not clipped.
    const clipsX = !el.matches('input, textarea') && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.textOverflow === 'ellipsis');
    if (clipsX && el.scrollWidth > el.clientWidth + 1) out.push({ kind: 'clipped sideways', el: name(el), need: el.scrollWidth, has: el.clientWidth });
    const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip' || Number(cs.webkitLineClamp) > 0;
    if (clipsY && el.scrollHeight > el.clientHeight + 1) out.push({ kind: 'clipped vertically', el: name(el), need: el.scrollHeight, has: el.clientHeight });
  }
  // Text nodes that run past their element (long words, unbreakable strings).
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    const host = n.parentElement;
    if (!host || hidden(host, getComputedStyle(host), host.getBoundingClientRect())) continue;
    if (r.width && r.right > W + 0.5 && !scrollsX(host)) out.push({ kind: 'text past the edge', el: name(host), right: Math.round(r.right), W });
  }
  return out;
}

const done = [];
/**
 * `prep` runs in the page before each inspection (with `arg`); `expect` is [selector, ...texts]: the state shown must
 * contain every one of them there (its words and its actions), or the inspection is of the wrong screen and counts as
 * a finding.
 */
async function audit(page, state, { full = false, inDialog = false, prep, arg, expect, holds } = {}) {
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: width < 700 ? 780 : 900, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await sleep(400);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await sleep(150);
      if (prep) {
        await page.evaluate(prep, arg);
        await sleep(100);
      }
      if (expect) {
        const seen = await page.evaluate(([sel, ...texts]) => texts.every((t) => (document.querySelector(sel)?.textContent ?? '').includes(t)), expect);
        if (!seen) findings.push({ state, width, scheme, kind: 'not the expected state', expect });
      }
      // `holds`: what the state must be beyond its words (switch values, disabled controls, which retries show).
      if (holds && !(await page.evaluate(holds))) findings.push({ state, width, scheme, kind: 'not the expected state', holds: holds.toString().slice(0, 200) });
      const found = await page.evaluate(inspect);
      for (const f of found) findings.push({ state, width, scheme, ...f });
      const file = `${state}-${width}-${scheme}.png`;
      if (inDialog) await (await page.$('[role="dialog"]')).screenshot({ path: join(OUT, file) }).catch(() => page.screenshot({ path: join(OUT, file) }));
      else await page.screenshot({ path: join(OUT, file), fullPage: full });
    }
  }
  done.push(state);
  console.log(state, findings.filter((f) => f.state === state).length, 'findings');
}

resetRateLimits();
const browser = await launch('chrome');
const page = await browser.newPage();
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
await page.setUserAgent({ userAgent: IPHONE });
await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
try {
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await openSheet(page);
  await audit(page, 'sheet-iphone-tab', { prep: () => document.querySelector('.channels')?.scrollIntoView({ block: 'center' }), expect: ['[role="dialog"]', 'add this site to your Home Screen'] });
  await page.setUserAgent({ userAgent: ANDROID });
  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await workerReady(page);
  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  // Self-test: the check must catch a planted overflow and a clipped label.
  const planted = await page.evaluate((src) => {
    const a = document.createElement('div'); a.style.width = '600px'; a.textContent = 'wide'; document.body.append(a);
    const b = document.createElement('button'); b.style.cssText = 'width:40px;overflow:hidden;white-space:nowrap'; b.textContent = 'A long label here'; document.body.append(b);
    const found = (0, eval)(`(${src})`)();
    a.remove(); b.remove();
    return found.map((f) => f.kind);
  }, inspect.toString());
  console.log('self-test', planted);
  if (!planted.includes('page scrolls sideways') || !planted.includes('clipped sideways')) throw new Error('the check misses planted problems');
  await audit(page, 'home', {
    full: true,
    expect: ['main', 'DFA offices in the Philippines have open dates', 'PHT'],
    // The theme switch at the header's right, beside the name; the age and the time in Manila, both in the open colour.
    holds: () => {
      const t = document.querySelector('.site-header .theme-toggle')?.getBoundingClientRect();
      const b = document.querySelector('.site-header .brand')?.getBoundingClientRect();
      const h = document.querySelector('.site-header')?.getBoundingClientRect();
      const open = getComputedStyle(document.documentElement).getPropertyValue('--open').trim();
      const probe = Object.assign(document.createElement('span'), { style: `color: ${open}` });
      document.body.append(probe);
      const openRgb = getComputedStyle(probe).color;
      probe.remove();
      const fresh = [...document.querySelectorAll('.summary .fresh')];
      return !!t && !!b && !!h && t.width >= 44 && t.height >= 44 && t.left >= b.right && h.right - t.right < 24 && Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2) < 4 && fresh.length === 2 && fresh.every((e) => getComputedStyle(e).color === openRgb);
    },
  });
  // The other theme, chosen with the switch, whatever the system prefers: the page and its bar follow the choice.
  await audit(page, 'home-theme-chosen', {
    prep: () => {
      const want = matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
      if (document.documentElement.dataset.theme !== want) document.querySelector('.theme-toggle').click();
    },
    expect: ['main', 'DFA offices in the Philippines have open dates'],
    holds: () => {
      const want = matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
      const bg = getComputedStyle(document.body).backgroundColor;
      const bar = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content);
      return document.documentElement.dataset.theme === want && bg === (want === 'dark' ? 'rgb(16, 20, 18)' : 'rgb(255, 255, 255)') && bar.every((c) => c === (want === 'dark' ? '#101412' : '#ffffff'));
    },
  });
  await page.evaluate(() => localStorage.removeItem('pengepassportph-theme'));
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Abroad');
  await sleep(600);
  await audit(page, 'home-abroad', { full: true });
  await page.goto(`${SITE}?office=486`, { waitUntil: 'networkidle0' });
  await audit(page, 'office', { full: true, expect: ['.office-status', 'Checked', 'PHT'] });
  // The tabs show only on narrow screens (wide ones show both panes side by side).
  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'By date');
  await page.waitForFunction(() => [...document.querySelectorAll('.tabs button')].some((b) => b.textContent.includes('By date') && b.getAttribute('aria-pressed') === 'true'));
  await sleep(600);
  await audit(page, 'by-date', { full: true });

  // The alerts form.
  resetRateLimits();
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await openSheet(page);
  await pickOffice(page);
  await page.evaluate(() => document.activeElement?.blur?.());
  const DIALOG = '[role="dialog"]';
  await audit(page, 'form-both-off', {
    expect: [DIALOG, 'How should we tell you?', 'Email', 'Browser notifications'],
    holds: () => [...document.querySelectorAll('[role="dialog"] [role="switch"]')].every((e) => e.getAttribute('aria-checked') === 'false') && document.querySelector('[role="dialog"] button[type="submit"]')?.disabled === true,
  });
  await (await emailSwitch(page)).evaluate((e) => e.click());
  await audit(page, 'form-email-only', {
    prep: () => document.querySelector('input[type="email"]')?.scrollIntoView({ block: 'center' }),
    expect: [DIALOG, 'Send confirmation email'],
    // The fields draw no box of their own, and the button has room above it.
    holds: () => {
      const f = document.querySelector('[role="dialog"] fieldset.form-body');
      const fields = [...f.querySelectorAll(':scope > .field')].at(-1).getBoundingClientRect();
      const button = document.querySelector('[role="dialog"] button[type="submit"]').getBoundingClientRect();
      const cs = getComputedStyle(f);
      return cs.borderTopWidth === '0px' && cs.borderBottomWidth === '0px' && cs.paddingLeft === '0px' && button.top - fields.bottom >= 20;
    },
  });
  await (await emailSwitch(page)).evaluate((e) => e.click());
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 20_000 }, await pushSwitch(page));
  await audit(page, 'form-notifications-on', { expect: [DIALOG, 'Turn on notifications'] });
  // Notifications only, sending (the setup request held), then refused (answered "full", as the server answers when
  // notifications are at their limit; a 503 would only be retried).
  const held = [];
  const holdSetup = (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/device-alerts')) return void held.push(req);
    return void req.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', holdSetup);
  await clickText(page, 'button[type="submit"]', 'Turn on notifications');
  await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.getAttribute('aria-busy') === 'true', { timeout: 20_000 });
  for (let i = 0; i < 80 && held.length === 0; i++) await sleep(250);
  await audit(page, 'form-busy', { prep: () => { const d = document.querySelector('.sheet'); d.scrollTop = d.scrollHeight; }, expect: [DIALOG, 'Working'], holds: () => document.querySelector('[role="dialog"] fieldset.form-body')?.disabled === true && document.querySelector('[role="dialog"] button[type="submit"]')?.getAttribute('aria-busy') === 'true' });
  page.off('request', holdSetup);
  for (const req of held.splice(0)) await req.respond({ status: 200, contentType: 'application/json', body: '{"outcome":"full","operation":null}' });
  await page.setRequestInterception(false);
  await page.waitForSelector('[role="dialog"] .sheet-result-failed', { timeout: 60_000 });
  await audit(page, 'form-results-notify-failed', { prep: () => { const d = document.querySelector('.sheet'); d.scrollTop = d.scrollHeight; }, expect: [DIALOG, 'Notifications are full right now.', 'Try notifications again'] });
  const failedWith = await page.$eval('[role="dialog"] .sheet-result-failed', (e) => e.textContent ?? '');
  console.log('notification failure shown:', failedWith);
  await (await emailSwitch(page)).evaluate((e) => e.click());
  await audit(page, 'form-both-on', { prep: () => document.querySelector('input[type="email"]')?.scrollIntoView({ block: 'center' }), expect: [DIALOG, 'Turn on notifications and send confirmation email'] });
  // Both results, one retry: email refused by the mail server, notifications on.
  await fetch('http://127.0.0.1:8787/dev/mail-fail', { method: 'POST' });
  await send(page, `audit-${RUN}@example.com`);
  await waitText(page, 'Notifications are on for this device.', 60_000);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Try email again'), { timeout: 30_000 });
  await audit(page, 'form-results-one-retry', { prep: () => { const d = document.querySelector('.sheet'); d.scrollTop = d.scrollHeight; }, expect: [DIALOG, 'Notifications are on for this device.', 'Try email again'], holds: () => ![...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Try notifications again') });
  await fetch('http://127.0.0.1:8787/dev/mail-ok', { method: 'POST' });
  await clickText(page, '[role="dialog"] button', 'Try email again');
  await waitText(page, 'Check your inbox for a link to start email alerts.');
  await audit(page, 'form-results-both-ok', { prep: () => { const d = document.querySelector('.sheet'); d.scrollTop = d.scrollHeight; }, expect: [DIALOG, 'Notifications are on for this device.', 'Check your inbox for a link to start email alerts.'] });
  await page.keyboard.press('Escape');
  // Change mode.
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await clickText(page, '.device-row button', 'Change');
  await page.waitForSelector('[role="dialog"]');
  await audit(page, 'form-change', { expect: ['[role="dialog"]', 'Save'] });
  await page.keyboard.press('Escape');
  // The row in every state, written through the VITE_LOCAL_DEBUG hook (the local stack's build sets it).
  const longest = 'Ciudad Autónoma de Buenos Aires (Philippine Embassy in the Argentine Republic, Argentina)';
  const alert = (o = {}) => ({ alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, fingerprint: 'f', endsAt: Date.now() + 179 * 86_400_000, choices: { siteIds: [486], applicants: 5, pace: 'hourly' }, ...o });
  const rows = {
    'row-on-longest': { kind: 'on', alert: alert({ officeNames: [longest] }), renewFailing: false },
    'row-on-renewal-note': { kind: 'on', alert: alert(), renewFailing: true },
    'row-setting-up': { kind: 'setting-up', slow: false },
    'row-setting-up-slow': { kind: 'setting-up', slow: true },
    'row-blocked': { kind: 'blocked' },
    'row-ended': { kind: 'ended', endedAt: Date.now() - 86_400_000 },
    'row-again': { kind: 'again' },
    'row-off-unconfirmed': { kind: 'off', unsubscribed: false, deleted: true },
    'row-off-pending': { kind: 'off', unsubscribed: true, deleted: false },
    'row-off-both-unfinished': { kind: 'off', unsubscribed: false, deleted: false },
    'row-cant-check': { kind: 'cant-check' },
    'row-cant-check-storage': { kind: 'cant-check', storage: true },
    'row-legacy': { kind: 'legacy' },
    'row-updating': { kind: 'updating' },
  };
  // What each state's row must say (the hook's state, written again before every inspection).
  const says = {
    'row-on-longest': [longest, 'Change', 'Send a test', 'Turn off'],
    'row-on-renewal-note': ["We couldn't renew it just now", 'Change', 'Send a test', 'Turn off'],
    'row-setting-up': ['Setting up notifications on this device', 'Turn off'],
    'row-setting-up-slow': ['Still setting up.', 'Turn off'],
    'row-blocked': ['Notifications are blocked on this device', 'Set up again'],
    'row-ended': ['Notifications on this device ended on', 'Set up again'],
    'row-again': ['Notifications need setting up again', 'Set up again'],
    'row-off-unconfirmed': ["This browser didn't stop its subscription.", 'Try again'],
    'row-off-pending': ["Notifications are off on this device. Deleting them from our server when you're back online.", 'Try again'],
    'row-off-both-unfinished': ["This browser didn't stop its subscription. Block notifications for this site in its settings to be sure. Deleting them", 'Try again'],
    'row-cant-check': ["Can't check notifications on this device right now.", 'Turn off'],
    'row-cant-check-storage': ['block them for this site in its settings', 'Turn off'],
    'row-legacy': ['Close other tabs of this site'],
    'row-updating': ["Updating this device's notifications", 'Turn off'],
  };
  for (const [name, view] of Object.entries(rows)) {
    await audit(page, name, { prep: (v) => window.__pengeRowView(v), arg: view, expect: ['.device-row', ...says[name]] });
  }
  // The form's hint when notifications are blocked for the site.
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setPermission', { origin: ORIGIN, permission: { name: 'notifications' }, setting: 'denied' });
  await page.reload({ waitUntil: 'networkidle0' });
  await openSheet(page);
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await waitText(page, 'blocked for this site');
  await audit(page, 'form-blocked-hint', { expect: ['[role="dialog"]', 'Notifications are blocked for this site.'] });

  for (const path of ['privacy', 'delete-data', 'unsubscribe']) {
    await page.goto(new URL(path, SITE).href, { waitUntil: 'networkidle0' });
    await audit(page, path, { full: true });
  }
} catch (err) {
  console.log('STOPPED', err?.stack ?? err);
  await page.screenshot({ path: join(OUT, 'stopped.png') });
} finally {
  const version = await browser.version().catch(() => null);
  writeFileSync(join(OUT, 'audit.json'), JSON.stringify({ version, run: RUN, widths: WIDTHS, finished: done.length === STATES, states: done, findings }, null, 2));
  await browser.close();
}
process.exitCode = done.length === STATES && findings.length === 0 ? 0 : 1;
