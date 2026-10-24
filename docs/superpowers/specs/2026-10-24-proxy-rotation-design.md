# A new proxy exit for each check, and another when one is refused

Status: built, 2026-10-24 (codex: design pass, four diff passes). Owner's decision: stay on Webshare's rotating residential pool (3 GB topped up), take a new
exit IP for every check, and move to another one when an exit fails, up to n times.

Follows [2026-10-21-upstream-route-design.md](2026-10-21-upstream-route-design.md).

## Why

- Since 21 Oct every request has gone out through one Webshare username (`<account>-65188`): one exit IP. If
  Cloudflare starts refusing that IP, or the home connection behind it goes away, every check fails until someone
  edits server.env.
- The allowance ran out on 23 Oct 06:12Z (Webshare answers every request `402`, `X-Webshare-Reason: bandwidthlimit`),
  shared with another heavy scraper of the owner's. Checks were down ~19 h. Rotation cannot help with that, but the
  logs and runbook must name it.

## What was measured (24 Oct, from the server)

- Webshare's username picks the exit: `<account>-rotate` is a new IP for every request; `<account>-<number>` keeps
  one IP while it lasts (same number twice = same IP; `-65188` moved between 21 and 24 Oct). Any number 1–200000
  worked; a non-number is refused (`400 client_connect_invalid_params`).
- 15 random numbers through impit `firefox144`, a session and one availability request each: 12 passed, 3 were
  challenged (`403`, `cf-mitigated: challenge`), always on the first request (`GET /appointment`), within ~3 s.
  Two of the three were Philippine IPs.
- A session opened on exit A (cookies + form token) keeps working from exit B: `/sites` and
  `/appointment/timeslot/available` answered normally from B, then A, then B, in 3/3 trials. So moving to another
  exit mid-session needs no new session.
