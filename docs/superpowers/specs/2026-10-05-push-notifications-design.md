# Push notifications: design

Status: draft 14 for the owner's review (5 October 2026), after thirteen adversarial passes by Codex
(gpt-6.1-sol, medium): 21 findings, then 13, 9, 6, 4, 3, 2, 2, 2, 2, 2, 2 and 1. Dispositions are at the end. Nothing here is built
yet.

## What the owner asked for

- Push notifications are **another channel on the same alert subscription**: the same offices, group size
  and pace, delivered by email, push, or both.
- The toggles live in the **email alert form** (`AlertSheet`).
- The app **detects whether it runs installed** (the Google Play app, or an installed PWA) or in a browser
  tab. Both may get notifications; where a browser cannot (iOS Safari in a tab), no toggle is offered.
- A person **may turn email off** and get push only. The email address stays the identity.
- **Existing subscribers enable push by submitting the form again.** No manage link in emails for now.
- Process: backups before any server change, documentation, verification on the Mac (Chrome and Firefox)
  and on the owner's phone over wireless debugging, and every concern settled locally before anything
  reaches the server or GitHub. Codex reviews every spec, plan and diff.

## What does not change

- The confirmed email address is the identity. Confirmation, deletion, recovery and one-click
  unsubscribe work from it. The encrypted `email` field of `pp:sub:<id>` keeps its meaning and format.
- **One alert decision per person**: pace, the per-person daily cap, the 3-hour announcement window,
  "only dates verified open in this run", held alerts and the outbox. Push is a second way to deliver the
  same decision, never a second decision.
- **At most once**: a send is claimed before it goes out, so a crash can lose an alert but never repeat it.
  This holds for every channel and device.

## Where the app runs, what it can do, and what is allowed

`apps/web/src/notify/context.ts` keeps three separate answers:

1. **Context** (only chooses wording):
   - `play`: the first load's `document.referrer` parses as `android-app://` with the package exactly
     `com.alphaexperiments.pengepassportph`. Remembered in `sessionStorage`. A build made with
     `VITE_LOCAL_DEBUG=1` (the local stack only; still a production build, so the worker registers) also
     accepts the debug package `com.alphaexperiments.pengepassportph.dev` and shows the detected context in
     a small debug line, so the phone gate can see it. The release build fails if that flag is set.
   - `installed`: `display-mode` is `standalone`, `minimal-ui` or `fullscreen`, or `navigator.standalone`.
   - `browser`: otherwise.
2. **Capability** (in every context): a secure context, `serviceWorker`, `PushManager`, `Notification`,
   a service worker that registered successfully, and the server's `push` flag on `/api/status`. **iOS in a
   tab** (iPhone/iPad user agent, not standalone) is treated as unable, whatever the APIs say.
3. **Permission and binding**: `Notification.permission` plus `pushManager.getSubscription()` at the moment
   of showing, never a stored "on" flag.

| Context and capability | What the form shows |
|---|---|
| `play` or `installed`, capable | "Notifications on this device" switch |
| `browser`, capable | "Browser notifications" switch, and a line suggesting the app |
| iOS tab | No switch. "Add this site to your Home Screen to get notifications." |
| Otherwise not capable | No switch. "This browser can't show notifications; email still works." |

Detection is never a security check; the server checks everything again.

## The form

`AlertSheet` gets a "How should we tell you?" group above the submit button: an **Email** switch (on by
default) and a **Notifications** switch (off by default). At least one must be on (checked in the form and
again by the server). The email address is always required.

`main.tsx` keeps the service worker registration's outcome (registered, failed) instead of discarding it.
Turning the notifications switch on, inside the click:

1. `Notification.requestPermission()` first, synchronously in the handler, so the gesture counts.
2. `granted`: wait for an active worker, **at most 10 s**; then `pushManager.subscribe({ userVisibleOnly:
   true, applicationServerKey })`. A timeout, a failed registration or a failed subscribe turns the switch
   back off with the reason.
3. `denied`: the switch turns back off, with how to allow notifications (Chrome: site settings; Firefox:
   the padlock; Play app: Android settings › Apps › PassportPH › Notifications).
4. Dismissed: back off, nothing else.
5. If the switches would leave no channel, Email turns back on.

## Binding a device

The device makes its own **credential** before anything is sent: 32 random bytes, kept in **IndexedDB**
(the page and the service worker can both read it). The server only ever stores its SHA-256 hash.

1. **Subscribe.** `POST /api/subscribe` gains `emailOn`, `pushOn` and, when push is on, `pushCredentialHash`
   and a coarse `device` label made from the user agent ("Chrome on Android"). No endpoint is sent. The
   server also records `pp:push:pending:<credential hash>` (expiring with the confirmation link, 48 h), so
   the device can be told `pending` before anyone confirms. The browser marks its credential
   **unconfirmed** with the time it asked.
