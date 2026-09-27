#!/usr/bin/env node
// PengePassportPH canary, UI flow: walks the real booking flow in headless
// Chromium the way a person would, up to the calendar, and checks each screen
// still looks the way the package assumes. It stops before choosing a time
// slot: choosing one holds it for 30 minutes and takes it away from real
// applicants.
//
// Settings: scripts/canary/config.mjs. Runbook: docs/canary.md.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { DEFAULT_BASE_URL } from '../../packages/penge-passport-ph/dist/index.js';
import { BASE_URL, SITE_ID as SITE_ID_OVERRIDE } from './config.mjs';
import { expect, Report, RESULTS_DIR } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(join(here, 'expected.json'), 'utf8'));
const BASE = BASE_URL ?? DEFAULT_BASE_URL;
const SITE_ID = String(SITE_ID_OVERRIDE ?? expected.canarySiteId);
const STEP_TIMEOUT = 30_000;

const report = new Report('ui', 'UI flow');
let browser;
let page;

// Same-origin non-GET requests the walk is allowed to cause, as "METHOD /path".
// Anything else (above all the schedule step's own form, which would reserve
// a slot) fails the canary.
const ALLOWED_POSTS = new Set(
  [
    '/appointment/terms',
    '/appointment/individual/site',
    '/countries',
    '/sites',
    '/site/json',
    '/appointment/timeslot/available',
    '/appointment/timeslot',
  ].map((path) => `POST ${path}`),
);
const posts = [];

/** Like page.waitForResponse, but never an unhandled rejection if the step fails first. */
function responseTo(predicate) {
  const promise = page.waitForResponse(predicate);
  promise.catch(() => undefined);
  return promise;
}

let shot = 0;
let broken = false;
/** Run one step of the flow; after the first failure the rest are skipped. */
async function step(name, fn) {
  if (broken) {
    report.skip(name, 'an earlier step failed');
    return undefined;
  }
  const result = await report.check(name, fn);
  const file = join(RESULTS_DIR, `ui-${String(++shot).padStart(2, '0')}.png`);
  await page?.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  if (!result.ok) {
    broken = true;
    report.checks.at(-1).detail += ` (at ${page?.url()}; screenshot ${file})`;
  }
  return result.value;
}

