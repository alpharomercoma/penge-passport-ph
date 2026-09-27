#!/usr/bin/env node
// PengePassportPH canary, API contract: scrapes one real record through the
// package and checks every assumption it makes about passport.gov.ph.
//
//   node scripts/canary/api.mjs            run the checks
//   node scripts/canary/api.mjs --update   re-pin the site's scripts after reviewing a diff
//
// Settings: scripts/canary/config.mjs. Runbook: docs/canary.md.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE_URL, ENDPOINTS, PengePassportPH, userAgent } from '../../packages/penge-passport-ph/dist/index.js';
import { parseBootstrap } from '../../packages/penge-passport-ph/dist/parse.js';
import { CookieJar } from '../../packages/penge-passport-ph/dist/session.js';
import { BASE_URL, CONTACT, ENV_PREFIX, SITE_ID as SITE_ID_OVERRIDE } from './config.mjs';
import { expect, Report, RESULTS_DIR, sleep } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(join(here, 'expected.json'), 'utf8'));
const BASE = BASE_URL ?? DEFAULT_BASE_URL;
const SITE_ID = Number(SITE_ID_OVERRIDE ?? expected.canarySiteId);
const UPDATE = process.argv.includes('--update');
const USER_AGENT = userAgent(CONTACT);

// Raw requests made by this script (outside the client) keep the same spacing.
const jar = new CookieJar();
let lastRawAt = 0;
async function politeFetch(path, init = {}) {
  const wait = lastRawAt + 3500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRawAt = Date.now();
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  const cookie = jar.header();
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  jar.store(res.headers);
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
}

const report = new Report('api', 'API contract');
const attachments = [];

// 1. Landing page: token, dates, terms form, endpoint map.
const landing = await report.check(`GET ${expected.bootstrapPath} answers 200 HTML`, async () => {
  const page = await politeFetch(expected.bootstrapPath);
  expect(page.status === 200, `HTTP ${page.status}`);
  expect(page.type.includes('text/html'), `content-type is "${page.type}"`);
  return { detail: `${page.text.length} bytes`, html: page.text };
});
const html = landing.value?.html;

if (html) {
  await report.check('Anti-forgery token, server date and booking horizon present', () => {
    const boot = parseBootstrap(html);
    expect(boot, 'no <input name="__RequestVerificationToken"> on the page');
    expect(boot.serverToday, "no `currentDate = 'YYYY-MM-DD'` in the page script");
    expect(boot.maxDate, "no `MAX_DATE = 'YYYY-MM-DD'` in the page script");
    return `today ${boot.serverToday}, horizon ${boot.maxDate}`;
  });

  await report.check('Terms step unchanged (form + individual/group buttons)', () => {
    expect(
      new RegExp(`<form[^>]*action="${escapeRe(expected.termsFormAction)}"`, 'i').test(html),
      `no <form action="${expected.termsFormAction}">`,
    );
    for (const label of expected.termsButtons) {
      expect(html.includes(label), `button "${label}" is gone`);
    }
    return `${expected.termsFormAction}, ${expected.termsButtons.length} buttons`;
  });

  await report.check('Endpoint map declared by the site is unchanged', () => {
    const live = Object.fromEntries(
      [...html.matchAll(/var\s+(\w+)\s*=\s*'(\/[^']*)'/g)].map((m) => [m[1], m[2]]),
    );
    const problems = [];
    for (const [name, url] of Object.entries(expected.endpointVars)) {
      if (!(name in live)) problems.push(`${name} removed (was ${url})`);
      else if (live[name] !== url) problems.push(`${name}: ${url} -> ${live[name]}`);
    }
    for (const [name, url] of Object.entries(live)) {
      if (!(name in expected.endpointVars)) problems.push(`new ${name} = ${url}`);
    }
    expect(problems.length === 0, problems.join('; '));
    const ours = Object.values(ENDPOINTS).filter((p) => p !== expected.bootstrapPath);
    for (const p of ours) {
      expect(Object.values(live).includes(p), `package endpoint ${p} is no longer declared`);
    }
    return `${Object.keys(live).length} endpoints match`;
  });
} else {
  report.skip('Token, terms and endpoint map', 'landing page unavailable');
}

