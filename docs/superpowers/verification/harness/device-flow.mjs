// node device-flow.mjs chrome|firefox — a notification alert on the Mac, end to end, against the local stack.
import { mkdirSync, writeFileSync } from 'node:fs';
import { clickText, devOpen, emailSwitch, IMG, launch, linkIn, mailMark, newNotes, notifyOnly, openSheet, ORIGIN, pickOffice, publishedDay, pushSwitch, REPO, resetRateLimits, rowText, scan, send, shot, shown, signUpAndConfirm, sleep, SITE, valkey, waitMail, waitText, workerReady } from './lib.mjs';

const kind = process.argv[2];
const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};
mkdirSync(IMG, { recursive: true });
resetRateLimits();
const browser = await launch(kind, { prefs: { 'permissions.default.desktop-notification': 1 } });
if (kind === 'chrome') await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
const page = await browser.newPage();
// What the store held before this browser's flow: another browser's run (or case 7, which leaves a confirmed email
// subscriber for the rollback rehearsal) may have left email subscribers; notifications must never add or change one.
const subsBefore = scan('pp:sub:*').sort().join(',');
const credsBefore = scan('pp:dev:cred:*').length;
// Keys an earlier run left (an alert whose profile is gone stays until it ends) are not this run's.
const atStart = new Set([...scan('pp:dev:cred:*'), ...scan('pp:dev:op:*'), ...scan('pp:dev:endpoint:*')]);
const ours = (pattern) => scan(pattern).filter((k) => !atStart.has(k));
/** This browser's alert id on the server (its credential's), or null. */
const myAlert = () => {
  const cred = ours('pp:dev:cred:*')[0];
  return cred ? valkey('GET', cred) : null;
};
/** This browser's subscription endpoint, or null. */
const endpointOf = (p) => p.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null);
/**
 * Every record of the alert is gone (its hash, credential, endpoint index, office membership and end index), and its
 * delivery keys are queued for clean-up or already cleaned.
 */
const alertGone = (id) =>
  !!id &&
  valkey('EXISTS', `pp:dev:${id}`) === '0' &&
  valkey('ZSCORE', 'pp:dev:ends', id) === '' &&
  !valkey('SMEMBERS', 'pp:dev:site:486').split('\n').some((m) => m.startsWith(`${id}:`)) &&
  ours('pp:dev:cred:*').length === 0 &&
  ours('pp:dev:endpoint:*').length === 0 &&
  (valkey('HEXISTS', 'pp:dev:garbage', id) === '1' || ['last', 'tried', 'held'].every((k) => valkey('EXISTS', `pp:dev:${k}:${id}`) === '0'));
