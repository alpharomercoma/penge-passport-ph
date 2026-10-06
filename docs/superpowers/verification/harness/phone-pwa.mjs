// The app installed from Chrome on the phone (a WebAPK for localhost:4173). It shares the Chrome
// tab's origin, so it shares that tab's worker and push registration (phone-tab.mjs ran first).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { devOpen, IMG, newNotes, openSheet, publishedDay, pushSwitch, RUN, shown, sleep, waitText } from './lib.mjs';

const D = process.env.ADB_SERIAL; // the phone, as `adb devices` lists it
if (!D) throw new Error('Set ADB_SERIAL');
const adb = (...a) => execFileSync('adb', ['-s', D, ...a], { maxBuffer: 64 * 1024 * 1024 });
const phoneShot = (name) => {
  writeFileSync(join(IMG, `${name}.png`), adb('exec-out', 'screencap', '-p'));
  console.log('  phone shot', name);
};
function screenNodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/ui.xml').toString();
  return [...xml.matchAll(/<node [^>]*?text="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)].map((m) => {
    const [x1, y1, x2, y2] = m.slice(2).map(Number);
    return { text: m[1], x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  });
}
const topActivity = () => /topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)/.exec(adb('shell', 'dumpsys', 'activity', 'activities').toString())?.[1];
const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};

globalThis.PHONE_CLICKS = true;
const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
const version = await browser.version();
let page;
for (const p of await browser.pages()) {
  if (await p.evaluate(() => document.querySelector('.debug-context')?.textContent === 'context: installed').catch(() => false)) page = p;
}
try {
  record('The installed app is detected as installed (context: installed)', !!page, topActivity());
  await page.reload({ waitUntil: 'networkidle0' });
  await openSheet(page);
  record('The switch reads "Notifications on this device"', (await (await pushSwitch(page)).evaluate((e) => e.textContent?.trim())) === 'Notifications on this device');
  await page.evaluate(() => document.querySelector('fieldset.channels')?.scrollIntoView({ block: 'center' }));
  await sleep(500);
  phoneShot('phone-pwa-sheet');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications on this device: On', 20_000);
  record('The row is On: the tab\'s registration, same origin', true);
  phoneShot('phone-pwa-row-on');
  const before = await shown(page);
  const day = publishedDay(5);
  await devOpen(486, day);
  const fresh = await newNotes(page, before);
  record('An alert shows a notification', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => `${n.title} / ${n.body}`)));
  const posted = adb('shell', 'dumpsys', 'notification', '--noredact').toString().split('NotificationRecord').filter((r) => r.includes('Dates open at Antipolo'));
  record('Who posted it (observation)', true, [...new Set(posted.map((r) => /pkg=(\S+)/.exec(r)?.[1]))].join(' '));
  adb('shell', 'input', 'keyevent', 'HOME');
  await sleep(1000);
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await sleep(1500);
  // The card for this origin and the new day ("Mon 12 Oct"-style), not the debug app's (8443).
  const label = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
  const nodes = screenNodes();
  const host = nodes.filter((n) => n.text.startsWith('localhost:4'));
  const body = nodes.filter((n) => n.text.startsWith(label));
  const card = body.find((b) => host.some((h) => Math.abs(h.y - b.y) < 120)) ?? body[0];
  if (!card) throw new Error(`no card for ${label}: ${nodes.map((n) => n.text).join(' | ')}`);
  adb('shell', 'input', 'tap', String(card.x), String(card.y));
  await sleep(4000);
  const act = topActivity();
  const at = await page.evaluate(() => location.href).catch(() => null);
  record('Tapping it opens the installed app on Antipolo, with the date and group', /WebApk/i.test(act ?? '') && !!at && at.includes('office=486') && at.includes(`date=${day}`) && at.includes('people=1'), `${act} ${at}`);
  phoneShot('phone-pwa-tapped');
} catch (err) {
  record('flow', false, String(err?.stack ?? err));
  phoneShot('phone-pwa-error');
} finally {
  writeFileSync(new URL('./phone-pwa.json', import.meta.url), JSON.stringify({ version, run: RUN, results }, null, 2));
  browser.disconnect();
}
