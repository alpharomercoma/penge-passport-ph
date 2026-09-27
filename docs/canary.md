# PengePassportPH canary runbook

The canary is the early warning that passport.gov.ph has changed in a way that could make
PengePassportPH wrong. It runs in [`.github/workflows/canary.yml`](../.github/workflows/canary.yml)
every 6 hours, on manual dispatch, and on pushes to `main` that touch the library (`packages/`) or the canary.

A run makes about 10 API requests and one browser walk, which is less than one person checking one site by
hand.

## What it checks

### API contract: `scripts/canary/api.mjs`

| Check | Fails when |
|---|---|
| `GET /appointment answers 200 HTML` | The landing page is down, blocked or no longer HTML |
| Anti-forgery token, server date and booking horizon present | The token input, `currentDate` or `MAX_DATE` is gone |
| Terms step unchanged | The terms form or the individual/group buttons changed |
| Endpoint map declared by the site is unchanged | Any of the 8 endpoint variables was renamed, moved, added or removed |
| `<script>` still builds the requests the package sends | The site's scripts no longer send the parameters the package sends |
| `<script>` unchanged since pinned | Either script differs at all from `scripts/canary/pinned/` (the diff is attached) |
| Countries, sites | The Philippines or the canary site disappeared, or the JSON shape changed |
| Availability parses | No published days, or the JSON shape changed |
| Time slots parse | A date listed as open yields no parsable slots |
| Day-level and slot-level data agree | A date stays "available" while every slot is booked, on two looks 65 s apart |
| Missing anti-forgery token is still answered with an empty 200 | The session-refresh logic would stop working |

### Python package: `scripts/canary/python.py`

Runs right after the API contract and scrapes the same site through the Python package.

| Check | Fails when |
|---|---|
| Python package is the same release as the Node package | The two versions drifted |
| Countries, sites, availability | Same as the API contract, through the Python parsers |
| Same published dates as the Node client | Python and Node read a different set of dates |
| Same time slots as the Node client | Python and Node read different slot times for the same date |

Open dates may differ between the two runs, since slots can be taken in the seconds between them. That is
a ⚠️, not a ❌.

### UI flow: `scripts/canary/ui.mjs`

Headless Chromium walks: home → fixer warning → consent → Start Individual Appointment → region, country and
site → confirmation → calendar → click a date (an open one if any, else a booked one). It checks each
screen, the requests the page sends, that the calendar's earliest date matches the endpoint, that no time
slot comes back selected, that NEXT stays disabled, and that every non-GET request is on an allowlist. It
never clicks a time slot.

## Reading a result

Each check is one line in the job summary:

| Mark | Meaning |
|---|---|
| ✅ | Passed |
| ❌ | Failed: the job fails, an error annotation is added, and the canary issue is opened or updated |
| ⚠️ | Worth a look but not a failure (e.g. no published dates to click) |
| ⏭️ | Skipped because an earlier step failed |

On any ❌, the run uploads `canary-results` (screenshots, JSON, diffs) and opens one issue titled
`❌ PengePassportPH canary: passport.gov.ph changed (N checks failing)` with the label `canary`. Later
failing runs comment on it only when the set of failures changes. The first passing run closes it. A failure
in install, build or Chromium setup opens the issue too.

## Responding to a failure

1. **Open the issue and the run.** The summary names each failing check and what it saw. Screenshots are
   in the artifact.
2. **Rule out an outage.** If the landing page itself failed, the site may be down or blocking GitHub's
   runners (they are outside the Philippines). Re-run the workflow later, or from a machine in the
   Philippines: `npm run canary`.
3. **Script changed?** Read the attached diff.
   - If the request shape changed (endpoint, parameter names, token handling), update `packages/penge-passport-ph/src/` and the fixtures
     under `packages/penge-passport-ph/test/fixtures/`, then update `scripts/canary/expected.json`.
   - If it's cosmetic, re-pin: `npm run canary:api -- --update`, review the diff with `git diff`, commit.
4. **Markup changed?** Parser failures point at `packages/penge-passport-ph/src/parse.ts`. Capture the new
   response into `packages/penge-passport-ph/test/fixtures/`, add a test that fails, then fix the parser.
5. **Canary site gone?** Set another site id in `expected.json` (`canarySiteId`), or dispatch the
   workflow with `site_id`.
6. **Merge the fix to `main`.** The canary runs on the push and closes the issue when it passes.

Until the issue is closed, treat PengePassportPH results as unreliable.

## Running it locally

```sh
npm install
uv sync --project python          # once, for the Python part
npx playwright install chromium   # once
npm run canary                    # all three parts; or canary:api / canary:python / canary:ui
```

## Settings

| Variable | Default | Effect |
|---|---|---|
| `PENGE_PASSPORT_PH_SITE_ID` | `canarySiteId` in `expected.json` (486, Antipolo) | Site to scrape |
| `PENGE_PASSPORT_PH_BASE_URL` | `https://passport.gov.ph` | Site root |
| `PENGE_PASSPORT_PH_RESULTS_DIR` | `canary-results` | Where results, screenshots and diffs go |
| `PENGE_PASSPORT_PH_ISSUE_DRY_RUN` | unset | `1` prints the `gh` calls instead of making them |

The canary's settings live in `scripts/canary/config.mjs`, which is deliberately independent of the built
package so the issue step still works when the build fails.
