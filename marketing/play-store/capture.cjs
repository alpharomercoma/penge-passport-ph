// Google Play's graphics, as Play asks for them:
//   icon-512.png                      512×512, 32-bit PNG, every pixel opaque (the site's mark)
//   feature-graphic.png               1024×500, 24-bit PNG (feature.html)
//   screenshots-phone/*.png           1080×1920 (a 360×640 phone at 3x)
//   screenshots-tablet-7/*.png        1200×2133 (a 600dp 7-inch tablet at 2x)
//   screenshots-tablet-10/*.png       1800×3200 (a 900dp 10-inch tablet at 2x)
// Screenshots are 24-bit PNG, 9:16: Play refuses one whose long side is more than twice the
// short one. Each is the live site with a caption above it; the numbers in the captions are
// read from the live API when this runs, so they are true on the day.
// The alert form is filled with the site's own placeholder address and never sent. The office
// shown is whichever has the soonest open date when this runs.
//
//   node marketing/play-store/capture.cjs
//   SITE=http://localhost:4319/pengepassportph/ node marketing/play-store/capture.cjs
// The second shoots a local build (`vite preview`) before it is deployed, with its API calls
// answered by the live site. OUT=dir writes somewhere other than here. Needs Pillow.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');

const LIVE = 'https://alphaexperiments.com/pengepassportph/';
const SITE = process.env.SITE || LIVE;
const EMAIL = 'juan@example.com';
const OUT = process.env.OUT || __dirname;

const DEVICES = [
  { dir: 'screenshots-phone', viewport: { width: 360, height: 640 }, scale: 3, canvas: { width: 1080, height: 1920 } },
  { dir: 'screenshots-tablet-7', viewport: { width: 600, height: 1067 }, scale: 2, canvas: { width: 1200, height: 2133 } },
  { dir: 'screenshots-tablet-10', viewport: { width: 900, height: 1600 }, scale: 2, canvas: { width: 1800, height: 3200 } },
];

/** Sets a PNG's channels (Chromium writes RGB or RGBA as it sees fit). */
function channels(file, mode) {
  execFileSync('python3', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert(sys.argv[2]).save(sys.argv[1])', file, mode]);
}
const flatten = (file) => channels(file, 'RGB');

// The mark in its light colours: the store shows one icon for both themes.
const MARK = fs
  .readFileSync(`${__dirname}/../../apps/web/public/favicon.svg`, 'utf8')
  .replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/, '');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * A screenshot with its caption: the one open day of the mark, a headline and a line under
 * it, above the screen in a card. Laid out in units of a 1080-wide canvas, so every size is
 * the same picture.
 */
