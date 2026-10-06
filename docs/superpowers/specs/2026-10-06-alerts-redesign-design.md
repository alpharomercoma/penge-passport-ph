# Alerts redesign: email and notifications as separate alerts

Status: draft 17 for the owner's review (6 October 2026), after sixteen adversarial passes by Codex (gpt-6.1-sol, medium):
32, 32, 35, 27, 19, 20, 18, 15, 13, 9, 7, 5, 4, 3, 2 and 1 findings, all taken. Drafts 4, 5 and 7 also **simplify** where patches were multiplying (dispositions at the end).
It **replaces** the channel design in `2026-10-05-push-notifications-design.md` (notifications as a second channel of an
email subscription), which the owner rejected after seeing it in owner mode. Nothing here is built yet.

## What the owner decided

- Email alerts and notifications are **different things**. Notifications must not depend on email.
- A notification alert needs **no email address at all**. The permission prompt is the consent; the alert belongs to that
  browser or app and is managed from it.
- **One alerts form**: channel switches first; the email field only when Email is on. Email is confirmed by a link before it
  sends anything; notifications start once the device is set up.
- Delivery of notifications: **Web Push**, not polling.
- An automatic **ready check**: the alert switches on only after this device has shown a setup notification and proved it to
  the server.
- A notification alert lasts **180 days from setup or from the last time the site or app was opened on that device**. The
  device row shows the end date.
- Process: Codex reviews the spec, plan and every diff; tests first; verified on the Mac (Chrome, Firefox) and on the owner's
  phone before production; backups first; no user data lost.

## Why push and not polling

A notification has to arrive when the app is closed. The page can ask for news only while it is open, and the web has no
general background polling: Chrome's Periodic Background Sync works only for an installed app, at most about every 12 hours
at the browser's discretion, and can stop entirely.

Web Push is made for this: the server encrypts a message and hands it to the browser maker's push service (Google for Chrome
and the Android app, Mozilla for Firefox, Apple for Safari), which wakes the service worker to show it, even with the app
closed. It is already built (`push/sender.ts`, `push/payload.ts`, `sw.js`). The push service **accepting** a message proves
less than the person seeing it; this document says "accepted", never "delivered". A notification's `TTL` only limits how long
the push service keeps it (alerts and tests 30 minutes, setup pushes 5 minutes). Dates can close at any time, so every alert
says when they were checked ("Checked 10:42"), and tapping it opens the office page, which shows live availability. The open
page keeps polling `/api/status` every minute to refresh what it shows.

## Two kinds of alert behind one form

| | Email alert | Notification alert |
|---|---|---|
| Identity | The confirmed address (`pp:sub:<id>`, unchanged) | A random alert id, owned by a secret credential kept in this browser |
| Starts | After the emailed link is pressed | After the ready check, a few seconds |
| Choices | Offices, group size, how often | The same three, kept separately |
| Changed by | Signing up again with the same address (confirmed again), as today | "Change" on this device's row, at once |
| Stopped by | The unsubscribe link in any alert, or "delete my data" | "Turn off" on this device's row, or the end of its 180 days |
| In backups | Yes, as today | No |

The form's switches choose **which alerts this submission creates**. With both on, one submit creates two independent alerts
from the same snapshot of choices. From then on neither affects the other: changing, stopping or losing one never touches the
other; delivery, pace, daily caps, retries and failures are separate. Where both are on, the form says: "These choices apply to
both now. Afterwards, change notifications on this device and email through its links." There is no "all my alerts" view:
without an address in common the server cannot know two alerts belong to one person.

Everything that tied a device to an email subscriber goes: binding, reservations, provisional devices, pending channel
requests, revoked markers, channel acknowledgement, channel lines in the confirmation email, `emailOn`/`pushOn`, the "waiting
for you to confirm" device state and `push-downgrade`.

## Email alerts: as before push

Email alerts work exactly as before the push work (release `157bad9`): address, confirmation link, one-click unsubscribe,
"delete my data", pace, the per-person daily cap (with its handling of held work at the cap), the daily email limit, held
alerts, the outbox, and the 3-hour window with its existing reboot handling. The 57 people subscribed today keep their ids,
offices, group size, pace and links and confirm nothing again. Only the form and wording change: the confirmation email and
page lose their channel lines; the pace hint says "email".

**Pages already open from the channel release (`05cee09`)** keep working for email, against the exact answers of that
release's contracts:

- `/api/confirm/preview` answers an email-only pending request with `channels: null` (that release's contract for "a request
  from before channels: email, as always").
- `/api/confirm` accepts that page's acknowledgement and answers `channels: { emailOn: true, pushOn: false, push: "none" }`.
- A request from such a page that asks for notifications (email off, or push on) is refused **before anything is written**:
  "This page is out of date. Reload it." The old `/api/push/*` routes answer `410` with the same message.
- Tested by loading the real `05cee09` and `157bad9` bundles against the new server: preview, confirmation and the rendering
  of both answers.

## Where the app runs, and what it can do

Kept from the previous design (`notify/context.ts`): the **context** (`play` for the Android app; `installed`; `browser`)
chooses wording; the **capability** (secure context, a registered service worker, `PushManager`, `Notification`, push offered
by the server) decides whether the notifications switch is shown; an iPhone or iPad Safari **tab** is treated as unable
whatever its APIs say.

"This device" means this browser's storage for the site: on Android, the app and Chrome tabs of the same site share it; another
browser or profile is another device; an iPhone Home Screen app has its own storage.

## The form

`AlertSheet` becomes the alerts form, opened from an **"Alerts"** button on the home page and an **"Alert me when dates open
here"** button on an office's page. Order: the channel switches; the email field (only with Email on, with its note on how the
address is kept); offices; group size; how often; the button.

- **Email**: off by default.
- **Notifications**: "Notifications on this device" in the app or an installed web app, "Browser notifications" in a tab; off
  by default. Not shown where not capable: an iPhone tab says "To get notifications on iPhone, add this site to your Home
  Screen, then open it from there."; other browsers say "This browser can't show notifications."
- Turning Notifications on asks for permission inside the tap. Denied: back off, with how to allow notifications (per browser,
  and for the app). Dismissed: back off. **Email is never switched on by itself.** Neither on: cannot send.
- The button says what will happen: "Turn on notifications", "Send confirmation email", or "Turn on notifications and send
  confirmation email".
- On submit the form takes a **snapshot** of the choices. With both on, the two requests run independently from it. The form
  shows each result ("Notifications are on for this device." / "Check your inbox for a link to start email alerts.") and offers
  a retry for only the one that failed, with the same snapshot; changing the choices makes a new submission. When Email is off,
  no address is sent.
- The pace hint names the channel: "One notification…", "One email…", or both.
- Opened from **Change** on the device row, the form edits only this device's alert: no switches, no email field; its button is
  "Save". Stopping is always the row's **Turn off**.

## Notification alerts on a device

### Browser state

A new IndexedDB database, `pengepassportph-device-alerts` (version 1), separate from the channel release's `pengepassportph-push`,
so pages of older releases never read or clear it. It holds:

- The **credential**: 32 random bytes; the server stores only its SHA-256 hash. It authorizes everything about this device's alert
  and travels only in the `Authorization: Device <base64url>` header, never in a URL, body or log.
- A **sequence** counter, increased for every new operation.
- The **operation in progress**, at most one: `{ op (16 random bytes), seq, epoch, kind: setup | change | rotate, phase, choices,
  captured alert, canonical subscription?, fingerprint?, nonce?, the server's expiry once known, result? }`. Its **phase** is
  `preparing` (stored before the browser is asked for a subscription; no subscription yet), `ready` (the subscription and the exact
  request stored; it can be sent), or `sent`. Whoever finds it (another tab, the worker, the page after a reload) carries it on from its
  phase: a `ready` or `sent` operation by sending the identical request again; a `preparing` one, if no page holds the driver lock and
  it is more than 10 s old, by asking the browser for the subscription itself (permission still `granted`, same epoch) and storing
  it, or by abandoning it if it cannot. "The identical operation", for joining, means the same kind, choices and captured alert.
- **Needs rotation**: set by `pushsubscriptionchange` or by a reconcile that finds the browser's subscription differs from the
  server's; cleared when a rotation for the current subscription succeeds.
- **Unsubscribe claim**, at most one: `{ task, fingerprint }`, written before calling `unsubscribe()`.
- **Retired credentials**, each with the fingerprint of the subscription it used and whether that subscription is unsubscribed yet.
- The server's VAPID public key, to subscribe again when the browser drops a subscription.
- The last known state and the time of the last confirmed renewal.
- An **epoch**, increased by every turn-off. Every operation, and every automatic re-subscription, records the epoch it started in.

**One operation at a time, never cancelled.** While an operation is in progress (until it has a result, or 30 seconds after the
server's expiry for it; or 2 minutes after it was made if the server never answered and repeats keep failing), this device starts no
other. A request for the **identical** operation (same kind and request) from another tab or a second press joins it and waits for
its result. A different one (other choices, or another kind) shows the running operation's progress and starts only after it ends
and the device has reconciled; a submission reports success only when its own request was applied. After any operation ends, the device reconciles its
subscription with the server's. If **needs rotation** is set: with an active alert, it starts a rotation; with none (a first setup
whose subscription changed before it finished), it starts a fresh setup with the saved choices and the current subscription, if
permission is still `granted`, else the row asks the person to turn notifications on again.
Only **Turn off** interrupts, and it does so by retiring the credential, not by cancelling the operation (below). So a delayed
request or acknowledgement can never act against a newer operation of the same credential.

Every change to this state happens under a Web Lock named `pengepassportph-device-alerts` (not the channel release's lock, which
an old tab can hold for a long time), shared by page and worker, as one short read-check-write; the lock is never
held across a network call or a wait for a push, and anything learned from the network is written only if the operation and the
credential it belongs to are still current (checked again under the lock). The old `pengepassportph-push` database is deleted by the
new page once it has checked it holds no credential.

**Old pages and the shared subscription.** Pages of the channel release share the service worker registration, so they could touch
the browser's subscription; their code does so only when their own database holds a channel-design credential, which that release
made locally whenever someone turned its switch on (anyone could, by opening `?push=owner`, even if the server then refused them).
So, on every browser:

- When the new service worker activates for the first time, it reloads every page it controls (`WindowClient.navigate` to its own
  address), so open old pages become new pages.
