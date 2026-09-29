# AppBuildersPH listing

What went into the "Submit an app" form on AppBuildersPH (2026-09-28). Same rules as the rest of
`marketing/`: every claim checked against the live site and the code.

**Since then:** on 30 September 2026 the offices in the Philippines went to being checked every 5 minutes.
The submission below says 15, as it was sent; the live listing's description needs the same change.

| Field | Value |
| --- | --- |
| App name | PengePassportPH |
| Tagline (up to ~80 characters) | Free email alerts when DFA passport appointment dates open, at home and abroad. |
| Website | https://alphaexperiments.com/pengepassportph/ |
| Categories | Productivity (main), Personal, Developer Tools |
| Tags | passport, dfa, appointments, philippines, ofw, email-alerts, open-source, npm, pypi |
| Pricing | Free |
| Launch date | 09/27/2026, when the site, the repo and both packages went public |
| Platforms | Web |
| Logo | [`logo-1024.png`](logo-1024.png) (the site's favicon, 1024×1024 on white) |
| Screenshots | [`1-philippines.png`](1-philippines.png), [`2-abroad.png`](2-abroad.png), [`3-hours.png`](3-hours.png), [`4-email.png`](4-email.png): 1920×1080 frames from [the launch video](../ad/README.md), rendered with `node stills.cjs 16.53 22.1 27.5 35.25` |

## Description

**Stop refreshing the DFA site.** The DFA releases new passport appointment dates at 12 noon and 9 PM,
Monday to Saturday, and they go in minutes. PengePassportPH watches for you and emails you when dates
open at the offices you can get to.

What it does:

- Checks all 43 DFA offices in the Philippines every 15 minutes
- Checks 133 embassies, consulates and outreach posts in 67 countries: hourly while they publish dates,
  every 6 hours while they don't
- Pick up to 10 offices, add your email, and get an alert when a date opens: at most once an hour, or as
  soon as a check finds dates if you'd rather, each with a one-click unsubscribe
- Tap an open day to see its hours and how many places are left, live from passport.gov.ph
- Booking for a group of 2 to 5? You only hear about dates with room for everyone

What makes it different:

- Free, with no account: confirm your email and you're set
- Read-only: it never selects, holds, books or sells a slot. You book on passport.gov.ph yourself.
  Not a fixer
- Open source (MIT), with npm and PyPI packages (`penge-passport-ph`) for developers, and rate-limited
  so it can't overload the DFA site
- Unofficial, and not affiliated with the Department of Foreign Affairs

Sources: release times are the DFA's notice quoted in `docs/legal/README.md`; cadence in
`deploy/systemd/penge-check.timer` and `apps/server/src/abroad.ts`; the 10-office and group-of-5 limits
in `packages/contracts` (`LIMITS`); the two paces are `PACES` there and `PACE_SPACING_MS` in
`apps/server/src/checker.ts`.
