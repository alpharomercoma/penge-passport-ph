# Changelog

All notable changes to PengePassportPH (`penge-passport-ph`) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-30

### Added

- `warmSession()` (`warm_session()` in Python) opens a session ahead of time when there is none or it would
  lapse within 2 minutes, so the next call does not wait for one. One request through the rate limiter, or
  none.

### Changed

- An empty answer for a day's hours from a token that worked in the last 2 minutes is taken as "no schedule
  yet" and returned as `[]`, instead of opening a new session and asking again: that cost two more requests
  and two waits for nothing. An older token still gets the second chance.
- The READMEs say how the website built on this package now runs: it checks every office in the
  Philippines every 5 minutes (the posts abroad still about hourly), and stores in Cloudflare R2 only what
  changed since its last scan, after each day's first record, which holds everything.

## [0.1.1] - 2026-09-27

### Changed

- The website moved to https://alphaexperiments.com/pengepassportph/, so the User-Agent and the package
  homepage now link there. The old address, alphaexperimental.org, no longer serves it.
- The READMEs now say when the rate limiter stops after an error: after 5 failures in a row, or a single
  `Retry-After` longer than an hour, for 15 minutes or as long as `Retry-After` asks, up to an hour.

## [0.1.0] - 2026-09-27

First release, on npm and PyPI.

### Added

- `PengePassportPH` client for Node.js: `regions()`, `countries()`, `sites()`, `findSites()`,
  `availability()`, `timeSlots()`, `watch()` and `stats()`. Results are copies: changing one never changes
  what the cache holds.
- The same client for Python (`pip install penge-passport-ph`), standard library only, synchronous and
  thread-safe. Its parsers are pinned by the same golden files as the Node.js ones.
- `penge-passport-ph` CLI (alias `penge`): `check`, `watch`, `sites`, `countries`, `regions`, with `--json`.
- `applicants` is 1, or 2 to 5 for a group: the most the DFA's group form takes (`MAX_APPLICANTS`).
- Built-in rate limiting shared across processes, including between Node.js and Python:
  - at least 2 s between requests (3 s by default);
  - an hourly budget of 300 by default and at most 1,200;
  - backoff with `Retry-After`, a circuit breaker, and a queue deadline.
- If the limiter's state file is damaged, requests pause for an hour, with a warning. What was sent in
  the last hour is then unknown, and the pause stops the budget being spent twice.
- Every request identifies itself: the User-Agent names the package and links to its website, and
  `contact` adds yours.
- A canary workflow that scrapes one real record (through both packages) and walks the booking UI
  every 6 hours, and opens an issue when the site changes.

[Unreleased]: https://github.com/alpharomercoma/penge-passport-ph/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/alpharomercoma/penge-passport-ph/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/alpharomercoma/penge-passport-ph/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alpharomercoma/penge-passport-ph/releases/tag/v0.1.0