- A new page that finds a credential in the old database **retires the legacy state before any setup**: under the new lock it writes
  an unsubscribe claim for the browser's current subscription (unless an operation or alert of the new design uses it), unsubscribes
  it, deletes the old database, and only then lets a setup start (which makes a fresh subscription). If any of this fails, setup does
  not start and the row says "Close other tabs of this site and reopen it to set up notifications."
- What remains: an old tab that was frozen through the reload and resumed later, holding a `missing` answer from before the
  deploy, could still unsubscribe the browser's subscription (at once if its old device was confirmed, after 48 hours otherwise). The push service then answers `410`, the alert is deleted, and the row asks the
  person to set up again. This is accepted and stated in the runbook.

Tests: a real `05cee09` page with a local credential from a refused, non-owner signup; pages suspended around a `missing` answer
with `confirmed` true (resumed at once) and false (resumed after 48 hours), beside a new setup, showing the outcome is "set up again"
and nothing worse; and one with an empty database beside a new setup.

### Setting up, with the ready check

1. The person turns Notifications on and presses the button. The page has permission and the active service worker, which must
   announce `deviceAlerts: 1` in the capabilities handshake; an older worker is updated first, or setup stops with the reason. The
   subscription (`userVisibleOnly`, the server's VAPID key) is asked for in step 2.
2. **Before** asking the browser for a subscription, under the lock: if an operation is in progress, the page joins it (or waits, if
   different). Otherwise the credential is reused or made and a new operation is stored with the current **epoch** (`seq` + 1, `kind:
   setup`, the choices, and the captured alert if this device already has one). Then the page asks the browser for the subscription;
   when that returns, under the lock, the operation must still be in progress and the epoch unchanged, or the operation is abandoned
   and nothing else happens. A subscription the abandoned operation created is removed (through an unsubscribe claim, below) **only
   if**, under the lock, no operation in progress and no alert the device knows uses that fingerprint; otherwise it is left to whoever
   adopted it. Then the fingerprint is recorded in the
   operation. The page then asks the worker to read them back; if it cannot (other storage, IndexedDB failing), the operation
   is dropped and setup stops: "This browser can't finish setting up notifications."
3. `POST /api/device-alerts` with the credential header and `{ op, seq, subscription, choices, captured? }`. The server, in one
   atomic step and in this order:
   1. The request gates (below); a refused request writes nothing.
   2. **A repeat**: the credential's current or last operation is this `op`. If the request's digest (SHA-256 of kind,
      subscription, choices and captured alert) matches, it answers that operation's state or result and changes nothing;
      otherwise `invalid`.
   3. **Too old**: `seq` not higher than the highest this credential has used: `invalid`. The highest `seq` is kept in the alert's
      record for as long as the credential owns an alert, and in the operation record otherwise (a credential with neither has nothing
      left to protect); changes and rotations are checked against it too. **Busy**: the credential has another
      unfinished operation; if it is past its expiry, it is ended as `expired` here (result recorded, reservation released) and
      admission goes on; otherwise `busy` (the page waits for it).
   4. **Mode**: admitted only if its push can be sent now (the mode allows it, with the owner token in owner mode for a new
      alert; push is not paused; its push service is not in backoff); otherwise `unavailable` (or `off`, `owner-only`) and nothing
      is stored. Then the endpoint checks.
   5. **What the credential owns**, by kind: a setup without a captured alert needs the credential to own no alert; a setup with
      one (it also changes choices) needs exactly that alert with the same incarnation, generation and revision; a rotation needs
      the same incarnation and generation only (it keeps whatever choices are current); otherwise `changed`. The same predicate is
      checked again at activation.
   6. **Capacity**: a new alert needs a **reservation** under the ceiling unless the endpoint belongs to another alert (a
      replacement, which does not add an alert; at most one candidate per endpoint, and at most 10% of the ceiling in all);
      otherwise `full`. The physical bounds (storage, below) are checked too.
   7. Stores the **setup** and makes it the credential's current operation (see storage), with a random 32-byte **nonce** sealed
      inside it and a dispatch state `unsent`.
   **The nonce is never returned by any route or written to any log.** Answer: `{ setup: "pending", expiresAt }` (5 minutes).
4. Dispatch: the API process takes a send slot (below) first; then one atomic step checks that this is still the credential's
   current operation, not expired, that the mode allows it, push is not paused, the push service is not in backoff and the
   endpoint's limit has room, and moves the dispatch state from `unsent` (or `retryable`) to `sending` with a dispatch id. If a check
   fails nothing is sent: an expired operation ends as `expired`; otherwise the state stays `unsent` (or `retryable`) with the reason
   and the earliest time it may be tried again (the backoff's end, or 30 s), which the driving page uses (step 7); the push is sent
   (`TTL` 300 s) as `{ v: 1, title: "Setting up PengePassportPH notifications", body: "<first office> and N more", tag:
   "setup-<op>", url: {}, kind: "setup", op, nonce, expiresAt }` (an older worker shows its title and body as they are); the
   transport's result moves the dispatch state, for that dispatch id:

   | Transport result | Dispatch state | Operation |
   |---|---|---|
   | `accepted` | `accepted` | Waits for the acknowledgement; never dispatched again |
   | `uncertain`, or `sending` left by a crash | `uncertain` | The same |
   | `refused`, `throttled` (sets the shared backoff), `rejected` | `retryable` | The **driving page** repeats the exact request after 5, 15 and 45 seconds (or after the backoff, if later), while the operation is unexpired; each repeat dispatches again through the gate above |
   | `bug` | `failed` | Ends as `failed` (result recorded, reservation released) |
   | `gone` | `failed` | Ends as `gone`; the device records the fingerprint as **gone**, removes that subscription (an unsubscribe claim, then `unsubscribe()`, sparing any newer fingerprint), and only then subscribes again and starts a new setup; if removal fails, it shows how to block and re-allow notifications for the site instead of trying again |
5. The worker, inside the push event, checks under the lock before each of these steps that the credential is not retired and the
   browser's subscription still has the operation's fingerprint, and **either** that the push's `op` is the operation in progress
   **or** (once the acknowledgement has been sent) that the operation was completed with `active` and its activation is still the
   alert the device knows (the page may have finished it first; that is success). The moment this fails, it shows (or replaces its notification with) "This notification setup didn't finish." and stops; whether
   notifications are on is shown only after the page reconciles.
   1. Shows "Setting up notifications…" (tag `setup-<op>`). If showing fails, it stops without acknowledging: the proof requires
      that this browser can display notifications.
   2. Stores the nonce in the operation (so the page can finish if the event ends).
   3. Posts `{ op, nonce }` with the credential header to `POST /api/device-alerts/ready`, up to 3 tries (after 0, 2 and 6 s); if the
      worker stored a nonce but no result arrived, the driving page tries again every 15 s until a terminal result or the expiry.
   4. Records a **terminal** answer as the operation's result (under the lock, if still current); a non-terminal one (see the API
      table) is not recorded and the operation stays in progress until a terminal result or its expiry. Then it replaces its
      notification. For `active`, before showing "Notifications are ready" it reads `GET /mine` and checks, as the page does, that
      the server's current alert is that activation and the credential is not retired; after the notification is shown it checks
      again under the lock that **the credential is not retired and the activation is still the alert the device knows** (the
      operation itself may already have been completed by the page; that is success), and only if not, it replaces that
      notification (tag `setup-<op>`) with "This notification setup didn't finish." Only this operation's notification is ever replaced or closed:

   | Answer | Worker's notification | Page |
   |---|---|---|
   | `active` | **"Notifications are ready"**, "You'll get a notification like this when dates open at <offices>." | "Notifications are on for this device." |
   | `expired` | "Setting up notifications took too long. Open PengePassportPH to try again." | The same, with **Try again** |
   | `full` | "Notifications are full right now. Email alerts still work." | The same, with **Try again** later |
   | `changed` | Removed | Reloads the alert; offers a fresh setup if it is gone, or the change again |
   | `gone`, `failed`, `owner-only` | "This notification setup didn't finish." | Reconciles; **Try again** (for `owner-only`, the owner link is forgotten) |
   | `invalid`, `unknown` (not terminal) | "This notification setup didn't finish." | Reconciles; the operation stays until its result or expiry, then **Try again** |
   | `limited`, a `5xx`, no connection | Nothing changes; the nonce and the operation are kept | Posts the acknowledgement again later (it is idempotent) |
   | No answer | "Couldn't confirm the setup yet. Open PengePassportPH to finish." | Posts the stored nonce itself, then as above |

6. The server, in one atomic step: if the credential's last operation is this `op` with a result, it answers it and changes
   nothing. If the credential's current setup is not this `op`, or the nonce does not match, it answers `invalid` (`unknown` for an
   `op` it has no record of) and changes nothing. Otherwise, for that exact setup: past its expiry, `expired`; the ownership
   condition of step 3.5 no longer holding, `changed`; else it activates (below), or `full` (activation step 4). The outcome is
   written atomically as the operation's **result**, with the setup removed (after comparing its `op` again) and its reservation
   released or used. With `active`, the result names the **activation**: alert id, incarnation, generation and revision.
