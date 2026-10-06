// Layout audit: every screen and state at phone-to-desktop widths. Flags horizontal page scroll,
// elements past the viewport's edges, and text clipped by its own box. Screenshots for eye review.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clickText, emailSwitch, launch, linkIn, mailMark, waitMail, ORIGIN, pushSwitch, resetRateLimits, RUN, send, sleep, SITE, waitText, workerReady,
} from './lib.mjs';

// Screenshots for eye review go outside the repository; audit.json is copied into results/.
const OUT = process.env.AUDIT_OUT ?? join(tmpdir(), 'penge-audit');
mkdirSync(OUT, { recursive: true });
const WIDTHS = [320, 360, 375, 390, 412, 768, 1280];
const findings = [];
const STATES = 19; // every audit() call below

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
    const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.textOverflow === 'ellipsis';
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
async function audit(page, state, { full = false, inDialog = false, prep } = {}) {
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: width < 700 ? 780 : 900, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await sleep(400);
    // A width change re-lays out the sheet: scroll it to the part this state is about, each time.
    if (prep) {
      await page.evaluate(prep);
      await sleep(200);
    }
    const found = await page.evaluate(inspect);
    for (const f of found) findings.push({ state, width, ...f });
    const file = `${state}-${width}.png`;
    if (inDialog) await (await page.$('[role="dialog"]')).screenshot({ path: join(OUT, file) }).catch(() => page.screenshot({ path: join(OUT, file) }));
    else await page.screenshot({ path: join(OUT, file), fullPage: full });
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
await page.goto(SITE, { waitUntil: 'networkidle0' });
await clickText(page, 'button', 'Email alerts');
await page.waitForSelector('[role="dialog"]');
await audit(page, 'sheet-iphone-tab', { prep: () => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }) });
await page.setUserAgent({ userAgent: ANDROID });
await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
try {
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
  await audit(page, 'home', { full: true });
  await clickText(page, 'button', 'Abroad');
  await sleep(600);
  await audit(page, 'home-abroad', { full: true });
  await page.goto(`${SITE}?office=486`, { waitUntil: 'networkidle0' });
  await audit(page, 'office', { full: true });
  // The tabs show only on narrow screens (wide ones show both panes side by side).
  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'By date');
  await page.waitForFunction(() => [...document.querySelectorAll('.tabs button')].some((b) => b.textContent.includes('By date') && b.getAttribute('aria-pressed') === 'true'));
  await sleep(600);
  await audit(page, 'by-date', { full: true });

  // The sheet: top, the switches, the end.
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await clickText(page, 'button', 'Email alerts');
  await page.waitForSelector('[role="dialog"]');
  await page.evaluate(() => document.activeElement?.blur?.());
  await audit(page, 'sheet-top');
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true', { timeout: 20_000 });
  await audit(page, 'sheet-switches', { prep: () => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }) });
  await (await emailSwitch(page)).evaluate((e) => e.click());
  await audit(page, 'sheet-push-only', { prep: () => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }) });
  await audit(page, 'sheet-end', { prep: () => { const d = document.querySelector('.sheet'); d.scrollTop = d.scrollHeight; } });

  // Sign up push only, then every row state.
  await (await emailSwitch(page)).evaluate((e) => e.click());
  const email = `audit-${RUN}@example.com`;
  const mark = mailMark();
  await send(page, email);
  await audit(page, 'sheet-sent');
  const mail = (await waitMail(mark, 'confirm', email)).text;
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Waiting for you to confirm by email.', 20_000);
  await audit(page, 'row-waiting');
  await page.goto(linkIn(mail, '/confirm'), { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm alert' && !b.disabled), { timeout: 15_000 });
  await audit(page, 'confirm-preview', { full: true });
  await clickText(page, 'button', 'Confirm alert');
  await waitText(page, 'Notifications are on for this device.', 20_000);
  await audit(page, 'confirm-done', { full: true });
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  await audit(page, 'row-on');
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setPermission', { origin: ORIGIN, permission: { name: 'notifications' }, setting: 'denied' });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);
  await audit(page, 'row-blocked');
  await clickText(page, 'button', 'Email alerts');
  await page.waitForSelector('[role="dialog"]');
  await audit(page, 'sheet-blocked-hint', { prep: () => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }) });

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