// 2. The site's own scripts: same request shapes, same bytes as pinned.
for (const [path, spec] of Object.entries(expected.scripts)) {
  const pinnedPath = join(here, spec.pinned);
  const fetched = await report.check(`GET ${path} answers 200`, async () => {
    const res = await politeFetch(path);
    expect(res.status === 200, `HTTP ${res.status}`);
    return { detail: `${res.text.length} bytes`, text: res.text };
  });
  const text = fetched.value?.text;
  if (text === undefined) {
    report.skip(`${path} request shape and fingerprint`, 'script unavailable');
    continue;
  }

  await report.check(`${path} still builds the requests the package sends`, () => {
    const missing = spec.mustContain.filter((s) => !text.includes(s));
    expect(missing.length === 0, `no longer contains: ${missing.map((s) => `"${s}"`).join(', ')}`);
    return `${spec.mustContain.length} markers found`;
  });

  if (UPDATE) {
    writeFileSync(pinnedPath, text);
    report.warn(`${path} fingerprint`, `re-pinned to ${sha256(text).slice(0, 16)}`);
    continue;
  }
  await report.check(`${path} unchanged since pinned`, () => {
    let pinned;
    try {
      pinned = readFileSync(pinnedPath, 'utf8');
    } catch {
      throw new Error(`no pinned copy at scripts/canary/${spec.pinned}; run with --update once`);
    }
    if (sha256(pinned) === sha256(text)) return `sha256 ${sha256(text).slice(0, 16)}`;
    const livePath = join(RESULTS_DIR, `live-${path.split('/').pop()}`);
    writeFileSync(livePath, text);
    attachments.push({ title: `Diff of ${path} (pinned → live)`, body: diff(pinnedPath, livePath) });
    throw new Error(
      `content changed (sha256 ${sha256(pinned).slice(0, 16)} → ${sha256(text).slice(0, 16)}); ` +
        'review the diff, update src/ if needed, then run `npm run canary:api -- --update`',
    );
  });
}

// 3. Scrape one record end to end through the package.
await sleep(3500);
const client = new PengePassportPH({ baseUrl: BASE, contact: CONTACT });

await report.check('Countries endpoint lists the Philippines (region 1)', async () => {
  const countries = await client.countries(1);
  expect(countries.some((c) => c.id === 1 && /philippines/i.test(c.name)), 'Philippines (id 1) missing');
  return `${countries.length} countries`;
});

const siteCheck = await report.check(`Sites endpoint lists canary site ${SITE_ID}`, async () => {
  const sites = await client.sites();
  expect(sites.length > 0, 'empty site list');
  const bad = sites.filter((s) => !s.name || !Number.isInteger(s.id));
  expect(bad.length === 0, `${bad.length} sites without id/name`);
  const site = sites.find((s) => s.id === SITE_ID);
  expect(site, `site ${SITE_ID} no longer listed; set ${ENV_PREFIX}SITE_ID to a live site`);
  return { detail: `${site.name}; ${sites.length} sites`, site };
});

const availability = await report.check(`Availability for site ${SITE_ID} parses`, async () => {
  const a = await client.availability({ siteId: SITE_ID });
  expect(a.days.every((d) => d.date >= a.from && d.date <= a.to), 'days outside the requested range');
  return {
    detail: `${a.days.length} published days, ${a.availableDates.length} open, earliest ${a.earliest ?? 'none'}`,
    a,
  };
});

