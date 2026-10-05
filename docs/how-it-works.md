# How PengePassportPH works

This describes both packages: the Node.js one in `packages/penge-passport-ph/src/` and the Python port in `packages/python/`. They follow the
same rules, and the parts that must match exactly (parsing and the rate-limit state file) are pinned by
shared tests.

PengePassportPH talks to passport.gov.ph the way the booking page's own scripts do. Everything
here was found by walking the booking flow in a browser, reading the site's network traffic and its scripts
(`/Scripts/site-timeslot.js`, `/Scripts/site-information.js`), and confirming each detail with live
requests. The [canary](canary.md) re-checks all of it every 6 hours.

## The booking flow, and where the package stops

```
Home ─► fixer warning ─► terms + consent ─► site location ─► date and time ─► personal details ─► …
                                             │                 │                  ▲
                                             │ POST /countries │ POST /appointment/timeslot/available
                                             │ POST /sites     │ POST /appointment/timeslot
                                             │                 │
                                             └─────────────────┴── PengePassportPH reads these,
                                                                   and nothing after them
```

Choosing a time slot and pressing NEXT holds that slot for 30 minutes. That step is the only one guarded by
reCAPTCHA. PengePassportPH never takes it, and does not expose the internal slot ids that would make it
possible.

## Endpoints

| Purpose | Request | Answer |
|---|---|---|
| Session | `GET /appointment` | HTML with a hidden `__RequestVerificationToken` input and its cookie, plus inline `currentDate = 'YYYY-MM-DD'` and `MAX_DATE = 'YYYY-MM-DD'` |
| Countries | `POST /countries` form `regionId` | `{ "Countries": [{ "Id", "Name" }] }` |
| Sites | `POST /sites` form `regionId, countryId` | `{ "Sites": [{ "Id", "Name", "Address", "Telephone", "Timeslots", "Description", "Url", "Timezone" }] }` |
| Dates | `POST /appointment/timeslot/available` form `fromDate, toDate, siteId, requestedSlots`, header `__RequestVerificationToken` | `[{ "IsAvailable": bool, "AppointmentDate": epoch-ms }]` |
| Time slots | `POST /appointment/timeslot` form `preferredDate, siteId, requiredSlots`, same header | HTML fragment: one radio input per hour, disabled when booked |

`requestedSlots` and `requiredSlots` are the site's names for the number of people in the booking. The
package calls it `applicants`, and uses "slot" only for an hourly time slot.

## The session

A single `GET /appointment` is enough: it sets the anti-forgery cookie and embeds the matching form token.
No `ASP.NET_SessionId`, terms POST or site step is needed to read availability. The page also carries the
server's own "today" and last bookable date, which the package uses as the default date range.

The site logs idle visitors out after 10 minutes, so the package refreshes its session after 9 idle
minutes, and at the latest after an hour. Opening one costs a request, and the next request waits out the
spacing after it, so `warmSession()` (`warm_session()` in Python) can open one ahead of time: the website
does this while someone is on it, so a tap on a day costs one request.

## Quirks the package handles

| The site does | The package does |
|---|---|
| Answers a missing or stale token with an **empty HTTP 200**, not an error | Refreshes the session once and retries; a second empty answer is a `SessionError` and counts as a failure. A day's hours can be empty for real (below), so there an empty answer is retried only when the token has not worked in the last 2 minutes |
| Answers an unknown `siteId` with **HTTP 500** | Treats it as a failure for backoff; the error message suggests `sites()` |
| Sends dates as epoch milliseconds at **UTC midnight** of the calendar date | Reads them as UTC dates, exactly as the site's own script does |
| Publishes only working days inside its release window | Reports only published days; an absent date is "not published", not "booked" |
| Returns an **empty fragment** for a date with no schedule yet ("Timeslots will be available soon") | Returns `[]` for that date |
| Encodes each site's time zone as .NET ticks (`288000000000`) | Converts to `utcOffsetMinutes` (480) |

## The rate limiter

Every request goes through a `HostGate`, one per host:

1. **Serial.** Requests run one at a time, in call order.
2. **Spaced.** At least `minIntervalMs` apart (2 s floor, 3 s default) plus up to 25% random jitter, so
   separate clients do not fall into step.
3. **Budgeted.** At most `maxRequestsPerHour` in any rolling hour (1200 ceiling, 300 default). Past it, calls
   fail with `RateLimitError` and a `retryAfterMs`.
4. **Backing off.** A failure (any non-2xx, an unreadable body, a timeout, a network error, a rejected
   session) pauses the gate for 5 s, doubling to 10 minutes, or for the server's `Retry-After` if longer
   (up to an hour). Five failures in a row, or one `Retry-After` longer than an hour, open the circuit
   (`CircuitOpenError`) for 15 minutes, or for the `Retry-After` if longer, up to an hour.
5. **Bounded.** A call that has waited `maxWaitMs` in the queue is refused instead of sent late.