function framed(png, canvas, title, sub) {
  const u = canvas.width / 1080;
  const cardTop = 420 * u;
  const cardHeight = canvas.height - cardTop - 56 * u;
  const cardWidth = cardHeight * (canvas.width / canvas.height);
  const left = (canvas.width - cardWidth) / 2;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${canvas.width}px; height: ${canvas.height}px; overflow: hidden; background: #f5f7f6; color: #17201b;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
  .day { position: absolute; left: ${left}px; top: ${108 * u}px; width: ${34 * u}px; height: ${30 * u}px; border-radius: ${8 * u}px; background: #0a7a43; }
  .caption { position: absolute; left: ${left}px; top: ${162 * u}px; width: ${cardWidth}px; }
  h1 { font-size: ${62 * u}px; line-height: 1.08; font-weight: 750; letter-spacing: -0.02em; text-wrap: balance; }
  p { margin-top: ${16 * u}px; font-size: ${31 * u}px; line-height: 1.3; color: #4f5b55; text-wrap: balance; }
  .card { position: absolute; left: ${left}px; top: ${cardTop}px; width: ${cardWidth}px; height: ${cardHeight}px; overflow: hidden;
    border: ${2 * u}px solid #dfe5e2; border-radius: ${30 * u}px; background: #fff; }
  .card img { display: block; width: 100%; height: 100%; }
</style></head><body>
  <div class="day"></div>
  <div class="caption"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>
  <div class="card"><img src="data:image/png;base64,${png.toString('base64')}" alt=""></div>
</body></html>`;
}

(async () => {
  // What the captions say, from the live site today.
  const status = await (await fetch(`${LIVE}api/status`)).json();
  const abroad = await (await fetch(`${LIVE}api/abroad`)).json();
  const offices = status.sites.length;
  const posts = abroad.posts.length;
  const countries = new Set(abroad.posts.map((p) => p.country)).size;
  const CAPTIONS = {
    '01-offices': ['Every office, soonest date first', `All ${offices} DFA offices in the Philippines, checked every 15 minutes`],
    '02-calendar': ['Open days at a glance', "Each office's calendar, from the latest check"],
    '03-hours': ['Tap a day for its hours', 'Places left each hour, straight from passport.gov.ph'],
    // No "free" or other price words on the pictures: Google's rule for screenshots and graphics.
    '04-alert': ['An email when dates open', 'Up to 10 offices, with a one-click unsubscribe'],
    '05-abroad': ['Embassies and consulates too', `${posts} posts in ${countries} countries`],
  };

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

  for (const device of DEVICES) {
    const dir = `${OUT}/${device.dir}`;
    fs.mkdirSync(dir, { recursive: true });
    const p = await (await b.newContext({ viewport: device.viewport, deviceScaleFactor: device.scale, colorScheme: 'light' })).newPage();
    if (SITE !== LIVE) {
      await p.route(`${SITE}api/**`, async (route) => {
        const res = await fetch(LIVE + route.request().url().slice(SITE.length), {
          method: route.request().method(),
          headers: { 'user-agent': await p.evaluate(() => navigator.userAgent) },
        });
        await route.fulfill({ status: res.status, contentType: res.headers.get('content-type') ?? undefined, body: Buffer.from(await res.arrayBuffer()) });
      });
    }
    const page = await b.newPage({ viewport: device.canvas, deviceScaleFactor: 1 });
    const shot = async (name) => {
      await p.evaluate(() => document.activeElement?.blur());
      await p.waitForTimeout(500);
      const [title, sub] = CAPTIONS[name];
      await page.setContent(framed(await p.screenshot(), device.canvas, title, sub));
      await page.screenshot({ path: `${dir}/${name}.png` });
      flatten(`${dir}/${name}.png`);
      console.log('captured', `${device.dir}/${name}`);
    };

    // The offices at home, soonest date first.
    await p.goto(SITE, { waitUntil: 'networkidle' });
    await p.locator('ul.rows button.row').first().waitFor();
    await shot('01-offices');

    // The first office's calendar, then the hours of its first open day.
    await p.locator('ul.rows button.row').first().click();
    const day = p.locator('table.calendar-grid button.day.is-open').first();
    await day.waitFor({ timeout: 25000 }).catch(() => {
      throw new Error('the soonest office has no open day to tap: rerun after the next release of dates');
    });
    await p.locator('.office-head').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await p.evaluate(() => scrollBy(0, -16));
    await shot('02-calendar');
    await day.click();
    await p.locator('.times').getByText(/\d:\d\d/).first().waitFor({ timeout: 30000 });
    // The day tapped, still marked on the calendar, above its hours.
    await p.locator('table.calendar-grid button.day.is-selected').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await p.evaluate(() => scrollBy(0, -16));
    await shot('03-hours');

    // The alert form, filled in and not sent.
    await p.getByRole('button', { name: /Email me when dates open here/ }).first().click();
    const sheet = p.getByRole('dialog');
    await sheet.getByLabel('Your email').fill(EMAIL);
    await shot('04-alert');

    // The posts abroad.
    await p.goto(`${SITE}?in=abroad`, { waitUntil: 'networkidle' });
    await p.locator('.country-name').first().waitFor();
    await shot('05-abroad');
  }

  await b.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
