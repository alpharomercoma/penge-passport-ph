// node push-flow.mjs chrome|firefox — push only, from the form to a notification.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  checked, clickText, devicesOf, devOpen, emailSwitch, IMG, launch, linkIn, mailMark, mailSince, newNotes, openSheet, ORIGIN, publishedDay, pushIds,
  pushSwitch, resetRateLimits, RUN, send, shot, shown, sleep, SITE, waitText, workerReady,
} from './lib.mjs';

const kind = process.argv[2];
const name = kind === 'chrome' ? 'Chrome' : 'Firefox';
mkdirSync(IMG, { recursive: true });
const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};
resetRateLimits();
const browser = await launch(kind, { prefs: { 'permissions.default.desktop-notification': 1 } });
if (kind === 'chrome') await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
const version = await browser.version();
const page = await browser.newPage();
const email = `push-only-${kind}-${RUN}@example.com`;
try {
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await workerReady(page);
  await shot(page, `${kind}-home`);
  const debug = await page.$eval('.debug-context', (e) => e.textContent).catch(() => null);
  record(`${name} tab is detected as a browser`, debug === 'context: browser', String(debug));

  await openSheet(page);
  const push = await pushSwitch(page);
  await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
  await shot(page, `${kind}-sheet-switches`);
  const label = await push.evaluate((e) => e.textContent?.trim());
  record('The switch reads "Browser notifications"', label === 'Browser notifications', label);
  await push.click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true', { timeout: 20_000 });
  await (await emailSwitch(page)).click();
  record('Push on, email off', (await checked(await pushSwitch(page))) === 'true' && (await checked(await emailSwitch(page))) === 'false');
  await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
  await sleep(400); // past the switches' 0.15 s transition
  await shot(page, `${kind}-sheet-push-only`);
  const mark = mailMark();
  await send(page, email);
  await shot(page, `${kind}-sheet-waiting`);
  const mails = mailSince(mark, 'confirm', email);
  record('One confirmation email for this request', mails.length === 1, String(mails.length));
  const mail = mails[0].text;
  record('The email says "Email: off"', /^Email: off$/m.test(mail));
  const pushLine = /^Notifications: .*$/m.exec(mail)?.[0] ?? '';
  record(`The email names the asking device (${name} on Mac)`, new RegExp(`^Notifications: on, for the device and browser that asked \\(${name} on Mac, `).test(pushLine), pushLine);

  await page.goto(linkIn(mail, '/confirm'), { waitUntil: 'networkidle0' });
  await waitText(page, 'Email: off');
  const preview = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.channels-preview li')].map((li) => li.textContent);
    const list = document.querySelector('.channels-preview');
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm alert');
    return { items, before: !!list && !!button && !!(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  record('The confirmation page lists both channels, before its button', preview.items[0] === 'Email: off' && new RegExp(`^Notifications: on, for the device and browser that asked \\(${name} on Mac, `).test(preview.items[1] ?? '') && preview.before, JSON.stringify(preview));
  await shot(page, `${kind}-confirm-preview`);
  const idsBefore = pushIds();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm alert' && !b.disabled));
  await clickText(page, 'button', 'Confirm alert');
  await waitText(page, 'You are subscribed');
  await waitText(page, 'Notifications are on for this device.', 15_000);
  await shot(page, `${kind}-confirmed`);
  record('Confirming in this browser registers it: "Notifications are on for this device."', true);
  const fresh = [...pushIds()].filter((id) => !idsBefore.has(id));
  const devices = fresh.length === 1 ? devicesOf(fresh[0]) : {};
  record('Exactly one new subscriber with one registered device', fresh.length === 1 && Object.values(devices).length === 1 && Object.values(devices)[0].startsWith('r|'), JSON.stringify(devices));

  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  await shot(page, `${kind}-row-on`);
  record('The row says "Notifications on this device: On"', true);

  const before = await shown(page);
  const alertMark = mailMark();
  const day = publishedDay();
  const report = await devOpen(486, day);
  const notes = await newNotes(page, before);
  const note = notes.find((n) => n.title === 'Dates open at Antipolo');
  record('An alert shows "Dates open at Antipolo", with the date and group in its body', notes.length === 1 && !!note && /· for 1 person$/.test(note.body), JSON.stringify(notes));
  record('Its data names Antipolo, that date and that group (what a tap opens; the tap itself is not run)', note?.data?.office === 486 && note?.data?.date === day && note?.data?.people === 1, JSON.stringify(note?.data));
  await sleep(10_000);
  record('No alert email for push only within 10 s', mailSince(alertMark, 'alert', email).length === 0);
  record('The checker counted the push as accepted', report.delivery?.push?.accepted >= 1, JSON.stringify(report.delivery?.push));
} catch (err) {
  record('flow', false, String(err?.stack ?? err));
  await shot(page, `${kind}-push-error`).catch(() => {});
} finally {
  writeFileSync(new URL(`./${kind}-push.json`, import.meta.url), JSON.stringify({ version, run: RUN, results }, null, 2));
  await browser.close();
}