7. The **driving page** is the visible page holding the Web Lock `pengepassportph-device-alerts-driver`; it holds it from the
   operation's start until a terminal result or the operation's expiry, and releases it when it is hidden, closed, or the credential
   is retired, so another visible page can take over (which rebuilds the schedule from the operation's stored times). It reads `GET
   /api/device-alerts/mine` every 2 s for the first 30 s, then every 10 s until the result or the expiry (at most about 50 reads per
   operation), or hears from the worker by message, and repeats the request when the dispatch state is
   `unsent` or `retryable` and its earliest retry time has passed (step 4); repeats never count as another stored setup. It
   reports success only when its operation's result is `active` **and** the server's current alert is that activation (same
   incarnation and generation) with the same fingerprint; if the alert has changed or gone since, it shows the current state
   instead. If the worker stored a nonce but no result arrived, the page posts the acknowledgement itself. After 30 s without a result
   the page shows "Still setting up. Check that notifications are allowed for this site." (the driving goes on until the result or the
   expiry), with **Try again** once the operation has ended.

The credential's last operation and its result are kept until the next operation replaces them, or for 24 hours, whichever comes
first; a repeat of an operation that has been replaced answers `unknown`, and the page reconciles. A setup nobody acknowledges is ended as
`expired` by the checker's clean-up or, if the checker is down, by the next admission for that credential; either records the result
and releases the reservation.

What it proves: whoever asked holds the credential **and** this browser shows that subscription's pushes, for the operation in
progress. An attacker with a copied subscription cannot activate it (the nonce goes only to the receiving browser, which
acknowledges only its own operation in progress). A delayed or replayed setup request is never acknowledged unless it is the
device's operation in progress, so it ends as `expired`.

### Activation and the one-alert-per-endpoint rule

Each alert has an id, an **incarnation** (random, new whenever an alert is created), a **generation** (the number of its proven
subscriptions), a **choices revision**, an end time and a last renewal. Activation, once step 6's checks pass:

1. Without a captured alert: a new alert, using its reservation.
2. With a captured alert (a setup that also changes choices): choices replaced (revision + 1), subscription replaced if different
   (generation + 1); pace, today's count and end time kept.
3. A rotation: subscription replaced (generation + 1); everything else kept.
4. In 1–3, if the endpoint belongs to **another** alert, that alert is deleted (its record and indexes compare-and-deleted; the
   checker drops its delivery work) and this one takes the endpoint: proof of the endpoint wins (the lost-credential case). A
   **first setup** admitted as a replacement (without a reservation) whose endpoint's alert has meanwhile gone creates a new alert, so
   it needs a reservation now, or ends as `full`. Setups with a captured alert and rotations never add an alert and never need one.
   Active alerts: a first setup adds one (a replacement adds one and deletes one); the others add none.

`active` is the only result that changed anything.

### Changing, testing, turning off

- **Change** (`PUT /api/device-alerts/mine`, `{ op, seq, incarnation, baseRevision, choices }`): an operation of kind `change`, so
  it waits for, and blocks, other operations like a setup. Applied at once if the incarnation and revision are current (revision +
  1, answer `active` with the new revision), otherwise `409` and the page reloads the alert. Pace and today's count are kept; the
  checker filters the alert's work to the new choices when it next claims. A repeat of the same `op` answers its result.
- **Send a test** (`POST /api/device-alerts/mine/test`): answers `accepted` ("Accepted by the push service. Check this device."),
  `uncertain` ("Sent, but the push service didn't confirm. Check this device before trying again."), `refused` ("The push service
  didn't take it. Try again later."), `gone` (settled by the same rule as an alert send: for the current generation the alert is deleted, or, with a rotation
  pending, `goneGeneration` is set and the row says "Updating this device's notifications…"; the row asks for setup again only if
  the alert was deleted),
  `unavailable` (push off, paused or in backoff), `limited`, or `none` (no alert). Tests never count toward the daily cap; they use
  the shared backoff and the per-process send limit (below); a gone answer for an older generation deletes nothing.
- **Turn off**: under the lock, in **one step**, the page increases the **epoch**, **retires** the credential, writes the
  **unsubscribe claim** for this browser's current subscription (its fingerprint; unless that subscription belongs to an opt-in started
  after this turn-off), drops any operation in progress, and clears the current credential. A later opt-in makes a fresh credential.
  The retired credential is kept until **both** its server deletion and the unsubscribe claim are resolved; on every opening, before
  any setup and whether or not there is a current credential, the page first resolves outstanding claims and retired deletions.
  Then, independently:
  - **Deletion**: `DELETE /api/device-alerts/mine` with the retired credential deletes the alert record, its indexes, any
    unfinished operation of that credential and its `ended` record, and answers `deleted` (also when nothing was there). Because the credential is retired,
    **any** alert found under it later is unwanted: the page keeps sending the deletion, on every opening, until the server answers
    `deleted` **and** `GET /mine` for that credential reports nothing (this also catches an acknowledgement that was already in
    flight when the person turned off). Only then is the retired credential forgotten.
  - **Unsubscribing**: with the claim already written (above), the page calls `unsubscribe()`. While a claim exists, no setup may start (it waits). On completion, under the lock, the claim is cleared only if
    it is still this task's; on every opening a leftover claim is resolved by looking at the subscription: absent, cleared; present
    with the claim's fingerprint, unsubscribed again; present with another fingerprint, cleared if that subscription belongs to an
    opt-in started after the turn-off, otherwise replaced by a new claim for it and unsubscribed. A claim never blocks setup beyond
    one such resolution.
  - The page closes this site's notifications still on screen.
  - The row reports the two separately: "Notifications are off on this device." once the subscription is confirmed absent (else
    "This browser didn't stop its subscription. Block notifications for this site in its settings to be sure."), and "Deleting them
    from our server when you're back online." while the deletion is pending. After unsubscribing, the push service usually answers
    later sends with `410` and the server deletes the alert then too; the deletion and the 180 days remain the guarantees.
- Notifications the push service had already accepted (alerts, a test or a setup) can still arrive; the privacy page says so.

### When the subscription changes

The push service may replace a subscription (`pushsubscriptionchange`), and the page compares its subscription with the server's
fingerprint on every opening. A new subscription is attached to the **same alert** by an operation of kind `rotate` (`POST
/api/device-alerts/mine/subscription`, `{ op, seq, subscription, captured }`, with the captured incarnation and generation only),
proven by the same ready check; no choices travel with it and the alert's current choices are kept whatever happens to them
meanwhile. If it answers `changed` while the credential and the browser's subscription are unchanged, the worker or page reloads
the alert and tries the rotation again once. A `pushsubscriptionchange` that arrives during another operation sets **needs
rotation** and joins; when that operation ends, the device reconciles and rotates to the then-current subscription. If the browser has **no** subscription (the event's new subscription or
`getSubscription()` is null), the worker or page subscribes again with the stored VAPID key if permission is still `granted`, as an
operation of its epoch (abandoned, and its subscription removed, if a turn-off happened meanwhile); if that
fails or needs the person, the row says "Notifications need setting up again on this device."

Until the new subscription is proven, the old one stays and is used. Rotation never renews the alert and keeps its end time; an
alert that ends during a pending rotation ends (the rotation answers `expired`). If the push service reports the **old** subscription
gone while a rotation is pending, the alert records `goneGeneration` (in its metadata, in the same step) and is not sent to; the
rotation's activation clears it; if the rotation ends any other way, the alert is deleted in that same step (or by clean-up). A gone
report for an older generation never deletes the alert.

### Lifetime and clean-up

- An **opening** is the page being visible with a credential and an alert the server has just reported active. The page then calls
  `POST /api/device-alerts/mine/seen` unless its last **confirmed** renewal (written under the lock only after the server answers) is
  less than an hour old; a stored time in the future is discarded. A failed renewal is retried while the page stays visible (after
  1, 5 and 15 minutes, then hourly). The server sets the end to the later of the current end and its own now plus 180 days;
  duplicates are harmless. So an alert ends 180 days after the last opening that reached the server, to within an hour. Renewal is
  an authenticated sign the device is in use, not proof a person looked. Only `seen` renews.
- The end uses the server's wall clock, which is kept by NTP; the end only ever moves later. A large forward clock step could end
  alerts early; this is accepted and stated in the runbook (affected devices are asked to set up again; nothing else is lost).
- The end is checked in the same atomic step as every read, renewal, change, activation, claim and send; an ended alert is treated
  as gone.
- **Gone** (`404`/`410`) for the current generation: the alert is deleted (see rotation for a pending one), and in the same step
  the credential's **end record** (`pp:dev:ended:<hash>`, using the unit the alert reserved for it) is written with `reason: gone`,
  the date and the gone subscription's fingerprint, for 30 days; `GET /mine` then answers `gone` with that fingerprint. The device,
  when it next reconciles, removes the subscription with that fingerprint (if the browser still returns it) before any new setup, exactly as for a gone setup push (a browser asked to subscribe again would otherwise return the same dead one).
- **Blocked**: when the page sees `Notification.permission` is `denied`, it turns the alert off (as Turn off) and the row says
  "Notifications are blocked on this device, so we turned them off." Blocking while the site is closed, and uninstalling the app,
  cannot be seen; the push service's `410` or the 180 days end those.
- **Clean-up** runs at the start of every checker invocation, before the cooldown and health checks, under the checker's lock,
  inside its own error boundary: if it fails, the failure is logged and counted, the notification pass is skipped for that run (the
  daily report flags the retention it may miss), and the run goes on with scans and email. Its steps: it
  deletes ended alerts with their indexes and delivery work; ends unacknowledged setups past their expiry; drops delivery work of
  alerts that no longer exist and dates older than their 3-hour window; deletes alerts whose pending rotation has ended with
  `goneGeneration` set; and recovers claims (below). Each step counts what it did. Admission also removes, in its own step, up to 20
  expired operations, ended alerts and records past their deadline in `pp:dev:deadlines` (results, end records), without delivery
  work, which only the checker touches; so physical storage stays bounded while the checker is down.
- An alert that ends leaves `ended` with its date in the credential's state for 30 days, so the row can say "Notifications on this
  device ended on <date>. Turn them on again to keep getting them." A turned-off, replaced or lost alert says "Notifications need
  setting up again on this device."

### On the home page

When this device has a credential, a row under the summary, reconciled on opening, on returning, and every 30 s while waiting:

- **On**: "Notifications on this device: Antipolo and 2 more · for 2 people · as soon as possible · until 4 Apr 2027" (with "We
  couldn't renew it just now; we'll try again." while a renewal is failing), then
  **Change**, **Send a test**, **Turn off** together on their own line.
- **Setting up**; **blocked**; **ended** (with date); **needs setting up again**; **off here, deletion pending**; **can't check right
  now** (nothing is claimed).
- "On" only when permission is `granted`, the browser's subscription fingerprint equals the server's for the alert, and the server
  says active.

## Storage (Valkey)

A separate namespace, so email code and older releases never meet a notification alert.

| Key | Holds |
|---|---|
| `pp:dev:<id>` | Hash. Sealed field (AES-256-GCM, `EMAIL_ENC_KEY`, associated data `device:v1`): the subscription (endpoint and keys). Plain fields, readable by scripts: offices, group size, pace, created, activation **order** (a number from the counter
`pp:dev:order`, below), credential hash, creating `op`, incarnation, generation, revision, fingerprint, endpoint HMAC, end, last renewal, `goneGeneration` |
| `pp:dev:endpoint:<hmac>`, `pp:dev:cred:<hash>` | Alert id |
| `pp:dev:site:<office>` | Set of `<id>:<group size>` |
| `pp:dev:ends` | Sorted set: alert id by end |
| `pp:dev:op:<credential hash>` | The credential's current or last operation: `op`, `seq` (and the highest `seq`), kind, digest, captured alert, reservation, expiry, dispatch state and id, the result (with the activation), and, while unfinished, the sealed (`device-setup:v1`) subscription, choices and nonce. No TTL: deleted by clean-up, accounted |
| `pp:dev:ops` | Sorted set of unfinished operations by expiry |
| `pp:dev:ended:<credential hash>` | The **end record**: `reason` (`ended` or `gone`), the date, and for `gone` the subscription's fingerprint |
| `pp:dev:queue` (hash: alert id → job), `pp:dev:queued` (sorted set by the oldest date's announcement) | Queued work, one merged job per alert |
| `pp:dev:held:<id>` | Held work |
| `pp:dev:claim:<id>` | The alert's one claim: claim id, run id, incarnation, generation, revision, charged day, dates, previous pace stamp, state `claimed` or `sending` |
| `pp:dev:fanout:<batch>`, `pp:dev:fanout:<batch>:stamps`, `pp:dev:fanouts` | Openings queued for email whose notification jobs are not yet written, in **batches** (one per queueing write, named by run and domestic or abroad): one entry per office, date and group size with a stamp index, at most 2,000 entries of at most 64 bytes, and that batch's `clock.ts` stamps; `pp:dev:fanouts` lists the pending batches, oldest first, at most 5 |
| `pp:dev:last:<id>` | Pace stamp (a `clock.ts` stamp, as email's) |
| `pp:dev:today:<id>:<day>` | Today's count (Manila day) |
| `pp:dev:tried:<id>` | Tries per date |
| `pp:dev:order` | The ordering counter for activations and fan-out batches |
| `pp:dev:records` | Storage units in use or reserved: alerts with their delivery footprint, operation and `ended` records, reservations, garbage entries; kept by the scripts that create and delete them |
| `pp:dev:garbage` | Deleted alerts whose delivery keys the checker has not yet removed (still charged) |
| `pp:dev:deadlines` | Sorted set: when each operation result (24 hours) and `ended` record (30 days) is due for deletion; clean-up deletes them through the same accounted scripts |
| `pp:dev:cursor:domestic`, `pp:dev:cursor:abroad`, `pp:scan:groupcursor`, `pp:scan:abroadcursor` | Fair-order and lookup cursors |

Life of each is in the retention table under "Privacy and data", which is the one place that states it.

**Encrypted or not.** Only the subscription is encrypted. Offices, group size and pace are plain fields: they are not personal, they
were already visible in `pp:dev:site`, and the scripts need them. **Jobs** (queued, held, claimed) are plain JSON: alert id,
incarnation, and dates, each with its office id, the group size it was announced for and its announcement time (a date's identity is
office, date and group size). They carry no signature, so the scripts can merge and filter them; when a notification is built, every
office id must be in the current catalogue and every date one that office has published, else it is dropped and logged.

**Who writes what.**

- The API writes alert records and their indexes (create, change, rotate, delete), operations, and `pp:dev:ended`. It may delete an
  alert record, never delivery work.
- The checker, while it holds its lock (every script checks the lock's owner), writes everything about delivery: queued, held and
  claimed work, pace, today's count, tries, cursors, the fan-out batches; and deletes ended alerts. It drops work whose alert no longer
  exists or has another incarnation, and checks the alert's incarnation, generation, revision, choices and end inside every claim and
  send step.
- Every write is one atomic step (a Lua script on Valkey, an equivalent single step in `MemoryKv`), checking everything before writing
  anything, idempotent on retry, tested on both. Where a step needs something only Node can make (a sealed subscription), Node prepares
  it and the script writes it only if the fields it was prepared from (operation, incarnation, generation) still match.

**Bounds.** At most 10 offices; an endpoint at most 1,024 characters, so an alert record (with its sealed subscription and plain
fields) at most 3 KB and an operation record at most 4 KB; a job at most 30 dates **and** 4 KB, in a compact form (a table of the
distinct `clock.ts` stamps it uses, then one `[office, date, group, stamp index]` per date); every merge and every admission enforces
both limits, dropping the oldest dates first and counting them. The plan measures these with maximum valid inputs, not typical
ones; tries are kept only for dates still in the alert's work and pruned with them. Per alert:
one queued job, one held job, one claim, one pace stamp, today's count and its tries, all of fixed maximum size: an alert's **delivery
footprint**. Per credential: one operation record and one `ended` record. Unfinished operations count against the ceiling while
unexpired. Storage is counted in **units** (an operation record: 1; an alert with its maximum delivery footprint **and the `ended`
record it may leave**: as measured, say 5). When an alert ends, its `ended` record uses its own reserved unit, and the rest stays
charged as garbage until the checker removes its delivery keys; so ending never needs a unit that was not reserved. Admission of an operation that may create an alert reserves the operation's unit **and** the alert's units, and
refuses (`full`) unless they fit `DEVICE_RECORD_LIMIT`; activation uses the reservation, and every other outcome releases it. So
delivery can never grow storage past what admission allowed, and concurrent activations cannot exceed it. When the API or admission
deletes an alert record, the alert's units stay charged as a **garbage** entry (`pp:dev:garbage`, alert id) until the checker has
removed its delivery keys, so the allowance is not reused while they still take memory. Records with a deadline are deleted only by
accounted scripts (no TTL), so the count cannot drift; a daily reconciliation in clean-up recounts and logs any difference. Both limits
come from the plan's measurement and hold while the checker is down.

**Headroom.** Production's Valkey has `maxmemory 64mb`, `noeviction`, shared with everything else; a script that starts under the
limit can finish over it, and a script that fails part-way keeps the writes it made. So:

- The plan measures the largest footprint of each `pp:dev:` record and of the limiter keys the global gates allow, and sets the
  record limit so the whole namespace at its limit is at most 25% of `maxmemory`. Device admission is refused above 70% `used_memory`
  (read live).
- **Queueing is two writes**: the first (as today, plus a fan-out batch: one entry per office, date and group size announced,
  at most 2,000 entries of at most 64 bytes, each `<office>|<date>|<group>|<stamp index>`, and the batch's announcement stamps, the
  same `clock.ts` stamps email jobs carry (boot id and uptime), stored once per batch; jobs carry the original stamp, so a date's age
  after a reboot is unknown exactly as for email) records the open dates, the announcement marks and the email jobs; the second
  writes the notification jobs from the oldest pending batch and removes it. Each queueing write adds a **new batch**; batches are
  never merged or overwritten. If 5 batches are already pending, the new one is not added (its notification work dropped and
  counted) and the pending ones are kept. Recipients: **an alert gets an opening if it was activated before the opening's announcement and
  its offices and group size match when the second write runs**. "Before" is decided by one counter, `pp:dev:order`, increased
  atomically whenever an activation **creates** an alert (a new incarnation; stored as its order, which never changes: rotations and
  setups with a captured alert keep it) and by every first queueing write (stored on its fan-out batch); an alert gets a batch's
  openings if its order is lower. The counter does not depend on any clock or boot, so it works the
  same after a reboot and on machines whose uptime is unknown. The `clock.ts` stamps are kept only for the 3-hour window. Normally that is moments after the announcement; after a crash it
  is the next run, and an alert whose choices changed in between is judged by its new choices (this is accepted: the claim filters by
  current choices anyway). Dates still inside their window are delivered as usual. If the batch would exceed 2,000 entries, or `used_memory` is above 85%, the first write goes without it and the notification
  work of those openings is dropped and counted. If the first write fails for any reason with the batch, it is retried once without
  it (the notification work dropped and counted); if it still fails, the run fails as today. A failure of the second write is caught,
  logged and counted; the batch stays for the next run; the email pass carries on. Email is never blocked by notification storage.
- The second write runs in **chunks** of at most 100 entries, each one atomic step that writes those entries' jobs and removes them
  from the batch, so it can be resumed after any chunk. The plan measures the worst case of a chunk at the alert ceiling and sets the
  chunk size so a chunk takes under 50 ms; between chunks the run yields (so the API and the lock renewal go on); the notification pass spends at most 10 s
  on chunks per run, and what is left is done by the next run.
- Every device script uses Valkey's flagged script form. Scripts that can grow storage are refused when memory is full, only
  before they start; **reclamation** scripts (deleting alerts, operations, garbage and delivery work) are flagged `allow-oom`, so they
  run even over the limit, and their own writes are bounded to small counters and index removals. Every script checks every key's
  type and every value before its first write, so no command after the first write can fail on its input. Tests run the real scripts against a Valkey at its memory limit and with keys of the wrong type, and check that each either
  writes everything or nothing; and that clean-up brings an over-limit database back under it.

## API

The device routes' **changes** (`POST`, `PUT`, `DELETE`, which sends `{}`) require a JSON body (the existing `jsonBody` check)
and an `Origin` header equal to the site's own origin (missing or `null` refused; the local stack's origins only in its build).
`GET /api/device-alerts/mine` has no body and no `Origin` requirement (same-origin reads usually omit it); it needs the credential
header, which no cross-site page can send without a preflight the server never grants, and it changes nothing. The email routes keep their current checks;
in particular the one-click unsubscribe (RFC 8058) form post, which mail providers send without an `Origin`, is unchanged. Shapes are versioned in
`packages/contracts` (`deviceAlerts: 1`); choices are validated by one function shared by both kinds of alert (no longer requiring an
email).

| Route | Does | Answers |
|---|---|---|
| `POST /api/device-alerts` | Start a setup | `pending` + `expiresAt`; `busy`, `limited`, `full`, `invalid`, `owner-only`, `off`, `unavailable`, `changed`; a repeat: its state or result |
| `POST /api/device-alerts/ready` | The proof (`{ op, nonce }`) | Terminal: `active` (with the activation), `expired`, `changed`, `full`, `owner-only`, `gone`, `failed`. Not terminal: `invalid`, `unknown` (nothing changed), `limited`, a `5xx` (try again) |
| `GET /api/device-alerts/mine` | This device's alert and operation | `active` (choices, revision, end, fingerprint, generation, incarnation), `ended` (date), `gone` (date, fingerprint), `none`; with the operation's state or result |
| `POST /api/device-alerts/mine/seen` | Renew on opening | the end |
| `PUT /api/device-alerts/mine` | Change | `active` or `409` |
| `POST /api/device-alerts/mine/subscription` | Rotation | as a setup |
| `POST /api/device-alerts/mine/test` | Test | `accepted`, `uncertain`, `refused` (also for `throttled`, `rejected`, `bug`, and `gone` for an older generation, none of which changes the row), `gone` (current generation: deleted, or kept with `goneGeneration` while a rotation is pending, as for an alert send), `unavailable`, `limited`, `none` |
| `DELETE /api/device-alerts/mine` | Turn off | `deleted` |

The fingerprint is the SHA-256 of the canonical subscription (endpoint and keys) as the page computes it; it reveals nothing the page
does not hold. Errors reaching the logger pass an allowlist (route, status, category, internal alert id); no subscription, credential,
nonce, header or payload is ever logged; a test feeds realistic push errors through it.

### What each mode allows

| | `off` | `owner` | `live` |
|---|---|---|---|
| Switch shown | No | Only with the owner token stored | Yes |
| Setup for a new alert | `off` | Owner token required | Yes |
| Setup with a captured alert, rotation | `unavailable` (tried again at the next opening) | Yes, without the token | Yes |
| Ready, read, renew, change, turn off | Yes (so people can see and stop their alert) | Yes | Yes |
| Tests | `unavailable` | Yes | Yes |
| Alert sends | No: work waits uncharged and is dropped after its 3-hour window | Yes | Yes |

`pp:push:paused` (the existing emergency stop) stops every push (alerts, tests, setups) in every mode.

## Limits against abuse

Each request first passes an **ingress gate** of fixed size: the IP's keyed hash picks one of 4,096 buckets (3,000 requests an hour
each), so it never creates more than 4,096 keys whatever the traffic; a shared IP, or a bucket shared by chance, can be slowed by it,
which is accepted. The request is then classified by a read-only lookup of its credential hash (known: it has an alert, an unfinished
operation or a retired alert being deleted; unknown: none of these), and charged to its class: the class's **global** pool first, and
only if that has room, the per-key counters, whose number is therefore bounded by the global rate times their 2-hour life. Refused requests create
nothing; unknown credentials create no per-credential state; and the classes have separate pools, so unknown traffic cannot use up the
capacity reserved for known devices, deletions and acknowledgements.

| Class | Per key | Global |
|---|---|---|
| Setup requests from unknown credentials (a first setup; including repeats) | 30 an hour per IP | 300 an hour |
| New setups stored | 10 an hour per IP | 100 an hour |
| Setup pushes to one endpoint from credentials that do not own its alert | 3 an hour per endpoint | (within the above) |
| Setups with a captured alert, and rotations, by an alert's own credential | 6 pushes an hour per alert | 600 an hour |
| Acknowledgements from known credentials | At most 10 per operation, counted only when the acknowledgement reaches the atomic step (a `5xx` or a refused request costs the operation nothing; a recorded result is answered again for free); 60 an hour per IP | 7,000 an hour, reserved (10 for each operation the setup and rotation pools can admit in an hour) |
| Reads and renewals by a credential with an alert | 600 an hour per credential, 2,400 per IP | 50,000 an hour, reserved |
| Reads by a credential with only an operation or `ended` record (the **pending** pool: setup polling, results) | 240 an hour per credential, 1,200 per IP | 15,000 an hour, separate: three times what the most setups the pools admit in an hour need at the polling schedule (about 50 reads each) |
| Changes, known | 60 an hour per credential | 6,000 an hour |
| Turn off | Never limited per credential; 600 an hour per IP | 6,000 an hour, reserved |
| Anything from unknown credentials (reads, changes, turn off) | 600 an hour per IP | 6,000 an hour, separate |
| Tests | 3 an hour per alert; 20 per IP | 200 an hour |
| Alerts | `DEVICE_ALERT_LIMIT` (unended alerts plus unexpired operations holding a reservation) and `DEVICE_RECORD_LIMIT` (everything stored) | |

Classification, by route and what the credential's hash finds:

| Route | Has an alert, or a retired alert being deleted | Has only an operation record (unfinished or completed) or an `ended` record | Nothing |
|---|---|---|---|
| Setup (first, or a repeat of it) | Known: setup pools | Setup pools for unknown credentials (a repeat of an unfinished first setup counts against "New setups stored" only once, when stored) | Setup pools for unknown credentials |
| Setup with a captured alert, rotation | Known: maintenance pool | `changed` (it owns no alert) | Unknown pool |
| Acknowledgement | Acknowledgement pool | Acknowledgement pool (an unfinished operation's proof, or the recorded result again) | Unknown pool; answers `unknown` |
| Read, renew, change, test | Known pools | Pending pool (below; answers `ended`, `none` or the result) | Unknown pool |
| Turn off | Turn-off pool | Turn-off pool | Unknown pool; answers `deleted` |

The page stays well inside these: only visible pages poll, the row polls every 30 s only while waiting, and setup polling stops at its
operation's result. Counter keys use keyed hashes and expire within about 2 hours. These limits are a deterrent, not a wall: someone
with many addresses can still make setups, and someone holding a copy of a browser's subscription can spend its 3 setup pushes an hour
(which delays that browser's own new setup, never its existing alert). The daily numbers show refusals by class and reason, and the
alerts and records in use against their limits, flagging 80%.

Endpoint checks are kept: `https:`, default port, no user info, at most 1,024 characters, a push service on the allowlist (Google,
Mozilla, Microsoft, Apple), valid keys; when stored and before every send; no redirects; 5 s timeout.

## Sending

### A run

1. Clean-up (above), then the existing cooldown and health checks.
2. The domestic scan. **Scan demand** includes both kinds of alert: the group sizes to look up for an office are the union of email
   subscribers' and notification alerts' sizes. When there are more pairs than the run's 10 group lookups, at most 6 go to pairs with
   **held work waiting for verification** (oldest first) and at least 4 to the others in turn (`pp:scan:groupcursor`); unused shares
   pass to the other side. Dates dropped because
   their pair could not be looked up in time are counted as such.
3. Queueing: the first write (email jobs and a fan-out batch, checking the run still holds its lock). The email pass can start at
   once; the second write (notification jobs) belongs to the notification pass.
4. Three things then run side by side:
   - The **abroad scan** starts right after the domestic queueing (its existing caps and budget, measured from the run's start as
     today; a post is "followed" if either kind follows it; its lookups are shared the same way, at most
     half to pairs with held work, the rest in turn by `pp:scan:abroadcursor`), then its queueing as in step 3. It ends by resolving an "abroad ready" signal, **always**: with
     the queued work, or empty if it failed or was skipped.
   - The **email pass**, one consumer in today's order: domestic delivery, then it waits for "abroad ready" and does abroad delivery.
   - The **notification pass**: first the second writes for pending fan-out batches, oldest first, within **10 s** of fan-out work
     per run (the rest stays pending); then the domestic batch; then it waits for "abroad ready", writes the abroad fan-out the same
     way, and runs the abroad batch. Nothing in it delays the scans or the email pass.
5. The run waits for all three before releasing its lock. An error or stop condition in one (mail paused, the email limit, mail
   errors, push paused, a failed abroad scan) never stops or delays the others; each catches its own errors.

Both kinds only send dates verified open in this run (`deliveryChecks()`).

### A notification alert's decision

- Pace: "as soon as possible" (with the 2-minute floor) or "at most once an hour", from the `clock.ts` stamp in `pp:dev:last`, handled
  across reboots exactly as email's pace (a stamp from another boot restarts the gap; it never shortens it).
- Daily cap: the same value as email's per-person cap (`alertsPerSubscriberPerDay`), counted per alert per Manila day. The count holds
  **accepted and uncertain** sends only; every other result gives its count back. Tests and setup pushes never count. Work over the
  cap stays held and is considered again the next Manila day if its window is still open; otherwise dropped (counted).
- Each date keeps its **original** announcement time; merging never restarts a date's 3-hour window; a date older than 3 hours is
  dropped (counted). A date whose age cannot be established (after a reboot, per `clock.ts`) is dropped, never given a new window.
- **At most one send attempt per alert per run.** In the domestic batch, an alert is skipped if its oldest waiting date is abroad and
  older than its oldest verified domestic date; the **abroad batch always runs**, even when the abroad scan failed or was skipped
  (then with no abroad dates verified), and sends such an alert everything verified in this run, domestic dates included. So the
  older work goes first when it can be sent, and verified domestic dates are never held back by abroad work that cannot be.

### Claims and sending

All of these are atomic steps run only by the checker, each checking the lock's owner:

1. **Claim**: takes a slot (below) first. Then, from the alert's held and queued work, it keeps only dates of the alert's current
   incarnation, offices and group size, still inside their window; of those, **only dates verified open in this run** are claimed,
   the rest stay held with their original times. The claimed dates go into `pp:dev:claim:<id>` (state `claimed`, with the run id,
   incarnation, generation, revision, the charged Manila day, the previous pace stamp); `pp:dev:last` becomes now; today's count goes
   up by one. Refused if the alert is ended or has `goneGeneration`, is at its cap, too soon for its pace, already claimed, or already
   attempted this run; or if no verified date remains.
2. **Send**: just before the transport call, checks the claim, the alert (incarnation, generation, revision, end), the mode and
   `pp:push:paused`, that push service's backoff, and every date's age; sets `sending`. If anything fails, the claim is put back
   unattempted (step 4) and nothing is sent.
3. **Settle** by the transport's result (compared by claim id):

   | Result | Settlement |
   |---|---|
   | `accepted` (`201`) | Claim deleted; count kept |
   | `gone` (`404`/`410`) for the alert's current generation | Alert deleted (or, with a rotation pending, `goneGeneration` set); claim deleted; count given back |
   | `gone` for an older generation | Put back, as a refusal |
   | `throttled` (`429`) | Put back, as a refusal; that push service's shared backoff set to its `Retry-After` (at most 1 hour; none given: 10 minutes) |
   | `refused`: `5xx`, an unexpected status, a timeout or connection failure **before** the request was sent | Put back, as a refusal |
   | `rejected` (`400`, `401`, `403`) | Put back, as a refusal; push paused for the rest of the run; logged for the operator |
   | `bug`: `413`, a payload, encryption or local validation error, a synchronous exception before sending | Claim deleted, count given back, never retried; logged |
   | `uncertain`: a timeout or reset after the request was sent | Claim deleted; count kept; never sent again |

4. **Put back**: the claim's dates go back into the alert's **current** held work (merged, original times kept, filtered to the current
   incarnation, offices and group size, dates past their window dropped); today's count goes down on the claim's charged day, only if that
   day's counter still exists and never below zero (a counter that has expired is not recreated);
   `pp:dev:last` goes back to the claim's previous stamp **only if** it still holds this claim's stamp. **As a refusal**, each date's
   tries also go up by one (after 3, dropped and counted); **unattempted**, tries are untouched. A deleted or replaced alert gets
   nothing back.

**Recovery**, in clean-up, by the run that now holds the lock: a claim whose run id is not this run's belongs to a run that lost the
lock, which can no longer pass step 2. A claim still `claimed` is put back unattempted; a claim in `sending` is settled as `uncertain`.
A run that lost its lock while a send was already in flight cannot stop it; its settlement then finds the claim gone or changed and
does nothing.

The transport returns a structured result (`accepted`, `gone`, `throttled` with a safe `Retry-After`, `refused`, `rejected`, `bug`,
`uncertain`), never a synthesized `201`. Setup and test sends use the same result.

### Time, order and shared limits

- Each notification batch (domestic, abroad) has its own **60 s** of sending from its first send; scanning does not count. A slot is
  taken before a claim; at a batch's deadline nothing more is claimed and the rest stays queued or held.
- Concurrency: the checker sends at most 8 at once; each API process sends setup and test pushes at most 4 at once (they are few:
  see the limits). Every send has a **total deadline** of 10 s (connection, request and response), enforced by aborting the request;
  its slot is held until the request has actually ended. A send aborted after its request may have reached the push service is
  `uncertain`; one aborted before is `refused`. Backoff for a push service (`pp:push:backoff:<service>`, after a `429`) is shared through Valkey and checked by
  every send, setup and test.
- Order within a batch: every alert with work (held and queued merged per alert), from that batch's cursor, which advances past every
  alert considered, whether sent, refused or skipped.
- The run's lock is renewed and released by atomic compare-owner scripts (today's check-then-set has a gap), renewed independently of
  slow sends.
- An alert notification: `{ v: 1, title, body, tag, url }` as today, with "Dates open at Antipolo" or "Dates open at 3 offices", the
  dates and group size, "Checked <time>", a unique tag, `TTL` 30 minutes, `urgency: high`; tapping opens the office with the date and
  group size. The checked time is the **oldest** verification among the dates sent: group lookups record their own fetch time
  (`snapshot.ts` gains it), `deliveryChecks()` keeps a time per office and group size, and the claim carries it to the payload.

## The service worker

Kept: `push`, `notificationclick`, `pushsubscriptionchange`, the capabilities handshake (now announcing `deviceAlerts: 1`). Every push
shows a notification (`userVisibleOnly`), and every payload keeps today's `{ v: 1, title, body, tag, url }` envelope, so an older
worker shows its own text correctly. Changed: `push` handles `kind: "setup"` (above) as well as alerts; `pushsubscriptionchange`
starts a rotation with the credential (no owner token needed), or joins one in progress. Removed: the email confirmation states
(`confirmed`, `askedAt`, the 48-hour protection).

## The Android app

Notification delegation and the monochrome icon are in 1.1.0. Before it goes to Play, the release APK (signed with the upload key,
which the live `assetlinks.json` lists) is checked on the owner's phone against the live site in owner mode: Android's own prompt
names the app; setup and alert notifications are posted by the app's package; tapping opens the office; denied and blocked show
the right row. If Chrome does not delegate to the verified app, notifications still work as Chrome's, and the owner decides
whether to ship.

## Privacy and data

**Retention**, the one place that states it (the storage section, the privacy page and the runbook follow this table):

| Item | Where | Normal life | While the checker is not running |
|---|---|---|---|
| The push subscription (an address at the browser maker's push service, and keys), encrypted; the alert's offices, group size and pace, plain, next to a random id | `pp:dev:<id>`, `pp:dev:site`, indexes | Until turned off, gone, or 180 days after the last opening that reached us | Ended alerts are removed by later admissions or the next run |
| An operation: while unfinished, the subscription, choices and a nonce, encrypted; then its result | `pp:dev:op:<credential hash>` | Unfinished: until acknowledged or expired (5 minutes) and ended by clean-up; the result: until the next operation, or 24 hours and then the next clean-up | Ended by the next admission for that credential, by admissions' clean-up of up to 20, or by the next run |
| That an alert ended or its subscription was gone, with the date (and for gone, the subscription's fingerprint), under a hash of the device's credential | `pp:dev:ended` | 30 days, or until the device turns off; deleted by the next clean-up after that (normally within 5 minutes) | Deleted by the next clean-up or admission after the deadline; if both stop, when either resumes |
| Queued, held and claimed work (offices and dates), plain | `pp:dev:queue`, `held`, `claim`, `fanout` | Sendable for 3 hours after the opening; deleted by the next clean-up after that (every run, normally every 5 minutes) | Until the next run |
| Pace stamp, today's count, tries | `pp:dev:last`, `today`, `tried` | With the alert; today's count 2 days | The same |
| Rate-limit counters, keyed by keyed hashes of the IP address, the credential or the endpoint | Valkey | About 2 hours | The same |
| Deleted data in the database's own files (email data too) | Valkey's append-only file **and** its snapshot (`dump.rdb`; production has `save 3600 1 300 100 60 10000`), two separate copies | Until **both** have been rewritten after the deletion: an append-only rewrite and a snapshot that each started after it completed; normally within the hour | Longer if either fails; the daily report shows each one's last success and status |
| On the device: the credential, retired credentials, the operation in progress, the last renewal time | The browser's storage for the site (IndexedDB) | Until turned off and the server confirms deletion, or until the person clears the site's data | The same |
| Log lines naming an internal alert id (a random number; never a subscription, credential or address) | The server's journal | 14 days (journald's retention) | The same |
| What the push service handles | Google (Chrome, the Android app), Mozilla (Firefox), Microsoft (Edge on Windows), Apple (Safari) | The message is encrypted; the service keeps an undelivered message at most its `TTL` (30 minutes for alerts and tests, 5 for setups). Its own records of delivery (the endpoint, times, sizes) are kept under its own policy, not ours | |

No full copy of the database is kept as a backup (the runbook's existing rule).

Privacy page, published before notifications open to everyone:

- Notifications need no email address. To send them we keep this browser's or app's push subscription, encrypted, and the alert's
  offices, group size and pace, next to a random number. Notifications pass through the browser maker's push service (Google,
  Mozilla, Microsoft or Apple), encrypted; that service keeps its own records of delivery under its own policy.
- Turning notifications off stops them on this device when the browser confirms it (if it cannot, we say so and how to block them in
  the browser's settings), and deletes them from our server when it is reached. Notifications the push service had already accepted
  may still arrive. If you block notifications or remove the app, we may not learn of it; an alert ends 180 days after the site or
  app was last opened on that device **and could reach us** (to within an hour), and sooner if the push service tells us the
  subscription no longer exists.
- Notification alerts are not in our subscriber backups. Deleted data stays in the database's own two files until both have been
  rewritten, normally within the hour. (The same holds for email data; the email part of the page says so too.)

"Delete my data" gets two parts: email (by address, as today) and **this device** (shown with a credential: Turn off). Email deletion
never touches notification alerts, nor the reverse. `docs/legal/README.md` and the Play Data safety form are updated: device or other
IDs, app functionality, push services as service providers.

**Backups.** The daily R2 backup and `admin.mjs backup` hold email subscribers only, in **format version 1** again (exactly the
pre-push format; the old release restores it). The importer:

- reads versions 1 and 2 (written since 6 October) and refuses others and any malformed channel flag;
- validates the whole file before changing anything: unique ids, unique address indexes, each record's decrypted address matching its
  index under the configured keys; and against live data in **both** directions: a record whose address now belongs to another live
  subscriber, or whose id now belongs to another live address, is skipped and listed (checked again under each address lock when
  writing);
- skips, and counts separately, records with email off;
- removes obsolete channel fields from restored records (`HDEL`, not just omitting them) and never touches `pp:dev:*`.

Restores are run during maintenance, with `penge-api` and the checker stopped, and one at a time (an import lock), so nothing can
change an id or address between the checks and the writes. A test restores a version 1 export with the importer of `157bad9`.
Restoring needs the same `EMAIL_ENC_KEY`, `EMAIL_HMAC_KEY` and `TOKEN_SECRET` (their existing names; listed in the runbook). After a
disaster that loses Valkey, devices find their alert missing and are asked to set up again; the VAPID keys are kept with the server's
configuration, so browser subscriptions stay valid.

## Configuration

- `PUSH_MODE`: `off`, `owner`, `live` (table above). Read at start: changing it (or anything in `server.env`) needs `systemctl
  restart penge-api`; a checker run reads it when it starts, so a run already going keeps its mode. To stop pushes **now**, set
  `pp:push:paused`, which every send step checks.
- `owner`: new setups need the owner token, `PUSH_OWNER_TOKEN` (at least 32 random characters). The owner opens the site once with
  `#owner=<token>`; **before rendering or registering the worker**, the page moves it to local storage and removes it from the
  address bar (a fragment never reaches the server or its logs); if local storage is unavailable, the form says the owner link
  could not be kept. It is sent as `X-Owner-Token` with new setups only, compared in constant time, never logged. A wrong or old
  token answers `owner-only` and the page forgets it. Each setup records a hash of the token it was admitted with; in owner mode,
  activation refuses (`owner-only`) a new alert whose token no longer matches. Revoking: change the token and restart the API.
- `PUSH_OWNER_EMAILS` is removed. `VAPID_*` stay; the keys made on 6 October are kept.
- `DEVICE_ALERT_LIMIT` and `DEVICE_RECORD_LIMIT` (set from the plan's measurement).

## Reporting

From the deploy, the new counters live under a versioned key prefix (`pp:stats:v2:`), and the report labels each day's schema (the
deploy day shows both, split at the deploy time). Each counter has a unit and is incremented **inside the atomic step that makes the
change**, so retries and crashes cannot double-count:

- Operations: started (first storage of an `op`), completed, expired, changed, full; changes applied and refused (`409`).
- Requests refused, by class and reason (limit, capacity, records, mode, owner, endpoint): requests, not operations.
- Alerts: created, changed, turned off, ended, gone, replaced; rotations completed.
- Claims: accepted, gone, refused (put back after an attempt), put back unattempted, rejected, bugs, uncertain, recovered; dates
  dropped (by window, by retries, by overflow, by unknown age); dates held at the cap; tests sent.
- Setups: dispatches accepted, refused, uncertain; activations ended as `full`.
- Gauges, with the time read: email alerts confirmed; notification alerts active; unfinished setups; alerts against the ceiling;
  records against their limit; the last successful database rewrite and snapshot.

The plan lists every transition in this document with the counter it increments (or "none"), and a test checks the list against
the scripts.

Email numbers are as today. The report never claims a number of people.

## Leaving the channel design behind

Production runs `05cee09` with `PUSH_MODE=owner` and `PUSH_OWNER_EMAILS`. In a short maintenance window:

1. `systemctl disable --now penge-check.timer`, then wait until `penge-check.service` is inactive (a running check finishes on its
   own, within its 20-minute lock); then stop `penge-api`. Nothing can write now. (If a check had to be killed, the new release's
   clean-up recovers its claims; the old release has none.)
2. Read-only inspection: every key under `pp:push:`, `pp:reserved:`, `pp:pending:channels`; subscribers and pending requests with
   any of `emailOn`, `pushOn`, `pushCredentialHash`, `device`. Expected: none. Whatever is found is handled by step 4's table (whose
   only stop is a subscriber with email off).