- Challenges come in waves. A rehearsal from the server (this code, the real client, a full scan through
  `{session}`) at ~02:00Z had `GET /appointment` challenged on 20 exits in a row (5 requests x 4 attempts) until
  the circuit breaker stopped it; the next, minutes later, passed after 2 moves. At 02:08Z, 24 of 24 random exits
  were challenged (Singapore, Hong Kong, Mumbai, Manila... Cloudflare locations), and production's fixed exit too
  (the API's lookups, 02:01Z on). Challenge responses set no cookie, so nothing carries over between exits; in a
  wave no exit helps. ~100 session-page requests from ~80 addresses with one fingerprint in 40 minutes of probing
  may itself have raised it: more exits in a wave only spread one fingerprint wider.
- Wire bytes (counting proxy): a domestic scan ~81 KB (session page ~35 KB of it), the abroad batch ~44 KB,
  ≈1.2 GB/month. A rotation costs one TLS handshake (~5 KB) and a repeated request.

## Design

### Settings

- `UPSTREAM_PROXY_URL` may hold `{session}` once, inside its user name: `http://<account>-{session}:<password>@p.webshare.io:80`.
  Each process replaces it with a random number (1–999999) when it starts, and with a new one on each rotation.
  Without `{session}` the proxy is used as today: one exit, never rotated, no retries (and the backout). One
  difference: an error while reading a body now goes through the same scrubbing as the request's own errors.
- `UPSTREAM_PROXY_ROTATIONS` (0–10, default 3): how many new exits one request may take, each with a resend, when
  exits refuse it. Set without `{session}`, it is an error. 0 keeps a random exit per process but never resends.
- Errors never repeat the value (as today).

### When to move, and when to resend

In `createUpstreamFetch`'s wrapper, shared by the scan, abroad and lookup clients of a process:

| What came back | Move to a new exit | Send the same request again |
| --- | --- | --- |
| A response with `cf-mitigated: challenge` | yes | yes, on the new exit |
| `ProxyTunnelError` with status ≥ 500 or none (the exit could not open the tunnel) | yes | yes |
| `ProxyTunnelError` 402 (allowance used up), 407, 400 or other 4xx; `ProxyAuthRequired` | no | no: account or settings, surfaced at once |
| Timeouts (impit's, or the client's own deadline: `TimeoutError`), connection, read/write and remote-protocol errors, from the request or from reading its body | yes | no: DFA may have seen it |
| The caller's own abort (`AbortError`) | no | no |
| Anything else (any other response, 2xx–5xx from the site) | no | no |

- Resending only when the request provably never reached DFA's server: a challenge is Cloudflare's edge answering;
  a refused tunnel never left the proxy. The package's rate limiter, which is what bounds what this server asks of
  DFA (docs/legal), counts the request once; the resend is invisible to it but DFA never saw the first. At most
  `n` resends per request.
- `n` bounds each request, and also each process over a window: at most n moves in any 5 minutes (one checker
  period). In a wave a run tries at most n + 1 exits, then fails as before instead of spraying ~20 addresses; the
  window then passes, so a long-lived process (the API) gets its moves back and is never stranded on a refused exit
  (codex, design pass, asked for a time-based rearm). When a request has used its n, the challenge response is
  returned as is, so the client's existing "stopped by Cloudflare's bot check" error fires; a refused tunnel throws
  as today. The library's circuit breaker still stops a run in which every exit is refused.
- Spacing: the limiter spaces requests from when it dispatched them, which is the first attempt. A resend goes out
  later, and holding only the request after it would crowd the one after that (codex, diff pass: sends at 0, 2, 5
  and 6 s). So while moving is on, the wrapper itself keeps every send at least the library's interval (3 s) after
  the previous one actually went out: sends queue one behind another, so a late timer only adds room (scheduled
  slots let a late timer crowd the next send; a test caught it under load). Normal sends are already that far apart
  (the limiter's slots), so this costs only around a resend. A fixed proxy is never held. The window of moves is
  kept in the process's memory: for the one-shot checker that is one run, for the API its lifetime.
- A body that fails while being read (the exit dropped after the headers) moves the next request to a new exit too:
  the wrapper watches the response's `text()`, which is the only way the client reads it (codex, design pass).
  impit names its errors only inside `fetch()`; a body read rejects with a plain `Error` ("Error reading response
  stream: reqwest::Error { … UnexpectedEof … }", seen with the real binary), so any body failure but the caller's
  `AbortError` moves (codex, diff pass).
- Concurrency (the API serves visitors at once): each request remembers the exit generation it went out on; only a
  failure on the current generation rotates. A request whose exit was already replaced resends on the new one
  and that counts as one of its n. Every request stops after n + 1 attempts, whatever happens.
- The caller's signal is checked before a resend. The old Impit is dropped on a rotation (no pool of instances).
- A rotation logs `warn` "upstream: new exit" with the reason (method, path, error name or "Cloudflare's bot
  check") and the exit's generation, never the URL. `describeUpstream` says "impit firefox144 through
  p.webshare.io, a new exit each start (up to 3 more per request when refused)".
- Scrubbing errors covers the template, the account part before `{session}`, every generated user name and the
  password (raw and decoded).

### What each process gets

- The checker is a one-shot process: a new exit every check (every 5 minutes), shared by scans and abroad.
- The API keeps one exit until it fails, then moves. No periodic change (not asked for).
- A visitor's lookup that hits a refused exit waits ~3–5 s more per rotation.

## Rollout

1. Ship the code with server.env unchanged; the start-up line must still say "impit firefox144 through p.webshare.io".
2. Back up server.env; change the user name to `<account>-{session}`; `systemctl restart penge-api`.
3. Watch three runs: healthy, a different session in each (not logged: the exit is not secret but not needed), and
   look for "new exit" lines.
4. Backout: put a fixed user name back, remove `UPSTREAM_PROXY_ROTATIONS` (refused without `{session}`), and
   restart penge-api (codex, diff pass).

## Tests

- Fake impit: challenge → rotate → resend succeeds; n used up → challenge returned, and the next request still
  gets its own n; 402/407/400 → no rotation; timeout → error returned, next request on a new exit; a body read that
  fails → next request on a new exit, no resend; caller abort → nothing; two concurrent failures → one rotation;
  the request after a resend waits out the interval; a rotated user name is scrubbed; no `{session}` → one Impit,
  never another.
- Real impit with a local proxy keyed on the session in `Proxy-Authorization`: one session refuses CONNECT with 503,
  one answers the site's request with 403 + `cf-mitigated: challenge`; the session picker is injected; the real
  client then completes a session and an availability request, proving body and headers are resent intact.
- Config: `{session}` only once and only in the user name; rotations bounded and needing `{session}`; messages
  never echo the value.
