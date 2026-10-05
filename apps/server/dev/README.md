# The local push test stack

Everything needed to try push notifications end to end on this machine, and on a
phone over USB or wireless debugging, without touching anything real.

It never reads `.secrets/`, never connects to R2, never asks passport.gov.ph, and
never talks to the server. Its keys (email, index, token, VAPID) and its TLS
certificate are made on first use in the repository's `.local/`, which git ignores.

## Pieces

| File | What it is |
| --- | --- |
| `local.ts` | The real API and the real checker, with a throwaway Valkey (or `MemoryKv` in tests), the capturing mailer, the fake DFA and no R2. Serves `127.0.0.1:8787`, plus a local-only `POST /dev/open` route. |
| `capture-mailer.ts` | A mailer that sends nothing: each email is kept and written to `.local/mail/NNN-<kind>.txt`. |
| `fake-upstream.ts` | A pretend passport.gov.ph: three offices, four published days, and whatever dates you open. It also answers the group-date and hour lookups. |
| `alert.ts` | Asks the running stack to open a date and run the checker once: a real alert, by email and push. |
| `build.mjs` | Bundles `local.ts` and `alert.ts` into `.local/dist/`. |
| `https-proxy.mjs` | `https://localhost:8443` in front of `vite preview`, for the debug Android app (it only opens https). |
| `../../../scripts/local-stack.sh` | Starts and stops all of it. |

## Commands

```sh
scripts/local-stack.sh up        # Valkey on 127.0.0.1:6391 (marked disposable), the API, vite preview, the HTTPS proxy
npm run dev:alert -w @penge/server -- --office 486 --date 2026-10-09   # a date the fake publishes
docker exec penge-local-valkey valkey-cli --scan --pattern 'pp:push*' # what the devices look like
scripts/local-stack.sh down
```

- Web: `http://localhost:4173/pengepassportph/` (built with `VITE_LOCAL_DEBUG=1`, which shows
  the detected context under the summary; a release build refuses that flag).
- HTTPS: `https://localhost:8443/pengepassportph/`. `local-stack.sh up` prints the
  certificate's SPKI hash, for Chrome's `--ignore-certificate-errors-spki-list`.
- Mail: read the confirmation link in `.local/mail/` and open it in the browser that asked.
- Logs: `.local/api.log`, `.local/web.log`, `.local/proxy.log`.

The stack only uses the Valkey on `127.0.0.1:6391`, and only once `local-stack.sh` has
marked it with `pp:test:disposable`; it never marks a database itself. Running
`test/push-atomic.test.ts` against it (`PUSH_TEST_VALKEY=redis://127.0.0.1:6391`) wipes it.