2. **Preview, then confirm.** A new read-only `POST /api/confirm/preview { token }` returns what the
   request would do: offices, group size, pace, channels, and for push "on the device that asked (Chrome on
   Android, 5 Oct 10:02)". It neither uses nor changes anything; it is rate-limited like confirm. The
   confirmation **email** says the same. The confirmation page loads the preview first and only then enables
   its button, so a person confirming a request they didn't make sees that it would switch their email off
   or add a device they don't have.
   - The server enforces it: for a pending request with channel fields, `POST /api/confirm` must carry
     `acknowledge: { emailOn, pushOn }` matching the request. A token-only confirm (an old page left open
     across the deploy, which can also receive a new link through a fragment change) is answered 409
     **without** using up the token or changing anything, with the message "This page is out of date.
     Reload it, then open the confirmation link from your email again." (the old page has already removed
     the token from its address, so reloading alone would lose it). Pending requests from before this
     change (no channel fields) still confirm with the token alone. A test drives the old `Confirm.tsx`
     against a new push-only request, then reopens the link in the new page and confirms.
3. **Confirming** applies the channels and, when push is on, creates the device record at once in the state
   **awaiting endpoint**, keyed by the credential hash, under the subscriber's existing address lock.
   - The credential's owner is reserved **atomically across subscribers** (`pp:push:cred:<hash>`, `SET NX`).
     If it already belongs to **this** subscriber, the existing device is kept as it is (no reset of a
     registered endpoint, no extra slot). If it belongs to **another** subscriber, the push part is not
     applied and the page says "this device already gets alerts for another address; turn them off there
     first".
   - A credential that was **turned off** (below) is never bound again: confirmation skips the push part.
   - If the push part cannot be applied (the credential belongs to another subscriber, or was turned off):
     - and the request has **email on**: everything else is applied and the page says push was not turned
       on, and why;
     - and the request has **email off**: **nothing** is applied, the token is not used up, an existing
       subscription keeps its current choices, and the page says why: the person can turn notifications
       off for the other address on this device, then **submit the form again** (the browser then makes a
       fresh credential, since turning off revokes the old one), push only if they like; or submit it with
       email on. Email is never turned on without the person choosing it. Tested through to a successful
       confirmation and registration, with a new address and an already-owned credential, and with an
       existing subscriber.
   - **Crash-safe order.** Each address has **one** reserved subscriber id while it has no subscriber:
     `pp:reserved:<address index>`, created with `SET NX` by the first subscribe request and shared by every
     pending request for that address (and by old pending records, which have none of their own). It
     **expires with the latest pending request** (48 hours from it): each new request, under the address
     lock, extends it but never shortens it, so an abandoned sign-up leaves nothing after its links
     expire. Any
     confirmation uses the existing subscriber's id, or else that reserved id, so every confirmation and
     every retry for one address lands on the same id.
     Confirmation then runs, under the address lock: (1) `pushBind` (idempotent for the same owner),
     (2) write the subscriber with the channels decided by (1), (3) use up the token. A crash after (1)
     or (2) is finished by retrying the link.
   - **When the subscriber doesn't exist yet**, `pushBind` gives the device's keys (`pp:push:<id>`,
     `pp:push:meta:<id>`, the `cred` entry) an expiry of 72 hours **and** extends `pp:reserved:<index>` to
     at least as long, in the same script. Step (2) removes the devices' expiry and deletes the reservation
     in the same atomic write that creates the subscriber. So the reservation always outlives any
     temporary device state, whatever the confirmation link's own expiry.
   - **Deleting an address** removes devices under its subscriber id **and** under `pp:reserved:<index>`,
     then deletes the reservation, then the pending requests.
   - Tests: kill the process between each step and retry the token; kill request A after (1), confirm
     request B for the same address, retry A, and check push is on the one real subscriber with A's
     email-off choice kept; bind just before the link expires, kill, move past the expiry, delete the
     address, and check that every device key, metadata entry, `cred` entry and the reservation are gone.