try {
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await workerReady(page);
  // 1. Notifications only: no email asked, the ready check, the row.
  // Notifications only, as sent: no email field, and Email off.
  // The setup notifications come and go (the last closes itself while the page is in view): watched throughout.
  const setupSeen = new Set();
  let watching = true;
  const watch = (async () => {
    while (watching) {
      for (const n of await shown(page).catch(() => [])) if (n.tag?.startsWith('setup-')) setupSeen.add(n.title);
      await sleep(200);
    }
  })();
  let lingering = true;
  // Stopped whatever happens, so a failed setup never leaves it polling a closed browser.
  try {
    await notifyOnly(page, {
      beforePress: async () =>
        record('No email was asked for', !(await page.$('[role="dialog"] input[type="email"]')) && (await (await emailSwitch(page)).evaluate((e) => e.getAttribute('aria-checked'))) === 'false'),
    });
    await shot(page, `${kind}-device-on`);
    for (let i = 0; i < 50 && !setupSeen.has('Notifications are on'); i++) await sleep(200);
    // ("Turning on notifications" comes first, but locally the check takes milliseconds: too short to observe here; the
    // worker's tests pin its words.)
    record('The ready check showed its notification', setupSeen.has('Notifications are on'), JSON.stringify([...setupSeen]));
    // The page in view says so itself: the notification goes a few seconds later.
    for (let i = 0; i < 50 && lingering; i++) {
      await sleep(200);
      lingering = (await shown(page)).some((n) => n.tag?.startsWith('setup-') && n.title === 'Notifications are on');
    }
  } finally {
    watching = false;
    await watch;
  }
  record('The "on" notification closed itself while the page was in view', !lingering);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  const row = await rowText(page);
  record('The row says what is on and until when', /^Notifications on this device: Antipolo · for 1 person · as soon as possible · until \d+ \w{3} \d{4}/.test(row ?? ''), row ?? '');
  record('The server holds no email for it', scan('pp:sub:*').sort().join(',') === subsBefore && scan('pp:dev:cred:*').length === credsBefore + 1);
  // 2. A real alert.
  const day = publishedDay(4);
  await devOpen(486, day);
  const alertedAt = Date.now();
  await sleep(3000);
  const alert = (await shown(page)).find((n) => n.tag?.startsWith('alert-'));
  record('An opening arrives as a notification, with when it was checked', !!alert && alert.title === 'Dates open at Antipolo' && / · Checked \d\d:\d\d$/.test(alert.body), JSON.stringify(alert ?? null));
  // 3. Change, test.
  await clickText(page, '.device-row button', 'Change');
  await page.waitForSelector('[role="dialog"]');
  record('Change has no switches and no email field', (await page.$$('[role="dialog"] [role="switch"]')).length === 0 && !(await page.$('[role="dialog"] input[type="email"]')));
  await page.select('select[id$="-applicants"]', '2');
  await clickText(page, 'button[type="submit"]', 'Save');
  await waitText(page, 'Saved.');
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitText(page, 'for 2 people');
  record('Changed: after a reload the row says 2 people', /· for 2 people ·/.test((await rowText(page)) ?? ''), (await rowText(page)) ?? '');
  const beforeChanged = await shown(page);
  // "As soon as possible" is at most one notification every 2 minutes: the next opening waits that out.
  await sleep(Math.max(0, 125_000 - (Date.now() - alertedAt)));
  await devOpen(486, publishedDay(7));
  const changed = await newNotes(page, beforeChanged);
  const c0 = changed[0];
  // The text, and what a tap opens (the worker builds its address from the data: office, date and group size).
  record(
    "Changed: the next opening's notification is for 2 people, and opens that office, date and group",
    changed.length === 1 && / · for 2 people · /.test(c0.body) && c0.data?.office === 486 && c0.data?.date === publishedDay(7) && c0.data?.people === 2,
    JSON.stringify(changed.map((n) => ({ body: n.body, data: n.data }))),
  );
  await clickText(page, '.device-row button', 'Send a test');
  await waitText(page, 'Accepted by the push service. Check this device.');
  await sleep(2000);
  record('The test notification arrived', (await shown(page)).some((n) => n.title === 'Test notification'));
  // 4. Turn off, online.
  const id4 = myAlert();
  await clickText(page, '.device-row button', 'Turn off');
  await sleep(1500);
  record('Turned off: nothing left on the server', alertGone(id4) && ours('pp:dev:op:*').length === 0, String(id4));
  record('Turned off: the browser has no subscription', await page.evaluate(async () => !(await (await navigator.serviceWorker.ready).pushManager.getSubscription())));
  // 5. Turn off offline, then back online.
  await notifyOnly(page);
  const id5 = myAlert();
  await page.setOfflineMode(true);
  await clickText(page, '.device-row button', 'Turn off');
  await waitText(page, "Deleting them from our server when you're back online.");
  await shot(page, `${kind}-device-off-pending`);
  record('Offline: the browser unsubscribed before reconnecting, and the server still holds the alert', (await endpointOf(page)) === null && valkey('EXISTS', `pp:dev:${id5}`) === '1');
  // Still offline, the page reopened (the stored app; without the server it shows no row): the deletion still waits in
  // this device's state.
  await page.reload({ waitUntil: 'networkidle0' }).catch(() => undefined);
  const kept = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('pengepassportph-device-alerts', 1);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const get = req.result.transaction('state').objectStore('state').get('device');
          get.onsuccess = () => (req.result.close(), resolve({ credential: get.result?.credential ?? null, retired: get.result?.retired?.length ?? 0 }));
        };
      }),
  );
  record('Offline, reopened: the pending deletion is remembered', kept?.credential === null && kept.retired > 0, JSON.stringify(kept));
  await page.setOfflineMode(false);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);
  record('Back online: the deletion went through', alertGone(id5), (await rowText(page)) ?? '');
  // 6. Ended (the server's clock moved): the row says so.
  await notifyOnly(page);
  const id = ours('pp:dev:cred:*')[0];
  const alertId = valkey('GET', id);
  valkey('HSET', `pp:dev:${alertId}`, 'end', String(Date.now() - 1000));
  valkey('ZADD', 'pp:dev:ends', String(Date.now() - 1000), alertId);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitText(page, 'Turn them on again to keep getting them.');
  await shot(page, `${kind}-device-ended`);
  record('An ended alert says so, with its date', /ended on \d+ \w{3} \d{4}/.test((await rowText(page)) ?? ''));
  const checked = (el) => el.evaluate((e) => e.getAttribute('aria-checked') === 'true');
  const dev = (path) => fetch(`http://127.0.0.1:8787/dev/${path}`, { method: 'POST' });
  // 7. Both kinds, one failing: the mail server refuses; notifications still turn on, and only email offers a retry.
  resetRateLimits();
  await dev('mail-fail');
  await openSheet(page);
  await pickOffice(page);
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 10_000 }, await pushSwitch(page));
  const both = `both-${Date.now()}@example.com`;
  await send(page, both);
  // Each kind's result on its own: notifications on, and email's failure with its retry.
  await waitText(page, 'Notifications are on for this device.', 60_000);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Try email again'), { timeout: 30_000 });
  const retries = await page.$$eval('[role="dialog"] button', (bs) => bs.map((b) => b.textContent));
  record('Both on, email refused: notifications on, and a retry for email only', retries.includes('Try email again') && !retries.includes('Try notifications again'), JSON.stringify(retries));
  await dev('mail-ok');
  const mark = mailMark();
  await clickText(page, '[role="dialog"] button', 'Try email again');
  await waitText(page, 'Check your inbox for a link to start email alerts.');
  const confirmMail = await waitMail(mark, 'confirm', both).catch(() => null);
  record('Email again, after the mail server is back: a confirmation email with its link was sent', !!confirmMail && linkIn(confirmMail.text, '/confirm').includes('/confirm'), confirmMail ? 'captured' : 'no mail');
  // Confirmed, so a real email subscriber follows Antipolo (the rollback rehearsal, Step 6, emails it).
  await page.keyboard.press('Escape');
  await page.goto(linkIn(confirmMail.text, '/confirm'), { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Confirm email alert');
  await waitText(page, 'We will email you');
  writeFileSync(`${REPO}/.local/email-subscriber.txt`, both); // for Step 6
  record('The email alert is confirmed', true, both);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  // Both on and working: one opening gives one email and one notification.
  const bothMark = mailMark();
  const beforeBoth = await shown(page);
  await devOpen(486, publishedDay(8));
  const bothNote = await newNotes(page, beforeBoth);
  const bothMail = await waitMail(bothMark, 'alert', both).catch(() => null);
  record('Both on: one opening gives one alert email and one notification', !!bothMail && bothNote.length === 1 && bothNote[0].title === 'Dates open at Antipolo', JSON.stringify({ mail: !!bothMail, notes: bothNote.map((n) => n.title) }));
  // 7b. Both on, the other way round: email goes out; the notification setup is refused (the setup request answered
  // "full", as the server does at its limit); only notifications offer a retry, if any.
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  const refuse = (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/device-alerts')) return void req.respond({ status: 200, contentType: 'application/json', body: '{"outcome":"full","operation":null}' });
    return void req.continue();
  };
  // This device's alert is turned off first: a device with one on would be setting up again.
  await clickText(page, '.device-row button', 'Turn off');
  await sleep(1500);
  resetRateLimits();
  await page.setRequestInterception(true);
  page.on('request', refuse);
  try {
    await openSheet(page);
    await pickOffice(page);
    await (await pushSwitch(page)).evaluate((e) => e.click());
    await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 10_000 }, await pushSwitch(page));
    const other = `email-ok-${Date.now()}@example.com`;
    const otherMark = mailMark();
    await send(page, other);
    await waitText(page, 'Check your inbox for a link to start email alerts.', 30_000);
    await waitText(page, 'Notifications are full right now. Email alerts still work.', 60_000);
    const mailOk = await waitMail(otherMark, 'confirm', other).catch(() => null);
    // Both results at once, and the retry only for notifications.
    const shownB = await page.$eval('[role="dialog"]', (d) => d.textContent ?? '');
    const bothShown = shownB.includes('Check your inbox for a link to start email alerts.') && shownB.includes('Notifications are full right now. Email alerts still work.');
    const retriesB = await page.$$eval('[role="dialog"] button', (bs) => bs.map((b) => b.textContent));
    record(
      'Both on, notifications refused: the confirmation email goes out, both results show together, and only notifications offer a retry',
      !!mailOk && bothShown && retriesB.includes('Try notifications again') && !retriesB.includes('Try email again'),
      JSON.stringify({ mail: !!mailOk, bothShown, retries: retriesB.filter((t) => /^Try/.test(t ?? '')) }),
    );
  } finally {
    page.off('request', refuse);
    await page.setRequestInterception(false);
  }
  await page.keyboard.press('Escape');
  // Notifications on again, for the deletion below.
  resetRateLimits();
  await notifyOnly(page);
  // 8. Delete this device's data: the device's alert and subscription go; the email alert stays.
  const id8 = myAlert();
  const subsBeforeDelete = scan('pp:sub:*').sort().join(',');
  await page.goto(`${SITE}delete-data`, { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Turn off notifications on this device');
  await sleep(1500);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  record("Delete this device's data: nothing left on the server, no subscription, and no row", alertGone(id8) && (await endpointOf(page)) === null && (await rowText(page)) === null, (await rowText(page)) ?? '');
  record("Delete this device's data: the email alert stays", scan('pp:sub:*').sort().join(',') === subsBeforeDelete);
  // 8b. Email only (this device has no notification alert now): an email, and no notification.
  resetRateLimits();
  const emailOnly = `email-only-${Date.now()}@example.com`;
  await signUpAndConfirm(page, emailOnly);
  record('Email only: no notification alert was made', ours('pp:dev:cred:*').length === 0);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  const onlyMark = mailMark();
  const beforeOnly = await shown(page);
  await devOpen(486, publishedDay(3));
  const onlyMail = await waitMail(onlyMark, 'alert', emailOnly).catch(() => null);
  const onlyNotes = await newNotes(page, beforeOnly, 10_000);
  record('Email only: an alert email, and no notification within 10 s', !!onlyMail && onlyNotes.length === 0, JSON.stringify({ mail: !!onlyMail, notes: onlyNotes.length }));
  // 9. Dismissed: the prompt answers 'default' (as a dismissed prompt does); the switch stays off, no hint, Email untouched.
  const dismissed = await browser.newPage();
  await dismissed.evaluateOnNewDocument(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    window.__asked = 0;
    Notification.requestPermission = async () => (window.__asked++, 'default');
  });
  await dismissed.goto(SITE, { waitUntil: 'networkidle0' });
  await openSheet(dismissed);
  await (await pushSwitch(dismissed)).evaluate((e) => e.click());
  await sleep(1000);
  const dismissedText = await dismissed.$eval('[role="dialog"]', (d) => d.textContent ?? '');
  const asked = await dismissed.evaluate(() => window.__asked);
  record('Dismissed: asked once; the switch stays off, no hint, Email untouched', asked === 1 && !(await checked(await pushSwitch(dismissed))) && !(await checked(await emailSwitch(dismissed))) && !/blocked for this site/.test(dismissedText), `asked ${asked}`);
  await dismissed.close();
  // 10. Denied: a profile where notifications are denied; the switch stays off, with the hint.
  const deniedBrowser = kind === 'firefox' ? await launch(kind, { prefs: { 'permissions.default.desktop-notification': 2 } }) : null;
  const deniedCtx = deniedBrowser ? deniedBrowser.defaultBrowserContext() : await (browser.createBrowserContext?.() ?? browser.createIncognitoBrowserContext());
  if (!deniedBrowser) await deniedCtx.overridePermissions(ORIGIN, []); // every permission not listed is denied
  const denied = await deniedCtx.newPage();
  await denied.goto(SITE, { waitUntil: 'networkidle0' });
  await openSheet(denied);
  await (await pushSwitch(denied)).evaluate((e) => e.click());
  await sleep(1000);
  const deniedText = await denied.$eval('[role="dialog"]', (d) => d.textContent ?? '');
  record('Denied: the switch stays off, with the "blocked for this site" hint', !(await checked(await pushSwitch(denied))) && /blocked for this site/.test(deniedText), deniedText.slice(0, 200));
  await (deniedBrowser ?? deniedCtx).close();
  // 11. Blocked while an alert is on (in both browsers: Puppeteer revokes a granted permission in Firefox too, through
  // WebDriver BiDi): turned off, and said.
  resetRateLimits();
  await notifyOnly(page);
  await browser.defaultBrowserContext().overridePermissions(ORIGIN, []);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitText(page, 'Notifications are blocked on this device, so we turned them off.');
  await sleep(1500);
  record('Blocked while on: the row says it was turned off, and the server holds nothing', ours('pp:dev:cred:*').length === 0 && ours('pp:dev:endpoint:*').length === 0);
} catch (err) {
  record('The flow ran to the end', false, String(err?.stack ?? err));
  await shot(page, `${kind}-device-error`).catch(() => {});
} finally {
  writeFileSync(`${REPO}/docs/superpowers/verification/results/device-flow-${kind}.json`, JSON.stringify({ browser: await browser.version(), results }, null, 2));
  await browser.close();
}
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
