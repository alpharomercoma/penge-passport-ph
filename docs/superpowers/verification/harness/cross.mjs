// Firefox's refusals, and two browsers: ask in Chrome, confirm in Firefox; a test reaches only the browser that asks.
import { writeFileSync } from 'node:fs';
import {
  checked, clickText, devicesOf, devOpen, emailSwitch, launch, linkIn, mailMark, mailSince, newNotes, openSheet, ORIGIN, publishedDay, pushIds, pushSwitch, resetRateLimits, RUN,
  send, shot, shown, signUpAndConfirm, sleep, SITE, waitText, workerReady,
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
    await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
    await shot(page, 'firefox-denied-hint');
    record('Firefox, denied: the padlock hint shows as the sheet opens', true);
  } catch (err) {
    record('Firefox, denied', false, String(err));
  } finally {
    await ff.close();
  }
}

// Firefox with its push connection off: subscribe() refuses; the switch goes back off, email stays on.
{
  const ff = await launch('firefox', { prefs: { 'permissions.default.desktop-notification': 1, 'dom.push.connection.enabled': false } });
  const page = await ff.newPage();
  try {
    await openSheet(page);
    const push = await pushSwitch(page);
    await push.click();
    await waitText(page, 'This browser would not turn notifications on (private windows often refuse). Email still works.', 20_000);
    await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
    await shot(page, 'firefox-subscribe-failed');
    record('A browser that will not subscribe: the switch goes back off with the reason, email stays on', (await checked(await pushSwitch(page))) === 'false' && (await checked(await emailSwitch(page))) === 'true');
  } catch (err) {
    record('Subscribe refused', false, String(err));
  } finally {
    await ff.close();
  }
}

// Firefox in private browsing.
{
  const ff = await launch('firefox', { prefs: { 'permissions.default.desktop-notification': 1, 'browser.privatebrowsing.autostart': true } });
  const page = await ff.newPage();
  try {
    await openSheet(page);
    const push = await pushSwitch(page);
    await push.click();
    await page.waitForFunction(
      () => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true' || document.body.innerText.includes('would not turn notifications on'),
      { timeout: 20_000 },
    );
    const on = (await checked(await pushSwitch(page))) === 'true';
    await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
    await shot(page, 'firefox-private');
    record('Firefox in private browsing', null, on ? 'the switch turned on: Firefox 157 allowed the subscription' : 'the switch went back off with the reason');
  } catch (err) {
    record('Firefox in private browsing', false, String(err));
  } finally {
    await ff.close();
  }
}

// Ask in Chrome, confirm in Firefox; then a test from Chrome reaches Chrome only.
const chrome = await launch('chrome');
versions.chrome = await chrome.version();
await chrome.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
const cpage = await chrome.newPage();
const ff = await launch('firefox', { prefs: { 'permissions.default.desktop-notification': 1 } });
const fpage = await ff.newPage();
try {
  const email = `cross-${RUN}@example.com`;
  await openSheet(cpage);
  await (await pushSwitch(cpage)).click();
  await cpage.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true', { timeout: 20_000 });
  const mark = mailMark();
  await send(cpage, email);
  // Chrome waits on its home page, where the row polls while waiting.
  await cpage.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(cpage, 'Waiting for you to confirm by email.', 15_000);
  await shot(cpage, 'chrome-cross-waiting');
  await fpage.goto(linkIn(mailSince(mark, 'confirm', email)[0].text, '/confirm'), { waitUntil: 'networkidle0' });
  await fpage.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm alert' && !b.disabled), { timeout: 15_000 });
  const idsBefore = pushIds();
  const t0 = Date.now(); // from the press in Firefox
  await clickText(fpage, 'button', 'Confirm alert');
  const chromeOn = cpage.waitForFunction(() => document.body.innerText.includes('Notifications on this device: On'), { timeout: 45_000 }).then(() => Date.now() - t0);
  await waitText(fpage, 'Notifications are on for the device where you asked for them. Open the app there once to finish.');
  await shot(fpage, 'firefox-confirm-elsewhere');
  record('Confirmed in Firefox: it says notifications are on where they were asked for', true);
  const subscriber = [...pushIds()].filter((x) => !idsBefore.has(x))[0];
  const ms = await chromeOn; // no reload: the row's own 30 s poll
  record('Back in Chrome, without reloading, the row turns On within 30 s of the press in Firefox', ms <= 30_000, `${ms} ms`);
  await shot(cpage, 'chrome-cross-on');
  let before = await shown(cpage);
  await devOpen(486, publishedDay(3));
  const fresh = await newNotes(cpage, before);
  record('An alert reaches Chrome', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => n.title)));

  // Firefox gets a push device of its own for the same address: one subscriber, two devices.
  await fpage.goto(SITE, { waitUntil: 'networkidle0' });
  await workerReady(fpage);
  await signUpAndConfirm(fpage, email, { emailOn: false, pushOn: true });
  await fpage.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(fpage, 'Notifications on this device: On', 20_000);
  const devices = Object.values(devicesOf(subscriber));
  record('One subscriber now has two registered devices (Chrome and Firefox)', devices.length === 2 && devices.every((d) => d.startsWith('r|')), JSON.stringify(devices.map((d) => d.slice(0, 2))));
  const ffBefore = await shown(fpage);
  before = await shown(cpage);
  const answer = cpage.waitForResponse((r) => r.url().endsWith('/api/push/test'));
  await clickText(cpage, '.device-row button', 'Send a test');
  record('A test from Chrome is accepted', (await answer).status() === 200);
  const inChrome = await newNotes(cpage, before.filter((n) => n.tag !== 'test'));
  const inFirefox = await newNotes(fpage, ffBefore, 10_000);
  record('The test reaches Chrome, and not Firefox (another device of the same subscriber) within 10 s', inChrome.some((n) => n.title === 'Test notification') && inFirefox.length === 0, `chrome ${JSON.stringify(inChrome.map((n) => n.title))}, firefox ${inFirefox.length}`);
} catch (err) {
  record('two browsers', false, String(err?.stack ?? err));
  await shot(cpage, 'cross-error-chrome').catch(() => {});
  await shot(fpage, 'cross-error-firefox').catch(() => {});
} finally {
  writeFileSync(new URL('./cross.json', import.meta.url), JSON.stringify({ versions, run: RUN, results }, null, 2));
  await chrome.close();
  await ff.close();
}