4. **Registering the endpoint.** The device that holds the credential calls `POST /api/push/device
   { credential, subscription }`: on the confirmation page when confirmed in the same browser, otherwise the
   next time the app opens, and every 30 s while the sheet's "check your email" view is open. Answers:
   `registered`, `pending` (a pending request exists, not confirmed yet), `stale` (see below), `missing`
   (no device and no pending request). It is **idempotent**: the credential was the device's from the
   start, so a lost answer is simply retried. The same call later replaces the endpoint when a browser
   rotates it.
   - Each call carries a **revision**. IndexedDB (shared by page and worker) keeps the pair *(revision,
     fingerprint of the whole subscription it was for: endpoint, `p256dh` and `auth`)*, so a renewal that
     keeps the endpoint but changes the keys also raises the revision. Whenever the browser's current subscription differs from the
     stored fingerprint, whoever notices (the page on open, or `pushsubscriptionchange`) raises the
     revision and stores the new pair, then registers that frozen pair. All of that (calling
     `getSubscription()`, comparing, raising the revision, registering) happens **inside one Web Lock**
     (`navigator.locks.request('pengepassportph-push', …)`), which the page and the worker share, so neither
     can act on a subscription it read before the other changed it. A browser without Web Locks is treated
     as not capable.
   - **Everything that changes this browser's push state uses that same lock**: creating a credential,
     reconciling, registering, turning off, and cleaning up after `missing`. A credential is cleared only
     if it is still the one being removed, so a slow turn-off in one tab cannot wipe a fresh credential
     another tab just made. A test pauses a turn-off in one tab while another tab recovers and submits
     again. The
     server applies a higher revision, accepts the same revision with the same whole-subscription
     fingerprint as a repeat, and refuses a lower one (or the same revision with a different fingerprint)
     as `stale`, so a delayed old endpoint or old keys can never overwrite newer ones. Tested with a
     renewal that keeps the endpoint and a delayed registration carrying the old keys. On `stale`, the page reconciles again, which raises the
     revision if the subscription really changed.
   - An **unconfirmed** credential is never discarded on `missing` until its 48 hours are up, so polling
     before confirmation cannot destroy a sign-up in progress.

Rules:

- **One owner per endpoint**, enforced atomically across subscribers: `pp:push:endpoint:<hmac>` is created
  with `SET NX` (value `<subscriber id>/<device id>`). If it already names a different device, the server
  answers `endpoint-taken` without saying whose. The browser then calls `unsubscribe()`, subscribes again
  for a fresh endpoint, and retries once; that is also how a browser recovers if someone copied its old
  subscription. An endpoint index entry is released only if it still names the releasing device (a
  compare-and-delete, a short Lua script in `kv.ts`, tested on Valkey and `MemoryKv`).
- **Devices are enumerable**: all of a subscriber's devices, awaiting or registered, live in one hash,
  `pp:push:<subscriber id>`. Deleting a subscriber deletes the hash and releases each device's endpoint.
  An awaiting device left unregistered for 48 hours is dropped the next time the hash is read.
- At most **5 devices per subscriber**, awaiting ones included. A sixth is refused at confirmation with
  "turn notifications off on another device first"; nothing is evicted silently.
- Every change to a subscriber's devices (create, register, replace, remove, failure cleanup) runs under
  that subscriber's **address lock** (`withAddressLock`, exported from `subscribers.ts`).
- **Turning off** (`DELETE /api/push/device` with the credential) removes the device, releases its
  endpoint and credential entries, and marks the credential **revoked** (`pp:push:revoked:<hash>`, kept
  for 72 h, longer than any confirmation link lives), so a second confirmation email for the same browser
  cannot bring it back. The browser calls `unsubscribe()`, clears IndexedDB, and makes a new credential
  next time.
- If the server answers `missing` (turned off elsewhere, deleted, or a restore), the page clears the
  credential, unsubscribes the browser, and says "Notifications are off for this device; submit the form
  to turn them on again".

### Checking an endpoint (SSRF and abuse)

Before it is stored and again before every send: `https:`, default port, no user info, at most 1,024
characters, host on an allowlist of browser push services (`fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`; pinned by a test and
confirmed against current browsers during implementation). `keys.p256dh` decodes to a 65-byte
uncompressed P-256 point, `keys.auth` to 16 bytes. Sent by `web-push` with a 5 s timeout, no redirects.
Device calls and tests are rate-limited per IP and per device (a test: 3 an hour).

## Storage (Valkey)

| Key | Holds |
|---|---|
| `pp:sub:<id>` new fields `emailOn`, `pushOn` (`1`/`0`) | Channel choice. Absent: `emailOn=1`, `pushOn=0` (every existing subscriber). The `email` field is untouched. |
| `pp:push:<id>` (hash: device id → sealed JSON) | Per device, encrypted: endpoint and keys (once registered), label, created, last success, last failure |
| `pp:push:meta:<id>` (hash: device id → `state|revision|credential hash|endpoint hmac|subscription hmac`) | What the atomic scripts compare, unencrypted because it holds no secret: a state, a number and three keyed hashes. The endpoint HMAC is for ownership; the subscription HMAC (server-computed over the canonical endpoint, `p256dh` and `auth`) is for telling a repeat from a change. Written in the same script as the sealed record, always together. |
| `pp:push:endpoint:<hmac>` | `<subscriber id>/<device id>`; one owner per endpoint |
| `pp:push:cred:<credential hash>` | `<subscriber id>/<device id>`, to find a device from its credential |
| `pp:push:pending:<credential hash>` | Set of pending confirmation-token hashes for that credential; 48 h |
| `pp:push:revoked:<credential hash>` | Marker that the credential was turned off; 72 h |
| `pp:pending:<hash>` | Gains `emailOn`, `pushOn`, `pushCredentialHash`, `device` |
| `pp:reserved:<address index>` | The subscriber id an address will get, while it has none; outlives any temporary device state |
| `pp:pending:channels` | Set of pending-token hashes whose request touches channels (push on, or email off), so a downgrade can find them; members whose pending record has expired are dropped when read |