The gate's state lives in `~/.local/state/penge-passport-ph/<host>.json` (see
[Configuration](../README.md#configuration)) behind a lock file. That makes the spacing, budget and
backoff shared by every process of the same user. The lock records its owner's pid and a random token.
It is reclaimed only when that process has exited, and it is moved aside and re-read before deletion so
a live lock is never removed by mistake. While a live process holds the lock, other calls are refused rather
than sent without coordination. Only when the file system itself refuses (read-only, permissions) does
the client warn once (`PENGE_PASSPORT_PH_STATE`) and limit its own process alone. A state file that is
corrupt or edited by hand is clamped, never trusted.

### The shared state file

The state file is a contract between processes, including between the Node.js and Python packages. Both
implement it exactly, and `packages/python/tests/test_interop.py` runs them side by side against one file.

- **Path:** `<state dir>/<host>.json`, e.g. `~/.local/state/penge-passport-ph/passport.gov.ph.json`.
- **Content:** JSON, all times in milliseconds since the epoch (wall clock):
  `{"lastDispatchAt": 0, "dispatched": [], "pauseUntil": 0, "consecutiveFailures": 0, "circuitOpenUntil": 0}`.
- **Lock:** `<state file>.lock`, created exclusively (`O_CREAT | O_EXCL`, mode 600), containing
  `<pid>:<random token>`. Hold it only to read, decide and write; release it by deleting the file, and only
  when it still holds your token.
- **Writing:** write `<state file>.<pid>.tmp`, then rename it over the state file.
- **Reclaiming:** a lock is dead only if its pid is not running. If the owner can't be read yet, it counts
  as dead only when it is more than 1 s old. Move a dead lock aside to a unique name and re-read it. If it
  is no longer the lock you judged dead, link it back.
- **Waiting:** retry every 10 ms, 300 times; if a live process still holds the lock, refuse the request.
- **Reading:** a missing file is a fresh start; unparsable JSON is reset; any other read error falls back to
  per-process limiting *without* overwriting the file. Values are clamped: future `lastDispatchAt` to now,
  pauses to at most 75 minutes ahead, `dispatched` to the last hour.

On top of the gate:

- **Cache.** Availability and time-slot answers are reused for 60 s, country and site lists for 6 h.
  Concurrent identical calls share one request. Failures are not cached.
- **Cancellation.** A caller that aborts only stops its own wait; the shared request is cancelled only when
  every caller waiting on it has aborted, so no one else's result is lost.
- **Parsing inside the gate.** A 200 whose body cannot be read counts as a failure, so a changed or broken
  site slows the client down instead of being retried at full pace.

## Source map

Paths are relative to `packages/penge-passport-ph/`.

| File | Role |
|---|---|
| `src/client.ts` | `PengePassportPH`: session, cache, the public methods, `watch()`, `userAgent()` |
| `src/rate-limit.ts` | `HostGate`, `FileStore`, `MemoryStore`, `LIMITS` |
| `src/parse.ts` | Parsers for the bootstrap page, JSON answers and the time-slot fragment |
| `src/cache.ts`, `src/async.ts` | TTL cache with shared, cancellable loads; `sleep`, `raceAbort` |
| `src/session.ts` | Cookie jar and session freshness |
| `src/meta.ts` | Display name, package name, CLI alias, version, homepage and env prefix (checked against `package.json` by the tests) |
| `src/cli.ts` | The `penge-passport-ph` command (alias `penge`) |

The Python package mirrors this layout in `packages/python/src/penge_passport_ph/`: `client.py`, `rate_limit.py`,
`parse.py`, `cache.py`, `session.py`, `models.py` (the returned dataclasses), `_meta.py`, `cli.py`, and
`_clock.py`, its single source of time (so tests can fast-forward it).

The website, its API and the alerting checker are built on the Node.js package: see
[deploy/README.md](../deploy/README.md) for how they run and the checker's guardrails.

## Alerts by email and push

The website's alerts have two channels on one subscription: email and Web Push. A person turns push on
in the alert form, in the browser or app that should get the notifications. That browser makes a random
credential (kept in its IndexedDB) and a push subscription; the request carries only the credential's
hash. The confirmation email and the confirmation page say which channels the request turns on, and for
which device. Confirming binds that credential to the subscriber: a credential has one owner, and a
turned-off credential is marked off for 3 days, longer than any sign-up link lives, so an older link
cannot turn it back on. The browser then registers its subscription with
its credential, and keeps it current (a renewed subscription is a higher revision; an older one never
overwrites a newer). A form sent without push changes the offices, group and pace, and leaves every
device as it was.

Each alert goes to every channel the person has that can carry it now: email within the daily limit,
push within a per-pass budget. A push service's "gone" removes that device, but only if it still has the
endpoint the push went to. A device that never finishes setting up is removed at the first check after 48 hours
(before the subscriber exists, its keys expire 72 hours after the last request for it). The device itself can ask how it is, send itself a test (three an hour),
or turn itself off. The details, and the reasons for each rule, are in
`docs/superpowers/specs/2026-10-05-push-notifications-design.md`.
