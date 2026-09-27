// Renders ad.html frame by frame (window.renderAt is deterministic), in parallel pages.
// node render.cjs <fps> <dir> [workers]
const { chromium } = require('playwright');
const fs = require('fs');
const fps = Number(process.argv[2] || 30), workers = Number(process.argv[4] || 6);
const dir = require('path').resolve(__dirname, process.argv[3] || 'frames/draft');
const LENGTH = 49.08, total = Math.ceil(LENGTH * fps);
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const t0 = Date.now();
  let next = 0, done = 0;
  const errors = [];
  await Promise.all(Array.from({ length: workers }, async () => {
    const p = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto('file://' + __dirname + '/ad.html');
    await p.evaluate(() => window.ready);
    for (;;) {
      const i = next++;
      if (i >= total) break;
      await p.evaluate((t) => window.renderAt(t), i / fps);
      await p.screenshot({ path: `${dir}/f_${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 95 });
      if (++done % 300 === 0) console.log(`${done}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  }));
  await b.close();
  console.log(`rendered ${total} frames at ${fps} fps in ${((Date.now() - t0) / 1000).toFixed(0)} s; page errors: ${errors.length ? errors.slice(0, 3) : 'none'}`);
})();
