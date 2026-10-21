# Reaching passport.gov.ph again: a browser-like client through a proxy

Status: draft, 2026-10-21. Owner's decision: route the checker's and the API's requests through a residential
proxy with a browser-like TLS fingerprint, so alerts resume.

## What changed upstream

- Since 16 Oct, every request from the server's IP (213.250.173.234, a datacenter) gets Cloudflare's managed
  challenge: `403` with `cf-mitigated: challenge`. The checker has failed every run since (circuit open, ~400
  consecutive failures), so no alerts go out.
- `https://passport.gov.ph/<path>` now answers `301` to `https://www.passport.gov.ph/` (the home page, path dropped).
  Every endpoint works on `www` with the same paths, forms and JSON as before.

## What was measured (21 Oct)

| Client | From | Result |
| --- | --- | --- |
| Node `fetch`, `curl` (any UA, with or without a browser's `cf_clearance`) | any IP | challenged |
| curl_cffi as Chrome or Safari | server IP | challenged |
| curl_cffi as Chrome | residential proxy, from laptop and server | 13/13 over an hour: page + token, `/sites` |
| impit `chrome*` profiles | proxy | challenged |
| impit `firefox` (its default) | proxy | challenged |
| impit `firefox144`, impit's UA or the package's own UA | proxy, laptop | 6/6: page + token, `/sites` (43 offices) |
| impit `firefox144` through the package's real client | proxy, server (Linux binary) | `/sites`, `/appointment/timeslot/available`, `/appointment/timeslot`: a full round (43 offices, 46 requests, ~156 KB) every 5 minutes, all passing; also under the units' sandbox as `penge` |
| impit `firefox144` with only impit's own headers (no `Accept`) | proxy, server | challenged: the client's `Accept` is part of what passes |
| the release's own `check.mjs` (local Valkey, R2 stand-in, dry-run mail) | proxy, laptop | two runs `healthy: true`, scan stored |

A cookie from a solved challenge is not needed and does not help: through the proxy no challenge is shown, and
without the fingerprint a valid `cf_clearance` is still refused. Both the IP and the fingerprint are required.

## Design

### Library (`penge-passport-ph`)

1. `DEFAULT_BASE_URL` becomes `https://www.passport.gov.ph`. The package's own default is broken today, for every
   user, not only this server.
2. A `403` with `cf-mitigated: challenge` becomes `UpstreamError` "`<METHOD> <path>` was stopped by Cloudflare's bot
   check (HTTP 403)", so a stale fingerprint or a burnt IP can be told from the site being down. Same status, same
   backoff; only the message differs.
3. The Python client (`packages/python`) gets the same default and the same message, and the canary's defaults
   (`scripts/canary/`) move to `www` too.
4. No new dependency. Impersonation stays the caller's choice through the existing `fetch` option; the README says
   so. CHANGELOG under Unreleased (published by hand by the owner, later).

### Server (`apps/server`)

5. Two settings in `server.env`, read by `loadConfig`:
   - `UPSTREAM_BROWSER`: an impit browser profile from a fixed list (`firefox144` is the one that works today).
     Unset: Node's `fetch`, exactly as now (tests, the local stack, anyone without a proxy).
   - `UPSTREAM_PROXY_URL`: `http(s)://` or `socks5(h)://` with optional credentials. Only with `UPSTREAM_BROWSER`
     (refused alone: a proxy without the fingerprint is still challenged). A bad value fails at start-up with a
     message that never contains the value.
6. `upstream.ts` builds one `fetch` for the process from those settings: impit (`followRedirects: false`, the
   client's own `AbortSignal` for deadlines, a 60 s backstop) with the client's method, headers, body, signal and
   `redirect: 'manual'`. Errors are rethrown with the proxy URL, user name and password removed from the message
   and with no `cause`, keeping `name` (`AbortError`, `TimeoutError` are what the client distinguishes). Both
   `PengePassportPH` instances in `check.ts` and the one in `server.ts` use it, with `baseUrl` left to the new
   default.
7. impit is loaded at start-up (a dynamic `import`, only when `UPSTREAM_BROWSER` is set). A release whose native
   binary cannot load makes the API fail to start, so `penge-activate`'s ready check rolls it back, and makes the
   checker exit 1, instead of failing quietly at the first request. At start each process logs the profile and the
   proxy's host only.

### Release

8. `impit` (exact version) is a dependency of `@penge/server`; the lockfile carries every platform's optional
   binary, and CI's `npm ci` on Ubuntu installs `impit-linux-x64-gnu`. esbuild leaves `impit` external.
9. `release.sh build` copies `impit` and each installed `impit-*` package into `server/node_modules/` (plain files,
   ~11 MB; `receive.sh` refuses links and caps a release at 100 MB). `ship` refuses a release without
   `server/node_modules/impit/package.json` and a `.node` binary for linux-x64-gnu, the server's platform.

### Server units and settings (by hand, as always)

10. `penge-api.service`: `MemoryHigh` 100M → 130M, `MemoryMax` 150M → 180M (it runs at ~85 MB; impit adds ~10-20 MB).
   `penge-check.service` 130M/180M → 160M/220M (peak ~66 MB, + ~25 MB with impit over a scan). Same change in
   `deploy/systemd/`.
11. `UPSTREAM_BROWSER=firefox144` and `UPSTREAM_PROXY_URL=…` appended to `/etc/penge/server.env` before the deploy;
    the running release ignores names it does not know. `server.env.example` and `deploy/README.md` document them.

## Rollout

1. Settings and unit limits on the server, `systemctl daemon-reload`.
2. Push to `main`; CI, then Deploy ships and activates (the API restarts and must be ready, or it rolls back).
3. The first run may still meet the old breaker ("Paused … retry in ≤601 s"); judge from the run after.
4. Done when: a run is `healthy: true`; the site's "Updated" is fresh and its outage notice gone; alerts are sent
   (`delivery.sent`, Postfix log) and one real alert email reads right.
5. Back out: remove the two settings and `systemctl restart penge-api.service` (the checker reads them at every run,
   the API only at start-up), or roll back the release. A new proxy URL or profile also needs that restart.

## Risks the owner should know

- **One proxy IP.** The "static" endpoint answered from a second IP once. If Cloudflare starts challenging it, the
  existing breaker and the site's notice cover it; there is no failover to a second proxy. A list of proxy URLs is a
  later step.
- **Headers matter too.** The same profile without the client's `Accept` header is challenged; the library always
  sends one. The runbook's test command sends it as well.
- **The fingerprint ages.** impit's Chrome profiles are already challenged; `firefox144` may be next. The new error
  text says when; the fix is a profile name in `server.env` (or an impit update), no code.
- **Bandwidth.** Every scan, abroad step and visitor lookup goes through the proxy: measured in the soak, to be
  compared with the plan's monthly allowance.
- **Routing around the DFA's bot check is deliberate.** Requests stay at the existing budgets and keep the package's
  own User-Agent with the contact address.

## Not in scope

- A second proxy or rotation; a browser on the server; curl_cffi (Python). impit runs in-process and fits the
  client's existing `fetch` option.
- Changing scan cadence or budgets.
