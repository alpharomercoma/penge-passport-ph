# Google Play listing

What to enter in Play Console for the Android app (29 September 2026; graphics and metadata
revised 30 September against the Play kit in the sibling mobile-inference project). Same rules as the rest of
`marketing/`: every claim checked against the live site, the code or a cited page. How to build and
release the app is in [`docs/android.md`](../../docs/android.md).

## Store listing

| Field | Value |
| --- | --- |
| App name (30 at most) | PengePassportPH: Slot Alerts (28) |
| Short description (80 at most) | Open DFA passport appointment dates, with email alerts. Unofficial app. (71) |
| Default language | English (United States), en-US |
| Category | Travel & Local |
| Tags (5 at most) | Chosen in the Console from its own fixed list, which Google does not publish; see below |
| Website | https://alphaexperiments.com/pengepassportph/ |
| Privacy policy | https://alphaexperiments.com/pengepassportph/privacy |
| Contact email | **Not filled in here: you must supply it before submitting.** Required and shown publicly on the listing, so use an address made for this app and watched, not a personal one |
| External marketing | Leave on: it is Google advertising the listing outside Play, with no data from the app |

**The name.** The app name is what people see first in search results, and "PengePassportPH" alone
uses 15 of its 30 characters to say nothing about what the app does. "Slot" is the DFA's own word ("slots are made available at 12:00 noon
and 9:00 p.m.", its passport FAQ) and "alerts" is what the app sends. "DFA" stays out of the name so
that it cannot read as the Department's app; the short description, which is also searched, carries
it with "Unofficial". The plain "PengePassportPH" works too if you'd rather keep the brand alone.

**The launcher label is separate and stays "PassportPH"** (`launcherName` in
`android/twa-manifest.json`, and `short_name` in the web manifest): under an icon, anything past about
12 characters is cut short. The listing name and the label differing is normal.

**Tags.** Google's rule is that a tag's relevance should be obvious to someone who doesn't know the
app, from its listing or its first screen. Pick only those, even if that's fewer than five.

Full description (1,594 of 4,000 characters). Lead with appointment checking and alerts.
The sources, privacy link and clearly labelled independence disclosure appear at the bottom:

```text
See open DFA passport appointment dates and get email alerts for the offices you choose.

The DFA releases new passport appointment dates at 12 noon and 9 PM, Monday to Saturday, except holidays. PengePassportPH checks for you and emails you when dates open at the offices you can get to.

What it does
• Checks all 43 DFA offices in the Philippines every 5 minutes
• Checks 133 embassies, consulates and outreach posts in 67 countries: hourly while they publish dates, every 6 hours while they don't
• Tap an open day to see its hours and how many places are left, live from passport.gov.ph
• Pick up to 10 offices and get an email when a date opens: at most once an hour, or as soon as a check finds dates
• Booking for a group of 2 to 5? You only hear about dates with room for everyone

What it doesn't do
• It never selects, holds or books a slot, and never sells one. You book at passport.gov.ph yourself.
• No account, no ads, no tracking scripts.

Open source (MIT license): https://github.com/alpharomercoma/penge-passport-ph

Sources
• Appointment dates and hours: the DFA's Online Passport Appointment System, https://passport.gov.ph/appointment
• Release times: the DFA's passport FAQ, https://passport.gov.ph/faqs_2
• Department of Foreign Affairs: https://dfa.gov.ph

Privacy: https://alphaexperiments.com/pengepassportph/privacy

Disclosure
PengePassportPH is an independent, unofficial project. It is not run by, affiliated with or endorsed by the Department of Foreign Affairs (DFA) or any other government agency. Appointment availability comes from the DFA's public calendar.
```

Where each claim comes from:
- The release times are quoted from https://passport.gov.ph/faqs_2 ("12:00 noon and 9:00 p.m. Mondays to
  Saturdays except holidays", read on 29 September 2026).
- The 43 offices, and the 133 posts in 67 countries, are the live site's counts (`/api/status` and
  `/api/abroad`) on 29 September.
- The check cadence is set in `deploy/systemd/penge-check.timer` and `apps/server/src/abroad.ts`.
- The 10 offices and groups of 2 to 5 are `LIMITS` in `packages/contracts`; the two paces are `PACES`
  there.

`dfa.gov.ph` shows scripts a Cloudflare challenge, so it could not be fetched from here; it is the
Department's own domain.

## Graphics

All made by `node marketing/play-store/capture.cjs` (needs Playwright's Chromium and Python's Pillow).
The screenshots are of the live site, so rerun it when the site changes; `SITE=` points it at a local
build before a deploy.

