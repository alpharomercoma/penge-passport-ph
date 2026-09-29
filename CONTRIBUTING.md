# Contributing to PengePassportPH

Thanks for helping. Three ground rules come before everything else:

1. **Read-only, always.** No change may select or submit a time slot, submit any booking form, touch the
   reCAPTCHA, or expose the internal slot ids. Choosing a slot holds it for 30 minutes and takes it from
   real applicants.
2. **The limits only get stricter.** Nothing may lower the floors in `LIMITS`
   (`packages/penge-passport-ph/src/rate-limit.ts`), add a way around the gate, or retry faster than the
   backoff allows.
3. **No email without a trustworthy scan.** The checker's guardrails (listed at the top of
   `apps/server/src/checker.ts`) decide when an alert may go out. Loosening one needs a test that shows why
   it is still safe.

## Layout

| Path | What it is |
|---|---|
| `packages/penge-passport-ph/` | The npm package and CLI: client, rate limiter, parsers |
| `packages/python/` | The Python port, `penge-passport-ph` on PyPI |
| `packages/contracts/` | Rules the website and server share: form validation, response shapes, date formatting |
| `apps/server/` | The checker (scan, R2 snapshot, alerts) and the website's API, bundled to two files |
| `apps/web/` | The website: React, built to static files, with a service worker and a web app manifest |
| `android/` | The Android app: `twa-manifest.json` and `build.sh`; the project is generated ([how](docs/android.md)) |
| `deploy/` | Server provisioning, systemd units, Caddy, releases, mail ([runbook](deploy/README.md)) |
| `scripts/canary/` | The canary that watches passport.gov.ph for changes |
| `marketing/` | The launch video, built from code ([how](marketing/ad/README.md)), the launch post, and the listings ([Google Play](marketing/play-store/README.md)) |

## Development

Everything Node.js, from the repository root:

```sh
npm install
npm run typecheck   # builds the library first; the server and website use its types
npm test            # every workspace: fixtures and fakes, no network
npm run build
```

The website against a local API (needs `.secrets/server.env`, see `deploy/server.env.example`):

```sh
npm run build -w @penge/server
(set -a; . .secrets/server.env; set +a; node apps/server/dist/server.mjs) &
npm run dev -w @penge/web          # http://localhost:5173, /api proxied to :8787
```

Python package, in `packages/python/`:

```sh
uv sync
uv run ruff check && uv run ruff format --check
uv run mypy       # strict
uv run pytest     # includes the Node/Python interop test once the npm package is built
```

## Fuzzing

Everything that reads untrusted input, enforces a limit or decides to send email is fuzzed, with fixed
seeds so every failure reproduces:

- `packages/penge-passport-ph/test/fuzz.test.ts` (fast-check) and `packages/python/tests/test_fuzz.py`
  (Hypothesis): the parsers never crash and keep their invariants, stay linear on adversarial input, and
  the cookie jar never emits a control character. The limiter, under random schedules and wall-clock
  jumps, never sends two requests closer than the interval, over the hourly budget or after a caller's
  deadline.
- `packages/python/tests/test_differential.py`: thousands of generated inputs through both packages'
  parsers, and fuzzed command lines through both CLIs; any difference fails.
- `packages/contracts/test/`: email and form validation never throw and accept only clean values; the
  response guards reject anything malformed.
- `apps/server/test/api.test.ts`: random methods, paths, content types and bodies never produce a 500.
- `apps/server/test/checker.test.ts`: random sequences of openings, failures and blank sites never
  announce a date that is not open now, was open at the last good look, or was announced within the hour
  window, and never email from an unhealthy scan.
- `apps/web/test/`: the form submits exactly what the shared rules accept and nothing else, whatever is
  typed or clicked; any valid status renders, with hostile office names as text; the API client turns
  every malformed answer into a readable error.

They run on every CI build at a small size. The weekly **Fuzz** workflow runs them large; locally:

```sh
FUZZ_RUNS=20000 npx vitest run --root packages/penge-passport-ph test/fuzz.test.ts
FUZZ_RUNS=5000 npm test -w @penge/contracts -w @penge/server -w @penge/web
cd packages/python && FUZZ_EXAMPLES=20000 uv run pytest tests/test_fuzz.py
cd packages/python && FUZZ_DIFF_N=100000 FUZZ_CLI_N=600 uv run pytest tests/test_differential.py
```

