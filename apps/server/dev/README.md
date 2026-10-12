# The local test stack

Everything needed to try email and notification alerts end to end on this machine, and on a
phone over USB or wireless debugging, without touching anything real.

It never reads `.secrets/`, never connects to R2, never asks passport.gov.ph, and
never talks to the server. Its keys (email, index, token, VAPID) and its TLS
certificate are made on first use in the repository's `.local/`, which git ignores.

## Pieces

| File | What it is |
| --- | --- |
| `local.ts` | The real API and the real checker, with a throwaway Valkey (or `MemoryKv`, with the Lua engine, in tests), the capturing mailer, the fake DFA and no R2. Notification alerts are on (`live` mode, limits of 50 alerts and 350 units), for the stack's own pages only (`devOrigins`: `http://localhost:4173`, `https://localhost:8443`, and `PENGE_PHONE_ORIGIN` when set for a phone). Serves `127.0.0.1:8787`, plus local-only routes: `POST /dev/open`, and `POST /dev/mail-fail` / `POST /dev/mail-ok` (the next emails are refused as a mail server refuses one, or sent again). |
| `capture-mailer.ts` | A mailer that sends nothing: each email is kept and written to `.local/mail/NNN-<kind>.txt`. |
| `lua-engine.ts` | Runs the device scripts' Lua on `MemoryKv` (wasmoon). |
| `fake-upstream.ts` | A pretend passport.gov.ph: three offices, four published days, and whatever dates you open. It also answers the group-date and hour lookups. |
| `alert.ts` | Asks the running stack to open a date and run the checker once: a real alert, by email and notification. |
| `build.mjs` | Bundles `local.ts` and `alert.ts` into `.local/dist/`. |
| `https-proxy.mjs` | `https://localhost:8443` in front of `vite preview`, for the debug Android app (it only opens https). |
| `../../../scripts/local-stack.sh` | Starts and stops all of it. |

## Commands

```sh
scripts/local-stack.sh up        # Valkey on 127.0.0.1:6391 (marked disposable), the API, vite preview, the HTTPS proxy
npm run dev:alert -w @penge/server -- --office 486 --date 2026-10-09   # a date the fake publishes
docker exec penge-local-valkey valkey-cli --scan --pattern 'pp:dev:*'  # what the notification alerts look like
scripts/local-stack.sh down
```

- Web: `http://localhost:4173/pengepassportph/` (built with `VITE_LOCAL_DEBUG=1`, which shows
  the detected context under the summary; a release build refuses that flag).
- HTTPS: `https://localhost:8443/pengepassportph/`. `local-stack.sh up` prints the
  certificate's SPKI hash, for Chrome's `--ignore-certificate-errors-spki-list`.
- Mail: read the confirmation link in `.local/mail/` and open it in the browser that asked.
- Logs: `.local/api.log`, `.local/web.log`, `.local/proxy.log`.

The stack only uses the Valkey on `127.0.0.1:6391`, and only once `local-stack.sh` has
marked it with `pp:test:disposable`; it never marks a database itself. The server tests' Valkey runs
(`DEVICE_TEST_VALKEY=redis://127.0.0.1:<port>`, with `--no-file-parallelism`) wipe the database they
are given: point them at a separate throwaway Valkey, not this one.

## The verification harness

`docs/superpowers/verification/harness/` drives the installed Chrome and Firefox, **headless** (set
`HEADED=1` to watch), with throwaway profiles, against the running stack. It runs from a scratch copy
that has `puppeteer-core` installed (it never installs anything in the repository):

```sh
mkdir -p /tmp/h && cd /tmp/h && npm i puppeteer-core@25.12
cp <repo>/docs/superpowers/verification/harness/*.m*s .
export REPO=<repo>/
node device-flow.mjs chrome; node device-flow.mjs firefox   # every notification and email flow
node old-pages.mjs chrome; node old-pages.mjs firefox       # the 05cee09 and 157bad9 pages against today's server
OLD=/tmp/penge-old-157bad9 node old-worker.mjs              # the upgrade from the release before push
node cross.mjs                                              # Firefox's refusals; two browsers' alerts
node audit.mjs                                              # the layout at 320 to 1280 px, light and dark
```

Results go to `docs/superpowers/verification/results/`, except the audit's: it writes `audit.json` and its
screenshots to `$AUDIT_OUT` (default `/tmp/penge-audit`, outside the repository); copy `audit.json` into
`results/` by hand. The harness only touches the stack's Valkey
after checking its disposable mark, and only through Docker on this machine.
