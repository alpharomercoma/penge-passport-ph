<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/alpharomercoma/penge-passport-ph/raw/main/docs/assets/logo-dark.svg">
    <img alt="PengePassportPH" src="https://github.com/alpharomercoma/penge-passport-ph/raw/main/docs/assets/logo-light.svg" width="470">
  </picture>
</p>

<p align="center">
  <strong>Penge ng slot? Tingnan muna natin.</strong><br>
  Read-only, rate-limited DFA passport appointment availability for the Philippines.<br>
  A library and CLI for <a href="https://passport.gov.ph">passport.gov.ph</a>, for Node.js and Python. It looks; it never books.
</p>

<p align="center">
  <a href="https://github.com/alpharomercoma/penge-passport-ph/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/alpharomercoma/penge-passport-ph/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/alpharomercoma/penge-passport-ph/actions/workflows/canary.yml"><img alt="Canary" src="https://github.com/alpharomercoma/penge-passport-ph/actions/workflows/canary.yml/badge.svg"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%E2%89%A522-339933">
  <img alt="Python 3.11+" src="https://img.shields.io/badge/python-%E2%89%A53.11-3776ab">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-1a7f37">
  <a href="https://github.com/alpharomercoma/penge-passport-ph/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

> [!IMPORTANT]
> Unofficial. Not affiliated with, endorsed by or connected to the Department of Foreign Affairs of the
> Philippines. Passport appointments are free and are booked only at [passport.gov.ph](https://passport.gov.ph).

*Penge* is Filipino for "give me (some)". The name is the wish; the tool is the reality check. It can't give
you a slot, and nobody should sell you one. It tells you where one is open, so you can book it yourself for
free.

**PengePassportPH** tells you which dates, and which hourly time slots, still have room at a DFA consular
site. It reads the same data the booking page shows, through the same endpoints. It paces itself so it
cannot overload the site, and it never selects a time slot: selecting one holds it for 30 minutes and
takes it away from real applicants.

- **Read-only by construction.** No booking, no reCAPTCHA, not even the internal slot ids.
- **Polite by default, and it can't be made faster.** One request at a time, at least 2 s apart, a capped
  hourly budget shared by every process you run, and backoff when the site struggles.
- **Node.js and Python, one behaviour.** Zero runtime dependencies in both, fully typed, the same CLI, and
  one rate limit shared by every process of either language.
- **Watched.** A scheduled [canary](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/canary.md) scrapes a real record every 6 hours and fails loudly when
  the site changes.
- **Email alerts, too.** The same repository runs a free website that checks every office in the
  Philippines every 15 minutes, and the posts abroad about hourly, and emails you when a date opens where
  you want it ([how it runs](https://github.com/alpharomercoma/penge-passport-ph/blob/main/deploy/README.md)).

## Contents

- [Install](#install)
- [CLI](#cli)
- [Library](#library)
- [Python](#python)
- [Email alerts website](#email-alerts-website)
- [Rate limits and responsible use](#rate-limits-and-responsible-use)
- [When the site changes](#when-the-site-changes)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [License](#license)

## Install

```sh
npm install penge-passport-ph       # Node.js library
npx penge-passport-ph --help        # CLI, no install
npm install -g penge-passport-ph    # CLI as `penge-passport-ph`, or just `penge`

pip install penge-passport-ph       # Python library (or: uv add penge-passport-ph)
pipx install penge-passport-ph      # the same CLI, from Python
```

Both packages install the same `penge-passport-ph` and `penge` commands, with the same flags and output;
use whichever runtime you have.

## CLI

```console
$ npx penge-passport-ph sites --search antipolo
  486  Antipolo (SM Center, Antipolo City, Rizal)

$ npx penge-passport-ph check --site antipolo --times
Antipolo (SM Center, Antipolo City, Rizal) (site 486)
Checked 2026-09-26 to 2027-03-31 for 1 applicant(s)
Earliest: 2026-10-14
Available (11): 2026-10-14, 2026-10-15, 2026-10-16, ...

Time slots on 2026-10-14:
  08:30-09:30  Available Slots: 1
  09:30-10:30  Fully Booked
  ...

$ npx penge-passport-ph watch --site 486 --site angeles --interval 10m
2026-09-26T14:05:11.020Z  Antipolo (SM Center, Antipolo City, Rizal): earliest 2026-10-14
2026-09-26T14:15:40.311Z  Antipolo (SM Center, Antipolo City, Rizal): opened 2026-10-02
```

| Command | What it does |
|---|---|
| `check --site <id\|name>` | Open dates at one site. `--times` adds the time slots on the earliest open date. |
| `watch --site <id\|name> [--site …]` | Polls and prints dates as they open or close. `--interval` (minimum 60 s, default 5 min). |
| `sites [--search <text>]` | Consular sites. Philippines by default; `--region` and `--country` for posts abroad. |
| `countries --region <id>` | Countries in a region. |
| `regions` | The five regions. |

Every command takes `--json`. `--applicants <n>` checks room for a group booking of 2 to 5 (the most the
DFA's group form takes; `applicants` in the API has the same range), `--from`/`--to` narrow
the date range, and `--contact <email-or-url>` adds a way to reach you to the User-Agent. Exit codes:
`0` ok, `2` usage error, `3` site, session or rate-limit error, `1` anything unexpected.

## Library

```ts
import { PengePassportPH } from 'penge-passport-ph';

const penge = new PengePassportPH({ contact: 'you@example.com' });

const [site] = await penge.findSites('antipolo');
const availability = await penge.availability({ siteId: site.id });

console.log(availability.earliest);        // '2026-10-14', or null when fully booked
console.log(availability.availableDates);  // ['2026-10-14', '2026-10-15', …]

if (availability.earliest) {
  const times = await penge.timeSlots({ siteId: site.id, date: availability.earliest });
  // [{ start: '08:30', end: '09:30', available: true, remaining: 1, status: 'Available Slots: 1', note: null }, …]
}

for await (const event of penge.watch({ siteIds: [486, 10], intervalMs: 10 * 60_000 })) {
  if (event.type === 'availability' && event.opened.length) console.log(event.siteId, 'opened', event.opened);
}
```

| Method | Returns |
|---|---|
| `regions()` | The five regions (static). |
| `countries(regionId)` | `Country[]` |
| `sites({ regionId?, countryId? })` | `Site[]`, the Philippines by default |
| `findSites(text, { regionId?, countryId? })` | `Site[]` whose name or description contains `text` |
| `availability({ siteId, applicants?, from?, to? })` | `Availability`: `earliest`, `availableDates`, and every published `days` entry |
| `timeSlots({ siteId, date, applicants? })` | `TimeSlot[]` for one date |
| `watch({ siteIds, intervalMs?, applicants?, signal? })` | Async iterator of `availability` and `error` events |
| `stats()` | Promise of the rate limiter's state: requests in the last hour, failures, pauses |

`applicants` is 1, or 2 to 5 for a group (`MAX_APPLICANTS`, the most the DFA's group form takes). `from` and
`to` default to the site's own "today" and booking horizon. `days` lists only the dates the site
has published (working days in its release window); a date that is absent is not published yet, which is
different from fully booked. Every method that makes a request accepts a `signal` to cancel it.

Errors all extend `PengePassportPHError`: `UpstreamError` (unexpected status or body, with `.status`),
`SessionError`, `RateLimitError` (with `.retryAfterMs`) and its subclass `CircuitOpenError`. Invalid
arguments throw `RangeError`. Results are copies: changing one never changes what the cache holds.

## Python

The Python package is a native port with the same behaviour: standard library only, Python 3.11+,
synchronous and thread-safe, durations in seconds, snake_case names.

```python
from penge_passport_ph import PengePassportPH

penge = PengePassportPH(contact="you@example.com")
availability = penge.availability(penge.find_sites("antipolo")[0].id)
print(availability.earliest, availability.available_dates)
```

Its guide is in [packages/python/README.md](https://github.com/alpharomercoma/penge-passport-ph/blob/main/packages/python/README.md). Both packages parse through rules pinned by the same
golden files, and share one rate-limit state file, so they can run side by side.

## Email alerts website

`apps/` holds a website built on this package, live at <https://alphaexperiments.com/pengepassportph/>
(short link `/p3h`): every office's open dates at a glance, in the Philippines and at the embassies and
consulates abroad, each one's calendar and hourly times for one person or a group, and an email when a
date opens where you can get to.

- **Checks every office in the Philippines every 15 minutes, and each of about 130 posts abroad about
  hourly,** through this package's rate limiter, and stores every scan in Cloudflare R2 for later analysis.
- **Emails only on trustworthy news.** A scan that looks broken (too many offices failing, no dates
  anywhere, an office list suddenly cut short) sends nothing and changes nothing; the first look is never news; a flickering date is
  announced once; at most 3 alerts a day.
- **Private.** Addresses are stored encrypted (AES-256-GCM), confirmed by double opt-in, and deleted on
  unsubscribe (daily backups, also encrypted, drop them within 14 days); every alert has a one-click
  unsubscribe (RFC 8058). No trackers. [Where an address goes](https://github.com/alpharomercoma/penge-passport-ph/blob/main/deploy/README.md#where-a-subscribers-address-goes)
  lists every place it exists, including the two where it is not encrypted.
- **Self-hosted, free to run.** One small server: Caddy, Node.js, Valkey (Redis), and its own Postfix
  with DKIM.

| Path | What it is |
|---|---|
| `packages/penge-passport-ph/` | This package (npm) |
| `packages/python/` | The Python port (PyPI) |
| `packages/contracts/` | Validation and shapes shared by the website and the server |
| `apps/server/` | The checker, the mailer and the website's API |
| `apps/web/` | The website (React) |
| `deploy/` | Provisioning, releases, mail setup and the [runbook](https://github.com/alpharomercoma/penge-passport-ph/blob/main/deploy/README.md) |

## Rate limits and responsible use

passport.gov.ph is a public service that people need on bad days. The limits are enforced inside the client
and cannot be switched off:

| Limit | Default | Allowed |
|---|---|---|
| Gap between requests | 3 s, plus up to 25% jitter | 2 s or more |
| Requests per rolling hour | 300 | 1 to 1200 |
| Concurrency | 1 | fixed |
| Reuse of availability and slot answers | 60 s | 30 s or more |
| Reuse of country and site lists | 6 h | any |
| `watch` interval | 5 min | 60 s or more, within the hourly budget |

- **Shared across processes and languages.** The limiter's state lives in a locked file under
  `~/.local/state/penge-passport-ph/`, so two terminals running `watch`, in Node.js or Python, share one budget
  instead of doubling the load.
- **Backs off.** Any non-2xx response, unreadable body, timeout or network error pauses the client for 5 s,
  doubling up to 10 minutes. It honours `Retry-After` up to an hour. After 5 failures in a row, or one
  `Retry-After` longer than an hour, it stops for 15 minutes, or as long as `Retry-After` asks, up to an hour.
- **Refuses rather than piles up.** A call that has waited `maxWaitMs` (default 60 s) in the queue fails with
  `RateLimitError`. Identical concurrent calls share one request.
- **Identifies itself.** Every request carries
  `penge-passport-ph/<version> (+https://alphaexperiments.com/pengepassportph/; read-only availability checker)`.
  Pass `contact` to add your email.

Please don't run it on many machines, don't use it to resell or broker appointments, and don't build
booking on top of it. The DFA warns applicants against fixers; this project exists so people can check for
themselves.

[docs/legal](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/legal/README.md) sets out what Philippine law, the DFA and the DICT say about automated
access, how other governments have treated appointment scanners, and why the alerts website uses the limits
it does. It is research, not legal advice.

## When the site changes

The site can change without notice, and a checker that silently misreads it is worse than none. The
[Canary workflow](https://github.com/alpharomercoma/penge-passport-ph/blob/main/.github/workflows/canary.yml) runs every 6 hours and on changes to `main`:

- **API contract.** Scrapes one real record through the package and checks the endpoint map, the request
  parameters, the site's two scripts against pinned copies, and how the site answers a missing token.
- **Python package.** Scrapes the same record through the Python package and checks it agrees with Node.js.
- **UI flow.** Walks the booking flow in headless Chromium up to the calendar and clicks a date. It checks
  that no slot comes back selected and that the walk made no booking request.

Any ❌ fails the job and opens a `❌ PengePassportPH canary: passport.gov.ph changed` issue with the diff and
screenshots. The issue closes itself when the canary passes again. What to do when it fires:
[docs/canary.md](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/canary.md).

## Configuration

| Setting | Where | Default |
|---|---|---|
| `contact` | option, `--contact` | none |
| `minIntervalMs`, `maxRequestsPerHour`, `maxWaitMs` | options | 3000, 300, 60000 |
| `availabilityTtlMs`, `directoryTtlMs`, `timeoutMs` | options | 60 s, 6 h, 20 s |
| `stateDir` | option, `PENGE_PASSPORT_PH_STATE_DIR` | `$XDG_STATE_HOME/penge-passport-ph`, else `~/.local/state/penge-passport-ph` |
| `baseUrl`, `fetch` | options | `https://passport.gov.ph`, global `fetch` |

The canary has its own `PENGE_PASSPORT_PH_*` variables, listed in [docs/canary.md](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/canary.md#settings).

## Documentation

- [How it works](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/how-it-works.md): the endpoints, the session, the site's quirks and the limiter design.
- [Canary runbook](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/canary.md): what each check means and how to respond when one fails.
- [Website runbook](https://github.com/alpharomercoma/penge-passport-ph/blob/main/deploy/README.md): how the alerts website runs, deploys, sends mail and stores scans.
- [Law and responsible use](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/legal/README.md): the DFA's rules, Philippine law, and why the limits are what they are.
- [Contributing](https://github.com/alpharomercoma/penge-passport-ph/blob/main/CONTRIBUTING.md): layout, development, fuzzing, naming and the ground rules.
- [Changelog](https://github.com/alpharomercoma/penge-passport-ph/blob/main/packages/penge-passport-ph/CHANGELOG.md)

## License

[MIT](https://github.com/alpharomercoma/penge-passport-ph/blob/main/LICENSE) © Alpha Romer Coma
