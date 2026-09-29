# Running the PengePassportPH website

One small Debian 13 server runs everything: the website, its API, the checker that scans
passport.gov.ph, and the mail server that sends the alerts. Scans are stored in Cloudflare R2 for
analysis; subscribers and live state are in Redis. Nothing here needs AWS, Google Cloud or Vercel.

```
                      ┌──────────────────────────── the server ─────────────────────────────┐
 visitor ──HTTPS──▶   │ Caddy ──▶ /            static React build   (/opt/penge/current/web) │
                      │       └─▶ /api/*       penge-api.service    (127.0.0.1:8787)         │
                      │                                                                      │
 passport.gov.ph ◀──  │ penge-check.timer, every 5 min ─▶ penge-check.service (one scan)     │
                      │                                                                      │
 inboxes ◀──SMTP───   │ Postfix (localhost only) ◀─ OpenDKIM signs every message             │
                      │                                                                      │
                      │ Valkey (Redis, 127.0.0.1 only): subscribers, status, outbox, caches  │
                      └──────────────────────────────────────────────────────────────────────┘
                              │ one file per scan, and a daily copy of the subscribers
                              ▼
                         Cloudflare R2 (pengepassportph)
```

| Piece | Where |
|---|---|
| Website build | `/opt/penge/current/web`, served by Caddy |
| API and checker bundles | `/opt/penge/current/server/{server,check}.mjs`, run by Node.js 24 as user `penge` |
| Releases | `/opt/penge/releases/<time>-<commit>`; `current` points at the live one; five are kept |
| Secrets | `/etc/penge/server.env` (root:penge, 0640); template in `server.env.example` |
| Rate-limiter state, R2 spool | `/var/lib/penge/limiter`, `/var/lib/penge/spool` |
| Units | `penge-api.service`, `penge-check.service`, `penge-check.timer`, `caddy.service` |

## What the checker does, and when it refuses to email

