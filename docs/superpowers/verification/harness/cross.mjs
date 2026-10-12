// Firefox's refusals, and two browsers each with a notification alert of its own: an opening reaches both, and a
// test reaches only the browser that sends it.
import { writeFileSync } from 'node:fs';
import {
  checked, clickText, devOpen, emailSwitch, launch, newNotes, notifyOnly, openSheet, ORIGIN, pickOffice, publishedDay, pushSwitch, REPO, resetRateLimits, RUN, shot, shown, sleep, waitText,
} from './lib.mjs';

const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass === null ? 'SEEN' : pass ? 'PASS' : 'FAIL', item, note);
};
resetRateLimits();
const versions = {};

// Firefox, notifications denied for the site: the hint shows at once.
{
  const ff = await launch('firefox', { prefs: { 'permissions.default.desktop-notification': 2 } });
  versions.firefox = await ff.version();
  const page = await ff.newPage();
  try {
    await openSheet(page);
    await waitText(page, 'Notifications are blocked for this site. Allow them from the padlock in the address bar, then try again.');
    await page.evaluate(() => document.querySelector('[role="switch"]')?.scrollIntoView({ block: 'center' }));
    await shot(page, 'firefox-denied-hint');
    record('Firefox, denied: the padlock hint shows as the sheet opens', true);
  } catch (err) {
    record('Firefox, denied', false, String(err));
  } finally {
    await ff.close();
  }
}

/** Notifications only, pressed: resolves with the text it ended on, setup done or refused. */
async function tryNotify(page) {
  await openSheet(page);
  await pickOffice(page);
  const mail = await emailSwitch(page);
  if ((await checked(mail)) === 'true') await mail.click();
  await (await pushSwitch(page)).click();
  await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 20_000 }, await pushSwitch(page));
  await clickText(page, 'button[type="submit"]', 'Turn on notifications');
  const ends = ['Notifications are on for this device.', "This notification setup didn't finish.", "This browser can't finish setting up notifications."];
  await page.waitForFunction((t) => t.some((x) => document.body.innerText.includes(x)), { timeout: 60_000 }, ends);
  return page.evaluate((t) => t.find((x) => document.body.innerText.includes(x)), ends);
}

// Firefox with its push connection off: subscribe() refuses; the form says the setup didn't finish, offers a retry, and
// still says so after the page's 30 s clock tick.
{
  const ff = await launch('firefox', { prefs: { 'permissions.default.desktop-notification': 1, 'dom.push.connection.enabled': false } });
  const page = await ff.newPage();
  try {
    const end = await tryNotify(page);
    await shot(page, 'firefox-subscribe-failed');
    const retry = () => page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Try notifications again'));
    record("A browser that will not subscribe: the form says the setup didn't finish, with a retry", end === "This notification setup didn't finish." && (await retry()), end);
    await sleep(35_000);
    const still = await page.evaluate(() => document.body.innerText.includes("This notification setup didn't finish."));
    record('…and still says so 35 s later', still && (await retry()));
  } catch (err) {
    record('Subscribe refused', false, `${err}: ${await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? document.body.innerText).catch(() => '')}`.slice(0, 600));
    await shot(page, 'firefox-subscribe-failed').catch(() => {});
  } finally {
    await ff.close();
  }
}

// Firefox in private browsing.
{
  const ff = await launch('firefox', { prefs: { 'permissions.default.desktop-notification': 1, 'browser.privatebrowsing.autostart': true } });
  const page = await ff.newPage();
  try {
    const end = await tryNotify(page);
    await shot(page, 'firefox-private');
    record('Firefox in private browsing', null, end);
  } catch (err) {
    record('Firefox in private browsing', false, String(err));
  } finally {
    await ff.close();
  }
}

// Chrome and Firefox, each with its own notification alert.
const chrome = await launch('chrome');
versions.chrome = await chrome.version();
await chrome.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
const cpage = await chrome.newPage();
const ff = await launch('firefox', { prefs: { 'permissions.default.desktop-notification': 1 } });
const fpage = await ff.newPage();
try {
  await notifyOnly(cpage);
  await notifyOnly(fpage);
  record('Both browsers set up a notification alert of their own', true);
  let before = await shown(cpage);
  const ffBefore = await shown(fpage);
  await devOpen(486, publishedDay(3));
  const inChrome = await newNotes(cpage, before);
  const inFirefox = await newNotes(fpage, ffBefore);
  record('An opening reaches both browsers, once each', inChrome.length === 1 && inFirefox.length === 1 && [...inChrome, ...inFirefox].every((n) => n.title === 'Dates open at Antipolo'), JSON.stringify({ chrome: inChrome.map((n) => n.title), firefox: inFirefox.map((n) => n.title) }));
  await sleep(500);
  before = await shown(cpage);
  const ffQuiet = await shown(fpage);
  const answer = cpage.waitForResponse((r) => r.url().endsWith('/mine/test'));
  await clickText(cpage, '.device-row button', 'Send a test');
  const res = await answer;
  const body = await res.json().catch(() => null);
  record('A test from Chrome is accepted', res.status() === 200 && body?.test === 'accepted', JSON.stringify(body));
  // The test notification itself (this fresh profile has shown none before, so its tag is new).
  const testChrome = (await newNotes(cpage, before)).filter((n) => n.title === 'Test notification');
  const testFirefox = await newNotes(fpage, ffQuiet, 10_000);
  record('The test notification reaches Chrome, and nothing reaches Firefox within 10 s', testChrome.length === 1 && testFirefox.length === 0, `chrome ${JSON.stringify(testChrome.map((n) => n.title))}, firefox ${testFirefox.length}`);
} catch (err) {
  record('two browsers', false, String(err?.stack ?? err));
  await shot(cpage, 'cross-error-chrome').catch(() => {});
  await shot(fpage, 'cross-error-firefox').catch(() => {});
} finally {
  writeFileSync(`${REPO}/docs/superpowers/verification/results/cross.json`, JSON.stringify({ versions, run: RUN, results }, null, 2));
  await chrome.close();
  await ff.close();
}
process.exitCode = results.every((r) => r.pass !== false) ? 0 : 1;