Index entries (`endpoint`, `cred`, `pending`, `revoked`) hold only random ids and keyed hashes, no
address, endpoint or key.

**Every change to who owns a device is one atomic step.** `kv.ts` gains three operations, each a single
Lua script on Valkey (so nothing can run between its parts, and a crash leaves either all of it or none)
and an equivalent single-step implementation in `MemoryKv`:

- `pushBind(subscriber, device, credentialHash)`: fails if the credential is revoked or owned by someone
  else; otherwise reserves the credential and creates the awaiting device (or keeps the existing one, for
  the same owner).
- `pushRegister(subscriber, device, revision, endpointHmac, subscriptionHmac, sealedDevice)`: on a lower
  revision, or the same revision with a different subscription HMAC, fails as `stale` and writes nothing;
  the same revision with the same subscription HMAC is a repeat (no change); a higher revision reserves
  the new endpoint (refusing one owned by another device), stores the device and its metadata, and
  releases the old endpoint only if it still names this device. Tested on Valkey and `MemoryKv` with the
  same revision and endpoint but different keys: `stale`, nothing written.
- `pushRemove(subscriber, device, { revoke, onlyIfEndpoint })`: deletes the device and, if they still
  name it, its credential and endpoint entries; with `revoke`, also sets the revoked marker; with
  `onlyIfEndpoint`, does nothing unless the stored endpoint is that one (the late-`410` case).

Each script reads only `pp:push:meta:<id>` and the index keys, never the sealed record (Lua cannot
decrypt). A Lua error does **not** undo writes already made, so every script **checks everything first
and writes only at the end**, with no step after the first write that can fail on its input (types and
arguments are checked by the TypeScript wrapper before the call, and again at the top of the script).

The same tests run against `MemoryKv` and a real Valkey in Docker:

- the interleavings found so far (turn-off between two confirmations under different address locks, a
  `410` after a rotation, two subscribers registering one endpoint);
- a script refused for bad input changes nothing;
- the caller dying, or the answer being lost, **after** a script succeeded: the retry is a no-op or the
  same result (every operation is idempotent).

Device JSON is sealed with AES-256-GCM under the existing `EMAIL_ENC_KEY`, with associated data `push:v1`,
so a sealed address can never be read as a device or the other way round.

**Compatibility.** A pending record from before this change confirms as email on, push unchanged. A
request from an old cached page (no channel fields) changes only offices, group size and pace: an existing
subscriber keeps their channels; a new one gets email on, push off.

## Sending (the checker)

`consider()` still makes one decision per person and claims it (`lastAlert`, the per-person counter)
before anything goes out.

### Each channel is available or not, separately

- **Email is available** when `MAIL_MODE=live`, mail is not paused, fewer than 3 mail errors in a row this
  pass, and **today's** limit has room. The limit block remembers the Manila day it was hit and is checked
  again when the day changes, so a run crossing midnight gets the new day's allowance.
- **Push is available** when `PUSH_MODE` is `owner` or `live`, push is not paused (`pp:push:paused`), and
  the pass's push budget (below) is not spent. (`owner` limits who can sign up, not who is delivered to.)
- A person's **deliverable channels** are the available ones they turned on (push also needs at least one
  registered device).
- None deliverable: everything waits, uncharged, as today. This is the only case that holds work, and the
  run carries on for the next person. `runCheck` runs the abroad delivery pass unless both channels are
  unavailable.
- **Email in dry-run** (`MAIL_MODE=dry-run`, local and tests): a simulated email counts as delivered only
  for someone with push off, which is today's behaviour. For someone with push on, only push outcomes
  decide.
- When email is unavailable and push delivers, **that decision's email is not kept for later**: the person
  has been told. The next email carries the next news.

### Outcomes, settled after every attempt for the decision has finished

| Email | Push (any device accepted?) | Result |
|---|---|---|
| sent | any | Delivered. Charged once. |
| refused for sure | accepted or uncertain | Delivered. The email allowance is refunded on the day it was charged; no email retry. |
| refused for sure | none (all refused) | Undo everything; retry later, as today (`MAX_MAIL_ATTEMPTS` per date). |
| uncertain | any | Delivered (claim kept), as today. |
| not deliverable | accepted or uncertain | Delivered by push. |
| not deliverable | none (all refused) | Undo everything; retry later. |