| File | Play Console field | Size and format |
| --- | --- | --- |
| [`icon-512.png`](icon-512.png) | App icon | 512×512, 32-bit PNG, every pixel opaque, full square: Play rounds the corners |
| [`feature-graphic.png`](feature-graphic.png) | Feature graphic | 1024×500, 24-bit PNG ([`feature.html`](feature.html)), no screenshot in it: Play crops it on some surfaces |
| [`screenshots-phone/`](screenshots-phone) | Phone screenshots | Five at 1080×1920, 24-bit PNG |
| [`screenshots-tablet-7/`](screenshots-tablet-7) | 7-inch tablet screenshots | Five at 1200×2133 (the site at 600dp) |
| [`screenshots-tablet-10/`](screenshots-tablet-10) | 10-inch tablet screenshots | Five at 1800×3200 (the site at 900dp) |

Google doesn't allow price or promotional words ("Free", "Best", "New", "#1" and so on) on screenshots
and graphics, in the app name or in the short description, nor price or promotional offers in the full
description ([listing guidance](https://support.google.com/googleplay/android-developer/answer/13393723)).
So no field says "free" at all, the app's price or anyone else's. The screenshots leave out the site's
footer for the same reason: it calls the project, and booking, free.

Every screenshot is 9:16, since Play refuses one whose long side is more than twice the short one (and
any side over 3840 px). Google's rules
([screenshots](https://support.google.com/googleplay/android-developer/answer/9866151)):
- at most 8 per device type;
- at least 2 in all to publish;
- at least 4 for tablets;
- at least 4 at 1080 px or more for an app to be eligible for Play's recommendation formats.

Five per set meets all of these. Each screenshot has a caption above the screen:

| Screen | Caption |
| --- | --- |
| `01-offices` | Every office, soonest date first. *All 43 DFA offices in the Philippines, checked every 5 minutes* |
| `02-calendar` | Open days at a glance. *Each office's calendar, from the latest check* |
| `03-hours` | Tap a day for its hours. *Places left each hour, straight from passport.gov.ph* |
| `04-alert` | An email when dates open. *You choose how often; unsubscribing deletes your address* |
| `05-abroad` | Embassies and consulates too. *133 posts in 67 countries* |

The counts are read from the live API each time the script runs. The alert form is filled in with the
placeholder `juan@example.com` and never sent. The office shown is the one with the soonest open date
that day.

**They are a snapshot.** The counts, dates and places left on screen are the live site's at the moment of
capture (last run 30 September 2026), and change within hours. Rerun the script before each listing
update so the pictures stay close to what people will see.

**Alt text**, which Google asks for with every graphic and screenshot (140 characters at most):

| Image | Alt text |
| --- | --- |
| Feature graphic | PengePassportPH: know when a passport appointment opens. A month of full days with one open day. Unofficial. |
| `01-offices` | The list of DFA offices in the Philippines, each with its soonest open date and how many days are open. |
| `02-calendar` | An office's calendar for the month, with its open days in green, and buttons to book or get an email. |
| `03-hours` | One day's hours at an office, showing which are open, which are full and how many places are left. |
| `04-alert` | The form to get an email when dates open: an email address, who you are booking for, and how often. |
| `05-abroad` | Philippine embassies and consulates abroad, by country, each with its soonest open date. |

**The tablet shots came with a fix.** At a 10-inch tablet's 900dp, an office's page was a 640px
column pinned to the left with empty space beside it. The office page is now centred, like the privacy
and confirmation pages, and the screenshots show that.

## App content

| Declaration | Answer |
| --- | --- |
| Privacy policy | https://alphaexperiments.com/pengepassportph/privacy |
| Ads | No ads |
| App access | All functionality is available without special access: there is no sign-in |
| Target audience | 18 and over. The people booking are adults, and parents book for children; choosing ages under 13 brings in the Families policy |
| Government apps | "Is the app developed by or on behalf of a government?" **No.** It is not affiliated with any government. It does communicate government information (the DFA's appointment calendar), which is why the description says it is unofficial and names its sources |
| News app | No |
| Financial features | "The app does not provide any financial features" |
| Health apps | None of the health features listed apply: choose the answer that says so |
| Advertising ID | No. The app declares one permission, which AndroidX adds for its own receivers (`DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`), and no `AD_ID` (`aapt2 dump badging` on the APK) |

**Content rating questionnaire.** For the answers: there is no violence, sexual content, crude
language, drugs, alcohol or tobacco, and no gambling. Users can't talk to or share anything with each
other. There is no location sharing and nothing to buy. The app shows one website and doesn't browse
the web: links to other sites open in the browser.

**Release notes** ("What's new", 500 characters at most) for version 1:

```text
First release: open DFA passport appointment dates at every office in the Philippines and posts abroad, and email alerts when dates open.
```

## Data safety

What Play asks about is data sent off the phone, including by web content the app controls, which a
Trusted Web Activity's is ([Play's guide](https://support.google.com/googleplay/android-developer/answer/10787469)).
The answers follow the [privacy page](https://alphaexperiments.com/pengepassportph/privacy) and the
runbook's inventory ([`deploy/README.md`](../../deploy/README.md#where-a-subscribers-address-goes)).

| Question | Answer |
| --- | --- |
| Does the app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by the app encrypted in transit? | Yes: from the phone, HTTPS only (plain HTTP is redirected, HSTS for a year). The alert emails the server sends out use TLS when the recipient's mail server offers it (`smtp_tls_security_level = may`), as the privacy page says; that is delivery to the user, not collection from the phone |
| Can users request that their data be deleted? | Yes: https://alphaexperiments.com/pengepassportph/delete-data is linked from the app and privacy page and works before the first alert or after an email link is lost. It emails a one-time link; pressing its button deletes the address, choices, waiting alerts and unused signup links. Links expire after 48 hours. Encrypted backups and mail logs retain their disclosed copies for up to 14 days; temporary abuse counters and anonymous totals retain their disclosed lifetimes |
| Does the app let users create an account? | **No**, on Google's definition of an account ("a unique user identity that developers provide as a user-facing feature"): there is no sign-in, username, password or profile. Signing up for alerts stores an email address to send alerts to. If Play reads that as an account, it will also want an in-app way to delete it (the unsubscribe page) and an external deletion URL: use https://alphaexperiments.com/pengepassportph/delete-data, which accepts the email address without requiring an old alert link ([requirement](https://support.google.com/googleplay/android-developer/answer/13327111)) |

| Data type | Collected | Shared | Ephemeral | Required | Purpose |
| --- | --- | --- | --- | --- | --- |
| Personal info: Email address | Yes | No | No | Optional (only for alerts) | App functionality; Fraud prevention, security, and compliance (confirmation and deletion-link emails per address are counted under a keyed hash for about two days, so the form can't flood an inbox) |
| App activity: Other actions (the offices, group size and pace chosen for alerts) | Yes | No | No | Optional | App functionality |
| Device or other IDs (the network address every request comes from) | Yes | No | No | Required | Fraud prevention, security, and compliance; Analytics |
| App activity: App interactions (pages visited, offices opened, days' hours looked up) | Yes | No | No | Required | Analytics |

The network address is declared because the server uses it:
- the rate limits count requests under a keyed hash of it, not the address, for about two hours;
- the web server's error log may record the address itself when a request fails, and keeps it 14 days;
- the daily visitor count hashes it with the browser's user agent and a salt that is deleted within 25
  hours, and keeps only an estimate of how many different hashes it saw.

Play's guide asks for data to be declared by what it is used for, and says pseudonymous data can still
count. So the visitor count and the counts of what people open are declared as Analytics, although
they keep no one's details: the cautious reading, since the count starts from each visitor's address.

Not declared, and why:
- **Service providers aren't sharing.** Huawei Cloud runs the server, and Cloudflare R2 holds the
  encrypted backups. Play's guide exempts service providers acting on the developer's behalf.
- **The saved office list stays on the phone** (browser storage), so it isn't collected.
- **Location.** No location is inferred from the network address.
- **Failed lookups.** When passport.gov.ph fails to answer, the log (kept 14 days) notes the office, day
  and group size asked about, with nothing about who asked, so it isn't linked to anyone.

## A policy to be ready for

Google Play's policy on government information bars apps that "falsely claim affiliation with a
government entity or offer, or facilitate government services without proper authorization"
([requirements](https://support.google.com/googleplay/android-developer/answer/9514050)).

**This is an open question, not a settled one.** The facts in the app's favour:
- it only reads the public calendar anyone can open;
- it never selects, holds or books a slot;
- it sends people to passport.gov.ph to book;
- it says it is unofficial on every page, in the listing and in the app's description.

Against them, the DFA's own FAQ calls "passport appointment assistance services" illegal. The project's
legal notes ([`docs/legal/README.md`](../../docs/legal/README.md), "Open question") say a lawyer should
decide whether a free service that only tells people when dates open counts as "assistance". A reviewer
could read it that way too. Whether to submit before that is answered is the owner's decision.

## Production release gates

Before production, run `node android/check-play-release.mjs --play-sha256 <Play-app-signing-SHA256> --support-email <monitored-public-support-email>`. This verifies the actual Play certificate against the live root asset links, the public URLs and the local Android package settings. A missing certificate or support email fails the check; the upload certificate alone is not evidence of Play verification. It does not submit the app or change any files.

Enter the monitored support email in the Console contact field and the privacy page. Install from the Play test track and confirm fullscreen launch, booking links opening in the browser, email confirmation, deletion, offline recovery, Back navigation, and TalkBack. Check the pre-launch report. Verify production access and, when required for a new personal account, the 12-testers/14-days closed test. The local emulator install only verifies the upload key.