try {
  await step('Headless Chromium starts', async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(STEP_TIMEOUT);
    const origin = new URL(BASE).origin;
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (req.method() !== 'GET' && url.origin === origin) posts.push(`${req.method()} ${url.pathname}`);
    });
    return browser.version();
  });

  await step('Home page loads with "Schedule an Appointment"', async () => {
    const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    expect(res?.ok(), `HTTP ${res?.status()}`);
    await page.getByRole('link', { name: 'Schedule an Appointment' }).first().waitFor();
    return await page.title();
  });

  await step('Fixer warning dialog gates the flow', async () => {
    await page.locator('#navbar-collapse-nav').getByRole('link', { name: 'Schedule an Appointment' }).click();
    const start = page.getByRole('link', { name: 'Start Appointment' });
    await start.waitFor({ state: 'visible' });
    await start.click();
    await page.waitForURL(/\/appointment$/);
    return new URL(page.url()).pathname;
  });

  await step('Terms page: consent checkbox and "Start Individual Appointment"', async () => {
    const consent = page.getByRole('checkbox', { name: /unequivocal consent/i });
    await consent.check();
    const siteData = responseTo((r) => r.url().endsWith('/sites') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Start Individual Appointment/i }).click();
    await page.waitForURL(/\/appointment\/individual\/site$/);
    const res = await siteData;
    expect(res.ok(), `POST /sites answered HTTP ${res.status()}`);
    const body = await res.json().catch(() => null);
    expect(Array.isArray(body?.Sites), 'POST /sites no longer returns { Sites: [...] }');
    return `${body.Sites.length} sites loaded`;
  });

  await step('Site form: region, country and site dropdowns', async () => {
    const options = async (sel) => page.locator(`${sel} option`).evaluateAll((os) => os.map((o) => [o.value, o.textContent.trim()]));
    const regions = await options('#SiteRegionID');
    expect(regions.some(([v, t]) => v === '1' && /asia pacific/i.test(t)), '#SiteRegionID has no "Asia Pacific" = 1');
    const countries = await options('#SiteCountryID');
    expect(countries.some(([v, t]) => v === '1' && /philippines/i.test(t)), '#SiteCountryID has no "Philippines" = 1');
    await page.locator(`#SiteID option[value="${SITE_ID}"]`).waitFor({ state: 'attached' });
    return `${regions.length - 1} regions, ${countries.length - 1} countries`;
  });

  await step(`Choosing site ${SITE_ID} shows office details and a confirmation`, async () => {
    await page.locator('#SiteID').selectOption(SITE_ID);
    const next = page.getByRole('button', { name: 'Next' });
    const confirm = page.getByRole('checkbox', { name: /I confirm that I have read/i });
    await confirm.waitFor({ state: 'visible' });
    expect(await next.isDisabled(), 'Next is enabled before confirming; the gate changed');
    await confirm.check();
    expect(await next.isEnabled(), 'Next stays disabled after confirming');
    return (await page.locator('#description').textContent())?.trim() ?? '';
  });

  const calendar = await step('Schedule page loads availability from the JSON endpoint', async () => {
    const availability = responseTo((r) => r.url().endsWith('/appointment/timeslot/available'));
    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForURL(/\/appointment\/individual\/schedule$/);
    const res = await availability;
    expect(res.ok(), `HTTP ${res.status()}`);
    const form = new URLSearchParams(res.request().postData() ?? '');
    for (const key of ['fromDate', 'toDate', 'siteId', 'requestedSlots']) {
      expect(form.has(key), `request no longer sends "${key}" (sent: ${[...form.keys()].join(', ')})`);
    }
    expect(res.request().headers()['__requestverificationtoken'], 'request no longer sends the token header');
    const days = await res.json().catch(() => null);
    expect(Array.isArray(days), 'response is not a JSON array');
    expect(
      days.every((d) => typeof d.IsAvailable === 'boolean' && typeof d.AppointmentDate === 'number'),
      'entries no longer look like { IsAvailable, AppointmentDate }',
    );
    const scripts = await page.locator('script[src]').evaluateAll((s) => s.map((e) => new URL(e.src).pathname));
    for (const path of Object.keys(expected.scripts)) {
      if (path.includes('site-timeslot')) expect(scripts.includes(path), `page no longer loads ${path}`);
    }
    const iso = (d) => new Date(d.AppointmentDate).toISOString().slice(0, 10);
    const published = days.map(iso);
    const open = days.filter((d) => d.IsAvailable).map(iso);
    return { detail: `${days.length} published days, ${open.length} open`, open, published };
  });

  await step('Calendar shows the same earliest date as the endpoint', async () => {
    await page.locator('#datepicker').waitFor({ state: 'visible' });
    const shown = (await page.locator('#next-available-date').textContent())?.trim() ?? '';
    const earliest = calendar.open[0];
    if (!earliest) {
      expect(/no available date/i.test(shown), `endpoint has no open dates but the page shows "${shown}"`);
      return 'no open dates, and the page agrees';
    }
    const [y, m, d] = earliest.split('-').map(Number);
    const label = `${String(d).padStart(2, '0')} ${new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`;
    expect(shown === label, `page shows "${shown}", endpoint says ${label}`);
    return label;
  });

  if (!broken && calendar.published.length === 0) {
    report.warn('Clicking a date lists its time slots', 'skipped: the site has no published dates');
  } else {
    await step('Clicking a date lists its time slots (none selected)', async () => {
      // Prefer an open date; on a fully booked site a booked date still lists its slots.
      const cells = '.datepicker-days td.day:not(.old):not(.new):not(.disabled)';
      const target = calendar.open.length ? `${cells}.available` : `${cells}.not-available`;
      const cell = page.locator(target).first();
      if ((await cell.count()) === 0) await page.locator('.datepicker-days th.next').click();
      const slots = responseTo((r) => r.url().endsWith('/appointment/timeslot'));
      await cell.click();
      const res = await slots;
      expect(res.ok(), `POST /appointment/timeslot answered HTTP ${res.status()}`);
      const form = new URLSearchParams(res.request().postData() ?? '');
      for (const key of ['preferredDate', 'siteId', 'requiredSlots']) {
        expect(form.has(key), `request no longer sends "${key}" (sent: ${[...form.keys()].join(', ')})`);
      }
      const date = form.get('preferredDate');
      expect(calendar.published.includes(date), `clicked ${date}, which the endpoint did not publish`);
      const radios = page.locator('#schedule-container input[name="TimeSlotID"]');
      await radios.first().waitFor({ state: 'attached' });
      const total = await radios.count();
      const enabled = await radios.evaluateAll((rs) => rs.filter((r) => !r.disabled).length);
      const checked = await radios.evaluateAll((rs) => rs.filter((r) => r.checked).length);
      expect(checked === 0, `${checked} time slot(s) came back pre-selected; the page may now hold a slot on its own`);
      if (!calendar.open.includes(date)) {
        expect(enabled === 0, `${date} is booked per the endpoint but ${enabled} slot(s) are selectable`);
      }
      expect(await page.locator('#NextButton').isDisabled(), 'Next is enabled without choosing a slot');
      const kind = calendar.open.includes(date) ? 'open' : 'booked';
      return `${date} (${kind}): ${total} slots, ${enabled} open; nothing selected`;
    });
  }

  const unexpected = posts.filter((p) => !ALLOWED_POSTS.has(p));
  if (unexpected.length) {
    report.add('fail', 'Walk made no booking or reservation request', `unexpected: ${unexpected.join(', ')}`);
  } else {
    report.add('pass', 'Walk made no booking or reservation request', `${posts.length} POSTs, all expected`);
  }
} catch (err) {
  report.add('fail', 'Canary crashed', err instanceof Error ? err.message : String(err));
} finally {
  report.finish();
  await browser?.close().catch(() => undefined);
}