Per push device: `201` accepted; `404`/`410` gone; `413` a bug (logged); `429`/`5xx` refused; timeout or
connection reset uncertain (so never sent twice). A **gone** device is removed under the address lock
**only if its stored endpoint is still the one that was sent to**, so an endpoint rotated meanwhile is kept.
Success and failure notes on a device follow the same check. Nothing else ever removes a device.

### Time and the lock

- Push sends share a pool: at most **8 in flight**, 5 s timeout each, a **60 s budget per pass**.
- A slot is **reserved before the claim**. When the budget is spent, push becomes unavailable for the rest
  of the pass (email carries on where available).
- Outcomes are settled per decision once that decision's attempts have finished, and the pass waits for
  every started attempt before it ends.
- `holdLock()` (renew and check ownership) runs before each person once 30 s of delivery have passed, so a
  slow pass cannot outlive the 20-minute lock.

### What a notification says

- **One notification per decision**, like one email: `Dates open at Antipolo` or `Dates open at 3 offices`;
  body `Thu 9 Oct, Mon 12 Oct and 4 more · for 2 people`, cut to stay under 3 KB.
- No `topic`, a unique `tag` per decision: an alert is never silently replaced.
- `TTL` 30 minutes, `urgency: high`, payload encrypted by `web-push` (`aes128gcm`). Always shown.
- Tap: the worker builds `<scope>?office=<first office>&date=<first date>&people=<n>` from its own scope,
  navigates an open window of the app there and focuses it, or opens one. `Home.tsx` gains `people=`.

## The service worker

An installed copy of the app already has an **old** worker without push handlers, and without a message
handler, so it cannot answer a handshake. Before subscribing, the page asks the active worker for its
version and capabilities (`postMessage`) and waits **1 s**. Silence, or an answer without push, means
old: the page calls `registration.update()`, waits for the new worker to take over (it calls
`skipWaiting` already; `controllerchange` signals it), and asks again, all within the overall 10 s. No
push-capable worker by then: no subscription, and the switch says why. A test starts with the real old
`sw.js` active.

`apps/web/src/sw.js` gains `push` (unreadable payload: a generic "New dates are open", never silent),
`notificationclick`, and `pushsubscriptionchange` (a fast path: re-subscribe and register with the
credential from IndexedDB). The page also **reconciles on every open**: with a credential and permission
granted, it compares `getSubscription()` with the server's view (`POST /api/push/device` is idempotent) and
re-subscribes when needed; with permission revoked, the row says "Notifications are blocked on this
device" and offers Turn off.

## On the home page

When this device has a credential: "Notifications on this device: On · Send a test · Turn off", or
"Waiting for you to confirm by email" while awaiting, showing the reconciled state.

## The Android app

- `android/twa-manifest.json`: `enableNotifications: true` (notification delegation) and
  `monochromeIconUrl` pointing at a new white-on-transparent status-bar icon. Version code 2, 1.1.0.
- Inspect the generated project for the delegation service and the Android 13+ `POST_NOTIFICATIONS`
  request.
- Owner, by hand: add Play's app-signing certificate to `assetlinks.json` (pending since version 1; without
  it the Play-installed app is not trusted and delegation cannot work), update Data safety, upload.

## Privacy and data lifecycle

- Privacy page, published **before** push goes live: what a push subscription is; that notifications pass
  through the browser maker's push service (Google for Chrome and the Play app, Mozilla for Firefox, Apple
  for Safari), encrypted; how to turn them off; how long data is kept.
- `docs/legal/README.md`: new rows (devices, credential hashes, endpoint index). Play Data safety: device or
  other IDs, for app functionality, processed by push providers as service providers; the owner confirms.
- `/delete-data` and one-click unsubscribe remove the device hash, the credential and endpoint index
  entries (`removeAddress`).
- **Backups get format version 2**, with the channel fields. The old release's importer refuses anything
  but version 1, so it can never restore a push-only subscriber as an email subscriber. The new importer
  reads version 1 (everyone email on, push off) and version 2. To restore a version 2 backup into the old
  release, `admin.mjs backup-to-v1` writes a version 1 copy **without** the people who turned email off,
  saying how many it left out. A test runs the old importer against a version 2 backup.
- **A restore never displaces a live subscriber.** Today's importer points an address at the restored id
  even if the address now belongs to a different subscriber, which would leave that newer subscriber (and,
  with push, their devices) unreachable by "delete my data". The new importer checks every record first,
  under each address lock, and **skips** any whose address now belongs to a different live subscriber,
  listing them, before it changes anything. Tested: back up, delete the address, subscribe again with
  push, restore, delete again, and check nothing of either id is left.
- **Subscriber backups do not include devices**, only the channel fields. `admin.mjs restore` removes the
  existing devices of each restored subscriber the normal way (indexes first, then the device hash, under
  the address lock), so a restore never revives a device and leaves no index behind. Browsers whose
  device is gone get `missing` and are told how to turn notifications on again.
