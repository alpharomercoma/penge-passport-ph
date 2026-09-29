# Launch post

The LinkedIn caption that goes with [the launch video](ad/out/pengepassportph-ad-16x9.mp4) ([how it's
built](ad/README.md)) (2026-09-28). The same rules
apply: every claim checked against the live site and the code, no real addresses.

```text
(¬_¬")💢 Filipinos keep refreshing the DFA site, hoping a passport slot opens at an office near them. So I built PengePassportPH: a free, open-source site that emails you when passport appointment dates open, at home and abroad.

🇵🇭 All 43 DFA offices in the Philippines, checked every 15 minutes
🌏 133 embassies and consulates in 67 countries, checked about hourly
📩 Pick up to 10 offices, add your email, then book it yourself on passport.gov.ph

Website: https://alphaexperiments.com/pengepassportph/
npm: https://www.npmjs.com/package/penge-passport-ph
PyPI: https://pypi.org/project/penge-passport-ph/
GitHub: https://github.com/alpharomercoma/penge-passport-ph

Checker:
- Node + TypeScript on a systemd timer. It only reads the DFA's public calendar and never selects, holds or books a slot
- Rate-limited so it can't flood the DFA site
- Valkey for subscribers and state, Cloudflare R2 for scan history (for later analytics)

Email without a paid email API:
- Huawei Cloud Flexus L, 2 vCPU / 1 GB RAM in Manila ($4.50/mo), which runs everything: site, checker and mail
- Nodemailer → self-hosted Postfix + OpenDKIM, with SPF, DKIM, DMARC and reverse DNS so alerts land in the inbox
- Works with any domain name

For my international connections: "penge" is Filipino for "gimme", so PengePassportPH ≈ GimmeAPassportPH. I swear this isn't a fixer or forger (⊙ _ ⊙ ) It's read-only, free, and not affiliated with the DFA.

Even the video is code: Playwright captures of the live site, animated frame by frame, with music generated in Python.
```

Where the numbers come from, for the next post: 43 offices and 133 posts in 67 countries are what the
site lists; offices at home are checked on `deploy/systemd/penge-check.timer` (every 5 minutes since 30
September 2026; the post above went out when it was every 15), posts
abroad hourly while they publish dates and every 6 hours while they don't (`apps/server/src/abroad.ts`);
up to 10 offices is `LIMITS.sitesPerSubscription` in `packages/contracts`; the server size and price are
the Huawei Cloud FlexusL plan in use.
