// Screenshots the rendered alert email (assets/email.html) and records where its dates sit
// (assets/email.js), so the ad can highlight them.
const { chromium } = require('playwright');
const fs = require('fs');
const A = __dirname + '/assets';
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 620, height: 900 }, deviceScaleFactor: 3 })).newPage();
  await p.goto('file://' + A + '/email.html');
  const card = p.locator('body > div').first();
  await card.screenshot({ path: A + '/email-card.png' });
  await p.screenshot({ path: A + '/email-full.png', fullPage: true });
  const c = await card.boundingBox();
  const rows = [];
  for (const li of await p.locator('li').all()) rows.push((await li.boundingBox()).y - c.y);
  const mail = { subject: await p.title(), width: c.width, rows };
  fs.writeFileSync(
    A + '/email.js',
    "// Written by email-shot.cjs: the alert email's subject, and where its date rows sit in\n" +
      `// email-card.png, in CSS px of the ${c.width}-wide card.\n` +
      `window.MAIL = ${JSON.stringify(mail, null, 1)};\n`,
  );
  console.log(JSON.stringify(mail));
  await b.close();
})();
