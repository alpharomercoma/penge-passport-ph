# Push notifications verified on Mac Chrome and Mac Firefox

Date: 6 October 2026, branch `push-notifications` at `3616760` (Task 16's local stack, plus the
two fixes the first round found: the pace hint and the off switches; see below).

**Browsers** (as each reported itself; recorded in `results/*.json`): `Chrome/154.0.8037.98` and
`firefox/157.0`, the ones installed on the owner's Mac, each run with a fresh throwaway profile and
driven by `puppeteer-core` 25.12 (Chrome over CDP, Firefox over WebDriver BiDi).

**Stack:** `scripts/local-stack.sh up`: the real API and checker, a throwaway Valkey on
127.0.0.1:6391, captured mail in `.local/mail/`, the fake DFA, the web app built with
`VITE_LOCAL_DEBUG=1`. Pushes went through the real push services (Chrome's subscriptions are on
`fcm.googleapis.com`, Firefox's on `updates.push.services.mozilla.com`, as the endpoints stored in
Valkey show).

**How results were checked:** the harness in `harness/` (run from a scratch directory with
`puppeteer-core` installed; it never installs anything in the repository). Each run uses its own
email addresses (suffixed with the run id) and reads only the mail captured after the action it
checks. A device is checked through its own subscriber's keys in Valkey (the subscriber that the
confirmation created), never a global count. A notification is checked by its new tag, title and
data, read from the service worker (`registration.getNotifications()`); a notification on screen
belongs to macOS and is not in the screenshots. "Nothing arrived" waits 10 seconds. Results, with
each run's id and browser version: `results/chrome-push.json`, `results/firefox-push.json`,
`results/chrome-more.json`, `results/cross.json`.

**Count:** 53 recorded checks: 52 passed, 0 failed, 1 observation (Firefox private browsing).
Not run in a browser: 3 (below), each with the automated test that covers it.

## Push only, in each browser (`push-flow.mjs`, 14 checks each)

| Check | Chrome | Firefox | Screenshot |
| --- | --- | --- | --- |
| A tab is detected as a browser (debug line `context: browser`) | pass | pass | `*-home` |
| The switch reads "Browser notifications", with the app hint | pass | pass | `*-sheet-switches` |
| Permission allowed: push on, email off | pass | pass | `*-sheet-push-only` |
| One confirmation email for the request; it says "Email: off" and "Notifications: on, for the device and browser that asked (Chrome on Mac, …)" / "(Firefox on Mac, …)" | pass | pass | (`.local/mail`, not committed) |
| The confirmation page lists "Email: off" and the notifications line, before its button | pass | pass | `*-confirm-preview` |
| Confirming in that browser registers it: "Notifications are on for this device." | pass | pass | `*-confirmed` |
| Exactly one new subscriber, with one registered device (`r|…`) | pass | pass | |
| The row says "Notifications on this device: On" | pass | pass | `*-row-on` |
| An alert shows one new notification "Dates open at Antipolo", body "… · for 1 person" | pass | pass | |
| Its data names Antipolo, that date and one person (`{ office: 486, date, people: 1 }`): what a tap opens. The tap itself is not run (below). | pass | pass | |
| No alert email for push only within 10 s; the checker counted the push as accepted | pass | pass | |

## More in Chrome (`chrome-more.mjs`, 16 checks)

