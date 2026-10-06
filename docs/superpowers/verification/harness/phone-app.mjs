// The debug Android app (TWA) on the phone: real taps through adb for the switch and Android's
// own dialogs; DevTools (forwarded to localhost:9333) to read the page and click within it.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  clickText, devicesOf, devOpen, emailSwitch, IMG, linkIn, mailMark, mailSince, newNotes, publishedDay, pushIds, pushSwitch, resetRateLimits, RUN, send, shown,
  sleep, waitText, workerReady,
} from './lib.mjs';

const D = process.env.ADB_SERIAL; // the phone, as `adb devices` lists it
if (!D) throw new Error('Set ADB_SERIAL');
const APP = 'com.alphaexperiments.pengepassportph.dev';
const SITE = 'https://localhost:8443/pengepassportph/';
const adb = (...a) => execFileSync('adb', ['-s', D, ...a], { maxBuffer: 64 * 1024 * 1024 });
const phoneShot = (name) => {
  writeFileSync(join(IMG, `${name}.png`), adb('exec-out', 'screencap', '-p'));
  console.log('  phone shot', name);
};
/** On-screen nodes: text → centre. */
function screenNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/ui.xml').toString();
  const nodes = [];
  for (const m of xml.matchAll(/<node [^>]*?(?:text|content-desc)="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    const [x1, y1, x2, y2] = m.slice(2).map(Number);
    nodes.push({ text: m[1], x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), x1, y1, x2, y2 });
  }
  return nodes;
}
const tap = (x, y) => adb('shell', 'input', 'tap', String(x), String(y));
async function waitNode(re, ms = 10_000) {
  for (let i = 0; i < ms / 500; i++) {
    const n = screenNodes().find((x) => re.test(x.text));
    if (n) return n;
    await sleep(500);
  }
  throw new Error(`nothing on screen matches ${re}`);
}
/** A real tap on a page element: its CSS box mapped onto the WebView's place on screen. */
async function realTap(page, handle) {
  // The keyboard (the sheet focuses a field) moves things: close it first.
  await page.evaluate(() => document.activeElement?.blur?.());
  await sleep(800);
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/ui.xml').toString();
  const m = /class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  // The page under the status bar (measured on this phone in portrait), when the dump does not list it.
  const web = m ? { x1: Number(m[1]), y1: Number(m[2]) } : { x1: 0, y1: 152 };
  const { box, dpr } = await handle.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, dpr: window.devicePixelRatio };
  });
  tap(Math.round(web.x1 + (box.x + Math.min(box.w, 60) / 2) * dpr), Math.round(web.y1 + (box.y + box.h / 2) * dpr));
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
const page = (await browser.pages()).find((p) => p.url().startsWith(SITE));
const email = `phone-app-${RUN}@example.com`;
try {
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await workerReady(page);
  record('The debug app is detected as the Play app (context: play)', (await page.$eval('.debug-context', (e) => e.textContent)) === 'context: play');
  await clickText(page, 'button', 'Email alerts');
  await page.waitForSelector('[role="dialog"]');
  const push = await pushSwitch(page);
  record('The switch reads "Notifications on this device"', (await push.evaluate((e) => e.textContent?.trim())) === 'Notifications on this device');
  await push.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(700);
  if ((await page.evaluate(() => Notification.permission)) === 'granted') {
    // Allowed already in an earlier run, through Chrome's site prompt (phone-app-chrome-prompt).
    const appGrant = /POST_NOTIFICATIONS: granted=(\w+)/.exec(adb('shell', 'dumpsys', 'package', APP).toString())?.[1];
    record("Android's own permission prompt names the app", false, `not shown: Chrome's site prompt asked instead; the app's POST_NOTIFICATIONS granted=${appGrant}`);
    await (await pushSwitch(page)).evaluate((e) => e.click());
  } else {
    await realTap(page, push);
    const dialog = await waitNode(/to send you notifications|wants to send you notifications/i, 20_000);
    phoneShot('phone-app-prompt');
    record("Android's own permission prompt names the app", /PassportPH dev/.test(dialog.text), dialog.text);
    tap(...Object.values((await waitNode(/^Allow$/))).slice(1, 3));
  }
  await page.waitForFunction(() => [...document.querySelectorAll('[role="switch"]')].at(-1)?.getAttribute('aria-checked') === 'true', { timeout: 20_000 });
  await (await emailSwitch(page)).evaluate((e) => e.click());
  await sleep(500);
  phoneShot('phone-app-sheet');
  const mark = mailMark();
  await send(page, email);
  const mail = mailSince(mark, 'confirm', email)[0].text;
  record('The email names the device ("Chrome on Android")', /Notifications: on, for the device and browser that asked \(Chrome on Android, /.test(mail), /^Notifications: .*$/m.exec(mail)?.[0]);
  const ids = pushIds();
  await page.goto(linkIn(mail, '/confirm').replace('http://localhost:4173', 'https://localhost:8443'), { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm alert' && !b.disabled), { timeout: 15_000 });
  await clickText(page, 'button', 'Confirm alert');
  await waitText(page, 'Notifications are on for this device.', 20_000);
  phoneShot('phone-app-confirmed');
  const id = [...pushIds()].filter((x) => !ids.has(x))[0];
  record('Confirmed in the app: one registered device', !!id && Object.values(devicesOf(id)).length === 1 && Object.values(devicesOf(id))[0].startsWith('r|'));
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  phoneShot('phone-app-row-on');
  const before = await shown(page);
  const day = publishedDay(4);
  await devOpen(486, day);
  const fresh = await newNotes(page, before);
  record('An alert shows a notification', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => `${n.title} / ${n.body}`)));
  // Which app posted it: the delegated notification belongs to the debug app, not Chrome.
  const posted = adb('shell', 'dumpsys', 'notification', '--noredact').toString();
  const mine = posted.split('NotificationRecord').filter((r) => r.includes('Dates open at Antipolo'));
  record('Android shows it as the app\'s notification (posted by the debug app)', mine.some((r) => r.includes(`pkg=${APP}`)), mine.map((r) => /pkg=(\S+)/.exec(r)?.[1]).join(' '));
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await sleep(1500);
  phoneShot('phone-app-notification-full');
  const card = await waitNode(/Dates open at Antipolo|Dates o/);
  tap(card.x, card.y);
  await sleep(4000);
  const at = (await browser.pages()).map((p) => p.url()).find((u) => u.includes('office=486'));
  record('Tapping it opens the app on Antipolo, with the date and group', !!at && at.includes(`date=${day}`) && at.includes('people=1'), String(at));
  phoneShot('phone-app-tapped');
  writeFileSync(new URL('./phone-app-subscriber.txt', import.meta.url), `${id}\n${email}\n`);
} catch (err) {
  record('flow', false, String(err?.stack ?? err));
  phoneShot('phone-app-error');
} finally {
  writeFileSync(new URL('./phone-app.json', import.meta.url), JSON.stringify({ version, run: RUN, results }, null, 2));
  browser.disconnect();
}