3. Backups, each named `…-expires-YYYYMMDDTHHMMSSZ[.json]` (14 days, deleted by `penge-backup-expire`): `server.env`, the
   subscriber export, and, if step 2 found anything, a dump of exactly those keys (`channel-keys-<stamp>-expires-<stamp>.json`,
   0600, root only). The expiry script's test covers that name.
4. Only if step 2 found anything:

   | Found | What happens |
   |---|---|
   | `pp:push:*` (devices, indexes, credentials, pending and revoked markers), except `pp:push:paused` | Deleted (their owner sets up again) |
   | A subscriber with `emailOn` absent or `1` (any `pushOn`) | Channel fields removed (`HDEL`); stays an email subscriber |
   | A subscriber with `emailOn=0` | **Stop**: the owner decides (never turned into email consent) |
   | A pending request with `emailOn=0` | Cancelled, with its indexes (never turned into email consent) |
   | A pending request with `emailOn` absent or `1` | Kept as an email request (token, choices, address untouched); channel fields removed |
   | `pp:pending:channels` | Deleted |
   | `pp:reserved:*` | Kept if a kept pending request still needs it; otherwise deleted |

5. In `server.env`: `PUSH_MODE=off`, remove `PUSH_OWNER_EMAILS`, add `PUSH_OWNER_TOKEN` (both `157bad9` and `05cee09` start with
   this configuration, which matters if the deploy's own automatic fallback in `activate.sh` switches back to `05cee09` because the
   new release did not become ready: that fallback happens only at this first deploy, while no notification alert exists, so it needs
   no clean-up; every later deploy falls back to a release that already knows notification alerts). Deploy the new release (its
   activation starts the API); `systemctl enable --now penge-check.timer`; check a run; then `PUSH_MODE=owner` and restart the API.

