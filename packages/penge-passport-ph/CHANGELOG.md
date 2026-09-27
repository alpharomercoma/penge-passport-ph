# Changelog

All notable changes to PengePassportPH (`penge-passport-ph`) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The website moved to https://alphaexperiments.com/pengepassportph/, so the User-Agent and the package
  homepage now link there. The old address, alphaexperimental.org, no longer serves it.

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

[Unreleased]: https://github.com/alpharomercoma/penge-passport-ph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alpharomercoma/penge-passport-ph/releases/tag/v0.1.0
