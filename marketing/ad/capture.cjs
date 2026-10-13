// Real footage of the live site for the ad, and where the ad taps on it (assets/boxes.js).
// A phone at 3x, as the Play app shows the site; the alert form's Notifications switch is turned on and the form is
// never sent (nothing is set up, nothing is emailed).
// The office, post and day are live data: change them when the day is no longer open with places left.
//   node capture.cjs            (OUT=dir to write somewhere other than assets/)
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'https://alphaexperiments.com/pengepassportph/';
const OFFICE = 424; // Ilocos Norte
const DAY = '20'; // the day tapped on its first calendar page (October)
const POST = 36; // Dubai
const EMAIL = 'juan@example.com';
const OUT = process.env.OUT || __dirname + '/assets';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // The full Chromium build: the default headless shell reports notifications as denied whatever is granted.
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'light' });
  // As in the app from Google Play: the switch reads "Notifications on this device", and the permission is the one the
  // ad's Allow grants.
  await ctx.addInitScript(() => sessionStorage.setItem('pengepassportph-context', 'play'));
  await ctx.grantPermissions(['notifications'], { origin: new URL(BASE).origin });
  const p = await ctx.newPage();
  const shot = async (name, fullPage = false) => {
    await p.evaluate(() => document.activeElement?.blur());
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage });
    console.log('captured', name);
  };
  const box = async (loc) => {
    const r = await loc.boundingBox();
    if (!r) throw new Error('not on screen: ' + loc);
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const boxes = {};

  // The offices at home, then the switch to the posts abroad.
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.locator('ul.rows button.row').first().waitFor();
  await shot('ph-top');
  await shot('ph-full', true);
  boxes.abroad = await box(p.getByRole('button', { name: 'Abroad', exact: true }));
  await p.getByRole('button', { name: 'Abroad', exact: true }).click();
  await p.locator('.country-name').first().waitFor();
  await shot('abroad-top');
  boxes.mea = await box(p.getByRole('button', { name: 'Middle East/Africa', exact: true }));
  await p.getByRole('button', { name: 'Middle East/Africa', exact: true }).click();
  await shot('abroad-mea-full', true);

  // One office: its calendar, a tap on a day, that day's hours.
  await p.goto(`${BASE}?office=${OFFICE}`, { waitUntil: 'networkidle' });
  await p.locator('.office-status').filter({ hasText: /open day/ }).waitFor({ timeout: 25000 });
  await shot('office-cal-top');
  await shot('office-cal-full', true);
  const day = p.locator('table.calendar-grid button', { hasText: new RegExp(`^${DAY}$`) }).first();
  boxes.day = await box(day);
  await day.click();
  await p.locator('.times').getByText(/\d:\d\d/).first().waitFor({ timeout: 30000 });
  await shot('office-hours-full', true);
  await p.locator('.times').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot('office-hours-view');
  boxes.hoursScroll = await p.evaluate(() => scrollY);
  const rows = p.locator('.times li, .times .slot, .times tr');
  boxes.hours = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const text = (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
    if (/left/.test(text)) boxes.hours.push({ text, ...(await box(rows.nth(i))) });
  }

  // The alert form for this office: both switches off, then Notifications on (the ad taps it, then the button).
  // In the part of the ad's phone screen below its status bar (844 - 47 px), so the form lays out as it would there,
  // its button in view.
  const alertButton = p.getByRole('button', { name: /Alert me when dates open here/ }).first();
  boxes.alertButton = await box(alertButton);
  await p.setViewportSize({ width: 390, height: 844 - 47 });
  await alertButton.click();
  const sheet = p.getByRole('dialog');
  const notify = sheet.getByRole('switch', { name: /Notifications/ });
  await notify.waitFor();
  // The sheet scrolled just enough to show its button (the switch stays in view): the same scroll for both screens.
  await p.evaluate(() => {
    const sheetEl = document.querySelector('.sheet');
    const button = sheetEl.querySelector('button[type="submit"]').getBoundingClientRect();
    sheetEl.scrollTop += Math.max(0, button.bottom - (innerHeight - 20));
  });
  await shot('alert-sheet-empty');
  boxes.notify = await box(notify);
  await notify.click();
  await p.waitForFunction(() => document.querySelector('[role="dialog"] [role="switch"][aria-checked="true"]'));
  await shot('alert-sheet-notify');
  boxes.submit = await box(sheet.getByRole('button', { name: /^Turn on notifications$/ }));
  // Email on as well, typed in: the form's other way (never sent).
  await notify.click();
  await sheet.getByRole('switch', { name: 'Email' }).click();
  await sheet.getByLabel('Your email').fill(EMAIL);
  await shot('alert-sheet-email');
  await p.setViewportSize({ width: 390, height: 844 });

  // A post abroad, and the desktop layout (not in the 16:9 cut; kept for other cuts).
  await p.goto(`${BASE}?office=${POST}`, { waitUntil: 'networkidle' });
  await p.locator('.office-status').filter({ hasText: /open day|No open dates/ }).waitFor({ timeout: 25000 });
  await shot('dubai-top');
  await shot('dubai-full', true);
  const d = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })).newPage();
  await d.goto(BASE, { waitUntil: 'networkidle' });
  await d.locator('ul.rows button.row').first().waitFor();
  await d.waitForTimeout(500);
  await d.screenshot({ path: `${OUT}/desktop-home.png` });
  console.log('captured desktop-home');

  // The phone's clock in the ad: when these screens were taken, in Manila ("4:36", as Android's status bar shows it).
  boxes.clock = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date()).replace(/\s*[AP]M$/, '');
  fs.writeFileSync(
    `${OUT}/boxes.js`,
    '// Written by capture.cjs: where things are on the captured phone screens, in CSS px of the\n' +
      '// 390-wide page. hoursScroll is how far the office page scrolls from the calendar to the hours.\n' +
      `window.BOXES = ${JSON.stringify(boxes, null, 1)};\n`,
  );
  console.log(JSON.stringify(boxes));
  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