**Code**: removed — the binding scripts and indexes, email-bound device states, channel fields on subscribers and pending requests
in new code (the old pages' answers above stay), channel lines in the confirmation email, backup version 2 export, `backup-to-v1`,
`push-downgrade`, tests that only pinned that coupling. Kept — the VAPID transport (now returning a structured result), endpoint
checks, error classification, payload building, sealing, the worker's handlers and handshake, context and capability detection,
permission handling, the Web Lock, fingerprints, the row's layout, the local stack and the verification harness. Changed — the pool
(per-batch deadline, shared limit, slot before claim), the lock scripts, scan demand and cursors, the run's orchestration.

**Rolling back.** First set `pp:push:paused` (every send stops at once); `systemctl disable --now penge-check.timer` and wait for a
running check to finish; set `PUSH_MODE=off` and remove `PUSH_OWNER_TOKEN` (both older releases start with `off` and no owner
setting); then switch the release (its activation restarts the API) and re-enable the timer, as the runbook says. Claims left by
the stopped run are recovered by the next run of the new release, if it is rolled forward. Older releases know nothing of `pp:dev:*` or the new IndexedDB database:
notification alerts stop and stay stored. Notifications the push service had already accepted may still be shown by the old worker, with
their own titles (setup pushes say they are a setup). A deletion retried by a device gets `404` from an older release and stays retired until rolled forward. Older
releases do not clean `pp:dev:*`, so the rollback first copies the new release's server bundle to `/opt/penge/device-cleanup/`
(outside `releases/`, so pruning cannot remove it) and adds a drop-in to `penge-check.service`: `ExecStartPre=-/usr/bin/timeout --kill-after=10s 120s` that bundle's
`admin.mjs device-cleanup` (the checker's clean-up, without sending, with `/etc/penge/server.env`). The `-` makes systemd start the old
checker whatever it returns; the command logs a device failure and exits 0; and `timeout` kills it after at most 130 s, far inside
the service's 15-minute start limit, so a hung clean-up (Valkey unreachable, a script that never returns) cannot stop email either.
Tested with Valkey stopped and with a clean-up that never returns. systemd runs it before each run
of the old checker in the same service activation, so the two never overlap and no lock shared with the old code is needed. Rolling
forward removes the drop-in and the copy. Nothing outlives its stated life by more than the time between clean-ups. Email works unchanged. Tested: each
older release starting with the new `server.env` and `off`; rolling back with an active alert, an open old tab and a retired
credential; `device-cleanup` against old releases' data; rolling forward again.

## Verification

1. **Tests first** (vitest, fake clock, `MemoryKv`, every atomic script also on a real Valkey in Docker): one operation at a time
   (a second tab joins; nothing cancels except turn-off); turn-off during a setup whose acknowledgement is in flight (the retired
   credential's alert is found and deleted); setup and ready check
   (right and wrong credential, operation, `seq` and nonce; a worker on other storage; turn-off at every worker step; lost
   answers both ways with the nonce kept; expiry before and during acknowledgement; two tabs; dispatch crashes and retries; display
   failing); the last result and replays; one alert per endpoint and a copied subscription (no takeover, no deletion); lost
   credential; re-setup and change with stale revisions and a vanished target; test; turn off with and without the server,
   `unsubscribe()` failing, a fresh opt-in afterwards, and delayed requests with a retired credential; rotation against gone, an
   older generation, deletion, expiry and a second rotation; lifetime, renewal retries, the clock never shortening an alert,
   clean-up on a cooldown run; every limit with the global gate first, the ceiling and reservations under concurrency; unknown
   credentials creating nothing; the memory guard, the full workload at the ceiling and out-of-memory errors (email still queued);
   the owner token and its revocation; every mode; scan demand and the cursors; queueing atomicity with the lock check;
   independent batches (each failing while the other works), domestic and abroad deadlines; pace, cap, windows, overflow and
   reboots; claims, every settlement row, release, and recovery after a lost lock; the lock scripts; the old pages' contract with
   the real `05cee09` and `157bad9` bundles; backups version 1 and 2, both identity checks and the old importer; statistics across
   the schema change; log redaction; the worker against a fake `self`.
2. **Mac Chrome and Firefox** on the local stack: notifications only, email only, both, one failing; denied and dismissed; the ready
   check; change; test; tap; turn off online and offline; blocked; ended (clock moved); delete this device's data; an open `05cee09`
   page; rollback and forward; the layout audit at 320 to 1280 pixels for every new state.
3. **The owner's phone**, with the owner's yes: a Chrome tab, an app installed from Chrome, and the release app.

## Rollout

1. "Leaving the channel design behind", above. 2. The owner sets up notifications on the phone (tab, installed, release app) and the
Mac with the owner link; real alerts or tests; the next morning's numbers. 3. Publish the privacy page; `PUSH_MODE=live`. 4. Android
1.1.0 to Play with Data safety updated. 5. Docs: `deploy/README.md` (operating notifications, emergency stop, keys, backups, rollback,
`device-cleanup`), `docs/how-it-works.md`, `docs/alert-timing.md`, `docs/android.md`, the privacy page, the legal register.

## Out of scope

Linking a notification alert to an email address; keeping a person's email and notification choices in step; a list of all one's
alerts across devices; notifications in an iPhone Safari tab; notifications of dates already open when the alert was set up.

## Codex reviews

Before draft 1, Codex compared one alert record with optional email and devices against two independent kinds of alert, and polling
against push, and recommended this design.

Draft 1 → 2 (32 findings) and 2 → 3 (32 findings): nonce secrecy; idempotent setup; fenced activation; the Web Lock never held across
waits; the `deviceAlerts` handshake; offline turn-off; renewal separate from reads; clean-up before the cooldown; scan demand and
atomic queueing for both kinds; independent delivery; claims; one deadline and limit; atomic lock scripts; settlement for every
answer; caps and windows; ceiling; abuse limits; memory; owner token; the old pages' exact contract; migration with writers stopped
and backups first; rollback with push off; the importer; reporting; the privacy inventory; versioned API; the form's switches; a
per-device `seq`; captured identities for re-setups and rotations; dispatch state; `/mine` naming operations; a separate IndexedDB
database.

Draft 3 → 4 (35 findings, all taken, partly by simplifying):

- **Cancellation is local**: the server activates only what the device's current operation acknowledges, so a delayed or replayed
  setup simply expires. Setup tickets and tombstones are gone (findings on pre-admission cancellation, delayed requests, ticket
  limits, credential-before-ticket ordering).
- **Turn off unsubscribes first**: after that the push service answers `410`, so the server deletes the alert at its next send even
  if the `DELETE` never arrives; no per-incarnation suppression and no silent pushes (findings on suppression lifetime, the
  visibility requirement, the unsubscribe race, rollback of the worker's suppression).
- **Only the checker writes delivery state**, under its lock, and jobs are signed plain JSON (offices and dates, not personal), so
  scripts can merge and filter them (finding on encrypted read-modify-write).
- Worker steps each re-check the current operation; per-operation notification tags; the dispatch state is claimed atomically with
  a dispatch id; unacknowledged setups are expired by clean-up with a recorded result; ordered activation branches, a vanished
  target answers `changed`; maintenance by an alert's own credential needs no owner token; explicit bounds for jobs and
  per-credential state; a global gate before any per-key counter; email keeps queueing when memory runs short, and out-of-memory
  is tested; clean-up drops expired queued and held dates; claims carry the run id, have no TTL, and are recovered only by the run
  holding the lock; pace stamps set at claim and restored only if unchanged; the send step re-checks ages, mode, pause and backoff;
  separate domestic and abroad sending minutes; the queueing cut-off and incarnation filtering; an exhaustive transport result;
  explicit request, storage and push limits; renewal after a successful read, retried while visible, never moving the end earlier;
  the server clock only; owner-token revocation needs a restart and is recorded per setup; importer checks in both directions;
  a complete migration matrix; waiting for the running check instead of `stop`; backup file names the expiry script recognizes; a
  rollback clean-up command; rewrite timing and plural outstanding notifications in the privacy text; counters with units and
  atomic increments under a versioned prefix.

Draft 4 → 5 (27 findings, all taken): a first setup requires, at admission and activation, that the credential owns no alert;
an unwanted activation is deleted by its incarnation only; admission checks a repeat first (bound to a request digest) and only
then the `seq`; every outcome is written as the operation's result, with the reservation released, and the last 5 results are kept
for 24 hours; a lost-credential replacement needs no reservation; a second opener joins a current rotation; turn-off unsubscribes the
current subscription, records and recovers an unsubscribe in progress, sends the deletion independently, and no longer promises a
`410`; setup records have no TTL (clean-up ends them); the API never deletes delivery work, only the checker does; device jobs are
unsigned and re-validated against the catalogue when a notification is built; memory: the device namespace at its limits fits in 25%,
admission reads memory live, and queueing retries without notification work when memory runs out; global gates and per-key limits
for every class, deletion never limited per credential, polling shared across tabs; only verified-open dates are claimed;
unattempted put-backs do not use a try; at most one attempt per alert per run; the count holds only accepted and uncertain sends;
email keeps one serial pass, notifications run their own; pace stamps follow `clock.ts` with no TTL; restores run stopped and one at
a time; the real key names `EMAIL_HMAC_KEY` and `TOKEN_SECRET`; setup pushes use the `v: 1` envelope so old workers show them
correctly; rollback clean-up every 5 minutes; the nonce is sealed and setup retention is stated as it is.

Draft 5 → 6 (19 findings, all taken): an unwanted activation is undone only for a first setup, matched by the operation that
created the alert and its incarnation, by the worker at once or by the page later from a persisted list of cancelled operations;
acknowledgements that do not match the exact setup change nothing; a change names the incarnation as well as the revision;
bounds for credential states, replacement candidates and expired setups (a 24-hour TTL, and sorted-set members that keep the
operation); request gates before the repeat lookup; a setup is admitted only when its push can be sent now, so nothing waits for a
mode change; setup polling stops only at its own operation's result, and only visible pages poll; the abroad scan runs beside
domestic delivery and always resolves its signal, while email keeps one serial consumer; rollback pauses push first and waits for
the running check; jobs carry the group size; a null subscription is recreated with the stored VAPID key, or the row asks for setup;
an exhaustive table of setup outcomes; "this setup didn't finish" wording; work retention stated as clean-up timing; Valkey's
snapshot file (production writes `dump.rdb` at least hourly) added to the retention inventory, for email too; turn-off reports
unsubscribing and server deletion separately; a transition-to-counter list.

Draft 6 → 7 (20 findings, all taken, by simplifying): **one operation at a time per device, never cancelled** — a second tab or press
joins it, and only turn-off interrupts, by retiring the credential; any alert later found under a retired credential is unwanted and
is deleted, retried until the server reports none (this replaces the undo of cancelled operations, their bounded lists and the
historical-result rules); success is reported only when the current alert is the operation's activation; turn-off records the
retirement and the unsubscribe task in one local step; a rotation that answers `changed` retries once against the current alert;
`goneGeneration` is kept in the alert's record; **offices, group size and pace are plain fields** (only the subscription is
encrypted), so scripts read choices directly and Node-prepared writes are compare-and-set; **queueing is two writes with a fan-out
list**, so a crash or a memory refusal never blocks email and is resumed by the next run; the second write re-checks recipients; a
physical record count with its own limit, and admission removes a few expired things, so storage stays bounded while the checker is
down; in the domestic batch an alert whose oldest work is abroad waits for the abroad batch; group lookups favour pairs with held work;
a shared push-service backoff and per-process limits for setup and test sends; a complete test-result mapping; request classes with
separate pools, classified before charging; the wall-clock limitation stated; Microsoft named; push services' own retention
distinguished from `TTL`; one retention table.

Draft 7 → 8 (18 findings, all taken): device scripts use the flagged form (memory refused only before they start) and validate
everything before their first write, so they write all or nothing; the notification recipient rule (activated before the opening's
announcement, current choices match) gives the same answer whenever computed, so the fan-out list holds only openings, is bounded
(2,000) and is skipped under memory pressure; records are alerts, operations and `ended` records, deleted only by accounted scripts
on a deadline set (no TTL), with a daily recount, and each alert counts with its fixed delivery footprint so delivery cannot outgrow
admission; tries pruned with their dates; the server answers `busy` to a second operation and ends an expired one first; the device
keeps the exact request so any tab can resume it; a complete set of setup, acknowledgement and test outcomes, terminal or not; an
unsubscribe claim blocks setups until resolved; a subscription change during another operation is remembered and rotated after it;
kind-specific ownership checks for rotations; an ingress gate, then classification, then charging, so unknown traffic cannot spend
known or reserved pools; group lookups split between held work and the rest; the checked time is the oldest verification, with group
fetch times recorded; a lock name of its own; an explicit `Origin` policy for device routes, leaving the one-click unsubscribe as it
is; turn-off deletes the `ended` record too; deleted data leaves the database files only when both the append-only file and the
snapshot have been rewritten.

Draft 8 → 9 (15 findings, all taken): reads need no body or `Origin` (the credential header cannot be sent cross-site without a
preflight the server never grants), changes do, and `DELETE` sends `{}`; the ingress gate is a fixed set of 4,096 hashed buckets, and
class pools are charged global-first, so counters are bounded; storage is counted in units and an admission that may create an alert
reserves the alert's units too; a deleted alert stays charged as garbage until its delivery keys are gone; reclamation scripts run
`allow-oom`; the recipient rule is stated as judged when the second write runs, not claimed identical; fan-out entries are one per
office, date and group size, with a byte bound; joining only an identical operation, others wait their turn; a first setup whose
subscription changed starts again with the saved choices; an unsubscribe claim on a different subscription is resolved, never left
blocking; only terminal answers end an operation; a dispatch state table with `retryable` and `failed`; the abroad batch always runs, so
deferring domestic work never strands it; a give-back never recreates an expired counter; "last opening that reached us" in the privacy
text, and the row says when a renewal is failing.

Draft 9 → 10 (13 findings, all taken): setup dispatch re-checks operation, expiry, mode, pause, backoff and the endpoint limit after
taking a send slot; a driving page (elected by a Web Lock) repeats retryable dispatches and late acknowledgements on a fixed schedule;
the worker shows "ready" only after checking the activation is current, and corrects only its own notification if it went stale; the
highest `seq` lives with the alert while it exists; an alert's units include the `ended` record it may leave; fan-out entries refer to
`clock.ts` stamps stored once per list; explicit failure paths for both queueing writes, with the second in resumable chunks under a
time bound; a replacement needs a reservation only when it creates an alert; a classification matrix by route and state; the
acknowledgement pool sized from the setup pools; a total send deadline that aborts the request and holds the slot until it ends; a
pinned rollback clean-up bundle and timer outside the pruned releases; browser storage and journal entries in the retention table.

Draft 10 → 11 (9 findings, all taken): old pages cannot touch a new alert's subscription because they act only with a channel-design
credential, which production never issued (checked by the migration, and tested with a suspended old page); notification fan-out is
kept in separate bounded batches, at most 5 pending, never overwritten, a new one dropped (counted) when full; the first deploy runs
with a configuration both older releases start with, so the deploy script's automatic fallback is safe and needs no clean-up; the
driving page drives until the result or expiry, hands over when hidden, and the 30-second message no longer stops it; acknowledgements
are capped at 5 per operation and the reserved pool sized from that; the worker's final check is against the credential and the
activation, so a page finishing the operation first is success; tests settle `gone` by the same rule as sends, including a pending
rotation; byte bounds for records and jobs, with a compact job form and enforcement at every merge and admission; an operation's result
lasts until the next operation or 24 hours.

Draft 11 → 12 (7 findings, all taken): old pages are made harmless by procedure, not by a claim about server data (only browsers that
opened the owner link could hold a local channel credential; the owner closes their tabs after the deploy, and tests show both cases),
and the migration's stop rule is consistent; an **epoch** recorded before any subscribe and increased by turn-off abandons a setup or
re-subscription that finishes after a turn-off; after its acknowledgement the worker accepts a completed, still-current activation as
success; acknowledgements cost an operation only when they reach the atomic step, with the page retrying every 15 s until expiry; a
dispatch blocked by its gate records why and when to retry, and the driving page retries `unsent` too; notification fan-out runs inside
the notification pass with a 10-second budget, never ahead of scans or email; rollback clean-up runs as a pre-step of the old checker's
own service, so systemd serialises them.

Draft 12 → 13 (5 findings, all P2, all taken): an abandoned setup removes a subscription only if nothing newer uses it; legacy
credentials are handled on every browser (anyone could have made one): the new worker reloads every open page on first activation, a
new page retires any legacy credential and its subscription before setup, and the remaining case (an old tab frozen for over 48 hours)
is stated, ending in "set up again"; a subscription reported gone is removed before subscribing again, for setups, tests and sends;
credentials without a proven alert read from a separate pending pool, so unproven setups cannot use established devices' capacity;
clean-up has its own error boundary in the checker, and the rollback pre-step can never stop the old checker.

Draft 13 → 14 (4 findings, all P2, all taken): a gone subscription leaves an end record with its fingerprint (in the unit the alert
reserved), which `/mine` returns, so the device can remove it later; an operation has explicit phases (`preparing`, `ready`, `sent`)
and any page can carry it on from its phase; activation is a `clock.ts` stamp and an unknown order counts as "not before"; the rollback
pre-step is wrapped in a 130-second hard timeout, far inside the service's start limit.

Draft 14 → 15 (3 findings, all taken): which alerts get an opening is decided by a Valkey counter shared by activations and fan-out
batches, not by boot-bound stamps (which would have cut off every existing alert after a reboot, and every alert on the Mac); the
pending read pool is sized from the polling schedule (2 s for 30 s, then 10 s; about 50 reads an operation) with a load test; admissions
also delete overdue results and end records, and the retention table says what happens if both the checker and admissions stop.

Draft 15 → 16 (2 findings, all taken): an alert's order is fixed when its incarnation is created, so rotations and re-setups never
make it miss openings already queued; the remaining old-tab case is described for both branches of the old code (confirmed: at once;
not confirmed: after 48 hours), and both are tested.

Draft 16 → 17 (1 finding, taken): turn-off writes the unsubscribe claim in the same local step as the retirement and the epoch
increase; a retired credential is kept until both its server deletion and its unsubscribe are resolved, and every opening resolves both
before any setup, with or without a current credential.
