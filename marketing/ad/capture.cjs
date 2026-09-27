// Real footage of the live site for the ad, and where the ad taps on it (assets/boxes.js).
// A phone at 3x; the alert form is filled with the site's own placeholder address and never sent.
// The office, post and day are live data: change them when Baguio no longer has 7 Oct open.
//   node capture.cjs            (OUT=dir to write somewhere other than assets/)
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'https://alphaexperiments.com/pengepassportph/';
const OFFICE = 12; // Baguio
const DAY = '7'; // the day tapped on its October calendar
const POST = 36; // Dubai
const EMAIL = 'juan@example.com';
const OUT = process.env.OUT || __dirname + '/assets';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'light' })).newPage();
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
  await shot('baguio-cal-top');
  await shot('baguio-cal-full', true);
  const day = p.locator('table.calendar-grid button', { hasText: new RegExp(`^${DAY}$`) }).first();
  boxes.day = await box(day);
  await day.click();
  await p.locator('.times').getByText(/\d:\d\d/).first().waitFor({ timeout: 30000 });
  await shot('baguio-hours-full', true);
  await p.locator('.times').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot('baguio-hours-view');
  boxes.hoursScroll = await p.evaluate(() => scrollY);
  const rows = p.locator('.times li, .times .slot, .times tr');
  boxes.hours = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const text = (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
    if (/left/.test(text)) boxes.hours.push({ text, ...(await box(rows.nth(i))) });
  }

  // The alert form, empty (the ad types into it) and filled.
  const alertButton = p.getByRole('button', { name: /Email me when dates open here/ }).first();
  boxes.alertButton = await box(alertButton);
  await alertButton.click();
  const sheet = p.getByRole('dialog');
  await shot('alert-sheet-empty');
  const input = sheet.getByLabel('Your email');
  boxes.email = await box(input);
  boxes.send = await box(sheet.getByRole('button', { name: /Send confirmation email/ }));
  await input.fill(EMAIL);
  await shot('alert-sheet');

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