| Check | Result | Screenshot |
| --- | --- | --- |
| Both channels: one new subscriber with one registered device; one alert gives one email and one notification | pass | `chrome-both-row` |
| Three test notifications are each answered 200, and a "Test notification" is shown (they share a tag, so each replaces the last) | pass | |
| The fourth within the hour is answered 429 with "You can send 3 test notifications an hour. Try again later." | pass | `chrome-test-limit` |
| Turn off: the browser held a credential before; afterwards the subscriber has no device on the server, the credential here is cleared, the row says off | pass | `chrome-turned-off` |
| After turning off, an alert (2 minutes later, past the floor between two alerts) gives no notification here within 10 s, and the email still comes | pass | |
| Turning on again makes a new credential and registers one device for the same subscriber; an alert then shows a notification | pass | |
| Delete my data: before, keys name the subscriber (its hashes, `pp:sub`, credential and endpoint entries); after, none does, and no `pp:reserved:*` holds its id | pass | `chrome-deleted` |
| Email only: no device registered; an alert gives an email and no notification within 10 s | pass | |
| Denied: the sheet says how to allow notifications, without asking | pass | `chrome-denied-hint` |
| Themes: the sheet in light and dark, the row in light (dark rows: every other row screenshot; this Mac is in dark mode) | pass by eye | `chrome-sheet-light`, `chrome-sheet-dark`, `chrome-row-light` |

## Two browsers, and Firefox's refusals (`cross.mjs`, 9 records)

| Check | Result | Screenshot |
| --- | --- | --- |
| Firefox, notifications denied: "Notifications are blocked for this site. Allow them from the padlock…" as the sheet opens | pass | `firefox-denied-hint` |
| A browser that will not subscribe (Firefox with its push connection off): the switch goes back off with "This browser would not turn notifications on (private windows often refuse). Email still works.", and email stays on | pass | `firefox-subscribe-failed` |
| Firefox in private browsing (`browser.privatebrowsing.autostart`) | observation: the switch turned on, so Firefox 157 allowed the subscription; the refusal path is the row above | `firefox-private` |
| Asked in Chrome (its row reading "Waiting for you to confirm by email."), confirmed in Firefox, which says "Notifications are on for the device where you asked for them. Open the app there once to finish." | pass | `chrome-cross-waiting`, `firefox-confirm-elsewhere` |
| Back in Chrome, with no reload, the row turns On by its own poll within 30 s, timed from the press in Firefox (28.7 s) | pass | `chrome-cross-on` |
| An alert reaches Chrome | pass | |
| Firefox then turns push on for the same address: one subscriber has two registered devices | pass | |
| A test sent from Chrome is accepted, reaches Chrome, and nothing reaches Firefox (the same subscriber's other device) within 10 s | pass | |

## Not run in a browser

| Plan item | Why | Covered by |
| --- | --- | --- |
| Permission dismissed (the switch stays off, no hint) | A browser's own permission prompt cannot be dismissed under automation | `apps/web/test/sheet.test.tsx`, "turns email back on when push fails to come on and email was off" (a dismissed answer) |
| Tapping the notification | It is a macOS notification, outside the browser | `apps/web/test/pwa.test.ts`, "navigates an open window to the office instead of opening another", and the notification data checked above |
| Old worker: a worker from the release before push, replaced within 10 s | Needs serving two releases on one port in turn | `apps/web/test/notify.test.ts`, "waits for the new worker when the real old one (from the last release) is active": the old worker is the real `sw.js` from `157bad9` and the new one the plugin's build of today's `sw.js`; the browser's update and `controllerchange` are simulated. Weaker than the browser run the plan asks for. |

## Found and fixed along the way

- The pace hint said "One email with everything new…" with email off: it now says "notification"
  (commit `3616760`, with a test).
- An off switch was hard to tell from the page in both themes: it is now outlined, with a grey knob.
- Under remote control Firefox turns its push connection off; the harness sets
  `dom.push.connection.enabled` and `dom.push.serverURL` back to Firefox's defaults (a person's
  Firefox has them on), except in the refusal check, which turns the connection off on purpose.
- The form's default pace is "at most once an hour" and "as soon as possible" keeps 2 minutes
  between two alerts to one person: the harness picks "as soon as possible" and waits 2 minutes
  where it sends a person a second alert.

Left as they are: the entry button still reads "Email alerts" (the owner placed the toggles in the
email alert form), and the sheet's sticky title lets a sliver of scrolled content show above it
(styles from before this work; noted for later).