Every 15 minutes (a scan is ~45 requests at the library's 3-second pace and takes about 2.5 minutes),
`penge-check.service` asks every office for its calendar for one person, looks up group sizes that
subscribers asked for, and stores the scan in R2. Then, only if the scan passes its checks,
it compares each office with its last good look and emails whoever was waiting for a date that just
opened. After that, the same run checks the 36 most overdue of the ~130 posts abroad (below). The
guardrails:

1. One run at a time, enforced in Redis, so a laptop pointed at the same Redis cannot race the server.
2. **An unhealthy scan sends nothing and changes no baseline**: the office list failed or was empty,
   more than 20% of offices failed, no office published any date, or the office list came back more
   than a fifth shorter than the last good one (which then stays).
3. An office that failed, or suddenly publishes no dates, keeps its baseline, so a glitch can never make
   every date look new on the next run. An office the site answers with an error is tried once more at
   the end of the scan (3 at most); if it fails again, the website shows what was last known about it,
   and when.
4. The first look at anything is a baseline, never an alert.
5. A date is announced at most once every 3 hours, however often it flickers (held slots are released
   after 30 minutes).
6. Caps: 3 alerts per subscriber per Manila day; `MAIL_DAILY_LIMIT` (300) emails a day in total.
7. Alerts older than an hour are dropped.
8. Three mail failures in a row stop delivery; the rest waits for the next run. An email the mail
   server refused is tried again later and not charged to anyone's daily count; one that failed
   part-way through may already have gone out, so it stays charged and is never sent twice.
9. A Redis flag pauses all delivery at once (below).
10. **The checker rests when the site struggles.** If, after the retries, 3 or more offices still
    answer with errors, or the rate limiter had to pause, the next scans wait 20 minutes: the next run
    is skipped, so the site is asked every 30 minutes instead of every 15. A run still going when the next is due is
    skipped by systemd, so a slow site also slows the scans.

Exit code 3 means the scan failed its checks and nothing was emailed; `systemctl --failed` shows it.

The API asks passport.gov.ph too, but only when someone opens an office or taps a day: fresh dates, dates
for a group, and the hours of a day. Each answer is shared with everyone for 3 minutes.

**Posts abroad** (`apps/server/src/abroad.ts`): the embassies, consulates and outreach missions that
book on passport.gov.ph too, 133 in 67 countries in September 2026. They are not all asked on every
run. Each run, after the scan at home and its emails, checks the 36 most overdue on their own
rate limiter: a post that publishes dates, or that someone follows, about once an hour; one that
publishes none, every 6 hours. The list of posts is read again once a week, a few countries per run
(all 42 of a run's requests the first time, so a new server lists them within half an hour, checking none meanwhile).
Alerts follow the same rules as at home; a run where most of its posts failed sends nothing from them,
and each post that failed keeps what was known. What each run saw goes to R2 under `scans-abroad/`.

**Three budgets that never compete** (`apps/server/src/budget.ts`, checked by `test/budget.test.ts`):

| | Rate limiter state | Most in any rolling hour | What fills it |
|---|---|---|---|
| Scans | `/var/lib/penge/limiter/scans` | 300 | 4 scans × (43 offices, a session, the office list, 3 retries, 10 group checks) = 232 at most, leaving room for one run by hand |
| Posts abroad | `/var/lib/penge/limiter/abroad` | 300 | 4 runs × (a session, 42 shared by 36 posts and 6 steps of reading the list, 4 group checks) = 188 at most, leaving room for a sweep by hand (about 135) |
| Visitors' lookups | `/var/lib/penge/limiter/lookups` | 1000 | Fresh dates, group dates, hours of a day, and the API's own sessions |

All are enforced by the library over an exact rolling hour, each request at least 3 seconds after
the last one on the same limiter. A busy hour of visitors cannot delay a scan. Past the lookups'
budget, the page shows the last answer with its age, or says to try again in a few minutes.
[docs/legal](../docs/legal/README.md) explains how these numbers were chosen and what the law and
the DFA say.

## When things update

All times are Manila time; the server's clock is UTC.

| What | When | Notes |
|---|---|---|
| Every office's dates, for one person | A scan starts at :02, :17, :32 and :47 and usually finishes in 2–3 minutes (median 2.5, slowest 3.7 in the first 52 scans; capped at 10) | Failed offices are tried once more (3 at most); after that, the website shows what was last known and when. The checker skips a run after a scan the site struggled with |
| Group dates for subscribers | During each healthy scan, at offices with room for one person, at most 10 | |
| A post abroad's dates, for one person | About hourly; every 6 hours while it publishes none and nobody follows it | 36 posts each run, after the scan at home and its emails; alerts in the same run. The list of posts is read again weekly |
| An open page | Reads the latest scan every 60 s; the ages it shows count up every 30 s, even while the server cannot be reached | |
| An office's dates for one person | When a visitor opens the office | From the office's scan while it is under 8 minutes old (the scans keep it so); only older than that is the DFA asked, so the hours a visitor taps next never wait behind it |
| Group dates, hours of a day | When a visitor changes the group size or taps a day | Asked of the DFA, in one request: while a person has the site open, a DFA session is kept ready (at most one request every 7 minutes or so, none while nobody visits); shared for 3 minutes; an older answer (up to an hour) with its age when the DFA cannot be asked. An office page does not ask again by itself; the list behind it keeps reading the scans |
| Email alerts | In the same run as the healthy scan that found the date | 3 a day per subscriber and 300 a day in total by default (`ALERTS_PER_SUBSCRIBER_PER_DAY`, `MAIL_DAILY_LIMIT`); a date at most once in 3 hours |
| Debian and Caddy security updates | Daily | Restart at 04:30 only when an update needs it |
| Node.js security releases | Weekly, Tuesday 04:10–04:40 | Signature-checked; runs at the next boot if the server was off |
| HTTPS certificate | Caddy renews it before it expires | |
| Scans to R2 | Every scan | If R2 cannot be reached, they wait on disk (up to 5,000, about 17 days) and are sent later. What each run saw at the posts abroad goes to `scans-abroad/`, and is not kept for later if R2 is down |
| Subscriber backup to R2 | Once a day, on the first scan after midnight | |
| Daily numbers to R2 and by email | Once a day, on the first scan after 07:00 (Manila), for the day before | `stats/v1/`; emailed to `STATS_EMAIL` when set ([Daily numbers](#daily-numbers)) |
| Valkey to disk | Continuously | Append-only file, flushed every second |
| Logs | Rotated daily | Journal kept 14 days; the mail log and root's mailbox keep 3 old days plus today |
| Canary | Every 6 hours, and on pushes that change either package | A few read-only requests through both packages, and a walk of the booking pages; opens an issue when the site changes |
| Fuzzing | Mondays | |
| Deploy | After CI passes on a push to `main` | Needs the `production` environment's secrets (below) |

## First-time setup

On your machine, with the secrets in `.secrets/server.env` (never committed). A minimal Debian image may
lack rsync: `ssh root@SERVER apt-get install -y rsync` first.

```sh
ssh-keygen -t ed25519 -N '' -C 'penge-deploy' -f .secrets/deploy_key   # the CI deploy key
rsync -a deploy/ root@SERVER:/root/penge-deploy/
ssh root@SERVER "DEPLOY_PUBKEY='$(cat .secrets/deploy_key.pub)' bash /root/penge-deploy/provision.sh"
scp .secrets/server.env root@SERVER:/etc/penge/server.env               # provision created /etc/penge
ssh root@SERVER 'chown root:penge /etc/penge/server.env && chmod 0640 /etc/penge/server.env'
ssh root@SERVER 'bash /root/penge-deploy/setup-valkey.sh'               # points REDIS_URL at the local Valkey
deploy/release.sh penge-deploy@SERVER                                     # first release
```

`provision.sh` is safe to run again after any change in `deploy/`; the site's address comes from
`deploy/site.conf`. It sets up SSH (keys only) and the firewall (22 rate-limited, 80, 443), automatic
security updates for Debian and Caddy with a nightly reboot window when a kernel update needs one,
Node.js from nodejs.org **with its release signature checked** against the Node.js release keys pinned in
`deploy/keys/` (and `penge-node-update.timer` to take new v24 releases weekly), Caddy with its signing key
pinned and only the capability to bind ports 80 and 443, the `penge` and `penge-deploy` users, the units,
and the Caddy config. Logs are kept 14 days.

**The deploy key can do two things**: upload a release into `/opt/penge/releases` (a gzipped tar that
`penge-receive` unpacks, refusing links, special files and anything over 100 MB) and activate one. It has no shell; `/usr/local/bin/penge-deploy-gate` is forced for it. It is still
production-code authority: whoever holds it can ship code that runs as `penge` and reads its secrets, so
keep it only in GitHub's `production` environment.

**Redis** is Valkey, Debian's open-source Redis, on the server itself (`setup-valkey.sh`, run by
`provision.sh`): it listens on 127.0.0.1 only, has a password as well, keeps an append-only file, and
never evicts. The server refuses a Redis elsewhere unless it is `rediss://` (TLS). Addresses in it are
encrypted and queued alerts are signed; the checker copies the subscribers to R2 every day.

## Moving to another server

**Check first that the new server can reach passport.gov.ph**: `curl -4 -m 15 -sS -o /dev/null -w '%{http_code}\n'
https://passport.gov.ph/` must print a status, not time out, and keep doing so for a while. The site's
server lets some networks in and silently drops others, sometimes only part of the time, so a looking
glass cannot tell (it only pings and traces, which the site ignores from everyone). On 27 September 2026:

- WebHorizon Singapore (160.191.77.75) never got an answer; that move was rolled back after one scan.
- Huawei Cloud FlexusL Manila (213.250.173.234, 2 vCPU, 1 GiB) answers in about 50 ms, and the service
  moved there from RackNerd (107.172.159.170). RackNerd forwards stale visitors there until it is retired.

Huawei's Debian image needed more than the usual steps:
- It ships Debian 11 with `base-files` held: upgrade in place to 12 and then 13 (`apt-mark unhold
  base-files`), from Debian's own mirror. Huawei's cloud-init no longer runs after that (it was not
  installed as a package), and nothing needs it: `touch /etc/cloud/cloud-init.disabled`.
- Its internal DNS server (100.125.1.250) does not answer: public resolvers go in
  `/etc/resolvconf/resolv.conf.d/head`, plus `supersede domain-name-servers` in `dhclient.conf`.
- The security group lets nothing in: allow TCP 22, 80, 443 and UDP 443.
- The server only sees its private address (1:1 NAT), so the mail scripts need
  `PUBLIC_IP=213.250.173.234` once; `setup-mail.sh` remembers it.
- The clock starts on Asia/Shanghai: `timedatectl set-timezone UTC`. Set a hostname in `/etc/hosts`,
  or sudo complains.

The procedure, with scans and email paused for about five minutes:

1. On the new server: timezone UTC, `apt-get full-upgrade`, reboot. Add a second A record for `penge`
   pointing at it and ask the provider for its reverse DNS; add its IP to `penge`'s SPF record.
2. Copy Caddy's certificates (`/var/lib/caddy/.local/share/caddy/{acme,certificates}`, owned by a `caddy`
   user created first), so Caddy never asks for a certificate the old server still answers for.
3. `provision.sh` as in first-time setup, then **`systemctl disable --now penge-check.timer`** at once:
   two servers scanning double the load on passport.gov.ph, and a reboot would start it.
4. Copy `/etc/penge/server.env` as is, then run `setup-valkey.sh` (it repoints `REDIS_URL`). Copy the DKIM
   key (`/etc/opendkim/keys/<domain>/penge.{private,txt}`) before `setup-mail.sh`, which then keeps it.
   `check-mail-dns.sh` passes; send yourself a test.
5. `deploy/release.sh` to the new server.
6. On the old server, `systemctl disable --now` the timer (after the running scan: a running oneshot is
   `activating`, not `active`), `penge-api` and `valkey-server`. Copy `/var/lib/valkey/{appendonlydir,dump.rdb}`
   and `/var/lib/penge/limiter` across (the limiter file carries the rolling hour over), start Valkey and
   the API, compare `DBSIZE`, and enable the timer on the new server. Watch its first scan.
7. Point the old Caddy at the new server (`reverse_proxy https://NEW_IP` with `header_up Host {host}` and
   `tls_server_name`), so visitors with stale DNS still reach it. Then move the apex A record, drop the old
   IP from `penge`'s A and SPF records, and update `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`.

Rolling back is the same steps the other way. Afterwards, wipe the data left on the server you leave:
a copy there would survive an unsubscribe.

## Deploying

Pushing to `main` deploys once CI passes (`.github/workflows/deploy.yml`). It needs three repository
secrets, under Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | `213.250.173.234` |
| `DEPLOY_SSH_KEY` | the contents of `.secrets/deploy_key` |
| `DEPLOY_KNOWN_HOSTS` | the contents of `.secrets/deploy_known_hosts` (the server's pinned host key) |

Put them in a GitHub **environment** named `production` (Settings → Environments), limited to the `main`
branch. The workflow builds in one job with no secrets, then a second job downloads the built files and
ships them, so `npm ci` never runs next to the key. By hand, with an `~/.ssh/config` entry for the deploy user:

```sh
npm ci && deploy/release.sh penge-deploy@213.250.173.234
```

Each release is uploaded as `releases/<id>.partial` (a tar stream over SSH, so it works the same from macOS
and Linux), then `penge-activate` (one at a time, under a lock)
publishes it, switches `current` to it, restarts the API and waits for `/api/ready` (which also proves Redis
answers). If the API does not become ready, it switches back and the deploy fails.
The checker picks up the new release on its next run.

## Turning on email

The server sends its own mail; nothing is paid for or rate-limited by a provider. Mail stays in dry-run
(every message is built, none is sent) until all of this is done.

**Mail for this deployment comes from `alerts@penge.alphaexperiments.com`**, a subdomain that is also the
server's mail host name (HELO and reverse DNS). The apex `alphaexperiments.com` stays free for other mail,
and the alerts' sending reputation can never affect it. DNS is on Vercel. The website is at
<https://alphaexperiments.com/pengepassportph/> (`/p3h` and `penge.alphaexperiments.com` redirect there;
both set in `deploy/site.conf`).

Until 27 September 2026 all of this was on `alphaexperimental.org` (mail from
`alerts@penge.alphaexperimental.org`). That domain no longer serves the site or sends its mail: its
records for the site and the `penge` subdomain were deleted, so links in emails sent before the move no
longer work. Two records stay, so nobody else can send as the old address: `penge` has
`v=spf1 -all`, and `_dmarc.penge` has `p=reject`.

| Step | State |
|---|---|
| 1. Postfix + OpenDKIM on the server: `MAILHOST=penge.alphaexperiments.com bash /root/penge-deploy/mail/setup-mail.sh penge.alphaexperiments.com` | done |
| 2. DNS records it printed (A, SPF, DKIM `penge._domainkey.penge`, DMARC `_dmarc.penge`), added with `vercel dns add` | done |
| 3. Website at `alphaexperiments.com/pengepassportph` (`deploy/site.conf`; `PUBLIC_BASE_URL` follows it) | done |
| 4. `MAIL_FROM=alerts@penge.alphaexperiments.com` in `/etc/penge/server.env` | done |
| 5. Reverse DNS of the server's IPv4 address: `penge.alphaexperiments.com`. On Huawei Cloud: Domain Name Service console → PTR Records → Create (the FlexusL "Domain" page is a forward binding, not this). IPv6 needs none: Postfix sends over IPv4 only | done |
| 6. `bash /root/penge-deploy/mail/check-mail-dns.sh`: every line `ok` | done |
| 7. Test messages to your own inbox; "Show original" in Gmail should say SPF, DKIM and DMARC: PASS, and land in the inbox | done: after reverse DNS, a real alert landed in the inbox at Gmail (SPF, DKIM, DMARC pass) and Proton; the one test before reverse DNS went to spam. Again from the WebHorizon server on 27 September: inbox at both |
| 8. `MAIL_MODE=live` in `server.env`, then `systemctl restart penge-api`; the website's form switches on by itself | done (27 September 2026) |

A new domain on a new IP starts with no reputation, so the first messages often go to spam whatever the
records say. Mark them "Not spam", and send little at first: `MAIL_DAILY_LIMIT` (300) keeps volume low
while reputation builds. Google Postmaster Tools (postmaster.google.com, verify the subdomain with a TXT
record) shows how Gmail rates the domain once there is some volume.

The test message, from the server:

```sh
printf 'Subject: PengePassportPH test\n\nHello from the server.\n' | sendmail -f alerts@penge.alphaexperiments.com you@example.com
```

For another domain, the same steps apply: `setup-mail.sh <domain>` (with `MAILHOST=` when the mail
host is not `mail.<domain>`) prints the records; `setup-mail.sh` remembers the domain and mail host in
`/etc/penge/mail.conf`, so `check-mail-dns.sh` needs no arguments.

Postfix listens on 127.0.0.1 only, accepts only `alerts@<domain>` as a sender (and the `sendmail` command
only from root), caps itself at 150 messages a minute, and refuses to send anything OpenDKIM has not signed;
the signature covers both List-Unsubscribe headers, which Gmail and Yahoo require for one-click unsubscribe.

When a receiving server refuses an email while Postfix is delivering it (the usual case), the bounce lands
in `/var/mail/root` (`less /var/mail/root`). Bounces a provider sends back later, by email, are lost: the
subdomain receives no mail. Postfix gives up on a message after a day, since an older alert is useless.
Postfix's delivery log (`/var/log/postfix/mail.log`) and root's mailbox name recipients, so each is
rotated daily and kept 3 days.

Optional: add `rua=mailto:<an inbox you read>` to the DMARC record to receive daily reports; once a week of
them looks clean, tighten the record to `p=quarantine`.

## Day to day

```sh
systemctl list-timers penge-check.timer          # when the next scan runs
journalctl -u penge-check -n 20 -o cat           # last scans: one JSON line each
journalctl -u penge-api -f -o cat                # API log (no addresses or tokens are ever logged)
systemctl start penge-check                      # scan now
curl -s https://alphaexperiments.com/pengepassportph/api/status | head -c 400
```

**Check every post abroad now** (a sweep, for testing; about 135 requests on their own limiter, so at
most about once an hour). It is a normal run, under the same lock, with the posts abroad all checked
whether due or not; the rotation then carries on from there:

```sh
systemd-run --wait --pipe -p User=penge -p EnvironmentFile=/etc/penge/server.env -E PENGE_ABROAD_SWEEP=1 \
  /usr/local/bin/node /opt/penge/current/server/check.mjs
```

**Pause every email at once** (alerts and confirmation emails; checked before every message; the outbox
keeps filling and alerts over an hour old are dropped):

```sh
apt install redis-tools                            # once, for redis-cli
REDIS_URL=$(sed -n 's/^REDIS_URL=//p' /etc/penge/server.env)   # read, never `source`, the env file
redis-cli -u "$REDIS_URL" SET pp:mail:paused 1     # resume: DEL pp:mail:paused
```

`MAIL_MODE=dry-run` is not a pause: alerts are built, logged and discarded, and do not come back when
mail is switched on again.

**Stop scanning**: `systemctl stop penge-check.timer` (and `disable` to keep it stopped after reboot).

**Roll back**: `ln -sfn releases/<older> /opt/penge/current.new && mv -T /opt/penge/current.new
/opt/penge/current && systemctl restart penge-api`, or run `penge-activate <older>` as `penge-deploy`.

## Where a subscriber's address goes

What the email field on the site promises ("Our database and backups keep your address encrypted, and we
use it only for these alerts. Unsubscribing deletes it; the last copies, in backups and mail-server logs,
are gone within 14 days."), checked on 27 September 2026:

| Where | What is there | Encrypted | Gone after unsubscribing |
|---|---|---|---|
| Browser to server | The form, over HTTPS: TLS 1.2 or 1.3 (Caddy's default; 1.3 when we checked); plain HTTP is redirected, and HSTS is set for a year | Yes | Not stored |
| Valkey | AES-256-GCM, a fresh nonce each time (`crypto.ts`); lookups use a keyed hash, never the address | Yes | At once |
| Unconfirmed sign-ups | The same encrypted record, waiting for its link to be clicked | Yes | At once (unsubscribing cancels them); otherwise after 48 hours |
| Daily backups in R2 | The records exactly as stored | Yes | Within 14 days: each day's scan deletes every copy older than that |
| API and checker logs | No address: the code never logs one, and every line is scrubbed of anything shaped like one (tests check both) | Nothing to encrypt | Not stored |
| Confirmation and unsubscribe links | Random tokens, stored only as a hash | Nothing to encrypt | Not an address |
| Postfix, while sending | The message, with its recipient, waits in the queue until delivered (at most a day; root and postfix only) | **No** | Within a day |
| Postfix's delivery log | One line per delivery, with the recipient (`/var/log/postfix/mail.log`, root only, rotated daily, 3 kept) | **No** | Within 4 days |
| Root's mailbox | Bounces: the refused message and its recipient (`/var/mail/root`, 0600, rotated daily, 3 kept) | **No** | Within 4 days |
| Server to the recipient's mail server | TLS when offered (`smtp_tls_security_level = may`), without checking the certificate. All 5 deliveries so far used TLS 1.3 | Usually | Not stored |
| The recipient's inbox | The email itself, as with any email | Their provider's | Theirs to delete |

The key that decrypts the addresses is in `/etc/penge/server.env` on the same server, so encryption
protects copies of the database and its backups, not a server that is itself compromised.

The journal (kept 14 days) holds two recipient lines from the first test sends on 26 September, before
Postfix had its own log; they age out by 10 October.

**Visitors' network addresses.** No access log is kept. The API counts requests per address to limit
them, under a keyed hash of the address (never the address itself), and the counters expire after about
two hours. Caddy's error log (in the journal, 14 days) does record the visitor's address when a request
fails, for example a dropped HTTP/3 connection.

**Visitors, counted.** The [daily numbers](#daily-numbers) count distinct visitors without a cookie, a
script or a stored address: the API hashes the visitor's network address and browser (user agent) with a
random salt for the Manila day and adds the hash to a HyperLogLog, which keeps an estimate of how many
distinct hashes it saw, not the hashes. The salt is deleted within 25 hours, after which nobody can tell
whether a given address visited, even with the database and the server's keys.

## Keys and backups

Subscribers live only in Redis. Once a day the checker copies them, as stored (addresses encrypted), to R2
at `backups/subscribers/date=YYYY-MM-DD/subscribers.json.gz`, and deletes the copies older than 14 days,
so an address removed on unsubscribing leaves the backups too. To restore, download one and run, on the
server:

```sh
install -o penge -m 0600 subscribers.json.gz /var/lib/penge/restore.json.gz
systemd-run --wait --pipe -p User=penge -p EnvironmentFile=/etc/penge/server.env \
  /usr/local/bin/node /opt/penge/current/server/admin.mjs restore /var/lib/penge/restore.json.gz --yes
```

(`admin.mjs backup > file.json` makes a copy by hand.) A backup restores only with the same
`EMAIL_ENC_KEY`, `EMAIL_HMAC_KEY` and `TOKEN_SECRET`.

- `EMAIL_ENC_KEY` encrypts every stored address. **Lose it and every subscriber is lost**; keep a copy
  of `/etc/penge/server.env` in a password manager.
- `EMAIL_HMAC_KEY` finds an address without decrypting it. `TOKEN_SECRET` signs unsubscribe links;
  changing it breaks every link already sent.
- The DKIM private key is `/etc/opendkim/keys/<domain>/penge.private`. Losing it only means generating
  a new one and updating the DNS record.
- Rotate the Redis password and the R2 keys from their dashboards, update `server.env`, restart the API.

## Daily numbers

The API counts, per Manila day: distinct visitors (estimated, see above) and how many of them looked at
the posts abroad, offices opened and which ones most, group sizes checked, days tapped for their hours,
confirmation emails, new subscribers, changed subscriptions and unsubscribes. The checker adds its runs,
the new dates it found, the alerts it sent and the ones the daily cap held back. Nothing is added to the
page, and a request never waits for its count (`apps/server/src/stats.ts`). Crawlers, link previews and
scripts are not counted as visitors.

On the first scan after 07:00 Manila time, yesterday's numbers go to R2 as
`stats/v1/date=YYYY-MM-DD/stats.json` (`DailyStats` in `stats.ts`) and, when `STATS_EMAIL` is set in
`/etc/penge/server.env`, to that address. The day counting began is marked as partial. The counters stay
in Valkey 40 days.

```sql
SELECT day, visitors, counts.officeViews, counts.confirmed, counts.alertsSent
FROM read_json('r2://pengepassportph/stats/v1/*/stats.json') ORDER BY day;
```

## Data in R2

Each scan is one gzipped JSON file, partitioned by UTC date:
`scans/v1/date=YYYY-MM-DD/<started>_<run id>.json.gz`. The schema is `Scan` in
`apps/server/src/snapshot.ts`: every office's published days and whether each had room for one person,
the group-size lookups, whether the run passed its health checks, and why not. With DuckDB:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET r2 (TYPE r2, KEY_ID '…', SECRET '…', ACCOUNT_ID '…');
SELECT s.name, d.date, count(*) FILTER (WHERE d.available) AS scans_open
FROM read_json('r2://pengepassportph/scans/v1/*/*.json.gz', hive_partitioning = true) AS scan,
     unnest(scan.sites) AS t(s), unnest(s.days) AS u(d)
WHERE scan.healthy
GROUP BY ALL ORDER BY scans_open DESC LIMIT 20;
```
