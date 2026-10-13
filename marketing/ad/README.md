# The launch video

A 49-second, 1920×1080 ad for PengePassportPH, built entirely from code: screens of the live site
captured with Playwright (as the app from Google Play shows it), one HTML page that animates them frame
by frame, and an original track synthesised in Python.

The finished video is [`out/pengepassportph-ad-16x9.mp4`](out/pengepassportph-ad-16x9.mp4) (60 fps,
H.264 and AAC, -14 LUFS), with a cover image in [`out/thumbnail.png`](out/thumbnail.png). The rest of
`out/` and all of `frames/` are generated and not committed.

## YouTube upload copy

The title and description are in [`youtube.txt`](youtube.txt). Keep the clearly labelled disclosure at the bottom when editing the description. No hosted URL is recorded here yet. Play Console's preview video slot takes a YouTube URL: use a separate, app-first preview there (see below), not this cut.

**Publish this cut only once version 1.1.0 is on Play and has passed the phone check** (Task 23: Android's
own permission prompt naming PengePassportPH, the notification shown by the app, a tap opening the
office). Its alert scene shows 1.1.0's behaviour; version 1.0.0 shows notifications through Chrome.
It is a promotional cut for YouTube: as a Play preview video it fits Google's recommendations poorly
(app footage starts at about 11 s and is well under 80% of it), so make a separate one for that slot.

## Build it

```sh
cd marketing/ad
./build.sh   # out/pengepassportph-ad-16x9.mp4 and out/thumbnail.png
```

A rebuild rewrites the committed video and thumbnail; commit them again with the change that made them.

Needs Node 22+ with the repo's `npm ci` (for Playwright), [uv](https://docs.astral.sh/uv/) and
ffmpeg. About 3 minutes on an M5.

## How it fits together

| File | What it does |
| --- | --- |
| `ad.html` | The whole ad as one page. `window.renderAt(t)` draws the frame at `t` seconds and never reads the clock, so every frame renders the same every time. Scenes cut on the music's bar lines: `bar(n, beat)` at 128 BPM. |
| `music.py` | The track: 128 BPM, A minor, 25 bars and a tail, synthesised with numpy and scipy (no samples, nothing licensed). Seeded, so every run gives the same file. |
| `render.cjs` | Screenshots `renderAt` frame by frame in parallel Playwright pages. |
| `build.sh` | Music, a 120 fps render, each pair of frames blended into one at 60 fps (motion blur), music set to -14 LUFS, H.264 and AAC. |
| `capture.cjs` | Screens of the live site (a phone at 3x) and where the ad taps on them (`assets/boxes.js`). |
| `email.mts`, `email-shot.cjs` | The alert email from the server's own template (`apps/server/src/templates.ts`) with sample openings, its screenshot, and where its dates sit (`assets/email.js`). |
| `stills.cjs`, `sheet.sh` | Review: stills at chosen times (`node stills.cjs 3 12 27`), and 2×2 contact sheets. |

| Scene | Bars | Seconds |
| --- | --- | --- |
| Refresh, refresh, "Full na naman?!" | 0–2 | 0–3.75 |
| New slots drop at 12:00 NN & 9:00 PM, gone in minutes (riser, then silence) | 2–4 | 3.75–7.5 |
| The drop: logo, Free, Open source, Not a fixer | 4–6 | 7.5–11.25 |
| Every DFA office in the Philippines: 43, every 5 minutes | 6–9 | 11.25–16.88 |
| "Kabayan, nasa abroad ka?": 136 posts in 67 countries | 9–12 | 16.88–22.5 |
| Tap a day, see the hours | 12–15 | 22.5–28.13 |
| Pick offices, tap Notifications, Allow; "Notifications are on"; on the chime, "Dates open at Ilocos Norte"; then the email, for those who prefer it | 15–19 | 28.13–35.63 |
| Read-only, never books, not a fixer, free | 19–21 | 35.63–39.38 |
| Open source: npm and pip | 21–22 | 39.38–41.25 |
| End card: URL, QR code, Get it on Google Play, not affiliated with the DFA | 22–end | 41.25–49.08 |

## Changing it

- **Words, timing, layout:** edit `ad.html`, check a few stills, then `./build.sh`.
- **Fresh screens:** `node capture.cjs` rewrites `assets/` from the live site. The office, day and
  post are constants at the top; the day must be open, and the ad rings at most the first two hours
  with room. The committed screens are a snapshot of 13 Oct 2026 (Ilocos Norte, Tue 20 Oct, places left in
  most hours) that the live site will move on from, so review stills after recapturing. It runs
  the full Chromium build (`channel: 'chromium'`): the default headless shell reports notifications as
  denied whatever is granted, and the form would show its "blocked" hint.
- **Another email:** edit the openings in `email.mts`, then `npx tsx email.mts && node email-shot.cjs`.
- **Music:** the bar numbers in `music.py` (drop at bar 4, chime at 17, end hit at 22) and the scene
  bars in `ad.html` move together.

## Rules for anything made here

- Never a real person's address. The ad types `juan@example.com`, the site's own placeholder, and
  `capture.cjs` fills the form without sending it (it turns the Notifications switch on, and never
  presses "Turn on notifications").
- The system screens (Android's permission prompt, the notifications) are drawn in `ad.html`, with the
  app's words: the prompt and notifications name the app as Android does (its label, PengePassportPH),
  and the notifications' titles and bodies are what `apps/web/src/sw.js` and
  `apps/server/src/push/payload.ts` send.
- Google Play: Google's own "Get it on Google Play" badge (`assets/google-play-badge.png`, from
  play.google.com/intl/en_us/badges), unaltered, and "Google Play and the Google Play logo are
  trademarks of Google LLC." wherever it appears.
- No DFA or government seals or colours, and say it is unofficial: the end card says it is not run by
  or affiliated with the Department of Foreign Affairs.
- Every claim traceable. The 12 noon and 9 PM releases are the DFA's own notice (quoted in
  [docs/legal/README.md](../../docs/legal/README.md)); 43 offices, 136 posts in 67 countries (13 Oct
  2026) and the 5-minute checks are the live site's; the npm and pip lines are what those installs really print.
