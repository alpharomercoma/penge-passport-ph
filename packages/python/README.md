<p align="center">
  <img alt="PengePassportPH" src="https://raw.githubusercontent.com/alpharomercoma/penge-passport-ph/main/docs/assets/logo-light.svg" width="470">
</p>

<p align="center">
  <strong>Penge ng slot? Tingnan muna natin.</strong><br>
  Read-only, rate-limited DFA passport appointment availability for the Philippines, in Python.<br>
  It looks; it never books.
</p>

> **Unofficial.** Not affiliated with, endorsed by or connected to the Department of Foreign Affairs of the
> Philippines. Passport appointments are free and are booked only at [passport.gov.ph](https://passport.gov.ph).

**PengePassportPH** tells you which dates, and which hourly time slots, still have room at a DFA consular
site. It reads the same data the booking page shows, through the same endpoints. It paces itself so it
cannot overload the site, and it never selects a time slot: selecting one holds it for 30 minutes and
takes it away from real applicants.

This is the Python package. It is a native port of the
[Node.js package](https://github.com/alpharomercoma/penge-passport-ph#readme) with the same behaviour, the
same CLI and **one shared rate limit**: Python and Node.js processes on the same machine count against a
single budget.

- **Standard library only.** No runtime dependencies. Python 3.11+, fully typed (`py.typed`).
- **Synchronous and thread-safe.** Share one client between threads; identical concurrent calls share one
  request.
- **Polite by default, and it can't be made faster.** At least 2 s between requests, a capped hourly
  budget, backoff when the site struggles.

## Install

```sh
pip install penge-passport-ph      # or: uv add penge-passport-ph
pipx install penge-passport-ph     # just the CLI: penge-passport-ph, or penge
```

## CLI

Same commands, flags, output and exit codes as the Node.js CLI:

```console
$ penge sites --search antipolo
  486  Antipolo (SM Center, Antipolo City, Rizal)

$ penge check --site antipolo --times
Antipolo (SM Center, Antipolo City, Rizal) (site 486)
Checked 2026-09-26 to 2027-03-31 for 1 applicant(s)
Earliest: 2026-10-14
Available (11): 2026-10-14, 2026-10-15, 2026-10-16, ...

$ penge watch --site 486 --site angeles --interval 10m
```

`penge --help` lists everything; `python -m penge_passport_ph` works too.

## Library

```python
from penge_passport_ph import PengePassportPH

penge = PengePassportPH(contact="you@example.com")

site = penge.find_sites("antipolo")[0]
availability = penge.availability(site.id)

print(availability.earliest)  # '2026-10-14', or None when fully booked
print(availability.available_dates)  # ('2026-10-14', '2026-10-15', …)

if availability.earliest:
    for slot in penge.time_slots(site.id, availability.earliest):
        print(slot.start, slot.end, slot.status)  # 08:30 09:30 Available Slots: 1

for event in penge.watch([486, 10], interval=600):
    if event.type == "availability" and event.opened:
        print(event.site_id, "opened", event.opened)
```

| Method | Returns |
|---|---|
| `regions()` | The five regions. |
| `countries(region_id)` | `list[Country]` |
| `sites(region_id=1, country_id=1)` | `list[Site]`, the Philippines by default |
| `find_sites(text, region_id=1, country_id=1)` | Sites whose name or description contains `text` |
| `availability(site_id, *, applicants=1, from_date=None, to_date=None)` | `Availability`: `earliest`, `available_dates`, and every published `days` entry |
| `time_slots(site_id, date, *, applicants=1)` | `list[TimeSlot]` for one date |
| `warm_session(*, within=120)` | Opens a session now if there is none or it would lapse within `within` seconds, so the next call does not wait for one: one request, or none. `True` when it opened one |
| `watch(site_ids, *, interval=300, applicants=None, stop=None)` | Iterator of `AvailabilityEvent` and `ErrorEvent`; set the `threading.Event` `stop`, or break, to end it |
| `stats()` | The rate limiter's state: requests in the last hour, failures, pauses in seconds |

Results are frozen dataclasses; `to_dict()` gives the same JSON as the Node.js package. Dates are
`YYYY-MM-DD` strings. `applicants` is 1, or 2 to 5 for a group (`MAX_APPLICANTS`, the most the DFA's group
form takes). `from_date` and `to_date` default to the site's own booking window. A date absent
from `days` is not published yet, which is different from fully booked.

Errors all derive from `PengePassportPHError`: `UpstreamError` (unexpected status or body, or the site
unreachable, with `.status`), `SessionError`, `RateLimitError` (with `.retry_after` in seconds) and its
subclass `CircuitOpenError`. Invalid arguments raise `ValueError`.

## Rate limits

| Limit | Default | Allowed |
|---|---|---|
| Gap between requests (`min_interval`) | 3 s, plus up to 25% jitter | 2 s or more |
| Requests per rolling hour (`max_requests_per_hour`) | 300 | 1 to 1200 |
| Concurrency | 1 | fixed |
| Reuse of availability and slot answers (`availability_ttl`) | 60 s | 30 s or more |
| `watch` interval | 5 min | 60 s or more, within the hourly budget |

The limiter's state lives in `~/.local/state/penge-passport-ph/` (override with `state_dir` or
`PENGE_PASSPORT_PH_STATE_DIR`), in the same file and format as the Node.js package, behind the same lock.
Any non-2xx response, unreadable body, timeout or network error pauses the client, doubling up to
10 minutes; it honours `Retry-After` up to an hour. After 5 failures in a row, or one `Retry-After` longer
than an hour, it rests for 15 minutes, or as long as `Retry-After` asks, up to an hour. If the state
file can't be written, it issues a `StateSharingWarning` and limits the current process only.

Please don't run it on many machines, don't use it to resell or broker appointments, and don't build
booking on top of it.

## Configuration

```python
PengePassportPH(
    base_url="https://passport.gov.ph",
    contact=None,  # added to the User-Agent
    min_interval=3.0,  # seconds, at least 2
    max_requests_per_hour=300,  # at most 1200
    max_wait=60.0,  # refuse, rather than queue, past this
    availability_ttl=60.0,  # at least 30
    directory_ttl=6 * 3600,
    timeout=20.0,
    state_dir=None,  # default: default_state_dir()
    transport=None,  # custom HTTP transport (proxies, tests)
)
```

## More

- [How it works](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/how-it-works.md): the
  endpoints, the site's quirks, and the shared state-file protocol.
- [Canary runbook](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/canary.md): the
  scheduled check that fails loudly when passport.gov.ph changes. It covers this package too.
- [Law and responsible use](https://github.com/alpharomercoma/penge-passport-ph/blob/main/docs/legal/README.md): the
  DFA's rules, Philippine law, and why the limits are what they are.
- [Changelog](https://github.com/alpharomercoma/penge-passport-ph/blob/main/packages/penge-passport-ph/CHANGELOG.md)

MIT © Alpha Romer Coma
