// Google Play's graphics: the icon (the site's mark, 512×512), the feature graphic
// (feature.html, 1024×500) and phone screenshots of the live site at 1080×1920 (a 360×640
// phone at 3x; Play refuses sides more than 2:1). The icon is a 32-bit PNG, every pixel opaque;
// the rest 24-bit PNG, with no alpha channel: what Play asks for.
// The alert form is filled with the site's own placeholder address and never sent. The office
// shown is whichever has the soonest open date when this runs.
//   node marketing/play-store/capture.cjs     (OUT=dir to write somewhere other than here)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const BASE = 'https://alphaexperiments.com/pengepassportph/';
const EMAIL = 'juan@example.com';
const OUT = process.env.OUT || __dirname;

/** Sets a PNG's channels (Chromium writes RGB or RGBA as it sees fit); needs Pillow. */
function channels(file, mode) {
  execFileSync('python3', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert(sys.argv[2]).save(sys.argv[1])', file, mode]);
}
const flatten = (file) => channels(file, 'RGB');

// The mark in its light colours: the store shows one icon for both themes.
const MARK = fs
  .readFileSync(`${__dirname}/../../apps/web/public/favicon.svg`, 'utf8')
  .replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/, '');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();

  // Full square on white: Play rounds the corners and adds the shadow itself.
  const i = await (await b.newContext({ viewport: { width: 512, height: 512 } })).newPage();
  await i.setContent(`<body style="margin:0"><div style="width:512px;height:512px;background:#fff;display:grid;place-items:center">
${MARK.replace('<svg ', '<svg width="358" height="358" ')}</div></body>`);
  await i.screenshot({ path: `${OUT}/icon-512.png` });
  channels(`${OUT}/icon-512.png`, 'RGBA');
  console.log('captured icon-512');

  const f = await (await b.newContext({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 })).newPage();
  await f.goto('file://' + __dirname + '/feature.html');
  await f.screenshot({ path: `${OUT}/feature-graphic.png` });
  flatten(`${OUT}/feature-graphic.png`);
  console.log('captured feature-graphic');

  const p = await (await b.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, colorScheme: 'light' })).newPage();
  const shot = async (name) => {
    await p.evaluate(() => document.activeElement?.blur());
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${OUT}/${name}.png` });
    flatten(`${OUT}/${name}.png`);
    console.log('captured', name);
  };

  // The offices at home, soonest date first.
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.locator('ul.rows button.row').first().waitFor();
  await shot('phone-1-offices');

  // The first office's calendar, then the hours of its first open day.
  await p.locator('ul.rows button.row').first().click();
  const day = p.locator('table.calendar-grid button.day.is-open').first();
  await day.waitFor({ timeout: 25000 }).catch(() => {
    throw new Error('the soonest office has no open day to tap: rerun after the next release of dates');
  });
  await p.locator('.office-head').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await p.evaluate(() => scrollBy(0, -16));
  await shot('phone-2-calendar');
  await day.click();
  await p.locator('.times').getByText(/\d:\d\d/).first().waitFor({ timeout: 30000 });
  // The day tapped, still marked on the calendar, above its hours.
  await p.locator('table.calendar-grid button.day.is-selected').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await p.evaluate(() => scrollBy(0, -16));
  await shot('phone-3-hours');

  // The alert form, filled in and not sent.
  await p.getByRole('button', { name: /Email me when dates open here/ }).first().click();
  const sheet = p.getByRole('dialog');
  await sheet.getByLabel('Your email').fill(EMAIL);
  await shot('phone-4-alert');

  // The posts abroad.
  await p.goto(`${BASE}?in=abroad`, { waitUntil: 'networkidle' });
  await p.locator('.country-name').first().waitFor();
  await shot('phone-5-abroad');

  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