When a fuzzer finds something, add the input to `packages/penge-passport-ph/test/fixtures/parse-cases.json`
(parsers) or a unit test, so it stays fixed.

## Keeping the two packages equivalent

- **Parsing** is pinned by `packages/penge-passport-ph/test/fixtures/golden/`, generated from the
  TypeScript parsers. After an intended change to `src/parse.ts`, regenerate with
  `UPDATE_GOLDEN=1 npx vitest run --root packages/penge-passport-ph test/golden.test.ts`, then make
  `packages/python/src/penge_passport_ph/parse.py` pass `packages/python/tests/test_parse.py`. Add new
  edge cases to `test/fixtures/parse-cases.json`; both suites run them.
- **The rate-limit state file** is a shared protocol ([spec](docs/how-it-works.md#the-shared-state-file)).
  Change it in both languages at once; `packages/python/tests/test_interop.py` runs them together.
- **The CLI** keeps the same commands, flags, output and exit codes. The Python help text is tested to be
  byte-identical to the Node one.
- **Behaviour changes land in both packages in the same pull request.**

Tests never touch the network. When the site's responses change, capture new ones into
`packages/penge-passport-ph/test/fixtures/` (strip tokens and anything personal) and write a failing test
before fixing the parser.

To exercise the real site, run the canary (`npm run canary`, see [docs/canary.md](docs/canary.md)). It
stays within the same limits as the package; please don't run it in a loop.

## Naming

One name, used the same way everywhere:

| Thing | Name |
|---|---|
| The brand, in prose, titles, headings and the logo | PengePassportPH |
| npm package, CLI command, repository, state directory, User-Agent product | `penge-passport-ph` |
| Short CLI alias | `penge` |
| Main class, its options, base error | `PengePassportPH`, `PengePassportPHOptions`, `PengePassportPHError` |
| Environment variables | `PENGE_PASSPORT_PH_*` |
| Process warning code | `PENGE_PASSPORT_PH_STATE` |
| People in a booking | `applicants` (`--applicants`) |
| One hourly time slot | "slot" / `TimeSlot`, and nothing else |
| A DFA location, on the website and in emails | "office" |
| Python import package | `penge_passport_ph` |
| Python methods and arguments | snake_case (`find_sites`, `time_slots`, `from_date`); durations in seconds |
| Private workspaces | `@penge/contracts`, `@penge/server`, `@penge/web` |
| Server user, units, config | `penge`, `penge-api.service`, `penge-check.timer`, `/etc/penge/server.env` |
| Workflows | `CI`, `Canary`, `Fuzz`, `Deploy` |
| Canary issue | label `canary`, title `❌ PengePassportPH canary: passport.gov.ph changed` |

`packages/penge-passport-ph/src/meta.ts` holds the display name, package name, CLI alias, version,
homepage and env prefix; `test/meta.test.ts` checks them against `package.json` and the canary's
`scripts/canary/config.mjs`.

Write PengePassportPH (one word, capital P-P-P-H) when you mean the project, and `penge-passport-ph` in code
format when you mean something you type: the package, the command, a path. Call the website
passport.gov.ph, and the department the Department of Foreign Affairs (DFA). Never use DFA or Philippine
government seals, logos or colours, or wording that suggests the project is official.

## Releasing

Both packages are released together, with the same version.

1. Update the version in `packages/penge-passport-ph/package.json`, `packages/penge-passport-ph/src/meta.ts`,
   `packages/python/pyproject.toml` and `packages/python/src/penge_passport_ph/_meta.py` (the tests fail
   if any differ).
2. Add the release to `packages/penge-passport-ph/CHANGELOG.md`.
3. `npm publish -w penge-passport-ph` (runs typecheck, tests and build first; the npm account asks for a
   one-time password), then from `packages/python/`: `uv build && uv publish`.
4. Tag the commit `vX.Y.Z` and push the tag; the changelog links to it.

The npm and PyPI pages link to `REPOSITORY` (`src/meta.ts`) for source, issues and the changelog, and
their README images load from its `main` branch. `HOMEPAGE`, in the CLI help and every request's
User-Agent, is the live website.

The website and server are not published; pushing to `main` deploys them once CI passes
([runbook](deploy/README.md)).