- **Logs never contain an endpoint, keys, a credential or a payload.** Push errors are logged as `{ device:
  <internal id>, status, category }` from an allowlist; a test feeds in realistic `WebPushError` objects.

## Configuration and keys

`server.env` and `deploy/server.env.example` gain `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (generated once;
the owner keeps an offline copy), `VAPID_SUBJECT=mailto:<a monitored, dedicated address>`, and `PUSH_MODE`:

- `off`: no push delivery; the switch is hidden. People who chose push only wait (uncharged, expiring
  after 3 hours); the daily numbers show them.
- `owner`: push is delivered, but **new push sign-ups are accepted only for the addresses in
  `PUSH_OWNER_EMAILS`**, enforced by the server at subscribe and confirm. `/api/status` says `push:
  "owner"`, which the public form treats as off (no switch). Opening the site with `?push=owner` (kept in
  `sessionStorage`) treats it as on, so the owner sees the switch; the server still refuses any other
  address. Delivery, registration and tests work as in `live`. This is how the owner tests live push
  before anyone else can sign up.
- `live`: everyone.

There is no production dry-run: a simulated push would consume a real decision.

## Reporting

Daily numbers gain: pushes accepted, refused, uncertain, devices removed, devices registered and awaiting,
subscribers with push on, push only, and with no working channel. `check finished` gains a `push` summary.

## Local verification, before anything reaches the server or GitHub

A **local stack** in `apps/server/dev/`, outside the production build:

- Its own entrypoint: a throwaway Valkey in Docker; the API with a **capturing mailer** (each email and its
  links written to a local folder; production code keeps refusing signups when mail is not live); a **fake
  upstream** with a small office catalog (no DFA client is constructed, and a test asserts it); no R2;
  VAPID keys made for local use. `.secrets/server.env` is never read.
- A script that feeds one verified opening into `deliver()` for chosen offices.
- The web app built and previewed with the same `BASE_PATH=pengepassportph` (`vite build` + `vite
  preview`), so the worker registers and paths match production.

Then:

1. **Tests first** (vitest, fake clock, `MemoryKv`), covering: context and capability; endpoint checks;
   sealing; subscribe, preview, confirm, register, rotate, turn off; the hostile signup; confirmation in
   another browser; concurrent registrations of one endpoint by **different subscribers**; a lost answer;
   turn-off racing a registration; a `410` arriving after rotation; every outcome row; email blocked by the
   limit, pause, errors and dry-run, in both passes, including a run across midnight; the pool, budget and
   lock with endpoints that time out; old pending records and old clients; backup and restore; log
   redaction; the worker's handlers against a fake `self`.
2. **Mac Chrome and Mac Firefox**: allow, deny, dismiss; email only, push only, both; confirm in the other
   browser, then register; test notification; synthetic alert; tap opens the right office and group size;
   turn off; delete my data.
3. **The owner's phone over wireless debugging** (`adb -s <phone> reverse tcp:4173 tcp:4173` and
   `tcp:8787`, so the phone's `localhost` is the Mac's):
   - Chrome on the phone, in a tab and **installed to the home screen** (the installed-PWA context).
   - The app, over **local HTTPS**, because the generated Android project always launches `https://`:
     - The Mac serves the production build and the API behind a local HTTPS proxy on port 8443 with a
       self-signed certificate made for `localhost` (kept in the scratch folder, never committed).
       `adb reverse tcp:8443 tcp:8443`.
     - A **separate debug app**: package `com.alphaexperiments.pengepassportph.dev`, its own manifest with
       host `localhost:8443`, local icons, a debug signing key, its own output folder (`android/out-dev/`,
       ignored by git), and its own build script that never fetches production assets.
     - Chrome on the phone gets a command line (`/data/local/tmp/chrome-command-line`, with "Enable command
       line on non-rooted devices" turned on in `chrome://flags`) with
       `--ignore-certificate-errors-spki-list=<the certificate's SPKI hash>` and
       `--disable-digital-asset-link-verification-for-url=https://localhost:8443`, then Chrome is restarted.
     - This checks the real path: the app opens without an address bar, asks for the Android 13+
       notification permission under its own name, and shows notifications as the app. Granted, denied,
       and revoked in Android settings after granting.
     - **This is a gate.** If the debug app cannot be made to work this way, nothing goes to the server
       or GitHub: the owner is told what failed and decides. Production is never used as the test bench.
       The Play-signed upload still needs its own check by the owner after release (its signing key
       differs), which is about Play's key in `assetlinks.json`, not about the feature.
   - Installs on the phone only after the owner says yes. Afterwards: uninstall the debug app, delete the
     Chrome command-line file and turn the flag back off, remove the `adb reverse` mappings.

## Rollout

1. **Backups first**, each with an **absolute expiry of 14 days from when it was made**, written into its
   file name (`…-expires-YYYYMMDD…`). A small `penge-backup-expire.timer` (daily, `Persistent=true`, so it
   catches up after a reboot) deletes any backup in `/root/penge-backups/` past its date; it is installed by
   hand, like the other units. Each one's restore command is in the docs:
   - `server.env` (a copy in `/root/penge-backups/`, 0600);
   - a subscriber export (`admin.mjs backup`, the same format as the daily R2 backup, which has no visitor
     salts and no devices) in `/root/penge-backups/`, 0600;
   - the previous release stays in `/opt/penge/releases/` for a rollback.
   No full Valkey snapshot is taken: it would keep visitor salts past their 25 hours.
2. Deploy with `PUSH_MODE=off`: no visible change; the new fields default to today's behaviour.

**Rolling back.** Before anyone has push on, the previous release is a safe rollback, as today. **After**
that, the old release would email people who chose push only (it does not know `emailOn`) and its
deletion would leave their devices behind. So:

- The first response to a push problem is **the new release with `PUSH_MODE=off`** (or `pp:push:paused`),
  not the old release.
- If the old release is really needed, it is done in a maintenance window, in this order:
  1. Stop and disable `penge-check.timer`, stop `penge-check.service` (which waits for a running check to
     finish), and stop `penge-api`. Nothing can confirm, register or send now.
  2. Run `admin.mjs push-downgrade` from the new release. It shows what it will do and needs `--yes`. It
     removes every device and push index; **cancels every pending request in `pp:pending:channels`**
     (the old release would confirm a push-only request as an email subscription); and **unsubscribes
     people who chose push only** (they never agreed to email), printing how many. People with email on
     keep their subscription. It is idempotent: if it is interrupted, run it again.
  3. Switch to the old release, then start the API, the timer and the checker.

  Before anyone has turned push on or asked for it, step 2 finds nothing. The docs give this in the
  rollback section, and a test runs the downgrade with a push-only subscriber and an unconfirmed push-only
  request, then the old confirmation and deletion paths.
3. Publish the privacy page, add VAPID keys, set `PUSH_MODE=owner` with the owner's address, and test with
   the owner's own devices. Only then `PUSH_MODE=live`.
4. Build Android 1.1.0 for the owner to upload, with Data safety updated first.
5. Docs: `deploy/README.md` (operating push, emergency stops, keys, backups), `docs/how-it-works.md`,
   `docs/alert-timing.md` (channels), `docs/android.md`, the privacy page and the legal register.

## Out of scope

- A manage link in emails (existing subscribers submit the form again).
- Subscribing with no email address.
- Rich notifications (images, actions), per-device schedules, a separate push queue service.

## Codex reviews: what changed

**Pass 1** (21 findings): the `email` field is no longer reused (separate `emailOn`/`pushOn`); hostile
confirmations are shown before the button; endpoints have one owner and need possession; cross-browser
confirmation works and credentials live in IndexedDB; an email blocked while push delivers is not kept
(a changed promise); an outcome table; email blocks no longer stop push in either pass; no production
dry-run; a pool, budget and lock renewal; turn-off races are serialised; a local stack with a capturing
mailer and fake upstream; a separate debug app; permission asked first in the click; context, capability
and permission kept apart; reconcile on open; devices removed only on `404`/`410`; devices not backed up;
redacted logs; delegation and Play disclosure checked rather than assumed; one notification per decision,
with a working tap.

**Pass 2** (13 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | Endpoint ownership raced across subscribers | `SET NX` reservation and compare-and-delete release; tested across different address locks |
| 2 | Grant consumption vs. a lost answer | No grants: the device's own credential, created before subscribing; registration is idempotent |
| 3 | Copied-subscription recovery contradicted the rule | `endpoint-taken` makes the browser take a fresh endpoint |
| 4 | Grants could not be revoked | Gone: devices are created at confirmation, in one enumerable hash |
| 5 | Spent push budget blocked email | Budget spent makes push unavailable; email carries on; slot reserved before the claim |
| 6 | A late `410` deleted a rotated device | Removal only if the stored endpoint is the one sent to, under the lock |
| 7 | Email dry-run missing from outcomes | Simulated email decides only for push-off subscribers |
| 8 | No read-only preview for confirmation | `POST /api/confirm/preview` |
| 9 | Limit block survived midnight | The block remembers its day |
| 10 | Restore left browsers stuck | `missing` answer clears and explains; restore deletes devices of restored subscribers |
| 11 | Worker readiness could hang | Registration outcome kept; readiness waited for 10 s at most |
| 12 | A local TWA can't be made from a manifest; `https` is hard-coded | Debug patch and package as an experiment, with an honest fallback; `BASE_PATH` consistent |
| 13 | Rollout backups outlived retention; snapshots keep salts | Absolute 14-day expiry; no full Valkey snapshot |

**Pass 3** (9 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | A credential could be bound under two subscribers | `SET NX` owner for credentials too; same owner reuses the device; another owner is refused |
| 2 | Polling before confirmation answered `missing` and destroyed the sign-up | `pp:push:pending:<hash>`; unconfirmed credentials kept for 48 h |
| 3 | A delayed old endpoint could overwrite a newer one | A revision counter shared by page and worker; stale replacements refused |
| 4 | Turn off did not stop a second confirmation | Revoked marker for 72 h; a new credential afterwards |
| 5 | Restore left unfindable index entries | Indexes removed before devices, everywhere; readers clean orphans |
| 6 | The old worker could be the active one | Version handshake and update before subscribing |
| 7 | Backup expiry did not survive a reboot | Expiry in the file name and a persistent daily timer |
| 8 | Delegation fallback tested on production | Local HTTPS debug app; a hard gate, no production testing |
| 9 | Live mode exposed the switch during owner testing | `PUSH_MODE=owner` with a server-enforced address list |

**Pass 4** (6 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | Removal was not crash-safe | `pushRemove` is one atomic script; crash tests at each step |
| 2 | Revocation raced confirmation across subscribers | `pushBind` checks "not revoked" and reserves in one script; turn-off revokes and releases in one |
| 3 | A browser-rotated endpoint stuck on `stale` | Revision stored with the endpoint's fingerprint and raised on any change; same pair accepted as a repeat |
| 4 | Owner mode contradicted both availability checks | `push: "owner"` status, `?push=owner` override, delivery on in `owner` |
| 5 | The old worker cannot answer a handshake | 1 s handshake; silence means old; update, `controllerchange`, ask again |
| 6 | The local build could not detect the debug app | `VITE_LOCAL_DEBUG=1` production build; release build refuses the flag; context shown on the phone |

**Pass 5** (4 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | Scripts cannot read sealed devices | `pp:push:meta:<id>` with state, revision and keyed hashes, written with the sealed record |
| 2 | Rolling back to the old release would email push-only people | Roll back by `PUSH_MODE=off`; `admin.mjs push-downgrade` before any old release |
| 3 | Page and worker could still race on revisions | One Web Lock around read, compare, raise and register |
| 4 | Lua errors don't roll back | Check first, write last; tests for bad input, and for caller death and lost answers after success |

**Pass 6** (3 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | Unconfirmed push-only requests survived a downgrade | `pp:pending:channels`; the downgrade cancels them |
| 2 | No maintenance boundary for the downgrade | Stop the timer, checker and API first; idempotent downgrade; then switch |
| 3 | Confirmation not crash-safe across its steps | Subscriber id reserved at sign-up; bind, write, use up the token, in that order; retry finishes it |

**Pass 7** (2 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | An old-format restore could email push-only people | Backup version 2, which the old importer refuses; `backup-to-v1` leaves out email-off people |
| 2 | An interrupted confirmation could leave a device deletion can't find | 72 h expiry until the subscriber exists; deletion also covers reserved ids, before pending requests go |

**Pass 8** (2 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | Two confirmations for one address could use different ids | One reserved id per address, `pp:reserved:<index>`, used by every confirmation |
| 2 | A reservation could expire before its device state | The reservation is extended with the device state and removed only when the subscriber exists or the address is deleted |

**Pass 9** (2 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | An old confirmation page could skip the preview | Confirm must acknowledge the channels; token-only confirms of new requests get 409 without using the token |
| 2 | Reservations of never-confirmed sign-ups never expired | The reservation expires with the latest pending request; `pushBind` extends it further, never shortens it |

**Pass 10** (2 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | A refused push binding turned email on against the person's choice | With email off, nothing is applied and the token stays usable; email is never turned on unasked |
| 2 | "Reload" lost the token on an old page | The 409 says to reopen the link from the email; tested through to a successful confirmation |

**Pass 11** (2 findings):

| # | Finding | Disposition |
|---|---|---|
| 1 | A restore could displace a live subscriber and leave their devices after deletion | The importer skips records whose address belongs to another live subscriber, checked before any change |
| 2 | The refusal's recovery advice could not work | Turn off, then submit the form again with a fresh credential; tested to the end |

**Pass 12** (2 findings; it confirmed the pass 11 fixes):

| # | Finding | Disposition |
|---|---|---|
| 1 | Renewed keys at the same endpoint kept the revision | Fingerprint the whole subscription (endpoint and both keys) |
| 2 | Turn-off was outside the shared lock | Every change to the browser's push state takes the lock; clear a credential only if it is still the one removed |

**Pass 13** (1 finding):

| # | Finding | Disposition |
|---|---|---|
| 1 | The server metadata could not enforce the whole-subscription fingerprint | A server-computed subscription HMAC in the metadata and in `pushRegister`'s comparison |
