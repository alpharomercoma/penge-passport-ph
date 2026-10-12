# Alerts redesign: the Mac verification record

**Date:** 13 October 2026. **Where:** this Mac, against the local stack (`scripts/local-stack.sh up`: the real API and
checker, a throwaway Valkey marked disposable, captured mail, a fake DFA, no R2). Pushes went through the real push
services (Chrome's on `fcm.googleapis.com`, Firefox's on `updates.push.services.mozilla.com`).
**Browsers:** Chrome 154.0.8037.99 and Firefox 157.0.1, driven headless by `puppeteer-core` 25.12 with throwaway
profiles (`docs/superpowers/verification/harness/`, how to run it in `apps/server/dev/README.md`).
**Code:** commit `bba25cc` (Task 20); nothing the browsers exercise changed after it.

Results, each with its run's browser version: `results/device-flow-chrome.json`, `results/device-flow-firefox.json`
(27 checks each), `results/old-pages.json`, `results/old-pages-firefox.json` (21 each), `results/old-worker.json` (6),
`results/cross.json` (7, and one observation), `results/audit.json` (31 states, 0 findings), `results/rollback.json`
(9 steps). Screenshots of the flows are in `img/` (`chrome-device-*.png`, `firefox-device-*.png`,
`firefox-*.png`, `old-worker-*.png`); the audit's go outside the repository (`AUDIT_OUT`, reviewed by eye).

## The spec's Verification step 2, item by item

| Item | Chrome | Firefox | Where |
|---|---|---|---|
| Notifications only (no email asked; the server holds no email for it; the row says what is on and until when) | PASS | PASS | device-flow 1; `*-device-on.png` |
| Email only (no notification alert made; an alert email and no notification within 10 s) | PASS | PASS | device-flow 8b |
| Both (one opening gives one alert email and one notification) | PASS | PASS | device-flow 7 |
| One failing: email refused, notifications on, a retry for email only; then email sent | PASS | PASS | device-flow 7 |
| One failing: notifications refused, email sent, both results together, a retry for notifications only | PASS | PASS | device-flow 7b |
| Denied (the switch stays off, with the "blocked for this site" hint) | PASS | PASS | device-flow 10; cross (Firefox's padlock hint) |
| Dismissed (asked once; the switch stays off, no hint, Email untouched) | PASS | PASS | device-flow 9 |
| The ready check (its notification shown before the alert starts) | PASS | PASS | device-flow 1 |
| Change (no switches, no email; after a reload the row says 2 people; the next opening's notification is for 2 people and opens that office, date and group) | PASS | PASS | device-flow 3 |
| Test (accepted; the test notification arrives; reaches only the browser that sent it) | PASS | PASS | device-flow 3; cross |
| Tap | — | — | See below |
| Turn off online (nothing left on the server; no browser subscription) | PASS | PASS | device-flow 4 |
| Turn off offline (unsubscribed before reconnecting; the deletion remembered across a reopen; done once back online) | PASS | PASS | device-flow 5; `*-device-off-pending.png` |
| Blocked while on (the row says it was turned off; the server holds nothing) | PASS | PASS | device-flow 11 |
| Ended, the clock moved (the row says so, with its date) | PASS | PASS | device-flow 6; `*-device-ended.png` |
| Delete this device's data (nothing on the server, no subscription, no row; the email alert stays) | PASS | PASS | device-flow 8 |
| An open `05cee09` page (and `157bad9`): email sign-up works; notifications are told to reload; resumed old tabs; one origin with today's worker, including an empty old database; today's worker reloads an open old tab; a refused signup's old credential retired before setup | PASS | PASS | old-pages |
| The upgrade from the release before push (its worker replaced after one reload; notifications on within 60 s; an alert delivered) | PASS | — | old-worker |
| Rollback and forward (both older releases start with the new configuration; their checkers run against the new data; email continues; device clean-up; roll forward) | PASS | | rollback.json |
| The layout audit, 320 to 1280 px, light and dark, every new state (each state's words and actions asserted) | PASS (31 states, 0 findings) | | audit |

**Tap.** A notification on screen belongs to macOS, and no browser automation can click it. What a tap opens is
covered by: the notification's data checked in the real flow (office, date and group size, device-flow 3); the
worker's `notificationclick` handler, unit-tested against a fake `self` (`apps/web/test/pwa.test.ts`: the office, date and group opened, and malformed data refused); and the
owner's phone check (Task 23), which taps real notifications.

**Seen, not judged:** Firefox in private browsing set notifications up (`cross.json`).

## Found by these runs, and fixed (each with a test written first)

| What | Fix | Commit |
|---|---|---|
| The alerts form reset its results whenever the page re-rendered (every 30 s), losing failures and their retries | `AlertSheet` keys the reset on the offices' value, not the array | `bba25cc` |
| The service worker's first activation reloaded first visits too (pages it had just claimed), interrupting the form or a setup | Pages listed before `clients.claim()` | `bba25cc` |
| After a successful setup the row could stay empty (the worker stored the alert first; the page's fenced write lost) | The row shows the known alert once success is confirmed, fenced on the operation still current | `bba25cc` |
| Old pages: Chromium's (and Firefox's) `unsubscribe()` acts on the registration, so a tab frozen with its request in flight also removes the new subscription | Expectation corrected: the spec's accepted remaining case (the alert ends as gone; the row asks to set up again) | `bba25cc` |
