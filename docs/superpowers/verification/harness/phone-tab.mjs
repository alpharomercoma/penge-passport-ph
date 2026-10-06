// The phone's Chrome tab, over adb (DevTools forwarded to localhost:9333): push only, to a notification.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  checked, clickText, devicesOf, devOpen, emailSwitch, IMG, linkIn, mailMark, mailSince, newNotes, openSheet, publishedDay, pushIds, pushSwitch, resetRateLimits, RUN,
  send, shown, sleep, SITE, waitText, workerReady,
} from './lib.mjs';

const D = process.env.ADB_SERIAL; // the phone, as `adb devices` lists it
if (!D) throw new Error('Set ADB_SERIAL');
const adb = (...a) => execFileSync('adb', ['-s', D, ...a], { maxBuffer: 64 * 1024 * 1024 });
const phoneShot = (name) => {
  writeFileSync(join(IMG, `${name}.png`), adb('exec-out', 'screencap', '-p'));
  console.log('  phone shot', name);
};
/** Taps the centre of the first on-screen node whose text matches. */
function tapText(text) {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/ui.xml').toString();
  const m = new RegExp(`text="${text}"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
  if (!m) throw new Error(`nothing on screen reads "${text}"`);
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  adb('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
}
const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};

globalThis.PHONE_CLICKS = true;
resetRateLimits();
const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
const version = await browser.version();
const page = (await browser.pages()).find((p) => p.url().includes('localhost:4173')) ?? (await browser.newPage());
const cdp = await page.createCDPSession();
await cdp.send('Browser.setPermission', { origin: 'http://localhost:4173', permission: { name: 'notifications' }, setting: 'granted' }).catch((e) => console.log('  setPermission:', e.message));
const email = `phone-tab-${RUN}@example.com`;
try {
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await workerReady(page);
  const debug = await page.$eval('.debug-context', (e) => e.textContent).catch(() => null);
  record('A Chrome tab on the phone is detected as a browser', debug === 'context: browser', String(debug));
  await openSheet(page);
  const push = await pushSwitch(page);
  record('The switch reads "Browser notifications"', (await push.evaluate((e) => e.textContent?.trim())) === 'Browser notifications');
  // A real tap (adb), found by its text on screen: a scripted click does not reach Chrome's gesture checks here.
  await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
  await sleep(800);
  // Permission was granted by real taps on the phone's own prompts (screenshots phone-tab-prompt,
  // phone-chrome-os-prompt); DevTools mouse input does not reach the page here, so it clicks in the page.
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true', { timeout: 20_000 });
  await (await emailSwitch(page)).evaluate((e) => e.click());
  await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
  await sleep(500);
  phoneShot('phone-tab-sheet');
  record('Push on, email off', (await checked(await pushSwitch(page))) === 'true' && (await checked(await emailSwitch(page))) === 'false');
  const mark = mailMark();
  await send(page, email);
  const mail = mailSince(mark, 'confirm', email)[0].text;
  record('The email names the phone ("Chrome on Android")', /Notifications: on, for the device and browser that asked \(Chrome on Android, /.test(mail), /^Notifications: .*$/m.exec(mail)?.[0]);
  const ids = pushIds();
  await page.goto(linkIn(mail, '/confirm'), { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm alert' && !b.disabled), { timeout: 15_000 });
  phoneShot('phone-tab-confirm-preview');
  await clickText(page, 'button', 'Confirm alert');
  await waitText(page, 'Notifications are on for this device.', 20_000);
  phoneShot('phone-tab-confirmed');
  const id = [...pushIds()].filter((x) => !ids.has(x))[0];
  record('Confirmed: one registered device', !!id && Object.values(devicesOf(id)).length === 1 && Object.values(devicesOf(id))[0].startsWith('r|'));
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  phoneShot('phone-tab-row-on');
  const before = await shown(page);
  await devOpen(486, publishedDay(3));
  const fresh = await newNotes(page, before);
  record('An alert arrives as a Chrome notification on the phone: "Dates open at Antipolo"', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => `${n.title} / ${n.body}`)));
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await sleep(1500);
  phoneShot('phone-tab-notification');
  adb('shell', 'cmd', 'statusbar', 'collapse');
  writeFileSync(new URL('./phone-tab-subscriber.txt', import.meta.url), `${id}\n${email}\n`);
} catch (err) {
  record('flow', false, String(err?.stack ?? err));
  phoneShot('phone-tab-error');
} finally {
  writeFileSync(new URL('./phone-tab.json', import.meta.url), JSON.stringify({ version, run: RUN, results }, null, 2));
  browser.disconnect();
}
