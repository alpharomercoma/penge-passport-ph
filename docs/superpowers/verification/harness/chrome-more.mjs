// Chrome: both channels, test notifications, turning off and on again, deleting the data, email only, themes.
import { writeFileSync } from 'node:fs';
import {
  clickText, devicesOf, devOpen, keysNaming, launch, linkIn, mailMark, mailSince, newNotes, openSheet, ORIGIN, publishedDay, pushIds, resetRateLimits, RUN,
  shot, shown, signUpAndConfirm, sleep, SITE, storedCredential, waitText,
} from './lib.mjs';

const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};
const both = `both-${RUN}@example.com`;
const emailOnly = `email-only-${RUN}@example.com`;
/** Signs up and returns the id of the subscriber this made. */
async function signUp(page, email, ch) {
  const ids = pushIds();
  await signUpAndConfirm(page, email, ch);
  return [...pushIds()].filter((id) => !ids.has(id))[0] ?? null;
}

resetRateLimits();
const browser = await launch('chrome');
await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
const version = await browser.version();
const page = await browser.newPage();
const cdp = await page.createCDPSession();
try {
  // Both channels: one email and one notification for one alert.
  const id = await signUp(page, both, { emailOn: true, pushOn: true });
  record('Both: one new subscriber with one registered device', !!id && Object.values(devicesOf(id)).length === 1 && Object.values(devicesOf(id))[0].startsWith('r|'), String(id));
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  let before = await shown(page);
  let mark = mailMark();
  await devOpen(486, publishedDay(4));
  let fresh = await newNotes(page, before);
  await sleep(2000);
  record('Both: one alert gives one email and one notification', mailSince(mark, 'alert', both).length === 1 && fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', `emails ${mailSince(mark, 'alert', both).length}, notifications ${JSON.stringify(fresh.map((n) => n.title))}`);
  await shot(page, 'chrome-both-row');

  // Test notifications: three an hour.
  const testCall = () => page.waitForResponse((r) => r.url().endsWith('/api/push/test'));
  const statuses = [];
  for (let i = 1; i <= 3; i++) {
    const answer = testCall();
    await clickText(page, '.device-row button', 'Send a test');
    statuses.push((await answer).status());
    await waitText(page, 'Sent. It should arrive in a few seconds.');
  }
  const tests = (await shown(page)).filter((n) => n.title === 'Test notification');
  record('Three tests are each answered 200, and a "Test notification" is shown (one tag, so each replaces the last)', statuses.join() === '200,200,200' && tests.length === 1, `${statuses.join()} / ${tests.length} shown`);
  const fourth = testCall();
  await clickText(page, '.device-row button', 'Send a test');
  const fourthStatus = (await fourth).status();
  await waitText(page, 'You can send 3 test notifications an hour');
  record('The fourth within the hour is answered 429 with the limit message', fourthStatus === 429, String(fourthStatus));
  await shot(page, 'chrome-test-limit');

  // Turn off.
  const credBefore = await storedCredential(page);
  record('Before turning off, this browser holds a credential', typeof credBefore === 'string' && credBefore.length === 43);
  await clickText(page, '.device-row button', 'Turn off');
  await waitText(page, 'Notifications are off for this device');
  await shot(page, 'chrome-turned-off');
  record("Turn off removes this subscriber's device on the server", Object.keys(devicesOf(id)).length === 0, JSON.stringify(devicesOf(id)));
  record("Turn off clears this browser's credential", (await storedCredential(page)) === null);
  before = await shown(page);
  mark = mailMark();
  await sleep(125_000); // past the 2-minute floor between two alerts to one person
  await devOpen(486, publishedDay(7));
  fresh = await newNotes(page, before, 10_000);
  record('After turning off: no notification here within 10 s, and the email still comes', fresh.length === 0 && mailSince(mark, 'alert', both).length === 1, `notifications ${fresh.length}, emails ${mailSince(mark, 'alert', both).length}`);

  // Turn on again.
  await signUpAndConfirm(page, both, { emailOn: true, pushOn: true });
  const credAgain = await storedCredential(page);
  record('Turning on again makes a new credential', typeof credAgain === 'string' && credAgain !== credBefore);
  record('…and registers one device for the same subscriber', Object.values(devicesOf(id)).length === 1 && Object.values(devicesOf(id))[0].startsWith('r|'));
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  before = await shown(page);
  await sleep(125_000);
  await devOpen(486, publishedDay(8));
  fresh = await newNotes(page, before);
  record('Push works again after turning back on', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => n.title)));
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await sleep(400);
  await shot(page, 'chrome-row-light');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  // Delete my data.
  record('Before deleting, keys name this subscriber', keysNaming(id).length > 0, keysNaming(id).join(' '));
  mark = mailMark();
  await page.goto(`${SITE}delete-data`, { waitUntil: 'networkidle0' });
  await page.type('#deletion-email', both);
  await clickText(page, 'button', 'Email me a deletion link');
  await waitText(page, 'Check your inbox');
  await page.goto(linkIn(mailSince(mark, 'deletion', both)[0].text, '/delete-data'), { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Delete my alert data');
  await waitText(page, 'deleted');
  await shot(page, 'chrome-deleted');
  record('Delete my data leaves no key naming this subscriber (its hashes, credential and endpoint entries, reservation)', keysNaming(id).length === 0, keysNaming(id).join(' '));

  // Email only.
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  before = await shown(page);
  const ids = pushIds();
  await signUpAndConfirm(page, emailOnly, { emailOn: true, pushOn: false });
  record('Email only: no device is registered', [...pushIds()].filter((x) => !ids.has(x)).length === 0);
  mark = mailMark();
  await devOpen(486, publishedDay(3));
  await sleep(10_000);
  record('Email only: an alert email, and no notification within 10 s', mailSince(mark, 'alert', emailOnly).length === 1 && (await newNotes(page, before, 1000)).length === 0);

  // Denied, and the themes.
  await cdp.send('Browser.setPermission', { origin: ORIGIN, permission: { name: 'notifications' }, setting: 'denied' });
  await openSheet(page);
  await waitText(page, 'Notifications are blocked for this site');
  await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
  await shot(page, 'chrome-denied-hint');
  record('Denied: the sheet says how to allow notifications, without asking', true);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await sleep(400);
  await shot(page, 'chrome-sheet-light');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await sleep(400);
  await shot(page, 'chrome-sheet-dark');
} catch (err) {
  record('flow', false, String(err?.stack ?? err));
  await shot(page, 'chrome-more-error').catch(() => {});
} finally {
  writeFileSync(new URL('./chrome-more.json', import.meta.url), JSON.stringify({ version, run: RUN, results }, null, 2));
  await browser.close();
}