if (availability.ok && availability.value.a.days.length === 0) {
  // A valid, empty answer: the office published nothing (closed, or between
  // release windows). Worth a look, but not a change in the site.
  report.warn('Time slots', `site ${SITE_ID} published no dates; nothing to compare`);
} else if (availability.ok) {
  const a = availability.value.a;
  const date = a.earliest ?? a.days[0].date;
  const listedOpen = a.earliest !== null;
  const slots = await report.check(`Time slots for site ${SITE_ID} on ${date} parse`, async () => {
    const list = await client.timeSlots({ siteId: SITE_ID, date });
    // An empty answer is the site's legitimate "not published yet", but not
    // for a date the availability endpoint has just called open.
    if (list.length === 0 && !listedOpen) return { detail: 'empty (not published yet)', list };
    expect(list.length > 0, `no time slots parsed for ${date}, which is listed as open (markup changed?)`);
    expect(list.every((s) => /^\d\d:\d\d$/.test(s.start) && /^\d\d:\d\d$/.test(s.end)), 'bad HH:MM times');
    return { detail: `${list.length} slots, ${list.filter((s) => s.available).length} open`, list };
  });
  // The Python canary (scripts/canary/python.py) scrapes the same record and compares.
  if (slots.ok) {
    writeFileSync(
      join(RESULTS_DIR, 'record.json'),
      `${JSON.stringify({ siteId: SITE_ID, from: a.from, to: a.to, days: a.days, timeSlots: { date, slots: slots.value.list } }, null, 2)}\n`,
    );
  }
  if (slots.ok && listedOpen) {
    const name = 'Day-level and slot-level data agree';
    const open = slots.value.list.filter((s) => s.available).length;
    if (open > 0) {
      report.add('pass', name, `${open} open slot(s) on ${date}`);
    } else {
      // Slots at busy sites go in seconds, so look again once the cache has
      // expired before calling it a disagreement.
      await sleep(65_000);
      try {
        const again = await client.availability({ siteId: SITE_ID });
        if (!again.availableDates.includes(date)) {
          report.add('pass', name, `${date}'s last slot was taken between the two calls; both now say booked`);
        } else {
          const recheck = await client.timeSlots({ siteId: SITE_ID, date });
          const reopen = recheck.filter((s) => s.available).length;
          if (reopen > 0) report.add('pass', name, `${reopen} open slot(s) on ${date} on the second look`);
          else {
            report.add(
              'fail',
              name,
              `${date} is listed as available twice, 65 s apart, but every slot is booked both times; ` +
                'the availability semantics or the slot markup changed',
            );
          }
        }
      } catch (err) {
        report.add('fail', name, `re-check failed: ${err.message}`);
      }
    }
  }
} else {
  report.skip('Time slots', 'availability failed');
}

// 4. The session-refresh logic depends on how a missing token is answered.
await sleep(3500);
{
  const name = 'Missing anti-forgery token is still answered with an empty 200';
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await politeFetch(ENDPOINTS.availability, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({ fromDate: today, toDate: today, siteId: String(SITE_ID), requestedSlots: '1' }),
    });
    if (res.status === 200 && res.text.trim() === '') report.add('pass', name, 'empty 200');
    else if (res.status === 200 && res.text.trim().startsWith('[')) {
      report.warn(name, 'answered JSON without a token; the token no longer seems required');
    } else {
      report.add(
        'fail',
        name,
        `got HTTP ${res.status} "${res.text.slice(0, 80)}"; the client relies on an empty 200 to trigger a session refresh`,
      );
    }
  } catch (err) {
    report.add('fail', name, err.message);
  }
}

report.finish();
if (attachments.length) {
  const extra = attachments
    .map((a) => `\n<details><summary>${a.title}</summary>\n\n\`\`\`diff\n${a.body}\n\`\`\`\n</details>\n`)
    .join('');
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, extra, { flag: 'a' });
  writeFileSync(join(RESULTS_DIR, 'api.md'), extra, { flag: 'a' });
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function diff(a, b) {
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', a, b], { encoding: 'utf8' });
    return '(no textual difference)';
  } catch (err) {
    // git diff exits 1 when files differ.
    const out = String(err.stdout ?? err.message);
    return out.length > 20_000 ? `${out.slice(0, 20_000)}\n… (truncated)` : out;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
