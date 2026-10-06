# Alerts redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the email-bound push channel with two independent kinds of alert behind one form: email alerts exactly as before push, and notification alerts that need no email, owned by the browser or app that set them up.

**Architecture:** Email alerts go back to release `157bad9`'s code. Notification alerts live in their own Valkey namespace (`pp:dev:*`), changed only by atomic Lua scripts: the API owns alert records, operations and per-credential state; the checker, under its lock, owns all delivery state. A ready check (a setup push whose nonce the browser's service worker must return) proves the browser holds both the credential and the subscription. The web app gets a new browser-state module shared by page and worker, a controller that drives setup, rotation, renewal and turn-off, and a reworked form and device row.

**Tech Stack:** TypeScript (Node 22+, Hono, `@redis/client`), Valkey 8 Lua scripts (Lua 5.1), `web-push` (request signing only), React 19 + Vite, Web Push / Service Worker / IndexedDB / Web Locks, vitest, `wasmoon` (Lua in tests), puppeteer-core (verification harness).

**Spec:** `docs/superpowers/specs/2026-10-06-alerts-redesign-design.md` (draft 17, Codex: ship). Read it before any task; where this plan and the spec disagree, the spec wins and the executor records a ruling.

## Global Constraints

- Email alerts behave exactly as at `157bad9` (address, confirmation link, one-click unsubscribe, "delete my data", pace, per-person daily cap, daily email limit, held alerts, outbox, 3-hour window and its reboot handling); the 57 production subscribers keep ids, offices, group size, pace and links and confirm nothing again.
- A notification alert needs **no email address**; the permission prompt is the consent; it belongs to the browser or app that set it up.
- One alerts form: channel switches first; the email field only with Email on; Email and Notifications off by default; Email never switched on by itself; button texts "Turn on notifications", "Send confirmation email", "Turn on notifications and send confirmation email".
- Entry buttons: "Alerts" (home page), "Alert me when dates open here" (office page).
- Ready check: setup push `TTL` 300 s, payload `{ v: 1, title: "Setting up PengePassportPH notifications", body, tag: "setup-<op>", url: {}, kind: "setup", op, nonce, expiresAt }`; operation expiry 5 minutes; the nonce is never returned by a route or logged.
- Worker acknowledgement tries after 0, 2 and 6 s; the driving page polls every 2 s for 30 s then every 10 s until the result or expiry, retries a stored nonce every 15 s, repeats `unsent`/`retryable` dispatches after 5, 15 and 45 s (or the backoff, if later); at most 10 acknowledgements per operation counted at the atomic step.
- Lifetime: 180 days after setup or the last opening that reached the server, to within an hour; renewal only by `POST /api/device-alerts/mine/seen`, at most once an hour per device; the end never moves earlier; the server's clock only.
- Credential: 32 random bytes in IndexedDB `pengepassportph-device-alerts` (version 1); only its SHA-256 on the server; sent only as `Authorization: Device <base64url>`.
- Web Locks: `pengepassportph-device-alerts` (state), `pengepassportph-device-alerts-driver` (driving page); never held across a network call or a wait for a push.
- `PUSH_MODE` `off` | `owner` | `live`; owner mode needs `PUSH_OWNER_TOKEN` (≥ 32 random characters), opened once as `#owner=<token>`, sent as `X-Owner-Token` with new setups only; `PUSH_OWNER_EMAILS` removed; `pp:push:paused` stops every push.
- Limits (per key / global, per hour): ingress 4,096 hashed buckets × 3,000; unknown setup requests 30/IP, 300; new setups stored 10/IP, 100; setup pushes to an endpoint from non-owners 3; re-setups and rotations 6 pushes per alert, 600; acknowledgements from known credentials 60/IP, 7,000 reserved; reads and renewals with an alert 600/credential, 2,400/IP, 50,000 reserved; pending reads 240/credential, 1,200/IP, 15,000; changes 60/credential, 6,000; turn off never per credential, 600/IP, 6,000 reserved; unknown credentials 600/IP, 6,000; tests 3/alert, 20/IP, 200.
- Storage: ≤ 10 offices; endpoint ≤ 1,024 characters; alert record ≤ 3 KB; operation record ≤ 4 KB; job ≤ 30 dates and ≤ 4 KB; fan-out ≤ 2,000 entries ≤ 64 bytes, ≤ 5 pending batches; whole `pp:dev:` namespace at its limits ≤ 25% of `maxmemory`; device admission refused above 70% `used_memory`; queueing skips notification work above 85%.
- Sending: per batch (domestic, abroad) 60 s of sending from its first send; checker ≤ 8 sends at once; each API process ≤ 4; a total 10 s deadline per send that aborts the request; backoff ≤ 1 hour (10 minutes when no `Retry-After`); ≤ 3 tries per date; one attempt per alert per run; daily cap `alertsPerSubscriberPerDay`; alerts and tests `TTL` 1,800 s, `urgency: high`.
- Group lookups: at most 6 of the 10 domestic lookups to pairs with held work waiting for verification, at least 4 in turn; abroad at most half to held work.
- Retention as the spec's single table: operation result until the next operation or 24 hours; end records 30 days; held work and other delivery state deleted by the next clean-up after its window; the journal 14 days.
- Copy: every user-visible string in the spec is used verbatim.
- Process: tests first (watch each fail), `npm test` and `npm run typecheck` green before each commit; an adversarial Codex pass (`gpt-6.1-sol`, reasoning `medium`) on every diff before committing, run as `codex exec -m gpt-6.1-sol -c model_reasoning_effort="medium" --skip-git-repo-check "$(cat prompt.md)" < /dev/null > out 2> err; echo CODEX-DONE $? >> out`, fingerprinting the repo before and after; never the owner's personal email in the repo; never reference the other project on the server; never rerun `deploy/provision.sh`; nothing to GitHub or the server without the owner's yes.

## Review Focus

1. **A browser without Web Locks or with IndexedDB failing** (private windows, old Safari): setup must stop at step 2 with "This browser can't finish setting up notifications." and email must still work. Pinned in Task 14 (`state.test.ts`, "refuses to start without the lock or the database") and Task 15 (`controller.test.ts`, "stops at step 2 without Web Locks or IndexedDB, and says so").
2. **A phone that delivers the setup push late** (FCM holds pushes for a sleeping device for minutes): the driving page keeps going until the expiry, shows "Still setting up…" after 30 s, and never reports success for an expired operation. Pinned in Task 15 (`controller.test.ts`, "a setup push that arrives after 4 minutes still completes; one after expiry never does").
3. **A device clock that is wrong by hours or days**: nothing on the server uses the device's time; a stored future renewal time is discarded. Pinned in Task 15 (`controller.test.ts`, "renews at most once an hour, only after the server answers, and discards a renewal time in the future").
4. **The longest real payloads** (10 offices abroad with long names, a group of 5, 30 dates): the notification stays under 3,000 bytes and a job within 30 dates and 4 KB. Pinned in Task 11 (`payload.test.ts`, "keeps the largest real alert under 3,000 bytes"), Task 10 (`devices-queue.test.ts`, "bounds a job to 30 dates, dropping the oldest and counting them") and Task 19 (`devices-footprint.test.ts`).
5. **An owner link pasted with spaces or percent-encoding** (`#owner=%20abc…`): the token is trimmed and decoded once, then removed from the address bar before the app renders. Pinned in Task 16 (`owner-token.test.ts`, "trims and decodes a pasted link once").

## Spec exception for the owner to accept at plan review

The spec asks the daily report for the append-only file's "last success and status". Valkey's `INFO` gives no time for a rewrite's success, and a rewrite cancelled by an operator (turning the AOF off, or signalling the rewrite child) leaves its counter, status and failure count exactly as a success would. The plan reports a bracket instead (Task 13: a rewrite that started after one checker run and finished by the next, status `ok`, zero consecutive failures), and the runbook forbids both cancelling actions (Task 22). Codex's review agreed nothing observable from `INFO` can do better. If the owner does not accept this, the alternative is reading the AOF manifest's base-file sequence on the server, which needs the checker to read Valkey's data directory.

## File structure

Server (`apps/server/src/`):
- `kv.ts` (modify): `ScriptDef.memory` optional; `MemoryKv.command()` (the Valkey subset device scripts use) and an injectable Lua engine; sorted sets; `memory()`, `persistence()`, `scan()`.
- `config.ts`, `keys.ts` (modify): owner token, device limits, `pp:dev:*` keys.
- `subscribers.ts`, `templates.ts`, `api.ts`, `checker.ts`, `stats.ts`, `admin.ts`, `check.ts`, `server.ts`, `backup.ts` (restored from `157bad9`, then changed by the tasks below); `pace.ts` (create: `PACE_SPACING_MS`, shared by email and notifications); `migrate.ts` (create: leaving the channel design).
- `devices/lua.ts` (the prelude and `deviceScript`), `devices/store-lua.ts` (records and units, in Lua), `devices/delivery-lua.ts` (jobs, in Lua), `devices/claims-lua.ts` (put back), `devices/store.ts` (constants, hashes, sealing, views), `devices/limits.ts` (ingress gate and class pools), `devices/scripts-api.ts` (admission, dispatch, ready, change, renew, read, turn off, gone, reclaim, backoff), `devices/scripts-delivery.ts` (queueing, fan-out, claims, gate, settle, clean-up scripts), `devices/queue.ts`, `devices/delivery.ts` (the notification pass), `devices/cleanup.ts`, `devices/lock.ts`, `devices/transport.ts`, `devices/api.ts` (the routes), `devices/counters.ts` (create, all).
- `push/endpoint.ts`, `push/payload.ts` (keep; payload gains "Checked <time>" and the setup payload); `push/atomic.ts`, `push/devices.ts`, `push/register.ts`, `push/sender.ts`, `push/errors.ts` (delete).
- `dev/lua-engine.ts`, `dev/cjson-lua.ts` (create: Lua on MemoryKv for tests and the local stack); `dev/local.ts` (modify).

Server tests (`apps/server/test/`): create `setup.ts`, `valkey.ts`, `lua-subset.ts`, `device-fixtures.ts`, `kv-lua.test.ts`, `devices-lua.test.ts`, `devices-limits.test.ts`, `old-pages.test.ts`, `backup.test.ts`, `devices-store.test.ts`, `devices-activate.test.ts`, `devices-transport.test.ts`, `devices-api.test.ts`, `devices-queue.test.ts`, `checker-devices.test.ts`, `devices-claims.test.ts`, `payload.test.ts`, `devices-cleanup.test.ts`, `devices-counters.test.ts`, `devices-footprint.test.ts`, `migrate.test.ts`; restore from `157bad9`: `api.test.ts`, `checker.test.ts`, `deletion.test.ts`, `stats.test.ts`, `abroad.test.ts`, `lookups.test.ts`; keep `helpers.ts` (a superset of `157bad9`'s), `fixtures/v0.2/` (the frozen `157bad9` importer); delete `api-push.test.ts`, `backup-push.test.ts`, `checker-push.test.ts`, `push-atomic.test.ts`, `push-sender.test.ts`, `subscribers-push.test.ts`, `templates.test.ts`, `abroad-world.ts`.

Web (`apps/web/src/`):
- `devices/state.js` + `state.d.ts` (IndexedDB, the lock, operations, epochs, claims, retired credentials; shared by page and worker), `devices/api.ts` (the routes' client), `devices/controller.ts` (setup, driving, rotation, renewal, change, test, turn off, reconcile), `devices/browser.ts` (the real browser behind the controller), `devices/owner.ts` (the owner link), `devices/instance.ts` (one controller per page) — create, all.
- `notify/context.ts`, `notify/worker.ts` (keep, adjust: owner by token; `deviceAlerts: 1`); `notify/shared.js`, `notify/shared.d.ts`, `notify/push.ts` (delete).
- `sw.js` (setup pushes, rotation, reload on first activation), `sw-plugin.ts` (inline `state.js`).
- `components/AlertSheet.tsx`, `components/DeviceRow.tsx` (rewritten); `components/OfficeView.tsx`, `pages/Home.tsx`, `pages/DeleteData.tsx`, `pages/Privacy.tsx`, `api.ts`, `main.tsx`, `time.ts`, `styles.css` (modify); `pages/Confirm.tsx` (restored from `157bad9`).

Web tests (`apps/web/test/`): create `state.test.ts`, `fake-device-server.ts`, `controller.test.ts`, `owner-token.test.ts`, `device-row.test.tsx`, `worker.test.ts`; modify `sheet.test.tsx`, `pages.test.tsx`, `notify.test.ts`, `pwa.test.ts`; delete `notify-shared.test.ts`.

Contracts (`packages/contracts/src/index.ts`): device-alert request and answer types and guards, `validateChoices` shared by both kinds (Task 5); the channel types removed (Task 17).

Other: `.github/workflows/ci.yml` (a Valkey job), `deploy/systemd/penge-check.service.d/device-cleanup.conf`, `deploy/server.env.example`, `deploy/README.md`, `docs/how-it-works.md`, `docs/alert-timing.md`, `docs/android.md`, `docs/legal/README.md`, `apps/server/dev/README.md`, `docs/superpowers/verification/harness/*`, `docs/superpowers/verification/2026-10-alerts-{mac,phone}.md`.

## Tasks

1. The real Lua in tests (wasmoon on MemoryKv; a Valkey job in CI)
2. Configuration, keys, the shared Lua prelude and all-or-nothing rate limits
3. Email alerts back to `157bad9`, with the channel release's pages still answered
4. Backups in version 1 again, and an importer that checks identities both ways
5. Device-alert contracts
6. The alert store, admission and setup dispatch
7. The ready check's activation, change, renewal, read, turn off and "gone"
8. The push transport: a structured result, a total deadline, a send limit
9. The device-alert routes
10. Queueing in two writes, scan demand for both kinds, fair group lookups
11. The notification pass: claims, the send gate, settlement, and the run's three passes
12. Clean-up at the start of every run, claim recovery, the daily recount, and `device-cleanup`
13. The day's numbers for notification alerts, under `pp:stats:v2:`
14. This device's state: one IndexedDB record and one lock, shared by page and worker
15. The page's controller and the device-alert client
16. The owner link, and one alerts form with the channel switches first
17. The device row, the entry buttons, the pages, and the channel contracts removed
18. The service worker: setup pushes and the ready check, rotation, and reloading old pages
19. Measure the largest footprint on Valkey, and set the limits from it
20. The local stack, the verification harness, the old pages against the new server, and the layout audit
21. Leaving the channel design: inspect, dump and clean up, as commands
22. The runbook, the docs, the rollback drop-in, and the Mac verification record
23. The owner's phone (owner gate)
24. Rollout (owner gate)

Each task ends green (`npm test`, `npm run typecheck`) and with its own Codex pass and commit, on the local branch `alerts-redesign`. Tasks 1–13 are the server, 14–18 the web app, 19–22 measurement, verification and documentation; 23 and 24 need the owner.

---
### Task 1: The real Lua in tests

Every device step is a Lua script. Tests run **the same Lua** on `MemoryKv` (through `wasmoon`, Lua 5.4 compiled to WebAssembly) and, in CI, on a real Valkey. There are no TypeScript twins of device scripts.

**Files:**
- Modify: `apps/server/src/kv.ts` (sorted sets, `command()`, the Lua hook, `memory()`, optional `ScriptDef.memory`)
- Create: `apps/server/dev/lua-engine.ts`, `apps/server/dev/cjson-lua.ts`
- Create: `apps/server/test/setup.ts`, `apps/server/test/valkey.ts`, `apps/server/test/lua-subset.ts`
- Modify: `apps/server/vitest.config.ts`, `apps/server/package.json` (devDependency `wasmoon`), `apps/server/src/keys.ts` (`testMark`), `.github/workflows/ci.yml`
- Test: `apps/server/test/kv-lua.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type Reply = string | number | null | { ok: string } | (string | number | null)[]` (kv.ts)
  - `ScriptDef { name: string; lua: string; memory?(tx: ScriptTx, keys: string[], args: string[]): string }`
  - `Kv.memory(): Promise<{ used: number; max: number }>` (`max` 0 when unlimited)
  - `MemoryKv.command(argv: string[]): Reply`; `MemoryKv.lua: LuaRunner | null` (static); `MemoryKv#oom: boolean`; `MemoryKv#memoryUse: { used: number; max: number }`
  - `type LuaRunner = (source: string, keys: string[], args: string[], call: (argv: string[]) => Reply) => Promise<() => string>`
  - `installLua(): void` (dev/lua-engine.ts)
  - `valkeyTargets(): [name: string, make: () => Promise<Kv>][]` (test/valkey.ts): always `MemoryKv`; plus `Valkey` when `DEVICE_TEST_VALKEY` is set; throws when `DEVICE_TEST_VALKEY_REQUIRED=1` and it is not.
  - `lintLua51(source: string): string[]` (test/lua-subset.ts): the problems found, empty when clean.
  - `K.testMark` = `pp:test:disposable`

- [ ] **Step 1: Add the dependency**

Run: `npm install -D wasmoon@1.16.0 -w @penge/server`
Expected: `apps/server/package.json` lists `"wasmoon": "^1.16.0"` under `devDependencies`; `package-lock.json` changes.

- [ ] **Step 2: Write the failing tests**

`apps/server/test/kv-lua.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type Kv, MemoryKv, type ScriptDef } from '../src/kv.ts';
import { clock } from './helpers.ts';
import { lintLua51 } from './lua-subset.ts';
import { valkeyTargets } from './valkey.ts';

const lua = (name: string, source: string): ScriptDef => ({ name, lua: `#!lua\n${source}` });
const run = (kv: Kv, source: string, keys: string[] = [], args: string[] = []) => kv.script(lua('t', source), keys, args);

for (const [name, make] of valkeyTargets()) {
  describe(`Lua scripts on ${name}`, () => {
    it('passes KEYS and ARGV as strings, byte for byte', async () => {
      const kv = await make();
      const out = await run(kv, "return KEYS[1] .. '|' .. ARGV[1] .. '|' .. #ARGV[2]", ['k"\\'], ['a\nb', 'é']);
      expect(out).toBe('k"\\|a\nb|2');
    });

    it('answers missing values with false, and status replies as tables', async () => {
      const kv = await make();
      const out = await run(kv, "redis.call('SET', 's', 'v') return tostring(redis.call('GET', 'nope')) .. '|' .. redis.call('TYPE', 's').ok .. '|' .. redis.call('TYPE', 'nope').ok");
      expect(out).toBe('false|string|none');
    });

    it('keeps hashes, sets, sorted sets and lists as Valkey does', async () => {
      const kv = await make();
      const out = await run(
        kv,
        `redis.call('HSET', 'h', 'a', '1', 'b', '2')
         redis.call('HINCRBY', 'h', 'a', 4)
         redis.call('SADD', 'st', 'x', 'y')
         redis.call('SREM', 'st', 'x')
         redis.call('ZADD', 'z', 30, 'c', 10, 'a', 20, 'b')
         redis.call('RPUSH', 'l', 'p', 'q')
         local r = redis.call('ZRANGEBYSCORE', 'z', '-inf', '(30', 'LIMIT', 0, 5)
         local first = redis.call('LPOP', 'l')
         return table.concat({ redis.call('HGET', 'h', 'a'), redis.call('HLEN', 'h'), table.concat(redis.call('SMEMBERS', 'st'), ','),
           table.concat(r, ','), redis.call('ZSCORE', 'z', 'c'), redis.call('ZCARD', 'z'), first, redis.call('LLEN', 'l'),
           tostring(redis.call('HMGET', 'h', 'a', 'zz')[2]) }, '|')`,
      );
      expect(out).toBe('5|2|y|a,b|30|3|p|1|false');
    });

    it('fails the whole script on a wrong type, and redis.pcall catches it', async () => {
      const kv = await make();
      await run(kv, "redis.call('SET', 's', 'v') return 'ok'");
      await expect(run(kv, "return redis.call('HGET', 's', 'f')")).rejects.toThrow(/WRONGTYPE/);
      expect(await run(kv, "local r = redis.pcall('HGET', 's', 'f') return type(r.err)")).toBe('string');
    });

    it('decodes and encodes JSON with cjson', async () => {
      const kv = await make();
      const out = await run(kv, "local t = cjson.decode(ARGV[1]) return cjson.encode({ n = t.n + 1, s = t.s, a = t.a })", [], ['{"n":1791261968326,"s":"x\\"y","a":[1,2]}']);
      expect(JSON.parse(out)).toEqual({ n: 1791261968327, s: 'x"y', a: [1, 2] });
    });

    it('decodes JSON null to cjson.null, not nil, as Valkey does', async () => {
      const kv = await make();
      expect(await run(kv, "local t = cjson.decode(ARGV[1]) return tostring(t.a == nil) .. '|' .. tostring(t.a == cjson.null)", [], ['{"a":null}'])).toBe('false|true');
    });

    it.each(['{"a":1;"b":2}', '[1;2]', '{"a" 1}', '{a:1}', '{"a":1}x', '{"a":}', '"\\q"', '"\\ud800"', '"\\udc00"', '"\\ud800\\u0041"'])('refuses malformed JSON %s as cjson does', async (bad) => {
      const kv = await make();
      expect(await run(kv, "local ok = pcall(cjson.decode, ARGV[1]) return tostring(ok)", [], [bad])).toBe('false');
    });

    it('decodes a surrogate pair to one 4-byte character, and encodes nil as null, as cjson does', async () => {
      const kv = await make();
      expect(await run(kv, "return cjson.decode(ARGV[1])", [], ['"\\ud83d\\ude00"'])).toBe('\u{1F600}');
      expect(await run(kv, "return cjson.encode(nil)", [], [])).toBe('null');
    });

    it('keeps a control byte followed by a digit exact', async () => {
      const kv = await make();
      expect(await run(kv, "return ARGV[1]", [], ['\n1\\2\u00012'])).toBe('\n1\\2\u00012');
    });

    it('refuses a table or boolean as a command argument', async () => {
      const kv = await make();
      await expect(run(kv, "return redis.call('SET', 'k', true)")).rejects.toThrow(/arguments must be strings or integers/);
    });

    it('lists hash fields with HKEYS', async () => {
      const kv = await make();
      expect(await run(kv, "redis.call('HSET', 'h', 'a', '1', 'b', '2') local k = redis.call('HKEYS', 'h') table.sort(k) return table.concat(k, ',')")).toBe('a,b');
    });

    it('formats large integers exactly with %.0f', async () => {
      const kv = await make();
      expect(await run(kv, "return string.format('%.0f', 1791261968326 + tonumber(ARGV[1]))", [], ['1'])).toBe('1791261968327');
    });
  });
}

describe('MemoryKv and Lua', () => {
  it('refuses a script that may write when memory is full, before it starts, and runs allow-oom ones', async () => {
    const kv = new MemoryKv();
    kv.oom = true;
    await expect(kv.script(lua('grow', "redis.call('SET', 'a', '1') return 'ok'"), [], [])).rejects.toThrow(/OOM/);
    expect(kv.keys()).toEqual([]);
    expect(await kv.script({ name: 'free', lua: "#!lua flags=allow-oom\nredis.call('DEL', 'a') return 'ok'" }, [], [])).toBe('ok');
  });

  it('holds time still while a Lua script runs', async () => {
    let ms = 0;
    const kv = new MemoryKv(() => (ms += 1));
    await kv.set('k', 'v', { ttlSeconds: 0.005 });
    const out = await kv.script(lua('slow', "for i = 1, 50 do redis.call('EXISTS', 'k') end return tostring(redis.call('GET', 'k'))"), [], []);
    expect(out).toBe('v');
  });

  it('runs a script without a Lua engine only if it has a memory twin', async () => {
    const saved = MemoryKv.lua;
    MemoryKv.lua = null;
    try {
      await expect(new MemoryKv().script(lua('x', "return 'x'"), [], [])).rejects.toThrow(/no Lua engine/);
    } finally {
      MemoryKv.lua = saved;
    }
  });

  it('reports the memory it was told, for the admission guard', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    kv.memoryUse = { used: 50, max: 100 };
    expect(await kv.memory()).toEqual({ used: 50, max: 100 });
  });
});

describe('the Lua 5.1 subset', () => {
  it('accepts plain 5.1 code, whatever its strings and comments hold', () => {
    expect(lintLua51("#!lua\nlocal s = 'a|b//c' -- x // y\nreturn unpack({ s })")).toEqual([]);
  });

  it('names every construct Valkey (Lua 5.1) does not have', () => {
    const found = lintLua51('#!lua\nlocal a = 7 // 2\ngoto x\n::x::\nlocal b = 1 & 2\nlocal c = table.unpack({})\nlocal d = utf8.char(1)\nlocal e = math.pow(2, 3)\nlocal f <const> = 1');
    expect(found).toEqual(['//', 'goto', '::label::', 'bitwise operator', 'table.unpack', 'utf8', 'math.pow', 'attribute']);
  });

  it('requires the flagged script form', () => {
    expect(lintLua51("return 'x'")).toEqual(['no #!lua shebang']);
  });
});
```

- [ ] **Step 3: Run the tests to watch them fail**

Run: `npm test -w @penge/server -- kv-lua`
Expected: FAIL: `Cannot find module './lua-subset.ts'` (and `./valkey.ts`).

- [ ] **Step 4: Write the test helpers**

`apps/server/test/valkey.ts`:

```ts
// Where the device scripts are tested: always MemoryKv (running the real Lua through wasmoon), and a real Valkey when
// DEVICE_TEST_VALKEY names a throwaway one on 127.0.0.1 that carries the disposable mark. Each make() wipes that one
// database, so a run against it uses --no-file-parallelism (CI does; so must a local run of several files).
import { K } from '../src/keys.ts';
import { connectRedis, type Kv, MemoryKv } from '../src/kv.ts';

async function disposableValkey(url: string): Promise<Kv> {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1') throw new Error('DEVICE_TEST_VALKEY must be a throwaway Valkey on 127.0.0.1');
  const kv = await connectRedis(url, () => {});
  if ((await kv.get(K.testMark)) !== '1') throw new Error('this Valkey is not marked disposable; refusing to wipe it');
  await kv.script({ name: 'wipe', lua: "#!lua flags=allow-oom\nredis.call('FLUSHDB') redis.call('SET', KEYS[1], '1') return 'ok'" }, [K.testMark], []);
  return kv;
}

export function valkeyTargets(): [string, () => Promise<Kv>][] {
  const url = process.env.DEVICE_TEST_VALKEY;
  if (!url && process.env.DEVICE_TEST_VALKEY_REQUIRED === '1') throw new Error('DEVICE_TEST_VALKEY is required here');
  const targets: [string, () => Promise<Kv>][] = [['MemoryKv', async () => new MemoryKv()]];
  if (url) targets.push(['Valkey', () => disposableValkey(url)]);
  return targets;
}
```

`apps/server/test/lua-subset.ts`:

```ts
// Valkey runs Lua 5.1; the tests run Lua 5.4. This keeps scripts to what both run the same way.
const RULES: [string, RegExp][] = [
  ['//', /\/\//],
  ['goto', /\bgoto\b/],
  ['::label::', /::\w+::/],
  ['bitwise operator', /[&|]|<<|>>|~(?!=)/],
  ['table.unpack', /\btable\.unpack\b/],
  ['utf8', /\butf8\./],
  ['math.pow', /\bmath\.(pow|tointeger|type|ult)\b/],
  ['attribute', /<\s*(const|close)\s*>/],
  ['string.pack', /\bstring\.(pack|unpack|packsize)\b/],
  ['table.move', /\btable\.move\b/],
  ['loadstring/setfenv', /\b(loadstring|setfenv|getfenv|load)\s*\(/],
];

/** The source with comments and string literals blanked out, so their contents are never mistaken for code. */
function codeOnly(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const long = /^(--)?\[(=*)\[/.exec(rest);
    if (long) {
      const close = `]${long[2]}]`;
      const end = source.indexOf(close, i + long[0].length);
      i = end < 0 ? source.length : end + close.length;
      out += ' ';
      continue;
    }
    if (rest.startsWith('--')) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    const q = source[i];
    if (q === '"' || q === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== q) j += source[j] === '\\' ? 2 : 1;
      i = j + 1;
      out += '""';
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

export function lintLua51(source: string): string[] {
  if (!source.startsWith('#!lua')) return ['no #!lua shebang'];
  const code = codeOnly(source.slice(source.indexOf('\n') + 1));
  return RULES.filter(([, re]) => re.test(code)).map(([name]) => name);
}
```

`apps/server/test/setup.ts`:

```ts
// Every test file runs device scripts as real Lua on MemoryKv.
import { installLua } from '../dev/lua-engine.ts';

installLua();
```

`apps/server/vitest.config.ts` gains `test: { setupFiles: ['./test/setup.ts'] }`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The library from source, as tsconfig.json's `paths` does for types and esbuild for the bundle.
    alias: { 'penge-passport-ph': fileURLToPath(new URL('../../packages/penge-passport-ph/src/index.ts', import.meta.url)) },
  },
  test: { setupFiles: ['./test/setup.ts'] },
});
```

`apps/server/src/keys.ts`: add next to `pushTestMark` (which Task 3 removes):

```ts
  /** Present only in a throwaway local Valkey: tests that wipe data refuse any other. */
  testMark: `${P}test:disposable`,
```

- [ ] **Step 5: Run the tests to watch them fail for the right reason**

Run: `npm test -w @penge/server -- kv-lua`
Expected: FAIL: `Cannot find module '../dev/lua-engine.ts'` from `test/setup.ts`.

- [ ] **Step 6: Write the engine**

`apps/server/dev/cjson-lua.ts` (the stand-in for Valkey's built-in `cjson`: JSON `null` decodes to `cjson.null` as on Valkey, and malformed JSON — a missing `:`, a separator other than `,`, an unquoted key, trailing characters — raises an error as cjson does, so a script's `pcall(cjson.decode, …)` sees the same failures in tests as in production):

```ts
// Valkey's scripts have a built-in cjson; Lua in tests gets this stand-in. Numbers encode as %.14g, as cjson does.
export const CJSON_LUA = String.raw`
cjson = {}
local function esc(s)
  return (s:gsub('[%c"\\]', function(c)
    local m = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
    return m[c] or string.format('\\u%04x', string.byte(c))
  end))
end
local function isarray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= 'number' or k < 1 or math.floor(k) ~= k then return false end
    n = n + 1
  end
  for i = 1, n do if t[i] == nil then return false end end
  return n > 0
end
-- Valkey's cjson decodes JSON null to the sentinel cjson.null, not nil: the stand-in does the same.
cjson.null = setmetatable({}, { __tostring = function() return 'null' end })
function cjson.encode(v)
  if v == nil or v == cjson.null then return 'null' end
  local t = type(v)
  if t == 'string' then return '"' .. esc(v) .. '"' end
  if t == 'number' then return string.format('%.14g', v) end
  if t == 'boolean' then return tostring(v) end
  if t == 'table' then
    local out = {}
    if isarray(v) then
      for i = 1, #v do out[i] = cjson.encode(v[i]) end
      return '[' .. table.concat(out, ',') .. ']'
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for i, k in ipairs(keys) do out[i] = '"' .. esc(tostring(k)) .. '":' .. cjson.encode(v[k]) end
    return '{' .. table.concat(out, ',') .. '}'
  end
  error('cjson stand-in cannot encode ' .. t)
end
function cjson.decode(s)
  local i = 1
  local function ws() i = s:find('[^ \t\r\n]', i) or #s + 1 end
  local value
  local function bad() error('cjson stand-in: bad JSON at ' .. i) end
  local function str()
    if s:sub(i, i) ~= '"' then bad() end
    local out = {}
    i = i + 1
    while true do
      local c = s:sub(i, i)
      if c == '"' then i = i + 1 return table.concat(out) end
      if c == '\\' then
        local e = s:sub(i + 1, i + 1)
        local m = { b = '\b', f = '\f', n = '\n', r = '\r', t = '\t', ['"'] = '"', ['\\'] = '\\', ['/'] = '/' }
        if e == 'u' then
          local function hex4(at)
            local h = s:sub(at, at + 3)
            if not h:match('^%x%x%x%x$') then bad() end
            return tonumber(h, 16)
          end
          local code = hex4(i + 2)
          i = i + 6
          -- As cjson: a high surrogate must be followed by \u and a low one (one 4-byte character); a lone one is an error.
          if code >= 0xDC00 and code <= 0xDFFF then bad() end
          if code >= 0xD800 and code <= 0xDBFF then
            if s:sub(i, i + 1) ~= '\\u' then bad() end
            local low = hex4(i + 2)
            if low < 0xDC00 or low > 0xDFFF then bad() end
            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
            i = i + 6
          end
          if code < 128 then out[#out + 1] = string.char(code)
          elseif code < 2048 then out[#out + 1] = string.char(192 + math.floor(code / 64), 128 + code % 64)
          elseif code < 65536 then out[#out + 1] = string.char(224 + math.floor(code / 4096), 128 + math.floor(code / 64) % 64, 128 + code % 64)
          else out[#out + 1] = string.char(240 + math.floor(code / 262144), 128 + math.floor(code / 4096) % 64, 128 + math.floor(code / 64) % 64, 128 + code % 64) end
        else
          if not m[e] then bad() end
          out[#out + 1] = m[e]
          i = i + 2
        end
      elseif c == '' then error('unterminated string')
      else out[#out + 1] = c i = i + 1 end
    end
  end
  function value()
    ws()
    local c = s:sub(i, i)
    if c == '{' then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == '}' then i = i + 1 return t end
      while true do
        ws() local k = str() ws()
        if s:sub(i, i) ~= ':' then bad() end
        i = i + 1
        t[k] = value() ws()
        local d = s:sub(i, i) i = i + 1
        if d == '}' then return t end
        if d ~= ',' then bad() end
      end
    elseif c == '[' then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == ']' then i = i + 1 return t end
      while true do
        t[#t + 1] = value() ws()
        local d = s:sub(i, i) i = i + 1
        if d == ']' then return t end
        if d ~= ',' then bad() end
      end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == 'true' then i = i + 4 return true
    elseif s:sub(i, i + 4) == 'false' then i = i + 5 return false
    elseif s:sub(i, i + 3) == 'null' then i = i + 4 return cjson.null
    else
      local num = s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', i)
      if not num or num == '' or not tonumber(num) then bad() end
      i = i + #num
      return tonumber(num)
    end
  end
  local v = value()
  ws()
  if i <= #s then error('cjson stand-in: trailing characters at ' .. i) end
  return v
end
`;
```

`apps/server/dev/lua-engine.ts`:

```ts
// Runs scripts' real Lua on MemoryKv, for tests and the local stack: Lua 5.4 (wasmoon) with Valkey's redis.call,
// redis.pcall and cjson, synchronously, so nothing else touches the store while a script runs.
import { LuaFactory } from 'wasmoon';
import { MemoryKv, type Reply } from '../src/kv.ts';
import { CJSON_LUA } from './cjson-lua.ts';

const factory = new LuaFactory();

/** A Lua string literal of the exact UTF-8 bytes, valid in Lua 5.1 and 5.4. */
const literal = (s: string) =>
  `"${[...Buffer.from(s, 'utf8')].map((b) => (b >= 32 && b < 127 && b !== 34 && b !== 92 ? String.fromCharCode(b) : `\\${String(b).padStart(3, '0')}`)).join('')}"`;
// Three digits always: "\10" followed by "1" would otherwise read as "\101".

const PRELUDE = `
unpack = unpack or table.unpack
local function conv(kind)
  if kind == 'nil' then return false end
  if kind == 'status' then return { ok = __value() } end
  if kind == 'array' then
    local t = {}
    for i = 1, __len() do
      local v = __item(i)
      if v == nil then v = false end
      t[i] = v
    end
    return t
  end
  return __value()
end
redis = { LOG_DEBUG = 0, LOG_VERBOSE = 1, LOG_NOTICE = 2, LOG_WARNING = 3 }
function redis.call(...) return conv(__call(...)) end
function redis.pcall(...)
  local ok, kind = pcall(__call, ...)
  if not ok then return { err = tostring(kind) } end
  return conv(kind)
end
function redis.error_reply(m) return { err = m } end
function redis.status_reply(m) return { ok = m } end
function redis.log() end
`;

/** Null when `source` compiles as a script body (the shebang line dropped), else the compiler's message. Runs nothing. */
export async function compileError(source: string): Promise<string | null> {
  const engine = await factory.createEngine({ enableProxy: false, injectObjects: false });
  try {
    const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
    const r = engine.doStringSync(`local f, err = load(${literal(`return function() ${body}\nend`)}) if f then return '' end return err`);
    return r === '' ? null : String(r);
  } finally {
    engine.global.close();
  }
}

export function installLua(): void {
  MemoryKv.lua = async (source, keys, args, call) => {
    const engine = await factory.createEngine({ enableProxy: false, injectObjects: false });
    let last: Reply = null;
    engine.global.set('__call', (...argv: unknown[]) => {
      // As Valkey: only strings and numbers may be arguments; a number is sent as %.17g would print it.
      if (argv.length === 0 || argv.some((a) => typeof a !== 'string' && typeof a !== 'number')) {
        throw new Error('Lua redis lib command arguments must be strings or integers');
      }
      last = call(argv.map((a) => (typeof a === 'number' ? (Number.isInteger(a) ? String(a) : String(Number(a.toPrecision(17)))) : a)));
      if (last === null) return 'nil';
      if (Array.isArray(last)) return 'array';
      if (typeof last === 'object') return 'status';
      return 'value';
    });
    engine.global.set('__value', () => (last !== null && typeof last === 'object' && !Array.isArray(last) ? last.ok : (last ?? undefined)));
    engine.global.set('__len', () => (Array.isArray(last) ? last.length : 0));
    engine.global.set('__item', (i: number) => (Array.isArray(last) ? (last[i - 1] ?? undefined) : undefined));
    const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
    const program = `${CJSON_LUA}\n${PRELUDE}\nKEYS = {${keys.map(literal).join(',')}}\nARGV = {${args.map(literal).join(',')}}\nreturn (function()\n${body}\nend)()`;
    return () => {
      try {
        const out: unknown = engine.doStringSync(program);
        if (out !== null && typeof out === 'object') {
          const o = out as { err?: unknown; ok?: unknown };
          if (typeof o.err === 'string') throw new Error(o.err);
          if (typeof o.ok === 'string') return o.ok;
        }
        if (typeof out === 'number') return String(Math.trunc(out));
        if (typeof out !== 'string') throw new Error('scripts must return a string');
        return out;
      } finally {
        engine.global.close();
      }
    };
  };
}
```

- [ ] **Step 7: Run the tests to watch them fail on `MemoryKv`**

Run: `npm test -w @penge/server -- kv-lua`
Expected: FAIL: `MemoryKv.lua` is not a property / `kv.command is not a function`, and the `memory()` test fails.

- [ ] **Step 8: Extend `kv.ts`**

In `apps/server/src/kv.ts`:

1. Make the twin optional and add the reply type, after `ScriptTx`:

```ts
/** One atomic operation: Lua for Valkey. Device scripts have no twin: MemoryKv runs their Lua (tests install an engine). */
export interface ScriptDef {
  name: string;
  lua: string;
  memory?(tx: ScriptTx, keys: string[], args: string[]): string;
}

/** A Valkey reply as a script sees it: bulk string, integer, nil, status, or a flat array of those. */
export type Reply = string | number | null | { ok: string } | (string | number | null)[];

/** Prepares a script (async), then runs it synchronously: nothing else may touch the store in between. */
export type LuaRunner = (source: string, keys: string[], args: string[], call: (argv: string[]) => Reply) => Promise<() => string>;
```

2. In `Kv`, after `script`:

```ts
  /** `used_memory` and `maxmemory` (0 when unlimited), read now, for the device admission guard. */
  memory(): Promise<{ used: number; max: number }>;
```

3. In `connectRedis`'s object, after `script`:

```ts
    async memory() {
      const info = await client.info('memory');
      const read = (name: string) => Number(new RegExp(`^${name}:(\\d+)`, 'm').exec(info)?.[1] ?? 0);
      return { used: read('used_memory'), max: read('maxmemory') };
    },
```

4. Above `type Entry`, a sorted set, and add it to `Entry`:

```ts
/** A sorted set in MemoryKv: member → score, read in Valkey's order (score, then member). */
class ZSet {
  readonly scores = new Map<string, number>();
  get size() {
    return this.scores.size;
  }
  ordered(): [string, number][] {
    return [...this.scores].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}

type Entry = { value: string | Map<string, string> | Set<string> | string[] | ZSet; expiresAt: number | null };
```

5. In `MemoryKv`, add the fields after `now`:

```ts
  /** Set by tests and the local stack: how scripts without a memory twin run. */
  static lua: LuaRunner | null = null;
  /** Emulates Valkey over `maxmemory`: scripts not flagged `allow-oom` are refused before they start. */
  oom = false;
  /** What `memory()` reports. */
  memoryUse = { used: 0, max: 64 * 1024 * 1024 };
```

and `async memory() { return { ...this.memoryUse }; }` next to `close()`.

6. `hGetAll` must refuse a sorted set: change its check to `if (!(entry.value instanceof Map)) throw new Error(\`WRONGTYPE ${key}\`);` (unchanged; a `ZSet` is not a `Map`). In `dump()`, show a sorted set as its scores:

```ts
        return [k, typeof v === 'string' ? v : v instanceof Map ? Object.fromEntries(v) : v instanceof ZSet ? Object.fromEntries(v.scores) : [...v]];
```

7. Replace `script()` with:

```ts
  async script(def: ScriptDef, keys: string[], args: string[]): Promise<string> {
    if (def.memory) return this.frozen(() => def.memory!(this.tx(), keys, args));
    const flags = /^#!lua(?:\s+flags=([\w,-]+))?/.exec(def.lua)?.[1]?.split(',') ?? [];
    if (this.oom && !flags.includes('allow-oom') && !flags.includes('no-writes')) {
      throw new Error("OOM command not allowed when used memory > 'maxmemory'.");
    }
    if (!MemoryKv.lua) throw new Error(`script ${def.name}: MemoryKv has no Lua engine (tests and the local stack install one)`);
    const run = await MemoryKv.lua(def.lua, keys, args, (argv) => this.command(argv));
    return this.frozen(run);
  }

  /** Time stands still while a script runs, as on Valkey: nothing expires halfway through it. */
  private frozen<T>(fn: () => T): T {
    const clock = this.now;
    const at = clock();
    this.now = () => at;
    try {
      return fn();
    } finally {
      this.now = clock;
    }
  }
```

and move the existing `hashOf`/`tx` construction into `private tx(): ScriptTx { … return tx; }` unchanged, with `type` also answering `'zset'` (add `'zset'` to `ScriptTx.type`'s union, and `if (e.value instanceof ZSet) return 'zset';` before the `Map` check).

8. Add `command()`, the Valkey subset device scripts use, after `frozen`:

```ts
  /** The Valkey commands device scripts use, with Valkey's replies and errors. */
  command(argv: string[]): Reply {
    const [name = '', key = '', ...rest] = argv;
    const cmd = name.toUpperCase();
    const wrong = () => new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    // Valkey's integers are signed 64-bit; past 2^53 JavaScript would round, so those are refused here too
    // (no device counter comes near either bound).
    // Canonical decimal only, as Valkey's string2ll: no sign but "-", no leading zeros, no "-0".
    const int = (s: string | undefined) => {
      if (s === undefined || !/^-?(0|[1-9]\d*)$/.test(s) || s === '-0' || !Number.isSafeInteger(Number(s))) throw new Error('ERR value is not an integer or out of range');
      return Number(s);
    };
    const checked = (n: number) => {
      if (!Number.isSafeInteger(n)) throw new Error('ERR increment or decrement would overflow');
      return n;
    };
    const hash = (create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof Map)) throw wrong();
      if (!e && create) return this.typed(key, () => new Map<string, string>(), (v) => v instanceof Map);
      return (e?.value as Map<string, string> | undefined) ?? null;
    };
    const set = (create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof Set && !(e.value instanceof Hll))) throw wrong();
      if (!e && create) return this.typed(key, () => new Set<string>(), (v) => v instanceof Set && !(v instanceof Hll));
      return (e?.value as Set<string> | undefined) ?? null;
    };
    const zset = (create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof ZSet)) throw wrong();
      if (!e && create) return this.typed(key, () => new ZSet(), (v) => v instanceof ZSet);
      return (e?.value as ZSet | undefined) ?? null;
    };
    const list = (create: boolean) => {
      const e = this.entry(key);
      if (e && !Array.isArray(e.value)) throw wrong();
      if (!e && create) return this.typed(key, () => [] as string[], Array.isArray);
      return (e?.value as string[] | undefined) ?? null;
    };
    const bound = (s: string, low: boolean) => {
      if (s === '-inf') return { v: -Infinity, open: false };
      if (s === '+inf' || s === 'inf') return { v: Infinity, open: false };
      const open = s.startsWith('(');
      const v = Number(open ? s.slice(1) : s);
      if (Number.isNaN(v)) throw new Error(`ERR min or max is not a float (${low ? 'min' : 'max'})`);
      return { v, open };
    };
    const after = <T>(value: T) => {
      this.tidy(key);
      return value;
    };
    switch (cmd) {
      case 'GET':
        return this.string(key);
      case 'SET': {
        // SET key value [EX seconds | PX ms]: the queueing write sets announcement marks with an expiry.
        const opt = rest[1]?.toUpperCase();
        const ms = opt === 'EX' ? int(rest[2]) * 1000 : opt === 'PX' ? int(rest[2]) : null;
        if (opt !== undefined && ms === null) throw new Error('ERR syntax error');
        this.data.set(key, { value: rest[0] ?? '', expiresAt: ms === null ? null : this.now() + ms });
        return { ok: 'OK' };
      }
      case 'DEL':
      case 'UNLINK': {
        let n = 0;
        for (const k of [key, ...rest]) if (this.entry(k) && this.data.delete(k)) n += 1;
        return n;
      }
      case 'EXISTS':
        return [key, ...rest].filter((k) => this.entry(k)).length;
      case 'TYPE':
        return { ok: this.tx().type(key) === 'other' ? 'none' : this.tx().type(key) };
      case 'PTTL':
        return this.tx().pttl(key);
      case 'TTL':
        return this.tx().ttl(key);
      case 'EXPIRE':
      case 'PEXPIRE': {
        const e = this.entry(key);
        if (!e) return 0;
        e.expiresAt = this.now() + int(rest[0]) * (cmd === 'EXPIRE' ? 1000 : 1);
        return 1;
      }
      case 'PERSIST': {
        const e = this.entry(key);
        if (!e || e.expiresAt === null) return 0;
        e.expiresAt = null;
        return 1;
      }
      case 'INCR':
      case 'INCRBY':
      case 'DECR':
      case 'DECRBY': {
        const by = cmd === 'INCR' ? 1 : cmd === 'DECR' ? -1 : cmd === 'INCRBY' ? int(rest[0]) : -int(rest[0]);
        const current = this.string(key);
        const next = checked((current === null ? 0 : int(current)) + by);
        const expiresAt = this.entry(key)?.expiresAt ?? null;
        this.data.set(key, { value: String(next), expiresAt });
        return next;
      }
      case 'HGET':
        return hash(false)?.get(rest[0] ?? '') ?? null;
      case 'HEXISTS':
        return hash(false)?.has(rest[0] ?? '') ? 1 : 0;
      case 'HMGET': {
        const h = hash(false);
        return rest.map((f) => h?.get(f) ?? null);
      }
      case 'HSET': {
        if (rest.length === 0 || rest.length % 2) throw new Error("ERR wrong number of arguments for 'hset' command");
        const h = hash(true)!;
        let added = 0;
        for (let i = 0; i < rest.length; i += 2) {
          if (!h.has(rest[i]!)) added += 1;
          h.set(rest[i]!, rest[i + 1]!);
        }
        return added;
      }
      case 'HDEL': {
        const h = hash(false);
        let n = 0;
        for (const f of rest) if (h?.delete(f)) n += 1;
        return after(n);
      }
      case 'HKEYS':
        return [...(hash(false)?.keys() ?? [])];
      case 'HLEN':
        return hash(false)?.size ?? 0;
      case 'HGETALL':
        return [...(hash(false) ?? [])].flat();
      case 'HINCRBY': {
        const h = hash(true)!;
        const next = checked(int(h.get(rest[0] ?? '') ?? '0') + int(rest[1]));
        h.set(rest[0] ?? '', String(next));
        return next;
      }
      case 'SADD': {
        const s = set(true)!;
        let n = 0;
        for (const m of rest) if (!s.has(m)) (s.add(m), (n += 1));
        return n;
      }
      case 'SREM': {
        const s = set(false);
        let n = 0;
        for (const m of rest) if (s?.delete(m)) n += 1;
        return after(n);
      }
      case 'SMEMBERS':
        return [...(set(false) ?? [])];
      case 'SCARD':
        return set(false)?.size ?? 0;
      case 'SISMEMBER':
        return set(false)?.has(rest[0] ?? '') ? 1 : 0;
      case 'ZADD': {
        if (rest.length === 0 || rest.length % 2) throw new Error('ERR syntax error');
        const z = zset(true)!;
        let added = 0;
        for (let i = 0; i < rest.length; i += 2) {
          const score = Number(rest[i]);
          if (Number.isNaN(score)) throw new Error('ERR value is not a valid float');
          if (!z.scores.has(rest[i + 1]!)) added += 1;
          z.scores.set(rest[i + 1]!, score);
        }
        return added;
      }
      case 'ZREM': {
        const z = zset(false);
        let n = 0;
        for (const m of rest) if (z?.scores.delete(m)) n += 1;
        return after(n);
      }
      case 'ZSCORE': {
        const v = zset(false)?.scores.get(rest[0] ?? '');
        return v === undefined ? null : String(v);
      }
      case 'ZCARD':
        return zset(false)?.size ?? 0;
      case 'ZRANGE': {
        const all = zset(false)?.ordered() ?? [];
        const n = all.length;
        let start = int(rest[0]);
        let stop = int(rest[1]);
        if (start < 0) start = Math.max(n + start, 0);
        if (stop < 0) stop = n + stop;
        return all.slice(start, Math.min(stop, n - 1) + 1).map(([m]) => m);
      }
      case 'ZRANGEBYSCORE': {
        const min = bound(rest[0] ?? '', true);
        const max = bound(rest[1] ?? '', false);
        let found = (zset(false)?.ordered() ?? []).filter(
          ([, s]) => (min.open ? s > min.v : s >= min.v) && (max.open ? s < max.v : s <= max.v),
        );
        const limit = rest.findIndex((r) => r.toUpperCase() === 'LIMIT');
        if (limit >= 0) {
          const offset = int(rest[limit + 1]);
          const count = int(rest[limit + 2]);
          found = found.slice(offset, count < 0 ? undefined : offset + count);
        }
        return found.map(([m]) => m);
      }
      case 'RPUSH': {
        const l = list(true)!;
        l.push(...rest);
        return l.length;
      }
      case 'LPOP': {
        const l = list(false);
        if (rest[0] === undefined) return after(l?.shift() ?? null);
        // LPOP key count: an array, or nil for a missing key, as Valkey answers.
        const n = int(rest[0]);
        return l ? after(l.splice(0, n)) : null;
      }
      case 'LLEN':
        return list(false)?.length ?? 0;
      case 'LINDEX': {
        const l = list(false) ?? [];
        const i = int(rest[0]);
        return l[i < 0 ? l.length + i : i] ?? null;
      }
      case 'LREM': {
        // LREM key 0 value: every occurrence (the only form device scripts use).
        const l = list(false);
        if (!l) return 0;
        const before = l.length;
        const kept = l.filter((v) => v !== rest[1]);
        l.splice(0, l.length, ...kept);
        return after(before - kept.length);
      }
      case 'LRANGE': {
        const l = list(false) ?? [];
        let start = int(rest[0]);
        let stop = int(rest[1]);
        if (start < 0) start = Math.max(l.length + start, 0);
        if (stop < 0) stop = l.length + stop;
        return l.slice(start, stop + 1);
      }
      case 'FLUSHDB':
        this.data.clear();
        return { ok: 'OK' };
      default:
        throw new Error(`ERR unknown command '${name}' (MemoryKv runs only the commands device scripts use)`);
    }
  }
```

The `lPop`, `hGetAll` and `sMembers` methods also refuse a `ZSet` (`WRONGTYPE`), which they already do because a `ZSet` is none of `Map`, `Set` or array; `lLen` answers 0 for it, as before for other types.

- [ ] **Step 9: Run the tests to watch them pass**

Run: `npm test -w @penge/server -- kv-lua kv`
Expected: PASS (all of `kv-lua.test.ts` and `kv.test.ts`).

- [ ] **Step 10: Run the same tests on a real Valkey**

Run (once per machine; the container is a throwaway on a loopback port):

```bash
docker run -d --name penge-test-valkey -p 127.0.0.1:6390:6379 valkey/valkey:8.1 valkey-server --maxmemory 64mb --maxmemory-policy noeviction
docker exec penge-test-valkey valkey-cli SET pp:test:disposable 1
DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- kv-lua
```

Expected: PASS, with each `Lua scripts on …` block run twice (`MemoryKv` and `Valkey`).

- [ ] **Step 11: CI runs the device scripts on Valkey**

`.github/workflows/ci.yml`, a new job after `node`:

```yaml
  valkey:
    name: Device scripts on Valkey
    runs-on: ubuntu-latest
    timeout-minutes: 10
    services:
      valkey:
        image: valkey/valkey:8.1
        ports: ['127.0.0.1:6379:6379']
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - name: Mark the throwaway Valkey and give it production's memory policy
        run: |
          docker exec ${{ job.services.valkey.id }} valkey-cli CONFIG SET maxmemory 64mb
          docker exec ${{ job.services.valkey.id }} valkey-cli CONFIG SET maxmemory-policy noeviction
          docker exec ${{ job.services.valkey.id }} valkey-cli SET pp:test:disposable 1
      # One test file at a time: each wipes the one throwaway database when it starts.
      - run: npm test -w @penge/server -- --no-file-parallelism
        env:
          DEVICE_TEST_VALKEY: redis://127.0.0.1:6379
          DEVICE_TEST_VALKEY_REQUIRED: '1'
```

- [ ] **Step 12: Full suite, typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: both pass (the old push tests still use their memory twins).

Codex pass on the diff (Global Constraints' command, prompt: "Adversarial review of this diff: a test-only Lua engine for MemoryKv that must behave like Valkey 8's Lua 5.1 scripting. Find divergences that would let a script pass on MemoryKv and fail on Valkey, or the reverse."). Take every finding or record a ruling, then:

```bash
git add apps/server/src/kv.ts apps/server/src/keys.ts apps/server/dev/lua-engine.ts apps/server/dev/cjson-lua.ts apps/server/test/setup.ts apps/server/test/valkey.ts apps/server/test/lua-subset.ts apps/server/test/kv-lua.test.ts apps/server/vitest.config.ts apps/server/package.json package-lock.json .github/workflows/ci.yml
git commit -m "Run scripts' real Lua in tests, on MemoryKv and on a throwaway Valkey in CI"
```

---
### Task 2: Configuration, keys, the shared Lua prelude and all-or-nothing rate limits

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/keys.ts`
- Create: `apps/server/src/devices/lua.ts`, `apps/server/src/devices/limits.ts`
- Test: `apps/server/test/units.test.ts` (config cases), `apps/server/test/devices-lua.test.ts`, `apps/server/test/devices-limits.test.ts`

**Interfaces:**
- Consumes: Task 1's `valkeyTargets()`, `lintLua51()`, `Kv.script`, `ScriptDef` without `memory`.
- Produces:
  - `Config.devices: { alertLimit: number; recordLimit: number }` (`DEVICE_ALERT_LIMIT` default and ceiling 300, `DEVICE_RECORD_LIMIT` default and ceiling 1,750)
  - Keys (all under `pp:dev:` unless noted): `K.devAlert(id)`, `K.devEndpoint(hmac)`, `K.devCred(hash)`, `K.devSite(office)`, `K.devEnds`, `K.devOp(hash)`, `K.devOps`, `K.devEnded(hash)`, `K.devQueue`, `K.devQueued`, `K.devHeld(id)`, `K.devClaim(id)`, `K.devFanout(batch)`, `K.devFanoutStamps(batch)`, `K.devFanouts`, `K.devLast(id)`, `K.devToday(id, day)`, `K.devTried(id)`, `K.devOrder`, `K.devRecords`, `K.devGarbage`, `K.devDeadlines`, `K.devCursor(kind: 'domestic' | 'abroad')`, `K.scanGroupCursor` (`pp:scan:groupcursor`), `K.scanAbroadCursor` (`pp:scan:abroadcursor`), `K.pushBackoff(service)` (`pp:push:backoff:<service>`), `K.statsV2(day)` (`pp:stats:v2:<day>`, a hash of device counters)
  - `deviceScript(name: string, body: string, opts?: { reclaim?: boolean }): DeviceScript` and `DeviceScript.run<T>(kv: Kv, keys: Record<string, string>, args: Record<string, unknown>): Promise<T>`; `DEVICE_SCRIPTS: DeviceScript[]` (every script defined, for the lint test). Inside a script: `K.<name>` is the key passed under that name, `A.<name>` the argument, `NOW` = `A.now` (ms), `KEY.<prefix>` the key prefixes, and the helpers `I(n)`, `N(s)`, `need(key, type)`, `hgetall(key)`, `count(name, by?)`, `rate_room(cur, prev, overlap, max)`, `rate_take(cur, ttl)`, `elapsed(then, now)` (a port of `clock.ts`'s `elapsed`, `nil` when unknown).
  - `devices/limits.ts`: `DEVICE_LIMITS` (every row of the spec's limits table as `Limit`s), `ingressBucket(ip: string, key: Buffer): number` (0–4,095; every per-network counter is keyed by this bucket, so per-network keys are bounded by 4,096 per class and window), `rateKeys(limit: Limit, id: string, now: number): { cur: string; prev: string; overlap: number; max: number; ttl: number }`, `charge(kv: Kv, items: [Limit, string][], now: number): Promise<{ ok: true } | { ok: false; refused: string }>` (all or nothing; `refused` is the bucket of the first limit without room; nothing is created when refused).

- [ ] **Step 1: Write the failing config tests**

In `apps/server/test/units.test.ts`, after the push config tests, add:

```ts
  it('reads the device limits, with defaults', () => {
    expect(loadConfig(env).devices).toEqual({ alertLimit: 300, recordLimit: 1750 });
    expect(() => loadConfig({ ...env, DEVICE_RECORD_LIMIT: '1751' })).toThrow(/DEVICE_RECORD_LIMIT/);
    expect(loadConfig({ ...env, DEVICE_ALERT_LIMIT: '10', DEVICE_RECORD_LIMIT: '100' }).devices).toEqual({ alertLimit: 10, recordLimit: 100 });
    expect(() => loadConfig({ ...env, DEVICE_ALERT_LIMIT: '-1' })).toThrow(/DEVICE_ALERT_LIMIT/);
    expect(() => loadConfig({ ...env, DEVICE_ALERT_LIMIT: '100', DEVICE_RECORD_LIMIT: '100' })).toThrow(/DEVICE_RECORD_LIMIT must hold/);
  });
```

The VAPID-size test below them keeps its body; its `vapid` object is unchanged.

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- units`
Expected: FAIL: `devices` is undefined.

- [ ] **Step 3: Change `config.ts`**

Add to `Config`, after `push`:

```ts
  /** The notification alerts' ceilings (spec: "Bounds"): alerts plus reserving operations, and storage units. */
  devices: { alertLimit: number; recordLimit: number };
```

Before `return`:

```ts
  // Ceilings, not just defaults: Task 19 measured that the pp:dev namespace at these limits, with the limiter's
  // worst case, fits in 25% of maxmemory; a larger value cannot be configured.
  const alertLimit = int('DEVICE_ALERT_LIMIT', 300, 0, 300);
  const recordLimit = int('DEVICE_RECORD_LIMIT', 1750, 0, 1750);
  // Every alert holds ALERT_UNITS storage units (devices/store.ts); the rest is for operation records.
  if (recordLimit < alertLimit * 5) throw new ConfigError('DEVICE_RECORD_LIMIT must hold 5 units for every alert DEVICE_ALERT_LIMIT allows');
```

and add `devices: { alertLimit, recordLimit },` to the returned object. (`5` is `ALERT_UNITS`, defined in Task 6; Task 6's `devices-store.test.ts` asserts `ALERT_UNITS === 5`, so a change made by Task 19's measurement must change both.)

- [ ] **Step 4: Watch the config tests pass**

Run: `npm test -w @penge/server -- units`
Expected: PASS.

- [ ] **Step 5: Write the failing Lua prelude and limit tests**

`apps/server/test/devices-lua.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { elapsed, type Stamp } from '../src/clock.ts';
import { DEVICE_SCRIPTS, deviceScript } from '../src/devices/lua.ts';
import { K } from '../src/keys.ts';
import { lintLua51 } from './lua-subset.ts';
import { valkeyTargets } from './valkey.ts';

// Every device module there is, so DEVICE_SCRIPTS holds every script (later tasks add modules; nothing to update here).
import.meta.glob('../src/devices/*.ts', { eager: true });

const echo = deviceScript('test-echo', `return cjson.encode({ a = K.a, b = A.b, now = NOW })`);
const prefixes = deviceScript(
  'test-prefixes',
  `return cjson.encode({ alert = KEY.alert .. 'x', today = KEY.today .. 'x:2026-10-06', stamps = KEY.fanout .. 'b1:stamps',
     site = KEY.site .. '486', op = KEY.op .. 'h', ended = KEY.ended .. 'h', backoff = KEY.backoff .. 'fcm',
     records = KEY.records, paused = KEY.paused, lock = KEY.lock, cursor = KEY.cursorAbroad })`,
);
const typed = deviceScript('test-typed', `need(K.h, 'hash') redis.call('SET', K.w, '1') return '"ok"'`);
const counted = deviceScript('test-count', `count('opsStarted') count('opsStarted', 2) return '"ok"'`);
const age = deviceScript('test-elapsed', `local e = elapsed(A.from, A.to) if e == nil then return '"unknown"' end return cjson.encode(e)`);

for (const [name, make] of valkeyTargets()) {
  describe(`device script prelude on ${name}`, () => {
    it('passes keys and arguments by name', async () => {
      const kv = await make();
      expect(await echo.run(kv, { a: 'pp:dev:x' }, { b: 'y"z', now: 1791261968326 })).toEqual({ a: 'pp:dev:x', b: 'y"z', now: 1791261968326 });
    });

    it('builds the same keys as keys.ts', async () => {
      const kv = await make();
      expect(await prefixes.run(kv, {}, { now: 0 })).toEqual({
        alert: K.devAlert('x'),
        today: K.devToday('x', '2026-10-06'),
        stamps: K.devFanoutStamps('b1'),
        site: K.devSite(486),
        op: K.devOp('h'),
        ended: K.devEnded('h'),
        backoff: K.pushBackoff('fcm'),
        records: K.devRecords,
        paused: K.pushPaused,
        lock: K.checkLock,
        cursor: K.devCursor('abroad'),
      });
    });

    it('checks key types before writing anything', async () => {
      const kv = await make();
      await kv.set('pp:dev:h', 'not a hash');
      await expect(typed.run(kv, { h: 'pp:dev:h', w: 'pp:dev:w' }, { now: 0 })).rejects.toThrow(/WRONGTYPE/);
      expect(await kv.get('pp:dev:w')).toBeNull();
    });

    it('counts into the day\'s versioned statistics, with an expiry', async () => {
      const kv = await make();
      await counted.run(kv, { stats: K.statsV2('2026-10-06') }, { now: 1791261968326 });
      expect(await kv.hGetAll(K.statsV2('2026-10-06'))).toEqual({ opsStarted: '3', since: '1791261968326' });
      const ttl = await deviceScript('test-ttl', `return cjson.encode(redis.call('TTL', K.s))`).run<number>(kv, { s: K.statsV2('2026-10-06') }, { now: 0 });
      expect(ttl).toBeGreaterThan(39 * 86400);
    });

    it('measures time between stamps exactly as clock.ts does', async () => {
      const kv = await make();
      const cases: [Stamp, Stamp][] = [
        [{ wall: 1000, up: 50, boot: 'a' }, { wall: 9000, up: 650, boot: 'a' }],
        [{ wall: 1000, up: 50, boot: 'a' }, { wall: 9000, up: 650, boot: 'b' }],
        [{ wall: 1000, up: 700, boot: 'a' }, { wall: 9000, up: 650, boot: 'a' }],
        [{ wall: 1000 }, { wall: 9000 }],
        [{ wall: 9000 }, { wall: 1000 }],
        [{ wall: 1000, up: 5, boot: 'a' }, { wall: 9000 }],
        [{ wall: 1000 }, { wall: 9000, up: 5, boot: 'a' }],
      ];
      for (const [then, now] of cases) {
        const expected = elapsed(then, now);
        expect(await age.run(kv, {}, { now: 0, from: then, to: now })).toEqual(expected === null ? 'unknown' : expected);
      }
    });
  });
}

describe('device scripts', () => {
  it('all compile (a reserved word as a field name, a typo in the Lua, fails here, not at its first use)', async () => {
    const { compileError } = await import('../dev/lua-engine.ts');
    for (const s of DEVICE_SCRIPTS) expect([s.def.name, await compileError(s.def.lua)]).toEqual([s.def.name, null]);
  });

  it('are all in the Lua 5.1 subset and the flagged form', async () => {
    expect(DEVICE_SCRIPTS.length).toBeGreaterThan(0);
    for (const s of DEVICE_SCRIPTS) expect([s.def.name, lintLua51(s.def.lua)]).toEqual([s.def.name, []]);
  });

  it('flags only reclamation scripts allow-oom', () => {
    const reclaim = deviceScript('test-reclaim', `return '"ok"'`, { reclaim: true });
    expect(reclaim.def.lua.split('\n')[0]).toBe('#!lua flags=allow-oom');
    expect(echo.def.lua.split('\n')[0]).toBe('#!lua');
  });
});
```

`apps/server/test/devices-limits.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { charge, DEVICE_LIMITS, ingressBucket } from '../src/devices/limits.ts';
import type { Limit } from '../src/limits.ts';
import { clock } from './helpers.ts';
import { valkeyTargets } from './valkey.ts';

const small = (bucket: string, max: number): Limit => ({ bucket, max, windowSeconds: 3600 });

for (const [name, make] of valkeyTargets()) {
  describe(`all-or-nothing limits on ${name}`, () => {
    it('charges every limit, or none when one has no room, and creates nothing when refused', async () => {
      const kv = await make();
      const t = clock();
      const global = small('t-global', 2);
      const perIp = small('t-ip', 5);
      expect(await charge(kv, [[global, 'all'], [perIp, 'ip1']], t.now())).toEqual({ ok: true });
      expect(await charge(kv, [[global, 'all'], [perIp, 'ip2']], t.now())).toEqual({ ok: true });
      expect(await charge(kv, [[global, 'all'], [perIp, 'ip3']], t.now())).toEqual({ ok: false, refused: 't-global' });
      const keys = (await kv.script({ name: 'k', lua: "#!lua\nreturn cjson.encode(redis.call('EXISTS', KEYS[1]))" }, [`pp:rate:t-ip:${Math.floor(t.now() / 3_600_000)}:ip3`], []));
      expect(keys).toBe('0');
    });

    it('weighs the previous window by its overlap, as hit() does', async () => {
      const kv = await make();
      const t = clock(Date.parse('2026-10-06T00:00:00Z'));
      const l = small('t-slide', 4);
      for (let i = 0; i < 4; i++) expect((await charge(kv, [[l, 'x']], t.now())).ok).toBe(true);
      t.advance(3_600_000 + 900_000); // a quarter into the next window: 3 of the 4 still count
      expect((await charge(kv, [[l, 'x']], t.now())).ok).toBe(true);
      expect((await charge(kv, [[l, 'x']], t.now())).ok).toBe(false);
    });
  });
}

describe('the ingress gate', () => {
  it('spreads addresses over exactly 4,096 buckets, the same bucket for the same address', () => {
    const key = randomBytes(32);
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) {
      const b = ingressBucket(`198.51.${i >> 8}.${i & 255}`, key);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(4096);
      seen.add(b);
    }
    expect(seen.size).toBeGreaterThan(3900);
    expect(ingressBucket('2001:db8::1', key)).toBe(ingressBucket('2001:db8::ffff', key)); // one /64
  });

  it('has every class of the spec\'s limits table', () => {
    expect(DEVICE_LIMITS.ingress.max).toBe(3000);
    expect([DEVICE_LIMITS.unknownSetupIp.max, DEVICE_LIMITS.unknownSetupAll.max]).toEqual([30, 300]);
    expect([DEVICE_LIMITS.storedSetupIp.max, DEVICE_LIMITS.storedSetupAll.max]).toEqual([10, 100]);
    expect(DEVICE_LIMITS.setupPushEndpoint.max).toBe(3);
    expect([DEVICE_LIMITS.maintenanceAlert.max, DEVICE_LIMITS.maintenanceAll.max]).toEqual([6, 600]);
    expect([DEVICE_LIMITS.ackIp.max, DEVICE_LIMITS.ackAll.max]).toEqual([60, 7000]);
    expect([DEVICE_LIMITS.knownReadCred.max, DEVICE_LIMITS.knownReadIp.max, DEVICE_LIMITS.knownReadAll.max]).toEqual([600, 2400, 50_000]);
    expect([DEVICE_LIMITS.pendingReadCred.max, DEVICE_LIMITS.pendingReadIp.max, DEVICE_LIMITS.pendingReadAll.max]).toEqual([240, 1200, 15_000]);
    expect([DEVICE_LIMITS.changeCred.max, DEVICE_LIMITS.changeAll.max]).toEqual([60, 6000]);
    expect([DEVICE_LIMITS.offIp.max, DEVICE_LIMITS.offAll.max]).toEqual([600, 6000]);
    expect([DEVICE_LIMITS.unknownIp.max, DEVICE_LIMITS.unknownAll.max]).toEqual([600, 6000]);
    expect([DEVICE_LIMITS.testAlert.max, DEVICE_LIMITS.testIp.max, DEVICE_LIMITS.testAll.max]).toEqual([3, 20, 200]);
    for (const l of Object.values(DEVICE_LIMITS)) expect(l.windowSeconds).toBe(3600);
  });
});
```

- [ ] **Step 6: Watch them fail**

Run: `npm test -w @penge/server -- devices-lua devices-limits`
Expected: FAIL: `Cannot find module '../src/devices/lua.ts'`.

- [ ] **Step 7: Add the keys**

In `apps/server/src/keys.ts`, replace everything from `/** Hash: device id → sealed device …` through `pushAddress: …` with the device keys below (keep `pushPaused`), and add `statsV2` after `statsEmailed`:

```ts
  /** Device counters for a Manila day, from the alerts redesign on (stats.ts reads both schemas). */
  statsV2: (day: string) => `${P}stats:v2:${day}`,
  /** Hash: a notification alert (devices/store.ts): its sealed subscription and plain fields. */
  devAlert: (id: string) => `${P}dev:${id}`,
  /** The alert id an endpoint (by its keyed hash) belongs to: one alert per endpoint. */
  devEndpoint: (endpointHmac: string) => `${P}dev:endpoint:${endpointHmac}`,
  /** The alert id a device credential (by its SHA-256) owns. */
  devCred: (credentialHash: string) => `${P}dev:cred:${credentialHash}`,
  /** Set of "<alert id>:<group size>" following an office. */
  devSite: (office: number | string) => `${P}dev:site:${office}`,
  /** Sorted set: alert id by its end (ms). */
  devEnds: `${P}dev:ends`,
  /** Hash: a credential's current or last operation. */
  devOp: (credentialHash: string) => `${P}dev:op:${credentialHash}`,
  /** Sorted set: credential hashes with an unfinished operation, by its expiry (ms). */
  devOps: `${P}dev:ops`,
  /** Hash: a credential's end record (reason, date, fingerprint). */
  devEnded: (credentialHash: string) => `${P}dev:ended:${credentialHash}`,
  /** Hash: alert id → its queued job (JSON); and a sorted set of alert ids by their oldest date's announcement. */
  devQueue: `${P}dev:queue`,
  devQueued: `${P}dev:queued`,
  devHeld: (id: string) => `${P}dev:held:${id}`,
  devClaim: (id: string) => `${P}dev:claim:${id}`,
  /** List: one fan-out batch's entries; its stamps; and the pending batches, oldest first. */
  devFanout: (batch: string) => `${P}dev:fanout:${batch}`,
  devFanoutStamps: (batch: string) => `${P}dev:fanout:${batch}:stamps`,
  devFanouts: `${P}dev:fanouts`,
  devLast: (id: string) => `${P}dev:last:${id}`,
  devToday: (id: string, day: string) => `${P}dev:today:${id}:${day}`,
  devTried: (id: string) => `${P}dev:tried:${id}`,
  /** The ordering counter for activations that create an alert and for fan-out batches. */
  devOrder: `${P}dev:order`,
  /** Hash: storage units in use or reserved, by kind, and their total. */
  devRecords: `${P}dev:records`,
  /** Hash: deleted alert id → units still charged until the checker removes its delivery keys. */
  devGarbage: `${P}dev:garbage`,
  /** Sorted set: "<kind>|<credential hash>" by when that record is due for deletion (ms). */
  devDeadlines: `${P}dev:deadlines`,
  devCursor: (kind: 'domestic' | 'abroad') => `${P}dev:cursor:${kind}`,
  /** The lock of `admin.mjs device-cleanup` (runs "cleanup-…"), never the checker's (Task 12). */
  devCleanupLock: `${P}lock:device-cleanup`,
  /** Where the next run's group lookups resume, domestic and abroad. */
  scanGroupCursor: `${P}scan:groupcursor`,
  scanAbroadCursor: `${P}scan:abroadcursor`,
  /** A push service's backoff after a 429, shared by every sender: the time it ends (ms). */
  pushBackoff: (service: string) => `${P}push:backoff:${service}`,
```

The old `push*`, `pendingChannels`, `reserved`, `pushAddress` and `pushTestMark` keys are deleted in Task 3 together with their last readers; until then keep them below the new keys.

- [ ] **Step 8: Write the prelude**

`apps/server/src/devices/lua.ts`:

```ts
// Every device step is one Lua script on Valkey (Lua 5.1), run as is on MemoryKv in tests. Each script is this
// prelude plus its body, in Valkey's flagged form: scripts that may grow storage are refused before they start when
// memory is full; reclamation scripts (`reclaim`) run anyway (`allow-oom`), and write only small counters and removals.
//
// Inside a script: K.<name> is the key passed under that name, A.<name> the argument, NOW the time (ms) the caller
// passed, KEY.<kind> the prefix of keys a script names by id. Scripts check every key's type and every value before
// their first write, so nothing after the first write can fail on its input; they return JSON.
import { K } from '../keys.ts';
import type { Kv, ScriptDef } from '../kv.ts';

const KEY_PREFIXES = {
  alert: K.devAlert(''),
  endpoint: K.devEndpoint(''),
  cred: K.devCred(''),
  site: K.devSite(''),
  op: K.devOp(''),
  ended: K.devEnded(''),
  held: K.devHeld(''),
  claim: K.devClaim(''),
  fanout: K.devFanout(''),
  last: K.devLast(''),
  today: K.devToday('', '').slice(0, -1), // "pp:dev:today:" — then "<id>:<day>"
  tried: K.devTried(''),
  backoff: K.pushBackoff(''),
  // Fixed keys, by name.
  records: K.devRecords,
  garbage: K.devGarbage,
  deadlines: K.devDeadlines,
  ops: K.devOps,
  ends: K.devEnds,
  order: K.devOrder,
  queue: K.devQueue,
  queued: K.devQueued,
  fanouts: K.devFanouts,
  cursorDomestic: K.devCursor('domestic'),
  cursorAbroad: K.devCursor('abroad'),
  paused: K.pushPaused,
  lock: K.checkLock,
  cleanupLock: K.devCleanupLock,
};

const PRELUDE = `
local K = {}
do
  local names = cjson.decode(ARGV[1])
  for i = 1, #names do K[names[i]] = KEYS[i] end
end
local A = cjson.decode(ARGV[2])
local NOW = A.now
local KEY = cjson.decode('${JSON.stringify(KEY_PREFIXES)}')
-- A run whose id starts with "cleanup-" (admin.mjs device-cleanup, the rollback's pre-step) is fenced by its own lock,
-- never the checker's: a clean-up killed while holding it can never keep an older checker (and its email) from running.
if type(A.run) == 'string' and string.sub(A.run, 1, 8) == 'cleanup-' then KEY.lock = KEY.cleanupLock end
local function I(n) return string.format('%.0f', n) end
local function N(s)
  local n = tonumber(s)
  if n == nil then error('not a number: ' .. tostring(s)) end
  return n
end
local function TYPE(k) return redis.call('TYPE', k).ok end
local function need(k, t)
  local got = TYPE(k)
  if got ~= 'none' and got ~= t then error('WRONGTYPE ' .. k .. ' is a ' .. got .. ', not a ' .. t) end
end
local function hgetall(k)
  local flat = redis.call('HGETALL', k)
  local t = {}
  for i = 1, #flat, 2 do t[flat[i]] = flat[i + 1] end
  return t
end
-- Counters live in the day's pp:stats:v2:<day> hash, kept as long as the v1 numbers (40 days); "since" says when the
-- day's first one was written, so the report can split the deploy day between the two schemas.
-- Counting can never fail a step: a damaged statistics key costs a number, not a change (redis.pcall).
local function count(name, by)
  if K.stats == nil then return end
  local r = redis.pcall('HINCRBY', K.stats, name, by or 1)
  if type(r) == 'table' and r.err then return end
  local ttl = redis.pcall('PTTL', K.stats)
  if type(ttl) == 'number' and ttl < 0 then redis.pcall('EXPIRE', K.stats, 3456000) end
  if redis.pcall('HEXISTS', K.stats, 'since') == 0 then redis.pcall('HSET', K.stats, 'since', I(NOW)) end
end
-- A counter that is not an integer stops the step here, before anything is written.
local function counter(k)
  local v = redis.call('GET', k)
  if not v then return 0 end
  local n = tonumber(v)
  -- As INCR would read it: a canonical integer that adding one cannot overflow.
  if n == nil or n ~= math.floor(n) or I(n) ~= v or math.abs(n) >= 9007199254740991 then error('not a counter: ' .. k) end
  return n
end
local function rate_room(cur, prev, overlap, max)
  return counter(cur) + 1 + counter(prev) * overlap <= max
end
-- A window's counter lives until its next window ends (ttlMs from now), so at most two of a key's windows exist.
local function rate_take(cur, ttlMs)
  redis.call('INCR', cur)
  if redis.call('PTTL', cur) < 0 then redis.call('PEXPIRE', cur, ttlMs) end
end
-- clock.ts's elapsed(): uptime within one boot; the wall clock only where neither stamp has uptime; else unknown (nil).
local function elapsed(t, n)
  local timed = t.boot ~= nil and t.up ~= nil
  if n.boot ~= nil and n.up ~= nil then
    if timed and t.boot == n.boot and t.up <= n.up then return n.up - t.up end
    return nil
  end
  if timed then return nil end
  local w = n.wall - t.wall
  if w >= 0 then return w end
  return nil
end
`;

export interface DeviceScript {
  def: ScriptDef;
  run<T = unknown>(kv: Kv, keys: Record<string, string>, args: Record<string, unknown>): Promise<T>;
}

export const DEVICE_SCRIPTS: DeviceScript[] = [];

export function deviceScript(name: string, body: string, opts: { reclaim?: boolean } = {}): DeviceScript {
  const def: ScriptDef = { name, lua: `#!lua${opts.reclaim ? ' flags=allow-oom' : ''}\n${PRELUDE}\n${body}` };
  const script: DeviceScript = {
    def,
    async run<T>(kv: Kv, keys: Record<string, string>, args: Record<string, unknown>): Promise<T> {
      const names = Object.keys(keys);
      const out = await kv.script(def, names.map((n) => keys[n]!), [JSON.stringify(names), JSON.stringify(args)]);
      return JSON.parse(out) as T;
    },
  };
  DEVICE_SCRIPTS.push(script);
  return script;
}
```

The `today` prefix: `K.devToday('', '')` is `pp:dev:today::`; dropping the last character gives `pp:dev:today:`, then a script appends `id .. ':' .. day`. The prefixes test pins this.

- [ ] **Step 9: Write the limits**

`apps/server/src/devices/limits.ts`:

```ts
// The device routes' limits (spec: "Limits against abuse"). Each request passes a fixed-size ingress gate, is
// classified read-only, then charged to its class: the class's global pool and its per-key counters together, all or
// nothing, in one script, so a refused request creates nothing and per-key counters exist only for admitted requests.
import { keyedHash } from '../crypto.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { ipBucket, type Limit } from '../limits.ts';
import { deviceScript } from './lua.ts';

const hour = (bucket: string, max: number): Limit => ({ bucket, max, windowSeconds: 3600 });

export const DEVICE_LIMITS = {
  /** 4,096 buckets by the IP's keyed hash, 3,000 requests an hour each. */
  ingress: hour('dev-in', 3000),
  unknownSetupIp: hour('dev-setup-ip', 30),
  unknownSetupAll: hour('dev-setup-all', 300),
  /** Counted by the admission script, only when a new setup is stored. */
  storedSetupIp: hour('dev-stored-ip', 10),
  storedSetupAll: hour('dev-stored-all', 100),
  /** Counted at dispatch, for setups by credentials that do not own the endpoint's alert. */
  setupPushEndpoint: hour('dev-push-ep', 3),
  /** Setups with a captured alert and rotations, by the alert's own credential: counted at dispatch, per alert. */
  maintenanceAlert: hour('dev-maint', 6),
  maintenanceAll: hour('dev-maint-all', 600),
  ackIp: hour('dev-ack-ip', 60),
  ackAll: hour('dev-ack-all', 7000),
  knownReadCred: hour('dev-read', 600),
  knownReadIp: hour('dev-read-ip', 2400),
  knownReadAll: hour('dev-read-all', 50_000),
  pendingReadCred: hour('dev-pend', 240),
  pendingReadIp: hour('dev-pend-ip', 1200),
  pendingReadAll: hour('dev-pend-all', 15_000),
  changeCred: hour('dev-change', 60),
  changeAll: hour('dev-change-all', 6000),
  offIp: hour('dev-off-ip', 600),
  offAll: hour('dev-off-all', 6000),
  unknownIp: hour('dev-unk-ip', 600),
  unknownAll: hour('dev-unk-all', 6000),
  testAlert: hour('dev-test', 3),
  testIp: hour('dev-test-ip', 20),
  testAll: hour('dev-test-all', 200),
} satisfies Record<string, Limit>;

/** Which of the 4,096 ingress buckets an address falls in (by its /64 for IPv6). */
export function ingressBucket(ip: string, key: Buffer): number {
  return Buffer.from(keyedHash(key, 'ingress', ipBucket(ip)), 'base64url').readUInt16BE(0) % 4096;
}

/** The sliding window's keys and weight, as limits.ts's hit() computes them. */
export function rateKeys(limit: Limit, id: string, now: number) {
  const size = limit.windowSeconds * 1000;
  const window = Math.floor(now / size);
  return {
    cur: K.rate(`${limit.bucket}:${window}`, id),
    prev: K.rate(`${limit.bucket}:${window - 1}`, id),
    overlap: 1 - (now % size) / size,
    max: limit.max,
    /** Milliseconds until the end of the next window: this window's counter is read as "previous" until then. */
    ttl: (window + 2) * size - now,
  };
}

const chargeScript = deviceScript(
  'dev-charge',
  `
local items = A.items
for i = 1, #items do need(items[i].cur, 'string') need(items[i].prev, 'string') end
for i = 1, #items do
  local it = items[i]
  if not rate_room(it.cur, it.prev, it.overlap, it.max) then
    -- Counted in the day's statistics (an existing hash's field), by the pool that refused: requests, not operations.
    count('requests_refused_' .. it.bucket)
    return cjson.encode({ ok = false, refused = it.bucket })
  end
end
for i = 1, #items do rate_take(items[i].cur, items[i].ttl) end
return cjson.encode({ ok = true })
`,
);

/** Charge every limit (global pools first, by convention), or none: a refused request creates no key. */
export async function charge(kv: Kv, items: [Limit, string][], now: number): Promise<{ ok: true } | { ok: false; refused: string }> {
  const list = items.map(([limit, id]) => ({ ...rateKeys(limit, id, now), bucket: limit.bucket }));
  return chargeScript.run(kv, { stats: K.statsV2(manilaDay(now)) }, { now, items: list });
}
```

(The rate keys are named in `A.items`, not passed as `KEYS`: Valkey runs standalone here, and these counters are outside `pp:dev:`. Every other device script passes its keys by name.)

- [ ] **Step 10: Watch the tests pass**

Run: `npm test -w @penge/server -- devices-lua devices-limits units`
Expected: PASS. With the throwaway Valkey: `DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- devices-lua devices-limits` also PASS.

- [ ] **Step 11: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass on the diff (prompt: "Adversarial review: device limits configuration, the pp:dev key map, a Lua prelude shared by all device scripts, and an all-or-nothing rate limiter. Check Lua 5.1 compatibility, that a refused charge creates nothing, that elapsed() matches clock.ts, and that limits misconfigured in server.env fail loudly."). Then:

```bash
git add apps/server/src/config.ts apps/server/src/keys.ts apps/server/src/devices apps/server/test/units.test.ts apps/server/test/devices-lua.test.ts apps/server/test/devices-limits.test.ts
git commit -m "Device configuration, keys, the shared Lua prelude and all-or-nothing limits"
```

---
### Task 3: Email alerts back to `157bad9`, with the channel release's pages still answered

Email code goes back to the release before push, file for file; the only changes on top are the answers pages of `05cee09` need, the status fields the web app reads, and `4f0c3a4`'s backup fix. Every module that bound devices to subscribers is deleted.

**Files:**
- Restore from `157bad9`: `apps/server/src/{subscribers,templates,api,checker,stats,admin,check,server,backup}.ts`, `apps/server/test/{api,checker,deletion,stats,abroad,lookups}.test.ts`
- Delete: `apps/server/src/push/{atomic,devices,register,sender}.ts`, `apps/server/test/{api-push,backup-push,checker-push,push-atomic,push-sender,subscribers-push,templates}.test.ts`, `apps/server/test/abroad-world.ts`
- Keep: `apps/server/src/push/{endpoint,payload,errors}.ts`, `apps/server/test/push-endpoint.test.ts`, `apps/server/test/helpers.ts` (as it is now: a superset of `157bad9`'s), `apps/server/test/fixtures/v0.2/` (the frozen `157bad9` importer, for Task 4)
- Modify: `packages/contracts/src/index.ts` (`SubscribeRequest.channels` optional), `apps/server/src/config.ts` (owner token), `apps/server/src/api.ts`, `apps/server/src/subscribers.ts`, `apps/server/src/checker.ts` (re-apply `4f0c3a4`), `apps/server/src/server.ts`, `apps/server/src/limits.ts`, `apps/server/src/keys.ts`, `apps/server/dev/local.ts`, `apps/server/test/local-stack.test.ts`, `apps/server/test/checker.test.ts`
- Test: `apps/server/test/old-pages.test.ts`

**Interfaces:**
- Consumes: Task 2's `K.testMark` and `Config.devices`.
- Produces:
  - `PushConfig { mode: PushMode; vapid: { publicKey; privateKey; subject } | null; ownerToken: string | null }` (no `ownerEmails`; `PUSH_OWNER_EMAILS` refused at start; owner mode needs `PUSH_OWNER_TOKEN`).
  - `ApiDeps.push: PushConfig` (status answers `push` and `vapidPublicKey`); `ApiDeps` otherwise as at `157bad9`.
  - `previewPending(kv: Kv, token: string): Promise<{ siteIds: number[]; applicants: number; pace: Pace; channels: null } | null>` (subscribers.ts)
  - `confirm(kv, token, now)` as at `157bad9`, refusing (`invalid`) a pending request whose stored `channels.emailOn` is `false`.
  - `LEGACY_RELOAD = 'This page is out of date. Reload it.'` (api.ts), answered with `code: 'reload'`.
  - `createApi(deps)` returns the Hono app; Task 8 mounts the device routes on it with `mountDeviceRoutes(app, …)`.
  - `CheckDeps` as at `157bad9` (no `push`); Task 11 adds `devices`.

- [ ] **Step 1: Write the failing tests for the old pages' contract**

`apps/server/test/old-pages.test.ts`:

```ts
// Pages of the channel release (05cee09) stay open in people's browsers after the deploy. Their email requests must
// keep working against the exact answers of that release's contracts; anything about notifications is refused
// before anything is written.
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import type { PushConfig } from '../src/config.ts';
import { hashToken } from '../src/crypto.ts';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { createPending } from '../src/subscribers.ts';
import { clock, confirmToken, FakeMailer, keys, MemoryKv } from './helpers.ts';

const SITES = [{ id: 486, name: 'Antipolo' }, { id: 693, name: 'Pampanga' }];
const off: PushConfig = { mode: 'off', vapid: null, ownerToken: null };

async function setup(push = off) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  await kv.set(K.sites, JSON.stringify(SITES));
  const mailer = new FakeMailer();
  const app = createApi({ kv, keys, mailer, log: silentLog, publicBaseUrl: 'https://penge.example', now: t.now, clientIp: () => '203.0.113.7', push });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { t, kv, mailer, app, post };
}

const form = { email: 'juan@example.com', siteIds: [486], applicants: 2, pace: 'asap' };

describe('pages of the channel release', () => {
  it('get an email-only preview as "a request from before channels"', async () => {
    const s = await setup();
    await s.post('/api/subscribe', { ...form, channels: { emailOn: true, pushOn: false } });
    const token = confirmToken(s.mailer.sent[0]!.text)!;
    const res = await s.post('/api/confirm/preview', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteIds: [486], applicants: 2, pace: 'asap', channels: null });
    expect((await s.post('/api/confirm/preview', { token: 'x'.repeat(43) })).status).toBe(404);
  });

  it('confirm with their acknowledgement, and read email channels in the answer', async () => {
    const s = await setup();
    await s.post('/api/subscribe', { ...form, channels: { emailOn: true, pushOn: false } });
    const token = confirmToken(s.mailer.sent[0]!.text)!;
    const res = await s.post('/api/confirm', { token, acknowledge: { emailOn: true, pushOn: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'confirmed', siteIds: [486], applicants: 2, pace: 'asap', channels: { emailOn: true, pushOn: false, push: 'none' } });
  });

  it.each([
    ['notifications on', { emailOn: true, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null }],
    ['email off', { emailOn: false, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null }],
    ['both off', { emailOn: false, pushOn: false }],
  ])('are told to reload when they ask for %s, and nothing is written or sent', async (_, channels) => {
    const s = await setup();
    const res = await s.post('/api/subscribe', { ...form, channels });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This page is out of date. Reload it.', code: 'reload' });
    expect(s.mailer.sent).toEqual([]);
    expect(s.kv.keys().filter((k) => !k.startsWith('pp:rate:') && k !== K.sites)).toEqual([]);
  });

  it('never confirm a pending request the channel release stored with email off', async () => {
    const s = await setup();
    const token = await createPending(s.kv, keys, { ...form, pace: 'asap' } as never, s.t.now());
    const key = K.pending(hashToken(token));
    const stored = JSON.parse((await s.kv.get(key))!) as Record<string, unknown>;
    await s.kv.set(key, JSON.stringify({ ...stored, channels: { emailOn: false, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null } }), { ttlSeconds: 3600 });
    expect((await s.post('/api/confirm', { token })).status).toBe(404);
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([]);
  });

  it.each([
    ['POST', '/api/push/device'],
    ['DELETE', '/api/push/device'],
    ['POST', '/api/push/test'],
  ])('get 410 and "reload" from %s %s', async (method, path) => {
    const s = await setup();
    const res = await s.app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: 'c'.repeat(43) }) });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'This page is out of date. Reload it.', code: 'reload' });
  });

  it('read push mode and the VAPID key from the status', async () => {
    const s = await setup({ mode: 'owner', vapid: { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), subject: 'mailto:alerts@example.com' }, ownerToken: 't'.repeat(40) });
    const body = (await (await s.app.request('/api/status')).json()) as Record<string, unknown>;
    expect([body.push, body.vapidPublicKey]).toEqual(['owner', 'B'.repeat(87)]);
    const offBody = (await (await (await setup()).app.request('/api/status')).json()) as Record<string, unknown>;
    expect([offBody.push, offBody.vapidPublicKey]).toEqual(['off', null]);
  });
});

describe('pages of the release before push (157bad9)', () => {
  it('confirm with a bare token and get the answer they know, with channels they ignore', async () => {
    const s = await setup();
    await s.post('/api/subscribe', form);
    const token = confirmToken(s.mailer.sent[0]!.text)!;
    const res = await s.post('/api/confirm', { token });
    expect(await res.json()).toMatchObject({ status: 'confirmed', siteIds: [486], applicants: 2, pace: 'asap' });
  });
});
```

`confirmToken` is already in `helpers.ts` (`grep -n "export function confirmToken" apps/server/test/helpers.ts`; if it is in `api.test.ts` instead, move it into `helpers.ts` and import it in both).

- [ ] **Step 2: Restore the email code and delete the push modules**

```bash
git checkout 157bad9 -- apps/server/src/subscribers.ts apps/server/src/templates.ts apps/server/src/api.ts apps/server/src/checker.ts apps/server/src/stats.ts apps/server/src/admin.ts apps/server/src/check.ts apps/server/src/server.ts apps/server/src/backup.ts \
  apps/server/test/api.test.ts apps/server/test/checker.test.ts apps/server/test/deletion.test.ts apps/server/test/stats.test.ts apps/server/test/abroad.test.ts apps/server/test/lookups.test.ts
git rm -q apps/server/src/push/atomic.ts apps/server/src/push/devices.ts apps/server/src/push/register.ts apps/server/src/push/sender.ts \
  apps/server/test/api-push.test.ts apps/server/test/backup-push.test.ts apps/server/test/checker-push.test.ts apps/server/test/push-atomic.test.ts \
  apps/server/test/push-sender.test.ts apps/server/test/subscribers-push.test.ts apps/server/test/templates.test.ts apps/server/test/abroad-world.ts
git diff --stat 157bad9 -- apps/server/src/subscribers.ts apps/server/src/templates.ts apps/server/src/api.ts apps/server/src/checker.ts apps/server/src/stats.ts apps/server/src/admin.ts apps/server/src/check.ts apps/server/src/server.ts apps/server/src/backup.ts
```

Expected: the last command prints nothing (identical to `157bad9`).

- [ ] **Step 3: Watch the old-page tests fail**

Run: `npm test -w @penge/server -- old-pages`
Expected: FAIL: `createApi` ignores `push` (status has no `vapidPublicKey`), `/api/confirm/preview` and `/api/push/*` answer 404, `/api/subscribe` accepts `pushOn: true`, and the confirm answer has no `channels`.

- [ ] **Step 4: Re-apply `4f0c3a4`'s backup fix**

```bash
git show 4f0c3a4 -- apps/server/src/checker.ts apps/server/test/checker.test.ts | git apply --3way
git diff --stat
```

Expected: `checker.ts` and `checker.test.ts` each change as in `4f0c3a4` (old backups deleted even when the upload fails). If `git apply` reports a conflict, apply the hunks by hand: they are the three `backupOncePerDay` hunks and the test `"deletes backups 14 days old even when the day's upload fails, and retries the upload"`.

- [ ] **Step 5a: The owner token replaces owner addresses in the configuration**

Now that nothing reads `ownerEmails` (the push modules are gone), change the configuration. In `apps/server/test/units.test.ts`, replace the two push config tests (`'keeps push off unless every push setting is there'` and `'reads push settings, and owner mode needs owner addresses'`) with:

```ts
  it('keeps push off unless every push setting is there', () => {
    expect(loadConfig(env).push).toEqual({ mode: 'off', vapid: null, ownerToken: null });
    expect(() => loadConfig({ ...env, PUSH_MODE: 'live' })).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => loadConfig({ ...env, PUSH_MODE: 'sometimes' })).toThrow(/PUSH_MODE/);
  });

  it('reads push settings; owner mode needs an owner token of at least 32 characters', () => {
    const vapid = { VAPID_PUBLIC_KEY: 'B'.repeat(87), VAPID_PRIVATE_KEY: 'p'.repeat(43), VAPID_SUBJECT: 'mailto:alerts@example.com' };
    expect(() => loadConfig({ ...env, ...vapid, PUSH_MODE: 'owner' })).toThrow(/PUSH_OWNER_TOKEN/);
    expect(() => loadConfig({ ...env, ...vapid, PUSH_MODE: 'owner', PUSH_OWNER_TOKEN: 'x'.repeat(31) })).toThrow(/PUSH_OWNER_TOKEN/);
    expect(() => loadConfig({ ...env, ...vapid, PUSH_MODE: 'owner', PUSH_OWNER_TOKEN: `${'x'.repeat(31)} ` + 'y' })).toThrow(/PUSH_OWNER_TOKEN/);
    const c = loadConfig({ ...env, ...vapid, PUSH_MODE: 'owner', PUSH_OWNER_TOKEN: 'a'.repeat(40) });
    expect(c.push).toMatchObject({ mode: 'owner', ownerToken: 'a'.repeat(40) });
    expect(() => loadConfig({ ...env, ...vapid, PUSH_MODE: 'live', VAPID_SUBJECT: 'https://x' })).toThrow(/VAPID_SUBJECT/);
  });

  it('refuses the removed PUSH_OWNER_EMAILS, so a stale server.env is caught at start', () => {
    expect(() => loadConfig({ ...env, PUSH_OWNER_EMAILS: 'juan@example.com' })).toThrow(/PUSH_OWNER_EMAILS is no longer used/);
  });

```

Then in `apps/server/src/config.ts`:

Replace `PushConfig`:

```ts
export interface PushConfig {
  mode: PushMode;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  /** PUSH_MODE=owner: the token the owner's link carries; new notification setups need it. */
  ownerToken: string | null;
}
```

Replace the owner-address block (from `const listed = …` to `push = { … }`) with:

```ts
    const ownerToken = env.PUSH_OWNER_TOKEN?.trim() || null;
    if (ownerToken !== null && !/^[A-Za-z0-9_-]{32,256}$/.test(ownerToken)) {
      throw new ConfigError('PUSH_OWNER_TOKEN must be 32 to 256 characters of A-Z, a-z, 0-9, _ and -');
    }
    if (pushModeRaw === 'owner' && !ownerToken) throw new ConfigError('PUSH_MODE=owner needs PUSH_OWNER_TOKEN');
    push = { mode: pushModeRaw, vapid: { publicKey, privateKey, subject }, ownerToken };
```

and initialise `let push: PushConfig = { mode: 'off', vapid: null, ownerToken: null };`. Before reading `PUSH_MODE`:

```ts
  if (env.PUSH_OWNER_EMAILS?.trim()) {
    throw new ConfigError('PUSH_OWNER_EMAILS is no longer used; remove it (owner mode now uses PUSH_OWNER_TOKEN)');
  }
```

Run: `npm test -w @penge/server -- units`
Expected: PASS.

- [ ] **Step 5: Add the old pages' answers**

In `apps/server/src/subscribers.ts`:

1. `Pending` gains the field the channel release may have stored:

```ts
interface Pending {
  sealedEmail: string;
  index: string;
  siteIds: number[];
  applicants: number;
  pace?: Pace;
  requestedAt: string;
  /** Written only by the channel release (05cee09); never written now. Email off there is never email consent here. */
  channels?: { emailOn?: unknown };
}
```

2. In `confirm`, right after `const pending = JSON.parse(raw) as Pending;`:

```ts
    if (pending.channels !== undefined && pending.channels.emailOn !== true) return { status: 'invalid' };
```

and in the `peek` step, the same check before taking the lock:

```ts
  const peeked = JSON.parse(peek) as Pending;
  if (peeked.channels !== undefined && peeked.channels.emailOn !== true) return { status: 'invalid' };
  return withAddressLock(kv, peeked.index, async () => {
```

3. Add, after `createPending`:

```ts
/** What a pending link will do, for pages of the channel release, which ask before confirming: email, as always. */
export async function previewPending(kv: Kv, token: string): Promise<{ siteIds: number[]; applicants: number; pace: Pace; channels: null } | null> {
  const raw = await kv.get(K.pending(hashToken(token)));
  if (!raw) return null;
  const p = JSON.parse(raw) as Pending;
  if (p.channels !== undefined && p.channels.emailOn !== true) return null;
  return { siteIds: p.siteIds, applicants: p.applicants, pace: p.pace ?? 'hourly', channels: null };
}
```

In `apps/server/src/api.ts`:

1. Imports: add `type PushConfig` from `./config.ts`, and `previewPending` to the `./subscribers.ts` import.
2. `ApiDeps` gains:

```ts
  /** Whether notifications can be set up, and the key browsers subscribe with (the status reports both). */
  push: PushConfig;
```

3. After `SUBSCRIBE_MESSAGE`/`DELETION_MESSAGE`:

```ts
/** What a page of the channel release (05cee09) is told when it asks for anything but email. */
export const LEGACY_RELOAD = 'This page is out of date. Reload it.';
```

4. `fail`'s status union gains `409 | 410`.
5. `/api/status`'s answer gains, after `sites`:

```ts
      push: deps.push.mode,
      vapidPublicKey: deps.push.vapid?.publicKey ?? null,
```

and its `stored` cast becomes `Omit<StatusResponse, 'mailLive' | 'push' | 'vapidPublicKey'>`.

6. In `/api/subscribe`, right after `if (!parsed.ok) return parsed.res;`:

```ts
    // A page of the channel release sends `channels`; only "email, no notifications" is still something we do.
    const legacy = (parsed.body as { channels?: unknown } | null)?.channels;
    if (legacy !== undefined && legacy !== null) {
      const ch = legacy as { emailOn?: unknown; pushOn?: unknown };
      if (typeof legacy !== 'object' || ch.emailOn !== true || ch.pushOn !== false) {
        return c.json<ApiError>({ error: LEGACY_RELOAD, code: 'reload' }, 409);
      }
    }
```

7. `/api/confirm`'s answer becomes:

```ts
    // Pages of the channel release read `channels`; pages before it ignore it.
    return c.json<ConfirmResponse>({ status: result.status, siteIds: result.siteIds, applicants: result.applicants, pace: result.pace, channels: { emailOn: true, pushOn: false, push: 'none' } });
```

8. After `/api/confirm`:

```ts
  app.post('/api/confirm/preview', async (c) => {
    if (await limited(c, API_LIMITS.tokenPerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const token = (parsed.body as { token?: unknown } | null)?.token;
    if (!isToken(token)) return fail(c, 400, 'That link is not valid. Copy the whole link from the email.');
    const preview = await previewPending(kv, token);
    if (!preview) return fail(c, 404, 'That link has expired or was already used. Subscribe again to get a new one.');
    return c.json(preview);
  });

  // The channel release's device routes: its pages are told to reload.
  const gone = (c: Context) => c.json<ApiError>({ error: LEGACY_RELOAD, code: 'reload' }, 410);
  app.post('/api/push/device', gone);
  app.delete('/api/push/device', gone);
  app.post('/api/push/test', gone);
```

(`ApiError.code` already allows `'reload'` in the contracts; Task 17 keeps that member when it removes the others.)

In `apps/server/src/server.ts`, the `createApi({ … })` call gains `push: config.push,` after `stats`.

In `apps/server/src/limits.ts`, delete `devicePerIp`, `devicePerCredential` and `testPerDevice` from `API_LIMITS` (the device routes use `devices/limits.ts`).

In `apps/server/src/keys.ts`, delete `pushDevices`, `pushMeta`, `pushEndpoint`, `pushCred`, `pushPending`, `pushRevoked`, `pendingChannels`, `reserved`, `pushAddress` and `pushTestMark` (keep `pushPaused`).

- [ ] **Step 6: The restored tests and the local stack**

Every restored test that calls `createApi` does so without `push`: `api.test.ts`, `deletion.test.ts`, `lookups.test.ts`, `stats.test.ts` (around its line 291) and `abroad.test.ts` (around its line 447). Add `push: { mode: 'off', vapid: null, ownerToken: null }` to each call; `grep -n "createApi(" apps/server/test/*.ts` must then show `push:` in every one.

The restored tests also build subscription requests without `channels`, which the contracts still require until Task 17. In `packages/contracts/src/index.ts`, make it optional now: `channels?: Channels | null;` in `SubscribeRequest` (the web app always sets it, and `validateSubscribe` still returns it). Nothing else in the contracts changes here. In `api.test.ts`, the confirm answer's `toEqual` gains `channels: { emailOn: true, pushOn: false, push: 'none' }` (the field pages of the channel release read; `git diff 157bad9 HEAD -- apps/server/test/api.test.ts` shows the same line).

`apps/server/dev/local.ts`:
- drop the `webPushTransport` import and the `transport` and `pushTransport` uses;
- `const push: PushConfig = { mode: 'live', vapid, ownerToken: null };` and pass `push` to `createApi`;
- `CheckDeps` loses `push: { … }`;
- `K.pushTestMark` becomes `K.testMark`;
- the header comment's first line becomes `// The local test stack's server: the real API and the real checker, with a`.

`apps/server/test/local-stack.test.ts`: the subscribe bodies lose `channels: { … }`, the confirm body loses `acknowledge`, and `second`'s type becomes `{ delivery: unknown }`.

- [ ] **Step 7: Watch everything pass**

Run: `npm test -w @penge/server`
Expected: PASS, including `old-pages.test.ts`, the restored suites and `4f0c3a4`'s backup test.

Run: `npm run typecheck`
Expected: PASS for the server. (The web app still type-checks: the contracts are unchanged until Task 17.)

Run: `git diff 157bad9 --stat -- apps/server/src/subscribers.ts apps/server/src/api.ts apps/server/src/checker.ts apps/server/src/server.ts`
Expected: only the changes listed in Steps 4–5.

- [ ] **Step 8: Codex, commit**

Codex pass (prompt: "Adversarial review: email alerts restored file-for-file to release 157bad9 (git diff 157bad9 shows only the listed additions), the push binding code deleted, and the channel release's open pages answered. Find any email behaviour that differs from 157bad9, any request from a 05cee09 page that can write a notification-related field or turn email off, and any path where a pending request stored by 05cee09 with email off becomes an email subscription."). Then:

```bash
git add -A apps/server packages/contracts/src/index.ts
git commit -m "Email alerts as before push, with the channel release's pages told to reload for anything but email"
```

---
### Task 4: Backups in version 1 again, and an importer that checks identities both ways

**Files:**
- Modify: `apps/server/src/backup.ts` (from its `157bad9` form), `apps/server/src/subscribers.ts` (export `withAddressLock`), `apps/server/src/admin.ts` (restore output), `apps/server/src/keys.ts` (`importLock`), `apps/server/test/checker.test.ts` (the importer's new signature)
- Test: `apps/server/test/backup.test.ts`

**Interfaces:**
- Consumes: Task 3's restored `subscribers.ts`, `backup.ts`, `admin.ts`; `test/fixtures/v0.2/backup.ts` (the frozen `157bad9` importer).
- Produces:
  - `exportSubscribers(kv, siteIds, now): Promise<Backup>` with `Backup = { version: 1; exportedAt: string; subscribers: { id: string; fields: Record<string, string> }[] }`, each `fields` holding only `email, index, sites, applicants, pace, createdAt, confirmedAt`, and no record with `emailOn` `0`.
  - `importSubscribers(kv: Kv, keys: Keys, backup: unknown): Promise<{ restored: number; skipped: { id: string; reason: Skip }[]; emailOff: number }>` with `type Skip = 'address-taken' | 'id-taken' | 'email-off-now' | 'damaged-keys'`
  - `K.importLock` = `pp:lock:import`

- [ ] **Step 1: Write the failing tests**

`apps/server/test/backup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { exportSubscribers, importSubscribers } from '../src/backup.ts';
import { emailIndex, encryptEmail } from '../src/crypto.ts';
import { K } from '../src/keys.ts';
import { importSubscribers as importOf157bad9 } from './fixtures/v0.2/backup.ts';
import { keys, MemoryKv } from './helpers.ts';

const record = (id: string, email: string, extra: Record<string, string> = {}) => ({
  id,
  fields: {
    email: encryptEmail(email, keys.email),
    index: emailIndex(email, keys.index),
    sites: '486',
    applicants: '1',
    pace: 'hourly',
    createdAt: '2026-10-01T00:00:00.000Z',
    confirmedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  },
});
const ID_A = 'aaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbb';

async function live(kv: MemoryKv, r: ReturnType<typeof record>) {
  await kv.write([
    { op: 'hSet', key: K.subscriber(r.id), fields: r.fields },
    { op: 'set', key: K.emailIndex(r.fields.index), value: r.id },
    { op: 'sAdd', key: K.allSubscribers, members: [r.id] },
    { op: 'sAdd', key: K.siteSubscribers(486), members: [r.id] },
  ]);
}

describe('backups', () => {
  it('export version 1 with the pre-push fields only, and never a subscriber with email off', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_A, 'juan@example.com', { emailOn: '1', pushOn: '0' }));
    await live(kv, record(ID_B, 'ana@example.com', { emailOn: '0', pushOn: '1' }));
    await live(kv, record('cccccccccccccccccccccc', 'pedro@example.com', { emailOn: 'maybe' }));
    const backup = await exportSubscribers(kv, [486], 0);
    expect(backup.version).toBe(1);
    expect(backup.subscribers.map((s) => s.id)).toEqual([ID_A]);
    expect(Object.keys(backup.subscribers[0]!.fields).sort()).toEqual(['applicants', 'confirmedAt', 'createdAt', 'email', 'index', 'pace', 'sites']);
  });

  it('restore with the importer of 157bad9', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_A, 'juan@example.com'));
    const backup = await exportSubscribers(kv, [486], 0);
    const fresh = new MemoryKv();
    expect(await importOf157bad9(fresh, backup)).toBe(1);
    expect(await fresh.hGetAll(K.subscriber(ID_A))).toEqual(backup.subscribers[0]!.fields);
  });

  it('import versions 1 and 2, skipping and counting people who had email off', async () => {
    const fresh = new MemoryKv();
    const result = await importSubscribers(fresh, keys, {
      version: 2,
      exportedAt: '',
      subscribers: [record(ID_A, 'juan@example.com', { emailOn: '1', pushOn: '1' }), record(ID_B, 'ana@example.com', { emailOn: '0' })],
    });
    expect(result).toEqual({ restored: 1, skipped: [], emailOff: 1 });
    expect(await fresh.hGetAll(K.subscriber(ID_A))).not.toHaveProperty('pushOn');
    expect(await fresh.get(K.emailIndex(emailIndex('ana@example.com', keys.index)))).toBeNull();
    expect((await importSubscribers(new MemoryKv(), keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com')] })).restored).toBe(1);
    // A version-1 file carrying email off (made from data the channel release touched) never becomes consent.
    const v1Off = await importSubscribers(new MemoryKv(), keys, { version: 1, exportedAt: '', subscribers: [record(ID_B, 'ana@example.com', { emailOn: '0' })] });
    expect(v1Off).toEqual({ restored: 0, skipped: [], emailOff: 1 });
  });

  it.each([
    ['another version', { version: 3, exportedAt: '', subscribers: [] }, /not a PengePassportPH backup/],
    ['a malformed channel flag', { version: 2, exportedAt: '', subscribers: [record(ID_A, 'j@example.com', { emailOn: 'yes' })] }, /bad subscriber/],
    ['a malformed channel flag in version 1', { version: 1, exportedAt: '', subscribers: [record(ID_A, 'j@example.com', { pushOn: 'true' })] }, /bad subscriber/],
    ['an email-off record whose address is not its index', { version: 2, exportedAt: '', subscribers: [{ ...record(ID_A, 'j@example.com', { emailOn: '0' }), fields: { ...record(ID_A, 'j@example.com', { emailOn: '0' }).fields, index: 'x' } }] }, /does not match/],
    ['an email-off record repeating another\'s id', { version: 2, exportedAt: '', subscribers: [record(ID_A, 'j@example.com'), record(ID_A, 'k@example.com', { emailOn: '0' })] }, /twice/],
    ['a repeated id', { version: 1, exportedAt: '', subscribers: [record(ID_A, 'j@example.com'), record(ID_A, 'k@example.com')] }, /twice/],
    ['a repeated address', { version: 1, exportedAt: '', subscribers: [record(ID_A, 'j@example.com'), record(ID_B, 'j@example.com')] }, /twice/],
    ['an address that is not its index', { version: 1, exportedAt: '', subscribers: [{ ...record(ID_A, 'j@example.com'), fields: { ...record(ID_A, 'j@example.com').fields, index: emailIndex('k@example.com', keys.index) } }] }, /does not match/],
    ['an address sealed with another key', { version: 1, exportedAt: '', subscribers: [{ ...record(ID_A, 'j@example.com'), fields: { ...record(ID_A, 'j@example.com').fields, email: encryptEmail('j@example.com', Buffer.alloc(32, 7)) } }] }, /does not match/],
  ])('refuse %s before writing anything', async (_, backup, error) => {
    const fresh = new MemoryKv();
    await expect(importSubscribers(fresh, keys, backup)).rejects.toThrow(error);
    expect(fresh.keys()).toEqual([]);
  });

  it('never displace a live subscriber: an address now someone else\'s, or an id now another address\'s', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_B, 'juan@example.com')); // the address moved to another id
    await live(kv, { ...record(ID_A, 'pedro@example.com') }); // the id now belongs to another address
    const result = await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com')] });
    expect(result.restored).toBe(0);
    expect(result.skipped).toEqual([{ id: ID_A, reason: 'address-taken' }]);
    const other = await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'maria@example.com')] });
    expect(other.skipped).toEqual([{ id: ID_A, reason: 'id-taken' }]);
    expect(await kv.get(K.emailIndex(emailIndex('maria@example.com', keys.index)))).toBeNull();
  });

  it('never displaces a live record under the same id with another address, even with its index pointer missing', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_A, 'pedro@example.com'));
    await kv.write([{ op: 'del', key: K.emailIndex(emailIndex('pedro@example.com', keys.index)) }]); // damaged: no reverse pointer
    const r = await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com')] });
    expect(r.skipped).toEqual([{ id: ID_A, reason: 'id-taken' }]);
    expect((await kv.hGetAll(K.subscriber(ID_A))).index).toBe(emailIndex('pedro@example.com', keys.index));
  });

  it('never turns a live subscriber\'s email off back on: an older email-on backup is skipped for them', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_A, 'juan@example.com', { emailOn: '0', pushOn: '1' }));
    const before = await kv.hGetAll(K.subscriber(ID_A));
    const r = await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com')] });
    expect(r).toMatchObject({ restored: 0, skipped: [{ id: ID_A, reason: 'email-off-now' }] });
    expect(await kv.hGetAll(K.subscriber(ID_A))).toEqual(before);
  });

  it('writes nothing of a record when a key it needs has the wrong type', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_A, 'juan@example.com'));
    await kv.set(K.siteSubscribers(693), 'not a set');
    const before = kv.dump();
    const r = await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com', { sites: '693', pace: 'asap' })] });
    expect(r.skipped).toEqual([{ id: ID_A, reason: 'damaged-keys' }]);
    expect(kv.dump()).toBe(before);
  });

  it('removes old channel fields from a restored record, and never touches notification alerts', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_A, 'juan@example.com', { emailOn: '1', pushOn: '1', pushCredentialHash: 'h', device: 'Chrome' }));
    await kv.write([{ op: 'hSet', key: K.devAlert('x'), fields: { offices: '486' } }]);
    await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com')] });
    expect(Object.keys(await kv.hGetAll(K.subscriber(ID_A))).sort()).toEqual(['applicants', 'confirmedAt', 'createdAt', 'email', 'index', 'pace', 'sites']);
    expect(await kv.hGetAll(K.devAlert('x'))).toEqual({ offices: '486' });
  });

  it('runs one restore at a time', async () => {
    const kv = new MemoryKv();
    await kv.set(K.importLock, 'other', { ttlSeconds: 3600 });
    await expect(importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [] })).rejects.toThrow(/another restore/);
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- backup.test`
Expected: FAIL (the `157bad9` importer takes no `keys`, returns a number, does not skip or check).

- [ ] **Step 3: Write the importer**

`apps/server/src/keys.ts`, next to `addressLock`:

```ts
  /** Held while a backup is being restored: one restore at a time (backup.ts). */
  importLock: `${P}lock:import`,
```

`apps/server/src/subscribers.ts`: `async function withAddressLock` becomes `export async function withAddressLock` (no other change).

`apps/server/src/backup.ts`, whole file:

```ts
// Subscribers live only in Redis. Once a day the checker copies them, exactly
// as stored (addresses stay encrypted), to R2; `admin.mjs restore` puts a copy
// back. A backup is useless without the EMAIL_ENC_KEY that sealed it (and the
// EMAIL_HMAC_KEY its indexes were made with). Backups hold email subscribers
// only, in version 1, the format of the release before push; notification
// alerts are never in a backup and a restore never touches them.
import { isPace, LIMITS } from '@penge/contracts';
import { decryptEmail, emailIndex, randomToken } from './crypto.ts';
import { K } from './keys.ts';
import type { Kv, ScriptDef, WriteOp } from './kv.ts';
import { type Keys, withAddressLock } from './subscribers.ts';

type Entry = { id: string; fields: Record<string, string> };

export interface Backup {
  version: 1;
  exportedAt: string;
  subscribers: Entry[];
}

const ID = /^[A-Za-z0-9_-]{16,32}$/;
const FIELDS = ['email', 'index', 'sites', 'applicants', 'pace', 'createdAt', 'confirmedAt'];
/** Written by the channel release (05cee09); removed from every restored record. */
const CHANNEL_FIELDS = ['emailOn', 'pushOn', 'pushCredentialHash', 'device'];

/**
 * Every subscriber: from the set of all of them, and from the site sets too,
 * so one whose only office has left the DFA's list is still kept.
 */
export async function exportSubscribers(kv: Kv, siteIds: number[], now: number): Promise<Backup> {
  const ids = new Set<string>(await kv.sMembers(K.allSubscribers));
  for (const siteId of siteIds) for (const id of await kv.sMembers(K.siteSubscribers(siteId))) ids.add(id);
  const subscribers: Entry[] = [];
  for (const id of [...ids].sort()) {
    const fields = await kv.hGetAll(K.subscriber(id));
    // Only email consent is exported: no flag (a subscriber from before channels) or exactly '1'. Email off, or a flag
    // with any other value, is not an email subscriber.
    if (fields.email && fields.index && fields.sites && (fields.emailOn === undefined || fields.emailOn === '1')) {
      subscribers.push({ id, fields: Object.fromEntries(FIELDS.filter((f) => typeof fields[f] === 'string').map((f) => [f, fields[f]!])) });
    }
  }
  return { version: 1, exportedAt: new Date(now).toISOString(), subscribers };
}

/**
 * One record checked in full (whatever its flags) and cleaned, with whether it had email off. Throws on anything
 * malformed. A channel flag may appear in either version (a version-1 file made from data the channel release
 * touched); wherever it is, it must be '0' or '1', and '0' is never turned into email consent.
 */
function validated(r: unknown, keys: Keys): Entry & { sites: number[]; emailOff: boolean } {
  const { id, fields } = (r ?? {}) as { id?: unknown; fields?: unknown };
  if (typeof id !== 'string' || !ID.test(id) || typeof fields !== 'object' || fields === null) throw new Error(`bad subscriber ${String(id)}`);
  const f = fields as Record<string, unknown>;
  for (const flag of ['emailOn', 'pushOn']) if (flag in f && f[flag] !== '0' && f[flag] !== '1') throw new Error(`bad subscriber ${id}`);
  const clean = Object.fromEntries(FIELDS.filter((k) => typeof f[k] === 'string').map((k) => [k, f[k] as string]));
  if (f.pace !== undefined && !isPace(f.pace)) throw new Error(`bad subscriber ${id}`);
  const sites = (clean.sites ?? '').split(',').map(Number);
  if (!clean.email || !clean.index || !sites.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error(`bad subscriber ${id}`);
  const applicants = Number(clean.applicants);
  if (!/^\d+$/.test(clean.applicants ?? '') || applicants < 1 || applicants > LIMITS.maxApplicants) throw new Error(`bad subscriber ${id}`);
  let address: string;
  try {
    address = decryptEmail(clean.email, keys.email);
  } catch {
    throw new Error(`subscriber ${id}: its address does not match its index (another EMAIL_ENC_KEY?)`);
  }
  if (emailIndex(address, keys.index) !== clean.index) throw new Error(`subscriber ${id}: its address does not match its index (another EMAIL_HMAC_KEY?)`);
  return { id, fields: clean, sites, emailOff: f.emailOn === '0' };
}

/**
 * Put subscribers back, from version 1 or 2. The whole file is checked before anything is written. A record whose
 * address now belongs to another live subscriber, or whose id now belongs to another live address, is skipped and
 * listed, never displacing anyone; both are checked again under the address's lock as it is written. Run with the API
 * and the checker stopped (deploy/README.md); one restore at a time.
 */
export type Skip = 'address-taken' | 'id-taken' | 'email-off-now' | 'damaged-keys';

const TYPE: ScriptDef = { name: 'key-type', lua: "#!lua flags=no-writes\nreturn redis.call('TYPE', KEYS[1]).ok" };

export async function importSubscribers(kv: Kv, keys: Keys, backup: unknown): Promise<{ restored: number; skipped: { id: string; reason: Skip }[]; emailOff: number }> {
  const b = backup as { version?: unknown; subscribers?: unknown } | null;
  if ((b?.version !== 1 && b?.version !== 2) || !Array.isArray(b.subscribers)) throw new Error('not a PengePassportPH backup');
  const checked = b.subscribers.map((r) => validated(r, keys));
  const ids = new Set<string>();
  const indexes = new Set<string>();
  // Every record, email off included, is unique in the file.
  for (const r of checked) {
    if (ids.has(r.id)) throw new Error(`subscriber ${r.id} is in the backup twice`);
    if (indexes.has(r.fields.index!)) throw new Error(`subscriber ${r.id}: its address is in the backup twice`);
    ids.add(r.id);
    indexes.add(r.fields.index!);
  }
  const records = checked.filter((r) => !r.emailOff);

  const lock = randomToken();
  if (!(await kv.set(K.importLock, lock, { nx: true, ttlSeconds: 3600 }))) throw new Error('another restore is running; wait for it to finish');
  try {
    const skipped: { id: string; reason: Skip }[] = [];
    let restored = 0;
    for (const r of records) {
      await withAddressLock(kv, r.fields.index!, async () => {
        const owner = await kv.get(K.emailIndex(r.fields.index!));
        if (owner && owner !== r.id && (await kv.hGetAll(K.subscriber(owner))).email) {
          skipped.push({ id: r.id, reason: 'address-taken' });
          return;
        }
        const current = await kv.hGetAll(K.subscriber(r.id));
        // A live record under this id with another address (or none to compare): never overwritten, whatever the
        // state of its index pointer.
        if (Object.keys(current).length > 0 && current.index !== r.fields.index) {
          skipped.push({ id: r.id, reason: 'id-taken' });
          return;
        }
        // Consent as it is now wins over an older backup: email off (or a flag that is not '1') is never turned on.
        if (current.emailOn !== undefined && current.emailOn !== '1') {
          skipped.push({ id: r.id, reason: 'email-off-now' });
          return;
        }
        // The offices it follows now and the backup does not name: it leaves them.
        const dropped = (current.sites ?? '').split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0 && !r.sites.includes(n));
        // Every key the write touches has its type (or does not exist) before anything is written: a write that failed
        // half-way would leave the subscriber following offices whose sets do not hold it.
        const want: [string, string][] = [
          [K.subscriber(r.id), 'hash'],
          [K.emailIndex(r.fields.index!), 'string'],
          [K.allSubscribers, 'set'],
          ...[...new Set([...dropped, ...r.sites])].map((n): [string, string] => [K.siteSubscribers(n), 'set']),
        ];
        for (const [key, type] of want) {
          const has = await kv.script(TYPE, [key], []);
          if (has !== 'none' && has !== type) {
            skipped.push({ id: r.id, reason: 'damaged-keys' });
            return;
          }
        }
        await kv.write([
          ...dropped.map((siteId): WriteOp => ({ op: 'sRem', key: K.siteSubscribers(siteId), members: [r.id] })),
          { op: 'hDel', key: K.subscriber(r.id), fields: CHANNEL_FIELDS },
          { op: 'hSet', key: K.subscriber(r.id), fields: r.fields },
          { op: 'set', key: K.emailIndex(r.fields.index!), value: r.id },
          { op: 'sAdd', key: K.allSubscribers, members: [r.id] },
          ...r.sites.map((siteId): WriteOp => ({ op: 'sAdd', key: K.siteSubscribers(siteId), members: [r.id] })),
        ]);
        restored++;
      });
    }
    return { restored, skipped, emailOff: checked.length - records.length };
  } finally {
    if ((await kv.get(K.importLock)) === lock) await kv.write([{ op: 'del', key: K.importLock }]);
  }
}
```

`apps/server/src/admin.ts`, the restore branch:

```ts
      let data = readFileSync(file!);
      if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
      const result = await importSubscribers(kv, config.keys, JSON.parse(data.toString('utf8')) as unknown);
      process.stderr.write(`restored ${result.restored} subscribers; ${result.emailOff} had email off and were left out\n`);
      const why = { 'address-taken': 'its address belongs to another subscriber now', 'id-taken': 'its id belongs to another address now', 'email-off-now': 'it has email off now; a backup never turns it back on', 'damaged-keys': 'a key it needs has the wrong type; nothing of it was written (see the runbook)' };
      for (const s of result.skipped) process.stderr.write(`skipped ${s.id}: ${why[s.reason]}\n`);
```

Delete the now-unused `Backup` type import in `admin.ts`, and change the `--yes` hint to `'restore puts subscribers back without displacing anyone; add --yes to go ahead\n'`.

`apps/server/test/checker.test.ts`: every `importSubscribers(x, backup)` becomes `importSubscribers(x, keys, backup)`; `.toBe(1)` becomes `.toMatchObject({ restored: 1 })`.

- [ ] **Step 4: Watch them pass**

Run: `npm test -w @penge/server -- backup checker`
Expected: PASS.

- [ ] **Step 5: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review: subscriber backups back to version 1, and an importer for versions 1 and 2 that validates the whole file, checks every address against its index under the configured keys, never displaces a live subscriber in either direction, skips email-off records, removes channel fields with HDEL and runs one at a time. Find any input that writes something before the checks finish, or displaces or resurrects anyone."). Then:

```bash
git add apps/server/src/backup.ts apps/server/src/subscribers.ts apps/server/src/admin.ts apps/server/src/keys.ts apps/server/test/backup.test.ts apps/server/test/checker.test.ts
git commit -m "Backups in version 1 again; the importer checks identities both ways and never displaces anyone"
```

---
### Task 5: Device-alert contracts

The shapes both sides of `/api/device-alerts` agree on, versioned `deviceAlerts: 1`, and one choices validator shared by email and notification alerts.

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/device-alerts.test.ts`

**Interfaces:**
- Consumes: the existing `Pace`, `LIMITS`, `Checked`, `parsePushSubscription`, `PushSubscriptionInput`.
- Produces (all exported from `@penge/contracts`):

```ts
export const DEVICE_ALERTS_VERSION = 1;
export const DEVICE_ALERT_DAYS = 180;
export const SETUP_SECONDS = 300;
export interface AlertChoices { siteIds: number[]; applicants: number; pace: Pace }
export function validateChoices(input: unknown, knownSiteIds?: ReadonlySet<number>): Checked<AlertChoices>;
/** The subscription as the fingerprint is computed: endpoint and unpadded keys, in this order. */
export function canonicalSubscription(s: PushSubscriptionInput): string;
export interface CapturedAlert { incarnation: string; generation: number; revision: number }
export interface Activation { alertId: string; incarnation: string; generation: number; revision: number }
export type OperationKind = 'setup' | 'change' | 'rotate';
export type DispatchState = 'unsent' | 'sending' | 'accepted' | 'uncertain' | 'retryable' | 'failed';
export type TerminalResult = 'active' | 'expired' | 'changed' | 'full' | 'owner-only' | 'gone' | 'failed';
export interface OperationView {
  op: string; seq: number; kind: OperationKind;
  /** ISO; null for a change, which never waits. */
  expiresAt: string | null;
  dispatch: DispatchState | null;
  /** ISO: the earliest time the driving page may repeat the request (unsent or retryable). */
  retryAt: string | null;
  /** The same two times as the server's milliseconds from now: a device whose clock is wrong waits by these. */
  remainingMs: number | null;
  retryInMs: number | null;
  /** Why it was not sent yet: 'paused' | 'backoff' | 'limited' | 'mode'. */
  reason: string | null;
  result: TerminalResult | null;
  activation: Activation | null;
}
export interface DeviceAlertView {
  alertId: string; incarnation: string; generation: number; revision: number;
  choices: AlertChoices; fingerprint: string; endsAt: string;
  /** The old subscription was reported gone while a rotation is pending. */
  updating: boolean;
}
export type MineState =
  | { state: 'active'; alert: DeviceAlertView }
  | { state: 'ended'; endedAt: string }
  | { state: 'gone'; endedAt: string; fingerprint: string }
  | { state: 'none' };
export type MineAnswer = MineState & { operation: OperationView | null };
export type SetupOutcome = 'pending' | 'done' | 'busy' | 'limited' | 'full' | 'invalid' | 'owner-only' | 'off' | 'unavailable' | 'changed';
export interface SetupAnswer { outcome: SetupOutcome; operation: OperationView | null }
export type ReadyResult = TerminalResult | 'invalid' | 'unknown';
export interface ReadyAnswer { result: ReadyResult; activation: Activation | null }
export type ChangeAnswer = { result: 'active'; revision: number } | { result: 'changed' | 'busy' | 'invalid' | 'full' };
export type TestOutcome = 'accepted' | 'uncertain' | 'refused' | 'gone' | 'unavailable' | 'limited' | 'none';
export interface TestAnswer { test: TestOutcome; updating?: boolean }
export type SeenAnswer = { state: 'active'; endsAt: string } | { state: 'ended' | 'none' };
export interface SetupRequest { op: string; seq: number; subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; choices: AlertChoices; captured: CapturedAlert | null }
export interface RotateRequest { op: string; seq: number; subscription: SetupRequest['subscription']; captured: { incarnation: string; generation: number } }
export interface ChangeRequest { op: string; seq: number; incarnation: string; baseRevision: number; choices: AlertChoices }
export interface ReadyRequest { op: string; nonce: string }
export function isSetupRequest(v: unknown): v is SetupRequest;
export function isRotateRequest(v: unknown): v is RotateRequest;
export function isChangeRequest(v: unknown): v is ChangeRequest;
export function isReadyRequest(v: unknown): v is ReadyRequest;
export function isOperationView(v: unknown): v is OperationView;
export function isMineAnswer(v: unknown): v is MineAnswer;
export const TERMINAL_RESULTS: readonly TerminalResult[];
```

- [ ] **Step 1: Write the failing tests**

`packages/contracts/test/device-alerts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  canonicalSubscription,
  isChangeRequest,
  isMineAnswer,
  isOperationView,
  isReadyRequest,
  isRotateRequest,
  isSetupRequest,
  validateChoices,
  validateSubscribe,
} from '../src/index.ts';

const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) } };
const op = 'o'.repeat(22);

describe('choices, shared by both kinds of alert', () => {
  it('need no email', () => {
    expect(validateChoices({ siteIds: [693, 486, 486], applicants: 2, pace: 'asap' })).toEqual({ ok: true, value: { siteIds: [486, 693], applicants: 2, pace: 'asap' } });
  });

  it('refuse what the email form refuses', () => {
    const bad = validateChoices({ siteIds: [], applicants: 9, pace: 'daily' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['applicants', 'pace', 'siteIds']);
    expect(validateChoices({ siteIds: Array.from({ length: 11 }, (_, i) => i + 1) }).ok).toBe(false);
    expect(validateChoices({ siteIds: [1] }, new Set([2])).ok).toBe(false);
  });

  it('are what validateSubscribe checks, plus the address', () => {
    const both = validateSubscribe({ email: 'Juan@Example.com', siteIds: [486], applicants: 1, pace: 'hourly' });
    expect(both.ok && both.value).toMatchObject({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'hourly' });
  });
});

describe('the subscription fingerprint\'s input', () => {
  it('is the endpoint and unpadded keys, so page and server agree', () => {
    expect(canonicalSubscription({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })).toBe(
      JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }),
    );
  });
});

describe('device-alert requests', () => {
  const choices = { siteIds: [486], applicants: 1, pace: 'asap' };
  it('a setup carries op, seq, subscription, choices and an optional captured alert', () => {
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices, captured: null })).toBe(true);
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices, captured: { incarnation: 'i'.repeat(22), generation: 1, revision: 2 } })).toBe(true);
    expect(isSetupRequest({ op: 'short', seq: 1, subscription: sub, choices, captured: null })).toBe(false);
    expect(isSetupRequest({ op, seq: 0, subscription: sub, choices, captured: null })).toBe(false);
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices, captured: null, email: 'x@y.z' })).toBe(false);
  });
  it('a rotation captures incarnation and generation only, and carries no choices', () => {
    expect(isRotateRequest({ op, seq: 2, subscription: sub, captured: { incarnation: 'i'.repeat(22), generation: 1 } })).toBe(true);
    expect(isRotateRequest({ op, seq: 2, subscription: sub, captured: { incarnation: 'i'.repeat(22), generation: 1 }, choices })).toBe(false);
  });
  it('a change names the incarnation and the base revision', () => {
    expect(isChangeRequest({ op, seq: 3, incarnation: 'i'.repeat(22), baseRevision: 1, choices })).toBe(true);
    expect(isChangeRequest({ op, seq: 3, incarnation: 'i'.repeat(22), choices })).toBe(false);
  });
  it('an acknowledgement is an op and a 43-character nonce', () => {
    expect(isReadyRequest({ op, nonce: 'n'.repeat(43) })).toBe(true);
    expect(isReadyRequest({ op, nonce: 'n'.repeat(42) })).toBe(false);
  });
});

describe('answers', () => {
  it('accept an operation view with its relative times, and refuse a negative or fractional one', () => {
    const view = { op: 'o'.repeat(22), seq: 1, kind: 'setup', expiresAt: '2026-10-06T00:05:00.000Z', dispatch: 'accepted', retryAt: null, remainingMs: 300_000, retryInMs: null, reason: null, result: null, activation: null };
    expect(isOperationView(view)).toBe(true);
    expect(isOperationView({ ...view, remainingMs: -1 })).toBe(false);
    expect(isOperationView({ ...view, retryInMs: 1.5 })).toBe(false);
  });

  it('accept every state of /mine and refuse others', () => {
    const operation = null;
    expect(isMineAnswer({ state: 'none', operation })).toBe(true);
    expect(isMineAnswer({ state: 'ended', endedAt: '2026-10-06T00:00:00.000Z', operation })).toBe(true);
    expect(isMineAnswer({ state: 'gone', endedAt: '2026-10-06T00:00:00.000Z', fingerprint: 'f'.repeat(43), operation })).toBe(true);
    expect(isMineAnswer({ state: 'active', operation, alert: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, choices: { siteIds: [486], applicants: 1, pace: 'asap' }, fingerprint: 'f'.repeat(43), endsAt: '2027-04-04T00:00:00.000Z', updating: false } })).toBe(true);
    expect(isMineAnswer({ state: 'maybe', operation })).toBe(false);
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/contracts -- device-alerts`
Expected: FAIL: `validateChoices` (and the rest) is not exported.

- [ ] **Step 3: Write the contracts**

In `packages/contracts/src/index.ts`, replace the body of `validateSubscribe` from `const siteIds: number[] = [];` to the `pace` check with a call to the new shared validator, so both kinds of alert check choices the same way:

```ts
  const choices = validateChoices(body, knownSiteIds);
  if (!choices.ok) Object.assign(errors, choices.errors);
  // Both checks reported together; the explicit branch narrows `choices` for TypeScript.
  if (Object.keys(errors).length > 0 || !choices.ok) return { ok: false, errors };
```

and its success return uses `choices.value` for `siteIds`, `applicants` and `pace` (the old `if (Object.keys(errors).length > 0) return …` line before it goes; the honeypot check before the email stays first). Above `validateSubscribe`, add:

```ts
export interface AlertChoices {
  siteIds: number[];
  applicants: number;
  pace: Pace;
}

/**
 * Offices, group size and pace, as both kinds of alert take them. `knownSiteIds` is the server's current site
 * list; without it (in the browser) only the shape of the ids is checked.
 */
export function validateChoices(input: unknown, knownSiteIds?: ReadonlySet<number>): Checked<AlertChoices> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: { form: 'Send the form as a JSON object.' } };
  const body = input as Record<string, unknown>;
  const errors: Partial<Record<Field, string>> = {};
  const siteIds: number[] = [];
  if (!Array.isArray(body.siteIds) || body.siteIds.length === 0) {
    errors.siteIds = 'Choose at least one site.';
  } else if (body.siteIds.length > LIMITS.sitesPerSubscription * 4) {
    errors.siteIds = `Choose at most ${LIMITS.sitesPerSubscription} sites.`;
  } else {
    for (const id of body.siteIds) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
        errors.siteIds = 'That site list is not valid.';
        break;
      }
      if (knownSiteIds && !knownSiteIds.has(id)) {
        errors.siteIds = 'One of those sites is not on the list.';
        break;
      }
      if (!siteIds.includes(id)) siteIds.push(id);
    }
    if (!errors.siteIds && siteIds.length > LIMITS.sitesPerSubscription) errors.siteIds = `Choose at most ${LIMITS.sitesPerSubscription} sites.`;
  }
  const applicants = body.applicants === undefined ? 1 : body.applicants;
  if (typeof applicants !== 'number' || !Number.isInteger(applicants) || applicants < 1 || applicants > LIMITS.maxApplicants) {
    errors.applicants = `Choose from 1 to ${LIMITS.maxApplicants} people.`;
  }
  const pace = body.pace === undefined ? 'hourly' : body.pace;
  if (!isPace(pace)) errors.pace = 'Choose how often to get alerts.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { siteIds: siteIds.sort((a, b) => a - b), applicants: applicants as number, pace: pace as Pace } };
}
```

`ApiError.code` gains `'limited'` (the device routes' 429): `code?: 'reload' | 'push-unavailable' | 'full' | 'limited';`.

At the end of the file, the device-alert section:

```ts
// -- Notification alerts on a device (deviceAlerts: 1) -------------------------

export const DEVICE_ALERTS_VERSION = 1;
/** An alert lasts this long after setup or the last opening that reached the server. */
export const DEVICE_ALERT_DAYS = 180;
/** A setup or rotation must be acknowledged within this. */
export const SETUP_SECONDS = 300;

const B64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const isOpId = (v: unknown): v is string => typeof v === 'string' && B64URL_22.test(v);
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
// Not `isCount` (index.ts already has one, bounded at 10,000 slots): any non-negative safe integer.
const isNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** The subscription as both sides hash it for its fingerprint: endpoint and unpadded keys, in this order. */
export function canonicalSubscription(s: PushSubscriptionInput): string {
  return JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.p256dh.replace(/=+$/, ''), auth: s.auth.replace(/=+$/, '') } });
}

export interface CapturedAlert {
  incarnation: string;
  generation: number;
  revision: number;
}

export interface Activation {
  alertId: string;
  incarnation: string;
  generation: number;
  revision: number;
}

export type OperationKind = 'setup' | 'change' | 'rotate';
export type DispatchState = 'unsent' | 'sending' | 'accepted' | 'uncertain' | 'retryable' | 'failed';
export type TerminalResult = 'active' | 'expired' | 'changed' | 'full' | 'owner-only' | 'gone' | 'failed';
export const TERMINAL_RESULTS: readonly TerminalResult[] = ['active', 'expired', 'changed', 'full', 'owner-only', 'gone', 'failed'];

export interface OperationView {
  op: string;
  seq: number;
  kind: OperationKind;
  /** ISO; null for a change, which never waits. */
  expiresAt: string | null;
  dispatch: DispatchState | null;
  /** ISO: the earliest time the driving page may repeat the request, while unsent or retryable. */
  retryAt: string | null;
  /** expiresAt and retryAt as milliseconds from the server's now: the device turns them into its own times on arrival,
   * so a device clock that is wrong neither expires an admitted setup nor repeats it early. */
  remainingMs: number | null;
  retryInMs: number | null;
  /** Why the push was not sent yet: paused, backoff, limited, mode. */
  reason: 'paused' | 'backoff' | 'limited' | 'mode' | null;
  result: TerminalResult | null;
  activation: Activation | null;
}

export interface DeviceAlertView {
  alertId: string;
  incarnation: string;
  generation: number;
  revision: number;
  choices: AlertChoices;
  fingerprint: string;
  endsAt: string;
  /** The old subscription was reported gone while a rotation is pending. */
  updating: boolean;
}

export type MineState =
  | { state: 'active'; alert: DeviceAlertView }
  | { state: 'ended'; endedAt: string }
  | { state: 'gone'; endedAt: string; fingerprint: string }
  | { state: 'none' };
export type MineAnswer = MineState & { operation: OperationView | null };

export type SetupOutcome = 'pending' | 'done' | 'busy' | 'limited' | 'full' | 'invalid' | 'owner-only' | 'off' | 'unavailable' | 'changed';
export interface SetupAnswer {
  outcome: SetupOutcome;
  operation: OperationView | null;
}
export type ReadyResult = TerminalResult | 'invalid' | 'unknown';
export interface ReadyAnswer {
  result: ReadyResult;
  activation: Activation | null;
}
export type ChangeAnswer = { result: 'active'; revision: number } | { result: 'changed' | 'busy' | 'invalid' | 'full' };
export type SeenAnswer = { state: 'active'; endsAt: string } | { state: 'ended' | 'none' };
export type TestOutcome = 'accepted' | 'uncertain' | 'refused' | 'gone' | 'unavailable' | 'limited' | 'none';
export interface TestAnswer {
  test: TestOutcome;
  /** For gone: the alert was kept while its rotation finishes ("Updating this device's notifications…"). */
  updating?: boolean;
}

export interface SetupRequest {
  op: string;
  seq: number;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  choices: AlertChoices;
  captured: CapturedAlert | null;
}
export interface RotateRequest {
  op: string;
  seq: number;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  captured: { incarnation: string; generation: number };
}
export interface ChangeRequest {
  op: string;
  seq: number;
  incarnation: string;
  baseRevision: number;
  choices: AlertChoices;
}
export interface ReadyRequest {
  op: string;
  nonce: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isChoices = (v: unknown) => isObj(v) && only(v, ['siteIds', 'applicants', 'pace']) && validateChoices(v).ok;

export function isSetupRequest(v: unknown): v is SetupRequest {
  if (!isObj(v) || !only(v, ['op', 'seq', 'subscription', 'choices', 'captured'])) return false;
  const c = v.captured;
  const captured = c === null || (isObj(c) && only(c, ['incarnation', 'generation', 'revision']) && isOpId(c.incarnation) && isSeq(c.generation) && isSeq(c.revision));
  return isOpId(v.op) && isSeq(v.seq) && parsePushSubscription(v.subscription) !== null && isChoices(v.choices) && captured;
}

export function isRotateRequest(v: unknown): v is RotateRequest {
  if (!isObj(v) || !only(v, ['op', 'seq', 'subscription', 'captured'])) return false;
  const c = v.captured;
  return isOpId(v.op) && isSeq(v.seq) && parsePushSubscription(v.subscription) !== null && isObj(c) && only(c, ['incarnation', 'generation']) && isOpId(c.incarnation) && isSeq(c.generation);
}

export function isChangeRequest(v: unknown): v is ChangeRequest {
  return isObj(v) && only(v, ['op', 'seq', 'incarnation', 'baseRevision', 'choices']) && isOpId(v.op) && isSeq(v.seq) && isOpId(v.incarnation) && isSeq(v.baseRevision) && isChoices(v.choices);
}

export function isReadyRequest(v: unknown): v is ReadyRequest {
  return isObj(v) && only(v, ['op', 'nonce']) && isOpId(v.op) && typeof v.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.nonce);
}

const isIsoOrNull = (v: unknown) => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

function isActivation(v: unknown): v is Activation {
  return isObj(v) && isOpId(v.alertId) && isOpId(v.incarnation) && isSeq(v.generation) && isSeq(v.revision);
}

export function isOperationView(v: unknown): v is OperationView {
  return (
    isObj(v) &&
    isOpId(v.op) &&
    isSeq(v.seq) &&
    (v.kind === 'setup' || v.kind === 'change' || v.kind === 'rotate') &&
    isIsoOrNull(v.expiresAt) &&
    (v.dispatch === null || ['unsent', 'sending', 'accepted', 'uncertain', 'retryable', 'failed'].includes(v.dispatch as string)) &&
    isIsoOrNull(v.retryAt) &&
    (v.remainingMs === null || (typeof v.remainingMs === 'number' && Number.isSafeInteger(v.remainingMs) && v.remainingMs >= 0)) &&
    (v.retryInMs === null || (typeof v.retryInMs === 'number' && Number.isSafeInteger(v.retryInMs) && v.retryInMs >= 0)) &&
    (v.reason === null || ['paused', 'backoff', 'limited', 'mode'].includes(v.reason as string)) &&
    (v.result === null || (TERMINAL_RESULTS as readonly unknown[]).includes(v.result)) &&
    (v.activation === null || isActivation(v.activation))
  );
}

export function isMineAnswer(v: unknown): v is MineAnswer {
  if (!isObj(v) || !(v.operation === null || isOperationView(v.operation))) return false;
  if (v.state === 'none') return true;
  if (v.state === 'ended') return isIsoOrNull(v.endedAt) && v.endedAt !== null;
  if (v.state === 'gone') return typeof v.endedAt === 'string' && typeof v.fingerprint === 'string';
  if (v.state !== 'active' || !isObj(v.alert)) return false;
  const a = v.alert;
  return isActivation(a) && isChoices(a.choices) && typeof a.fingerprint === 'string' && typeof a.endsAt === 'string' && typeof a.updating === 'boolean' && isNonNegative(a.generation);
}
```

- [ ] **Step 4: Watch them pass**

Run: `npm test -w @penge/contracts`
Expected: PASS (the new file and the existing `contracts.test.ts`).

- [ ] **Step 5: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review: request and answer contracts for notification alerts, and the choices validator now shared with email. Find inputs a guard accepts that the server must not trust, fields that would let a request carry an email address or extra data, and any change to what validateSubscribe accepts."). Then:

```bash
git add packages/contracts/src/index.ts packages/contracts/test/device-alerts.test.ts
git commit -m "Contracts for notification alerts, with one choices validator for both kinds"
```

---
### Task 6: The alert store, admission and setup dispatch

Records, units and the first API-side scripts: admitting a setup or rotation (spec, "Setting up", step 3) and the dispatch gate and settlement (step 4). Activation is Task 7.

**Files:**
- Create: `apps/server/src/devices/store.ts` (TypeScript side: hashes, sealing, digests, views, constants), `apps/server/src/devices/store-lua.ts` (the Lua library every store script shares), `apps/server/src/devices/scripts-api.ts` (admission, dispatch begin and end, reclaim)
- Test: `apps/server/test/devices-store.test.ts`, `apps/server/test/device-fixtures.ts`

**Interfaces:**
- Consumes: Task 2's `deviceScript`, `KEY` prefixes and fixed keys, `rateKeys`, `DEVICE_LIMITS`; Task 5's contracts; `seal`/`unseal`/`hashToken`/`newId`/`keyedHash` (crypto.ts); `checkPushSubscription`, `endpointHmac` (push/endpoint.ts).
- Produces:
  - Constants (store.ts): `ALERT_UNITS = 5`, `OP_UNITS = 1`, `SETUP_MS = 300_000`, `RESULT_KEEP_MS = 86_400_000`, `ENDED_KEEP_MS = 30 * 86_400_000`, `ALERT_MS = 180 * 86_400_000`, `MAX_ACKS = 10`, `RECLAIM_BATCH = 20`, `CRASH_SENDING_MS = 30_000`.
  - `credentialHash(credential: string): string` (SHA-256, base64url); `fingerprint(s: PushSubscriptionInput): string` (SHA-256 of `canonicalSubscription`, base64url); `pushService(endpoint: string): 'fcm' | 'mozilla' | 'wns' | 'apple'`; `digest(kind: 'setup' | 'rotate', s: PushSubscriptionInput, choices: AlertChoices | null, captured: object | null): string`.
  - `sealSetup(keys: Keys, v: { subscription: PushSubscriptionInput; choices: AlertChoices | null; nonce: string }): string` / `openSetup(keys, sealed)`, label `device-setup:v1`; `sealSubscription(keys, s)` / `openSubscription(keys, sealed)`, label `device:v1`.
  - `type OpRecord = Record<string, string>`; `opView(o: OpRecord | null, now: number): OperationView | null`.
  - Scripts (scripts-api.ts): `admitScript`, `dispatchBeginScript`, `dispatchEndScript`, `reclaimScript`, each a `DeviceScript`, and typed wrappers:
    - `admit(kv, a: AdmitInput): Promise<{ outcome: 'pending' | 'repeat' | 'busy' | 'invalid' | 'changed' | 'full' | 'limited'; o?: OpRecord }>`
    - `dispatchBegin(kv, a: { now; cred; op; did; svc; ep; modeOk: boolean; epItems: RateItem[]; maintItems: RateItem[] }): Promise<{ go: boolean; o: OpRecord }>`
    - `dispatchEnd(kv, a: { now; cred; op; did; svc; outcome: 'accepted' | 'uncertain' | 'retryable' | 'failed' | 'gone'; backoffUntil: number | null }): Promise<{ ok: boolean }>`
    - `reclaim(kv, now: number, limit?: number): Promise<{ expired: number; ended: number; deleted: number }>`
  - The Lua library (store-lua.ts, `STORE_LIB`): `rec(field)`, `rec_add(field, n)`, `alert_get(id)`, `is_ended(a)`, `alert_delete(id, a, reason)` (reason `ended` | `gone` | `off` | `replaced`), `op_finish(cred, o, result, activation)`, `reclaim(n)`; constants `ALERT_UNITS`, `RESULT_KEEP_MS`, `ENDED_KEEP_MS`, `ALERT_MS`, `MAX_ACKS`.
  - Record layout (fixed here, used by every later task):
    - Alert `pp:dev:<id>`: `sub` (sealed, `device:v1`), `offices` ("486,693"), `group`, `pace`, `created`, `order`, `cred`, `op`, `inc`, `gen`, `rev`, `fp`, `ep`, `svc`, `end`, `renewed`, `seq`, `gone` (absent unless set), `cand` (absent unless a replacement candidate's credential).
    - Operation `pp:dev:op:<cred>`: `op`, `seq`, `maxseq`, `kind`, `digest`, `cap` (JSON or ""), `alert` (the captured alert's id or ""), `rsv` ("" | `alert` | `repl`), `other` (the alert a replacement targets, or ""), `exp`, `dsp`, `did`, `dspAt`, `retry`, `why`, `result` ("" while unfinished), `act` (JSON or ""), `done`, `sealed` and `nh` (only while unfinished), `ep`, `fp`, `svc`, `tok`, `acks`, `started`; a change also has `choices`.
    - End record `pp:dev:ended:<cred>`: `reason` (`ended` | `gone`), `at`, `fp`.
    - `pp:dev:records`: `units`, `alerts`, `repl`. `pp:dev:garbage`: alert id → units. `pp:dev:deadlines` members `op|<cred>` and `ended|<cred>`.

- [ ] **Step 1: Write the test fixtures**

`apps/server/test/device-fixtures.ts`:

```ts
// Notification-alert test fixtures: real subscriptions (allowlisted hosts, real P-256 keys), credentials, and a way
// to put an alert in place without going through setup.
import { randomBytes } from 'node:crypto';
import type { AlertChoices } from '@penge/contracts';
import { checkPushSubscription, endpointHmac } from '../src/push/endpoint.ts';
import { K } from '../src/keys.ts';
import type { Kv } from '../src/kv.ts';
import { ALERT_MS, credentialHash, fingerprint, pushService, sealSubscription } from '../src/devices/store.ts';
import { fcmSubscription, keys } from './helpers.ts';

export const credential = () => randomBytes(32).toString('base64url');
export const opId = () => randomBytes(16).toString('base64url');
export const choices = (o: Partial<AlertChoices> = {}): AlertChoices => ({ siteIds: [486], applicants: 1, pace: 'asap', ...o });
export const subscription = (id?: string) => checkPushSubscription(fcmSubscription(id))!;

/** An active alert, written as activation would write it. */
export async function seedAlert(kv: Kv, o: { id?: string; cred?: string; now: number; choices?: AlertChoices; inc?: string; gen?: number; rev?: number; end?: number; order?: number; sub?: ReturnType<typeof subscription> }) {
  const id = o.id ?? opId();
  const cred = o.cred ?? credential();
  const hash = credentialHash(cred);
  const sub = o.sub ?? subscription();
  const c = o.choices ?? choices();
  const ep = endpointHmac(keys.index, sub.endpoint);
  await kv.write([
    {
      op: 'hSet',
      key: K.devAlert(id),
      fields: {
        sub: sealSubscription(keys, sub), offices: c.siteIds.join(','), group: String(c.applicants), pace: c.pace,
        created: String(o.now), order: String(o.order ?? 1), cred: hash, op: opId(), inc: o.inc ?? opId(), gen: String(o.gen ?? 1),
        rev: String(o.rev ?? 1), fp: fingerprint(sub), ep, svc: pushService(sub.endpoint), end: String(o.end ?? o.now + ALERT_MS),
        renewed: String(o.now), seq: '1',
      },
    },
    { op: 'set', key: K.devCred(hash), value: id },
    { op: 'set', key: K.devEndpoint(ep), value: id },
    ...c.siteIds.map((s) => ({ op: 'sAdd' as const, key: K.devSite(s), members: [`${id}:${c.applicants}`] })),
    { op: 'hSet', key: K.devRecords, fields: { units: String(Number((await kv.hGetAll(K.devRecords)).units ?? 0) + 5), alerts: String(Number((await kv.hGetAll(K.devRecords)).alerts ?? 0) + 1) } },
  ]);
  await kv.script({ name: 'seed-end', lua: `#!lua\nredis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) return 'ok'` }, [K.devEnds], [String(o.end ?? o.now + ALERT_MS), id]);
  return { id, cred, hash, sub, ep, fp: fingerprint(sub), choices: c };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/server/test/devices-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { endpointHmac } from '../src/push/endpoint.ts';
import { admit, type AdmitInput, dispatchBegin, dispatchEnd, reclaim } from '../src/devices/scripts-api.ts';
import { ALERT_UNITS, credentialHash, digest, fingerprint, opView, pushService, sealSetup, SETUP_MS } from '../src/devices/store.ts';
import { choices, credential, opId, seedAlert, subscription } from './device-fixtures.ts';
import { keys, MemoryKv } from './helpers.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const limits = { alertLimit: 3, recordLimit: 100 };

function setup(cred: string, o: Partial<AdmitInput> & { sub?: ReturnType<typeof subscription>; cap?: AdmitInput['cap'] } = {}): AdmitInput {
  const sub = o.sub ?? subscription();
  const c = choices();
  return {
    now: T0, cred: credentialHash(cred), op: opId(), seq: 1, kind: 'setup', cap: false,
    digest: digest('setup', sub, c, o.cap || null), ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc: pushService(sub.endpoint),
    sealed: sealSetup(keys, { subscription: sub, choices: c, nonce: 'n'.repeat(43) }), nh: 'h'.repeat(43), tok: '', exp: T0 + SETUP_MS,
    stored: [], ...limits, ...o,
  };
}
const records = async (kv: Parameters<typeof admit>[0]) => kv.hGetAll(K.devRecords);

for (const [name, make] of valkeyTargets()) {
  describe(`admission on ${name}`, () => {
    it('stores a first setup with a reservation and one operation unit', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      const r = await admit(kv, a);
      expect(r.outcome).toBe('pending');
      expect(r.o).toMatchObject({ op: a.op, seq: '1', kind: 'setup', rsv: 'alert', dsp: 'unsent', result: '', exp: String(T0 + SETUP_MS) });
      expect(await records(kv)).toEqual({ units: String(ALERT_UNITS + 1), alerts: '1' });
      expect(opView(r.o!, T0)).toMatchObject({ op: a.op, kind: 'setup', dispatch: 'unsent', result: null, expiresAt: new Date(T0 + SETUP_MS).toISOString() });
    });

    it('answers a repeat with the same request by its state, and a different one as invalid, changing nothing', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const before = await records(kv);
      expect((await admit(kv, a)).outcome).toBe('repeat');
      expect((await admit(kv, { ...a, digest: 'other' })).outcome).toBe('invalid');
      expect(await records(kv)).toEqual(before);
    });

    it('refuses a sequence number not higher than the highest used, and another operation while one runs', async () => {
      const kv = await make();
      const c = credential();
      await admit(kv, setup(c, { seq: 5 }));
      expect((await admit(kv, setup(c, { seq: 5 }))).outcome).toBe('invalid');
      expect((await admit(kv, setup(c, { seq: 6 }))).outcome).toBe('busy');
    });

    it('ends an expired operation as expired, releasing its reservation, and admits the next', async () => {
      const kv = await make();
      const c = credential();
      await admit(kv, setup(c, { seq: 1 }));
      const next = await admit(kv, setup(c, { seq: 2, now: T0 + SETUP_MS + 1, exp: T0 + 2 * SETUP_MS }));
      expect(next.outcome).toBe('pending');
      expect(await records(kv)).toEqual({ units: String(ALERT_UNITS + 1), alerts: '1' });
    });

    it('refuses a new alert at the ceiling, and anything past the record limit, writing nothing', async () => {
      const kv = await make();
      for (let i = 0; i < 3; i++) expect((await admit(kv, setup(credential()))).outcome).toBe('pending');
      const before = await records(kv);
      expect((await admit(kv, setup(credential()))).outcome).toBe('full');
      expect((await admit(kv, setup(credential(), { alertLimit: 10, recordLimit: Number(before.units) + 5 }))).outcome).toBe('full');
      expect(await records(kv)).toEqual(before);
    });

    it('counts a stored new setup against its IP and the global pool, and refuses past them without writing', async () => {
      const kv = await make();
      const item = { cur: 'pp:rate:t:1:ip', prev: 'pp:rate:t:0:ip', overlap: 1, max: 1, ttl: 60, bucket: 'dev-stored-ip' };
      expect((await admit(kv, setup(credential(), { stored: [item] }))).outcome).toBe('pending');
      const before = await records(kv);
      expect((await admit(kv, setup(credential(), { stored: [item] }))).outcome).toBe('limited');
      expect(await records(kv)).toEqual(before);
    });

    it('admits a setup for an endpoint another alert has as one replacement candidate, within 10% of the ceiling', async () => {
      const kv = await make();
      const owner = await seedAlert(kv, { now: T0 });
      const r = await admit(kv, setup(credential(), { sub: owner.sub, alertLimit: 10 }));
      expect(r.outcome).toBe('pending');
      expect(r.o).toMatchObject({ rsv: 'repl', other: owner.id });
      expect((await kv.hGetAll(K.devAlert(owner.id))).cand).toBeDefined();
      expect((await admit(kv, setup(credential(), { sub: owner.sub, alertLimit: 10 }))).outcome).toBe('busy');
      expect((await records(kv)).repl).toBe('1');
    });

    it('needs the captured alert for a re-setup, and incarnation and generation for a rotation', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, gen: 2, rev: 3 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      expect((await admit(kv, setup(mine.cred, { seq: 2, cap: { incarnation: inc, generation: 2, revision: 2 } }))).outcome).toBe('changed');
      expect((await admit(kv, setup(mine.cred, { seq: 2 }))).outcome).toBe('changed'); // a first setup needs no alert
      expect((await admit(kv, setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 2 } }))).outcome).toBe('pending');
      expect(await records(kv)).toMatchObject({ alerts: '1' }); // no reservation for maintenance
    });

    it('ends the credential\'s own ended alert first, leaving an end record, and then admits a first setup', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      expect((await admit(kv, setup(mine.cred, { seq: 2 }))).outcome).toBe('pending');
      expect(await kv.get(K.devAlert(mine.id))).toBeNull();
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'ended', at: String(T0) });
      expect(await kv.hGetAll(K.devGarbage)).toEqual({ [mine.id]: String(ALERT_UNITS - 1) });
    });

    it('after finishing an expired rotation whose old subscription was gone, never writes to the deleted alert', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await admit(kv, setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } }));
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }]);
      const r = await admit(kv, setup(mine.cred, { seq: 3, now: T0 + SETUP_MS + 1, exp: T0 + 2 * SETUP_MS }));
      expect(r.outcome).toBe('pending'); // a first setup: the alert went with its rotation
      expect(await kv.hGetAll(K.devAlert(mine.id))).toEqual({});
    });

    it('fails without writing anything when an alert it would delete has a damaged index or field', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      // The ended alert's endpoint index is damaged (a set, not a string): deleting it would fail half-way.
      await kv.write([{ op: 'del', key: K.devEndpoint(mine.ep) }, { op: 'sAdd', key: K.devEndpoint(mine.ep), members: ['wrong type'] }]);
      const records = await kv.hGetAll(K.devRecords);
      await expect(admit(kv, setup(mine.cred, { seq: 2 }))).rejects.toThrow(/WRONGTYPE/);
      expect(await kv.hGetAll(K.devAlert(mine.id))).not.toEqual({});
      expect(await kv.hGetAll(K.devRecords)).toEqual(records);
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toEqual({});
    });

    it('refuses a new setup while push is paused or its push service backs off, checked in the same step', async () => {
      const kv = await make();
      await kv.set(K.pushPaused, '1');
      expect((await admit(kv, setup(credential()))).outcome).toBe('unavailable');
      await kv.write([{ op: 'del', key: K.pushPaused }]);
      await kv.set(K.pushBackoff('fcm'), String(T0 + 60_000));
      expect((await admit(kv, setup(credential()))).outcome).toBe('unavailable');
      expect(await kv.hGetAll(K.devRecords)).toEqual({});
    });

    it('fails without writing anything when a key has the wrong type', async () => {
      const kv = await make();
      await kv.set(K.devRecords, 'oops');
      await expect(admit(kv, setup(credential()))).rejects.toThrow(/WRONGTYPE/);
      expect(await kv.get(K.devRecords)).toBe('oops');
    });
  });

  describe(`setup dispatch on ${name}`, () => {
    const gate = (cred: string, op: string, o: Partial<Parameters<typeof dispatchBegin>[1]> = {}) => ({
      now: T0, cred: credentialHash(cred), op, did: opId(), svc: 'fcm', ep: 'e', modeOk: true, epItems: [], maintItems: [], ...o,
    });

    it('sends once: the first begin moves unsent to sending, a second begin does not', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      expect((await dispatchBegin(kv, gate(c, a.op))).go).toBe(true);
      expect((await dispatchBegin(kv, gate(c, a.op))).go).toBe(false);
    });

    it.each([
      ['the mode', { modeOk: false }, 'mode'],
      ['the emergency stop', {}, 'paused'],
      ['a push service backoff', {}, 'backoff'],
    ])('holds the push for %s, saying why and when to try again', async (_, o, why) => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      if (why === 'paused') await kv.set(K.pushPaused, '1');
      if (why === 'backoff') await kv.set(K.pushBackoff('fcm'), String(T0 + 60_000));
      const r = await dispatchBegin(kv, gate(c, a.op, o));
      expect(r.go).toBe(false);
      expect(r.o).toMatchObject({ dsp: 'unsent', why, retry: String(why === 'backoff' ? T0 + 60_000 : T0 + 30_000) });
    });

    it('limits setup pushes to an endpoint whose alert the credential does not own', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const ep = { cur: 'pp:rate:dev-push-ep:1:e', prev: 'pp:rate:dev-push-ep:0:e', overlap: 1, max: 0, ttl: 60, bucket: 'dev-push-ep' };
      expect((await dispatchBegin(kv, gate(c, a.op, { epItems: [ep] }))).o).toMatchObject({ why: 'limited' });
    });

    it('ends an expired operation at the gate instead of sending', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const r = await dispatchBegin(kv, gate(c, a.op, { now: T0 + SETUP_MS }));
      expect(r.go).toBe(false);
      expect(r.o).toMatchObject({ result: 'expired' });
      expect(await records(kv)).toEqual({ units: '1', alerts: '0' });
    });

    it.each([
      ['accepted', 'accepted', ''],
      ['uncertain', 'uncertain', ''],
      ['retryable', 'retryable', ''],
      ['failed', 'sending', 'failed'],
      ['gone', 'sending', 'gone'],
    ] as const)('settles a %s dispatch by its id only', async (outcome, dsp, result) => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const g = gate(c, a.op);
      await dispatchBegin(kv, g);
      expect((await dispatchEnd(kv, { now: T0, cred: g.cred, op: a.op, did: 'someone-else', svc: 'fcm', outcome, backoffUntil: null })).ok).toBe(false);
      expect((await dispatchEnd(kv, { now: T0, cred: g.cred, op: a.op, did: g.did, svc: 'fcm', outcome, backoffUntil: null })).ok).toBe(true);
      expect(await kv.hGetAll(K.devOp(g.cred))).toMatchObject(result ? { result } : { dsp, result: '' });
      if (result) expect(await records(kv)).toEqual({ units: '1', alerts: '0' });
    });

    it('fails without writing anything when a rotation it would finish has an alert with a damaged index', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const rot = setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await admit(kv, rot);
      const g = gate(mine.cred, rot.op);
      await dispatchBegin(kv, g);
      // The old subscription was reported gone, and the alert's endpoint index is damaged: a failed rotation would delete it.
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }, { op: 'del', key: K.devEndpoint(mine.ep) }, { op: 'sAdd', key: K.devEndpoint(mine.ep), members: ['wrong type'] }]);
      const before = { alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords), backoff: await kv.get(K.pushBackoff('fcm')) };
      await expect(dispatchEnd(kv, { now: T0, cred: g.cred, op: rot.op, did: g.did, svc: 'fcm', outcome: 'failed', backoffUntil: T0 + 60_000 })).rejects.toThrow(/WRONGTYPE/);
      await expect(dispatchBegin(kv, gate(mine.cred, rot.op, { now: T0 + SETUP_MS }))).rejects.toThrow(/WRONGTYPE/);
      expect({ alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords), backoff: await kv.get(K.pushBackoff('fcm')) }).toEqual(before);
    });

    it.each(['1.0', '1e0', '01', '9007199254740993'])('fails without writing anything when a record counter reads %s', async (bad) => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const rot = setup(mine.cred, { seq: 2, kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await admit(kv, rot);
      const g = gate(mine.cred, rot.op);
      await dispatchBegin(kv, g);
      // A failed rotation of an alert whose old subscription was gone deletes it, then counts: the count is checked first.
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }, { op: 'hSet', key: K.devRecords, fields: { alerts: bad } }]);
      const before = { alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords) };
      await expect(dispatchEnd(kv, { now: T0, cred: g.cred, op: rot.op, did: g.did, svc: 'fcm', outcome: 'failed', backoffUntil: null })).rejects.toThrow(/not an integer/);
      expect({ alert: await kv.hGetAll(K.devAlert(mine.id)), op: await kv.hGetAll(K.devOp(g.cred)), records: await kv.hGetAll(K.devRecords) }).toEqual(before);
    });

    it('sets the shared backoff for a throttled dispatch, never earlier than one already set', async () => {
      const kv = await make();
      const c = credential();
      const a = setup(c);
      await admit(kv, a);
      const g = gate(c, a.op);
      await dispatchBegin(kv, g);
      await kv.set(K.pushBackoff('fcm'), String(T0 + 900_000));
      await dispatchEnd(kv, { now: T0, cred: g.cred, op: a.op, did: g.did, svc: 'fcm', outcome: 'retryable', backoffUntil: T0 + 60_000 });
      expect(await kv.get(K.pushBackoff('fcm'))).toBe(String(T0 + 900_000));
      expect(await kv.hGetAll(K.devOp(g.cred))).toMatchObject({ dsp: 'retryable', retry: String(T0 + 900_000) });
    });
  });

  describe(`reclaim on ${name}`, () => {
    it('ends expired operations and ended alerts, and deletes overdue results and end records, at most the batch', async () => {
      const kv = await make();
      const c = credential();
      await admit(kv, setup(c));
      const old = await seedAlert(kv, { now: T0 - 1000, end: T0 - 1 });
      expect(await reclaim(kv, T0 + SETUP_MS)).toEqual({ expired: 1, ended: 1, deleted: 0 });
      expect(await reclaim(kv, T0 + SETUP_MS + 31 * 86_400_000)).toEqual({ expired: 0, ended: 0, deleted: 2 });
      expect(await kv.get(K.devOp(credentialHash(c)))).toBeNull();
      expect(await kv.get(K.devEnded(old.hash))).toBeNull();
      // Only the ended alert's garbage is still charged: the checker removes its delivery keys.
      expect(await records(kv)).toEqual({ units: String(ALERT_UNITS - 1), alerts: '0' });
    });
  });
}

describe('units', () => {
  it('match the configuration check (5 per alert, config.ts)', () => {
    expect(ALERT_UNITS).toBe(5);
  });
});

describe('admission and memory', () => {
  it('is refused before it starts when Valkey is out of memory', async () => {
    const kv = new MemoryKv();
    kv.oom = true;
    await expect(admit(kv, setup(credential()))).rejects.toThrow(/OOM/);
    expect(kv.keys()).toEqual([]);
  });

  it('reclaims even when out of memory', async () => {
    const kv = new MemoryKv();
    kv.oom = true;
    expect(await reclaim(kv, T0)).toEqual({ expired: 0, ended: 0, deleted: 0 });
  });
});
```

- [ ] **Step 3: Watch them fail**

Run: `npm test -w @penge/server -- devices-store`
Expected: FAIL: `Cannot find module '../src/devices/store.ts'`.

- [ ] **Step 4: Write `store.ts`**

`apps/server/src/devices/store.ts`:

```ts
// Notification alerts' records, as the TypeScript side sees them: hashes, sealing, digests and the views the API
// answers with. The records themselves are written only by the Lua scripts (scripts-api.ts, scripts-delivery.ts).
import { createHash } from 'node:crypto';
import { type AlertChoices, canonicalSubscription, type DispatchState, type OperationView, type PushSubscriptionInput, SETUP_SECONDS, type TerminalResult, TERMINAL_RESULTS } from '@penge/contracts';
import { seal, unseal } from '../crypto.ts';
import type { Keys } from '../subscribers.ts';

/** Storage units (spec: "Bounds"): an alert with its largest delivery footprint and the end record it may leave. */
export const ALERT_UNITS = 5;
/** An operation record. */
export const OP_UNITS = 1;
export const SETUP_MS = SETUP_SECONDS * 1000;
export const RESULT_KEEP_MS = 24 * 3600_000;
export const ENDED_KEEP_MS = 30 * 86_400_000;
export const ALERT_MS = 180 * 86_400_000;
export const MAX_ACKS = 10;
/** What one admission tidies up in passing (spec: "Lifetime and clean-up"). */
export const RECLAIM_BATCH = 20;
/** A dispatch still `sending` this long after it began was cut short by a crash: it is uncertain. */
export const CRASH_SENDING_MS = 30_000;

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');

export const credentialHash = (credential: string) => sha(credential);
export const fingerprint = (s: PushSubscriptionInput) => sha(canonicalSubscription(s));

export function pushService(endpoint: string): 'fcm' | 'mozilla' | 'wns' | 'apple' {
  const host = new URL(endpoint).hostname;
  if (host === 'fcm.googleapis.com') return 'fcm';
  if (host === 'updates.push.services.mozilla.com') return 'mozilla';
  if (host.endsWith('.notify.windows.com')) return 'wns';
  return 'apple';
}

/** What makes two requests "the identical operation": kind, subscription, choices and captured alert. */
export function digest(kind: 'setup' | 'rotate', s: PushSubscriptionInput, choices: AlertChoices | null, captured: object | null): string {
  return sha(JSON.stringify([kind, canonicalSubscription(s), choices, captured]));
}

export interface SetupSecret {
  subscription: PushSubscriptionInput;
  choices: AlertChoices | null;
  nonce: string;
}

export const sealSetup = (keys: Keys, v: SetupSecret) => seal(JSON.stringify(v), keys.email, 'device-setup:v1');
export const openSetup = (keys: Keys, sealed: string) => JSON.parse(unseal(sealed, keys.email, 'device-setup:v1')) as SetupSecret;
export const sealSubscription = (keys: Keys, s: PushSubscriptionInput) => seal(JSON.stringify(s), keys.email, 'device:v1');
export const openSubscription = (keys: Keys, sealed: string) => JSON.parse(unseal(sealed, keys.email, 'device:v1')) as PushSubscriptionInput;

export type OpRecord = Record<string, string>;

const iso = (ms: string | undefined) => (ms ? new Date(Number(ms)).toISOString() : null);

/** What a credential's operation record looks like from the device. Never includes the sealed fields or the nonce hash. */
export function opView(o: OpRecord | null | undefined, now: number): OperationView | null {
  if (!o?.op) return null;
  const kind = o.kind as OperationView['kind'];
  let dispatch = (o.dsp || null) as DispatchState | null;
  if (dispatch === 'sending' && now - Number(o.dspAt ?? 0) > CRASH_SENDING_MS) dispatch = 'uncertain';
  const result = (TERMINAL_RESULTS as readonly string[]).includes(o.result ?? '') ? (o.result as TerminalResult) : null;
  return {
    op: o.op,
    seq: Number(o.seq),
    kind,
    expiresAt: kind === 'change' ? null : iso(o.exp),
    dispatch: kind === 'change' ? null : dispatch,
    retryAt: !result && (dispatch === 'unsent' || dispatch === 'retryable') ? iso(o.retry) : null,
    remainingMs: kind === 'change' || !o.exp ? null : Math.max(0, Number(o.exp) - now),
    retryInMs: !result && (dispatch === 'unsent' || dispatch === 'retryable') && o.retry ? Math.max(0, Number(o.retry) - now) : null,
    reason: (['paused', 'backoff', 'limited', 'mode'].includes(o.why ?? '') ? o.why : null) as OperationView['reason'],
    result,
    activation: o.act ? (JSON.parse(o.act) as OperationView['activation']) : null,
  };
}
```

- [ ] **Step 5: Write the Lua library**

`apps/server/src/devices/store-lua.ts`:

```ts
// Lua functions shared by every script that changes alert records (appended after the prelude of lua.ts). Units are
// kept here and only here: every record that takes storage is created and deleted through these functions.
import { ALERT_MS, ALERT_UNITS, ENDED_KEEP_MS, MAX_ACKS, RESULT_KEEP_MS } from './store.ts';

export const STORE_LIB = `
local ALERT_UNITS = ${ALERT_UNITS}
local RESULT_KEEP_MS = ${RESULT_KEEP_MS}
local ENDED_KEEP_MS = ${ENDED_KEEP_MS}
local ALERT_MS = ${ALERT_MS}
local MAX_ACKS = ${MAX_ACKS}

local function rec(field) return tonumber(redis.call('HGET', KEY.records, field) or '0') or 0 end
local function rec_add(field, n) if n ~= 0 then redis.call('HINCRBY', KEY.records, field, n) end end

local function alert_get(id)
  if not id then return nil end
  need(KEY.alert .. id, 'hash')
  local a = hgetall(KEY.alert .. id)
  if a.inc == nil then return nil end
  return a
end

-- As Valkey's HINCRBY and INCR read a stored value: a canonical decimal integer ("1", never "1.0", "1e0" or "01"),
-- within the safe range, so any later increment of it cannot fail after earlier writes.
local function integer(v, what)
  local n = tonumber(v)
  if n == nil or n ~= math.floor(n) or math.abs(n) >= 9007199254740991 then error('not an integer: ' .. what) end
  if type(v) == 'string' and I(n) ~= v then error('not an integer: ' .. what) end
  return n
end

-- Everything deleting or changing this alert may touch, checked before a step's first write: key types, and the
-- fields a script reads as numbers. A step that fails here has written nothing.
local function alert_check(id, a)
  if not a then return end
  need(KEY.cred .. a.cred, 'string') need(KEY.endpoint .. a.ep, 'string') need(KEY.ended .. a.cred, 'hash')
  for office in string.gmatch(a.offices or '', '[^,]+') do need(KEY.site .. office, 'set') end
  for _, f in ipairs({ 'end', 'gen', 'rev', 'order', 'group' }) do integer(a[f], 'alert ' .. id .. ' ' .. f) end
  if a.seq ~= nil and a.seq ~= '' then integer(a.seq, 'alert ' .. id .. ' seq') end
end

-- The same for a credential's operation record, and for the alerts finishing it may touch.
local function op_check(cred, o)
  if o.op == nil then return end
  for _, f in ipairs({ 'seq', 'maxseq', 'exp', 'acks' }) do if o[f] ~= nil and o[f] ~= '' then integer(o[f], 'op ' .. f) end end
  if o.other ~= nil and o.other ~= '' then alert_check(o.other, alert_get(o.other)) end
  if o.alert ~= nil and o.alert ~= '' then alert_check(o.alert, alert_get(o.alert)) end
end

local function is_ended(a) return N(a['end']) <= NOW end

-- Deletes an alert's record and indexes (each index only if it still names this alert). Its delivery keys stay for
-- the checker, charged as garbage. 'ended' and 'gone' leave an end record for its credential, in the unit the alert
-- reserved for it; 'off' and 'replaced' leave none.
local function alert_delete(id, a, reason)
  redis.call('DEL', KEY.alert .. id)
  if redis.call('GET', KEY.cred .. a.cred) == id then redis.call('DEL', KEY.cred .. a.cred) end
  if redis.call('GET', KEY.endpoint .. a.ep) == id then redis.call('DEL', KEY.endpoint .. a.ep) end
  for office in string.gmatch(a.offices, '[^,]+') do redis.call('SREM', KEY.site .. office, id .. ':' .. a.group) end
  redis.call('ZREM', KEY.ends, id)
  rec_add('alerts', -1)
  local garbage = ALERT_UNITS
  if reason == 'ended' or reason == 'gone' then
    local ek = KEY.ended .. a.cred
    if redis.call('EXISTS', ek) == 1 then rec_add('units', -1) end
    local fp = ''
    if reason == 'gone' then fp = a.fp end
    redis.call('DEL', ek)
    redis.call('HSET', ek, 'reason', reason, 'at', I(NOW), 'fp', fp)
    redis.call('ZADD', KEY.deadlines, NOW + ENDED_KEEP_MS, 'ended|' .. a.cred)
    garbage = ALERT_UNITS - 1
  end
  redis.call('HSET', KEY.garbage, id, garbage)
  count('alerts_' .. reason)
end

-- Ends a credential's unfinished operation with a terminal result, releasing what it reserved. With 'active' the
-- reservation has become the alert (activation did that). A rotation that ends any other way deletes an alert whose
-- old subscription was reported gone meanwhile.
local function op_finish(cred, o, result, activation)
  local ok = KEY.op .. cred
  if o.rsv == 'alert' and result ~= 'active' then rec_add('alerts', -1) rec_add('units', -ALERT_UNITS) end
  if o.rsv == 'repl' then
    rec_add('repl', -1)
    if result ~= 'active' then rec_add('units', -ALERT_UNITS) end
  end
  if o.other ~= nil and o.other ~= '' and redis.call('HGET', KEY.alert .. o.other, 'cand') == cred then
    redis.call('HDEL', KEY.alert .. o.other, 'cand')
  end
  if o.kind == 'rotate' and result ~= 'active' and o.alert ~= '' then
    local a = alert_get(o.alert)
    if a and a.gone ~= nil and a.gone ~= '' then alert_delete(o.alert, a, 'gone') end
  end
  local act = ''
  if activation then act = cjson.encode(activation) end
  redis.call('HSET', ok, 'result', result, 'done', I(NOW), 'act', act, 'rsv', '')
  redis.call('HDEL', ok, 'sealed', 'nh')
  redis.call('ZREM', KEY.ops, cred)
  redis.call('ZADD', KEY.deadlines, NOW + RESULT_KEEP_MS, 'op|' .. cred)
  count('ops_' .. result)
end

-- Ends what is overdue, at most n things: unfinished operations past their expiry, alerts past their end, and
-- results and end records past their deadline. Never touches delivery keys (only the checker does).
local function reclaim(n)
  local out = { expired = 0, ended = 0, deleted = 0 }
  local left = n
  -- Each item is checked, then changed: an item that fails its check stops the step with the earlier ones complete.
  for _, cred in ipairs(redis.call('ZRANGEBYSCORE', KEY.ops, '-inf', NOW, 'LIMIT', 0, left)) do
    need(KEY.op .. cred, 'hash')
    local o = hgetall(KEY.op .. cred)
    op_check(cred, o)
    if o.op ~= nil and o.result == '' then op_finish(cred, o, 'expired') out.expired = out.expired + 1
    else redis.call('ZREM', KEY.ops, cred) end
    left = left - 1
  end
  if left > 0 then
    for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEY.ends, '-inf', NOW, 'LIMIT', 0, left)) do
      local a = alert_get(id)
      alert_check(id, a)
      if a then alert_delete(id, a, 'ended') out.ended = out.ended + 1 else redis.call('ZREM', KEY.ends, id) end
      left = left - 1
    end
  end
  if left > 0 then
    for _, m in ipairs(redis.call('ZRANGEBYSCORE', KEY.deadlines, '-inf', NOW, 'LIMIT', 0, left)) do
      local sep = string.find(m, '|', 1, true)
      local kind = string.sub(m, 1, sep - 1)
      local cred = string.sub(m, sep + 1)
      need(KEY.op .. cred, 'hash') need(KEY.ended .. cred, 'hash')
      if kind == 'op' then
        local o = hgetall(KEY.op .. cred)
        if o.op ~= nil and o.result ~= '' then redis.call('DEL', KEY.op .. cred) rec_add('units', -1) out.deleted = out.deleted + 1 end
      elseif kind == 'ended' then
        if redis.call('EXISTS', KEY.ended .. cred) == 1 then redis.call('DEL', KEY.ended .. cred) rec_add('units', -1) out.deleted = out.deleted + 1 end
      end
      redis.call('ZREM', KEY.deadlines, m)
      left = left - 1
    end
  end
  return out
end

-- The fixed keys every store script touches, and the counters it adds to, checked before its first write.
local function need_store()
  need(KEY.records, 'hash') need(KEY.garbage, 'hash') need(KEY.deadlines, 'zset') need(KEY.ops, 'zset') need(KEY.ends, 'zset')
  for _, f in ipairs({ 'units', 'alerts', 'repl' }) do
    local v = redis.call('HGET', KEY.records, f)
    if v then integer(v, 'records ' .. f) end
  end
end
`;
```

- [ ] **Step 6: Write the scripts**

`apps/server/src/devices/scripts-api.ts`:

```ts
// The API's atomic steps for notification alerts (spec: "Setting up, with the ready check", steps 3 and 4).
// Each checks every key's type first, so a failure writes nothing; refusals write nothing either, except the
// tidying the spec asks for in passing (an expired operation ended, the credential's own ended alert ended).
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { deviceScript } from './lua.ts';
import { STORE_LIB } from './store-lua.ts';
import { type OpRecord, RECLAIM_BATCH } from './store.ts';

export interface RateItem {
  cur: string;
  prev: string;
  overlap: number;
  max: number;
  ttl: number;
  bucket: string;
}

export interface AdmitInput {
  now: number;
  /** The credential's SHA-256. */
  cred: string;
  op: string;
  seq: number;
  kind: 'setup' | 'rotate';
  /** A setup's captured alert, or a rotation's incarnation and generation; false for a first setup. */
  cap: { incarnation: string; generation: number; revision?: number } | false;
  digest: string;
  ep: string;
  fp: string;
  svc: string;
  sealed: string;
  /** SHA-256 of the nonce: what the acknowledgement is compared with. */
  nh: string;
  /** SHA-256 of the owner token this setup came with, or "". */
  tok: string;
  exp: number;
  /** The "new setups stored" counters (first setups only). */
  stored: RateItem[];
  alertLimit: number;
  recordLimit: number;
}

export const admitScript = deviceScript(
  'dev-admit',
  `${STORE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.endpoint, 'string') need(K.backoff, 'string') need_store()
for i = 1, #A.stored do need(A.stored[i].cur, 'string') need(A.stored[i].prev, 'string') end
local cred = A.cred
-- Everything this step reads, read (and so type-checked) before its first write.
local o = hgetall(K.op)
local alertId = redis.call('GET', K.cred) or nil
local a = alert_get(alertId)
local owner = redis.call('GET', K.endpoint) or nil
local oa = alert_get(owner)
local co = {}
if oa and oa.cand ~= nil and oa.cand ~= '' and oa.cand ~= cred then need(KEY.op .. oa.cand, 'hash') co = hgetall(KEY.op .. oa.cand) end
alert_check(alertId, a) alert_check(owner, oa) op_check(cred, o)
if co.exp ~= nil and co.exp ~= '' then integer(co.exp, 'candidate exp') end
local function refuse(why) count('refused_' .. why) return cjson.encode({ outcome = why }) end
-- A repeat of the credential's current or last operation answers its state and changes nothing.
if o.op == A.op then
  if o.digest == A.digest then return cjson.encode({ outcome = 'repeat', o = o }) end
  return refuse('invalid')
end
local highest = tonumber(o.maxseq or '0') or 0
if a then highest = math.max(highest, tonumber(a.seq or '0') or 0) end
if A.seq <= highest then return refuse('invalid') end
if o.op ~= nil and o.result == '' and N(o.exp) > NOW then return refuse('busy') end
-- Admitted only if its push can be sent now: the stop and the push service's backoff, checked again here, atomically.
if redis.call('EXISTS', KEY.paused) == 1 then return refuse('unavailable') end
if counter(K.backoff) > NOW then return refuse('unavailable') end
-- Tidying the spec asks for in passing: valid whatever happens next.
if o.op ~= nil and o.result == '' then
  op_finish(cred, o, 'expired')
  -- Finishing an expired rotation can delete the alert (its old subscription was gone): read it again.
  alertId = redis.call('GET', K.cred) or nil
  a = alert_get(alertId)
  owner = redis.call('GET', K.endpoint) or nil
  oa = alert_get(owner)
end
if a and is_ended(a) then
  alert_delete(alertId, a, 'ended')
  if owner == alertId then owner = nil oa = nil end
  a = nil
  alertId = nil
end
local cap = A.cap
if A.kind == 'setup' and not cap then
  if a then return refuse('changed') end
elseif A.kind == 'setup' then
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation or N(a.rev) ~= cap.revision then return refuse('changed') end
else
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation then return refuse('changed') end
end
local rsv, other = '', ''
local units = 0
if redis.call('EXISTS', K.op) == 0 then units = 1 end
if A.kind == 'setup' and not cap then
  if oa and not is_ended(oa) then
    -- One replacement candidate per endpoint: another credential's unfinished, unexpired setup for it blocks this one.
    if co.result == '' and co.other == owner and N(co.exp) > NOW then return refuse('busy') end
    if rec('repl') + 1 > math.floor(A.alertLimit / 10) then return refuse('full') end
    rsv = 'repl'
    other = owner
  else
    if rec('alerts') + 1 > A.alertLimit then return refuse('full') end
    rsv = 'alert'
  end
  units = units + ALERT_UNITS
  for i = 1, #A.stored do
    local it = A.stored[i]
    if not rate_room(it.cur, it.prev, it.overlap, it.max) then return refuse('limited') end
  end
end
if rec('units') + units > A.recordLimit then return refuse('full') end
if A.kind == 'setup' and not cap then for i = 1, #A.stored do rate_take(A.stored[i].cur, A.stored[i].ttl) end end
if rsv == 'alert' then rec_add('alerts', 1) end
if rsv == 'repl' then rec_add('repl', 1) redis.call('HSET', KEY.alert .. other, 'cand', cred) end
rec_add('units', units)
local maxseq = math.max(highest, A.seq)
local capJson = ''
if cap then capJson = cjson.encode(cap) end
redis.call('DEL', K.op)
redis.call('HSET', K.op, 'op', A.op, 'seq', I(A.seq), 'maxseq', I(maxseq), 'kind', A.kind, 'digest', A.digest, 'cap', capJson,
  'alert', alertId or '', 'rsv', rsv, 'other', other, 'exp', I(A.exp), 'dsp', 'unsent', 'did', '', 'dspAt', '', 'retry', I(NOW),
  'why', '', 'result', '', 'act', '', 'done', '', 'sealed', A.sealed, 'nh', A.nh, 'ep', A.ep, 'fp', A.fp, 'svc', A.svc,
  'tok', A.tok, 'acks', '0', 'started', I(NOW))
if a then redis.call('HSET', KEY.alert .. alertId, 'seq', I(maxseq)) end
redis.call('ZADD', KEY.ops, A.exp, cred)
redis.call('ZREM', KEY.deadlines, 'op|' .. cred)
count('ops_started')
return cjson.encode({ outcome = 'pending', o = hgetall(K.op) })
`,
);

export async function admit(kv: Kv, a: AdmitInput): Promise<{ outcome: 'pending' | 'repeat' | 'busy' | 'invalid' | 'changed' | 'full' | 'limited' | 'unavailable'; o?: OpRecord }> {
  // The endpoint index is passed as a key; the alert record of its owner is reached by prefix.
  return admitScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), endpoint: K.devEndpoint(a.ep), backoff: K.pushBackoff(a.svc) }, { ...a });
}

export const dispatchBeginScript = deviceScript(
  'dev-dispatch-begin',
  `${STORE_LIB}
need(K.op, 'hash') need(K.backoff, 'string') need(K.endpoint, 'string') need_store()
local o = hgetall(K.op)
-- Everything finishing the operation may touch (an expired rotation can delete its alert) is checked before any write.
op_check(A.cred, o)
if o.op ~= A.op or o.result ~= '' then return cjson.encode({ go = false, o = o }) end
if N(o.exp) <= NOW then op_finish(A.cred, o, 'expired') return cjson.encode({ go = false, o = hgetall(K.op) }) end
if o.dsp ~= 'unsent' and o.dsp ~= 'retryable' then return cjson.encode({ go = false, o = o }) end
local function hold(why, at)
  redis.call('HSET', K.op, 'why', why, 'retry', I(at))
  count('dispatch_held_' .. why)
  return cjson.encode({ go = false, o = hgetall(K.op) })
end
if not A.modeOk then return hold('mode', NOW + 30000) end
if redis.call('EXISTS', KEY.paused) == 1 then return hold('paused', NOW + 30000) end
local b = tonumber(redis.call('GET', K.backoff) or '0') or 0
if b > NOW then return hold('backoff', b) end
local items = {}
if o.cap ~= '' then
  items = A.maintItems
else
  local owner = redis.call('GET', K.endpoint) or nil
  if not owner or redis.call('HGET', KEY.alert .. owner, 'cred') ~= A.cred then items = A.epItems end
end
for i = 1, #items do need(items[i].cur, 'string') need(items[i].prev, 'string') end
for i = 1, #items do
  if not rate_room(items[i].cur, items[i].prev, items[i].overlap, items[i].max) then return hold('limited', NOW + 30000) end
end
for i = 1, #items do rate_take(items[i].cur, items[i].ttl) end
redis.call('HSET', K.op, 'dsp', 'sending', 'did', A.did, 'dspAt', I(NOW), 'why', '')
return cjson.encode({ go = true, o = hgetall(K.op) })
`,
);

export function dispatchBegin(
  kv: Kv,
  a: { now: number; cred: string; op: string; did: string; svc: string; ep: string; modeOk: boolean; epItems: RateItem[]; maintItems: RateItem[] },
): Promise<{ go: boolean; o: OpRecord }> {
  return dispatchBeginScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), backoff: K.pushBackoff(a.svc), endpoint: K.devEndpoint(a.ep) }, { ...a });
}

export const dispatchEndScript = deviceScript(
  'dev-dispatch-end',
  `${STORE_LIB}
need(K.op, 'hash') need(K.backoff, 'string') need_store()
local o = hgetall(K.op)
op_check(A.cred, o)
if o.op ~= A.op or o.did ~= A.did or o.dsp ~= 'sending' or o.result ~= '' then return '{"ok":false}' end
local b = tonumber(redis.call('GET', K.backoff) or '0') or 0
if A.backoffUntil and A.backoffUntil > b then
  redis.call('SET', K.backoff, I(A.backoffUntil))
  b = A.backoffUntil
end
count('dispatch_' .. A.outcome)
if A.outcome == 'accepted' or A.outcome == 'uncertain' then
  redis.call('HSET', K.op, 'dsp', A.outcome)
elseif A.outcome == 'retryable' then
  redis.call('HSET', K.op, 'dsp', 'retryable', 'retry', I(math.max(NOW, b)))
else
  op_finish(A.cred, o, A.outcome)
end
return '{"ok":true}'
`,
);

export function dispatchEnd(
  kv: Kv,
  a: { now: number; cred: string; op: string; did: string; svc: string; outcome: 'accepted' | 'uncertain' | 'retryable' | 'failed' | 'gone'; backoffUntil: number | null },
): Promise<{ ok: boolean }> {
  return dispatchEndScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), backoff: K.pushBackoff(a.svc) }, { ...a, backoffUntil: a.backoffUntil ?? false });
}

export const reclaimScript = deviceScript(
  'dev-reclaim',
  `${STORE_LIB}
need_store()
return cjson.encode(reclaim(A.limit))
`,
  { reclaim: true },
);

export function reclaim(kv: Kv, now: number, limit = RECLAIM_BATCH): Promise<{ expired: number; ended: number; deleted: number }> {
  return reclaimScript.run(kv, { stats: statsKey(now) }, { now, limit });
}

import { manilaDay } from '../keys.ts';
export const statsKey = (now: number) => K.statsV2(manilaDay(now));
```

Move the `manilaDay` import to the top with the other imports when writing the file (it is shown last here only to keep `statsKey` next to its use).

- [ ] **Step 7: Watch the tests pass**

Run: `npm test -w @penge/server -- devices-store devices-lua`
Expected: PASS (the lint and compile tests now cover `dev-admit`, `dev-dispatch-begin`, `dev-dispatch-end` and `dev-reclaim`: they load every module in `src/devices/`).

Run with the throwaway Valkey: `DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- devices-store`
Expected: PASS on both targets.

- [ ] **Step 8: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review of Lua scripts run atomically on Valkey 8 (Lua 5.1): admission of notification-alert setups and rotations, the setup dispatch gate and its settlement, and reclamation. Check against the spec sections 'Setting up, with the ready check' steps 3–4, 'Bounds' and the units rule: every refusal writes nothing it should not, no path leaks or double-counts units, alerts or replacement candidates, a write never follows a check that can fail, and Lua 5.4 (tests) and 5.1 (Valkey) behave the same."). Then:

```bash
git add apps/server/src/devices apps/server/test/devices-store.test.ts apps/server/test/device-fixtures.ts apps/server/test/devices-lua.test.ts
git commit -m "Notification alert store: admission, the setup dispatch gate and reclamation, as atomic scripts"
```

---
### Task 7: The ready check's activation, change, renewal, read, turn off and "gone"

**Files:**
- Modify: `apps/server/src/devices/scripts-api.ts`
- Test: `apps/server/test/devices-activate.test.ts`

**Interfaces:**
- Consumes: Task 6's `STORE_LIB` (`alert_get`, `alert_delete`, `op_finish`, `rec`, `rec_add`, `is_ended`, `need_store`), record layout, `admit`, `seedAlert`, `statsKey`.
- Produces (scripts-api.ts):
  - `interface Prepared { sub: string; ep: string; fp: string; svc: string; offices?: string; group?: string; pace?: string }` — what Node unsealed from the operation and re-sealed for the alert.
  - `ready(kv, a: { now; cred; op; nh; prep: Prepared | false; newId: string; newInc: string; ownerMode: boolean; ownerTok: string; alertLimit: number }): Promise<{ result: ReadyResult | 'limited'; activation: Activation | null }>`
  - `change(kv, a: { now; cred; op; seq; digest; inc; baseRev; offices: string; group: string; pace: string; recordLimit: number }): Promise<{ result: 'active' | 'changed' | 'busy' | 'invalid' | 'full'; revision?: number }>`
  - `renew(kv, a: { now; cred }): Promise<{ state: 'active'; endsAt: number } | { state: 'ended' | 'none' }>`
  - `readMine(kv, a: { now; cred }): Promise<{ a: Record<string, string> | false; id: string | false; o: OpRecord | false; e: Record<string, string> | false }>`
  - `turnOff(kv, a: { now; cred }): Promise<{ deleted: true }>`
  - `markGone(kv, a: { now; id: string; inc: string; gen: number }): Promise<{ gone: 'deleted' | 'kept' | 'older' | 'none' }>`
  - Stats counted inside the scripts: `alerts_created`, `alerts_replaced` (via `alert_delete`), `alerts_ended`, `alerts_gone`, `alerts_off`, `alerts_changed`, `rotations_completed`, `changes_applied`, `changes_refused`, `renewals`, `acks`, `ops_<result>`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/devices-activate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { endpointHmac } from '../src/push/endpoint.ts';
import { admit, type AdmitInput, change, markGone, type Prepared, readMine, ready, renew, turnOff } from '../src/devices/scripts-api.ts';
import { ALERT_MS, ALERT_UNITS, credentialHash, digest, fingerprint, pushService, sealSetup, sealSubscription, SETUP_MS } from '../src/devices/store.ts';
import { choices, credential, opId, seedAlert, subscription } from './device-fixtures.ts';
import { keys } from './helpers.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const NH = 'h'.repeat(43);
type Kv = Parameters<typeof admit>[0];

function prepared(sub: ReturnType<typeof subscription>, c = choices()): Prepared {
  return { sub: sealSubscription(keys, sub), ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc: pushService(sub.endpoint), offices: c.siteIds.join(','), group: String(c.applicants), pace: c.pace };
}

async function start(kv: Kv, o: { cred?: string; seq?: number; sub?: ReturnType<typeof subscription>; kind?: 'setup' | 'rotate'; cap?: AdmitInput['cap']; now?: number; alertLimit?: number; tok?: string } = {}) {
  const cred = o.cred ?? credential();
  const sub = o.sub ?? subscription();
  const op = opId();
  const now = o.now ?? T0;
  const c = choices();
  const r = await admit(kv, {
    now, cred: credentialHash(cred), op, seq: o.seq ?? 1, kind: o.kind ?? 'setup', cap: o.cap ?? false, digest: digest(o.kind ?? 'setup', sub, c, o.cap || null),
    ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc: pushService(sub.endpoint), sealed: sealSetup(keys, { subscription: sub, choices: c, nonce: 'n'.repeat(43) }),
    nh: NH, tok: o.tok ?? '', exp: now + SETUP_MS, stored: [], alertLimit: o.alertLimit ?? 10, recordLimit: 1000,
  });
  return { cred, hash: credentialHash(cred), op, sub, r };
}

const ack = (kv: Kv, s: { hash: string; op: string; sub: ReturnType<typeof subscription> }, o: { now?: number; nh?: string; ownerMode?: boolean; ownerTok?: string; alertLimit?: number; prep?: Prepared | false } = {}) =>
  ready(kv, { now: o.now ?? T0 + 1000, cred: s.hash, op: s.op, nh: o.nh ?? NH, prep: o.prep ?? prepared(s.sub), newId: opId(), newInc: opId(), ownerMode: o.ownerMode ?? false, ownerTok: o.ownerTok ?? '', alertLimit: o.alertLimit ?? 10 });

for (const [name, make] of valkeyTargets()) {
  describe(`the ready check on ${name}`, () => {
    it('activates a first setup: a new alert, its indexes, an order, 180 days; the reservation becomes the alert', async () => {
      const kv = await make();
      const s = await start(kv);
      const r = await ack(kv, s);
      expect(r.result).toBe('active');
      const id = r.activation!.alertId;
      expect(r.activation).toMatchObject({ generation: 1, revision: 1 });
      const a = await kv.hGetAll(K.devAlert(id));
      expect(a).toMatchObject({ offices: '486', group: '1', pace: 'asap', cred: s.hash, op: s.op, gen: '1', rev: '1', fp: fingerprint(s.sub), end: String(T0 + 1000 + ALERT_MS), order: '1' });
      expect(await kv.get(K.devCred(s.hash))).toBe(id);
      expect(await kv.get(K.devEndpoint(endpointHmac(keys.index, s.sub.endpoint)))).toBe(id);
      expect(await kv.sMembers(K.devSite(486))).toEqual([`${id}:1`]);
      expect(await kv.hGetAll(K.devRecords)).toEqual({ units: String(ALERT_UNITS + 1), alerts: '1' });
      const op = await kv.hGetAll(K.devOp(s.hash));
      expect(op).toMatchObject({ result: 'active', rsv: '' });
      expect(op).not.toHaveProperty('sealed');
      expect(op).not.toHaveProperty('nh');
    });

    it('answers a recorded result again for free, an unknown op as unknown, a wrong nonce as invalid', async () => {
      const kv = await make();
      const s = await start(kv);
      expect((await ack(kv, s, { nh: 'x'.repeat(43) })).result).toBe('invalid');
      expect((await ack(kv, s)).result).toBe('active');
      for (let i = 0; i < 20; i++) expect((await ack(kv, s)).result).toBe('active');
      expect((await ack(kv, { ...s, op: opId() })).result).toBe('unknown');
    });

    it('counts at most 10 acknowledgements per operation', async () => {
      const kv = await make();
      const s = await start(kv);
      for (let i = 0; i < 10; i++) expect((await ack(kv, s, { nh: 'x'.repeat(43) })).result).toBe('invalid');
      expect((await ack(kv, s)).result).toBe('limited');
    });

    it('ends an expired setup as expired and releases its reservation', async () => {
      const kv = await make();
      const s = await start(kv);
      expect((await ack(kv, s, { now: T0 + SETUP_MS })).result).toBe('expired');
      expect(await kv.hGetAll(K.devRecords)).toEqual({ units: '1', alerts: '0' });
    });

    it('lets proof of an endpoint win: the other alert is deleted, without an end record, and charged as garbage', async () => {
      const kv = await make();
      const other = await seedAlert(kv, { now: T0 });
      const s = await start(kv, { sub: other.sub });
      const r = await ack(kv, s);
      expect(r.result).toBe('active');
      expect(await kv.hGetAll(K.devAlert(other.id))).toEqual({});
      expect(await kv.get(K.devCred(other.hash))).toBeNull();
      expect(await kv.hGetAll(K.devEnded(other.hash))).toEqual({});
      expect(await kv.hGetAll(K.devGarbage)).toEqual({ [other.id]: String(ALERT_UNITS) });
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ alerts: '1', repl: '0' });
    });

    it('needs a free alert slot for a replacement whose target ended meanwhile, else full', async () => {
      const kv = await make();
      const other = await seedAlert(kv, { now: T0, end: T0 + 500 });
      await seedAlert(kv, { now: T0 }); // the one slot left is taken
      const s = await start(kv, { sub: other.sub, alertLimit: 10 });
      expect((await ack(kv, s, { alertLimit: 1 })).result).toBe('full');
      expect(await kv.hGetAll(K.devEnded(other.hash))).toMatchObject({ reason: 'ended' }); // ended in passing
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ alerts: '1', repl: '0' });
    });

    it('answers changed when what the credential owns no longer matches', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const s = await start(kv, { cred: mine.cred, seq: 2, cap: { incarnation: inc, generation: 1, revision: 1 } });
      await turnOff(kv, { now: T0, cred: mine.hash });
      expect((await ack(kv, { ...s, hash: mine.hash })).result).toBe('unknown'); // turned off: the operation went too
      const t = await start(kv, { cred: mine.cred, seq: 3 });
      await seedAlert(kv, { now: T0, cred: mine.cred });
      expect((await ack(kv, t)).result).toBe('changed');
    });

    it('re-setup with a captured alert replaces choices (revision + 1) and keeps end, order and generation for the same subscription', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 - 1000, rev: 4, order: 7 });
      const before = await kv.hGetAll(K.devAlert(mine.id));
      const s = await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: before.inc!, generation: 1, revision: 4 } });
      const r = await ack(kv, s, { prep: prepared(mine.sub, choices({ siteIds: [693], applicants: 3, pace: 'hourly' })) });
      expect(r).toMatchObject({ result: 'active', activation: { alertId: mine.id, incarnation: before.inc, generation: 1, revision: 5 } });
      const after = await kv.hGetAll(K.devAlert(mine.id));
      expect(after).toMatchObject({ offices: '693', group: '3', pace: 'hourly', end: before.end, order: '7' });
      expect(await kv.sMembers(K.devSite(486))).toEqual([]);
      expect(await kv.sMembers(K.devSite(693))).toEqual([`${mine.id}:3`]);
    });

    it('rotates to a new subscription: generation + 1, endpoint index moved, choices as they are now', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const fresh = subscription();
      const s = await start(kv, { cred: mine.cred, seq: 2, sub: fresh, kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { offices: '693' } }]); // a change meanwhile (simplified)
      const prep = prepared(fresh);
      delete prep.offices;
      delete prep.group;
      delete prep.pace;
      const r = await ack(kv, s, { prep });
      expect(r.activation).toMatchObject({ alertId: mine.id, generation: 2 });
      expect(await kv.hGetAll(K.devAlert(mine.id))).toMatchObject({ gen: '2', fp: fingerprint(fresh), offices: '693' });
      expect(await kv.get(K.devEndpoint(mine.ep))).toBeNull();
      expect(await kv.get(K.devEndpoint(endpointHmac(keys.index, fresh.endpoint)))).toBe(mine.id);
    });

    it('in owner mode, refuses a new alert whose owner token no longer matches; maintenance needs none', async () => {
      const kv = await make();
      const s = await start(kv, { tok: 'old' });
      expect((await ack(kv, s, { ownerMode: true, ownerTok: 'new' })).result).toBe('owner-only');
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const m = await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: inc, generation: 1, revision: 1 } });
      expect((await ack(kv, m, { ownerMode: true, ownerTok: 'new' })).result).toBe('active');
    });

    it('answers expired for a rotation whose alert ended meanwhile, and ends the alert', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, end: T0 + 500 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const s = await start(kv, { cred: mine.cred, seq: 2, sub: subscription(), kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      expect((await ack(kv, s)).result).toBe('expired');
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'ended' });
    });
  });

  describe(`gone, change, renewal, read and turn off on ${name}`, () => {
    it('deletes an alert reported gone for its current generation, leaving the fingerprint; an older generation deletes nothing', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, gen: 2 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      expect(await markGone(kv, { now: T0, id: mine.id, inc, gen: 1 })).toEqual({ gone: 'older' });
      expect(await markGone(kv, { now: T0, id: mine.id, inc, gen: 2 })).toEqual({ gone: 'deleted' });
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'gone', fp: mine.fp });
    });

    it('keeps an alert whose old subscription is gone while a rotation is pending, and deletes it if the rotation fails', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: subscription(), kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      expect(await markGone(kv, { now: T0, id: mine.id, inc, gen: 1 })).toEqual({ gone: 'kept' });
      expect((await kv.hGetAll(K.devAlert(mine.id))).gone).toBe('1');
      expect((await readMine(kv, { now: T0 + SETUP_MS, cred: mine.hash })).a).toBe(false); // the rotation expired: deleted
      expect(await kv.hGetAll(K.devEnded(mine.hash))).toMatchObject({ reason: 'gone' });
    });

    it('applies a change at once when incarnation and revision are current, else answers changed', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, rev: 2 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      const base = { now: T0, cred: mine.hash, digest: 'd', inc, offices: '693', group: '2', pace: 'hourly', recordLimit: 100 };
      const op = opId();
      expect(await change(kv, { ...base, op, seq: 2, baseRev: 2 })).toEqual({ result: 'active', revision: 3 });
      expect(await change(kv, { ...base, op, seq: 2, baseRev: 2 })).toEqual({ result: 'active', revision: 3 }); // a repeat
      expect(await change(kv, { ...base, op: opId(), seq: 3, baseRev: 2 })).toEqual({ result: 'changed' });
      expect(await kv.sMembers(K.devSite(693))).toEqual([`${mine.id}:2`]);
    });

    it('never recreates part of an alert that finishing an expired rotation deleted', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: subscription(), kind: 'rotate', cap: { incarnation: inc, generation: 1 } });
      await kv.write([{ op: 'hSet', key: K.devAlert(mine.id), fields: { gone: '1' } }]);
      const r = await change(kv, { now: T0 + SETUP_MS + 1, cred: mine.hash, op: opId(), seq: 3, digest: 'd', inc, baseRev: 1, offices: '693', group: '1', pace: 'asap', recordLimit: 100 });
      expect(r).toEqual({ result: 'changed' });
      expect(await kv.hGetAll(K.devAlert(mine.id))).toEqual({});
      expect(await kv.sMembers(K.devSite(693))).toEqual([]);
    });

    it('waits behind a setup in progress', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: inc, generation: 1, revision: 1 } });
      expect(await change(kv, { now: T0, cred: mine.hash, op: opId(), seq: 3, digest: 'd', inc, baseRev: 1, offices: '693', group: '1', pace: 'asap', recordLimit: 100 })).toEqual({ result: 'busy' });
    });

    it('renews to 180 days from now, never earlier than the current end', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, end: T0 + 200 * 86_400_000 });
      expect(await renew(kv, { now: T0, cred: mine.hash })).toEqual({ state: 'active', endsAt: T0 + 200 * 86_400_000 });
      expect(await renew(kv, { now: T0 + 30 * 86_400_000, cred: mine.hash })).toEqual({ state: 'active', endsAt: T0 + 210 * 86_400_000 });
      expect(await renew(kv, { now: T0, cred: credentialHash(credential()) })).toEqual({ state: 'none' });
    });

    it('reads an ended alert as ended, ending it in the same step', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0, end: T0 + 10 });
      const r = await readMine(kv, { now: T0 + 10, cred: mine.hash });
      expect(r.a).toBe(false);
      expect(r.e).toMatchObject({ reason: 'ended', at: String(T0 + 10) });
    });

    it('turns off: alert, indexes, operation (with its reservation) and end record go; delivery units stay as garbage', async () => {
      const kv = await make();
      const mine = await seedAlert(kv, { now: T0 });
      const inc = (await kv.hGetAll(K.devAlert(mine.id))).inc!;
      await start(kv, { cred: mine.cred, seq: 2, sub: mine.sub, cap: { incarnation: inc, generation: 1, revision: 1 } });
      expect(await turnOff(kv, { now: T0, cred: mine.hash })).toEqual({ deleted: true });
      const exists = (key: string) => kv.script({ name: 'exists', lua: "#!lua\nreturn tostring(redis.call('EXISTS', KEYS[1]))" }, [key], []);
      for (const key of [K.devAlert(mine.id), K.devCred(mine.hash), K.devOp(mine.hash), K.devEnded(mine.hash)]) expect([key, await exists(key)]).toEqual([key, '0']);
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ units: String(ALERT_UNITS), alerts: '0' });
      expect(await turnOff(kv, { now: T0, cred: mine.hash })).toEqual({ deleted: true });
    });
  });
}
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- devices-activate`
Expected: FAIL: `ready` (and the rest) is not exported.

- [ ] **Step 3: Write the scripts**

Append to `apps/server/src/devices/scripts-api.ts`:

```ts
/** The subscription and choices Node unsealed from the operation, the subscription sealed again for the alert. */
export interface Prepared {
  sub: string;
  ep: string;
  fp: string;
  svc: string;
  offices?: string;
  group?: string;
  pace?: string;
}

const ACTIVATE_LIB = `
local function index_sites(id, offices, group)
  for office in string.gmatch(offices, '[^,]+') do redis.call('SADD', KEY.site .. office, id .. ':' .. group) end
end
local function unindex_sites(id, offices, group)
  for office in string.gmatch(offices, '[^,]+') do redis.call('SREM', KEY.site .. office, id .. ':' .. group) end
end
-- The endpoint now belongs to this alert: any other alert holding it is deleted (proof of the endpoint wins).
local function take_endpoint(id, epKey, epOwner, x)
  if x then
    local why = 'replaced'
    if is_ended(x) then why = 'ended' end
    alert_delete(epOwner, x, why)
  end
  redis.call('SET', epKey, id)
end
`;

export const readyScript = deviceScript(
  'dev-ready',
  `${STORE_LIB}${ACTIVATE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.endpoint, 'string') need(KEY.order, 'string') need_store()
local cred = A.cred
local o = hgetall(K.op)
if o.op == nil or o.op ~= A.op then return cjson.encode({ result = 'unknown' }) end
if o.result ~= '' then
  local act = false
  if o.act ~= '' then act = cjson.decode(o.act) end
  return cjson.encode({ result = o.result, activation = act })
end
if o.kind == 'change' then return cjson.encode({ result = 'invalid' }) end
if N(o.acks) >= MAX_ACKS then return cjson.encode({ result = 'limited' }) end
-- Read everything before the first write.
local alertId = redis.call('GET', K.cred) or nil
local a = alert_get(alertId)
local epOwner = redis.call('GET', K.endpoint) or nil
local x = nil
if epOwner and epOwner ~= alertId then x = alert_get(epOwner) end
alert_check(alertId, a) alert_check(epOwner, x) op_check(cred, o)
-- Where activation will write: the new offices' index sets, and the order counter.
if A.prep and A.prep.offices then for office in string.gmatch(A.prep.offices, '[^,]+') do need(KEY.site .. office, 'set') end end
counter(KEY.order)
local capOk, capValue = pcall(cjson.decode, o.cap ~= '' and o.cap or '0')
if o.cap ~= '' and (not capOk or type(capValue) ~= 'table') then error('op cap') end
redis.call('HINCRBY', K.op, 'acks', 1)
count('acks')
if o.nh ~= A.nh or not A.prep or A.prep.fp ~= o.fp or A.prep.ep ~= o.ep then return cjson.encode({ result = 'invalid' }) end
local function finish(result) op_finish(cred, o, result) return cjson.encode({ result = result }) end
if N(o.exp) <= NOW then return finish('expired') end
local cap = false
if o.cap ~= '' then cap = capValue end
if a and is_ended(a) then
  alert_delete(alertId, a, 'ended')
  a = nil
  if cap then return finish('expired') end
end
if o.kind == 'setup' and not cap then
  if a then return finish('changed') end
elseif o.kind == 'setup' then
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation or N(a.rev) ~= cap.revision then return finish('changed') end
else
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation then return finish('changed') end
end
local p = A.prep
local activation
if not cap then
  if A.ownerMode and o.tok ~= A.ownerTok then return finish('owner-only') end
  -- A target that ended meanwhile is ended now, so its slot is free for the check below.
  if x and is_ended(x) then
    alert_delete(epOwner, x, 'ended')
    x = nil
  end
  if o.rsv == 'repl' then
    -- Replacing a live alert adds none; if the target is gone, this creates one, which needs a free slot now.
    if not x and rec('alerts') + 1 > A.alertLimit then return finish('full') end
    rec_add('alerts', 1)
  end
  local id = A.newId
  local order = redis.call('INCR', KEY.order)
  take_endpoint(id, K.endpoint, epOwner, x)
  redis.call('HSET', KEY.alert .. id, 'sub', p.sub, 'offices', p.offices, 'group', p.group, 'pace', p.pace, 'created', I(NOW),
    'order', I(order), 'cred', cred, 'op', o.op, 'inc', A.newInc, 'gen', '1', 'rev', '1', 'fp', p.fp, 'ep', p.ep, 'svc', p.svc,
    'end', I(NOW + ALERT_MS), 'renewed', I(NOW), 'seq', o.maxseq)
  redis.call('SET', K.cred, id)
  index_sites(id, p.offices, p.group)
  redis.call('ZADD', KEY.ends, NOW + ALERT_MS, id)
  count('alerts_created')
  activation = { alertId = id, incarnation = A.newInc, generation = 1, revision = 1 }
else
  local id = alertId
  local rev = N(a.rev)
  local gen = N(a.gen)
  if o.kind == 'setup' then
    unindex_sites(id, a.offices, a.group)
    rev = rev + 1
    redis.call('HSET', KEY.alert .. id, 'offices', p.offices, 'group', p.group, 'pace', p.pace, 'rev', I(rev))
    index_sites(id, p.offices, p.group)
    count('alerts_changed')
  end
  if p.fp ~= a.fp then
    gen = gen + 1
    if redis.call('GET', KEY.endpoint .. a.ep) == id then redis.call('DEL', KEY.endpoint .. a.ep) end
    take_endpoint(id, K.endpoint, epOwner, x)
    redis.call('HSET', KEY.alert .. id, 'sub', p.sub, 'fp', p.fp, 'ep', p.ep, 'svc', p.svc, 'gen', I(gen))
  end
  redis.call('HDEL', KEY.alert .. id, 'gone')
  if o.kind == 'rotate' then count('rotations_completed') end
  activation = { alertId = id, incarnation = a.inc, generation = gen, revision = rev }
end
op_finish(cred, o, 'active', activation)
return cjson.encode({ result = 'active', activation = activation })
`,
);

export async function ready(
  kv: Kv,
  a: { now: number; cred: string; op: string; nh: string; prep: Prepared | false; newId: string; newInc: string; ownerMode: boolean; ownerTok: string; alertLimit: number },
): Promise<{ result: ReadyResult | 'limited'; activation: Activation | null }> {
  // Without a prepared subscription (an op with nothing sealed), the endpoint key is a placeholder no alert uses.
  const ep = a.prep ? a.prep.ep : '-';
  const r = await readyScript.run<{ result: ReadyResult | 'limited'; activation?: Activation | false }>(
    kv,
    { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), endpoint: K.devEndpoint(ep) },
    { ...a },
  );
  return { result: r.result, activation: r.activation || null };
}

export const changeScript = deviceScript(
  'dev-change',
  `${STORE_LIB}${ACTIVATE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need_store()
local cred = A.cred
local o = hgetall(K.op)
local alertId = redis.call('GET', K.cred) or nil
local a = alert_get(alertId)
alert_check(alertId, a) op_check(cred, o)
for office in string.gmatch(A.offices, '[^,]+') do need(KEY.site .. office, 'set') end
if o.op == A.op then
  if o.kind == 'change' and o.digest == A.digest then
    if o.result == 'active' then return cjson.encode({ result = 'active', revision = cjson.decode(o.act).revision }) end
    return cjson.encode({ result = o.result })
  end
  return cjson.encode({ result = 'invalid' })
end
local highest = tonumber(o.maxseq or '0') or 0
if a then highest = math.max(highest, tonumber(a.seq or '0') or 0) end
if A.seq <= highest then return cjson.encode({ result = 'invalid' }) end
if o.op ~= nil and o.result == '' and N(o.exp) > NOW then return cjson.encode({ result = 'busy' }) end
local units = 0
if o.op == nil then units = 1 end
if rec('units') + units > A.recordLimit then return cjson.encode({ result = 'full' }) end
if o.op ~= nil and o.result == '' then
  op_finish(cred, o, 'expired')
  -- Finishing an expired rotation can delete the alert: read it again, never write to a deleted one.
  alertId = redis.call('GET', K.cred) or nil
  a = alert_get(alertId)
end
if a and is_ended(a) then alert_delete(alertId, a, 'ended') a = nil end
local result = 'changed'
local act = ''
local rev = 0
if a and a.inc == A.inc and N(a.rev) == A.baseRev then
  rev = N(a.rev) + 1
  unindex_sites(alertId, a.offices, a.group)
  redis.call('HSET', KEY.alert .. alertId, 'offices', A.offices, 'group', A.group, 'pace', A.pace, 'rev', I(rev), 'seq', I(math.max(highest, A.seq)))
  index_sites(alertId, A.offices, A.group)
  result = 'active'
  act = cjson.encode({ alertId = alertId, incarnation = a.inc, generation = N(a.gen), revision = rev })
  count('changes_applied')
else
  count('changes_refused')
end
count('ops_started')
count('ops_' .. result)
rec_add('units', units)
redis.call('DEL', K.op)
redis.call('HSET', K.op, 'op', A.op, 'seq', I(A.seq), 'maxseq', I(math.max(highest, A.seq)), 'kind', 'change', 'digest', A.digest,
  'cap', '', 'alert', alertId or '', 'rsv', '', 'other', '', 'exp', I(NOW), 'dsp', '', 'did', '', 'dspAt', '', 'retry', '', 'why', '',
  'result', result, 'act', act, 'done', I(NOW), 'ep', '', 'fp', '', 'svc', '', 'tok', '', 'acks', '0', 'started', I(NOW))
redis.call('ZREM', KEY.ops, cred)
redis.call('ZADD', KEY.deadlines, NOW + RESULT_KEEP_MS, 'op|' .. cred)
if result == 'active' then return cjson.encode({ result = 'active', revision = rev }) end
return cjson.encode({ result = 'changed' })
`,
);

export function change(
  kv: Kv,
  a: { now: number; cred: string; op: string; seq: number; digest: string; inc: string; baseRev: number; offices: string; group: string; pace: string; recordLimit: number },
): Promise<{ result: 'active' | 'changed' | 'busy' | 'invalid' | 'full'; revision?: number }> {
  return changeScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred) }, { ...a });
}

export const renewScript = deviceScript(
  'dev-renew',
  `${STORE_LIB}
need(K.cred, 'string') need_store()
local id = redis.call('GET', K.cred) or nil
local a = alert_get(id)
alert_check(id, a)
if not a then return '{"state":"none"}' end
if is_ended(a) then alert_delete(id, a, 'ended') return '{"state":"ended"}' end
local e = math.max(N(a['end']), NOW + ALERT_MS)
redis.call('HSET', KEY.alert .. id, 'end', I(e), 'renewed', I(NOW))
redis.call('ZADD', KEY.ends, e, id)
count('renewals')
return cjson.encode({ state = 'active', endsAt = e })
`,
  { reclaim: true },
);

export function renew(kv: Kv, a: { now: number; cred: string }): Promise<{ state: 'active'; endsAt: number } | { state: 'ended' | 'none' }> {
  return renewScript.run(kv, { stats: statsKey(a.now), cred: K.devCred(a.cred) }, { ...a });
}

export const readScript = deviceScript(
  'dev-read',
  `${STORE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.ended, 'hash') need_store()
local o = hgetall(K.op)
local id = redis.call('GET', K.cred) or nil
local a = alert_get(id)
alert_check(id, a) op_check(A.cred, o)
if o.op ~= nil and o.result == '' and N(o.exp) <= NOW then op_finish(A.cred, o, 'expired') o = hgetall(K.op) end
a = alert_get(id)
if a and is_ended(a) then alert_delete(id, a, 'ended') a = nil end
local e = hgetall(K.ended)
local out = { a = false, id = false, o = false, e = false }
if a then a.sub = nil out.a = a out.id = id end
if o.op ~= nil then o.sealed = nil o.nh = nil out.o = o end
if e.reason ~= nil then out.e = e end
return cjson.encode(out)
`,
  { reclaim: true },
);

export function readMine(kv: Kv, a: { now: number; cred: string }): Promise<{ a: Record<string, string> | false; id: string | false; o: OpRecord | false; e: Record<string, string> | false }> {
  return readScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), ended: K.devEnded(a.cred) }, { ...a });
}

export const turnOffScript = deviceScript(
  'dev-turn-off',
  `${STORE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.ended, 'hash') need_store()
local cred = A.cred
local id = redis.call('GET', K.cred) or nil
local a = alert_get(id)
local o = hgetall(K.op)
alert_check(id, a) op_check(cred, o)
if a then alert_delete(id, a, 'off') end
if o.op ~= nil then
  if o.result == '' then op_finish(cred, o, 'off') end
  redis.call('DEL', K.op)
  rec_add('units', -1)
  redis.call('ZREM', KEY.deadlines, 'op|' .. cred)
end
if redis.call('EXISTS', K.ended) == 1 then
  redis.call('DEL', K.ended)
  rec_add('units', -1)
  redis.call('ZREM', KEY.deadlines, 'ended|' .. cred)
end
return '{"deleted":true}'
`,
  { reclaim: true },
);

export function turnOff(kv: Kv, a: { now: number; cred: string }): Promise<{ deleted: true }> {
  return turnOffScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), ended: K.devEnded(a.cred) }, { ...a });
}

export const goneScript = deviceScript(
  'dev-gone',
  `${STORE_LIB}
need_store()
local a = alert_get(A.id)
alert_check(A.id, a)
if not a or a.inc ~= A.inc then return '{"gone":"none"}' end
if N(a.gen) ~= A.gen then return '{"gone":"older"}' end
need(KEY.op .. a.cred, 'hash')
local o = hgetall(KEY.op .. a.cred)
op_check(a.cred, o)
if o.op ~= nil and o.result == '' and o.kind == 'rotate' and o.alert == A.id and N(o.exp) > NOW then
  redis.call('HSET', KEY.alert .. A.id, 'gone', I(A.gen))
  count('gone_kept')
  return '{"gone":"kept"}'
end
alert_delete(A.id, a, 'gone')
return '{"gone":"deleted"}'
`,
  { reclaim: true },
);

/** A push service said the alert's subscription no longer exists (spec: "Gone" and "When the subscription changes"). */
export function markGone(kv: Kv, a: { now: number; id: string; inc: string; gen: number }): Promise<{ gone: 'deleted' | 'kept' | 'older' | 'none' }> {
  return goneScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}
```

Add `import type { Activation, ReadyResult } from '@penge/contracts';` at the top.

`op_finish(cred, o, 'off')` records the result `off` just before the record is deleted, and counts `ops_off` (a turned-off operation); it is never answered to anyone.

- [ ] **Step 4: Watch them pass**

Run: `npm test -w @penge/server -- devices-activate devices-store devices-lua`
Expected: PASS. (Add `await import('../src/devices/scripts-api.ts');` already done in Task 6 covers the new scripts in the lint test.)

Run with the throwaway Valkey: `DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- devices-activate`
Expected: PASS on both targets.

- [ ] **Step 5: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review of the Lua scripts for the ready check's activation (one alert per endpoint, replacement, re-setup, rotation, owner token), change, renewal, read, turn off and 'gone', against the spec sections 'Setting up' step 6, 'Activation and the one-alert-per-endpoint rule', 'Changing, testing, turning off', 'When the subscription changes' and 'Lifetime and clean-up'. Look for unit or alert-count leaks, an index left pointing at a deleted alert, an activation the device's current operation did not prove, and anything that changes state on a replayed or unknown acknowledgement."). Then:

```bash
git add apps/server/src/devices/scripts-api.ts apps/server/test/devices-activate.test.ts
git commit -m "The ready check's activation, change, renewal, read, turn off and gone, as atomic scripts"
```

---
### Task 8: The push transport: a structured result, a total deadline, a send limit

**Files:**
- Create: `apps/server/src/devices/transport.ts`
- Delete: `apps/server/src/push/errors.ts`, and the `'push errors in logs'` block of `apps/server/test/push-endpoint.test.ts` (with its `classifyPushError` import)
- Test: `apps/server/test/devices-transport.test.ts`

**Interfaces:**
- Consumes: `web-push`'s `generateRequestDetails` (3.6.7: `(subscription, payload, { vapidDetails: { subject, publicKey, privateKey }, TTL, urgency })` → `{ method, headers, body: Buffer, endpoint }`).
- Produces:

```ts
export type SendResult =
  | { kind: 'accepted'; status: 201 }
  | { kind: 'gone'; status: 404 | 410 }
  | { kind: 'throttled'; status: 429; retryAfterMs: number }
  | { kind: 'refused'; status: number | null }
  | { kind: 'rejected'; status: 400 | 401 | 403 }
  | { kind: 'bug'; status: number | null }
  | { kind: 'uncertain'; status: null };
export interface Transport { send(sub: PushSubscriptionInput, payload: string, opts: { ttl: number; urgency: 'high' | 'normal' }): Promise<SendResult> }
export function webPushTransport(vapid: { publicKey: string; privateKey: string; subject: string }, o?: { fetch?: typeof fetch; deadlineMs?: number; now?: () => number }): Transport;
export const SEND_DEADLINE_MS = 10_000;
export const BACKOFF_MAX_MS = 3_600_000;
export const BACKOFF_DEFAULT_MS = 600_000;
export class SendSlots { constructor(max: number); take(): Promise<() => void>; get busy(): number }
export const CHECKER_SLOTS = 8;
export const API_SLOTS = 4;
/** What may reach a log about a send: never the endpoint, keys, payload, headers or body. */
export function loggable(r: SendResult): { status: number | null; category: SendResult['kind'] };
```

- [ ] **Step 1: Write the failing tests**

`apps/server/test/devices-transport.test.ts`:

```ts
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { line } from '../src/log.ts';
import { loggable, SendSlots, webPushTransport } from '../src/devices/transport.ts';
import { subscription } from './device-fixtures.ts';

const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:alerts@example.com' };
const answer = (status: number, headers: Record<string, string> = {}) => async () => new Response('{"reason":"secret body"}', { status, headers });
const send = (f: typeof fetch, deadlineMs = 10_000) => webPushTransport(vapid, { fetch: f, deadlineMs, now: () => Date.parse('2026-10-06T02:00:00Z') }).send(subscription(), '{"v":1}', { ttl: 1800, urgency: 'high' });

describe('the push transport', () => {
  it('signs and encrypts with web-push and posts it once, without following redirects', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await send(async (url, init) => {
      seen = { url: String(url), init: init! };
      return new Response(null, { status: 201 });
    });
    expect(r).toEqual({ kind: 'accepted', status: 201 });
    expect(seen!.url).toMatch(/^https:\/\/fcm\.googleapis\.com\//);
    const h = new Headers(seen!.init.headers);
    expect([h.get('TTL'), h.get('Urgency'), h.get('Content-Encoding')]).toEqual(['1800', 'high', 'aes128gcm']);
    expect(h.get('Authorization')).toMatch(/^vapid t=/);
    expect(seen!.init.redirect).toBe('manual');
  });

  it.each([
    [404, { kind: 'gone', status: 404 }],
    [410, { kind: 'gone', status: 410 }],
    [400, { kind: 'rejected', status: 400 }],
    [401, { kind: 'rejected', status: 401 }],
    [403, { kind: 'rejected', status: 403 }],
    [413, { kind: 'bug', status: 413 }],
    [500, { kind: 'refused', status: 500 }],
    [503, { kind: 'refused', status: 503 }],
    [302, { kind: 'refused', status: 302 }],
    [200, { kind: 'refused', status: 200 }],
    [202, { kind: 'refused', status: 202 }],
    [418, { kind: 'refused', status: 418 }],
  ])('maps %i', async (status, expected) => {
    expect(await send(answer(status))).toEqual(expected);
  });

  it('reads Retry-After for a 429 in seconds or as a date, at most an hour, 10 minutes when absent or unreadable', async () => {
    expect(await send(answer(429, { 'retry-after': '120' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 120_000 });
    expect(await send(answer(429, { 'retry-after': 'Tue, 06 Oct 2026 02:05:00 GMT' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 300_000 });
    expect(await send(answer(429, { 'retry-after': '999999' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 3_600_000 });
    expect(await send(answer(429))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 600_000 });
    expect(await send(answer(429, { 'retry-after': 'soon' }))).toEqual({ kind: 'throttled', status: 429, retryAfterMs: 600_000 });
  });

  it('calls a failure before the request left "refused", and one after it may have left "uncertain"', async () => {
    const fail = (code: string) => async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    };
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']) {
      expect(await send(fail(code))).toEqual({ kind: 'refused', status: null });
    }
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'something new']) expect(await send(fail(code))).toEqual({ kind: 'uncertain', status: null });
  });

  it('calls a fetch that throws before sending a bug, never uncertain', async () => {
    const throwsAtOnce = (() => {
      throw new TypeError('invalid header');
    }) as unknown as typeof fetch;
    expect(await send(throwsAtOnce)).toEqual({ kind: 'bug', status: null });
  });

  it('aborts a send at its total deadline, as uncertain', async () => {
    const hang: typeof fetch = (_, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
    expect(await send(hang, 50)).toEqual({ kind: 'uncertain', status: null });
  });

  it('calls a payload or key that cannot be encrypted a bug, without sending', async () => {
    let called = false;
    const t = webPushTransport(vapid, { fetch: async () => ((called = true), new Response(null, { status: 201 })) });
    const broken = { ...subscription(), p256dh: 'AAAA' };
    expect(await t.send(broken, '{}', { ttl: 1800, urgency: 'high' })).toEqual({ kind: 'bug', status: null });
    expect(called).toBe(false);
  });

  it('logs only a status and a category', () => {
    const text = line('warn', 'push not accepted', { push: loggable({ kind: 'gone', status: 410 }), alert: 'a1' });
    expect(JSON.parse(text)).toMatchObject({ push: { status: 410, category: 'gone' }, alert: 'a1' });
    expect(text).not.toMatch(/fcm|secret|vapid/i);
  });
});

describe('send slots', () => {
  it('lets at most n sends run, and hands a freed slot to the next waiter', async () => {
    const slots = new SendSlots(2);
    const a = await slots.take();
    const b = await slots.take();
    let third = false;
    const c = slots.take().then((release) => ((third = true), release));
    await Promise.resolve();
    expect([slots.busy, third]).toEqual([2, false]);
    a();
    (await c)();
    expect(third).toBe(true);
    b();
    expect(slots.busy).toBe(0);
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- devices-transport`
Expected: FAIL: `Cannot find module '../src/devices/transport.ts'`.

- [ ] **Step 3: Write the transport**

`apps/server/src/devices/transport.ts`:

```ts
// Sends one push and says exactly what happened (spec: "Claims and sending", the transport's results). web-push
// signs and encrypts; fetch posts, once, with a total deadline that aborts the request. Nothing here logs: callers
// log loggable(result) with an internal id, never the endpoint, keys, payload or the push service's answer.
import type { PushSubscriptionInput } from '@penge/contracts';
import webpush from 'web-push';

export const SEND_DEADLINE_MS = 10_000;
export const BACKOFF_MAX_MS = 3_600_000;
export const BACKOFF_DEFAULT_MS = 600_000;
export const CHECKER_SLOTS = 8;
export const API_SLOTS = 4;

export type SendResult =
  | { kind: 'accepted'; status: 201 }
  | { kind: 'gone'; status: 404 | 410 }
  | { kind: 'throttled'; status: 429; retryAfterMs: number }
  | { kind: 'refused'; status: number | null }
  | { kind: 'rejected'; status: 400 | 401 | 403 }
  | { kind: 'bug'; status: number | null }
  | { kind: 'uncertain'; status: null };

export interface Transport {
  send(sub: PushSubscriptionInput, payload: string, opts: { ttl: number; urgency: 'high' | 'normal' }): Promise<SendResult>;
}

/** Errors that mean the request never reached the push service. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function retryAfter(raw: string | null, now: number): number {
  if (!raw) return BACKOFF_DEFAULT_MS;
  const seconds = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) * 1000 : Date.parse(raw) - now;
  if (!Number.isFinite(seconds) || seconds <= 0) return BACKOFF_DEFAULT_MS;
  return Math.min(seconds, BACKOFF_MAX_MS);
}

export function webPushTransport(
  vapid: { publicKey: string; privateKey: string; subject: string },
  o: { fetch?: typeof fetch; deadlineMs?: number; now?: () => number } = {},
): Transport {
  const post = o.fetch ?? fetch;
  const deadlineMs = o.deadlineMs ?? SEND_DEADLINE_MS;
  const now = o.now ?? Date.now;
  return {
    async send(sub, payload, opts) {
      let details: { method: string; headers: Record<string, string | number>; body: Buffer | null; endpoint: string };
      try {
        details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          vapidDetails: vapid,
          TTL: opts.ttl,
          urgency: opts.urgency,
        }) as typeof details;
      } catch {
        return { kind: 'bug', status: null };
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(details.headers)) if (k.toLowerCase() !== 'content-length') headers.set(k, String(v));
      let sending: Promise<Response>;
      try {
        sending = post(details.endpoint, { method: 'POST', headers, body: details.body, redirect: 'manual', signal: AbortSignal.timeout(deadlineMs) });
      } catch {
        // Thrown before any request was made (a header or option fetch refused): our bug, never sent.
        return { kind: 'bug', status: null };
      }
      let res: Response;
      try {
        res = await sending;
      } catch (err) {
        const code = ((err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code) as string | undefined;
        if (typeof code === 'string' && NEVER_SENT.has(code)) return { kind: 'refused', status: null };
        return { kind: 'uncertain', status: null };
      }
      // The answer's body is never read: it is the push service's, and may echo what was sent.
      await res.body?.cancel().catch(() => {});
      const s = res.status;
      // The push protocol's acceptance is 201 Created; any other status is unexpected, so refused (spec: settlement table).
      if (s === 201) return { kind: 'accepted', status: 201 };
      if (s === 404 || s === 410) return { kind: 'gone', status: s };
      if (s === 429) return { kind: 'throttled', status: 429, retryAfterMs: retryAfter(res.headers.get('retry-after'), now()) };
      if (s === 400 || s === 401 || s === 403) return { kind: 'rejected', status: s };
      if (s === 413) return { kind: 'bug', status: 413 };
      return { kind: 'refused', status: s };
    },
  };
}

/** At most `max` sends at once in this process; a slot is held until its request has really ended. */
export class SendSlots {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  get busy() {
    return this.running;
  }
  async take(): Promise<() => void> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    else this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    };
  }
}

export function loggable(r: SendResult): { status: number | null; category: SendResult['kind'] } {
  return { status: r.status, category: r.kind };
}
```

`webpush.generateRequestDetails`'s type in `@types/web-push` returns `RequestDetails`; the cast to the local shape keeps the header values' union. If `@types/web-push` lacks `urgency` in `RequestOptions`, it is `'very-low' | 'low' | 'normal' | 'high'` there already (check `node_modules/@types/web-push/index.d.ts`).

Remove `apps/server/src/push/errors.ts` and the `'push errors in logs'` block (and the `classifyPushError` import) from `apps/server/test/push-endpoint.test.ts`.

- [ ] **Step 4: Watch them pass**

Run: `npm test -w @penge/server -- devices-transport push-endpoint`
Expected: PASS.

- [ ] **Step 5: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review: a Web Push transport over web-push's generateRequestDetails and fetch, with a structured result per the spec's settlement table, a total 10 s deadline that aborts the request, a Retry-After clamp and a per-process slot limit. Find a result that could make a caller send twice, call a delivered push refused, follow a redirect, read or log the push service's body or the endpoint, or hold a slot forever."). Then:

```bash
git add -A apps/server/src/devices/transport.ts apps/server/src/push apps/server/test/devices-transport.test.ts apps/server/test/push-endpoint.test.ts
git commit -m "Push transport with a structured result, a total deadline and a send limit"
```

---
### Task 9: The device-alert routes

**Files:**
- Create: `apps/server/src/devices/api.ts`
- Modify: `apps/server/src/api.ts` (mount the routes; `ApiDeps` gains `devices` and `pushTransport`), `apps/server/src/server.ts` (wire the transport and limits), `apps/server/src/push/payload.ts` (the setup payload), `apps/server/src/devices/scripts-api.ts` (`setBackoff`)
- Test: `apps/server/test/devices-api.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 5–8 (`charge`, `DEVICE_LIMITS`, `ingressBucket`, `rateKeys`, the contracts' guards, `admit`, `dispatchBegin`, `dispatchEnd`, `ready`, `change`, `renew`, `readMine`, `turnOff`, `markGone`, `reclaim`, `opView`, `Transport`, `SendSlots`, `loggable`).
- Produces:
  - `mountDeviceRoutes(app: Hono, d: DeviceRouteDeps): void` with `DeviceRouteDeps = { kv; keys; log; now: () => number; push: PushConfig; limits: { alertLimit: number; recordLimit: number }; transport: Transport | null; slots: SendSlots; ipOf: (c: Context) => string; sites: () => Promise<SiteSummary[] | null>; origins: string[] }`
  - `ApiDeps.devices?: { alertLimit: number; recordLimit: number }` (default `{ alertLimit: 0, recordLimit: 0 }`: no notification alerts) and `ApiDeps.pushTransport?: Transport`; `ApiDeps.devOrigins?: string[]` (the local stack's extra origins).
  - `setupPayload(a: { op: string; nonce: string; expiresAt: number; offices: string[] }): string` (payload.ts)
  - `setBackoff(kv, svc: string, until: number): Promise<void>` (scripts-api.ts): sets `pp:push:backoff:<svc>` only if later.
  - Routes and answers exactly as the contracts in Task 5; HTTP status: 200 for every answer the scripts give, except `ChangeAnswer` `changed`/`busy` (409), `invalid` bodies (400), a missing or malformed credential (401), a missing or foreign `Origin` on a change (403), `limited` (429, `{ error, code: 'limited' }`).

- [ ] **Step 1: Write the failing tests**

`apps/server/test/devices-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import type { PushConfig } from '../src/config.ts';
import { K } from '../src/keys.ts';
import type { SendResult, Transport } from '../src/devices/transport.ts';
import { credentialHash } from '../src/devices/store.ts';
import { credential, opId } from './device-fixtures.ts';
import { clock, fcmSubscription, FakeMailer, keys, MemoryKv, recordingLog } from './helpers.ts';

const ORIGIN = 'https://penge.example';
const SITES = [{ id: 486, name: 'Antipolo' }, { id: 693, name: 'Pampanga' }];
const VAPID = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), subject: 'mailto:alerts@example.com' };

class FakeTransport implements Transport {
  sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
  next: SendResult[] = [];
  async send(sub: { endpoint: string }, payload: string) {
    this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
    return this.next.shift() ?? { kind: 'accepted' as const, status: 201 };
  }
}

async function world(o: { mode?: PushConfig['mode']; ownerToken?: string; limits?: { alertLimit: number; recordLimit: number } } = {}) {
  const t = clock(Date.parse('2026-10-06T02:00:00Z'));
  const kv = new MemoryKv(t.now);
  await kv.set(K.sites, JSON.stringify(SITES));
  const transport = new FakeTransport();
  const { log, lines } = recordingLog();
  let ip = '203.0.113.7';
  const push: PushConfig = { mode: o.mode ?? 'live', vapid: VAPID, ownerToken: o.ownerToken ?? null };
  const app = createApi({
    kv, keys, mailer: new FakeMailer(), log, publicBaseUrl: ORIGIN, now: t.now, clientIp: () => ip, push,
    devices: o.limits ?? { alertLimit: 10, recordLimit: 100 }, pushTransport: transport,
  });
  const cred = credential();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, who = cred) => {
    const res = await app.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }), authorization: `Device ${who}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, any>, text };
  };
  return { t, kv, transport, lines, app, cred, call, setIp: (v: string) => (ip = v) };
}

const choices = { siteIds: [486], applicants: 2, pace: 'asap' };
const setupBody = (o: { seq?: number; captured?: unknown; sub?: unknown } = {}) => ({ op: opId(), seq: o.seq ?? 1, subscription: o.sub ?? fcmSubscription(), choices, captured: o.captured ?? null });

describe('notification alerts through the API', () => {
  it('set up, prove, read, renew, change, test and turn off', async () => {
    const w = await world();
    const body = setupBody();
    const setup = await w.call('POST', '/api/device-alerts', body);
    expect(setup.status).toBe(200);
    expect(setup.body).toMatchObject({ outcome: 'pending', operation: { op: body.op, dispatch: 'accepted', result: null } });
    const push = w.transport.sent[0]!.payload;
    expect(push).toMatchObject({ v: 1, title: 'Setting up PengePassportPH notifications', body: 'Antipolo', tag: `setup-${body.op}`, url: {}, kind: 'setup', op: body.op });
    const nonce = push.nonce as string;

    const proof = await w.call('POST', '/api/device-alerts/ready', { op: body.op, nonce });
    expect(proof.body).toMatchObject({ result: 'active', activation: { generation: 1, revision: 1 } });

    const mine = await w.call('GET', '/api/device-alerts/mine');
    expect(mine.body).toMatchObject({ state: 'active', alert: { choices, generation: 1, revision: 1, updating: false }, operation: { result: 'active' } });

    const seen = await w.call('POST', '/api/device-alerts/mine/seen', {});
    expect(seen.body).toMatchObject({ state: 'active' });

    const changed = await w.call('PUT', '/api/device-alerts/mine', { op: opId(), seq: 2, incarnation: mine.body.alert.incarnation, baseRevision: 1, choices: { ...choices, siteIds: [693] } });
    expect(changed.body).toEqual({ result: 'active', revision: 2 });

    expect((await w.call('POST', '/api/device-alerts/mine/test', {})).body).toEqual({ test: 'accepted' });
    expect(w.transport.sent[1]!.payload).toMatchObject({ v: 1, title: 'Test notification', body: 'Notifications work on this device.' });

    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).body).toEqual({ deleted: true });
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toEqual({ state: 'none', operation: null });
    // The nonce is never in an answer or a log line.
    for (const text of [setup.text, proof.text, mine.text, ...w.lines]) expect(text).not.toContain(nonce);
    for (const text of w.lines) expect(text).not.toContain(w.cred);
  });

  it('requires the site\'s Origin on changes, not on reads', async () => {
    const w = await world();
    for (const origin of [undefined, 'null', 'https://evil.example']) {
      const res = await w.app.request('/api/device-alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Device ${w.cred}`, ...(origin ? { origin } : {}) },
        body: JSON.stringify(setupBody()),
      });
      expect(res.status).toBe(403);
    }
    expect((await w.call('GET', '/api/device-alerts/mine')).status).toBe(200);
  });

  it('requires a well-formed credential header', async () => {
    const w = await world();
    expect((await w.call('GET', '/api/device-alerts/mine', undefined, {}, 'short')).status).toBe(401);
    const res = await w.app.request('/api/device-alerts/mine');
    expect(res.status).toBe(401);
  });

  it.each([
    ['off', { mode: 'off' as const }, 'off'],
    ['owner without a token', { mode: 'owner' as const, ownerToken: 'o'.repeat(40) }, 'owner-only'],
  ])('refuses a first setup when push is %s, storing nothing', async (_, o, outcome) => {
    const w = await world(o);
    const r = await w.call('POST', '/api/device-alerts', setupBody());
    expect(r.body).toEqual({ outcome, operation: null });
    expect(w.kv.keys().filter((k) => k.startsWith('pp:dev:'))).toEqual([]);
  });

  it('admits the owner with the token from the owner link, compared exactly', async () => {
    const w = await world({ mode: 'owner', ownerToken: 'o'.repeat(40) });
    expect((await w.call('POST', '/api/device-alerts', setupBody(), { 'x-owner-token': `${'o'.repeat(39)}x` })).body.outcome).toBe('owner-only');
    expect((await w.call('POST', '/api/device-alerts', setupBody(), { 'x-owner-token': 'o'.repeat(40) })).body.outcome).toBe('pending');
  });

  it('answers unavailable while push is paused or its service is backing off', async () => {
    const w = await world();
    await w.kv.set(K.pushPaused, '1');
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.outcome).toBe('unavailable');
    await w.kv.write([{ op: 'del', key: K.pushPaused }]);
    await w.kv.set(K.pushBackoff('fcm'), String(w.t.now() + 60_000));
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.outcome).toBe('unavailable');
  });

  it('answers an identical repeat with its operation even after push was paused or the owner token changed', async () => {
    const w = await world();
    const body = setupBody();
    await w.call('POST', '/api/device-alerts', body);
    await w.kv.set(K.pushPaused, '1');
    expect((await w.call('POST', '/api/device-alerts', body)).body).toMatchObject({ outcome: 'pending', operation: { op: body.op } });
    await w.kv.write([{ op: 'del', key: K.pushPaused }]);
  });

  it('refuses a subscription to anything but a browser push service', async () => {
    const w = await world();
    const r = await w.call('POST', '/api/device-alerts', setupBody({ sub: { endpoint: 'https://evil.example/push', keys: fcmSubscription().keys } }));
    expect(r.status).toBe(400);
  });

  it('answers full when Valkey is above 70% of its memory', async () => {
    const w = await world();
    w.kv.memoryUse = { used: 72, max: 100 };
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.outcome).toBe('full');
  });

  it('repeats a retryable dispatch when the page sends the identical request again', async () => {
    const w = await world();
    w.transport.next = [{ kind: 'refused', status: 503 }];
    const body = setupBody();
    expect((await w.call('POST', '/api/device-alerts', body)).body.operation).toMatchObject({ dispatch: 'retryable' });
    const again = await w.call('POST', '/api/device-alerts', body);
    expect(again.body).toMatchObject({ outcome: 'pending', operation: { dispatch: 'accepted' } });
    expect(w.transport.sent).toHaveLength(2);
  });

  it('ends a setup whose push service says the subscription is gone', async () => {
    const w = await world();
    w.transport.next = [{ kind: 'gone', status: 410 }];
    expect((await w.call('POST', '/api/device-alerts', setupBody())).body.operation).toMatchObject({ result: 'gone' });
  });

  it('settles a test answered gone by deleting the alert, which then reads gone with its fingerprint', async () => {
    const w = await world();
    const body = setupBody();
    await w.call('POST', '/api/device-alerts', body);
    await w.call('POST', '/api/device-alerts/ready', { op: body.op, nonce: w.transport.sent[0]!.payload.nonce });
    const fp = (await w.call('GET', '/api/device-alerts/mine')).body.alert.fingerprint;
    w.transport.next = [{ kind: 'gone', status: 410 }];
    expect((await w.call('POST', '/api/device-alerts/mine/test', {})).body).toEqual({ test: 'gone' });
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toMatchObject({ state: 'gone', fingerprint: fp });
  });

  it('answers an unknown credential without storing anything about it', async () => {
    const w = await world();
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toEqual({ state: 'none', operation: null });
    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).body).toEqual({ deleted: true });
    expect((await w.call('POST', '/api/device-alerts/ready', { op: opId(), nonce: 'n'.repeat(43) })).body).toEqual({ result: 'unknown', activation: null });
    expect(w.kv.keys().some((k) => k.includes(credentialHash(w.cred)))).toBe(false);
  });

  it('limits first setups to 30 an hour from one network, and creates nothing when refusing', async () => {
    const w = await world({ limits: { alertLimit: 100, recordLimit: 1000 } });
    for (let i = 0; i < 30; i++) await w.call('POST', '/api/device-alerts', setupBody(), {}, credential());
    const before = w.kv.keys().length;
    const r = await w.call('POST', '/api/device-alerts', setupBody(), {}, credential());
    expect(r.status).toBe(429);
    expect(w.kv.keys().length).toBe(before);
  });

  it('turns off even when Valkey is out of memory (the counters are skipped, the deletion runs)', async () => {
    const w = await world();
    const body = setupBody();
    await w.call('POST', '/api/device-alerts', body);
    await w.call('POST', '/api/device-alerts/ready', { op: body.op, nonce: w.transport.sent[0]!.payload.nonce });
    w.kv.oom = true;
    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).body).toEqual({ deleted: true });
    w.kv.oom = false;
    expect((await w.call('GET', '/api/device-alerts/mine')).body).toEqual({ state: 'none', operation: null });
  });

  it('keeps reads and turn-off working with push off', async () => {
    const w = await world({ mode: 'off' });
    expect((await w.call('GET', '/api/device-alerts/mine')).status).toBe(200);
    expect((await w.call('DELETE', '/api/device-alerts/mine', {})).status).toBe(200);
    expect((await w.call('POST', '/api/device-alerts/mine/test', {})).body).toEqual({ test: 'unavailable' });
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- devices-api`
Expected: FAIL: `createApi` ignores `devices` (every route answers 404).

- [ ] **Step 3: The setup payload and the backoff setter**

`apps/server/src/push/payload.ts`, add:

```ts
/** The ready check's push (spec, "Setting up", step 4): in the v1 envelope, so an older worker shows its title and body. */
export function setupPayload(a: { op: string; nonce: string; expiresAt: number; offices: string[] }): string {
  const first = [...shortName(a.offices[0] ?? 'your offices')].slice(0, NAME_CHARS).join('');
  const body = a.offices.length > 1 ? `${first} and ${a.offices.length - 1} more` : first;
  return JSON.stringify({ v: 1, title: 'Setting up PengePassportPH notifications', body, tag: `setup-${a.op}`, url: {}, kind: 'setup', op: a.op, nonce: a.nonce, expiresAt: new Date(a.expiresAt).toISOString() });
}
```

`apps/server/src/devices/scripts-api.ts`, add:

```ts
export const backoffScript = deviceScript(
  'dev-backoff',
  `need(K.backoff, 'string')
local b = tonumber(redis.call('GET', K.backoff) or '0') or 0
if A.till > b then redis.call('SET', K.backoff, I(A.till)) end
return '"ok"'`,
  { reclaim: true },
);

/** A push service answered 429: every sender waits until `until` (never shortened). */
export const testCaptureScript = deviceScript(
  'dev-test-capture',
  `${STORE_LIB}
need_store()
local a = alert_get(A.id)
if not a or a.inc ~= A.inc or is_ended(a) then return '{"state":"none"}' end
if a.gone ~= nil and a.gone ~= '' then return '{"state":"gone"}' end
if redis.call('EXISTS', KEY.paused) == 1 then return '{"state":"unavailable"}' end
need(KEY.backoff .. a.svc, 'string')
if counter(KEY.backoff .. a.svc) > NOW then return '{"state":"unavailable"}' end
return cjson.encode({ state = 'ok', alert = a })
`,
  { reclaim: true },
);

/** The alert as one atomic read, with the stop and its push service's backoff, for a test send. */
export function testCapture(kv: Kv, a: { now: number; id: string; inc: string }): Promise<{ state: 'ok'; alert: Record<string, string> } | { state: 'none' | 'gone' | 'unavailable' }> {
  return testCaptureScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export async function setBackoff(kv: Kv, svc: string, until: number): Promise<void> {
  // "until" is a Lua keyword: the field is "till".
  await backoffScript.run(kv, { backoff: K.pushBackoff(svc) }, { now: until, till: until });
}
```

- [ ] **Step 4: Write the routes**

`apps/server/src/devices/api.ts`:

```ts
// The notification-alert routes (spec: "API", "What each mode allows", "Limits against abuse"). Every request passes
// the ingress gate, then is classified read-only by its credential's hash, then charged to its class (global pool
// first, all or nothing). Changes need the site's Origin and a JSON body; the credential travels only in the
// Authorization header. Nothing here logs a subscription, credential, nonce, header or payload.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type AlertChoices,
  type ApiError,
  type ChangeAnswer,
  isChangeRequest,
  isReadyRequest,
  isRotateRequest,
  isSetupRequest,
  type MineAnswer,
  type PushSubscriptionInput,
  type ReadyAnswer,
  type SeenAnswer,
  type SetupAnswer,
  type SetupOutcome,
  type SiteSummary,
  type TestAnswer,
  validateChoices,
} from '@penge/contracts';
import type { Context, Hono } from 'hono';
import type { PushConfig } from '../config.ts';
import { newId, randomToken } from '../crypto.ts';
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Limit } from '../limits.ts';
import type { Logger } from '../log.ts';
import { checkPushSubscription } from '../push/endpoint.ts';
import { endpointHmac } from '../push/endpoint.ts';
import { setupPayload } from '../push/payload.ts';
import type { Keys } from '../subscribers.ts';
import { charge, DEVICE_LIMITS, ingressBucket, rateKeys } from './limits.ts';
import { admit, change, dispatchBegin, dispatchEnd, markGone, type Prepared, readMine, ready, reclaim, renew, setBackoff, testCapture, turnOff } from './scripts-api.ts';
import { credentialHash, digest, fingerprint, type OpRecord, openSetup, openSubscription, opView, pushService, sealSetup, sealSubscription, SETUP_MS } from './store.ts';
import { loggable, type SendResult, type SendSlots, type Transport } from './transport.ts';

export interface DeviceRouteDeps {
  kv: Kv;
  keys: Keys;
  log: Logger;
  now: () => number;
  push: PushConfig;
  limits: { alertLimit: number; recordLimit: number };
  transport: Transport | null;
  slots: SendSlots;
  ipOf: (c: Context) => string;
  sites: () => Promise<SiteSummary[] | null>;
  /** The site's own origin, and the local stack's in its build. */
  origins: string[];
}

type Class = 'alert' | 'pending' | 'unknown';
const SETUP_TTL_SECONDS = 300;
const ALERT_TTL_SECONDS = 1800;
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const choicesOf = (a: Record<string, string>): AlertChoices => ({ siteIds: a.offices!.split(',').map(Number), applicants: Number(a.group), pace: a.pace as AlertChoices['pace'] });

export function mountDeviceRoutes(app: Hono, d: DeviceRouteDeps): void {
  const { kv, keys, log } = d;
  const limited = (c: Context) => c.json<ApiError>({ error: 'Too many requests. Try again later.', code: 'limited' }, 429);
  const bad = (c: Context) => c.json<ApiError>({ error: 'That request is not valid.' }, 400);

  type Gate = { ok: true; hash: string; cls: Class; alertId: string | null; body: Record<string, unknown> } | { ok: false; res: Response };

  /** Ingress, Origin and body (for changes), credential, classification. Charging is per route (below). */
  /** Over maxmemory, Valkey refuses the counters' script; a turn-off, which only removes, goes through uncounted. */
  const overMemory = (err: unknown) => /OOM/.test(String((err as Error)?.message ?? err));
  async function pay(c: Context, items: [Limit, string][], reclaim = false): Promise<boolean> {
    try {
      return (await charge(kv, items, d.now())).ok;
    } catch (err) {
      if (reclaim && overMemory(err)) return true;
      throw err;
    }
  }

  async function gate(c: Context, change: boolean, reclaim = false): Promise<Gate> {
    const bucket = String(ingressBucket(d.ipOf(c), keys.index));
    if (!(await pay(c, [[DEVICE_LIMITS.ingress, bucket]], reclaim))) return { ok: false, res: limited(c) };
    let body: Record<string, unknown> = {};
    if (change) {
      const origin = c.req.header('origin');
      if (!origin || origin === 'null' || !d.origins.includes(origin)) return { ok: false, res: c.json<ApiError>({ error: 'Not allowed from there.' }, 403) };
      if (!/^application\/json\s*(?:;|$)/i.test(c.req.header('content-type') ?? '')) return { ok: false, res: c.json<ApiError>({ error: 'Send JSON.' }, 415) };
      try {
        const parsed = (await c.req.json()) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, res: bad(c) };
        body = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, res: bad(c) };
      }
    }
    const m = /^Device ([A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '');
    if (!m) return { ok: false, res: c.json<ApiError>({ error: 'This device has no notification key.' }, 401) };
    const hash = credentialHash(m[1]!);
    const alertId = await kv.get(K.devCred(hash));
    let cls: Class = 'unknown';
    if (alertId) cls = 'alert';
    else if ((await kv.hGetAll(K.devOp(hash))).op || (await kv.hGetAll(K.devEnded(hash))).reason) cls = 'pending';
    return { ok: true, hash, cls, alertId, body };
  }

  // Per-network counters are keyed by the ingress bucket (one of 4,096), so their number is bounded whatever the traffic.
  const ip = (c: Context) => `b${ingressBucket(d.ipOf(c), keys.index)}`;
  const unknownPool = (c: Context): [Limit, string][] => [[DEVICE_LIMITS.unknownAll, 'all'], [DEVICE_LIMITS.unknownIp, ip(c)]];
  const readPool = (c: Context, g: { hash: string; cls: Class }): [Limit, string][] =>
    g.cls === 'alert'
      ? [[DEVICE_LIMITS.knownReadAll, 'all'], [DEVICE_LIMITS.knownReadIp, ip(c)], [DEVICE_LIMITS.knownReadCred, g.hash]]
      : g.cls === 'pending'
        ? [[DEVICE_LIMITS.pendingReadAll, 'all'], [DEVICE_LIMITS.pendingReadIp, ip(c)], [DEVICE_LIMITS.pendingReadCred, g.hash]]
        : unknownPool(c);

  const modeAllowsSetups = () => d.push.mode !== 'off' && d.transport !== null;

  async function siteNames(ids: number[]): Promise<string[]> {
    const list = (await d.sites()) ?? [];
    return ids.map((id) => list.find((s) => s.id === id)?.name ?? `Office ${id}`);
  }

  /** Sends the setup push for the credential's current operation, if its gate lets it (spec step 4). */
  async function dispatch(hash: string, o: OpRecord): Promise<OpRecord> {
    if (!d.transport) return o;
    const release = await d.slots.take();
    try {
      const now = d.now();
      const ep = rateKeys(DEVICE_LIMITS.setupPushEndpoint, o.ep!, now);
      const items = (l: Limit, id: string) => ({ ...rateKeys(l, id, now), bucket: l.bucket });
      const did = newId();
      const begin = await dispatchBegin(kv, {
        now, cred: hash, op: o.op!, did, svc: o.svc!, ep: o.ep!, modeOk: modeAllowsSetups(),
        epItems: [{ ...ep, bucket: DEVICE_LIMITS.setupPushEndpoint.bucket }],
        maintItems: [items(DEVICE_LIMITS.maintenanceAll, 'all'), items(DEVICE_LIMITS.maintenanceAlert, o.alert || 'none')],
      });
      if (!begin.go) return begin.o;
      // Everything between the gate and the settlement is inside one handler: a failure before the request leaves
      // as failed (a bug, never sent), not as "sending", which would read as uncertain.
      let result: SendResult;
      try {
        const secret = openSetup(keys, begin.o.sealed!);
        let offices = secret.choices?.siteIds ?? [];
        if (offices.length === 0 && o.alert) offices = ((await kv.hGetAll(K.devAlert(o.alert))).offices ?? '').split(',').filter(Boolean).map(Number);
        const payload = setupPayload({ op: o.op!, nonce: secret.nonce, expiresAt: Number(o.exp), offices: await siteNames(offices) });
        // Endpoint checks again, just before the send.
        const sub = checkPushSubscription({ endpoint: secret.subscription.endpoint, keys: { p256dh: secret.subscription.p256dh, auth: secret.subscription.auth } });
        result = sub ? await d.transport.send(sub, payload, { ttl: SETUP_TTL_SECONDS, urgency: 'high' }) : { kind: 'bug', status: null };
      } catch {
        result = { kind: 'bug', status: null };
      }
      if (result.kind !== 'accepted') log.warn('setup push not accepted', { route: 'setup', push: loggable(result) });
      const outcome = result.kind === 'accepted' || result.kind === 'uncertain' ? result.kind : result.kind === 'gone' ? 'gone' : result.kind === 'bug' ? 'failed' : 'retryable';
      const backoffUntil = result.kind === 'throttled' ? d.now() + result.retryAfterMs : null;
      await dispatchEnd(kv, { now: d.now(), cred: hash, op: o.op!, did, svc: o.svc!, outcome, backoffUntil });
      return await kv.hGetAll(K.devOp(hash));
    } finally {
      release();
    }
  }

  const answer = (c: Context, outcome: SetupOutcome, o?: OpRecord) => c.json<SetupAnswer>({ outcome, operation: o ? opView(o, d.now()) : null });

  /** A setup or a rotation, from the gate to the dispatch. */
  async function start(c: Context, kind: 'setup' | 'rotate') {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    const body = g.body;
    const valid = kind === 'setup' ? isSetupRequest(body) : isRotateRequest(body);
    if (!valid) return bad(c);
    const captured = (body.captured ?? null) as { incarnation: string; generation: number; revision?: number } | null;
    const first = kind === 'setup' && captured === null;
    const sub = checkPushSubscription(body.subscription);
    if (!sub) return bad(c);
    // Choices normalised by shape only here (the digest must not depend on today's office list).
    let choices: AlertChoices | null = null;
    if (kind === 'setup') {
      const shaped = validateChoices(body.choices);
      if (!shaped.ok) return bad(c);
      choices = shaped.value;
    }
    const requestDigest = digest(kind, sub, choices, captured);
    // An identical repeat of this credential's current or last operation answers that operation before anything a new
    // setup must pass (its class's pools, the office list, the mode, the owner token, the stop, a backoff, memory):
    // it was admitted already. It costs a read from the credential's read pool.
    const last = await kv.hGetAll(K.devOp(g.hash));
    if (last.op === body.op) {
      if (!(await pay(c, readPool(c, { hash: g.hash, cls: g.cls === 'unknown' ? 'pending' : g.cls })))) return limited(c);
      if (last.digest !== requestDigest) return answer(c, 'invalid');
      let o = last;
      if (o.result === '' && (o.dsp === 'unsent' || o.dsp === 'retryable')) o = await dispatch(g.hash, o);
      return answer(c, o.result === '' ? 'pending' : 'done', o);
    }
    // Classes (spec: "Classification"): first setups use the unknown-setup pools whatever the credential has.
    if (first) {
      if (!(await pay(c, [[DEVICE_LIMITS.unknownSetupAll, 'all'], [DEVICE_LIMITS.unknownSetupIp, ip(c)]]))) return limited(c);
    } else if (g.cls === 'alert') {
      if (!(await pay(c, readPool(c, g)))) return limited(c);
    } else {
      if (!(await pay(c, g.cls === 'pending' ? readPool(c, g) : unknownPool(c)))) return limited(c);
      return answer(c, 'changed');
    }
    if (choices) {
      const sites = await d.sites();
      if (!sites) return answer(c, 'unavailable');
      if (!validateChoices(choices, new Set(sites.map((x) => x.id))).ok) return bad(c);
    }
    // Mode (spec: "What each mode allows").
    if (d.push.mode === 'off' || !d.transport || !d.push.vapid) return answer(c, first ? 'off' : 'unavailable');
    let tok = '';
    if (first && d.push.mode === 'owner') {
      const given = c.req.header('x-owner-token') ?? '';
      const want = d.push.ownerToken ?? '';
      const same = want !== '' && timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(want)));
      if (!same) return answer(c, 'owner-only');
      tok = sha(want);
    }
    const svc = pushService(sub.endpoint);
    if (await kv.get(K.pushPaused)) return answer(c, 'unavailable');
    if (Number((await kv.get(K.pushBackoff(svc))) ?? 0) > d.now()) return answer(c, 'unavailable');
    // Memory is read live, just before the admission step (the step itself cannot read it: INFO is not a script
    // command we use). Over maxmemory, Valkey refuses the admission script anyway; between 70% and 100% this guard
    // can admit one request that started a moment before the line was crossed, which the 25% budget absorbs.
    const mem = await kv.memory();
    if (mem.max > 0 && mem.used / mem.max > 0.7) return answer(c, 'full');
    const now = d.now();
    await reclaim(kv, now);
    const nonce = randomToken();
    const item = (l: Limit, id: string) => ({ ...rateKeys(l, id, now), bucket: l.bucket });
    const r = await admit(kv, {
      now, cred: g.hash, op: body.op as string, seq: body.seq as number, kind,
      cap: captured ?? false,
      digest: requestDigest, ep: endpointHmac(keys.index, sub.endpoint), fp: fingerprint(sub), svc,
      sealed: sealSetup(keys, { subscription: sub, choices, nonce }), nh: sha(nonce), tok, exp: now + SETUP_MS,
      stored: first ? [item(DEVICE_LIMITS.storedSetupAll, 'all'), item(DEVICE_LIMITS.storedSetupIp, ip(c))] : [],
      ...d.limits,
    });
    if (r.outcome !== 'pending' && r.outcome !== 'repeat') return answer(c, r.outcome);
    let o = r.o!;
    if (o.result === '' && (o.dsp === 'unsent' || o.dsp === 'retryable')) o = await dispatch(g.hash, o);
    return answer(c, o.result === '' ? 'pending' : 'done', o);
  }

  app.post('/api/device-alerts', (c) => start(c, 'setup'));
  app.post('/api/device-alerts/mine/subscription', (c) => start(c, 'rotate'));

  app.post('/api/device-alerts/ready', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    if (!isReadyRequest(g.body)) return bad(c);
    if (g.cls === 'unknown') {
      if (!(await pay(c, unknownPool(c)))) return limited(c);
      return c.json<ReadyAnswer>({ result: 'unknown', activation: null });
    }
    if (!(await pay(c, [[DEVICE_LIMITS.ackAll, 'all'], [DEVICE_LIMITS.ackIp, ip(c)]]))) return limited(c);
    const o = await kv.hGetAll(K.devOp(g.hash));
    let prep: Prepared | false = false;
    if (o.op === g.body.op && o.sealed) {
      const secret = openSetup(keys, o.sealed);
      prep = { sub: sealSubscription(keys, secret.subscription), ep: o.ep!, fp: o.fp!, svc: o.svc! };
      if (secret.choices) Object.assign(prep, { offices: secret.choices.siteIds.join(','), group: String(secret.choices.applicants), pace: secret.choices.pace });
    }
    const r = await ready(kv, {
      now: d.now(), cred: g.hash, op: g.body.op as string, nh: sha(g.body.nonce as string), prep, newId: newId(), newInc: newId(),
      ownerMode: d.push.mode === 'owner', ownerTok: d.push.ownerToken ? sha(d.push.ownerToken) : '', alertLimit: d.limits.alertLimit,
    });
    if (r.result === 'limited') return limited(c);
    return c.json<ReadyAnswer>({ result: r.result, activation: r.activation });
  });

  app.get('/api/device-alerts/mine', async (c) => {
    const g = await gate(c, false);
    if (!g.ok) return g.res;
    if (!(await pay(c, readPool(c, g)))) return limited(c);
    if (g.cls === 'unknown') return c.json<MineAnswer>({ state: 'none', operation: null });
    const now = d.now();
    const r = await readMine(kv, { now, cred: g.hash });
    const operation = r.o ? opView(r.o, now) : null;
    if (r.a && r.id) {
      const a = r.a;
      return c.json<MineAnswer>({
        state: 'active',
        operation,
        alert: { alertId: r.id, incarnation: a.inc!, generation: Number(a.gen), revision: Number(a.rev), choices: choicesOf(a), fingerprint: a.fp!, endsAt: new Date(Number(a.end)).toISOString(), updating: Boolean(a.gone) },
      });
    }
    if (r.e) {
      const endedAt = new Date(Number(r.e.at)).toISOString();
      return c.json<MineAnswer>(r.e.reason === 'gone' ? { state: 'gone', endedAt, fingerprint: r.e.fp!, operation } : { state: 'ended', endedAt, operation });
    }
    return c.json<MineAnswer>({ state: 'none', operation });
  });

  app.post('/api/device-alerts/mine/seen', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    if (!(await pay(c, readPool(c, g)))) return limited(c);
    if (g.cls === 'unknown') return c.json<SeenAnswer>({ state: 'none' });
    const r = await renew(kv, { now: d.now(), cred: g.hash });
    return c.json<SeenAnswer>(r.state === 'active' ? { state: 'active', endsAt: new Date(r.endsAt).toISOString() } : r);
  });

  app.put('/api/device-alerts/mine', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    const pool: [Limit, string][] = g.cls === 'alert' ? [[DEVICE_LIMITS.changeAll, 'all'], [DEVICE_LIMITS.changeCred, g.hash]] : g.cls === 'pending' ? readPool(c, g) : unknownPool(c);
    if (!(await pay(c, pool))) return limited(c);
    if (!isChangeRequest(g.body)) return bad(c);
    const sites = await d.sites();
    const checked = validateChoices(g.body.choices, new Set((sites ?? []).map((s) => s.id)));
    if (!checked.ok || !sites) return bad(c);
    if (g.cls === 'unknown') return c.json<ChangeAnswer>({ result: 'changed' }, 409);
    const v = checked.value;
    const r = await change(kv, {
      now: d.now(), cred: g.hash, op: g.body.op as string, seq: g.body.seq as number, digest: sha(JSON.stringify([g.body.incarnation, g.body.baseRevision, v])),
      inc: g.body.incarnation as string, baseRev: g.body.baseRevision as number, offices: v.siteIds.join(','), group: String(v.applicants), pace: v.pace, recordLimit: d.limits.recordLimit,
    });
    if (r.result === 'active') return c.json<ChangeAnswer>({ result: 'active', revision: r.revision! });
    return c.json<ChangeAnswer>({ result: r.result }, r.result === 'invalid' ? 400 : r.result === 'full' ? 503 : 409);
  });

  app.post('/api/device-alerts/mine/test', async (c) => {
    const g = await gate(c, true);
    if (!g.ok) return g.res;
    if (!(await pay(c, readPool(c, g)))) return limited(c);
    if (d.push.mode === 'off' || !d.transport || (await kv.get(K.pushPaused))) return c.json<TestAnswer>({ test: 'unavailable' });
    if (g.cls !== 'alert' || !g.alertId) return c.json<TestAnswer>({ test: 'none' });
    // An ended alert is ended here (and answers none).
    const r = await readMine(kv, { now: d.now(), cred: g.hash });
    if (!r.a || !r.id) return c.json<TestAnswer>({ test: 'none' });
    const id = r.id;
    if (!(await pay(c, [[DEVICE_LIMITS.testAll, 'all'], [DEVICE_LIMITS.testIp, ip(c)], [DEVICE_LIMITS.testAlert, id]]))) return c.json<TestAnswer>({ test: 'limited' }, 429);
    // The slot first; then one atomic step reads the alert (subscription, generation, end, gone) with the stop and the
    // backoff, just before the send. The generation sent to is the one a "gone" answer settles.
    const release = await d.slots.take();
    let result: SendResult;
    let a: Record<string, string>;
    try {
      const cap = await testCapture(kv, { now: d.now(), id, inc: r.a.inc! });
      if (cap.state !== 'ok') return c.json<TestAnswer>(cap.state === 'gone' ? { test: 'gone', updating: true } : { test: cap.state });
      a = cap.alert;
      let sub: PushSubscriptionInput | null = null;
      try {
        // A missing sealed subscription is a damaged record: refused below, like one that fails the checks.
        if (typeof a.sub !== 'string') throw new Error('no subscription stored');
        const opened = openSubscription(keys, a.sub);
        sub = checkPushSubscription({ endpoint: opened.endpoint, keys: { p256dh: opened.p256dh, auth: opened.auth } });
      } catch {
        sub = null;
      }
      if (!sub) {
        log.error('a notification alert could not be opened or failed the endpoint checks', { route: 'test', alert: id });
        return c.json<TestAnswer>({ test: 'refused' });
      }
      const payload = JSON.stringify({ v: 1, title: 'Test notification', body: 'Notifications work on this device.', tag: `test-${randomBytes(6).toString('base64url')}`, url: {} });
      result = await d.transport.send(sub, payload, { ttl: ALERT_TTL_SECONDS, urgency: 'high' }).catch((): SendResult => ({ kind: 'bug', status: null }));
    } finally {
      release();
    }
    const r2 = { id };
    if (result.kind !== 'accepted') log.warn('test push not accepted', { route: 'test', alert: r2.id, push: loggable(result) });
    if (result.kind === 'accepted' || result.kind === 'uncertain') return c.json<TestAnswer>({ test: result.kind });
    if (result.kind === 'throttled') await setBackoff(kv, a.svc!, d.now() + result.retryAfterMs);
    if (result.kind === 'gone') {
      const gone = await markGone(kv, { now: d.now(), id: r2.id, inc: a.inc!, gen: Number(a.gen) });
      if (gone.gone === 'deleted') return c.json<TestAnswer>({ test: 'gone' });
      if (gone.gone === 'kept') return c.json<TestAnswer>({ test: 'gone', updating: true });
    }
    if (result.kind === 'rejected' || result.kind === 'bug') log.error('test push refused by us or the push service', { route: 'test', alert: r2.id, push: loggable(result) });
    return c.json<TestAnswer>({ test: 'refused' });
  });

  app.delete('/api/device-alerts/mine', async (c) => {
    const g = await gate(c, true, true);
    if (!g.ok) return g.res;
    if (g.cls === 'unknown') {
      if (!(await pay(c, unknownPool(c), true))) return limited(c);
      return c.json({ deleted: true });
    }
    if (!(await pay(c, [[DEVICE_LIMITS.offAll, 'all'], [DEVICE_LIMITS.offIp, ip(c)]], true))) return limited(c);
    return c.json(await turnOff(kv, { now: d.now(), cred: g.hash }));
  });
}
```

`apps/server/src/api.ts`:

```ts
import { mountDeviceRoutes } from './devices/api.ts';
import { API_SLOTS, SendSlots, type Transport } from './devices/transport.ts';
```

`ApiDeps` gains:

```ts
  /** Notification alerts' ceilings; without them no notification alert can be set up. */
  devices?: { alertLimit: number; recordLimit: number };
  /** Sends setup and test pushes; without it they answer "unavailable". */
  pushTransport?: Transport;
  /** The local stack's extra origins, allowed on device changes. */
  devOrigins?: string[];
```

and before `app.notFound(…)`:

```ts
  mountDeviceRoutes(app, {
    kv, keys, log, now, push: deps.push,
    limits: deps.devices ?? { alertLimit: 0, recordLimit: 0 },
    transport: deps.pushTransport ?? null,
    slots: new SendSlots(API_SLOTS),
    ipOf,
    sites,
    origins: [new URL(deps.publicBaseUrl).origin, ...(deps.devOrigins ?? [])],
  });
```

`apps/server/src/server.ts`:

```ts
import { webPushTransport } from './devices/transport.ts';
```

and the `createApi({ … })` call gains:

```ts
  devices: config.devices,
  ...(config.push.vapid ? { pushTransport: webPushTransport(config.push.vapid) } : {}),
```

- [ ] **Step 5: Watch them pass**

Run: `npm test -w @penge/server -- devices-api old-pages api`
Expected: PASS.

- [ ] **Step 6: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review of the notification-alert HTTP routes against the spec's 'API', 'What each mode allows' and 'Limits against abuse' (ingress gate, classification, class pools charged global-first and all-or-nothing, Origin on changes, the owner token compared in constant time, the nonce never answered or logged). Find a route that writes for an unknown credential, a way to spend another class's pool, a mode table row not enforced, a log line that can carry a credential, nonce, endpoint or payload, and any answer that differs from the contracts."). Then:

```bash
git add apps/server/src/devices/api.ts apps/server/src/devices/scripts-api.ts apps/server/src/api.ts apps/server/src/server.ts apps/server/src/push/payload.ts apps/server/test/devices-api.test.ts
git commit -m "The notification-alert routes: gates, classes, owner token and the setup dispatch"
```

---
### Task 10: Queueing in two writes, scan demand for both kinds, fair group lookups

The checker's first queueing write (as at `157bad9`, now a script that checks the lock) also stores a **fan-out batch** of the openings notification alerts follow; the notification pass later turns batches into one merged job per alert, in resumable chunks. Group lookups serve both kinds and share a run's lookups fairly.

**Files:**
- Create: `apps/server/src/devices/delivery-lua.ts` (job helpers in Lua), `apps/server/src/devices/scripts-delivery.ts` (queue write, fan-out chunk, held pairs), `apps/server/src/devices/queue.ts` (Node side)
- Modify: `apps/server/src/checker.ts` (`queueAlerts`, `scanGroups`, `deliveryChecks`, `abroadPass`'s followed posts), `apps/server/src/snapshot.ts` (`GroupObservation.fetchedAt`), `apps/server/src/record.ts` (`runContent` ignores lookup times), `apps/server/src/keys.ts` (`queueMark`)
- Test: `apps/server/test/devices-queue.test.ts`, `apps/server/test/checker-devices.test.ts`

**Interfaces:**
- Consumes: Task 6's `STORE_LIB` (`alert_get`, `is_ended`), Task 2's prelude (`elapsed`, `count`), `seedAlert`.
- Produces:
  - Job format (queued `pp:dev:queue` field, held `pp:dev:held:<id>`, claimed in `pp:dev:claim:<id>`): `{ "i": alertId, "n": incarnation, "s": [Stamp, …], "d": [[office, "YYYY-MM-DD", group, stampIndex], …] }`; a date's identity is office, date and group; at most 30 dates and 4,096 bytes.
  - `DELIVERY_LIB` (Lua): `WINDOW_MS`, `MAX_DATES`, `MAX_JOB_BYTES`, `stamp_ok(st)`, `job_decode`, `dkey`, `stamp_of`, `job_with`, `job_merge`, `job_bound`, `job_prune(job, a, nowStamp)`, `oldest_wall`, `slice`, `lock_ok()`.
  - `queueWrite(kv, a: { now: number; run: string; mark: string; ops: WriteOp[]; batch: FanoutBatch | null }): Promise<void>` (scripts-delivery.ts; throws `LostLock` if the run no longer holds the lock; `mark` names the write, so a retry applies nothing twice)
  - `K.queueMark(name)` = `pp:queued:<name>` (keys.ts; a day's expiry): set as the queueing write's last write.
  - `type FanoutBatch = { id: string; entries: string[]; stamps: Stamp[] }`
  - `fanoutChunk(kv, a: { now: number; run: string; maxEntries: number; maxWork: number }): Promise<{ lost?: true; done?: true; batch?: string; entries?: number; work?: number }>`
  - `heldPairs(kv): Promise<[office: number, group: number, wall: number][]>` (device held work, by pair, oldest announcement)
  - `class LostLock extends Error`
  - queue.ts: `FANOUT_MAX_ENTRIES = 2000`, `FANOUT_MAX_PENDING = 5`, `CHUNK_ENTRIES = 100`, `CHUNK_WORK = 200`, `FANOUT_BUDGET_MS = 10_000`, `MEMORY_SKIP = 0.85`; `fanoutEntries(kv, openings: { siteId: number; applicants: number; dates: string[] }[]): Promise<string[]>`; `writeQueue(deps: { kv; log; now }, a: { run: string; ops: WriteOp[]; batchId: string; stamp: Stamp; openings: … }): Promise<void>` (the first write with its retry rule); `writeFanout(deps, a: { run: string; until: number }): Promise<{ chunks: number; merged: number }>` (the second write, chunked, yielding between chunks).
  - `GroupObservation.fetchedAt?: string | null`; `DeliveryCheck` gains `times: Map<number, string>` (group size → its lookup's time; 1 → the office's).
  - checker.ts exports `GROUP_HELD_SHARE = 6` and `ABROAD_HELD_SHARE = 2` (of `GROUP_QUERY_CAP` 10 and `ABROAD_GROUP_CAP` 4).

- [ ] **Step 1: Write the failing script tests**

`apps/server/test/devices-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { fanoutChunk, heldPairs, LostLock, queueWrite } from '../src/devices/scripts-delivery.ts';
import { choices, seedAlert } from './device-fixtures.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const stamp = { wall: T0 };
const job = async (kv: Parameters<typeof queueWrite>[0], id: string) => JSON.parse((await kv.hGetAll(K.devQueue))[id] ?? 'null');
const lock = (kv: Parameters<typeof queueWrite>[0], run = 'r1') => kv.set(K.checkLock, run);

for (const [name, make] of valkeyTargets()) {
  describe(`queueing on ${name}`, () => {
    it('applies the email write and stores a fan-out batch in one step, only while the run holds the lock', async () => {
      const kv = await make();
      await lock(kv, 'other');
      const write = { now: T0, run: 'r1', mark: 'r1:domestic', ops: [{ op: 'set' as const, key: K.announced(486, 1, '2026-10-09'), value: '{}', ttlSeconds: 60 }], batch: { id: 'r1:domestic', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } };
      await expect(queueWrite(kv, write)).rejects.toThrow(LostLock);
      expect(await kv.get(K.announced(486, 1, '2026-10-09'))).toBeNull();
      await lock(kv);
      await queueWrite(kv, write);
      expect(await kv.get(K.announced(486, 1, '2026-10-09'))).toBe('{}');
      expect(JSON.parse((await kv.get(K.devFanoutStamps('r1:domestic')))!)).toEqual({ order: 1, stamps: [stamp] });
      // A retry of the same write (its answer lost) applies nothing twice.
      await queueWrite(kv, write);
      expect(await kv.script({ name: 'n', lua: "#!lua\nreturn tostring(redis.call('LLEN', KEYS[1]))" }, [K.devFanouts], [])).toBe('1');
    });

    it('checks everything before writing: a damaged order counter stops the write with nothing written, and the retry without the batch goes', async () => {
      const kv = await make();
      await lock(kv);
      await kv.set(K.devOrder, 'not a number');
      const write = { now: T0, run: 'r1', mark: 'r1:domestic', ops: [{ op: 'rPush' as const, key: K.outbox, values: ['job'] }], batch: { id: 'r1:domestic', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } };
      await expect(queueWrite(kv, write)).rejects.toThrow(/not a counter/);
      expect(await kv.lLen(K.outbox)).toBe(0);
      await queueWrite(kv, { ...write, batch: null });
      expect(await kv.lLen(K.outbox)).toBe(1);
    });

    it('keeps at most 5 pending batches: a sixth is dropped and counted, the email write still goes', async () => {
      const kv = await make();
      await lock(kv);
      for (let i = 0; i < 6; i++) {
        await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [{ op: 'set', key: `pp:test:${i}`, value: '1' }], batch: { id: `b${i}`, entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      }
      expect(await kv.get('pp:test:5')).toBe('1');
      expect(await kv.get(K.devFanoutStamps('b5'))).toBeNull();
      expect((await kv.hGetAll(K.statsV2('2026-10-06'))).fanout_dropped_batches).toBe('1');
    });

    it('turns a batch into one merged job per alert activated before it, whose offices and group match', async () => {
      const kv = await make();
      await lock(kv);
      const early = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486, 693], applicants: 2 }) });
      await kv.script({ name: 'order', lua: "#!lua\nredis.call('SET', KEYS[1], '1') return 'ok'" }, [K.devOrder], []);
      const otherGroup = await seedAlert(kv, { now: T0, order: 1, choices: choices({ siteIds: [486], applicants: 1 }) });
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|2|0', '693|2026-10-10|2|0', '486|2026-10-11|1|0'], stamps: [stamp] } });
      const late = await seedAlert(kv, { now: T0, order: 9, choices: choices({ siteIds: [486], applicants: 2 }) });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toMatchObject({ batch: 'b1', entries: 3 });
      expect(await job(kv, early.id)).toEqual({ i: early.id, n: (await kv.hGetAll(K.devAlert(early.id))).inc, s: [stamp], d: [[486, '2026-10-09', 2, 0], [693, '2026-10-10', 2, 0]] });
      expect((await job(kv, otherGroup.id)).d).toEqual([[486, '2026-10-11', 1, 0]]);
      expect(await job(kv, late.id)).toBeNull();
      expect(await kv.get(K.devFanoutStamps('b1'))).toBeNull(); // done: removed with its list
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toEqual({ done: true });
    });

    it('resumes a batch chunk by chunk, never merging a date twice', async () => {
      const kv = await make();
      await lock(kv);
      const a = await seedAlert(kv, { now: T0, order: 0 });
      const entries = Array.from({ length: 5 }, (_, i) => `486|2026-10-1${i}|1|0`);
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries, stamps: [stamp] } });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 2, maxWork: 100 })).toMatchObject({ entries: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 2, maxWork: 100 })).toMatchObject({ entries: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 2, maxWork: 100 })).toMatchObject({ entries: 1 });
      expect((await job(kv, a.id)).d).toHaveLength(5);
    });

    it('stops a chunk at exactly maxWork recipients, inside an entry, and resumes after the last one handled', async () => {
      const kv = await make();
      await lock(kv);
      const alerts = [];
      for (let i = 0; i < 5; i++) alerts.push(await seedAlert(kv, { now: T0, order: 0 }));
      await queueWrite(kv, { now: T0, run: 'r1', mark: 'm1', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 2 })).toMatchObject({ entries: 0, work: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 2 })).toMatchObject({ entries: 0, work: 2 });
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 2 })).toMatchObject({ entries: 1, work: 1 });
      for (const a of alerts) expect((await job(kv, a.id)).d).toEqual([[486, '2026-10-09', 1, 0]]);
    });

    it('bounds a job to 30 dates, dropping the oldest and counting them', async () => {
      const kv = await make();
      await lock(kv);
      const a = await seedAlert(kv, { now: T0, order: 0 });
      const stamps = Array.from({ length: 35 }, (_, i) => ({ wall: T0 + i }));
      const entries = stamps.map((_, i) => `486|2026-11-${String(i + 1).padStart(2, '0')}|1|${i}`);
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries, stamps } });
      await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 });
      const j = await job(kv, a.id);
      expect(j.d).toHaveLength(30);
      expect(j.d[0][1]).toBe('2026-11-06'); // the 5 oldest went
      expect((await kv.hGetAll(K.statsV2('2026-10-06'))).dates_dropped_overflow).toBe('5');
      expect(JSON.stringify(j).length).toBeLessThanOrEqual(4096);
    });

    it('stops at the lock\'s loss without writing', async () => {
      const kv = await make();
      await lock(kv);
      await seedAlert(kv, { now: T0, order: 0 });
      await queueWrite(kv, { now: T0, run: 'r1', mark: `m${Math.random()}`, ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [stamp] } });
      await lock(kv, 'r2');
      expect(await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: 100 })).toEqual({ lost: true });
      expect(await kv.hGetAll(K.devQueue)).toEqual({});
    });

    it('lists the pairs with held work, by their oldest announcement', async () => {
      const kv = await make();
      const a = await seedAlert(kv, { now: T0, choices: choices({ applicants: 3 }) });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: 'x', s: [{ wall: T0 + 5 }, { wall: T0 }], d: [[486, '2026-10-09', 3, 0], [486, '2026-10-10', 3, 1]] }));
      expect(await heldPairs(kv)).toEqual([[486, 3, T0]]);
    });
  });
}
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- devices-queue`
Expected: FAIL: `Cannot find module '../src/devices/scripts-delivery.ts'`.

- [ ] **Step 3: Write the job helpers in Lua**

`apps/server/src/devices/delivery-lua.ts`:

```ts
// Lua for delivery work (spec: "Encrypted or not", "Bounds", "Claims and sending"). Jobs are plain JSON:
// { i, n, s: stamps, d: [[office, date, group, stamp index], …] }. A date's identity is office, date and group; it
// keeps its original announcement stamp through every merge. Only the checker runs these, under its lock.
export const DELIVERY_LIB = `
local WINDOW_MS = 3 * 3600000
local MAX_DATES = 30
local MAX_JOB_BYTES = 4096

local function lock_ok() return redis.call('GET', KEY.lock) == A.run end
local function slice(t, i, j)
  local out = {}
  for k = i, math.min(j, #t) do out[#out + 1] = t[k] end
  return out
end
-- A pace stamp as clock.ts makes it: a wall time, and an uptime with its boot id, or neither.
local function stamp_ok(st)
  if type(st) ~= 'table' or type(st.wall) ~= 'number' then return false end
  if st.up == nil and st.boot == nil then return true end
  return type(st.up) == 'number' and type(st.boot) == 'string'
end
-- A job whose every stamp is a stamp and every date points at one; anything else reads as no job (dropped).
local function job_decode(raw)
  if not raw then return nil end
  local ok, j = pcall(cjson.decode, raw)
  if not ok or type(j) ~= 'table' or type(j.d) ~= 'table' or type(j.s) ~= 'table' or type(j.n) ~= 'string' then return nil end
  for _, st in ipairs(j.s) do if not stamp_ok(st) then return nil end end
  for _, d in ipairs(j.d) do
    if type(d) ~= 'table' or type(d[1]) ~= 'number' or type(d[2]) ~= 'string' or type(d[3]) ~= 'number' or type(d[4]) ~= 'number'
      or d[4] < 0 or d[4] >= #j.s then return nil end
  end
  return j
end
local function dkey(d) return I(d[1]) .. '|' .. d[2] .. '|' .. I(d[3]) end
local function stamp_of(job, d) return job.s[d[4] + 1] end
local function same_stamp(a, b) return a.wall == b.wall and a.up == b.up and a.boot == b.boot end
local function stamp_index(job, st)
  for i = 1, #job.s do if same_stamp(job.s[i], st) then return i - 1 end end
  job.s[#job.s + 1] = st
  return #job.s - 1
end
-- The job with only these dates, its stamp table rebuilt.
local function job_with(job, dates)
  local out = { i = job.i, n = job.n, s = {}, d = {} }
  for _, d in ipairs(dates) do out.d[#out.d + 1] = { d[1], d[2], d[3], stamp_index(out, stamp_of(job, d)) } end
  return out
end
-- Adds src's dates that dst lacks; a date already there keeps its own (original) stamp.
local function job_merge(dst, src)
  local have = {}
  for _, d in ipairs(dst.d) do have[dkey(d)] = true end
  for _, d in ipairs(src.d) do
    if not have[dkey(d)] then
      have[dkey(d)] = true
      dst.d[#dst.d + 1] = { d[1], d[2], d[3], stamp_index(dst, stamp_of(src, d)) }
    end
  end
  return dst
end
local function by_age(job)
  local list = {}
  for _, d in ipairs(job.d) do list[#list + 1] = d end
  table.sort(list, function(a, b)
    local wa, wb = stamp_of(job, a).wall, stamp_of(job, b).wall
    if wa ~= wb then return wa < wb end
    return dkey(a) < dkey(b)
  end)
  return list
end
-- At most MAX_DATES dates and MAX_JOB_BYTES bytes, the oldest dropped first. Returns the job (nil if empty) and the drops.
local function job_bound(job)
  local list = by_age(job)
  local dropped = 0
  while #list > MAX_DATES do table.remove(list, 1) dropped = dropped + 1 end
  local j = job_with(job, list)
  while #j.d > 0 and #cjson.encode(j) > MAX_JOB_BYTES do
    table.remove(list, 1)
    dropped = dropped + 1
    j = job_with(job, list)
  end
  if #j.d == 0 then return nil, dropped end
  return j, dropped
end
local function oldest_wall(job)
  local w = nil
  for _, d in ipairs(job.d) do
    local x = stamp_of(job, d).wall
    if w == nil or x < w then w = x end
  end
  return w
end
-- The dates still for alert a (its incarnation, offices and group) and inside their window as of stamp nowst. A date
-- whose age cannot be known is dropped, never given a new window. Returns the job (nil if empty) and drops by reason.
local function job_prune(job, a, nowst)
  local drop = { choices = 0, window = 0, unknown = 0 }
  if not a or job.n ~= a.inc then drop.choices = #job.d return nil, drop end
  local offices = {}
  for o in string.gmatch(a.offices, '[^,]+') do offices[o] = true end
  local keep = {}
  for _, d in ipairs(job.d) do
    local age = elapsed(stamp_of(job, d), nowst)
    if not offices[I(d[1])] or I(d[3]) ~= a.group then drop.choices = drop.choices + 1
    elseif age == nil then drop.unknown = drop.unknown + 1
    elseif age > WINDOW_MS then drop.window = drop.window + 1
    else keep[#keep + 1] = d end
  end
  if #keep == 0 then return nil, drop end
  return job_with(job, keep), drop
end
local function count_drops(drop)
  if drop.choices > 0 then count('dates_dropped_choices', drop.choices) end
  if drop.window > 0 then count('dates_dropped_window', drop.window) end
  if drop.unknown > 0 then count('dates_dropped_unknown_age', drop.unknown) end
end
`;
```

- [ ] **Step 4: Write the queueing scripts**

`apps/server/src/keys.ts`, next to `outbox`:

```ts
  /** Set as a queueing write's last write (one per run and domestic/abroad): a retry of it applies nothing twice. */
  queueMark: (name: string) => `${P}queued:${name}`,
```


`apps/server/src/devices/scripts-delivery.ts`:

```ts
// The checker's atomic steps for notification delivery. Every one checks the run still holds the checker's lock
// (KEY.lock = pp:lock:check), and reads and type-checks everything before its first write.
import type { Stamp } from '../clock.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv, WriteOp } from '../kv.ts';
import { DELIVERY_LIB } from './delivery-lua.ts';
import { deviceScript } from './lua.ts';
import { STORE_LIB } from './store-lua.ts';

export class LostLock extends Error {
  override name = 'LostLock';
  constructor() {
    super('lost the checker lock; stopping this run');
  }
}

export interface FanoutBatch {
  id: string;
  entries: string[];
  stamps: Stamp[];
}

const statsKey = (now: number) => K.statsV2(manilaDay(now));

export const queueWriteScript = deviceScript(
  'dev-queue-write',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(K.mark, 'string')
if not lock_ok() then return '{"lost":true}' end
-- Applied already (a retry after a lost answer): nothing again. The mark is this step's last write.
if redis.call('EXISTS', K.mark) == 1 then return '{"ok":true,"again":true}' end
-- Everything checked before the first write, so nothing after it can fail on its input (Valkey keeps the writes a
-- failing script made): key types, every value a string, every expiry a positive integer, the counters integers.
local function str(v, what) if type(v) ~= 'string' then error('not a string: ' .. what) end end
local types = { set = 'string', hSet = 'hash', rPush = 'list', del = false }
for _, op in ipairs(A.ops) do
  local t = types[op.op]
  if t == nil then error('unknown write ' .. tostring(op.op)) end
  str(op.key, 'key')
  if t then need(op.key, t) end
  if op.op == 'set' then
    str(op.value, op.key)
    if op.ttlSeconds ~= nil and (type(op.ttlSeconds) ~= 'number' or op.ttlSeconds < 1 or op.ttlSeconds ~= math.floor(op.ttlSeconds)) then error('bad expiry ' .. op.key) end
  elseif op.op == 'hSet' then
    for f, v in pairs(op.fields) do str(f, op.key) str(v, op.key) end
  elseif op.op == 'rPush' then
    for i = 1, #op.values do str(op.values[i], op.key) end
  end
end
local b = A.batch
local fk, sk
if b then
  fk = KEY.fanout .. b.id
  sk = fk .. ':stamps'
  need(KEY.fanouts, 'list') need(fk, 'list') need(sk, 'string') need(KEY.order, 'string')
  counter(KEY.order)
  for i = 1, #b.entries do str(b.entries[i], 'entry') end
end
for _, op in ipairs(A.ops) do
  if op.op == 'set' then
    if op.ttlSeconds then redis.call('SET', op.key, op.value, 'EX', op.ttlSeconds) else redis.call('SET', op.key, op.value) end
  elseif op.op == 'del' then
    redis.call('DEL', op.key)
  elseif op.op == 'hSet' then
    local args = {}
    for f, v in pairs(op.fields) do args[#args + 1] = f args[#args + 1] = v end
    if #args > 0 then redis.call('HSET', op.key, unpack(args)) end
  elseif op.op == 'rPush' then
    for i = 1, #op.values, 500 do redis.call('RPUSH', op.key, unpack(slice(op.values, i, i + 499))) end
  end
end
if b then
  if redis.call('LLEN', KEY.fanouts) >= 5 then
    count('fanout_dropped_batches')
    count('fanout_dropped_entries', #b.entries)
  elseif #b.entries > 0 then
    local order = redis.call('INCR', KEY.order)
    for i = 1, #b.entries, 500 do redis.call('RPUSH', fk, unpack(slice(b.entries, i, i + 499))) end
    redis.call('SET', sk, cjson.encode({ order = order, stamps = b.stamps }))
    redis.call('RPUSH', KEY.fanouts, b.id)
    count('fanout_batches')
  end
end
redis.call('SET', K.mark, '1', 'EX', 86400)
return '{"ok":true}'
`,
);

/**
 * The first queueing write: the email write as at 157bad9, plus the fan-out batch, while the run holds the lock.
 * `mark` names this write (run and domestic/abroad): a retry after a lost answer applies nothing twice.
 */
export async function queueWrite(kv: Kv, a: { now: number; run: string; mark: string; ops: WriteOp[]; batch: FanoutBatch | null }): Promise<void> {
  const ops = a.ops.filter((op) => op.op === 'set' || op.op === 'del' || op.op === 'hSet' || op.op === 'rPush');
  if (ops.length !== a.ops.length) throw new Error('the queueing write has an operation the script does not apply');
  const r = await queueWriteScript.run<{ ok?: true; lost?: true }>(kv, { stats: statsKey(a.now), mark: K.queueMark(a.mark) }, { now: a.now, run: a.run, ops, batch: a.batch ?? false });
  if (r.lost) throw new LostLock();
}

export const fanoutChunkScript = deviceScript(
  'dev-fanout-chunk',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(KEY.fanouts, 'list') need(KEY.queue, 'hash') need(KEY.queued, 'zset')
if not lock_ok() then return '{"lost":true}' end
local id = redis.call('LINDEX', KEY.fanouts, 0)
if not id then return '{"done":true}' end
local fk = KEY.fanout .. id
local sk = fk .. ':stamps'
need(fk, 'list') need(sk, 'string')
local metaOk, meta = pcall(cjson.decode, redis.call('GET', sk) or '{"order":0,"stamps":[]}')
if not metaOk or type(meta) ~= 'table' or type(meta.stamps) ~= 'table' then error('fan-out batch ' .. id .. ' has no readable stamps') end
-- Read and decide everything first. Members are taken in sorted order, so a chunk can stop inside an entry, at
-- exactly maxWork recipients, and the next one resume after the last member it handled (meta.resume).
local entries = redis.call('LRANGE', fk, 0, A.maxEntries - 1)
local resume = meta.resume
local jobs = {}
local touched = {}
local work, n = 0, 0
local stopped = nil
for idx, e in ipairs(entries) do
  local office, date, group, si = string.match(e, '^(%d+)|(%d%d%d%d%-%d%d%-%d%d)|(%d+)|(%d+)$')
  local st = nil
  if office then st = meta.stamps[N(si) + 1] end
  local skipping = idx == 1 and type(resume) == 'table' and resume.entry == e
  local last = ''
  if skipping then last = resume.after end
  if st then
    need(KEY.site .. office, 'set')
    local members = redis.call('SMEMBERS', KEY.site .. office)
    table.sort(members)
    for _, m in ipairs(members) do
      local aid, g = string.match(m, '^(.+):(%d+)$')
      if (not skipping or m > resume.after) and g == group then
        if work >= A.maxWork then stopped = { entry = e, after = last } break end
        work = work + 1
        last = m
        need(KEY.alert .. aid, 'hash')
        local a = alert_get(aid)
        local follows = false
        if a then for o in string.gmatch(a.offices, '[^,]+') do if o == office then follows = true end end end
        if a and follows and a.group == group and N(a.order) < meta.order and not is_ended(a) and (a.gone == nil or a.gone == '') then
          local job = jobs[aid]
          if not job then
            job = job_decode(redis.call('HGET', KEY.queue, aid))
            if not job or job.n ~= a.inc then job = { i = aid, n = a.inc, s = {}, d = {} } end
            jobs[aid] = job
            touched[#touched + 1] = aid
          end
          job_merge(job, { s = { st }, d = { { N(office), date, N(group), 0 } } })
        end
      end
    end
  end
  if stopped then break end
  n = n + 1
end
-- Then write.
local dropped = 0
for _, aid in ipairs(touched) do
  local bounded, dr = job_bound(jobs[aid])
  dropped = dropped + dr
  if bounded then
    redis.call('HSET', KEY.queue, aid, cjson.encode(bounded))
    redis.call('ZADD', KEY.queued, oldest_wall(bounded), aid)
  else
    redis.call('HDEL', KEY.queue, aid)
    redis.call('ZREM', KEY.queued, aid)
  end
end
if n > 0 then redis.call('LPOP', fk, n) end
meta.resume = stopped
if redis.call('LLEN', fk) > 0 then redis.call('SET', sk, cjson.encode(meta)) end
if redis.call('LLEN', fk) == 0 then
  redis.call('DEL', fk, sk)
  redis.call('LREM', KEY.fanouts, 0, id)
end
if #touched > 0 then count('fanout_merged', #touched) end
if dropped > 0 then count('dates_dropped_overflow', dropped) end
return cjson.encode({ batch = id, entries = n, work = work })
`,
);

/** One chunk of the second queueing write: up to maxEntries entries of the oldest pending batch, and at most maxWork recipients (stopping inside an entry if need be). */
export function fanoutChunk(kv: Kv, a: { now: number; run: string; maxEntries: number; maxWork: number }): Promise<{ lost?: true; done?: true; batch?: string; entries?: number; work?: number }> {
  return fanoutChunkScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const heldPairsScript = deviceScript(
  'dev-held-pairs',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.ends, 'zset')
local oldest = {}
local order = {}
for _, id in ipairs(redis.call('ZRANGE', KEY.ends, 0, -1)) do
  need(KEY.held .. id, 'string')
  local job = job_decode(redis.call('GET', KEY.held .. id))
  if job then
    for _, d in ipairs(job.d) do
      local k = I(d[1]) .. ':' .. I(d[3])
      local w = stamp_of(job, d).wall
      if oldest[k] == nil then order[#order + 1] = k end
      if oldest[k] == nil or w < oldest[k] then oldest[k] = w end
    end
  end
end
local out = {}
for _, k in ipairs(order) do
  local o, g = string.match(k, '^(%d+):(%d+)$')
  out[#out + 1] = { N(o), N(g), oldest[k] }
end
table.sort(out, function(a, b) if a[3] ~= b[3] then return a[3] < b[3] end if a[1] ~= b[1] then return a[1] < b[1] end return a[2] < b[2] end)
return cjson.encode(out)
`,
  { reclaim: true },
);

/** (office, group, oldest announcement) for every pair with held notification work. Read only. */
export async function heldPairs(kv: Kv): Promise<[number, number, number][]> {
  const out = await heldPairsScript.run<[number, number, number][] | Record<string, never>>(kv, {}, { now: 0 });
  return Array.isArray(out) ? out : [];
}
```

(`cjson.encode` of an empty Lua table gives `{}`, hence the `Array.isArray` guard.)

- [ ] **Step 5: Watch the script tests pass**

Run: `npm test -w @penge/server -- devices-queue`
Expected: PASS. With the throwaway Valkey: `DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- devices-queue` PASS on both.

The lint and compile tests in `devices-lua.test.ts` pick up the new scripts by themselves.

- [ ] **Step 6: Write the failing checker tests**

`apps/server/test/checker-devices.test.ts` (this file grows in Tasks 11 and 12; it shares the checker test world):

```ts
import { describe, expect, it } from 'vitest';
import { type CheckDeps, GROUP_HELD_SHARE, runCheck } from '../src/checker.ts';
import { K } from '../src/keys.ts';
import { choices, seedAlert } from './device-fixtures.ts';
import { clock, FakeMailer, FakeUpstream, keys, MemoryKv, MemorySink, recordingLog } from './helpers.ts';

export async function deviceWorld(overrides: Partial<CheckDeps> = {}) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  const upstream = new FakeUpstream();
  const sink = new MemorySink();
  const mailer = new FakeMailer();
  const { log, lines } = recordingLog();
  const deps: CheckDeps = {
    kv, upstream, sink, mailer, keys, log, publicBaseUrl: 'https://penge.example', mailDailyLimit: 300, alertsPerSubscriberPerDay: 3,
    client: 'penge-passport-ph@test', uptime: () => null, now: t.now, ...overrides,
  };
  let n = 0;
  const run = async () => {
    const report = await runCheck({ ...deps, runId: `run${++n}` });
    t.advance(10 * 60_000);
    return report;
  };
  return { t, kv, upstream, sink, mailer, deps, lines, run };
}

describe('queueing for notification alerts', () => {
  it('writes a fan-out batch with the email write, only for openings some notification alert follows', async () => {
    const w = await deviceWorld();
    await w.run(); // baseline
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) });
    w.upstream.open.set('486', ['2026-10-09']);
    w.upstream.open.set('693', ['2026-10-09']);
    await w.run();
    // The batch was written and, in the same run, turned into a job (Task 12 runs the second write); here: only 486.
    const queue = await w.kv.hGetAll(K.devQueue);
    const jobs = Object.values(queue).map((j) => JSON.parse(j) as { d: unknown[] });
    expect(jobs.flatMap((j) => j.d)).toEqual([[486, '2026-10-09', 1, 0]]);
  });

  it('still queues email when memory is above 85%, without the notification batch, and counts nothing written for it', async () => {
    const w = await deviceWorld();
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) });
    const sub = await (await import('../src/subscribers.ts')).createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap' } as never, w.t.now());
    await (await import('../src/subscribers.ts')).confirm(w.kv, sub, w.t.now());
    w.kv.memoryUse = { used: 90, max: 100 };
    w.upstream.open.set('486', ['2026-10-09']);
    const report = await w.run();
    expect(report.queued).toBe(1); // the email job
    expect(await w.kv.get(K.devFanoutStamps('run2:domestic'))).toBeNull();
    expect(w.lines.some((l) => l.includes('memory above 85%'))).toBe(true);
  });

  it('keeps scanning and emailing when the notification index cannot be read', async () => {
    const w = await deviceWorld();
    await w.run();
    const token = await (await import('../src/subscribers.ts')).createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 2, pace: 'asap' } as never, w.t.now());
    await (await import('../src/subscribers.ts')).confirm(w.kv, token, w.t.now());
    await w.kv.set(K.devSite(486), 'not a set');
    w.upstream.open.set('486', ['2026-10-09']);
    w.upstream.open.set('486:2', ['2026-10-09']);
    const report = await w.run();
    expect(report.healthy).toBe(true);
    expect(w.sink.scans.at(-1)!.groups.some((g) => g.siteId === 486 && g.applicants === 2 && g.ok)).toBe(true);
  });

  it('records a scan as unchanged when only lookup times differ', async () => {
    const { runContentForTest } = await import('../src/record.ts');
    const base = { source: { host: 'h', client: 'c' }, healthy: true, problems: [] };
    const a = runContentForTest({ ...base, groups: [{ siteId: 1, applicants: 2, ok: true, error: null, openDates: [], fetchedAt: '2026-10-06T00:00:00Z' }] });
    const b = runContentForTest({ ...base, groups: [{ siteId: 1, applicants: 2, ok: true, error: null, openDates: [], fetchedAt: '2026-10-06T00:05:00Z' }] });
    expect(a).toBe(b);
  });

  it('looks up group sizes notification alerts follow, as it does for email subscribers', async () => {
    const w = await deviceWorld();
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486], applicants: 3 }) });
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(w.sink.scans.at(-1)!.groups).toEqual([expect.objectContaining({ siteId: 486, applicants: 3, ok: true, fetchedAt: expect.any(String) })]);
  });

  it('gives at most 6 of 10 group lookups to pairs with held work, oldest first, and the rest in turn', async () => {
    const w = await deviceWorld();
    expect(GROUP_HELD_SHARE).toBe(6);
    // 12 pairs: offices 486 and 693 (and the other fake offices), group sizes 2..5, with held work on 8 of them.
    // (Fixture detail: the FakeUpstream offices; open a date at each, seed an alert per pair, held jobs on 8.)
    const offices = w.upstream.sitesList.map((s) => s.id);
    let held = 0;
    for (const office of offices) {
      w.upstream.open.set(String(office), ['2026-10-09']);
      for (const applicants of [2, 3, 4]) {
        const a = await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [office], applicants }) });
        if (held < 8) {
          await w.kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: (await w.kv.hGetAll(K.devAlert(a.id))).inc, s: [{ wall: w.t.now() - held }], d: [[office, '2026-10-09', applicants, 0]] }));
          held++;
        }
      }
    }
    await w.run();
    const looked = w.sink.scans.at(-1)!.groups.filter((g) => g.ok);
    expect(looked).toHaveLength(10);
    const heldLooked = looked.filter((g) => offices.indexOf(g.siteId) * 3 + [2, 3, 4].indexOf(g.applicants) < 8);
    expect(heldLooked).toHaveLength(6);
    // The next run starts the others where this one stopped.
    expect(await w.kv.get(K.scanGroupCursor)).not.toBeNull();
  });
});
```

`FakeUpstream.sitesList` is the fake's office list (`grep -n "sitesList" apps/server/test/helpers.ts`; it exists since the abroad tests; if it is named differently, use that name).

- [ ] **Step 7: Watch them fail**

Run: `npm test -w @penge/server -- checker-devices`
Expected: FAIL: no `pp:dev:queue` entry (no batch is written), no group lookup for size 3, `GROUP_HELD_SHARE` undefined.

- [ ] **Step 8: The Node side of queueing**

`apps/server/src/devices/queue.ts`:

```ts
// Queueing for notification alerts (spec: "Headroom", "Queueing is two writes"). The first write is the email
// write plus a fan-out batch; if it fails with the batch, it is retried once without it (the notification work
// dropped and counted). The second write turns batches into merged jobs, in chunks, within a time budget.
import type { Stamp } from '../clock.ts';
import { K } from '../keys.ts';
import type { Kv, WriteOp } from '../kv.ts';
import type { Logger } from '../log.ts';
import { fanoutChunk, LostLock, queueWrite } from './scripts-delivery.ts';

export const FANOUT_MAX_ENTRIES = 2000;
export const FANOUT_MAX_PENDING = 5;
export const CHUNK_ENTRIES = 100;
/** Recipients merged per chunk at most: measured (devices-queue.test.ts) to keep a chunk under 50 ms at the ceiling. */
export const CHUNK_WORK = 200;
export const FANOUT_BUDGET_MS = 10_000;
/** Above this share of maxmemory, the first write goes without its batch. */
export const MEMORY_SKIP = 0.85;

/** One entry per office, date and group size some notification alert follows: "<office>|<date>|<group>|0". */
export async function fanoutEntries(kv: Kv, openings: { siteId: number; applicants: number; dates: string[] }[]): Promise<string[]> {
  const followed = new Map<number, Set<string>>();
  const entries: string[] = [];
  for (const o of openings) {
    let groups = followed.get(o.siteId);
    if (!groups) {
      groups = new Set((await kv.sMembers(K.devSite(o.siteId))).map((m) => m.slice(m.lastIndexOf(':') + 1)));
      followed.set(o.siteId, groups);
    }
    if (!groups.has(String(o.applicants))) continue;
    for (const date of o.dates) entries.push(`${o.siteId}|${date}|${o.applicants}|0`);
  }
  return entries;
}

export async function writeQueue(
  deps: { kv: Kv; log: Logger; now: () => number; stats?: { count(name: string, by?: number): void } },
  a: { run: string; ops: WriteOp[]; batchId: string; stamp: Stamp; openings: { siteId: number; applicants: number; dates: string[] }[] },
): Promise<void> {
  const { kv, log } = deps;
  let entries: string[] = [];
  try {
    entries = await fanoutEntries(kv, a.openings);
  } catch (err) {
    log.warn('notification fan-out not computed; email goes on', { run: a.run, err: err as Error });
  }
  let batch = entries.length > 0 ? { id: a.batchId, entries, stamps: [a.stamp] } : null;
  if (batch && entries.length > FANOUT_MAX_ENTRIES) {
    log.warn('notification fan-out too large; dropped', { run: a.run, entries: entries.length });
    batch = null;
  }
  if (batch) {
    const mem = await kv.memory().catch(() => ({ used: 0, max: 0 }));
    if (mem.max > 0 && mem.used / mem.max > MEMORY_SKIP) {
      log.warn('memory above 85%: notification fan-out dropped', { run: a.run, entries: entries.length });
      batch = null;
    }
  }
  try {
    await queueWrite(kv, { now: deps.now(), run: a.run, mark: a.batchId, ops: a.ops, batch });
  } catch (err) {
    if (err instanceof LostLock || !batch) throw err;
    log.error('queueing with the notification fan-out failed; retrying without it', { run: a.run, entries: entries.length, err: err as Error });
    await queueWrite(kv, { now: deps.now(), run: a.run, mark: a.batchId, ops: a.ops, batch: null });
  }
}

/** The second write: pending batches, oldest first, chunk by chunk, until done or `until`. Yields between chunks. */
export async function writeFanout(deps: { kv: Kv; now: () => number }, a: { run: string; until: number }): Promise<{ chunks: number; merged: number }> {
  let chunks = 0;
  let merged = 0;
  while (deps.now() < a.until) {
    const r = await fanoutChunk(deps.kv, { now: deps.now(), run: a.run, maxEntries: CHUNK_ENTRIES, maxWork: CHUNK_WORK });
    if (r.lost) throw new LostLock();
    if (r.done) break;
    chunks++;
    merged += r.work ?? 0;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { chunks, merged };
}
```

- [ ] **Step 9: Change the checker**

In `apps/server/src/snapshot.ts`, `GroupObservation` gains:

```ts
  /** When the lookup answered (Availability.fetchedAt): a notification says when its dates were checked. */
  fetchedAt?: string | null;
```

In `apps/server/src/checker.ts`:

1. Imports: `import { heldPairs } from './devices/scripts-delivery.ts';` and `import { writeQueue } from './devices/queue.ts';`.

2. Constants after `GROUP_QUERY_CAP`:

```ts
/** Of a run's group lookups, at most this many go to pairs with held work waiting for verification; the rest in turn. */
export const GROUP_HELD_SHARE = 6;
/** The same for the posts abroad: at most half of ABROAD_GROUP_CAP. */
export const ABROAD_HELD_SHARE = 2;
```

3. In `queueAlerts`, replace the final write `ops.push({ op: 'rPush', … }); await kv.write(ops);` with:

```ts
  ops.push({ op: 'rPush', key: K.outbox, values: [...jobs.values()].map((j) => sealJob(j, deps.keys.token)) });
  await writeQueue(
    { kv, log, now },
    { run: scan.runId, ops, batchId: `${scan.runId}:${kind}`, stamp: queued, openings: openings.map((o) => ({ siteId: o.site.id, applicants: o.applicants, dates: o.dates })) },
  );
```

and `queueAlerts` gains a parameter `kind: 'domestic' | 'abroad'` (the domestic call passes `'domestic'`, `abroadPass` passes `'abroad'`).

4. Replace `scanGroups` with (same signature plus `held` and `cursorKey`):

```ts
/**
 * A date with room for 3 people has room for 1, so group sizes need their own lookup only at offices that have
 * room for 1 and are followed for more, by email subscribers or notification alerts. When there are more pairs than
 * lookups, at most `heldShare` go to pairs with held work waiting for verification (oldest first), and the rest to the
 * others in turn from `cursorKey`; a share one side cannot use passes to the other. Lookups not made are recorded as
 * skipped.
 */
async function scanGroups(
  deps: CheckDeps,
  upstream: Pick<Upstream, 'availability'>,
  sites: SiteObservation[],
  loadSubscriber: LoadSubscriber,
  cap: number,
  heldShare: number,
  cursorKey: string,
  more: () => boolean = () => true,
) {
  const { kv } = deps;
  const pairs: { site: SiteObservation; applicants: number; key: string }[] = [];
  for (const site of sites) {
    if (!site.ok || site.openDates.length === 0) continue;
    const sizes = new Set<number>();
    for (const id of await kv.sMembers(K.siteSubscribers(site.id))) {
      const sub = await loadSubscriber(id);
      if (sub && sub.applicants > 1) sizes.add(sub.applicants);
    }
    // Notification demand never stops a scan: a failure here leaves email's sizes, and is logged.
    for (const m of await kv.sMembers(K.devSite(site.id)).catch((err: unknown) => {
      deps.log.warn('notification demand could not be read; group lookups go on for email', { site: site.id, err: err as Error });
      return [] as string[];
    })) {
      const size = Number(m.slice(m.lastIndexOf(':') + 1));
      if (size > 1) sizes.add(size);
    }
    for (const applicants of [...sizes].sort((a, b) => a - b)) pairs.push({ site, applicants, key: `${site.id}:${applicants}` });
  }
  // Pairs with held work, oldest first: email's held alerts and notification alerts' held jobs.
  const heldAt = new Map<string, number>();
  const note = (key: string, wall: number) => heldAt.set(key, Math.min(heldAt.get(key) ?? Infinity, wall));
  for (const id of await kv.sMembers(K.heldSubscribers)) {
    const raw = await kv.get(K.held(id));
    const job = raw === null ? null : openJob(raw, deps.keys.token);
    if (!job) continue;
    for (const o of job.openings) note(`${o.id}:${job.applicants}`, job.createdAt);
  }
  for (const [office, group, wall] of await heldPairs(kv).catch(() => [] as [number, number, number][])) note(`${office}:${group}`, wall);
  const held = pairs.filter((p) => heldAt.has(p.key)).sort((a, b) => heldAt.get(a.key)! - heldAt.get(b.key)!);
  const others = pairs.filter((p) => !heldAt.has(p.key)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const cursor = await kv.get(cursorKey);
  const from = cursor === null ? 0 : Math.max(0, others.findIndex((p) => p.key > cursor));
  const rotated = [...others.slice(from), ...others.slice(0, from)];
  const otherTake = Math.min(rotated.length, cap - Math.min(held.length, heldShare));
  const heldTake = Math.min(held.length, cap - otherTake);
  // The order lookups are made in: held work oldest first, then the others in turn from the cursor.
  const schedule = [...held.slice(0, heldTake), ...rotated.slice(0, otherTake)];
  const othersKeys = new Set(others.map((p) => p.key));

  const results = new Map<string, GroupObservation>();
  let stop: string | null = null;
  // The cursor moves past the last of the others actually asked, so one cut short by the deadline is first next run.
  let lastOtherAsked: string | null = null;
  for (const { site, applicants, key } of schedule) {
    const skip = (error: string) => results.set(key, { siteId: site.id, applicants, ok: false, error, openDates: [], fetchedAt: null });
    if (stop) {
      skip(stop);
      continue;
    }
    if (!more()) {
      skip('skipped: the run ran out of time');
      continue;
    }
    if (othersKeys.has(key)) lastOtherAsked = key;
    try {
      const a = await upstream.availability({ siteId: site.id, applicants });
      results.set(key, { siteId: site.id, applicants, ok: true, error: null, openDates: [...a.availableDates].sort(), fetchedAt: a.fetchedAt });
    } catch (err) {
      skip(message(err));
      if (err instanceof CircuitOpenError) stop = 'skipped: the rate limiter paused requests';
    }
  }
  if (lastOtherAsked !== null) await kv.set(cursorKey, lastOtherAsked);
  // Every pair is reported, in the catalogue's order; one not scheduled was over the cap.
  const groups: GroupObservation[] = pairs.map(
    ({ site, applicants, key }) => results.get(key) ?? { siteId: site.id, applicants, ok: false, error: `skipped: more than ${cap} group lookups this run`, openDates: [], fetchedAt: null },
  );
  return groups;
}
```

The two callers become `scanGroups(deps, deps.upstream, sites, loadSubscriber, GROUP_QUERY_CAP, GROUP_HELD_SHARE, K.scanGroupCursor)` and `scanGroups(deps, upstream, sites, loadSubscriber, ABROAD_GROUP_CAP, ABROAD_HELD_SHARE, K.scanAbroadCursor, more)`.

A test of the rotation when the deadline cuts a run short, in `apps/server/test/checker-devices.test.ts` (export `scanGroups` from `checker.ts` for it, as `scanGroupsForTest`):

```ts
  it('asks every followed pair in turn across runs, even when time allows only one lookup a run', async () => {
    const w = await deviceWorld({ devices: { mode: 'live', transport: null } });
    // Eight pairs: four offices, each followed for 2 and 3 people.
    const sites = [10, 20, 30, 40].map((id) => ({ id, ok: true, openDates: ['2026-10-09'] }) as never);
    for (const id of [10, 20, 30, 40]) for (const g of [2, 3]) await w.kv.write([{ op: 'sAdd', key: K.devSite(id), members: [`a${id}${g}:${g}`] }]);
    const asked: string[] = [];
    const upstream = { availability: async (q: { siteId: number; applicants: number }) => (asked.push(`${q.siteId}:${q.applicants}`), { availableDates: [], fetchedAt: new Date().toISOString() }) };
    for (let run = 0; run < 8; run++) {
      let budget = 1;
      await scanGroupsForTest(w.deps, upstream as never, sites, async () => null, 4, 0, K.scanAbroadCursor, () => budget-- > 0);
    }
    expect(new Set(asked).size).toBe(8); // every pair asked once in eight runs
  });
```

(`w.deps` is the world's `CheckDeps`; add it to `deviceWorld`'s return if it is not there.)

5. `deliveryChecks` keeps every size's time:

```ts
type DeliveryCheck = { checkedAt: string; dates: Map<number, Set<string>>; times: Map<number, string> };

function deliveryChecks(scans: readonly DeliveryScan[]): Map<number, DeliveryCheck> {
  const checks = new Map<number, DeliveryCheck>();
  for (const scan of scans) {
    if (!scan.healthy) continue;
    for (const site of scan.sites) {
      if (!site.ok || !site.fetchedAt || !Number.isFinite(Date.parse(site.fetchedAt))) continue;
      checks.set(site.id, { checkedAt: site.fetchedAt, dates: new Map([[1, new Set(site.openDates)]]), times: new Map([[1, site.fetchedAt]]) });
    }
    for (const group of scan.groups) {
      const check = checks.get(group.siteId);
      if (!group.ok || !check) continue;
      check.dates.set(group.applicants, new Set(group.openDates));
      // Older group records have no time of their own: the office's stands in.
      check.times.set(group.applicants, group.fetchedAt && Number.isFinite(Date.parse(group.fetchedAt)) ? group.fetchedAt : check.checkedAt);
    }
  }
  return checks;
}
```

Export `deliveryChecks` and `DeliveryCheck` (Task 11 uses them).

6. In `abroadPass`, a post is "followed" if either kind of alert follows it (spec: "A run"): the `followed` loop becomes

```ts
  for (const o of observations) {
    const byEmail = (await kv.sMembers(K.siteSubscribers(o.id))).length > 0;
    const byDevice = !byEmail && (await kv.sMembers(K.devSite(o.id)).catch(() => [] as string[])).length > 0;
    if (byEmail || byDevice) followed.add(o.id);
  }
```

7. `apps/server/src/record.ts`, `runContent`: lookup times are not content, so a group's `fetchedAt` is left out of the comparison (the record still stores it); export it for the test as `export const runContentForTest = runContent;`:

```ts
  const groups = [...run.groups].map(({ fetchedAt: _t, ...g }) => g).sort((a, b) => a.siteId - b.siteId || a.applicants - b.applicants);
```

- [ ] **Step 10: Watch everything pass**

Run: `npm test -w @penge/server -- checker-devices checker devices-queue`
Expected: PASS, except the first `checker-devices` case's last assertion, which needs the second write (Task 12 runs it in the notification pass). Until Task 12, that case asserts the batch instead: replace its last two lines with

```ts
    expect(await w.kv.get(K.devFanoutStamps('run2:domestic'))).not.toBeNull();
```

and Task 11 Step 10 restores the job assertion, creating that case's world with `deviceWorld({ devices: { mode: 'live', transport: null } })` so the notification pass runs the second write (with no transport, it writes the jobs and sends nothing).

Run: `npm test -w @penge/server`
Expected: PASS (the restored email tests are unchanged in behaviour: the queueing write applies the same operations).

- [ ] **Step 11: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review: the checker's queueing write as a lock-checked script that also stores a bounded notification fan-out batch, its retry without the batch, the chunked second write with the activation-order recipient rule, job merging and bounds, and fair group lookups shared by email and notification alerts. Check that email queueing can never be blocked or changed by the notification side (memory, a full batch list, a failing script), that a date is never merged twice or its stamp replaced, and that the 30-date / 4 KB bounds hold for every merge."). Then:

```bash
git add apps/server/src/devices apps/server/src/checker.ts apps/server/src/snapshot.ts apps/server/test/devices-queue.test.ts apps/server/test/checker-devices.test.ts apps/server/test/devices-lua.test.ts
git commit -m "Queueing in two writes with notification fan-out batches; fair group lookups for both kinds"
```

---
### Task 11: The notification pass: claims, the send gate, settlement, and the run's three passes

**Files:**
- Create: `apps/server/src/devices/claims-lua.ts` (put back and give back, in Lua), `apps/server/src/devices/lock.ts` (atomic lock renewal and release, a heartbeat), `apps/server/src/devices/delivery.ts` (the pass)
- Modify: `apps/server/src/devices/scripts-delivery.ts` (work list, claim, send gate, settle), `apps/server/src/push/payload.ts` ("Checked <time>"), `apps/server/src/checker.ts` (lock scripts, orchestration, `CheckDeps.devices`, `RunReport.devices`), `apps/server/src/check.ts` (the transport)
- Test: `apps/server/test/devices-claims.test.ts`, `apps/server/test/checker-devices.test.ts` (more cases), `apps/server/test/payload.test.ts`

**Interfaces:**
- Consumes: Task 10's `DELIVERY_LIB`, job format, `writeFanout`, `deliveryChecks`/`DeliveryCheck`; Task 8's `Transport`, `SendSlots`, `CHECKER_SLOTS`, `loggable`; Task 7's alert record and `alert_delete`; Task 6's `openSubscription`.
- Produces:
  - lock.ts: `acquireLock(kv, run, ttlSeconds): Promise<boolean>`, `renewLock(kv, run, ttlSeconds): Promise<boolean>`, `releaseLock(kv, run): Promise<void>`, `heartbeat(kv, run, ttlSeconds, everyMs?): { stop(): void; lost(): boolean }`.
  - scripts-delivery.ts: `workList(kv): Promise<string[]>` (alive alerts with held or queued work, sorted); `claim(kv, a: ClaimInput): Promise<ClaimAnswer>`; `sendGate(kv, a: { now; run; id; cid; stamp; modeOk: boolean; svc: string }): Promise<{ go: true; sub: string } | { go: false; why: string }>`; `settle(kv, a: { now; run; id; cid; stamp; result: SendResult['kind']; backoffUntil: number | null }): Promise<{ ok: boolean; outcome?: string }>`.
  - `ClaimInput = { now: number; run: string; id: string; cid: string; stamp: Stamp; day: string; cap: number; batch: 'domestic' | 'abroad'; open: Record<string, { d: string[]; at: number }>; abroad: Record<string, true> }` — `open` keyed `"<office>|<group>"`: the dates this run verified open for that pair and when (ms; the older of the office's and the group's lookups).
  - `ClaimAnswer = { ok: true; job: Job; checked: number } | { ok: false; why: 'lost' | 'none' | 'ended' | 'claimed' | 'attempted' | 'empty' | 'deferred' | 'unverified' | 'pace' | 'cap' }`.
  - claims-lua.ts `CLAIM_LIB`: `give_back(id, c)`, `put_back(id, c, a, refusal)`.
  - delivery.ts: `notificationPass(deps: PassDeps, ctx: { run: string; scan: DeliveryScan; abroadReady: Promise<DeliveryScan | null> }): Promise<DevicePassReport>`; `BATCH_SENDING_MS = 60_000`; `DevicePassReport = { fanout: { chunks: number; merged: number }; domestic: BatchReport; abroad: BatchReport }`, `BatchReport = { considered: number; claimed: number; accepted: number; refused: number; uncertain: number; gone: number; stoppedBy: 'paused' | 'rejected' | 'deadline' | 'mode' | null }`.
  - `buildPayload(a: { openings: Opening[]; applicants: number; decisionId: string; checkedAt: number | null }): string` (adds "Checked HH:MM", Manila time).
  - `CheckDeps.devices?: { mode: PushMode; transport: Transport | null }`; `RunReport.devices: DevicePassReport | null`.
  - Pace: `PACE_SPACING_MS` (checker.ts) is used for notification alerts too.

- [ ] **Step 1: Write the failing script tests**

`apps/server/test/devices-claims.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { claim, type ClaimInput, sendGate, settle, workList } from '../src/devices/scripts-delivery.ts';
import { choices, opId, seedAlert } from './device-fixtures.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
const DAY = '2026-10-06';
type Kv = Parameters<typeof claim>[0];

async function withWork(kv: Kv, o: { pace?: 'asap' | 'hourly'; dates?: string[]; wall?: number; office?: number } = {}) {
  const a = await seedAlert(kv, { now: T0, order: 0, choices: choices({ siteIds: [o.office ?? 486], pace: o.pace ?? 'asap' }) });
  const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
  const dates = o.dates ?? ['2026-10-09'];
  await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [a.id]: JSON.stringify({ i: a.id, n: inc, s: [{ wall: o.wall ?? T0 }], d: dates.map((d) => [o.office ?? 486, d, 1, 0]) }) } }]);
  await kv.set(K.checkLock, 'r1');
  return { ...a, inc };
}
const input = (id: string, o: Partial<ClaimInput> = {}): ClaimInput => ({
  now: T0 + 1000, run: 'r1', id, cid: opId(), stamp: { wall: T0 + 1000 }, day: DAY, cap: 3, batch: 'domestic',
  open: { '486|1': { d: ['2026-10-09'], at: T0 + 500 } }, abroad: {}, ...o,
});

for (const [name, make] of valkeyTargets()) {
  describe(`claims on ${name}`, () => {
    it('claims only dates verified open in this run, charges the day and sets the pace stamp', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: ['2026-10-09', '2026-10-10'] });
      const c = input(a.id);
      const r = await claim(kv, c);
      expect(r).toMatchObject({ ok: true, checked: T0 + 500, job: { d: [[486, '2026-10-09', 1, 0]] } });
      expect(await kv.get(K.devToday(a.id, DAY))).toBe('1');
      expect(JSON.parse((await kv.get(K.devLast(a.id)))!)).toEqual({ wall: T0 + 1000 });
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-10', 1, 0]]); // the rest waits
      expect(await kv.hGetAll(K.devQueue)).toEqual({});
      expect(await claim(kv, input(a.id))).toEqual({ ok: false, why: 'claimed' });
    });

    it.each([
      ['its pace', async (kv: Kv, id: string) => kv.set(K.devLast(id), JSON.stringify({ wall: T0 })), 'pace'],
      ['its daily cap', async (kv: Kv, id: string) => kv.set(K.devToday(id, DAY), '3'), 'cap'],
      ['an attempt already this run', async (kv: Kv, id: string) => kv.write([{ op: 'hSet', key: K.devTried(id), fields: { run: 'r1' } }]), 'attempted'],
    ])('refuses for %s, keeping the work held with its original time', async (_, prepare, why) => {
      const kv = await make();
      const a = await withWork(kv);
      await prepare(kv, a.id);
      expect(await claim(kv, input(a.id))).toEqual({ ok: false, why });
      if (why !== 'attempted') expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).s).toEqual([{ wall: T0 }]);
    });

    it('drops dates past their 3-hour window and dates whose age cannot be known', async () => {
      const kv = await make();
      const a = await withWork(kv, { wall: T0 - 3 * 3600_000 - 1 });
      expect(await claim(kv, input(a.id))).toEqual({ ok: false, why: 'empty' });
      const b = await withWork(kv, { office: 486 });
      await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [b.id]: JSON.stringify({ i: b.id, n: b.inc, s: [{ wall: T0, up: 5, boot: 'old' }], d: [[486, '2026-10-09', 1, 0]] }) } }]);
      expect(await claim(kv, input(b.id, { stamp: { wall: T0 + 1000, up: 9, boot: 'new' } }))).toEqual({ ok: false, why: 'empty' });
      expect((await kv.hGetAll(K.statsV2(DAY))).dates_dropped_unknown_age).toBe('1');
    });

    it('in the domestic batch, defers an alert whose oldest waiting date is abroad and older', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: ['2026-10-09'] });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: a.inc, s: [{ wall: T0 - 60_000 }], d: [[9001, '2026-10-20', 1, 0]] }));
      await kv.write([{ op: 'hSet', key: K.devAlert(a.id), fields: { offices: '486,9001' } }]);
      expect(await claim(kv, input(a.id, { abroad: { '9001': true } }))).toEqual({ ok: false, why: 'deferred' });
      // The abroad batch sends both.
      const r = await claim(kv, input(a.id, { batch: 'abroad', abroad: { '9001': true }, open: { '486|1': { d: ['2026-10-09'], at: T0 }, '9001|1': { d: ['2026-10-20'], at: T0 } } }));
      expect(r.ok && r.job.d).toHaveLength(2);
    });

    it('puts a claim back unattempted when the gate fails, restoring count and pace, without a try', async () => {
      const kv = await make();
      const a = await withWork(kv);
      await kv.set(K.devLast(a.id), JSON.stringify({ wall: T0 - 3600_000 }));
      const c = input(a.id);
      await claim(kv, c);
      await kv.set(K.pushPaused, '1');
      expect(await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' })).toEqual({ go: false, why: 'paused' });
      expect(await kv.get(K.devToday(a.id, DAY))).toBe('0');
      expect(JSON.parse((await kv.get(K.devLast(a.id)))!)).toEqual({ wall: T0 - 3600_000 });
      expect(await kv.hGetAll(K.devTried(a.id))).toEqual({});
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-09', 1, 0]]);
    });

    it('passes the gate once, with the sealed subscription, and moves the claim to sending', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      const g = await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      expect(g).toMatchObject({ go: true, sub: expect.stringMatching(/^v2\./) });
      expect((await kv.hGetAll(K.devClaim(a.id))).state).toBe('sending');
      expect(await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' })).toMatchObject({ go: false });
    });

    it.each([
      ['accepted', { claim: false, today: '1', held: false }],
      ['uncertain', { claim: false, today: '1', held: false }],
      ['bug', { claim: false, today: '0', held: false }],
      ['refused', { claim: false, today: '0', held: true }],
      ['throttled', { claim: false, today: '0', held: true }],
      ['rejected', { claim: false, today: '0', held: true }],
    ] as const)('settles %s', async (result, want) => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      expect(await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: opId(), stamp: c.stamp, result, backoffUntil: null })).toEqual({ ok: false });
      expect((await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, result, backoffUntil: result === 'throttled' ? T0 + 60_000 : null })).ok).toBe(true);
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual({});
      expect(await kv.get(K.devToday(a.id, DAY))).toBe(want.today);
      expect((await kv.get(K.devHeld(a.id))) !== null).toBe(want.held);
      if (want.held) expect((await kv.hGetAll(K.devTried(a.id)))['486|2026-10-09|1']).toBe('1');
      if (result === 'throttled') expect(await kv.get(K.pushBackoff('fcm'))).toBe(String(T0 + 60_000));
    });

    it('settles gone for the current generation by deleting the alert, keeping no work', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      expect(await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, result: 'gone', backoffUntil: null })).toEqual({ ok: true, outcome: 'deleted' });
      expect(await kv.hGetAll(K.devAlert(a.id))).toEqual({});
      expect(await kv.hGetAll(K.devEnded(a.hash))).toMatchObject({ reason: 'gone' });
    });

    it('drops a date after its third refused try', async () => {
      const kv = await make();
      const a = await withWork(kv);
      for (let i = 0; i < 3; i++) {
        const c = input(a.id, { run: `r${i}` });
        await kv.set(K.checkLock, `r${i}`);
        await kv.set(K.devLast(a.id), JSON.stringify({ wall: 0 })); // pace allows
        expect((await claim(kv, c)).ok).toBe(true);
        await sendGate(kv, { now: T0 + 1000, run: `r${i}`, id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
        await settle(kv, { now: T0 + 2000, run: `r${i}`, id: a.id, cid: c.cid, stamp: c.stamp, result: 'refused', backoffUntil: null });
      }
      expect(await kv.get(K.devHeld(a.id))).toBeNull();
      expect((await kv.hGetAll(K.statsV2(DAY))).dates_dropped_tries).toBe('1');
    });

    it('never settles for a run that lost the lock: the claim stays for the next run to recover', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const c = input(a.id);
      await claim(kv, c);
      await sendGate(kv, { now: T0 + 1000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, modeOk: true, svc: 'fcm' });
      await kv.set(K.checkLock, 'r2');
      expect(await settle(kv, { now: T0 + 2000, run: 'r1', id: a.id, cid: c.cid, stamp: c.stamp, result: 'refused', backoffUntil: null })).toEqual({ ok: false });
      expect((await kv.hGetAll(K.devClaim(a.id))).state).toBe('sending');
    });

    it('bounds the merged held and queued work before claiming: at most 30 dates', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`) });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: a.inc, s: [{ wall: T0 - 1000 }], d: Array.from({ length: 30 }, (_, i) => [486, `2026-12-${String(i + 1).padStart(2, '0')}`, 1, 0]) }));
      const all = [...Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 30 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`)];
      const r = await claim(kv, input(a.id, { open: { '486|1': { d: all, at: T0 } } }));
      expect(r.ok && r.job.d.length).toBe(30);
      expect((await kv.hGetAll(K.statsV2(DAY))).dates_dropped_overflow).toBe('30');
    });

    it('stops at a damaged pace stamp before changing anything', async () => {
      const kv = await make();
      const a = await withWork(kv);
      await kv.set(K.devLast(a.id), 'not json');
      await expect(claim(kv, input(a.id))).rejects.toThrow(/pace stamp/);
      expect(Object.keys(await kv.hGetAll(K.devQueue))).toEqual([a.id]);
    });

    it('stops at a pace stamp with a wrong uptime, or a run stamp without a wall time, before changing anything', async () => {
      const kv = await make();
      const a = await withWork(kv);
      await kv.set(K.devLast(a.id), JSON.stringify({ wall: T0 - 1000, up: 'x', boot: 'b' }));
      await expect(claim(kv, input(a.id))).rejects.toThrow(/pace stamp/);
      await kv.write([{ op: 'del', key: K.devLast(a.id) }]);
      await expect(claim(kv, input(a.id, { stamp: { up: 5, boot: 'b' } as never }))).rejects.toThrow(/stamp/);
      expect(Object.keys(await kv.hGetAll(K.devQueue))).toEqual([a.id]);
    });

    it('treats held work whose date points at no stamp as no work', async () => {
      const kv = await make();
      const a = await withWork(kv, { dates: [] });
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: a.inc, s: [{ wall: T0 - 1000 }], d: [[486, '2026-12-01', 1, 3]] }));
      expect(await claim(kv, input(a.id))).toMatchObject({ ok: false });
    });

    it('lists the alerts with work, sorted', async () => {
      const kv = await make();
      const a = await withWork(kv);
      const b = await withWork(kv);
      expect(await workList(kv)).toEqual([a.id, b.id].sort());
    });
  });
}
```

`apps/server/test/payload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPayload } from '../src/push/payload.ts';

describe('an alert notification', () => {
  it('says when its dates were checked, in Manila time', () => {
    const p = JSON.parse(buildPayload({ openings: [{ id: 486, name: 'Antipolo', dates: ['2026-10-09'] }], applicants: 2, decisionId: 'd1', checkedAt: Date.parse('2026-10-06T02:42:00Z') }));
    expect(p).toMatchObject({ v: 1, title: 'Dates open at Antipolo', tag: 'alert-d1', url: { office: 486, date: '2026-10-09', people: 2 } });
    expect(p.body).toBe('Fri 9 Oct · for 2 people · Checked 10:42');
  });

  it('keeps the largest real alert under 3,000 bytes: 10 offices abroad with long names, 5 people, 30 dates', () => {
    const name = 'Ciudad Autónoma de Buenos Aires (Philippine Embassy in the Argentine Republic, Argentina)';
    const openings = Array.from({ length: 10 }, (_, i) => ({ id: 9000 + i, name: `${name} ${i}`, dates: Array.from({ length: 3 }, (_, j) => `2026-11-${String(i * 3 + j + 1).padStart(2, '0')}`) }));
    const p = buildPayload({ openings, applicants: 5, decisionId: 'x'.repeat(22), checkedAt: Date.parse('2026-10-06T02:42:00Z') });
    expect(Buffer.byteLength(p)).toBeLessThan(3000);
    expect(JSON.parse(p).title).toBe('Dates open at 10 offices');
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- devices-claims payload`
Expected: FAIL: `claim` is not exported; `buildPayload` has no "Checked".

- [ ] **Step 3: The claim library**

`apps/server/src/devices/claims-lua.ts`:

```ts
// Putting a claim back (spec: "Claims and sending", step 4). Appended after STORE_LIB and DELIVERY_LIB.
export const CLAIM_LIB = `
local MAX_TRIES = 3
-- Today's count goes down on the claim's charged day, only if that counter still exists and never below zero.
local function give_back(id, c)
  local tk = KEY.today .. id .. ':' .. c.day
  local v = tonumber(redis.call('GET', tk) or '')
  if v ~= nil and v > 0 then redis.call('DECR', tk) end
end
-- The claim's dates go back into the alert's current held work (filtered, original times kept); its count is given
-- back; its pace stamp is restored only if it still holds this claim's stamp. As a refusal each date's tries go up
-- (dropped after MAX_TRIES); unattempted, tries are untouched and the run's attempt mark is removed.
local function put_back(id, c, a, refusal, nowst)
  local job = job_decode(c.job)
  if a and job and job.n == a.inc then
    local back = {}
    for _, d in ipairs(job.d) do
      if refusal then
        local k = dkey(d)
        local t = (tonumber(redis.call('HGET', KEY.tried .. id, k) or '0') or 0) + 1
        if t >= MAX_TRIES then
          redis.call('HDEL', KEY.tried .. id, k)
          count('dates_dropped_tries')
        else
          redis.call('HSET', KEY.tried .. id, k, t)
          back[#back + 1] = d
        end
      else
        back[#back + 1] = d
      end
    end
    local held = job_decode(redis.call('GET', KEY.held .. id))
    if not held or held.n ~= a.inc then held = { i = id, n = a.inc, s = {}, d = {} } end
    if #back > 0 then job_merge(held, job_with(job, back)) end
    local pruned, drop = job_prune(held, a, nowst)
    count_drops(drop)
    local bounded = nil
    if pruned then
      local dr
      bounded, dr = job_bound(pruned)
      if dr > 0 then count('dates_dropped_overflow', dr) end
    end
    if bounded then redis.call('SET', KEY.held .. id, cjson.encode(bounded)) else redis.call('DEL', KEY.held .. id) end
  end
  give_back(id, c)
  if redis.call('GET', KEY.last .. id) == c.at then
    if c.prev ~= '' then redis.call('SET', KEY.last .. id, c.prev) else redis.call('DEL', KEY.last .. id) end
  end
  if not refusal and redis.call('HGET', KEY.tried .. id, 'run') == c.run then redis.call('HDEL', KEY.tried .. id, 'run') end
  redis.call('DEL', KEY.claim .. id)
  if refusal then count('claims_refused') else count('claims_unattempted') end
end
`;
```

- [ ] **Step 4: The claim, gate and settle scripts**

Append to `apps/server/src/devices/scripts-delivery.ts` (import `CLAIM_LIB` and `type SendResult`):

```ts
const ALL_LIBS = `${STORE_LIB}${DELIVERY_LIB}${CLAIM_LIB}`;
// Every key a delivery step may touch for one alert, type-checked before the first write.
const NEED_ALERT = `
local function need_alert(id)
  need(KEY.alert .. id, 'hash') need(KEY.held .. id, 'string') need(KEY.claim .. id, 'hash') need(KEY.last .. id, 'string')
  need(KEY.tried .. id, 'hash') need(KEY.queue, 'hash') need(KEY.queued, 'zset') need(KEY.lock, 'string')
end
`;

export const workListScript = deviceScript(
  'dev-work-list',
  `${ALL_LIBS}
need(KEY.ends, 'zset') need(KEY.queue, 'hash')
local seen, out = {}, {}
for _, id in ipairs(redis.call('HKEYS', KEY.queue)) do if not seen[id] then seen[id] = true out[#out + 1] = id end end
for _, id in ipairs(redis.call('ZRANGE', KEY.ends, 0, -1)) do
  if not seen[id] and redis.call('EXISTS', KEY.held .. id) == 1 then seen[id] = true out[#out + 1] = id end
end
table.sort(out)
return cjson.encode(out)
`,
  { reclaim: true },
);

export async function workList(kv: Kv): Promise<string[]> {
  const out = await workListScript.run<string[] | Record<string, never>>(kv, {}, { now: 0 });
  return Array.isArray(out) ? out : [];
}

export interface ClaimInput {
  now: number;
  run: string;
  id: string;
  cid: string;
  stamp: Stamp;
  day: string;
  cap: number;
  batch: 'domestic' | 'abroad';
  /** "<office>|<group>" → the dates this run verified open for that pair, and when (ms). */
  open: Record<string, { d: string[]; at: number }>;
  /** The alert's offices that are posts abroad. */
  abroad: Record<string, true>;
}

export type Job = { i: string; n: string; s: Stamp[]; d: [number, string, number, number][] };
export type ClaimAnswer = { ok: true; job: Job; checked: number } | { ok: false; why: 'lost' | 'none' | 'ended' | 'claimed' | 'attempted' | 'empty' | 'deferred' | 'unverified' | 'pace' | 'cap' };

export const claimScript = deviceScript(
  'dev-claim',
  `${ALL_LIBS}${NEED_ALERT}
local id = A.id
need_alert(id)
local tk = KEY.today .. id .. ':' .. A.day
need(tk, 'string')
if not lock_ok() then return '{"ok":false,"why":"lost"}' end
local a = alert_get(id)
local function no(why) count('claims_refused_' .. why) return cjson.encode({ ok = false, why = why }) end
if not a then return no('none') end
if is_ended(a) or (a.gone ~= nil and a.gone ~= '') then return no('ended') end
if redis.call('EXISTS', KEY.claim .. id) == 1 then return no('claimed') end
if redis.call('HGET', KEY.tried .. id, 'run') == A.run then return no('attempted') end
local spacing = { asap = ${PACE_SPACING_MS.asap}, hourly = ${PACE_SPACING_MS.hourly} }
local lastRaw = redis.call('GET', KEY.last .. id) or nil
-- Checked before any write: the pace stamp reads as a stamp, today's count is an integer.
local last = nil
if lastRaw then
  local ok, v = pcall(cjson.decode, lastRaw)
  if not ok or not stamp_ok(v) then error('pace stamp of ' .. id) end
  last = v
end
if not stamp_ok(A.stamp) then error("the run's stamp") end
local today = counter(tk)
alert_check(id, alert_get(id))
-- All the alert's work, merged: held first, then queued; pruned to its incarnation, choices and window.
local work = job_decode(redis.call('GET', KEY.held .. id))
local queued = job_decode(redis.call('HGET', KEY.queue, id))
if work and work.n ~= a.inc then work = nil end
if queued and queued.n == a.inc then
  if work then job_merge(work, queued) else work = queued end
end
local pruned = nil
local drop = { choices = 0, window = 0, unknown = 0 }
if work then pruned, drop = job_prune(work, a, A.stamp) end
-- The merged work is bounded like any job (30 dates, 4 KB) before a claim is cut from it.
local overflow = 0
if pruned then pruned, overflow = job_bound(pruned) end
-- From here on, writes.
count_drops(drop)
if overflow > 0 then count('dates_dropped_overflow', overflow) end
redis.call('HDEL', KEY.queue, id)
redis.call('ZREM', KEY.queued, id)
local function keep(job)
  if job then
    local bounded, dr = job_bound(job)
    if dr > 0 then count('dates_dropped_overflow', dr) end
    if bounded then redis.call('SET', KEY.held .. id, cjson.encode(bounded)) return end
  end
  redis.call('DEL', KEY.held .. id)
end
if not pruned then keep(nil) return no('empty') end
-- Split into the dates verified open in this run and the rest.
local open, rest = {}, {}
local checked = nil
local oldestOpenDomestic, oldestWaitingAbroad = nil, nil
for _, d in ipairs(pruned.d) do
  local pair = A.open[I(d[1]) .. '|' .. I(d[3])]
  local isOpen = false
  if pair then for _, x in ipairs(pair.d) do if x == d[2] then isOpen = true end end end
  local wall = stamp_of(pruned, d).wall
  if isOpen then
    open[#open + 1] = d
    if checked == nil or pair.at < checked then checked = pair.at end
    if not A.abroad[I(d[1])] and (oldestOpenDomestic == nil or wall < oldestOpenDomestic) then oldestOpenDomestic = wall end
  else
    rest[#rest + 1] = d
  end
  if A.abroad[I(d[1])] and not isOpen and (oldestWaitingAbroad == nil or wall < oldestWaitingAbroad) then oldestWaitingAbroad = wall end
end
if #open == 0 then keep(pruned) return no('unverified') end
if A.batch == 'domestic' and oldestWaitingAbroad ~= nil and oldestOpenDomestic ~= nil and oldestWaitingAbroad < oldestOpenDomestic then
  keep(pruned)
  return no('deferred')
end
if last then
  local since = elapsed(last, A.stamp)
  if since == nil then
    -- A stamp from another boot restarts the gap; it never shortens it.
    redis.call('SET', KEY.last .. id, cjson.encode(A.stamp))
    keep(pruned)
    return no('pace')
  end
  if since < spacing[a.pace] then keep(pruned) return no('pace') end
end
if today >= A.cap then
  keep(pruned)
  count('dates_held_cap', #pruned.d)
  return no('cap')
end
local claimed = job_with(pruned, open)
local stampJson = cjson.encode(A.stamp)
redis.call('HSET', KEY.claim .. id, 'cid', A.cid, 'run', A.run, 'inc', a.inc, 'gen', a.gen, 'rev', a.rev, 'day', A.day,
  'prev', lastRaw or '', 'at', stampJson, 'state', 'claimed', 'job', cjson.encode(claimed), 'checked', I(checked))
redis.call('SET', KEY.last .. id, stampJson)
redis.call('INCR', tk)
if redis.call('PTTL', tk) < 0 then redis.call('EXPIRE', tk, 172800) end
redis.call('HSET', KEY.tried .. id, 'run', A.run)
if #rest > 0 then keep(job_with(pruned, rest)) else keep(nil) end
count('claims')
return cjson.encode({ ok = true, job = claimed, checked = checked })
`,
);

export function claim(kv: Kv, a: ClaimInput): Promise<ClaimAnswer> {
  return claimScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const sendGateScript = deviceScript(
  'dev-send-gate',
  `${ALL_LIBS}${NEED_ALERT}
local id = A.id
need_alert(id)
need(KEY.backoff .. A.svc, 'string')
if not lock_ok() then return '{"go":false,"why":"lost"}' end
local c = hgetall(KEY.claim .. id)
if c.cid ~= A.cid or c.state ~= 'claimed' or c.run ~= A.run then return '{"go":false,"why":"claim"}' end
local a = alert_get(id)
local why = nil
if not a or a.inc ~= c.inc or a.gen ~= c.gen or a.rev ~= c.rev then why = 'changed'
elseif is_ended(a) or (a.gone ~= nil and a.gone ~= '') then why = 'ended'
elseif not A.modeOk then why = 'mode'
elseif redis.call('EXISTS', KEY.paused) == 1 then why = 'paused'
elseif (tonumber(redis.call('GET', KEY.backoff .. A.svc) or '0') or 0) > NOW then why = 'backoff'
else
  local job = job_decode(c.job)
  local pruned, drop = nil, nil
  if job then pruned, drop = job_prune(job, a, A.stamp) end
  if not pruned or #pruned.d ~= #job.d then why = 'age' end
end
if why then
  put_back(id, c, a, false, A.stamp)
  return cjson.encode({ go = false, why = why })
end
redis.call('HSET', KEY.claim .. id, 'state', 'sending')
return cjson.encode({ go = true, sub = a.sub })
`,
);

export function sendGate(kv: Kv, a: { now: number; run: string; id: string; cid: string; stamp: Stamp; modeOk: boolean; svc: string }): Promise<{ go: true; sub: string } | { go: false; why: string }> {
  return sendGateScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const settleScript = deviceScript(
  'dev-settle',
  `${ALL_LIBS}${NEED_ALERT}
local id = A.id
need_alert(id)
need(KEY.backoff .. A.svc, 'string')
need_store()
local c = hgetall(KEY.claim .. id)
-- Only the run that holds the lock settles: a run that lost it leaves its claim to the next run's recovery
-- (a claim still "sending" is then settled as uncertain).
if not lock_ok() or c.cid ~= A.cid then return '{"ok":false}' end
local a = alert_get(id)
alert_check(id, a)
local r = A.result
if A.backoffUntil and A.backoffUntil > (tonumber(redis.call('GET', KEY.backoff .. A.svc) or '0') or 0) then
  redis.call('SET', KEY.backoff .. A.svc, I(A.backoffUntil))
end
if r == 'accepted' or r == 'uncertain' then
  redis.call('DEL', KEY.claim .. id)
  count('claims_' .. r)
  return cjson.encode({ ok = true, outcome = r })
end
-- Passed the gate but never handed to the push service (the run stopped first): back as unattempted.
if r == 'unattempted' then
  put_back(id, c, a, false, A.stamp)
  return '{"ok":true,"outcome":"unattempted"}'
end
if r == 'bug' then
  give_back(id, c)
  redis.call('DEL', KEY.claim .. id)
  count('claims_bug')
  return '{"ok":true,"outcome":"bug"}'
end
if r == 'gone' and a and a.inc == c.inc and a.gen == c.gen then
  give_back(id, c)
  redis.call('DEL', KEY.claim .. id)
  count('claims_gone')
  local o = hgetall(KEY.op .. a.cred)
  if o.op ~= nil and o.result == '' and o.kind == 'rotate' and o.alert == id and N(o.exp) > NOW then
    redis.call('HSET', KEY.alert .. id, 'gone', a.gen)
    return '{"ok":true,"outcome":"kept"}'
  end
  alert_delete(id, a, 'gone')
  return '{"ok":true,"outcome":"deleted"}'
end
-- refused, throttled, rejected, and gone for an older generation: put back as a refusal.
if r == 'rejected' then count('claims_rejected') end
if r == 'throttled' then count('claims_throttled') end
put_back(id, c, a, true, A.stamp)
return '{"ok":true,"outcome":"put-back"}'
`,
  { reclaim: true },
);

export const cursorScript = deviceScript(
  'dev-cursor',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(K.cursor, 'string')
if not lock_ok() then return 'false' end
redis.call('SET', K.cursor, A.id)
return 'true'
`,
);

/** A batch's fair-order cursor moves past an alert considered; only while the run holds the lock. */
export function setCursor(kv: Kv, a: { now: number; run: string; kind: 'domestic' | 'abroad'; id: string }): Promise<boolean> {
  return cursorScript.run(kv, { stats: statsKey(a.now), cursor: K.devCursor(a.kind) }, { ...a });
}

export function settle(kv: Kv, a: { now: number; run: string; id: string; cid: string; stamp: Stamp; result: SendResult['kind'] | 'unattempted'; backoffUntil: number | null; svc?: string }): Promise<{ ok: boolean; outcome?: string }> {
  return settleScript.run(kv, { stats: statsKey(a.now) }, { ...a, svc: a.svc ?? 'fcm', backoffUntil: a.backoffUntil ?? false });
}
```

Importing `PACE_SPACING_MS` from `../checker.ts` would make a cycle; instead move it to a new module, `apps/server/src/pace.ts`:

```ts
// How far apart two alerts to one person (email) or one alert (notifications) may be; see checker.ts for why.
import type { Pace } from '@penge/contracts';

export const PACE_SPACING_MS: Record<Pace, number> = { hourly: 60 * 60_000, asap: 2 * 60_000 };
```

In `checker.ts`, delete the constant (keep its comment beside the import), add `import { PACE_SPACING_MS } from './pace.ts';` (the restored email delivery uses it) and `export { PACE_SPACING_MS } from './pace.ts';` (the restored tests import it from the checker). In `scripts-delivery.ts`, add `import { PACE_SPACING_MS } from '../pace.ts';` (the claim script interpolates it).

In the settle test table, the `svc` for `throttled` is `fcm` (the default above).

- [ ] **Step 5: Watch the script tests pass**

Run: `npm test -w @penge/server -- devices-claims`
Expected: PASS. With the throwaway Valkey: PASS on both targets.

- [ ] **Step 6: "Checked <time>" in the payload**

`apps/server/src/push/payload.ts`, `buildPayload` gains `checkedAt` and appends it to every body it tries:

```ts
const manilaTime = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

export function buildPayload(a: { openings: Opening[]; applicants: number; decisionId: string; checkedAt: number | null }): string {
  const checked = a.checkedAt === null ? '' : ` · Checked ${manilaTime(a.checkedAt)}`;
  // … as before, with each body `${…}${checked}`: `${list} · ${people}${checked}` and `${people}${checked}`.
}
```

Write the function out in full when implementing: the two `make(...)` calls become `make(\`${list} · ${people}${checked}\`)` and `make(\`${people}${checked}\`)`; the last-resort payload keeps `body: people`.

- [ ] **Step 7: The lock, atomically**

`apps/server/src/devices/lock.ts`:

```ts
// The checker's lock (pp:lock:check), taken with SET NX and renewed and released only by its owner, atomically
// (the release before push checked, then set: a gap another run could fall into). A heartbeat renews it while
// slow sends run, so a run never outlives it unknowingly; every delivery script checks the owner anyway.
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { deviceScript } from './lua.ts';

const renewScript = deviceScript(
  'lock-renew',
  `need(KEY.lock, 'string')
if redis.call('GET', KEY.lock) ~= A.run then return 'false' end
redis.call('EXPIRE', KEY.lock, A.ttl)
return 'true'`,
  { reclaim: true },
);

const releaseScript = deviceScript(
  'lock-release',
  `need(KEY.lock, 'string')
if redis.call('GET', KEY.lock) == A.run then redis.call('DEL', KEY.lock) end
return 'true'`,
  { reclaim: true },
);

/** A "cleanup-…" run (admin.mjs device-cleanup) takes its own lock; the scripts' prelude fences it by that one too. */
export const lockKeyFor = (run: string) => (run.startsWith('cleanup-') ? K.devCleanupLock : K.checkLock);
export const acquireLock = (kv: Kv, run: string, ttlSeconds: number) => kv.set(lockKeyFor(run), run, { nx: true, ttlSeconds });
export const renewLock = (kv: Kv, run: string, ttlSeconds: number) => renewScript.run<boolean>(kv, {}, { now: 0, run, ttl: ttlSeconds });
export const releaseLock = async (kv: Kv, run: string) => void (await releaseScript.run(kv, {}, { now: 0, run }));

export function heartbeat(kv: Kv, run: string, ttlSeconds: number, everyMs = 60_000) {
  let lost = false;
  const timer = setInterval(() => {
    renewLock(kv, run, ttlSeconds)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => {});
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer), lost: () => lost };
}
```

In `checker.ts`'s `runCheck`: take the lock with `acquireLock`, `holdLock` becomes

```ts
    const holdLock = async () => {
      if (!(await renewLock(kv, runId, LOCK_TTL_SECONDS))) throw new Error('lost the checker lock; stopping this run');
    };
```

the `finally` becomes `beat.stop(); await releaseLock(kv, runId);` with `const beat = heartbeat(kv, runId, LOCK_TTL_SECONDS);` right after the lock is taken.

- [ ] **Step 8: The notification pass**

`apps/server/src/devices/delivery.ts`:

```ts
// The notification pass (spec: "Sending"): the second queueing write for pending fan-out batches (10 s of it per
// run), then the domestic batch, then, once the abroad scan says it is ready (always, even empty), the abroad fan-out
// and batch. Each batch has 60 s of sending from its first send; a slot is taken before each claim; at most 8 sends at
// once. Nothing here can stop or delay the scans or the email pass, and an error ends only this pass.
import type { Opening } from '../templates.ts';
import { type PushMode, describePost } from '@penge/contracts';
import { catalogPosts } from '../abroad.ts';
import type { Stamp } from '../clock.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Logger } from '../log.ts';
import { buildPayload } from '../push/payload.ts';
import type { Keys } from '../subscribers.ts';
import { writeFanout, FANOUT_BUDGET_MS } from './queue.ts';
import { claim, LostLock, sendGate, setCursor, settle, workList } from './scripts-delivery.ts';
import { checkPushSubscription } from '../push/endpoint.ts';
import { openSubscription } from './store.ts';
import { CHECKER_SLOTS, loggable, type SendResult, SendSlots, type Transport } from './transport.ts';
import { newId } from '../crypto.ts';

export const BATCH_SENDING_MS = 60_000;
const ALERT_TTL_SECONDS = 1800;

export interface DeliveryCheckLike {
  checkedAt: string;
  dates: Map<number, Set<string>>;
  times: Map<number, string>;
}

export interface PassDeps {
  kv: Kv;
  keys: Keys;
  log: Logger;
  now: () => number;
  stampNow: () => Stamp;
  mode: PushMode;
  transport: Transport | null;
  alertsPerDay: number;
  /** deliveryChecks() of the checker, for the scans given. */
  checks: (scans: readonly unknown[]) => Map<number, DeliveryCheckLike>;
}

export interface BatchReport {
  considered: number;
  claimed: number;
  accepted: number;
  refused: number;
  uncertain: number;
  gone: number;
  stoppedBy: 'paused' | 'rejected' | 'deadline' | 'mode' | null;
}
export interface DevicePassReport {
  fanout: { chunks: number; merged: number };
  domestic: BatchReport;
  abroad: BatchReport;
}

const emptyBatch = (): BatchReport => ({ considered: 0, claimed: 0, accepted: 0, refused: 0, uncertain: 0, gone: 0, stoppedBy: null });

export async function notificationPass(deps: PassDeps, ctx: { run: string; scan: unknown; abroadReady: Promise<unknown | null> }): Promise<DevicePassReport> {
  const { kv, log } = deps;
  const report: DevicePassReport = { fanout: { chunks: 0, merged: 0 }, domestic: emptyBatch(), abroad: emptyBatch() };
  let fanoutLeft = FANOUT_BUDGET_MS;
  const fanout = async () => {
    const started = deps.now();
    try {
      const r = await writeFanout(deps, { run: ctx.run, until: started + fanoutLeft });
      report.fanout.chunks += r.chunks;
      report.fanout.merged += r.merged;
    } catch (err) {
      if (err instanceof LostLock) throw err;
      log.error('notification fan-out failed; the batch stays for the next run', { run: ctx.run, err: err as Error });
    }
    fanoutLeft = Math.max(0, fanoutLeft - (deps.now() - started));
  };
  const names = await officeNames(kv);
  const slots = new SendSlots(CHECKER_SLOTS);
  const stop = { rejected: false };
  // Each batch has its own error boundary: one failing leaves the other to run. Losing the lock ends the pass.
  const guarded = async (kind: 'domestic' | 'abroad', run: () => Promise<BatchReport>): Promise<BatchReport> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof LostLock) throw err;
      log.error(`the ${kind} notification batch failed; the other goes on`, { run: ctx.run, err: err as Error });
      return { ...emptyBatch(), stoppedBy: null };
    }
  };
  await fanout();
  report.domestic = await guarded('domestic', () => batch(deps, { run: ctx.run, kind: 'domestic', checks: deps.checks([ctx.scan]), names, slots, stop }));
  const abroadScan = await ctx.abroadReady;
  await fanout();
  report.abroad = await guarded('abroad', () => batch(deps, { run: ctx.run, kind: 'abroad', checks: deps.checks(abroadScan ? [ctx.scan, abroadScan] : [ctx.scan]), names, slots, stop }));
  return report;
}

/** Office names as alerts give them: the office list, and posts abroad as "Place (Post, Country)". Also the catalogue check. */
async function officeNames(kv: Kv): Promise<{ names: Map<number, string>; abroad: Set<number> }> {
  const raw = await kv.get(K.sites);
  const names = new Map<number, string>(raw ? (JSON.parse(raw) as { id: number; name: string }[]).map((s) => [s.id, s.name]) : []);
  const abroad = new Set<number>();
  for (const p of await catalogPosts(kv)) {
    const d = describePost(p.name, p.country);
    names.set(p.id, `${d.place} (${d.detail})`);
    abroad.add(p.id);
  }
  return { names, abroad };
}

async function batch(
  deps: PassDeps,
  b: { run: string; kind: 'domestic' | 'abroad'; checks: Map<number, DeliveryCheckLike>; names: { names: Map<number, string>; abroad: Set<number> }; slots: SendSlots; stop: { rejected: boolean } },
): Promise<BatchReport> {
  const { kv, log } = deps;
  const r = emptyBatch();
  if (deps.mode === 'off' || !deps.transport) {
    r.stoppedBy = 'mode';
    return r;
  }
  const transport = deps.transport;
  const ids = await workList(kv);
  const cursorKey = K.devCursor(b.kind);
  const cursor = await kv.get(cursorKey);
  const from = cursor === null ? 0 : Math.max(0, ids.findIndex((id) => id > cursor));
  const order = [...ids.slice(from), ...ids.slice(0, from)];
  let firstSend: number | null = null;
  const sends: Promise<void>[] = [];
  // Every send started is awaited before the batch ends, however it ends (a lost lock included).
  try {
    for (const id of order) {
      if (b.stop.rejected) {
        r.stoppedBy = 'rejected';
        break;
      }
      if (await kv.get(K.pushPaused)) {
        r.stoppedBy = 'paused';
        break;
      }
      const release = await b.slots.take();
      // From the slot on, one try: the slot is released on every path that does not hand it to a send.
      let sent = false;
      try {
        // Checked again with the slot in hand: a send that released it may have been rejected meanwhile.
        if (b.stop.rejected) {
          r.stoppedBy = 'rejected';
          break;
        }
        if (firstSend !== null && deps.now() - firstSend >= BATCH_SENDING_MS) {
          r.stoppedBy = 'deadline';
          break;
        }
        r.considered++;
        if (!(await setCursor(kv, { now: deps.now(), run: b.run, kind: b.kind, id }))) throw new LostLock();
        const alert = await kv.hGetAll(K.devAlert(id));
        if (!alert.offices) continue;
        // The alert's push service (validated when it was stored), defaulted once, for the gate and every settlement.
        const svc = alert.svc ?? 'fcm';
        const group = Number(alert.group);
        const open: Record<string, { d: string[]; at: number }> = {};
        const abroad: Record<string, true> = {};
        for (const office of alert.offices.split(',').map(Number)) {
          if (b.names.abroad.has(office)) abroad[String(office)] = true;
          const check = b.checks.get(office);
          const one = check?.dates.get(1);
          const mine = check?.dates.get(group);
          if (!check || !one || !mine) continue;
          const dates = [...mine].filter((d) => one.has(d));
          if (dates.length === 0) continue;
          const at = Math.min(Date.parse(check.times.get(1) ?? check.checkedAt), Date.parse(check.times.get(group) ?? check.checkedAt));
          open[`${office}|${group}`] = { d: dates, at };
        }
        const stamp = deps.stampNow();
        const cid = newId();
        const c = await claim(kv, { now: deps.now(), run: b.run, id, cid, stamp, day: manilaDay(deps.now()), cap: deps.alertsPerDay, batch: b.kind, open, abroad });
        if (!c.ok) {
          if (c.why === 'lost') throw new LostLock();
          continue;
        }
        r.claimed++;
        // Every office must be in the catalogue; every date was verified open in this run (so it is published).
        const byOffice = new Map<number, string[]>();
        for (const [office, date] of c.job.d) {
          if (!b.names.names.has(office)) {
            log.warn('a notification date for an office not in the catalogue was dropped', { alert: id, office });
            continue;
          }
          byOffice.set(office, [...(byOffice.get(office) ?? []), date]);
        }
        const openings: Opening[] = [...byOffice].map(([office, dates]) => ({ id: office, name: b.names.names.get(office)!, dates: dates.sort() })).sort((x, y) => x.name.localeCompare(y.name));
        // A fresh reading for the gate: every date's age is checked just before the send, not at the claim.
        // A rejection that arrived while this alert was being claimed fails the gate: the claim goes back unattempted.
        const gate = await sendGate(kv, { now: deps.now(), run: b.run, id, cid, stamp: deps.stampNow(), modeOk: deps.mode !== 'off' && !b.stop.rejected, svc });
        if (!gate.go) {
          if (gate.why === 'lost') throw new LostLock();
          if (b.stop.rejected) {
            r.stoppedBy = 'rejected';
            break;
          }
          continue;
        }
        // A rejection that arrived while the gate ran: this claim goes back unattempted, and nothing more is sent.
        // (From here to transport.send nothing awaits, so no later rejection can slip in before the send starts.)
        if (b.stop.rejected) {
          await settle(kv, { now: deps.now(), run: b.run, id, cid, stamp, result: 'unattempted', backoffUntil: null, svc });
          r.stoppedBy = 'rejected';
          break;
        }
        if (openings.length === 0) {
          await settle(kv, { now: deps.now(), run: b.run, id, cid, stamp, result: 'bug', backoffUntil: null, svc });
          continue;
        }
        firstSend ??= deps.now();
        sent = true;
        sends.push(
          (async () => {
            // One alert's failure (a damaged record, a script error) is logged and costs only that alert.
            let result: SendResult;
            try {
              const opened = openSubscription(deps.keys, gate.sub);
              // Endpoint checks again before every send (spec: "Endpoint checks are kept … when stored and before every send").
              const sub = checkPushSubscription({ endpoint: opened.endpoint, keys: { p256dh: opened.p256dh, auth: opened.auth } });
              if (!sub) {
                log.error('a stored subscription failed the endpoint checks; not sent', { alert: id });
                result = { kind: 'bug', status: null };
              } else {
                const payload = buildPayload({ openings, applicants: group, decisionId: `${b.run}-${id}`.slice(0, 64), checkedAt: c.checked });
                result = await transport.send(sub, payload, { ttl: ALERT_TTL_SECONDS, urgency: 'high' });
              }
            } catch {
              result = { kind: 'bug', status: null };
            }
            if (result.kind === 'accepted') r.accepted++;
            else if (result.kind === 'uncertain') r.uncertain++;
            else if (result.kind === 'gone') r.gone++;
            else r.refused++;
            if (result.kind !== 'accepted') log.warn('notification not accepted', { alert: id, push: loggable(result) });
            if (result.kind === 'rejected') {
              b.stop.rejected = true;
              log.error('a push service rejected our request; notifications stop for this run', { alert: id, push: loggable(result) });
            }
            const backoffUntil = result.kind === 'throttled' ? deps.now() + result.retryAfterMs : null;
            await settle(kv, { now: deps.now(), run: b.run, id, cid, stamp, result: result.kind, backoffUntil, svc }).catch((err: unknown) =>
              log.error('a notification could not be settled; clean-up recovers it', { alert: id, err: err as Error }),
            );
          })().finally(release),
        );
      } catch (err) {
        if (err instanceof LostLock) throw err;
        log.error('a notification alert could not be handled this run', { alert: id, err: err as Error });
      } finally {
        if (!sent) release();
      }
    }
  } finally {
    await Promise.allSettled(sends);
  }
  return r;
}
```

- [ ] **Step 9: The run's three passes**

In `apps/server/src/checker.ts`:

1. `CheckDeps` gains:

```ts
  /** Notification alerts: the mode this run started with, and the push transport. Without it, none are sent. */
  devices?: { mode: PushMode; transport: Transport | null };
```

and `RunReport` gains `devices: DevicePassReport | null;` (every early return gives `devices: null`).

2. Replace, in `runCheck`, everything from `// One email per person per check` to the line before `// The records come after every alert is out` with:

```ts
    // Three things side by side (spec: "A run"): the abroad scan, the email pass and the notification pass.
    // Each catches its own errors; the email pass's error, if any, fails the run once the others are done.
    const emailed = new Set<string>();
    let resolveAbroad!: (scan: DeliveryScan | null) => void;
    const abroadReady = new Promise<DeliveryScan | null>((resolve) => (resolveAbroad = resolve));
    const abroadTask = (async () => {
      if (!deps.abroad) return null;
      // A sweep by hand gets its time from when the posts begin; a scheduled run's posts stop at a time counted from
      // the run's start, to end before the next run.
      const deadline = deps.abroadSweep ? now() + ABROAD_SWEEP_DEADLINE_MS : started + ABROAD_DEADLINE_MS;
      return abroadPass(deps, deps.abroad, scan.runId, now, deadline, loadSubscriber, holdLock);
    })()
      .then((pass) => {
        resolveAbroad(pass && pass.report.trusted ? pass.scan : null);
        return pass;
      })
      .catch((err: unknown) => {
        resolveAbroad(null);
        log.error('posts abroad failed this run', { runId, err: err as Error });
        return null;
      });
    const emailTask = (async () => {
      let delivery = await deliver(deps, now, emailed, [scan]);
      const abroadScan = await abroadReady;
      if (abroadScan && !delivery.stoppedBy) delivery = addDelivery(delivery, await deliver(deps, now, emailed, [scan, abroadScan]));
      return delivery;
    })();
    const devicesTask = deps.devices
      ? notificationPass(
          {
            kv, keys: deps.keys, log, now, stampNow: deps.stampNow!, mode: deps.devices.mode, transport: deps.devices.transport,
            alertsPerDay: deps.alertsPerSubscriberPerDay, checks: (scans) => deliveryChecks(scans as DeliveryScan[]),
          },
          { run: runId, scan: scan.healthy ? scan : { healthy: false, sites: [], groups: [] }, abroadReady },
        ).catch((err: unknown) => {
          log.error('the notification pass failed this run', { runId, err: err as Error });
          return null;
        })
      : Promise.resolve(null);
    const [pass, emailResult, devices] = await Promise.all([abroadTask, emailTask.then((d) => ({ ok: true as const, d }), (err: unknown) => ({ ok: false as const, err })), devicesTask]);
    if (!emailResult.ok) throw emailResult.err;
    const delivery = emailResult.d;
    const abroad = pass?.report ?? null;
    const recordAbroad = pass?.record ?? null;
```

and the final `return` gains `devices`.

3. `abroadPass`'s `queueAlerts(deps, scan, now, loadSubscriber)` call becomes `queueAlerts(deps, scan, now, loadSubscriber, 'abroad')`; the domestic call passes `'domestic'`.

4. Imports: `notificationPass`, `type DevicePassReport` from `./devices/delivery.ts`; `type Transport` from `./devices/transport.ts`; `type PushMode` from `@penge/contracts`; `acquireLock`, `heartbeat`, `releaseLock`, `renewLock` from `./devices/lock.ts`.

`apps/server/src/check.ts`: the `runCheck({ … })` call gains

```ts
    devices: { mode: config.push.mode, transport: config.push.vapid ? webPushTransport(config.push.vapid) : null },
```

with `import { webPushTransport } from './devices/transport.ts';`.

- [ ] **Step 10: Write the failing pass tests**

Append to `apps/server/test/checker-devices.test.ts` (and restore Task 10 Step 6's first case to its job assertion, with its world made by `deviceWorld({ devices: { mode: 'live', transport: null } })`, now that the pass runs the second write):

```ts
import type { SendResult, Transport } from '../src/devices/transport.ts';

class Pushes implements Transport {
  sent: Record<string, any>[] = [];
  next: SendResult[] = [];
  delayMs = 0;
  async send(_: unknown, payload: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.sent.push(JSON.parse(payload));
    return this.next.shift() ?? { kind: 'accepted' as const, status: 201 };
  }
}

describe('the notification pass', () => {
  it('sends a verified opening to a notification alert, with when it was checked', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0, choices: choices({ siteIds: [486] }) });
    w.upstream.open.set('486', ['2026-10-09']);
    const report = await w.run();
    expect(report.devices?.domestic).toMatchObject({ claimed: 1, accepted: 1 });
    expect(pushes.sent[0]).toMatchObject({ v: 1, title: 'Dates open at Antipolo', url: { office: 486, date: '2026-10-09', people: 1 } });
    expect(pushes.sent[0]!.body).toMatch(/· Checked \d\d:\d\d$/);
  });

  it('keeps email and notifications independent: mail failing does not stop pushes, and the reverse', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    const token = await (await import('../src/subscribers.ts')).createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap' } as never, w.t.now());
    await (await import('../src/subscribers.ts')).confirm(w.kv, token, w.t.now());
    w.mailer.failNext = 3; // FakeMailer: the next sends fail as refused
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(pushes.sent).toHaveLength(1);
    pushes.next = [{ kind: 'refused', status: 503 }];
    w.upstream.open.set('486', ['2026-10-09', '2026-10-10']);
    w.mailer.failNext = 0;
    await w.run();
    expect(w.mailer.sent.some((m) => m.kind === 'alert')).toBe(true);
  });

  it('runs the abroad batch even when the abroad scan failed, sending what was verified at home', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes }, abroad: { sites: async () => { throw new Error('down'); }, availability: async () => { throw new Error('down'); } } as never });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    const report = await w.run();
    expect(report.devices?.abroad.stoppedBy).toBeNull();
    expect(pushes.sent).toHaveLength(1);
  });

  it('sends nothing in off mode; the work waits uncharged', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'off', transport: pushes } });
    await w.run();
    const a = await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(pushes.sent).toEqual([]);
    expect(await w.kv.get(K.devToday(a.id, (await import('../src/keys.ts')).manilaDay(w.t.now())))).toBeNull();
  });

  it('stops claiming at a batch\'s 60 seconds of sending; the abroad batch, with its own 60 s, sends the rest', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    for (let i = 0; i < 12; i++) await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    pushes.send = async (_: unknown, payload: string) => {
      w.t.advance(7_000); // each send takes 7 s of the batch's 60
      pushes.sent.push(JSON.parse(payload));
      return { kind: 'accepted', status: 201 };
    };
    const report = await w.run();
    // 7 s a send: the domestic batch sends 9 (63 s > 60 s stops it before a tenth), and the abroad batch, which sends
    // what was verified at home too, has its own 60 s for the 3 left.
    expect(report.devices?.domestic).toMatchObject({ stoppedBy: 'deadline', accepted: 9 });
    expect(report.devices?.abroad).toMatchObject({ accepted: 3 });
    expect(pushes.sent).toHaveLength(12);
  });

  it('sends nothing more after a rejection, even to the alert that was waiting for the rejected send\'s slot', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    for (let i = 0; i < 12; i++) await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    let n = 0;
    pushes.send = async (_: unknown, payload: string) => {
      const mine = ++n;
      pushes.sent.push(JSON.parse(payload));
      // The first send is rejected after the other seven slots are taken; the ninth alert waits for its slot.
      await new Promise((r) => setTimeout(r, mine === 1 ? 30 : 60));
      return mine === 1 ? { kind: 'rejected', status: 401 } : { kind: 'accepted', status: 201 };
    };
    const report = await w.run();
    expect(report.devices?.domestic.stoppedBy).toBe('rejected');
    expect(pushes.sent).toHaveLength(8);
  });

  it('finishes the sends it started before a lost lock ends the batch', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    for (let i = 0; i < 3; i++) await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    let finished = 0;
    pushes.send = async (_: unknown, payload: string) => {
      // The first send outlives the lock: another run takes it while this send is on the wire.
      if (pushes.sent.length === 0) await w.kv.set(K.checkLock, 'another-run');
      pushes.sent.push(JSON.parse(payload));
      await new Promise((r) => setTimeout(r, 20));
      finished++;
      return { kind: 'accepted', status: 201 };
    };
    await w.run().catch(() => undefined);
    expect(finished).toBe(pushes.sent.length); // nothing still on the wire when the run returns
    expect(pushes.sent.length).toBeLessThan(3);
  });

    it('sends one notification per alert per run, however many batches', async () => {
    const pushes = new Pushes();
    const w = await deviceWorld({ devices: { mode: 'live', transport: pushes } });
    await w.run();
    await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    expect(pushes.sent).toHaveLength(1);
  });
});
```

`FakeMailer.failNext` is the helper's switch for refused sends (`grep -n "failNext\|class FakeMailer" -A 12 apps/server/test/helpers.ts`; use whatever it is called there, its comment says "The next sends fail as when the mail server is down").

- [ ] **Step 11: Watch them pass**

Run: `npm test -w @penge/server -- checker-devices devices-claims payload checker`
Expected: PASS. If a restored `checker.test.ts` or `abroad.test.ts` case asserts that the abroad scan starts only after domestic delivery (the order at `157bad9`), change that one assertion to the spec's order (the abroad scan starts right after domestic queueing, beside the email pass; email keeps domestic before abroad delivery and one email per person per check) and record a Ruling in the ledger.

Run with the throwaway Valkey: `DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- devices-claims`
Expected: PASS on both.

- [ ] **Step 12: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review of the notification pass against the spec's 'Sending' section: claims (only verified dates, pace across reboots, daily cap counting accepted and uncertain only, one attempt per run, the domestic/abroad deferral), the send gate, the settlement table row by row, put-back (tries, give-back, pace restore only if unchanged), per-batch 60 s deadlines with a slot before every claim, the atomic lock scripts and heartbeat, and the run's three side-by-side passes. Look for a send twice, a count never given back, a date that outlives its window, work lost on a crash, and any way the email pass is delayed or stopped by notifications."). Then:

```bash
git add apps/server/src/devices apps/server/src/pace.ts apps/server/src/checker.ts apps/server/src/check.ts apps/server/src/push/payload.ts apps/server/test/devices-claims.test.ts apps/server/test/checker-devices.test.ts apps/server/test/payload.test.ts
git commit -m "The notification pass: claims, a send gate, settlement, and the run's three passes side by side"
```

---
### Task 12: Clean-up at the start of every run, claim recovery, the daily recount, and `device-cleanup`

**Files:**
- Create: `apps/server/src/devices/cleanup.ts`
- Modify: `apps/server/src/devices/scripts-delivery.ts` (reclaim under the lock, garbage, sweep, recount), `apps/server/src/checker.ts` (clean-up first, then the cooldown), `apps/server/src/admin.ts` (`device-cleanup`)
- Test: `apps/server/test/devices-cleanup.test.ts`, `apps/server/test/checker-devices.test.ts` (more cases)

**Interfaces:**
- Consumes: Task 6's `reclaim` (Lua), Task 10's `DELIVERY_LIB`, Task 11's `CLAIM_LIB` (`put_back`), lock functions.
- Produces:
  - scripts-delivery.ts: `reclaimLocked(kv, a: { now; run; limit }): Promise<{ lost?: true; expired: number; ended: number; deleted: number }>`, `collectGarbage(kv, a: { now; run; limit; days: string[] }): Promise<{ lost?: true; removed: number; left: number }>`, `aliveAlerts(kv): Promise<string[]>`, `sweep(kv, a: { now; run; stamp; ids: string[] }): Promise<{ lost?: true; recovered: number; uncertain: number; pruned: number }>`, `recount(kv, now): Promise<{ units: number; expectedUnits: number; alerts: number; expectedAlerts: number }>`.
  - cleanup.ts: `deviceCleanup(deps: { kv; log; now; stampNow }, run: string): Promise<CleanupReport>`, `CleanupReport = { expired; ended; deleted; garbage; recovered; uncertain; pruned; recount: { units; expectedUnits; alerts; expectedAlerts } | null }`.
  - admin.ts: `node admin.mjs device-cleanup` (always exits 0; logs a failure).

- [ ] **Step 1: Write the failing tests**

`apps/server/test/devices-cleanup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { deviceCleanup } from '../src/devices/cleanup.ts';
import { claim, sendGate } from '../src/devices/scripts-delivery.ts';
import { turnOff } from '../src/devices/scripts-api.ts';
import { ALERT_UNITS } from '../src/devices/store.ts';
import { silentLog } from '../src/log.ts';
import { choices, opId, seedAlert } from './device-fixtures.ts';
import { valkeyTargets } from './valkey.ts';

const T0 = Date.parse('2026-10-06T02:00:00Z');
type Kv = Parameters<typeof claim>[0];
const run = (kv: Kv, runId: string, now = T0 + 60_000) => {
  return kv.set(K.checkLock, runId).then(() => deviceCleanup({ kv, log: silentLog, now: () => now, stampNow: () => ({ wall: now }) }, runId));
};

async function claimed(kv: Kv, runId: string, sending: boolean) {
  const a = await seedAlert(kv, { now: T0, order: 0, choices: choices() });
  const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
  await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [a.id]: JSON.stringify({ i: a.id, n: inc, s: [{ wall: T0 }], d: [[486, '2026-10-09', 1, 0]] }) } }]);
  await kv.set(K.checkLock, runId);
  const cid = opId();
  await claim(kv, { now: T0 + 1000, run: runId, id: a.id, cid, stamp: { wall: T0 + 1000 }, day: '2026-10-06', cap: 3, batch: 'domestic', open: { '486|1': { d: ['2026-10-09'], at: T0 } }, abroad: {} });
  if (sending) await sendGate(kv, { now: T0 + 1000, run: runId, id: a.id, cid, stamp: { wall: T0 + 1000 }, modeOk: true, svc: 'fcm' });
  return a;
}

for (const [name, make] of valkeyTargets()) {
  describe(`clean-up on ${name}`, () => {
    it('puts back a claim a lost run left claimed, unattempted', async () => {
      const kv = await make();
      const a = await claimed(kv, 'old', false);
      const r = await run(kv, 'new');
      expect(r.recovered).toBe(1);
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual({});
      expect(await kv.get(K.devToday(a.id, '2026-10-06'))).toBe('0');
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-09', 1, 0]]);
    });

    it('settles a claim a lost run left sending as uncertain: deleted, count kept, never sent again', async () => {
      const kv = await make();
      const a = await claimed(kv, 'old', true);
      const r = await run(kv, 'new');
      expect(r.uncertain).toBe(1);
      expect(await kv.hGetAll(K.devClaim(a.id))).toEqual({});
      expect(await kv.get(K.devToday(a.id, '2026-10-06'))).toBe('1');
      expect(await kv.get(K.devHeld(a.id))).toBeNull();
    });

    it('removes a deleted alert\'s delivery keys and releases its units', async () => {
      const kv = await make();
      const a = await claimed(kv, 'old', false);
      await turnOff(kv, { now: T0, cred: a.hash });
      expect((await kv.hGetAll(K.devGarbage))[a.id]).toBe(String(ALERT_UNITS));
      const r = await run(kv, 'new');
      expect(r.garbage).toBe(1);
      for (const key of [K.devClaim(a.id), K.devLast(a.id), K.devTried(a.id), K.devHeld(a.id), K.devToday(a.id, '2026-10-06')]) {
        expect(await kv.script({ name: 'x', lua: "#!lua\nreturn tostring(redis.call('EXISTS', KEYS[1]))" }, [key], [])).toBe('0');
      }
      expect(await kv.hGetAll(K.devRecords)).toMatchObject({ units: '0', alerts: '0' });
    });

    it('drops queued and held dates past their window, and work of another incarnation', async () => {
      const kv = await make();
      const a = await seedAlert(kv, { now: T0, order: 0 });
      const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
      await kv.write([{ op: 'hSet', key: K.devQueue, fields: { [a.id]: JSON.stringify({ i: a.id, n: 'old-incarnation', s: [{ wall: T0 }], d: [[486, '2026-10-09', 1, 0]] }) } }]);
      await kv.set(K.devHeld(a.id), JSON.stringify({ i: a.id, n: inc, s: [{ wall: T0 - 4 * 3600_000 }, { wall: T0 }], d: [[486, '2026-10-10', 1, 0], [486, '2026-10-11', 1, 1]] }));
      const r = await run(kv, 'new');
      expect(r.pruned).toBe(2);
      expect(await kv.hGetAll(K.devQueue)).toEqual({});
      expect(JSON.parse((await kv.get(K.devHeld(a.id)))!).d).toEqual([[486, '2026-10-11', 1, 0]]);
    });

    it('expires a fan-out batch past its window even when no notification pass runs', async () => {
      const kv = await make();
      await kv.set(K.checkLock, 'old');
      const { queueWrite } = await import('../src/devices/scripts-delivery.ts');
      await queueWrite(kv, { now: T0, run: 'old', mark: 'm', ops: [], batch: { id: 'b1', entries: ['486|2026-10-09|1|0'], stamps: [{ wall: T0 - 4 * 3600_000 }] } });
      const r = await run(kv, 'new');
      expect(r.fanoutExpired).toBe(1);
      expect(await kv.get(K.devFanoutStamps('b1'))).toBeNull();
    });

    it('recounts once a day and agrees with the units kept', async () => {
      const kv = await make();
      await claimed(kv, 'old', false);
      const r = await run(kv, 'new');
      expect(r.recount).toEqual({ units: ALERT_UNITS, expectedUnits: ALERT_UNITS, alerts: 1, expectedAlerts: 1 });
      expect((await run(kv, 'newer')).recount).toBeNull();
    });

    it('does nothing without the lock', async () => {
      const kv = await make();
      await claimed(kv, 'old', false);
      await kv.set(K.checkLock, 'someone-else');
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0, stampNow: () => ({ wall: T0 }) }, 'me')).rejects.toThrow(/lost the checker lock/);
    });
  });
}
```

Append to `apps/server/test/checker-devices.test.ts`:

```ts
describe('clean-up in a run', () => {
  it('runs before the cooldown, so a resting run still cleans up', async () => {
    const w = await deviceWorld({ devices: { mode: 'live', transport: null } });
    const a = await seedAlert(w.kv, { now: w.t.now() - 1000, end: w.t.now() - 1 });
    await w.kv.set(K.scanCooldown, 'x', { ttlSeconds: 600 });
    expect((await w.run()).skipped).toBe('cooling down');
    expect(await w.kv.hGetAll(K.devAlert(a.id))).toEqual({});
  });

  it('skips only the notification pass when clean-up fails; scans and email go on', async () => {
    const w = await deviceWorld({ devices: { mode: 'live', transport: null } });
    await w.kv.set(K.devGarbage, 'not a hash');
    const report = await w.run();
    expect(report.healthy).toBe(true);
    expect(report.devices).toBeNull();
    expect(w.lines.some((l) => l.includes('notification clean-up failed'))).toBe(true);
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- devices-cleanup checker-devices`
Expected: FAIL: `Cannot find module '../src/devices/cleanup.ts'`.

- [ ] **Step 3: The clean-up scripts**

Append to `apps/server/src/devices/scripts-delivery.ts`:

```ts
export const reclaimLockedScript = deviceScript(
  'dev-reclaim-locked',
  `${STORE_LIB}${DELIVERY_LIB}
need_store() need(KEY.lock, 'string')
if not lock_ok() then return '{"lost":true}' end
return cjson.encode(reclaim(A.limit))
`,
  { reclaim: true },
);

export function reclaimLocked(kv: Kv, a: { now: number; run: string; limit: number }): Promise<{ lost?: true; expired: number; ended: number; deleted: number }> {
  return reclaimLockedScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const garbageScript = deviceScript(
  'dev-garbage',
  `${ALL_LIBS}
need_store() need(KEY.lock, 'string') need(KEY.queue, 'hash') need(KEY.queued, 'zset')
if not lock_ok() then return '{"lost":true}' end
local all = hgetall(KEY.garbage)
local ids = {}
for id, units in pairs(all) do
  integer(units, 'garbage ' .. id)
  ids[#ids + 1] = id
end
table.sort(ids)
local removed = 0
for i = 1, math.min(#ids, A.limit) do
  local id = ids[i]
  local keys = { KEY.held .. id, KEY.claim .. id, KEY.last .. id, KEY.tried .. id }
  for _, day in ipairs(A.days) do keys[#keys + 1] = KEY.today .. id .. ':' .. day end
  redis.call('DEL', unpack(keys))
  redis.call('HDEL', KEY.queue, id)
  redis.call('ZREM', KEY.queued, id)
  redis.call('HDEL', KEY.garbage, id)
  rec_add('units', -N(all[id]))
  removed = removed + 1
end
if removed > 0 then count('garbage_removed', removed) end
return cjson.encode({ removed = removed, left = #ids - removed })
`,
  { reclaim: true },
);

export function collectGarbage(kv: Kv, a: { now: number; run: string; limit: number; days: string[] }): Promise<{ lost?: true; removed: number; left: number }> {
  return garbageScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const aliveScript = deviceScript('dev-alive', `need(KEY.ends, 'zset') return cjson.encode(redis.call('ZRANGE', KEY.ends, 0, -1))`, { reclaim: true });

export async function aliveAlerts(kv: Kv): Promise<string[]> {
  const out = await aliveScript.run<string[] | Record<string, never>>(kv, {}, { now: 0 });
  return Array.isArray(out) ? out : [];
}

export const sweepScript = deviceScript(
  'dev-sweep',
  `${ALL_LIBS}${NEED_ALERT}
for _, id in ipairs(A.ids) do need_alert(id) end
if not lock_ok() then return '{"lost":true}' end
local out = { recovered = 0, uncertain = 0, pruned = 0 }
for _, id in ipairs(A.ids) do
  local a = alert_get(id)
  -- Claims left by a run that lost the lock: still claimed, put back unattempted; sending, settled as uncertain.
  local c = hgetall(KEY.claim .. id)
  if c.cid ~= nil and c.run ~= A.run then
    if c.state == 'sending' then
      redis.call('DEL', KEY.claim .. id)
      count('claims_recovered_uncertain')
      out.uncertain = out.uncertain + 1
    else
      put_back(id, c, a, false, A.stamp)
      count('claims_recovered')
      out.recovered = out.recovered + 1
    end
  end
  -- Queued and held work: only this incarnation's, choices and window.
  local live = {}
  local q = job_decode(redis.call('HGET', KEY.queue, id))
  if q then
    local kept, drop = job_prune(q, a, A.stamp)
    count_drops(drop)
    out.pruned = out.pruned + drop.choices + drop.window + drop.unknown
    if kept then
      redis.call('HSET', KEY.queue, id, cjson.encode(kept))
      redis.call('ZADD', KEY.queued, oldest_wall(kept), id)
      for _, d in ipairs(kept.d) do live[dkey(d)] = true end
    else
      redis.call('HDEL', KEY.queue, id)
      redis.call('ZREM', KEY.queued, id)
    end
  end
  local h = job_decode(redis.call('GET', KEY.held .. id))
  if h then
    local kept, drop = job_prune(h, a, A.stamp)
    count_drops(drop)
    out.pruned = out.pruned + drop.choices + drop.window + drop.unknown
    if kept then
      redis.call('SET', KEY.held .. id, cjson.encode(kept))
      for _, d in ipairs(kept.d) do live[dkey(d)] = true end
    else
      redis.call('DEL', KEY.held .. id)
    end
  end
  local cj = job_decode(redis.call('HGET', KEY.claim .. id, 'job'))
  if cj then for _, d in ipairs(cj.d) do live[dkey(d)] = true end end
  -- Tries are kept only for dates still in the alert's work.
  for field in pairs(hgetall(KEY.tried .. id)) do
    if field ~= 'run' and not live[field] then redis.call('HDEL', KEY.tried .. id, field) end
  end
end
return cjson.encode(out)
`,
  { reclaim: true },
);

export function sweep(kv: Kv, a: { now: number; run: string; stamp: Stamp; ids: string[] }): Promise<{ lost?: true; recovered: number; uncertain: number; pruned: number }> {
  return sweepScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const fanoutExpireScript = deviceScript(
  'dev-fanout-expire',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(KEY.fanouts, 'list')
if not lock_ok() then return '{"lost":true}' end
-- A batch whose every announcement is past its 3-hour window (or of unknown age) holds nothing sendable: it goes,
-- even while the notification pass is not running (a cooldown, a rollback's pre-step).
local removed = 0
for _, id in ipairs(redis.call('LRANGE', KEY.fanouts, 0, -1)) do
  local fk = KEY.fanout .. id
  local sk = fk .. ':stamps'
  need(fk, 'list') need(sk, 'string')
  local ok, meta = pcall(cjson.decode, redis.call('GET', sk) or 'null')
  local live = false
  if ok and type(meta) == 'table' and type(meta.stamps) == 'table' then
    for _, st in ipairs(meta.stamps) do
      local age = elapsed(st, A.stamp)
      if age ~= nil and age <= WINDOW_MS then live = true end
    end
  end
  if not live then
    redis.call('DEL', fk, sk)
    redis.call('LREM', KEY.fanouts, 0, id)
    removed = removed + 1
  end
end
if removed > 0 then count('fanout_expired', removed) end
return cjson.encode({ removed = removed })
`,
  { reclaim: true },
);

export function expireFanouts(kv: Kv, a: { now: number; run: string; stamp: Stamp }): Promise<{ lost?: true; removed: number }> {
  return fanoutExpireScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const recountScript = deviceScript(
  'dev-recount',
  `${STORE_LIB}${DELIVERY_LIB}
need_store() need(KEY.lock, 'string')
if not lock_ok() then return '{"lost":true}' end
local alive = redis.call('ZCARD', KEY.ends)
local rsvAlert, rsvRepl, unfinished = 0, 0, 0
for _, cred in ipairs(redis.call('ZRANGE', KEY.ops, 0, -1)) do
  unfinished = unfinished + 1
  local rsv = redis.call('HGET', KEY.op .. cred, 'rsv')
  if rsv == 'alert' then rsvAlert = rsvAlert + 1 elseif rsv == 'repl' then rsvRepl = rsvRepl + 1 end
end
local finishedOps, ended = 0, 0
for _, m in ipairs(redis.call('ZRANGE', KEY.deadlines, 0, -1)) do
  if string.sub(m, 1, 3) == 'op|' then finishedOps = finishedOps + 1 else ended = ended + 1 end
end
local garbage = 0
for _, v in pairs(hgetall(KEY.garbage)) do garbage = garbage + N(v) end
local expectedUnits = alive * ALERT_UNITS + unfinished + finishedOps + ended + garbage + (rsvAlert + rsvRepl) * ALERT_UNITS
local out = { units = rec('units'), expectedUnits = expectedUnits, alerts = rec('alerts'), expectedAlerts = alive + rsvAlert }
redis.call('HSET', K.stats, 'recounted', '1')
if out.units ~= out.expectedUnits or out.alerts ~= out.expectedAlerts then count('recount_differences') end
return cjson.encode(out)
`,
  { reclaim: true },
);

export async function recount(kv: Kv, now: number, run: string): Promise<{ units: number; expectedUnits: number; alerts: number; expectedAlerts: number }> {
  const r = await recountScript.run<{ lost?: true; units: number; expectedUnits: number; alerts: number; expectedAlerts: number }>(kv, { stats: statsKey(now) }, { now, run });
  if (r.lost) throw new LostLock();
  return r;
}
```

(An alert's end record shares the alert's units while the alert lives; `ended|` deadlines count one unit each because the alert that left them is gone. A credential with an alert and an older end record counts both, as the scripts charge them.)

- [ ] **Step 4: The clean-up runner**

`apps/server/src/devices/cleanup.ts`:

```ts
// Clean-up (spec: "Lifetime and clean-up"), at the start of every checker run, under its lock, before the cooldown
// and health checks; also `admin.mjs device-cleanup` (the rollback's pre-step). Each step is a bounded script run
// until it has nothing left; each counts what it did.
import type { Stamp } from '../clock.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Logger } from '../log.ts';
import { aliveAlerts, collectGarbage, expireFanouts, LostLock, reclaimLocked, recount, sweep } from './scripts-delivery.ts';

export interface CleanupReport {
  expired: number;
  ended: number;
  deleted: number;
  garbage: number;
  recovered: number;
  uncertain: number;
  pruned: number;
  fanoutExpired: number;
  recount: { units: number; expectedUnits: number; alerts: number; expectedAlerts: number } | null;
}

const BATCH = 200;
const MAX_ROUNDS = 100;

export async function deviceCleanup(deps: { kv: Kv; log: Logger; now: () => number; stampNow: () => Stamp }, run: string): Promise<CleanupReport> {
  const { kv, log } = deps;
  const r: CleanupReport = { expired: 0, ended: 0, deleted: 0, garbage: 0, recovered: 0, uncertain: 0, pruned: 0, fanoutExpired: 0, recount: null };
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const x = await reclaimLocked(kv, { now: deps.now(), run, limit: BATCH });
    if (x.lost) throw new LostLock();
    r.expired += x.expired;
    r.ended += x.ended;
    r.deleted += x.deleted;
    if (x.expired + x.ended + x.deleted < BATCH) break;
  }
  const days = [manilaDay(deps.now()), manilaDay(deps.now() - 86_400_000), manilaDay(deps.now() - 2 * 86_400_000)];
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const g = await collectGarbage(kv, { now: deps.now(), run, limit: 50, days });
    if (g.lost) throw new LostLock();
    r.garbage += g.removed;
    if (g.left === 0) break;
  }
  const f = await expireFanouts(kv, { now: deps.now(), run, stamp: deps.stampNow() });
  if (f.lost) throw new LostLock();
  r.fanoutExpired = f.removed;
  const ids = await aliveAlerts(kv);
  for (let i = 0; i < ids.length; i += 50) {
    const s = await sweep(kv, { now: deps.now(), run, stamp: deps.stampNow(), ids: ids.slice(i, i + 50) });
    if (s.lost) throw new LostLock();
    r.recovered += s.recovered;
    r.uncertain += s.uncertain;
    r.pruned += s.pruned;
  }
  if (!(await kv.hGetAll(K.statsV2(manilaDay(deps.now())))).recounted) {
    r.recount = await recount(kv, deps.now(), run);
    if (r.recount.units !== r.recount.expectedUnits || r.recount.alerts !== r.recount.expectedAlerts) {
      log.error('notification storage units differ from a recount', r.recount);
    }
  }
  if (r.expired + r.ended + r.deleted + r.garbage + r.recovered + r.uncertain + r.pruned > 0) log.info('notification clean-up', { run, ...r, recount: undefined });
  return r;
}
```

- [ ] **Step 5: Clean-up first in a run, then the cooldown**

In `runCheck`, take the lock before the cooldown check, run clean-up in its own error boundary, then check the cooldown (releasing the lock on that early return):

```ts
  if (!(await acquireLock(kv, runId, LOCK_TTL_SECONDS))) {
    log.warn('another check is running; skipping this one', { runId });
    return { runId, skipped: 'locked', healthy: false, problems: [], recorded: null, queued: 0, delivery: null, abroad: null, devices: null };
  }
  const beat = heartbeat(kv, runId, LOCK_TTL_SECONDS);
  try {
    // Notification clean-up first, every run, cooldown or not; its failure skips only the notification pass.
    let devicesClean = false;
    if (deps.devices) {
      try {
        await deviceCleanup({ kv, log, now, stampNow: deps.stampNow! }, runId);
        devicesClean = true;
      } catch (err) {
        log.error('notification clean-up failed; no notifications this run', { runId, err: err as Error });
      }
    }
    if (await kv.get(K.scanCooldown)) {
      log.info('the site had trouble on a recent scan; resting before the next', { runId });
      return { runId, skipped: 'cooling down', healthy: false, problems: [], recorded: null, queued: 0, delivery: null, abroad: null, devices: null };
    }
    …the rest as before, with `devicesTask` started only when `deps.devices && devicesClean`…
  } finally {
    beat.stop();
    await releaseLock(kv, runId);
  }
```

The failure is counted in the day's statistics by Task 13 (`cleanupFailures`).

- [ ] **Step 6: `admin.mjs device-cleanup`**

In `apps/server/src/admin.ts`, add `device-cleanup` to the commands (and to `USAGE`), before the `backup`/`restore` branch:

```ts
if (command === 'device-cleanup') {
  // The rollback's pre-step (deploy/README.md): an older release's checker does not clean notification alerts. It takes
  // its own lock (a "cleanup-…" run: pp:lock:device-cleanup), never the checker's, logs a failure and always exits 0,
  // so it can never stop the old checker or email. It does nothing while any checker run holds pp:lock:check (only this
  // release's checker touches pp:dev:*, and its own run cleans up anyway).
  const runId = `cleanup-${Date.now().toString(36)}`;
  try {
    const config = loadConfig();
    const kv = await connectRedis(config.redisUrl, (err) => process.stderr.write(`redis: ${err.message}\n`));
    try {
      if (await kv.get(K.checkLock)) {
        log.warn('a check is running; device clean-up skipped');
      } else if (await acquireLock(kv, runId, 300)) {
        try {
          const r = await deviceCleanup({ kv, log, now: Date.now, stampNow: () => stampAt(Date.now()) }, runId);
          log.info('device clean-up done', { ...r });
        } finally {
          await releaseLock(kv, runId);
        }
      } else {
        log.warn('another device clean-up is running; skipped');
      }
    } finally {
      await kv.close().catch(() => {});
    }
  } catch (err) {
    log.error('device clean-up failed', { err: err as Error });
  }
  process.exit(0);
}
```

with imports `K` (`./keys.ts`), `deviceCleanup` (`./devices/cleanup.ts`), `acquireLock`, `releaseLock` (`./devices/lock.ts`), `stampAt` (`./clock.ts`), `log` (`./log.ts`). The command check becomes a list (Task 21 adds to it):

```ts
const COMMANDS = ['backup', 'restore', 'scans', 'device-cleanup'];
const USAGE =
  'usage: admin.mjs backup > file.json | admin.mjs restore <file.json[.gz]> --yes | admin.mjs scans <YYYY-MM-DD> [abroad] > day.jsonl | admin.mjs device-cleanup\n';
const [command, file, confirm] = process.argv.slice(2);
if (!command || !COMMANDS.includes(command)) {
  process.stderr.write(USAGE);
  process.exit(2);
}
```

- [ ] **Step 7: Watch the tests pass**

Run: `npm test -w @penge/server -- devices-cleanup checker-devices checker`
Expected: PASS. With the throwaway Valkey: `DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- devices-cleanup` PASS on both.

In `apps/server/test/devices-cleanup.test.ts`, the rollback's guarantee as a test (both targets):

```ts
    it('a device-cleanup run killed while holding its lock never stops the checker from running', async () => {
      const kv = await make();
      // A cleanup that took its lock and was then killed (no release): its lock stays until its TTL ...
      expect(await acquireLock(kv, 'cleanup-hung', 300)).toBe(true);
      expect(await kv.get(K.devCleanupLock)).toBe('cleanup-hung');
      // ... and the checker's lock is untouched: the next (older or newer) checker run takes it at once.
      expect(await acquireLock(kv, 'r-next', 300)).toBe(true);
      expect(await kv.get(K.checkLock)).toBe('r-next');
      // A cleanup run is fenced by its own lock: it works while it holds it, whatever holds the checker's.
      await kv.write([{ op: 'del', key: K.devCleanupLock }]);
      await acquireLock(kv, 'cleanup-live', 300);
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0, stampNow: () => ({ wall: T0 }) }, 'cleanup-live')).resolves.toBeTruthy();
      // And it stops when it no longer holds it.
      await kv.set(K.devCleanupLock, 'cleanup-other');
      await expect(deviceCleanup({ kv, log: silentLog, now: () => T0, stampNow: () => ({ wall: T0 }) }, 'cleanup-live')).rejects.toThrow();
    });
```

(imports: `acquireLock` from `../src/devices/lock.ts`.) Older checkers (`157bad9`, `05cee09`) take only `pp:lock:check`; with the clean-up on its own lock, a clean-up that hangs and is killed by the drop-in's `timeout` leaves nothing that stops them. The spec's "rollback needs no shared lock with the old checker" holds, and the old checkers never touch `pp:dev:*`.

- [ ] **Step 8: `device-cleanup` against a stopped Valkey, and one that never answers**

Run (the build first; a Valkey address nothing listens on, then a TCP sink that accepts and never answers):

```bash
npm run build -w @penge/server
REDIS_URL=redis://127.0.0.1:6399 EMAIL_ENC_KEY=$(openssl rand -base64 32) EMAIL_HMAC_KEY=$(openssl rand -base64 32) TOKEN_SECRET=$(openssl rand -base64 32) \
  timeout --kill-after=10s 120s node apps/server/dist/admin.mjs device-cleanup; echo "exit $?"
```

Expected: `exit 0` within about 10 s (the connect timeout), with one `device clean-up failed` line. Then with `nc -lk 6399 >/dev/null &` running, the same command: `exit 124` or `137` from `timeout` at most 130 s later (the drop-in's `-` prefix ignores it). Stop `nc` afterwards. (macOS: `gtimeout` from coreutils, or run this step in the Linux CI shell.)

- [ ] **Step 9: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review: notification clean-up at the start of every checker run (before the cooldown, under the lock, in its own error boundary), claim recovery after a lost lock, garbage collection of deleted alerts' delivery keys with unit release, pruning by window/incarnation/choices, the daily recount, and the rollback pre-step command. Check against the spec's retention table and 'Recovery': nothing outlives its stated life by more than a run, units never leak or go negative, a recovered claim is never sent twice, and the command can never stop the old checker."). Then:

```bash
git add apps/server/src/devices apps/server/src/checker.ts apps/server/src/admin.ts apps/server/test/devices-cleanup.test.ts apps/server/test/checker-devices.test.ts
git commit -m "Notification clean-up first in every run, claim recovery, a daily recount, and device-cleanup"
```

---
### Task 13: The day's numbers for notification alerts, under `pp:stats:v2:`

**Files:**
- Create: `apps/server/src/devices/counters.ts` (every counter, its unit and the transition that increments it; `countDevice`; gauges)
- Modify: `apps/server/src/stats.ts` (`DailyStats.devices`), `apps/server/src/templates.ts` (`dailyStatsEmail`), `apps/server/src/kv.ts` (`Kv.persistence()`), `apps/server/src/devices/api.ts` (mode, owner and endpoint refusals counted), `apps/server/src/checker.ts` (a clean-up failure counted), `apps/server/src/check.ts` and `apps/server/src/server.ts` (limits passed to the report)
- Test: `apps/server/test/devices-counters.test.ts`, `apps/server/test/stats.test.ts` (more cases)

**Interfaces:**
- Consumes: every `count(...)` in the device scripts (Tasks 2, 6, 7, 10, 11, 12); `K.statsV2`.
- Produces:
  - `DEVICE_COUNTERS: { name: string; unit: 'requests' | 'operations' | 'alerts' | 'dates' | 'claims' | 'batches' | 'entries' | 'records' | 'runs' | 'pushes'; when: string }[]` — names may end in `*` (a family, e.g. `ops_*`).
  - `countDevice(kv: Kv, now: number, name: string, by?: number): Promise<void>` (for counts made outside a script: route refusals, a failed clean-up).
  - `deviceGauges(kv: Kv, limits: { alertLimit: number; recordLimit: number }): Promise<DeviceGauges>` with `DeviceGauges = { readAt: string; alertsActive: number; setupsUnfinished: number; alerts: number; alertLimit: number; units: number; recordLimit: number; flags: string[]; persistence: { rdbLastOk: string | null; rdbStatus: string | null; aofOkAfter: string | null; aofOkBy: string | null; aofRewriteStatus: string | null } }`: the last successful snapshot, and the last append-only rewrite known to have started after one time and finished successfully by another, each with its current status.
  - `Kv.persistence(): Promise<{ rdbLastSave: number | null; rdbStatus: string | null; aofRewrites: number | null; aofInProgress: number | null; aofFailures: number | null; aofRewriteStatus: string | null }>` (`INFO persistence`: `rdb_last_save_time`, `rdb_last_bgsave_status`, `aof_rewrites`, `aof_rewrite_in_progress`, `aof_rewrites_consecutive_failures`, `aof_last_bgrewrite_status`; MemoryKv: all null).
  - `notePersistence(kv, now): Promise<void>` (counters.ts), called by every checker run: Valkey reports no time for the last append-only rewrite, so runs bracket it (`pp:persist`, a hash: `aofRewrites` and `aofIdleAt`, the count at the last reading with no rewrite in progress and its time; `aofOkAfter`, `aofOkBy`). When a reading with no rewrite in progress finds the count grown since the last such reading and the status `ok`, a rewrite started after that earlier reading (none was running then) and finished by this one (none is running now), and the last to finish succeeded. Deleted data is out of the AOF once a rewrite that started after the deletion has finished, so the report shows "started after … , finished by …" and flags a finish older than 2 hours (the retention table's "normally within the hour" missed). A smaller count (Valkey restarted) only resets the baseline. Valkey counts a rewrite when it starts; a failed one sets the status to `err` and the consecutive-failure count above 0, so both must read `ok` and 0. One case stays invisible: a rewrite an operator cancels (turning the AOF off, `SIGUSR1`) leaves both untouched; the runbook never does that, and says so beside the report's line.
  - `DailyStats.devices: { schema: 2; since: string | null; counts: Record<string, number>; gauges: DeviceGauges | null } | null` and `DailyStats.schema` stays 1 for the v1 part.
  - `dailyStats(kv, day, now, limits?)` gains the optional limits; `reportOncePerDay` passes them through `ReportDeps.deviceLimits?`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/devices-counters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEVICE_SCRIPTS } from '../src/devices/lua.ts';
import { DEVICE_COUNTERS } from '../src/devices/counters.ts';

/** Every count() a script makes: literal names, and families built as 'prefix_' .. something. */
function countsIn(lua: string): string[] {
  const out = new Set<string>();
  for (const m of lua.matchAll(/count\('([a-z_]+)'(\s*\.\.)?/g)) out.add(m[2] ? `${m[1]}*` : m[1]!);
  return [...out];
}

describe('the counters', () => {
  it('are each listed with a unit and the transition that increments them, and every listed one is used', async () => {
    await import('../src/devices/scripts-api.ts');
    await import('../src/devices/scripts-delivery.ts');
    await import('../src/devices/limits.ts');
    await import('../src/devices/lock.ts');
    const used = new Set(DEVICE_SCRIPTS.flatMap((s) => countsIn(s.def.lua)));
    const listed = new Set(DEVICE_COUNTERS.map((c) => c.name));
    // A literal name is covered by its own row or by a family's ("claims_*" covers "claims_recovered").
    const covered = (name: string) => listed.has(name) || (!name.endsWith('*') && [...listed].some((l) => l.endsWith('*') && name.startsWith(l.slice(0, -1))));
    for (const name of used) expect([name, covered(name)]).toEqual([name, true]);
    const outsideScripts = [
      'requests_refused_mode', 'requests_refused_owner', 'requests_refused_endpoint', 'requests_refused_memory', 'cleanup_failures', 'tests_*',
      'fanout_skipped_size', 'fanout_skipped_memory', 'fanout_skipped_failed', 'fanout_skipped_entries', 'fanout_second_failures',
    ];
    for (const name of listed) expect([name, used.has(name) || outsideScripts.includes(name)]).toEqual([name, true]);
    for (const c of DEVICE_COUNTERS) expect(c.when.length).toBeGreaterThan(10);
  });

  it('cover every transition the spec\'s "Reporting" section names', () => {
    const required = [
      'ops_started', 'ops_active', 'ops_expired', 'ops_changed', 'ops_full', 'changes_applied', 'changes_refused',
      'requests_refused_dev-setup-ip', 'requests_refused_mode', 'requests_refused_owner', 'requests_refused_endpoint', 'requests_refused_memory', 'refused_full',
      'alerts_created', 'alerts_changed', 'alerts_off', 'alerts_ended', 'alerts_gone', 'alerts_replaced', 'rotations_completed',
      'claims_accepted', 'claims_gone', 'claims_refused', 'claims_unattempted', 'claims_rejected', 'claims_bug', 'claims_uncertain', 'claims_recovered',
      'dates_dropped_window', 'dates_dropped_tries', 'dates_dropped_overflow', 'dates_dropped_unknown_age', 'dates_held_cap', 'tests_accepted',
      'dispatch_accepted', 'dispatch_retryable', 'dispatch_uncertain',
    ];
    const listed = DEVICE_COUNTERS.map((c) => c.name);
    const covered = (name: string) => listed.includes(name) || listed.some((l) => l.endsWith('*') && name.startsWith(l.slice(0, -1)));
    for (const name of required) expect([name, covered(name)]).toEqual([name, true]);
  });
});
```

Append to `apps/server/test/stats.test.ts`:

```ts
describe('notification numbers', () => {
  it('reports the day\'s v2 counters and gauges, saying when counting began that day', async () => {
    const t = clock(Date.parse('2026-10-07T00:00:00Z'));
    const kv = new MemoryKv(t.now);
    await kv.write([{ op: 'hSet', key: K.statsV2('2026-10-06'), fields: { ops_started: '4', ops_active: '3', since: String(Date.parse('2026-10-06T05:00:00Z')) } }]);
    await kv.write([{ op: 'hSet', key: K.devRecords, fields: { units: '2900', alerts: '450' } }]);
    const s = await dailyStats(kv, '2026-10-06', t.now(), { alertLimit: 500, recordLimit: 3500 });
    expect(s.devices).toMatchObject({ schema: 2, since: '2026-10-06T05:00:00.000Z', counts: { ops_started: 4, ops_active: 3 } });
    expect(s.devices!.gauges).toMatchObject({ alerts: 450, alertLimit: 500, units: 2900, recordLimit: 3500, flags: ['alerts at 90% of DEVICE_ALERT_LIMIT', 'records at 83% of DEVICE_RECORD_LIMIT'] });
    const mail = dailyStatsEmail(s);
    expect(mail.text).toContain('Notification alerts');
    expect(mail.text).toContain('Operations started (setups, rotations, changes): 4');
    expect(mail.text).toContain('Counting began at: 1:00 PM');
  });

  it('brackets an append-only rewrite between two idle readings, and never counts one still running', async () => {
    const kv = new MemoryKv();
    let p = { rdbLastSave: null, rdbStatus: null, aofRewrites: 3, aofInProgress: 0, aofFailures: 0, aofRewriteStatus: 'ok' };
    kv.persistence = async () => p;
    await notePersistence(kv, 1000); // baseline: 3, idle
    p = { ...p, aofRewrites: 4, aofInProgress: 1 };
    await notePersistence(kv, 2000); // running: not counted, baseline kept
    expect(await kv.hGetAll(K.persist)).toEqual({ aofRewrites: '3', aofIdleAt: '1000' });
    p = { ...p, aofInProgress: 0 };
    await notePersistence(kv, 3000);
    expect(await kv.hGetAll(K.persist)).toMatchObject({ aofOkAfter: '1000', aofOkBy: '3000' });
    p = { ...p, aofRewrites: 0 }; // Valkey restarted: a new baseline, nothing claimed
    await notePersistence(kv, 4000);
    expect(await kv.hGetAll(K.persist)).toMatchObject({ aofRewrites: '0', aofIdleAt: '4000', aofOkBy: '3000' });
    p = { ...p, aofRewrites: 1, aofFailures: 1, aofRewriteStatus: 'err' }; // a failed rewrite: never claimed as done
    await notePersistence(kv, 5000);
    expect(await kv.hGetAll(K.persist)).toMatchObject({ aofOkBy: '3000' });
  });

  it('keeps the last successful snapshot time when the latest attempt failed, and flags the failure', async () => {
    const now = Date.parse('2026-10-07T00:00:00Z');
    const kv = new MemoryKv(() => now);
    kv.persistence = async () => ({ rdbLastSave: now / 1000 - 600, rdbStatus: 'err', aofRewrites: null, aofInProgress: null, aofFailures: null, aofRewriteStatus: null });
    const g = await deviceGauges(kv, now, { alertLimit: 300, recordLimit: 1750 });
    expect(g.persistence.rdbLastOk).toBe(new Date(now - 600_000).toISOString());
    expect(g.flags).toContain('the latest snapshot attempt failed (err)');
  });

  it('has no device section for a day before the redesign', async () => {
    const kv = new MemoryKv();
    expect((await dailyStats(kv, '2026-10-01', Date.parse('2026-10-02T00:00:00Z'))).devices).toBeNull();
  });
});
```

(Add the imports `K` from `../src/keys.ts`, `dailyStatsEmail` from `../src/templates.ts` and `notePersistence`, `deviceGauges` from `../src/devices/counters.ts` if `stats.test.ts` lacks them.)

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- devices-counters stats`
Expected: FAIL: `Cannot find module '../src/devices/counters.ts'`; `devices` undefined.

- [ ] **Step 3: The counter list**

`apps/server/src/devices/counters.ts`:

```ts
// Every notification counter (spec: "Reporting"), its unit, and the transition that increments it, inside the
// atomic step that makes the change (so a retry or a crash cannot count twice). devices-counters.test.ts checks this
// list against every count() in the scripts, both ways.
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { deviceScript } from './lua.ts';

type Unit = 'requests' | 'operations' | 'alerts' | 'dates' | 'claims' | 'batches' | 'entries' | 'records' | 'runs' | 'pushes';

export const DEVICE_COUNTERS: { name: string; unit: Unit; when: string }[] = [
  { name: 'requests_refused_*', unit: 'requests', when: 'a request refused by a pool, by the pool that refused (charge)' },
  { name: 'requests_refused_mode', unit: 'requests', when: 'a setup refused because the mode does not allow it (off, unavailable)' },
  { name: 'requests_refused_owner', unit: 'requests', when: 'a first setup refused in owner mode without the right token' },
  { name: 'requests_refused_endpoint', unit: 'requests', when: 'a setup refused because its subscription failed the endpoint checks' },
  { name: 'requests_refused_memory', unit: 'requests', when: 'a setup refused because Valkey was above 70% of its memory' },
  { name: 'refused_*', unit: 'requests', when: 'an admission refused by the script: busy, invalid, changed, full, limited' },
  { name: 'ops_started', unit: 'operations', when: 'a setup, rotation or change stored for the first time (its op)' },
  { name: 'ops_*', unit: 'operations', when: 'an operation ended with this result: active, expired, changed, full, owner-only, gone, failed, off' },
  { name: 'dispatch_*', unit: 'pushes', when: 'a setup push settled: accepted, uncertain, retryable, failed, gone' },
  { name: 'dispatch_held_*', unit: 'pushes', when: 'a setup push held at its gate: mode, paused, backoff, limited' },
  { name: 'acks', unit: 'requests', when: 'an acknowledgement reached the atomic step (counted toward the 10 per operation)' },
  { name: 'alerts_created', unit: 'alerts', when: 'an activation created an alert (a new incarnation)' },
  { name: 'alerts_changed', unit: 'alerts', when: 'a setup with a captured alert replaced its choices' },
  { name: 'alerts_*', unit: 'alerts', when: 'an alert deleted: ended, gone, off (turned off), replaced' },
  { name: 'rotations_completed', unit: 'alerts', when: 'a rotation activated a new subscription' },
  { name: 'changes_applied', unit: 'operations', when: 'a change applied (revision + 1)' },
  { name: 'changes_refused', unit: 'operations', when: 'a change refused with 409 (incarnation or revision not current)' },
  { name: 'renewals', unit: 'requests', when: 'a renewal on opening reached the script with an active alert' },
  { name: 'gone_kept', unit: 'alerts', when: 'a gone report kept an alert because a rotation is pending (goneGeneration set)' },
  { name: 'fanout_batches', unit: 'batches', when: 'a fan-out batch stored with the first queueing write' },
  { name: 'fanout_dropped_batches', unit: 'batches', when: 'a fan-out batch not stored because 5 were pending' },
  { name: 'fanout_dropped_entries', unit: 'entries', when: 'the entries of a batch not stored because 5 were pending' },
  { name: 'fanout_merged', unit: 'alerts', when: 'jobs written by a chunk of the second queueing write' },
  { name: 'fanout_skipped_size', unit: 'batches', when: 'a fan-out batch over 2,000 entries, left out of the first queueing write' },
  { name: 'fanout_skipped_memory', unit: 'batches', when: 'a fan-out batch left out because used_memory was above 85%' },
  { name: 'fanout_skipped_failed', unit: 'batches', when: 'a first queueing write that failed with its batch and was written again without it' },
  { name: 'fanout_skipped_entries', unit: 'entries', when: 'the entries of a batch left out for any of the three reasons above' },
  { name: 'fanout_second_failures', unit: 'runs', when: 'a run whose second queueing write failed (the batch stays for the next run)' },
  { name: 'dates_dropped_overflow', unit: 'dates', when: 'dates dropped to keep a job within 30 dates and 4 KB' },
  { name: 'dates_dropped_choices', unit: 'dates', when: 'dates dropped because the alert no longer follows that office and group, or has another incarnation' },
  { name: 'dates_dropped_window', unit: 'dates', when: 'dates dropped past their 3-hour window' },
  { name: 'dates_dropped_unknown_age', unit: 'dates', when: 'dates dropped because their age cannot be known (another boot)' },
  { name: 'dates_dropped_tries', unit: 'dates', when: 'dates dropped after 3 refused tries' },
  { name: 'dates_held_cap', unit: 'dates', when: 'dates held because the alert reached its daily cap' },
  { name: 'claims', unit: 'claims', when: 'a claim made' },
  { name: 'claims_refused_*', unit: 'claims', when: 'a claim refused: none, ended, claimed, attempted, empty, deferred, unverified, pace, cap' },
  { name: 'claims_*', unit: 'claims', when: 'a claim settled: accepted, uncertain, bug, gone, refused (put back after an attempt), unattempted, recovered, recovered_uncertain' },
  { name: 'garbage_removed', unit: 'alerts', when: 'a deleted alert\'s delivery keys removed and its units released' },
  { name: 'fanout_expired', unit: 'batches', when: 'a fan-out batch past its 3-hour window removed by clean-up' },
  { name: 'tests_*', unit: 'pushes', when: 'a test notification sent, by its result: accepted, uncertain, refused, gone (counted by the route after the send)' },
  { name: 'recount_differences', unit: 'runs', when: 'the daily recount found units or alerts different from those kept' },
  { name: 'cleanup_failures', unit: 'runs', when: 'a run\'s notification clean-up failed (its notification pass was skipped)' },
];

const countScript = deviceScript('dev-count', `count(A.name, A.by) return '"ok"'`);

/** A count made outside a script (a route's own refusal, a failed clean-up), into the same day's v2 hash. */
export async function countDevice(kv: Kv, now: number, name: string, by = 1): Promise<void> {
  await countScript.run(kv, { stats: K.statsV2(manilaDay(now)) }, { now, name, by });
}

export interface DeviceGauges {
  readAt: string;
  alertsActive: number;
  setupsUnfinished: number;
  alerts: number;
  alertLimit: number;
  units: number;
  recordLimit: number;
  flags: string[];
  persistence: { rdbLastOk: string | null; rdbStatus: string | null; aofOkAfter: string | null; aofOkBy: string | null; aofRewriteStatus: string | null };
}

const gaugeScript = deviceScript(
  'dev-gauges',
  `need(KEY.ends, 'zset') need(KEY.ops, 'zset') need(KEY.records, 'hash')
return cjson.encode({ active = redis.call('ZCOUNT', KEY.ends, '(' .. I(NOW), '+inf'), ops = redis.call('ZCARD', KEY.ops),
  units = tonumber(redis.call('HGET', KEY.records, 'units') or '0'), alerts = tonumber(redis.call('HGET', KEY.records, 'alerts') or '0') })`,
  { reclaim: true },
);

export async function deviceGauges(kv: Kv, now: number, limits: { alertLimit: number; recordLimit: number }): Promise<DeviceGauges> {
  const g = await gaugeScript.run<{ active: number; ops: number; units: number; alerts: number }>(kv, {}, { now });
  const p = await kv.persistence();
  const noted = await kv.hGetAll(K.persist);
  const flags: string[] = [];
  const stale = (ms: number | null) => ms === null || now - ms > 2 * 3600_000;
  // rdb_last_save_time is the last successful save whatever the latest attempt did; the status is the latest attempt's.
  if (p.rdbStatus !== null && stale(p.rdbLastSave ? p.rdbLastSave * 1000 : null)) flags.push('no successful snapshot in 2 hours: deleted data may stay in dump.rdb longer');
  if (p.rdbStatus !== null && p.rdbStatus !== 'ok') flags.push(`the latest snapshot attempt failed (${p.rdbStatus})`);
  if (p.aofRewriteStatus !== null && p.aofRewriteStatus !== 'ok') flags.push(`the latest append-only rewrite failed (${p.aofRewriteStatus})`);
  if (p.aofRewriteStatus !== null && stale(noted.aofOkBy ? Number(noted.aofOkBy) : null)) flags.push('no append-only rewrite known to have finished in 2 hours: deleted data may stay in the AOF longer');
  const share = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
  if (limits.alertLimit > 0 && g.alerts >= 0.8 * limits.alertLimit) flags.push(`alerts at ${share(g.alerts, limits.alertLimit)}% of DEVICE_ALERT_LIMIT`);
  if (limits.recordLimit > 0 && g.units >= 0.8 * limits.recordLimit) flags.push(`records at ${share(g.units, limits.recordLimit)}% of DEVICE_RECORD_LIMIT`);
  return {
    readAt: new Date(now).toISOString(),
    alertsActive: g.active,
    setupsUnfinished: g.ops,
    alerts: g.alerts,
    alertLimit: limits.alertLimit,
    units: g.units,
    recordLimit: limits.recordLimit,
    flags,
    persistence: {
      rdbLastOk: p.rdbLastSave ? new Date(p.rdbLastSave * 1000).toISOString() : null,
      rdbStatus: p.rdbStatus,
      aofOkAfter: noted.aofOkAfter ? new Date(Number(noted.aofOkAfter)).toISOString() : null,
      aofOkBy: noted.aofOkBy ? new Date(Number(noted.aofOkBy)).toISOString() : null,
      aofRewriteStatus: p.aofRewriteStatus,
    },
  };
}
```

`ZCOUNT` joins `command()` in `kv.ts` (Task 1's subset):

```ts
      case 'ZCOUNT': {
        const min = bound(rest[0] ?? '', true);
        const max = bound(rest[1] ?? '', false);
        return (zset(false)?.ordered() ?? []).filter(([, s]) => (min.open ? s > min.v : s >= min.v) && (max.open ? s < max.v : s <= max.v)).length;
      }
```

`Kv.persistence()` (kv.ts): in `connectRedis`,

```ts
    async persistence() {
      const info = await client.info('persistence');
      const field = (name: string) => new RegExp(`^${name}:(\\S+)`, 'm').exec(info)?.[1] ?? null;
      const last = field('rdb_last_save_time');
      const num = (name: string) => {
        const v = field(name);
        return v === null ? null : Number(v);
      };
      return { rdbLastSave: num('rdb_last_save_time'), rdbStatus: field('rdb_last_bgsave_status'), aofRewrites: num('aof_rewrites'), aofInProgress: num('aof_rewrite_in_progress'), aofFailures: num('aof_rewrites_consecutive_failures'), aofRewriteStatus: field('aof_last_bgrewrite_status') };
    },
```

and in `MemoryKv`: `async persistence() { return { rdbLastSave: null, rdbStatus: null, aofRewrites: null, aofInProgress: null, aofFailures: null, aofRewriteStatus: null }; }`. (`const last = field('rdb_last_save_time');` above goes; `num` replaces it.)

`K.persist` = `pp:persist` (keys.ts). In counters.ts:

```ts
/**
 * Valkey says when the last snapshot succeeded, but not when the last append-only rewrite did: runs bracket it. Only a
 * reading with no rewrite in progress counts; between two such readings, a grown count means a rewrite started after the
 * first and finished before the second.
 */
export async function notePersistence(kv: Kv, now: number): Promise<void> {
  const p = await kv.persistence();
  if (p.aofRewrites === null || p.aofInProgress !== 0) return;
  const healthy = p.aofRewriteStatus === 'ok' && (p.aofFailures ?? 0) === 0;
  const noted = await kv.hGetAll(K.persist);
  const before = noted.aofRewrites === undefined ? null : Number(noted.aofRewrites);
  const fields: Record<string, string> = { aofRewrites: String(p.aofRewrites), aofIdleAt: String(now) };
  if (before !== null && noted.aofIdleAt && p.aofRewrites > before && healthy) {
    fields.aofOkAfter = noted.aofIdleAt;
    fields.aofOkBy = String(now);
  }
  await kv.write([{ op: 'hSet', key: K.persist, fields }]);
}
```

The checker calls it once per run after clean-up (`await notePersistence(kv, now()).catch(() => {})`). MemoryKv reports no persistence, so in tests the gauges carry nulls and no persistence flag.

- [ ] **Step 4: The report**

`apps/server/src/stats.ts`: `DailyStats` gains

```ts
  /** Notification alerts' numbers (pp:stats:v2:), from the redesign's deploy on; null for days before it. */
  devices: { schema: 2; since: string | null; counts: Record<string, number>; gauges: DeviceGauges | null } | null;
```

and `dailyStats(kv, day, now, limits?)` fills it:

```ts
  const v2 = await kv.hGetAll(K.statsV2(day));
  const { since: sinceMs, recounted: _r, ...rest } = v2;
  const devices = Object.keys(v2).length === 0
    ? null
    : {
        schema: 2 as const,
        since: sinceMs && manilaDay(Number(sinceMs)) === day ? new Date(Number(sinceMs)).toISOString() : null,
        counts: Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, Number(v)])),
        gauges: limits ? await deviceGauges(kv, now, limits) : null,
      };
```

`ReportDeps` gains `deviceLimits?: { alertLimit: number; recordLimit: number }` and `reportOncePerDay` passes it to `dailyStats`. The checker passes `deviceLimits` from `CheckDeps` (add `deviceLimits?: { alertLimit: number; recordLimit: number }` to `CheckDeps`; `check.ts` sets it from `config.devices`).

`apps/server/src/templates.ts`, `dailyStatsEmail`: when `stats.devices` is not null, add a section after "Alerts":

```ts
    ...(stats.devices
      ? ([
          [
            'Notification alerts',
            [
              ...(stats.devices.since ? ([['Counting began at', manilaTime(stats.devices.since)]] as [string, string][]) : []),
              // ops_* count every operation kind: setups and rotations (proved by the ready check), and changes (Task 7).
              ['Operations started (setups, rotations, changes)', String(stats.devices.counts.ops_started ?? 0)],
              ['Operations completed (setups, rotations, changes)', String(stats.devices.counts.ops_active ?? 0)],
              ['Setups and rotations expired before the ready check', String(stats.devices.counts.ops_expired ?? 0)],
              ['Changes applied', String(stats.devices.counts.changes_applied ?? 0)],
              ['Turned off', String(stats.devices.counts.alerts_off ?? 0)],
              ['Ended after 180 days', String(stats.devices.counts.alerts_ended ?? 0)],
              ['Gone (the push service dropped them)', String(stats.devices.counts.alerts_gone ?? 0)],
              ['Notifications accepted by push services', String(stats.devices.counts.claims_accepted ?? 0)],
              ['Not confirmed by the push service', String(stats.devices.counts.claims_uncertain ?? 0)],
              ['Refused, to try again', String(stats.devices.counts.claims_refused ?? 0)],
              ['Dates dropped past their window', String(stats.devices.counts.dates_dropped_window ?? 0)],
              ['Requests refused by limits', String(Object.entries(stats.devices.counts).filter(([k]) => k.startsWith('requests_refused_dev-')).reduce((n, [, v]) => n + v, 0))],
              ['Setups refused: push off or paused', String(stats.devices.counts.requests_refused_mode ?? 0)],
              ['Setups refused: owner link missing', String(stats.devices.counts.requests_refused_owner ?? 0)],
              ['Setups refused: not a browser push service', String(stats.devices.counts.requests_refused_endpoint ?? 0)],
              ['Setups refused: memory', String(stats.devices.counts.requests_refused_memory ?? 0)],
              ['Test notifications sent', String(Object.entries(stats.devices.counts).filter(([k]) => k.startsWith('tests_')).reduce((n, [, v]) => n + v, 0))],
              ...(stats.devices.counts.cleanup_failures ? ([['Clean-up failures (retention may slip)', String(stats.devices.counts.cleanup_failures)]] as [string, string][]) : []),
              ...(stats.devices.gauges
                ? ([
                    ['Active now', String(stats.devices.gauges.alertsActive)],
                    ['Alerts and reservations', `${stats.devices.gauges.alerts} of ${stats.devices.gauges.alertLimit}`],
                    ['Storage units', `${stats.devices.gauges.units} of ${stats.devices.gauges.recordLimit}`],
                    ['Last successful database snapshot', stats.devices.gauges.persistence.rdbLastOk ? manilaTime(stats.devices.gauges.persistence.rdbLastOk) : `none known (${stats.devices.gauges.persistence.rdbStatus ?? 'unknown'})`],
                    // Valkey gives no time for it: bracketed by two checker runs (notePersistence).
                    [
                      'Last append-only rewrite known finished',
                      stats.devices.gauges.persistence.aofOkBy && stats.devices.gauges.persistence.aofOkAfter
                        ? `started after ${manilaTime(stats.devices.gauges.persistence.aofOkAfter)}, finished by ${manilaTime(stats.devices.gauges.persistence.aofOkBy)}`
                        : `none known (${stats.devices.gauges.persistence.aofRewriteStatus ?? 'unknown'})`,
                    ],
                    ...stats.devices.gauges.flags.map((f): [string, string] => ['Flag', f]),
                  ] as [string, string][])
                : []),
            ],
          ],
        ] as [string, [string, string][]][])
      : []),
```

(05:00Z is 1:00 PM in Manila; rows render as `  ${label}: ${value}`.)

- [ ] **Step 5: Counts made outside scripts**

In the test route of `apps/server/src/devices/api.ts`, after the send: `await countDevice(kv, d.now(), `tests_${result.kind}`).catch(() => {})`. (The change script already counts `ops_started` and `ops_<result>`, Task 7; settlement counts `claims_rejected` and `claims_throttled`, Task 11.)

In `apps/server/src/devices/api.ts`'s `start()`: before each `answer(c, 'off' | 'unavailable')` for the mode or the stop, `await countDevice(kv, d.now(), 'requests_refused_mode')`; before `answer(c, 'owner-only')`, `'requests_refused_owner'`; before the `bad(c)` for a failed `checkPushSubscription`, `'requests_refused_endpoint'`; before `answer(c, 'full')` for memory, `'requests_refused_memory'`. In `checker.ts`, in the clean-up `catch`, `await countDevice(kv, now(), 'cleanup_failures').catch(() => {})`.

The fan-out's dropped work (spec: "the notification work of those openings is dropped and counted"; "a failure of the second write is caught, logged and counted"), counted best-effort (a failed count never stops email) and once, after the write it describes succeeded. In Task 10's `writeQueue`, a `skipped: 'size' | 'memory' | 'failed' | null` is set where each `log.warn`/`log.error` drops the batch (`'size'`, `'memory'`; `'failed'` in the `catch` that writes again without it), and after the `queueWrite` that stored the email work:

```ts
  if (skipped) {
    await countDevice(kv, deps.now(), `fanout_skipped_${skipped}`).catch(() => {});
    await countDevice(kv, deps.now(), 'fanout_skipped_entries', entries.length).catch(() => {});
  }
```

(the `catch`'s retry becomes `await queueWrite(…batch: null); skipped = 'failed';`, and the count follows it). In Task 11's `fanout` (the second write's error boundary in the run), after its `log.error`: `await countDevice(kv, deps.now(), 'fanout_second_failures').catch(() => {});`.

Tests, appended to `apps/server/test/checker-devices.test.ts`:

```ts
  it('counts notification work left out of the first write, and a failed second write, without stopping email', async () => {
    const w = await deviceWorld({ devices: { mode: 'live', transport: null } });
    await w.run();
    for (let i = 0; i < 3; i++) await seedAlert(w.kv, { now: w.t.now(), order: 0 });
    // Memory above 85%: the batch is left out and counted; the email work is written as usual.
    w.kv.memory = async () => ({ used: 90, max: 100 });
    w.upstream.open.set('486', ['2026-10-09']);
    await w.run();
    const day = (await import('../src/keys.ts')).manilaDay(w.t.now());
    expect(await w.kv.hGetAll(K.statsV2(day))).toMatchObject({ fanout_skipped_memory: '1', fanout_skipped_entries: '1' });
  });
```

(the three alerts follow Antipolo for 1 person: one entry, for one office, date and group.) The size and failure paths are covered in Task 10's `writeQueue` unit tests: add one case each there asserting `fanout_skipped_size` (2,001 entries) and `fanout_skipped_failed` (a `queueWrite` that throws once with a batch), and in Task 11's notification-pass tests one where `writeFanout` throws (`fanout_second_failures: '1'`, and the run's email delivery still happens).

- [ ] **Step 6: Watch them pass**

Run: `npm test -w @penge/server -- devices-counters stats checker-devices devices-queue`
Expected: PASS.

- [ ] **Step 7: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review: notification counters under pp:stats:v2:, each incremented inside the atomic step that makes the change, a list of every counter with its unit and transition checked against the scripts both ways, gauges with the time read, and the daily report's new section split at the deploy time. Find a counter that can double-count on retry, a transition with no counter, and anything in the report that claims a number of people."). Then:

```bash
git add apps/server/src apps/server/test/devices-counters.test.ts apps/server/test/stats.test.ts
git commit -m "The day's numbers for notification alerts, versioned, with every transition's counter listed"
```

---
### Task 14: This device's state: one IndexedDB record and one lock, shared by page and worker

**Files:**
- Create: `apps/web/src/devices/state.js` (plain JavaScript: the worker inlines it), `apps/web/src/devices/state.d.ts`
- Test: `apps/web/test/state.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the fingerprint must equal the contracts' `canonicalSubscription` hashed; the test checks that).
- Produces (`state.d.ts`):

```ts
export const DB_NAME: 'pengepassportph-device-alerts';
export const LOCK_NAME: 'pengepassportph-device-alerts';
export const DRIVER_LOCK: 'pengepassportph-device-alerts-driver';
export const LEGACY_DB: 'pengepassportph-push';
export class Unsupported extends Error {}
export interface Env { indexedDB?: IDBFactory; locks?: Pick<LockManager, 'request' | 'query'>; crypto: Crypto }
export interface SubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }
/** preparing → attached (a subscription, by one caller) → ready (that caller's handshake done) → sent (the server answered). */
export type Phase = 'preparing' | 'attached' | 'ready' | 'sent';
export interface Operation {
  op: string; seq: number; epoch: number; kind: 'setup' | 'change' | 'rotate'; phase: Phase;
  choices: AlertChoices | null; captured: { incarnation: string; generation: number; revision?: number } | null;
  subscription: SubscriptionJson | null; fingerprint: string | null; nonce: string | null;
  expiresAt: number | null; createdAt: number; result: string | null; activation: Activation | null;
  /** Who attached the subscription (the attaching caller's id): only that caller may abandon it once attached. */
  by: string | null;
}
/** A turn-off's claim when the browser's subscription could not be read: whatever subscription is found later is removed. */
export const UNKNOWN_SUBSCRIPTION: '?';
export interface Known { alertId: string; incarnation: string; generation: number; revision: number; fingerprint: string; endsAt: number; choices: AlertChoices }
export interface DeviceState {
  credential: string | null; seq: number; epoch: number; op: Operation | null; needsRotation: boolean;
  claim: { task: string; fingerprint: string } | null;
  retired: { credential: string; fingerprint: string | null; deleted: boolean; unsubscribed: boolean }[];
  vapidKey: string | null; known: Known | null; renewedAt: number | null; gone: string[];
  /** Goes up with every change to `known` (and every turn-off): a read fences its writes by the value it started from. */
  knownVersion: number;
  /** The last choices a setup or change asked for. */
  choices: AlertChoices | null;
}
export function readState(env: Env): Promise<DeviceState>;
export function update<T>(env: Env, fn: (s: DeviceState) => { state?: DeviceState; result: T }): Promise<T>;
export function opDone(op: Operation, now: number): boolean;
/** Blocked while an unsubscribe claim or a retired credential's server deletion is unresolved (checked under the lock). */
export function begin(env: Env, a: { kind: Operation['kind']; choices: AlertChoices | null; captured: Operation['captured']; now: number }):
  Promise<{ started: Operation; credential: string } | { joined: Operation } | { waiting: Operation } | { blocked: 'claim' | 'retired' }>;
export function attach(env: Env, a: { op: string; epoch: number; subscription: SubscriptionJson; fingerprint: string; by: string }): Promise<'ok' | 'already' | 'abandoned'>;
/** The attaching caller's handshake is done: attached → ready (only `by`, only while attached). Only a ready operation is sent. */
export function confirmReady(env: Env, a: { op: string; by: string }): Promise<boolean>;
/** Drops the operation only while preparing, or while attached by `by`; never once ready (it may be sent), never another's. */
export function abandon(env: Env, a: { op: string; fingerprint: string | null; by: string | null }): Promise<{ task: string; fingerprint: string } | null>;
export function markSent(env: Env, a: { op: string; expiresAt: number | null }): Promise<boolean>;
export function storeNonce(env: Env, a: { op: string; credential: string; fingerprint: string; nonce: string }): Promise<boolean>;
export function recordResult(env: Env, a: { op: string; credential: string; result: string; activation: Activation | null }): Promise<boolean>;
export function finish(env: Env, a: { op: string }): Promise<void>;
/**
 * Writes the known alert for this credential. Refused: an older generation or revision of the same incarnation; and,
 * when `version` is given (the `knownVersion` a read started from), any write after `known` changed since, so a late
 * read never clears, replaces or brings back what a newer step wrote.
 */
export function setKnown(env: Env, a: { credential: string; known: Known | null; version?: number }): Promise<boolean>;
/** A renewal's new end, written only onto the same alert (alertId, incarnation, generation) still known: never restores one. */
export function setEndsAt(env: Env, a: { credential: string; alertId: string; incarnation: string; generation: number; endsAt: number }): Promise<Known | null>;
/** Recovery of an attached operation whose caller went away: ownership moves from `from` to `by` (compare-and-set). */
export function adopt(env: Env, a: { op: string; from: string | null; by: string }): Promise<boolean>;
export function turnOff(env: Env, a: { fingerprint: string | null }): Promise<{ claim: { task: string; fingerprint: string } | null; retired: string | null }>;
/** `fingerprint`: null when the browser has no subscription; UNKNOWN_SUBSCRIPTION when it could not be asked (claimed, resolved once it can be). */
/** Clears the claim when `unsubscribed` (confirmed), replaces it with one for `replaceWith`, or keeps it (returned) when the unsubscribe failed. */
export function settleClaim(env: Env, a: { task: string; unsubscribed: boolean; replaceWith?: string | null }): Promise<{ task: string; fingerprint: string } | null>;
export function retiredDeleted(env: Env, a: { credential: string }): Promise<void>;
export function setNeedsRotation(env: Env, on: boolean): Promise<void>;
export function setVapid(env: Env, key: string): Promise<void>;
export function setRenewed(env: Env, a: { credential: string; at: number }): Promise<void>;
export function noteGone(env: Env, fingerprint: string): Promise<void>;
export function legacyCredential(env: Env): Promise<'yes' | 'no' | 'empty' | 'unknown'>;
export function deleteLegacy(env: Env): Promise<void>;
export function canonical(json: SubscriptionJson): string;
export function fingerprint(env: Env, json: SubscriptionJson): Promise<string>;
export function newCredential(env: Env): string;
export function newId(env: Env): string;
export function credentialHash(env: Env, credential: string): Promise<string>;
```

- [ ] **Step 1: Write the failing tests**

`apps/web/test/state.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { canonicalSubscription } from '@penge/contracts';
import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as S from '../src/devices/state.js';

/** A Web Lock manager good enough for tests: one holder per name, FIFO. */
export function fakeLocks() {
  const queues = new Map<string, Promise<unknown>>();
  return {
    held: [] as string[],
    request(name: string, fn: () => Promise<unknown>) {
      const prev = queues.get(name) ?? Promise.resolve();
      const run = prev.then(async () => {
        this.held.push(name);
        try {
          return await fn();
        } finally {
          this.held.splice(this.held.indexOf(name), 1);
        }
      });
      queues.set(name, run.catch(() => undefined));
      return run;
    },
    async query() {
      return { held: this.held.map((name) => ({ name })) };
    },
  };
}
export const env = (): S.Env => ({ indexedDB: new IDBFactory(), locks: fakeLocks() as never, crypto: webcrypto as Crypto });

const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) } };
const choices = { siteIds: [486], applicants: 1, pace: 'asap' as const };
const T = 1_791_261_968_326;

describe('this device\'s state', () => {
  it('refuses to start without the lock or the database', async () => {
    // Left out, not set to undefined: Env's optional members (exactOptionalPropertyTypes).
    const { locks: _l, ...noLocks } = env();
    const { indexedDB: _i, ...noDb } = env();
    await expect(S.begin(noLocks, { kind: 'setup', choices, captured: null, now: T })).rejects.toThrow(S.Unsupported);
    await expect(S.begin(noDb, { kind: 'setup', choices, captured: null, now: T })).rejects.toThrow(S.Unsupported);
    const broken = env();
    (broken.indexedDB as unknown as { open: () => never }).open = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    await expect(S.begin(broken, { kind: 'setup', choices, captured: null, now: T })).rejects.toThrow(S.Unsupported);
  });

  it('starts one operation: a credential and seq 1, phase preparing, before any subscription', async () => {
    const e = env();
    const r = await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    expect('started' in r && r.started).toMatchObject({ seq: 1, epoch: 0, kind: 'setup', phase: 'preparing', subscription: null });
    expect((await S.readState(e)).credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('joins the identical operation and makes a different one wait; nothing is cancelled', async () => {
    const e = env();
    const first = await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    expect(await S.begin(e, { kind: 'setup', choices, captured: null, now: T + 1 })).toEqual({ joined: (first as { started: S.Operation }).started });
    expect(Object.keys(await S.begin(e, { kind: 'setup', choices: { ...choices, applicants: 2 }, captured: null, now: T + 1 }))).toEqual(['waiting']);
  });

  it('lets a new operation start once the last has a result, or 30 s after its expiry, or 2 minutes unanswered', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    expect(S.opDone(started, T + 119_000)).toBe(false);
    expect(S.opDone(started, T + 121_000)).toBe(true);
    expect(S.opDone({ ...started, expiresAt: T + 300_000 }, T + 320_000)).toBe(false);
    expect(S.opDone({ ...started, expiresAt: T + 300_000 }, T + 331_000)).toBe(true);
    expect(S.opDone({ ...started, result: 'active' }, T)).toBe(true);
  });

  it('abandons an operation whose subscription arrives after a turn-off (another epoch)', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    await S.turnOff(e, { fingerprint: 'f' });
    expect(await S.attach(e, { op: started.op, epoch: started.epoch, subscription: sub, fingerprint: 'f', by: 'p1' })).toBe('abandoned');
  });

  it('turns off with the subscription unknown: a claim for whatever subscription is found later, never "unsubscribed"', async () => {
    const e = env();
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    const r = await S.turnOff(e, { fingerprint: S.UNKNOWN_SUBSCRIPTION });
    expect(r.claim).toMatchObject({ fingerprint: S.UNKNOWN_SUBSCRIPTION });
    expect((await S.readState(e)).retired[0]).toMatchObject({ fingerprint: S.UNKNOWN_SUBSCRIPTION, unsubscribed: false });
  });

  it('attaches a subscription once: a second page never replaces a prepared request', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    expect(await S.attach(e, { op: started.op, epoch: 0, subscription: sub, fingerprint: 'f1', by: 'p1' })).toBe('ok');
    expect(await S.attach(e, { op: started.op, epoch: 0, subscription: sub, fingerprint: 'f2', by: 'p2' })).toBe('already');
    expect((await S.readState(e)).op).toMatchObject({ fingerprint: 'f1', phase: 'attached' });
    // The loser (or one that never attached) cannot drop the winner's request, nor make it ready.
    await S.abandon(e, { op: started.op, fingerprint: 'f1', by: 'p2' });
    await S.abandon(e, { op: started.op, fingerprint: null, by: null });
    expect(await S.confirmReady(e, { op: started.op, by: 'p2' })).toBe(false);
    expect((await S.readState(e)).op?.op).toBe(started.op);
    // Once its handshake is done the winner makes it ready; then nobody drops it (it may be sent).
    expect(await S.confirmReady(e, { op: started.op, by: 'p1' })).toBe(true);
    await S.abandon(e, { op: started.op, fingerprint: 'f1', by: 'p1' });
    expect((await S.readState(e)).op).toMatchObject({ op: started.op, phase: 'ready' });
  });

  it('lets the attaching caller drop its request when its handshake fails', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    await S.attach(e, { op: started.op, epoch: 0, subscription: sub, fingerprint: 'f1', by: 'p1' });
    await S.abandon(e, { op: started.op, fingerprint: null, by: 'p1' });
    expect((await S.readState(e)).op).toBeNull();
  });

  it('starts nothing while a retired credential\'s server deletion is unresolved', async () => {
    const e = env();
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    await S.turnOff(e, { fingerprint: null });
    expect(await S.begin(e, { kind: 'setup', choices, captured: null, now: T + 1 })).toEqual({ blocked: 'retired' });
    const retired = (await S.readState(e)).retired[0]!.credential;
    await S.retiredDeleted(e, { credential: retired });
    expect(Object.keys(await S.begin(e, { kind: 'setup', choices, captured: null, now: T + 2 })).sort()).toEqual(['credential', 'started']);
  });

  it('keeps an earlier unsubscribe claim on a second turn-off, so every retired credential resolves', async () => {
    const e = env();
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    await S.turnOff(e, { fingerprint: S.UNKNOWN_SUBSCRIPTION });
    const first = (await S.readState(e)).claim!;
    await S.retiredDeleted(e, { credential: (await S.readState(e)).retired[0]!.credential });
    await S.update(e, (s) => ({ state: { ...s, credential: 'c'.repeat(43) }, result: null })); // a later credential
    await S.turnOff(e, { fingerprint: 'real' });
    expect((await S.readState(e)).claim).toEqual(first);
    // The unknown claim meets the real subscription: replaced by a claim for it, then confirmed gone.
    const replaced = await S.settleClaim(e, { task: first.task, unsubscribed: false, replaceWith: 'real' });
    await S.settleClaim(e, { task: replaced!.task, unsubscribed: true });
    await S.retiredDeleted(e, { credential: 'c'.repeat(43) });
    expect((await S.readState(e)).retired).toEqual([]);
  });

  it('never lets a late renewal or read put back older choices, a replaced alert, or a cleared one', async () => {
    const e = env();
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    const cred = (await S.readState(e)).credential!;
    const k = { alertId: 'a', incarnation: 'i', generation: 1, revision: 2, fingerprint: 'f', endsAt: T + 10, choices };
    expect(await S.setKnown(e, { credential: cred, known: k })).toBe(true);
    expect(await S.setKnown(e, { credential: cred, known: { ...k, revision: 1, endsAt: T + 99 } })).toBe(false);
    expect((await S.readState(e)).known).toMatchObject({ revision: 2 });
    // A read that started before a newer write (another incarnation) is refused by its version.
    const v = (await S.readState(e)).knownVersion;
    expect(await S.setKnown(e, { credential: cred, known: { ...k, alertId: 'b', incarnation: 'j' } })).toBe(true);
    expect(await S.setKnown(e, { credential: cred, known: null, version: v })).toBe(false);
    expect((await S.readState(e)).known).toMatchObject({ incarnation: 'j' });
    // A renewal for the replaced alert writes nothing; after a clear it never brings it back.
    expect(await S.setEndsAt(e, { credential: cred, alertId: 'a', incarnation: 'i', generation: 1, endsAt: T + 999 })).toBeNull();
    expect(await S.setKnown(e, { credential: cred, known: null })).toBe(true);
    expect(await S.setEndsAt(e, { credential: cred, alertId: 'b', incarnation: 'j', generation: 1, endsAt: T + 999 })).toBeNull();
    expect((await S.readState(e)).known).toBeNull();
  });

  it('moves an attached operation to a recovering caller only from its recorded owner', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    await S.attach(e, { op: started.op, epoch: 0, subscription: sub, fingerprint: 'f1', by: 'gone-tab' });
    expect(await S.adopt(e, { op: started.op, from: 'someone-else', by: 'p2' })).toBe(false);
    expect(await S.adopt(e, { op: started.op, from: 'gone-tab', by: 'p2' })).toBe(true);
    expect(await S.confirmReady(e, { op: started.op, by: 'gone-tab' })).toBe(false);
    expect(await S.confirmReady(e, { op: started.op, by: 'p2' })).toBe(true);
  });

  it('removes an abandoned operation\'s subscription only if nothing newer uses it', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    await S.update(e, (s) => ({ state: { ...s, known: { alertId: 'a', incarnation: 'i', generation: 1, revision: 1, fingerprint: 'used', endsAt: T, choices } }, result: null }));
    expect(await S.abandon(e, { op: started.op, fingerprint: 'used', by: null })).toBeNull();
    expect(await S.abandon(e, { op: started.op, fingerprint: 'orphan', by: null })).toMatchObject({ fingerprint: 'orphan' });
  });

  it('lets the worker store a nonce and a result only for the current operation, credential and subscription', async () => {
    const e = env();
    const { started, credential } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation; credential: string };
    await S.attach(e, { op: started.op, epoch: 0, subscription: sub, fingerprint: 'f1', by: 'p1' });
    expect(await S.storeNonce(e, { op: started.op, credential, fingerprint: 'other', nonce: 'n' })).toBe(false);
    expect(await S.storeNonce(e, { op: 'old', credential, fingerprint: 'f1', nonce: 'n' })).toBe(false);
    expect(await S.storeNonce(e, { op: started.op, credential, fingerprint: 'f1', nonce: 'n' })).toBe(true);
    expect(await S.recordResult(e, { op: started.op, credential: 'retired', result: 'active', activation: null })).toBe(false);
    expect(await S.recordResult(e, { op: started.op, credential, result: 'active', activation: null })).toBe(true);
    expect(await S.recordResult(e, { op: started.op, credential, result: 'expired', activation: null })).toBe(false); // the first result stands
  });

  it('turns off in one step: epoch + 1, the credential retired, the unsubscribe claim written, the operation dropped', async () => {
    const e = env();
    const { credential } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { credential: string };
    const r = await S.turnOff(e, { fingerprint: 'f1' });
    const s = await S.readState(e);
    expect(r).toMatchObject({ retired: credential, claim: { fingerprint: 'f1' } });
    expect(s).toMatchObject({ credential: null, epoch: 1, op: null, claim: { fingerprint: 'f1' }, retired: [{ credential, fingerprint: 'f1', deleted: false, unsubscribed: false }] });
    expect(await S.begin(e, { kind: 'setup', choices, captured: null, now: T })).toEqual({ blocked: 'claim' });
  });

  it('forgets a retired credential only when both its deletion and its unsubscribe are resolved', async () => {
    const e = env();
    const { credential } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { credential: string };
    const { claim } = await S.turnOff(e, { fingerprint: 'f1' });
    await S.retiredDeleted(e, { credential });
    expect((await S.readState(e)).retired).toHaveLength(1);
    await S.settleClaim(e, { task: claim!.task, unsubscribed: true });
    expect((await S.readState(e)).retired).toEqual([]);
    expect((await S.readState(e)).claim).toBeNull();
  });

  it('keeps a claim whose unsubscribe failed, to try again', async () => {
    const e = env();
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    const { claim } = await S.turnOff(e, { fingerprint: 'f1' });
    expect(await S.settleClaim(e, { task: claim!.task, unsubscribed: false })).toEqual(claim);
    expect((await S.readState(e)).claim).toEqual(claim);
  });

  it('settles a claim only if it is still that task\'s, and can replace it for another subscription', async () => {
    const e = env();
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    const { claim } = await S.turnOff(e, { fingerprint: 'f1' });
    expect(await S.settleClaim(e, { task: 'someone-else', unsubscribed: true })).toBeNull();
    const next = await S.settleClaim(e, { task: claim!.task, unsubscribed: false, replaceWith: 'f2' });
    expect(next).toMatchObject({ fingerprint: 'f2' });
  });

  it('fingerprints a subscription exactly as the server does', async () => {
    const e = env();
    const expected = createHash('sha256').update(canonicalSubscription({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })).digest('base64url');
    expect(await S.fingerprint(e, sub)).toBe(expected);
    expect(await S.fingerprint(e, { ...sub, keys: { p256dh: `${sub.keys.p256dh}=`, auth: `${sub.keys.auth}==` } })).toBe(expected);
  });

  it('sees a credential in the channel release\'s database, and deletes that database', async () => {
    const e = env();
    await new Promise<void>((resolve) => {
      const req = e.indexedDB!.open(S.LEGACY_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('state');
      req.onsuccess = () => {
        const tx = req.result.transaction('state', 'readwrite');
        tx.objectStore('state').put({ credential: 'c'.repeat(43) }, 'device');
        tx.oncomplete = () => (req.result.close(), resolve());
      };
    });
    expect(await S.legacyCredential(e)).toBe('yes');
    await S.deleteLegacy(e);
    expect(await S.legacyCredential(e)).toBe('no');
  });

  it('keeps every change atomic under the lock: two tabs starting at once start one operation', async () => {
    const e = env();
    const [a, b] = await Promise.all([
      S.begin(e, { kind: 'setup', choices, captured: null, now: T }),
      S.begin(e, { kind: 'setup', choices, captured: null, now: T }),
    ]);
    expect([Object.keys(a)[0], Object.keys(b)[0]].sort()).toEqual(['joined', 'started']);
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/web -- state`
Expected: FAIL: `Cannot find module '../src/devices/state.js'`.

- [ ] **Step 3: Write the module**

`apps/web/src/devices/state.js`:

```js
// This device's notification alert: one IndexedDB record and one Web Lock, shared by the page and the service worker
// (spec: "Browser state"). Every change is one short read-check-write under the lock; the lock is never held across a
// network call or a wait for a push. Plain JavaScript: sw-plugin.ts inlines this file into sw.js. Types: state.d.ts.
export const DB_NAME = 'pengepassportph-device-alerts';
export const LOCK_NAME = 'pengepassportph-device-alerts';
export const DRIVER_LOCK = 'pengepassportph-device-alerts-driver';
export const LEGACY_DB = 'pengepassportph-push';
export const UNKNOWN_SUBSCRIPTION = '?';
const STORE = 'state';
const KEY = 'device';
const UNANSWERED_MS = 2 * 60_000;
const AFTER_EXPIRY_MS = 30_000;

export class Unsupported extends Error {
  constructor(message) {
    super(message);
    this.name = 'Unsupported';
  }
}

const empty = () => ({ credential: null, seq: 0, epoch: 0, op: null, needsRotation: false, claim: null, retired: [], vapidKey: null, known: null, renewedAt: null, gone: [], choices: null, knownVersion: 0 });

function open(env, name = DB_NAME) {
  if (!env.indexedDB) return Promise.reject(new Unsupported('no IndexedDB'));
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = env.indexedDB.open(name, 1);
    } catch {
      reject(new Unsupported('IndexedDB refused'));
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Unsupported('IndexedDB failed'));
    req.onblocked = () => reject(new Unsupported('IndexedDB blocked'));
  });
}

/** One transaction; settles on complete, error or abort (a full disk aborts a commit with no request error). */
function transact(env, mode, use, name) {
  return open(env, name).then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        let value;
        use(tx.objectStore(STORE), (v) => (value = v));
        const fail = () => {
          db.close?.();
          reject(new Unsupported('IndexedDB could not save'));
        };
        tx.oncomplete = () => {
          db.close?.();
          resolve(value);
        };
        tx.onerror = fail;
        tx.onabort = fail;
      }),
  );
}

export function readState(env) {
  return transact(env, 'readonly', (store, done) => {
    const req = store.get(KEY);
    req.onsuccess = () => done({ ...empty(), ...(req.result ?? {}) });
  });
}

const write = (env, state) => transact(env, 'readwrite', (store) => void store.put(state, KEY));

function withLock(env, fn) {
  if (!env.locks?.request) return Promise.reject(new Unsupported('no Web Locks'));
  return env.locks.request(LOCK_NAME, fn);
}

/** Read, decide, write: `fn` returns the new state (or none) and a result. */
export function update(env, fn) {
  return withLock(env, async () => {
    const before = await readState(env);
    const { state, result } = fn(before);
    if (state) await write(env, state);
    return result;
  });
}

export function opDone(op, now) {
  if (op.result) return true;
  if (op.expiresAt) return now > op.expiresAt + AFTER_EXPIRY_MS;
  return now > op.createdAt + UNANSWERED_MS;
}

const same = (op, kind, choices, captured) => op.kind === kind && JSON.stringify(op.choices) === JSON.stringify(choices) && JSON.stringify(op.captured) === JSON.stringify(captured);

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const newCredential = (env) => b64url(env.crypto.getRandomValues(new Uint8Array(32)));
export const newId = (env) => b64url(env.crypto.getRandomValues(new Uint8Array(16)));
const sha256 = async (env, text) => b64url(await env.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
export const credentialHash = (env, credential) => sha256(env, credential);

/** The subscription as page and server hash it: endpoint and unpadded keys, in this order (contracts' canonicalSubscription). */
export function canonical(json) {
  return JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh.replace(/=+$/, ''), auth: json.keys.auth.replace(/=+$/, '') } });
}
export const fingerprint = (env, json) => sha256(env, canonical(json));

export function begin(env, { kind, choices, captured, now }) {
  return update(env, (s) => {
    if (s.claim) return { result: { blocked: 'claim' } };
    // A turned-off credential's alert must be confirmed deleted on the server before anything new starts.
    if (s.retired.some((r) => !r.deleted)) return { result: { blocked: 'retired' } };
    if (s.op && !opDone(s.op, now)) {
      if (same(s.op, kind, choices, captured)) return { result: { joined: s.op } };
      return { result: { waiting: s.op } };
    }
    const credential = s.credential ?? newCredential(env);
    const op = { op: newId(env), seq: s.seq + 1, epoch: s.epoch, kind, phase: 'preparing', choices, captured, subscription: null, fingerprint: null, nonce: null, expiresAt: null, createdAt: now, result: null, activation: null, by: null };
    // The last choices asked for, so a first setup whose subscription changed before it finished can start again.
    return { state: { ...s, credential, seq: op.seq, op, choices: choices ?? s.choices }, result: { started: op, credential } };
  });
}

/**
 * The subscription for a `preparing` operation, compare-and-set: only the first page to attach one does ('ok'); a
 * request already prepared is never changed ('already': use the stored one); a dropped or newer one, 'abandoned'.
 */
export function attach(env, { op, epoch, subscription, fingerprint: fp, by }) {
  return update(env, (s) => {
    if (!s.op || s.op.op !== op || s.epoch !== epoch || s.op.result) return { result: 'abandoned' };
    if (s.op.phase !== 'preparing') return { result: 'already' };
    return { state: { ...s, op: { ...s.op, phase: 'attached', subscription, fingerprint: fp, by } }, result: 'ok' };
  });
}

export function confirmReady(env, { op, by }) {
  return update(env, (s) => {
    if (!s.op || s.op.op !== op || s.op.phase !== 'attached' || s.op.by !== by || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, phase: 'ready' } }, result: true };
  });
}

/**
 * Drops the operation if it is still preparing, or if `by` attached it (never another caller's attached request); returns
 * an unsubscribe claim for `fingerprint` only if nothing the device knows uses it.
 */
export function abandon(env, { op, fingerprint: fp, by }) {
  return update(env, (s) => {
    const mine = s.op?.op === op && !s.op.result && (s.op.phase === 'preparing' || (s.op.phase === 'attached' && by !== null && s.op.by === by));
    const next = { ...s, op: mine ? null : s.op };
    const used = !fp || next.op?.fingerprint === fp || s.known?.fingerprint === fp || !!s.claim;
    if (used) return { state: next, result: null };
    const claim = { task: newId(env), fingerprint: fp };
    return { state: { ...next, claim }, result: claim };
  });
}

export function markSent(env, { op, expiresAt }) {
  return update(env, (s) => {
    if (!s.op || s.op.op !== op) return { result: false };
    return { state: { ...s, op: { ...s.op, phase: 'sent', expiresAt: expiresAt ?? s.op.expiresAt } }, result: true };
  });
}

export function storeNonce(env, { op, credential, fingerprint: fp, nonce }) {
  return update(env, (s) => {
    if (s.credential !== credential || !s.op || s.op.op !== op || s.op.fingerprint !== fp || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, nonce } }, result: true };
  });
}

export function recordResult(env, { op, credential, result, activation }) {
  return update(env, (s) => {
    if (s.credential !== credential || !s.op || s.op.op !== op || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, result, activation } }, result: true };
  });
}

export function finish(env, { op }) {
  return update(env, (s) => (s.op?.op === op ? { state: { ...s, op: null }, result: undefined } : { result: undefined }));
}

/** Known alert for this credential; an older generation or revision of the same incarnation never replaces a newer one. */
export function setKnown(env, { credential, known, version }) {
  return update(env, (s) => {
    if (s.credential !== credential) return { result: false };
    if (version !== undefined && s.knownVersion !== version) return { result: false };
    const k = s.known;
    if (known && k && known.incarnation === k.incarnation && (known.generation < k.generation || (known.generation === k.generation && known.revision < k.revision))) return { result: false };
    return { state: { ...s, known, knownVersion: s.knownVersion + 1 }, result: true };
  });
}

export function setEndsAt(env, { credential, alertId, incarnation, generation, endsAt }) {
  return update(env, (s) => {
    const k = s.known;
    if (s.credential !== credential || !k || k.alertId !== alertId || k.incarnation !== incarnation || k.generation !== generation) return { result: null };
    const next = { ...k, endsAt: Math.max(k.endsAt, endsAt) };
    return { state: { ...s, known: next, knownVersion: s.knownVersion + 1 }, result: next };
  });
}

export function adopt(env, { op, from, by }) {
  return update(env, (s) => {
    if (!s.op || s.op.op !== op || s.op.phase !== 'attached' || s.op.by !== from || s.op.result) return { result: false };
    return { state: { ...s, op: { ...s.op, by } }, result: true };
  });
}

/** Turn off, in one step: a new epoch, the credential retired, the unsubscribe claim written, the operation dropped. */
// `fingerprint`: the browser's subscription, null when it has none, UNKNOWN_SUBSCRIPTION when it could not be asked (a
// claim for whatever subscription is found once it can be).
export function turnOff(env, { fingerprint: fp }) {
  return update(env, (s) => {
    // An earlier claim is kept: resolving it meets the browser's one subscription (replacing the claim when it differs),
    // and every retired entry is then marked by the claim that covered it.
    const claim = s.claim ?? (fp ? { task: newId(env), fingerprint: fp } : null);
    const covered = claim ? claim.fingerprint : fp;
    const retired = s.credential ? [...s.retired, { credential: s.credential, fingerprint: covered, deleted: false, unsubscribed: !covered }] : s.retired;
    const state = { ...s, epoch: s.epoch + 1, credential: null, op: null, needsRotation: false, retired, claim, known: null, renewedAt: null, knownVersion: s.knownVersion + 1 };
    return { state, result: { claim, retired: s.credential } };
  });
}

const tidy = (retired) => retired.filter((r) => !(r.deleted && r.unsubscribed));

/**
 * A claim resolved: cleared if still this task's and its subscription is confirmed gone (`unsubscribed`), or replaced
 * by a claim for another subscription. An unsubscribe that failed keeps the claim, to be tried again.
 */
export function settleClaim(env, { task, unsubscribed, replaceWith = null }) {
  return update(env, (s) => {
    if (s.claim?.task !== task) return { result: null };
    if (!unsubscribed && !replaceWith) return { result: s.claim };
    const fp = s.claim.fingerprint;
    // Replaced: the browser holds another subscription now (one per registration), so the claimed one is gone too.
    const retired = tidy(s.retired.map((r) => ((unsubscribed || replaceWith) && r.fingerprint === fp ? { ...r, unsubscribed: true } : r)));
    const claim = replaceWith ? { task: newId(env), fingerprint: replaceWith } : null;
    return { state: { ...s, claim, retired }, result: claim };
  });
}

export function retiredDeleted(env, { credential }) {
  return update(env, (s) => ({ state: { ...s, retired: tidy(s.retired.map((r) => (r.credential === credential ? { ...r, deleted: true } : r))) }, result: undefined }));
}

export const setNeedsRotation = (env, on) => update(env, (s) => ({ state: { ...s, needsRotation: on }, result: undefined }));
export const setVapid = (env, key) => update(env, (s) => ({ state: { ...s, vapidKey: key }, result: undefined }));
export const setRenewed = (env, { credential, at }) => update(env, (s) => (s.credential === credential ? { state: { ...s, renewedAt: at }, result: undefined } : { result: undefined }));
export const noteGone = (env, fp) => update(env, (s) => ({ state: { ...s, gone: [...new Set([...s.gone, fp])].slice(-10) }, result: undefined }));

/**
 * The channel release's database (only that release wrote it): 'no' when it does not exist, 'empty' when it holds no
 * credential (it is deleted, and must be), 'yes' with one, or 'unknown' when it cannot be read (setup then waits).
 */
export async function legacyCredential(env) {
  if (!env.indexedDB) return 'no';
  if (env.indexedDB.databases) {
    const list = await env.indexedDB.databases().catch(() => null);
    if (list && !list.some((d) => d.name === LEGACY_DB)) return 'no';
  }
  try {
    const found = await transact(env, 'readonly', (store, done) => {
      const req = store.get(KEY);
      req.onsuccess = () => done(!!req.result?.credential);
    }, LEGACY_DB);
    return found ? 'yes' : 'empty';
  } catch {
    return 'unknown';
  }
}

export function deleteLegacy(env) {
  return new Promise((resolve, reject) => {
    if (!env.indexedDB) return resolve(undefined);
    const req = env.indexedDB.deleteDatabase(LEGACY_DB);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(new Unsupported('the old database could not be deleted'));
    req.onblocked = () => reject(new Unsupported('the old database is open in another tab'));
  });
}
```

`apps/web/src/devices/state.d.ts`: the declarations in this task's Interfaces block, with `import type { Activation, AlertChoices } from '@penge/contracts';` at the top.

`legacyCredential` opening `LEGACY_DB` with version 1 creates it when missing (where `databases()` is unavailable); it answers `'empty'` then, and the controller deletes it.

- [ ] **Step 4: Watch them pass**

Run: `npm test -w @penge/web -- state`
Expected: PASS.

- [ ] **Step 5: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review of a browser module shared by page and service worker that keeps one notification alert's local state in IndexedDB under a Web Lock, against the spec's 'Browser state' section: one operation at a time never cancelled, identical-operation joining, epochs, turn-off in one step, unsubscribe claims, retired credentials kept until both deletion and unsubscribe resolve. Find a race between page and worker, a write after the operation or credential changed, and a browser where it silently misbehaves instead of refusing."). Then:

```bash
git add apps/web/src/devices/state.js apps/web/src/devices/state.d.ts apps/web/test/state.test.ts
git commit -m "This device's notification state: one record and one lock, shared by page and worker"
```

---
### Task 15: The page's controller and the device-alert client

The controller drives everything the spec puts on the page: setup with the ready check (steps 1–8), the driving page's schedule, rotation, renewal on opening, change, test and turn off, and reconciling on every opening. It talks to the browser through a small adapter, so the tests drive it with a fake clock, a fake push manager and a fake server.

**Files:**
- Create: `apps/web/src/devices/api.ts`, `apps/web/src/devices/controller.ts`, `apps/web/src/devices/browser.ts` (the adapter over the real browser)
- Test: `apps/web/test/controller.test.ts`, `apps/web/test/fake-device-server.ts`, `apps/web/test/device-api.test.ts`

**Interfaces:**
- Consumes: Task 14's `state.js`; Task 5's contract types and guards (`isMineAnswer`, …).
- Produces:
  - `devices/api.ts`: `class DeviceApiError extends Error { kind: 'offline' | 'server' | 'refused' }`; `DeviceApi` with `setup(cred, body, ownerToken?)`, `rotate(cred, body)`, `ready(cred, body)`, `mine(cred)`, `seen(cred)`, `change(cred, body)`, `test(cred)`, `turnOff(cred)`; `deviceApi: DeviceApi` (fetch, `Authorization: Device <cred>`); a 429 answers `{ outcome: 'limited' }` / `{ result: 'limited' }` / `{ test: 'limited' }` instead of throwing.
  - `devices/controller.ts`:

```ts
export interface BrowserSub { json: SubscriptionJson; unsubscribe(): Promise<boolean> }
export interface Browser {
  permission(): NotificationPermission;
  subscription(): Promise<BrowserSub | null>;
  subscribe(vapidKey: string): Promise<BrowserSub>;
  /** The active worker announces deviceAlerts: 1 (updated first if older). */
  workerReady(): Promise<boolean>;
  /** The worker can read this operation back from its own storage. */
  workerReads(op: string): Promise<boolean>;
  closeNotifications(): Promise<void>;
  /** Holds the driver lock while `fn` runs, if no other page holds it; null if one does. */
  drive<T>(fn: () => Promise<T>): Promise<T | null>;
  visible(): boolean;
}
export interface ControllerDeps { env: Env; api: DeviceApi; browser: Browser; now(): number; mono(): number; sleep(ms: number): Promise<void>; ownerToken(): string | null; forgetOwner(): void; vapidKey(): string | null }
export type RowView =
  | { kind: 'none' }
  | { kind: 'on'; alert: Known; renewFailing: boolean }
  | { kind: 'setting-up'; slow: boolean }
  | { kind: 'blocked' } | { kind: 'ended'; endedAt: number } | { kind: 'again' }
  | { kind: 'off'; unsubscribed: boolean; deleted: boolean }
  | { kind: 'cant-check' } | { kind: 'legacy' } | { kind: 'updating' };
export type SetupResult = { ok: true; text: string } | { ok: false; text: string; retry: boolean };
export class DeviceController {
  constructor(d: ControllerDeps);
  view: RowView;
  subscribe(listener: (v: RowView) => void): () => void;
  /** Every opening and every return to the page: claims, retired deletions, legacy state, blocked, rotation, renewal. */
  reconcile(): Promise<RowView>;
  setup(choices: AlertChoices): Promise<SetupResult>;
  change(choices: AlertChoices): Promise<SetupResult>;
  test(): Promise<string>;
  turnOff(): Promise<RowView>;
}
export const POLL_FAST_MS = 2000, POLL_FAST_FOR_MS = 30_000, POLL_SLOW_MS = 10_000, ACK_RETRY_MS = 15_000, REPEAT_AFTER_MS = [5000, 15_000, 45_000], RENEW_EVERY_MS = 3_600_000, RENEW_RETRY_MS = [60_000, 300_000, 900_000];
```

  - Texts (verbatim from the spec), exported as `TEXT`: `on: 'Notifications are on for this device.'`, `cantFinish: "This browser can't finish setting up notifications."`, `slow: 'Still setting up. Check that notifications are allowed for this site.'`, `expired: 'Setting up notifications took too long. Open PengePassportPH to try again.'`, `full: 'Notifications are full right now. Email alerts still work.'`, `didntFinish: "This notification setup didn't finish."`, `again: 'Notifications need setting up again on this device.'`, `legacy: 'Close other tabs of this site and reopen it to set up notifications.'`, `blocked: 'Notifications are blocked on this device, so we turned them off.'`, `offDone: 'Notifications are off on this device.'`, `offBrowser: "This browser didn't stop its subscription. Block notifications for this site in its settings to be sure."`, `offPending: "Deleting them from our server when you're back online."`, `testAccepted: 'Accepted by the push service. Check this device.'`, `testUncertain: "Sent, but the push service didn't confirm. Check this device before trying again."`, `testRefused: "The push service didn't take it. Try again later."`, `updating: "Updating this device's notifications…"`, `renewFailing: "We couldn't renew it just now; we'll try again."`.

- [ ] **Step 1: The fake server for tests**

`apps/web/test/fake-device-server.ts`: an in-memory model of the routes with the spec's semantics for one device, enough for the controller (the real scripts are tested on the server):

```ts
import { createHash } from 'node:crypto';
import type { DeviceApi } from '../src/devices/api.ts';
import { type Activation, type AlertChoices, canonicalSubscription, type MineAnswer, type OperationView, type SetupAnswer } from '@penge/contracts';

/** The fingerprint as the server computes it (and state.js, as the page does). */
export const fpOf = (s: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
  createHash('sha256').update(canonicalSubscription({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth })).digest('base64url');

type Captured = { incarnation: string; generation: number; revision?: number } | null;
type Op = {
  op: string; seq: number; kind: 'setup' | 'rotate' | 'change'; digest: string; fp: string; choices: AlertChoices | null; captured: Captured;
  nonce: string; expiresAt: number; result: string | null; activation: Activation | null; dispatch: OperationView['dispatch'];
};
type Alert = Activation & { choices: AlertChoices; fingerprint: string; endsAt: number };
/** One credential's server side, as the scripts keep it: its alert (or how it ended), its last operation, its highest seq. */
type Device = { alert: Alert | null; ended: { at: number; reason: 'ended' | 'gone'; fp: string } | null; op: Op | null; maxseq: number };

/**
 * The device routes for the controller's tests, with the server's admission rules (Tasks 6 and 7): a repeat of the last
 * operation with the same body answers its state and one with another body is invalid; a lower seq is invalid; an
 * unfinished operation makes another busy; a setup or rotation whose captured incarnation, generation (and, for a
 * setup, revision) is not the alert's is refused as changed, as is a first setup while an alert exists; a recreated
 * alert has a new incarnation; a turn-off deletes everything under the credential. `alert`, `op` and `ended` are the
 * last-used credential's, for the tests to read and adjust.
 */
export class FakeDeviceServer {
  now = () => 0;
  pushes: { op: string; nonce: string }[] = [];
  /** What the next dispatches answer: accepted unless told otherwise. */
  dispatch: OperationView['dispatch'][] = [];
  offline = false;
  calls: string[] = [];
  seenAt: number | null = null;
  private devices = new Map<string, Device>();
  private last = '';
  private n = 0;
  private dev(cred: string): Device {
    this.last = cred;
    let d = this.devices.get(cred);
    if (!d) this.devices.set(cred, (d = { alert: null, ended: null, op: null, maxseq: 0 }));
    return d;
  }
  private get cur(): Device {
    return this.devices.get(this.last) ?? { alert: null, ended: null, op: null, maxseq: 0 };
  }
  get alert() {
    return this.cur.alert;
  }
  get op() {
    return this.cur.op;
  }
  get ended() {
    return this.cur.ended;
  }
  private view(o: Op | null): OperationView | null {
    if (!o) return null;
    const retry = o.dispatch === 'retryable';
    return { op: o.op, seq: o.seq, kind: o.kind, expiresAt: new Date(o.expiresAt).toISOString(), dispatch: o.dispatch, retryAt: retry ? new Date(this.now()).toISOString() : null, remainingMs: Math.max(0, o.expiresAt - this.now()), retryInMs: retry ? 0 : null, reason: null, result: (o.result as OperationView['result']) ?? null, activation: o.activation };
  }
  private guard(name: string) {
    this.calls.push(name);
    if (this.offline) throw Object.assign(new Error('offline'), { kind: 'offline' });
  }
  /** An alert past its end becomes an end record before anything reads or changes it. */
  private expire(d: Device) {
    if (d.alert && d.alert.endsAt <= this.now()) {
      d.ended = { at: this.now(), reason: 'ended', fp: d.alert.fingerprint };
      d.alert = null;
    }
  }
  private start(cred: string, kind: 'setup' | 'rotate', body: { op: string; seq: number; subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; choices?: AlertChoices; captured?: Captured }): SetupAnswer {
    const d = this.dev(cred);
    const digest = JSON.stringify(body);
    if (d.op?.op === body.op) {
      if (d.op.digest !== digest) return { outcome: 'invalid', operation: null };
      if (d.op.dispatch === 'retryable' && !d.op.result) this.send(d.op);
      return { outcome: d.op.result ? 'done' : 'pending', operation: this.view(d.op) };
    }
    if (body.seq <= d.maxseq) return { outcome: 'invalid', operation: null };
    if (d.op && !d.op.result && d.op.expiresAt > this.now()) return { outcome: 'busy', operation: null };
    if (d.op && !d.op.result) d.op.result = 'expired';
    this.expire(d);
    const cap = body.captured ?? null;
    const a = d.alert;
    const fits =
      kind === 'setup' && !cap ? !a : !!a && !!cap && a.incarnation === cap.incarnation && a.generation === cap.generation && (kind === 'rotate' || a.revision === cap.revision);
    if (!fits) return { outcome: 'changed', operation: null };
    d.maxseq = body.seq;
    d.op = { op: body.op, seq: body.seq, kind, digest, fp: fpOf(body.subscription), choices: body.choices ?? null, captured: cap, nonce: `nonce-${++this.n}`.padEnd(43, 'x'), expiresAt: this.now() + 300_000, result: null, activation: null, dispatch: 'unsent' };
    this.send(d.op);
    return { outcome: 'pending', operation: this.view(d.op) };
  }
  private send(o: Op) {
    o.dispatch = this.dispatch.shift() ?? 'accepted';
    if (o.dispatch === 'accepted' || o.dispatch === 'uncertain') this.pushes.push({ op: o.op, nonce: o.nonce });
  }
  api: DeviceApi = {
    setup: async (cred, body) => (this.guard('setup'), this.start(cred, 'setup', body)),
    rotate: async (cred, body) => (this.guard('rotate'), this.start(cred, 'rotate', body)),
    ready: async (cred, body) => {
      this.guard('ready');
      const d = this.dev(cred);
      const o = d.op;
      if (!o || o.op !== body.op || o.kind === 'change') return { result: 'unknown', activation: null };
      if (o.result) return { result: o.result as never, activation: o.activation };
      if (body.nonce !== o.nonce) return { result: 'invalid', activation: null };
      if (this.now() >= o.expiresAt) return (o.result = 'expired'), { result: 'expired', activation: null };
      // As the ready script (Task 7): an alert past its end is ended first (and a captured operation then expires); the
      // captured ownership is checked again at activation.
      if (d.alert && d.alert.endsAt <= this.now()) {
        this.expire(d);
        if (o.captured) return (o.result = 'expired'), { result: 'expired', activation: null };
      }
      const a = d.alert;
      const cap = o.captured;
      const fits = o.kind === 'setup' && !cap ? !a : !!a && !!cap && a.incarnation === cap.incarnation && a.generation === cap.generation && (o.kind === 'rotate' || a.revision === cap.revision);
      if (!fits) return (o.result = 'changed'), { result: 'changed', activation: null };
      // A first setup creates an alert (new incarnation, 180 days); a re-setup keeps it with the revision up (its choices
      // replaced) and a rotation keeps it; either way the generation goes up when the subscription changed, and the
      // end does not move (only renewal moves it).
      const next: Alert = a
        ? { ...a, generation: a.generation + (a.fingerprint !== o.fp ? 1 : 0), revision: a.revision + (o.kind === 'setup' ? 1 : 0), choices: o.kind === 'setup' ? o.choices! : a.choices, fingerprint: o.fp }
        : { alertId: `alert-${++this.n}`.padEnd(22, 'a'), incarnation: `inc-${++this.n}`.padEnd(22, 'i'), generation: 1, revision: 1, choices: o.choices!, fingerprint: o.fp, endsAt: this.now() + 180 * 86_400_000 };
      d.alert = next;
      d.ended = null;
      o.result = 'active';
      o.activation = { alertId: next.alertId, incarnation: next.incarnation, generation: next.generation, revision: next.revision };
      return { result: 'active', activation: o.activation };
    },
    mine: async (cred) => {
      this.guard('mine');
      const d = this.dev(cred);
      this.expire(d);
      const operation = this.view(d.op);
      if (d.alert) return { state: 'active', operation, alert: { ...d.alert, endsAt: new Date(d.alert.endsAt).toISOString(), updating: false } } as MineAnswer;
      if (d.ended) return d.ended.reason === 'gone' ? { state: 'gone', endedAt: new Date(d.ended.at).toISOString(), fingerprint: d.ended.fp, operation } : { state: 'ended', endedAt: new Date(d.ended.at).toISOString(), operation };
      return { state: 'none', operation };
    },
    seen: async (cred) => {
      this.guard('seen');
      const d = this.dev(cred);
      this.expire(d);
      if (!d.alert) return { state: 'none' };
      d.alert.endsAt = Math.max(d.alert.endsAt, this.now() + 180 * 86_400_000);
      this.seenAt = this.now();
      return { state: 'active', endsAt: new Date(d.alert.endsAt).toISOString() };
    },
    change: async (cred, body) => {
      this.guard('change');
      const d = this.dev(cred);
      const digest = JSON.stringify(body);
      // A change sent again (its answer lost) gets its own stored answer; another body under its id is invalid.
      if (d.op?.op === body.op) {
        if (d.op.kind !== 'change' || d.op.digest !== digest) return { result: 'invalid' };
        return d.op.result === 'active' ? { result: 'active', revision: d.op.activation!.revision } : { result: d.op.result as 'changed' };
      }
      if (body.seq <= d.maxseq) return { result: 'invalid' };
      if (d.op && !d.op.result && d.op.expiresAt > this.now()) return { result: 'busy' };
      if (d.op && !d.op.result) d.op.result = 'expired';
      this.expire(d);
      d.maxseq = body.seq;
      const a = d.alert;
      const ok = !!a && a.incarnation === body.incarnation && a.revision === body.baseRevision;
      if (ok) {
        a.revision += 1;
        a.choices = body.choices;
      }
      const activation = ok ? { alertId: a.alertId, incarnation: a.incarnation, generation: a.generation, revision: a.revision } : null;
      d.op = { op: body.op, seq: body.seq, kind: 'change', digest, fp: a?.fingerprint ?? '', choices: body.choices, captured: null, nonce: '', expiresAt: this.now(), result: ok ? 'active' : 'changed', activation, dispatch: 'accepted' };
      return ok ? { result: 'active', revision: a.revision } : { result: 'changed' };
    },
    test: async (cred) => {
      this.guard('test');
      const d = this.dev(cred);
      this.expire(d);
      return { test: d.alert ? 'accepted' : 'none' };
    },
    turnOff: async (cred) => {
      this.guard('turnOff');
      this.dev(cred);
      this.devices.delete(cred);
      return { deleted: true };
    },
  };
}
```

(The fake fingerprints subscriptions as the server does, so the controller's comparison of the browser's subscription with the server's works as in production.)

`apps/web/test/device-api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceApiError, deviceApi, REQUEST_TIMEOUT_MS } from '../src/devices/api.ts';

describe('the device routes client', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up on a request that never answers, so no caller waits on it', async () => {
    vi.useFakeTimers();
    // A server that never answers, but stops when the request is aborted (as fetch does).
    vi.stubGlobal('fetch', (_: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const pending = deviceApi.mine('c'.repeat(43));
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await caught).toMatchObject({ kind: 'offline' });
    expect(await caught).toBeInstanceOf(DeviceApiError);
  });

  it('gives up on an answer whose body never ends', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (_: string, init: { signal: AbortSignal }) => ({
      status: 200,
      json: () => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    }));
    const caught = deviceApi.mine('c'.repeat(43)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await caught).toMatchObject({ kind: 'offline' });
  });
});
```

- [ ] **Step 2: Write the failing tests**

`apps/web/test/controller.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { type Browser, type BrowserSub, DeviceController, TEXT } from '../src/devices/controller.ts';
import * as S from '../src/devices/state.js';
import { FakeDeviceServer } from './fake-device-server.ts';
import { env as stateEnv } from './state.test.ts';

const choices = { siteIds: [486], applicants: 1, pace: 'asap' as const };

/** A clock that only moves when a sleep asks it to; the worker's acknowledgement runs on `deliverAfter`. */
function world(o: { deliverAfterMs?: number | null; permission?: NotificationPermission; workerReads?: boolean; visible?: boolean; unsubscribeFails?: () => boolean; noRegistration?: () => boolean; holdTime?: () => Promise<void> | null } = {}) {
  let now = 1_791_261_968_326;
  const server = new FakeDeviceServer();
  server.now = () => now;
  const env = stateEnv();
  let current: BrowserSub | null = null;
  let n = 0;
  const make = (): BrowserSub => {
    const sub: BrowserSub = {
      json: { endpoint: `https://fcm.googleapis.com/fcm/send/${++n}`, keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) } },
      unsubscribe: async () => {
        if (o.unsubscribeFails?.()) return false;
        current = current === sub ? null : current;
        return true;
      },
    };
    return sub;
  };
  // The worker: when a push arrives, it stores the nonce and acknowledges (as sw.js does), after `deliverAfterMs`.
  const deliveries: { at: number; op: string; nonce: string }[] = [];
  const worker = async () => {
    for (const d of deliveries.filter((x) => x.at <= now)) {
      deliveries.splice(deliveries.indexOf(d), 1);
      const s = await S.readState(env);
      if (!s.credential || s.op?.op !== d.op) continue;
      await S.storeNonce(env, { op: d.op, credential: s.credential, fingerprint: s.op.fingerprint!, nonce: d.nonce });
      try {
        const r = await server.api.ready(s.credential, { op: d.op, nonce: d.nonce });
        if (r.result !== 'invalid' && r.result !== 'unknown' && r.result !== 'limited') await S.recordResult(env, { op: d.op, credential: s.credential, result: r.result, activation: r.activation });
      } catch {
        // Lost on the way: the nonce stays stored, for the page to send.
      }
    }
  };
  let driving = false;
  const browser: Browser = {
    permission: () => o.permission ?? 'granted',
    subscription: async () => {
      if (o.noRegistration?.()) throw new S.Unsupported('no service worker registration');
      return current;
    },
    subscribe: async () => (current ??= make()),
    workerReady: async () => true,
    workerReads: async () => o.workerReads ?? true,
    closeNotifications: async () => undefined,
    // The driver lock: one page drives; another gets null and waits for the recorded result.
    drive: async (fn) => {
      if (driving) return null;
      driving = true;
      try {
        return await fn();
      } finally {
        driving = false;
      }
    },
    visible: () => o.visible ?? true,
  };
  const sleep = async (ms: number) => {
    // A test can stop the clock (every sleep waits) while it holds something, so no caller's time runs ahead.
    await o.holdTime?.();
    // New pushes become deliveries; time moves; the worker acts.
    for (const p of server.pushes.splice(0)) if (o.deliverAfterMs !== null) deliveries.push({ at: now + (o.deliverAfterMs ?? 0), op: p.op, nonce: p.nonce });
    now += ms;
    await worker();
  };
  let owner: string | null = null;
  // The device's wall clock can jump (`jump`); its monotonic clock and the server's clock cannot.
  let skew = 0;
  const c = new DeviceController({ env, api: server.api, browser, now: () => now + skew, mono: () => now, sleep, ownerToken: () => owner, forgetOwner: () => (owner = null), vapidKey: () => 'B'.repeat(87) });
  return { c, server, env, browser, advance: (ms: number) => (now += ms), now: () => now, current: () => current, setOwner: (t: string) => (owner = t), jump: (ms: number) => (skew += ms) };
}

describe('setting up on this device', () => {
  it('turns notifications on once this browser has shown the setup notification and proved it', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    expect(w.c.view).toMatchObject({ kind: 'on', alert: { choices } });
  });

  it('a setup push that arrives after 4 minutes still completes; one after expiry never does', async () => {
    const late = world({ deliverAfterMs: 240_000 });
    const views: string[] = [];
    late.c.subscribe((v) => views.push(v.kind === 'setting-up' && v.slow ? 'slow' : v.kind));
    expect(await late.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    expect(views).toContain('slow'); // "Still setting up…" after 30 s
    const never = world({ deliverAfterMs: 400_000 });
    expect(await never.c.setup(choices)).toEqual({ ok: false, text: TEXT.expired, retry: true });
    expect(never.server.alert).toBeNull();
  });

  it('acknowledges from the page when the worker stored the nonce but no result arrived', async () => {
    const w = world();
    // The worker stores the nonce but its acknowledgement is lost: the page posts it.
    w.server.api.ready = ((orig) => {
      let first = true;
      return async (cred, body) => {
        if (first) {
          first = false;
          throw Object.assign(new Error('lost'), { kind: 'offline' });
        }
        return orig(cred, body);
      };
    })(w.server.api.ready);
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
  });

  it('repeats a retryable dispatch after 5, 15 and 45 seconds, and never counts it as another setup', async () => {
    const w = world();
    w.server.dispatch = ['retryable', 'retryable', 'accepted'];
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    expect(w.server.calls.filter((x) => x === 'setup')).toHaveLength(3);
  });

  it('stops at step 2 when the worker cannot read the operation (other storage)', async () => {
    const w = world({ workerReads: false });
    expect(await w.c.setup(choices)).toEqual({ ok: false, text: TEXT.cantFinish, retry: false });
    expect(w.server.calls).not.toContain('setup');
  });

  it('stops at step 2 without Web Locks or IndexedDB, and says so', async () => {
    const w = world();
    const { locks: _l, ...noLocks } = w.env; // left out, not undefined (exactOptionalPropertyTypes)
    const c = new DeviceController({ env: noLocks, api: w.server.api, browser: w.browser, now: w.now, mono: w.now, sleep: async () => undefined, ownerToken: () => null, forgetOwner: () => undefined, vapidKey: () => 'B'.repeat(87) });
    expect(await c.setup(choices)).toEqual({ ok: false, text: TEXT.cantFinish, retry: false });
  });

  it('joins a second press of the same setup instead of starting another', async () => {
    const w = world({ deliverAfterMs: 5000 });
    const [a, b] = await Promise.all([w.c.setup(choices), w.c.setup(choices)]);
    expect([a, b]).toEqual([{ ok: true, text: TEXT.on }, { ok: true, text: TEXT.on }]);
    expect(w.server.calls.filter((x) => x === 'setup')).toHaveLength(1);
  });

  it('sends the owner token with a new setup only, and forgets it when the server says owner-only', async () => {
    const w = world();
    w.setOwner('t'.repeat(40));
    let sent: string | undefined;
    const orig = w.server.api.setup;
    w.server.api.setup = async (cred, body, token) => ((sent = token), { outcome: 'owner-only', operation: null });
    expect((await w.c.setup(choices)).ok).toBe(false);
    expect(sent).toBe('t'.repeat(40));
    w.server.api.setup = orig;
  });
});

describe('on every opening', () => {
  it('renews at most once an hour, only after the server answers, and discards a renewal time in the future', async () => {
    const w = world();
    await w.c.setup(choices);
    await w.c.reconcile();
    const first = w.server.seenAt;
    expect(first).not.toBeNull();
    w.advance(30 * 60_000);
    await w.c.reconcile();
    expect(w.server.seenAt).toBe(first); // within the hour: no renewal
    // A renewal time in the future (a wrong device clock) is discarded: the next opening renews.
    const s = await S.readState(w.env);
    await S.setRenewed(w.env, { credential: s.credential!, at: w.now() + 10 * 86_400_000 });
    await w.c.reconcile();
    expect(w.server.seenAt).toBe(w.now());
  });

  it('turns off when notifications are blocked, and says so', async () => {
    const w = world();
    await w.c.setup(choices);
    const blocked = new DeviceController({ ...(w.c as unknown as { d: object }).d, browser: { ...w.browser, permission: () => 'denied' } } as never);
    expect(await blocked.reconcile()).toEqual({ kind: 'blocked' });
    expect(w.server.alert).toBeNull();
  });

  it('rotates to a new subscription when the browser\'s differs from the server\'s, keeping the alert', async () => {
    const w = world();
    await w.c.setup(choices);
    await w.current()!.unsubscribe(); // the push service replaced it: the browser has a new one
    await w.browser.subscribe('B'.repeat(87));
    await w.c.reconcile();
    expect(w.server.alert?.generation).toBe(2);
    expect(w.c.view.kind).toBe('on');
  });

  it('shows an ended alert with its date', async () => {
    const w = world();
    await w.c.setup(choices);
    w.advance(181 * 86_400_000);
    expect((await w.c.reconcile()).kind).toBe('ended');
  });
});

describe('turning off', () => {
  it('reports unsubscribing and server deletion separately, and keeps deleting until the server confirms', async () => {
    const w = world();
    await w.c.setup(choices);
    w.server.offline = true;
    const v = await w.c.turnOff();
    expect(v).toEqual({ kind: 'off', unsubscribed: true, deleted: false });
    expect(w.current()).toBeNull();
    w.server.offline = false;
    expect((await w.c.reconcile()).kind).toBe('none');
    expect((await S.readState(w.env)).retired).toEqual([]);
  });

  it('starts no setup while an unsubscribe claim is unresolved; resolves it first', async () => {
    const w = world();
    await w.c.setup(choices);
    const s = await S.readState(w.env);
    await S.turnOff(w.env, { fingerprint: await S.fingerprint(w.env, w.current()!.json) });
    expect(s.credential).not.toBeNull();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on }); // the claim resolved on the way
    expect((await S.readState(w.env)).claim).toBeNull();
  });
});

describe('the fixes the plan review asked for', () => {
  it('keeps an unsubscribe that failed, says so, and starts no setup until it is resolved', async () => {
    let fail = true;
    const w = world({ unsubscribeFails: () => fail });
    await w.c.setup(choices);
    expect(await w.c.turnOff()).toEqual({ kind: 'off', unsubscribed: false, deleted: true });
    expect((await S.readState(w.env)).claim).not.toBeNull();
    expect(await w.c.setup(choices)).toEqual({ ok: false, text: TEXT.finishingOff, retry: true });
    fail = false;
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
  });

  it('a device clock that jumps an hour ahead, or back, during setup neither ends it nor hurries it', async () => {
    for (const ms of [3_600_000, -3_600_000]) {
      const w = world({ deliverAfterMs: 40_000 });
      const orig = w.server.api.setup;
      let jumped = false;
      w.server.api.setup = async (cred, body, token) => {
        const answer = await orig(cred, body, token);
        if (!jumped) (jumped = true), w.jump(ms);
        return answer;
      };
      expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
      expect(w.server.calls.filter((x) => x === 'setup').length).toBeLessThanOrEqual(2);
    }
  });

  it('a clock jump while preparing still sends the setup (no expiry before the first request)', async () => {
    const w = world();
    const reads = w.browser.workerReads;
    w.browser.workerReads = async (op) => {
      w.jump(3_600_000);
      return reads(op);
    };
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    expect(w.server.calls).toContain('setup');
  });

  it('a second press after a clock jump joins the setup the server still has open, never replacing it', async () => {
    let frozen: Promise<void> | null = null;
    const w = world({ holdTime: () => frozen });
    const orig = w.server.api.setup;
    const ops = new Set<string>();
    let jumped = false;
    w.server.api.setup = async (cred, body, token) => {
      ops.add(body.op);
      const answer = await orig(cred, body, token);
      if (!jumped) (jumped = true), w.jump(3_600_000);
      return answer;
    };
    // The worker's acknowledgement is held, so the first setup is demonstrably unfinished when the second press comes.
    const ready = w.server.api.ready;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    w.server.api.ready = async (cred, body) => {
      if (!held) {
        held = true;
        frozen = gate; // the clock stops with the acknowledgement: the joining caller's waits pass no time
        await gate;
      }
      return ready(cred, body);
    };
    const first = w.c.setup(choices);
    await vi.waitFor(() => expect(held).toBe(true));
    const second = w.c.setup(choices);
    // The second press joined the first's operation (nothing new started) before the acknowledgement is let through.
    await vi.waitFor(async () => expect((await S.readState(w.env)).op?.op).toBe([...ops][0]));
    await new Promise((r) => setTimeout(r, 50));
    frozen = null;
    release();
    expect(await first).toEqual({ ok: true, text: TEXT.on });
    expect(await second).toEqual({ ok: true, text: TEXT.on });
    expect(ops.size).toBe(1);
  });

  it('an unanswered setup taken over by another page still ends 2 minutes after it was created', async () => {
    const w = world();
    w.server.offline = true;
    // Made 110 s ago by a page that closed, already sent once (no answer arrived), so this page drives it.
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() - 110_000 })) as { started: S.Operation };
    const sub = await w.browser.subscribe('B'.repeat(87));
    await S.attach(w.env, { op: r.started.op, epoch: 0, subscription: sub.json, fingerprint: await S.fingerprint(w.env, sub.json), by: 'p' });
    await S.confirmReady(w.env, { op: r.started.op, by: 'p' });
    const start = w.now();
    await w.c.reconcile();
    await vi.waitFor(async () => expect((await S.readState(w.env)).op?.result).toBe('expired'));
    expect(w.now() - start).toBeLessThanOrEqual(30_000);
  });

  it('never says on when permission or the subscription went away during the renewal', async () => {
    for (const change of ['permission', 'subscription'] as const) {
      const w = world();
      await w.c.setup(choices);
      w.advance(2 * 3_600_000); // the next opening renews
      let permission: NotificationPermission = 'granted';
      const c = new DeviceController({ ...(w.c as unknown as { d: object }).d, browser: { ...w.browser, permission: () => permission } } as never);
      const seen = w.server.api.seen;
      w.server.api.seen = async (cred) => {
        const answer = await seen(cred);
        if (change === 'permission') permission = 'default';
        else await w.current()!.unsubscribe();
        return answer;
      };
      const v = await c.reconcile();
      if (change === 'permission') expect(v.kind).toBe('again');
      // Gone from the browser: never "on" for the old subscription; "on" only after a rotation to the browser's new one.
      else if (v.kind === 'on') expect(w.server.alert?.fingerprint).toBe(await S.fingerprint(w.env, w.current()!.json));
    }
  });

  it('stops driving as soon as the page is hidden, sending nothing more, and hands the operation on', async () => {
    const w = world();
    w.server.dispatch = ['retryable', 'retryable', 'retryable'];
    let visible = true;
    w.browser.visible = () => visible;
    const orig = w.server.api.setup;
    w.server.api.setup = async (cred, body, token) => {
      const answer = await orig(cred, body, token);
      visible = false; // hidden right after the first request
      return answer;
    };
    expect(await w.c.setup(choices)).toMatchObject({ ok: false, text: TEXT.slow });
    expect(w.server.calls.filter((x) => x === 'setup')).toHaveLength(1);
    expect((await S.readState(w.env)).op).toMatchObject({ result: null }); // kept for the next visible page
  });

  it('sends nothing more once the page is hidden: during an acknowledgement, a wait, or a refused answer', async () => {
    for (const during of ['ready', 'sleep', 'refused'] as const) {
      const w = world({ deliverAfterMs: null }); // no push arrives: the page acknowledges and waits
      let visible = true;
      let boundary = Infinity; // w.server.calls.length when the page was hidden (after the request in flight, if any)
      const hide = () => {
        visible = false;
        boundary = w.server.calls.length;
      };
      w.browser.visible = () => visible;
      const orig = w.server.api.setup;
      w.server.api.setup = async (cred, body, token) => {
        if (during === 'refused') {
          await orig(cred, body, token);
          hide(); // hidden while a refusal was on its way back
          return { outcome: 'full', operation: null };
        }
        const answer = await orig(cred, body, token);
        // A nonce already stored (the worker stored it, its acknowledgement lost), so the page acknowledges.
        await S.storeNonce(w.env, { op: body.op, credential: cred, fingerprint: (await S.readState(w.env)).op!.fingerprint!, nonce: 'x'.repeat(43) });
        return answer;
      };
      const ready = w.server.api.ready;
      w.server.api.ready = async (cred, body) => {
        const r = await ready(cred, body);
        if (during === 'ready') hide();
        return r;
      };
      const c = new DeviceController({
        ...(w.c as unknown as { d: object }).d,
        sleep: async (ms: number) => {
          if (during === 'sleep') hide();
          await (w.c as unknown as { d: { sleep(ms: number): Promise<void> } }).d.sleep(ms);
        },
      } as never);
      expect(await c.setup(choices)).toMatchObject({ ok: false, text: TEXT.slow });
      expect(w.server.calls.slice(boundary)).toEqual([]); // no request of any kind after the page was hidden
      expect((await S.readState(w.env)).op).toMatchObject({ result: null }); // kept, for when the page shows again
    }
  });

  it('a valid acknowledgement answered as the page hides is kept, and nothing is read until the page shows again', async () => {
    const w = world({ deliverAfterMs: null });
    let visible = true;
    let boundary = Infinity;
    w.browser.visible = () => visible;
    const orig = w.server.api.setup;
    w.server.api.setup = async (cred, body, token) => {
      const answer = await orig(cred, body, token);
      // The worker stored the real nonce (its own acknowledgement lost): the page acknowledges it.
      const nonce = w.server.op!.nonce;
      await S.storeNonce(w.env, { op: body.op, credential: cred, fingerprint: (await S.readState(w.env)).op!.fingerprint!, nonce });
      return answer;
    };
    const ready = w.server.api.ready;
    w.server.api.ready = async (cred, body) => {
      const r = await ready(cred, body);
      visible = false;
      boundary = w.server.calls.length;
      return r;
    };
    expect(await w.c.setup(choices)).toMatchObject({ ok: false, text: TEXT.slow });
    expect(w.server.calls.slice(boundary)).toEqual([]);
    expect((await S.readState(w.env)).op).toMatchObject({ result: 'active' }); // the server's result, kept
    visible = true;
    expect((await w.c.reconcile()).kind).toBe('on'); // shown when the page is visible again
  });

  it('treats a "limited" answer as a reason to repeat, not a result', async () => {
    const w = world();
    const orig = w.server.api.setup;
    let first = true;
    w.server.api.setup = async (cred, body, token) => {
      if (first) {
        first = false;
        return { outcome: 'limited', operation: null };
      }
      return orig(cred, body, token);
    };
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
  });

  it('keeps the server\'s expiry from a later answer when the first was lost, so a 2½-minute push still completes', async () => {
    const w = world({ deliverAfterMs: 150_000 });
    const orig = w.server.api.setup;
    let first = true;
    w.server.api.setup = async (cred, body, token) => {
      const answer = await orig(cred, body, token);
      if (first) {
        first = false;
        throw Object.assign(new Error('lost'), { kind: 'offline' }); // stored, but the answer never arrived
      }
      return answer;
    };
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
  });

  it('sets up again after an alert ended: a first setup, not a re-setup of the ended one', async () => {
    const w = world();
    await w.c.setup(choices);
    w.advance(181 * 86_400_000);
    expect((await w.c.reconcile()).kind).toBe('ended');
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
  });

  it('sends a change again after its answer was lost, until it has its own result', async () => {
    const w = world();
    await w.c.setup(choices);
    const orig = w.server.api.change;
    w.server.api.change = async () => {
      throw Object.assign(new Error('offline'), { kind: 'offline' });
    };
    expect((await w.c.change({ ...choices, siteIds: [693] })).ok).toBe(false);
    w.server.api.change = orig;
    const v = await w.c.reconcile();
    expect(v).toMatchObject({ kind: 'on', alert: { revision: 2, choices: { siteIds: [693] } } });
  });

  it('carries on an operation a closed page left preparing, after 10 seconds', async () => {
    const w = world();
    await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() - 20_000 });
    expect(await w.c.reconcile()).toEqual({ kind: 'setting-up', slow: false });
    await vi.waitFor(() => expect(w.server.alert).not.toBeNull());
  });

  it('deletes an empty old database before setting up, and waits while an old tab holds it open', async () => {
    const w = world();
    const open = await new Promise<IDBDatabase>((resolve) => {
      const req = w.env.indexedDB!.open(S.LEGACY_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('state');
      req.onsuccess = () => resolve(req.result);
    });
    // An old tab holding the database open (and not closing on versionchange) blocks the deletion.
    open.onversionchange = () => undefined;
    expect(await w.c.setup(choices)).toEqual({ ok: false, text: TEXT.legacy, retry: false });
    open.close();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    expect(await S.legacyCredential(w.env)).toBe('no');
  });

  it('turns off without a reachable worker, says it could not confirm, and unsubscribes once the worker is back', async () => {
    let unreachable = false;
    const w = world({ noRegistration: () => unreachable });
    await w.c.setup(choices);
    unreachable = true;
    expect(await w.c.turnOff()).toEqual({ kind: 'off', unsubscribed: false, deleted: true });
    expect((await S.readState(w.env)).claim).toMatchObject({ fingerprint: S.UNKNOWN_SUBSCRIPTION });
    expect(w.current()).not.toBeNull();
    unreachable = false;
    await w.c.reconcile();
    expect(w.current()).toBeNull();
    expect((await S.readState(w.env)).claim).toBeNull();
  });

  it('writes and shows nothing from a read whose subscription lookup outlived a turn-off', async () => {
    const w = world();
    await w.c.setup(choices);
    const orig = w.browser.subscription;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const held = new Promise<void>((r) => (reached = r));
    let first = true;
    // The first lookup is the reconcile's, after its entry check; it waits while the device turns off.
    w.browser.subscription = async () => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return orig();
    };
    const reading = w.c.reconcile();
    await held;
    await w.c.turnOff();
    const seen = w.server.calls.filter((x) => x === 'seen').length;
    release();
    await reading;
    expect(w.c.view.kind).toBe('off');
    expect((await S.readState(w.env)).needsRotation).toBe(false);
    expect(w.server.calls.filter((x) => x === 'seen')).toHaveLength(seen);
  });

  it('keeps retrying a failed renewal when the read before it fails too, one request per retry', async () => {
    const w = world();
    await w.c.setup(choices);
    w.advance(2 * 3_600_000);
    // The opening's renewal fails; the 1-minute retry's read (the second read from here) fails; the next retry renews.
    const seen = w.server.api.seen;
    let seenCalls = 0;
    w.server.api.seen = async (cred) => {
      if (++seenCalls === 1) throw Object.assign(new Error('offline'), { kind: 'offline' });
      return seen(cred);
    };
    const mine = w.server.api.mine;
    let mineCalls = 0;
    w.server.api.mine = async (cred) => {
      if (++mineCalls === 2) throw Object.assign(new Error('offline'), { kind: 'offline' });
      return mine(cred);
    };
    await w.c.reconcile();
    await vi.waitFor(() => expect(seenCalls).toBe(2));
    await vi.waitFor(() => expect(w.server.seenAt).not.toBeNull());
    expect(mineCalls).toBeGreaterThanOrEqual(3);
  });

  it('a renewal that comes back after a change never puts the older choices back', async () => {
    const w = world();
    await w.c.setup(choices);
    w.advance(2 * 3_600_000); // the next opening renews
    const orig = w.server.api.seen;
    let first = true;
    w.server.api.seen = async (cred) => {
      const answer = await orig(cred);
      if (first) {
        // A change lands while the first renewal is on its way back.
        first = false;
        await w.c.change({ ...choices, siteIds: [693] });
      }
      return answer;
    };
    await w.c.reconcile();
    expect((await S.readState(w.env)).known).toMatchObject({ revision: 2, choices: { siteIds: [693] } });
  });

  it('says it cannot check, rotating and renewing nothing, while no worker is reachable', async () => {
    let unreachable = false;
    const w = world({ noRegistration: () => unreachable });
    await w.c.setup(choices);
    unreachable = true;
    w.advance(2 * 3_600_000);
    const seen = w.server.seenAt;
    expect((await w.c.reconcile()).kind).toBe('cant-check');
    expect(w.server.alert?.generation).toBe(1);
    expect(w.server.seenAt).toBe(seen);
  });

  it('asks to set up again when permission is no longer granted (and not blocked), with no subscription', async () => {
    const w = world();
    await w.c.setup(choices);
    await w.current()!.unsubscribe();
    const reset = new DeviceController({ ...(w.c as unknown as { d: object }).d, browser: { ...w.browser, permission: () => 'default' } } as never);
    expect((await reset.reconcile()).kind).toBe('again');
    expect(w.server.alert).not.toBeNull(); // kept on the server: the person sets up again or it ends
  });

  it('recovers an operation a closed page attached but never made ready', async () => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() - 20_000 })) as { started: S.Operation };
    const sub = await w.browser.subscribe('B'.repeat(87));
    await S.attach(w.env, { op: r.started.op, epoch: 0, subscription: sub.json, fingerprint: await S.fingerprint(w.env, sub.json), by: 'closed-tab' });
    expect((await w.c.reconcile()).kind).toBe('setting-up');
    await vi.waitFor(() => expect(w.server.alert).not.toBeNull());
  });

  it('keeps driving when a refusal follows a request that was stored but whose answer was lost', async () => {
    const w = world();
    const orig = w.server.api.setup;
    let n = 0;
    w.server.api.setup = async (cred, body, token) => {
      n++;
      if (n === 1) {
        await orig(cred, body, token); // stored
        throw Object.assign(new Error('lost'), { kind: 'offline' });
      }
      return { outcome: 'full', operation: null }; // a later repeat refused: the stored one stands
    };
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
  });

  it('ignores a read that comes back after the device turned off', async () => {
    const w = world();
    await w.c.setup(choices);
    const orig = w.server.api.mine;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const held = new Promise<void>((r) => (reached = r));
    let first = true;
    // Only the reconcile's read is held back (answered "active"); every later read goes straight through.
    w.server.api.mine = async (cred) => {
      const answer = await orig(cred);
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return answer;
    };
    const reading = w.c.reconcile();
    await held;
    await w.c.turnOff();
    release();
    await reading;
    expect(w.c.view.kind).toBe('off');
    expect((await S.readState(w.env)).known).toBeNull();
  });

  it('rotates once more when the first rotation lost to a change', async () => {
    const w = world();
    await w.c.setup(choices);
    await w.current()!.unsubscribe();
    await w.browser.subscribe('B'.repeat(87));
    const orig = w.server.api.rotate;
    let first = true;
    w.server.api.rotate = async (cred, body) => {
      if (first) {
        first = false;
        w.server.alert!.generation++; // another rotation won meanwhile
        return { outcome: 'changed', operation: null };
      }
      return orig(cred, body);
    };
    expect((await w.c.reconcile()).kind).toBe('on');
    expect(w.server.alert?.fingerprint).toBe(await S.fingerprint(w.env, w.current()!.json));
  });

  it('shows the renewed end date', async () => {
    const w = world();
    await w.c.setup(choices);
    w.advance(30 * 86_400_000);
    const v = await w.c.reconcile();
    expect(v.kind === 'on' && v.alert.endsAt).toBe(w.now() + 180 * 86_400_000);
  });
});

describe('change and test', () => {
  it('a change pressed twice waits for the one change, and reports its result', async () => {
    const w = world();
    await w.c.setup(choices);
    const next = { ...choices, siteIds: [693] };
    const [a, b] = await Promise.all([w.c.change(next), w.c.change(next)]);
    expect([a, b]).toEqual([{ ok: true, text: 'Saved.' }, { ok: true, text: 'Saved.' }]);
    expect(w.server.alert?.revision).toBe(2);
  });

  it('changes at once, and reloads on a stale revision', async () => {
    const w = world();
    await w.c.setup(choices);
    expect(await w.c.change({ ...choices, siteIds: [693] })).toEqual({ ok: true, text: 'Saved.' });
    w.server.alert!.revision = 9;
    expect((await w.c.change({ ...choices, siteIds: [486] })).ok).toBe(false);
  });

  it('says what the push service did with a test', async () => {
    const w = world();
    await w.c.setup(choices);
    expect(await w.c.test()).toBe(TEXT.testAccepted);
  });
});
```

(`state.test.ts` exports `env`; add `export` to its `env` and `fakeLocks` if Task 14 did not.)

- [ ] **Step 3: Watch them fail**

Run: `npm test -w @penge/web -- controller`
Expected: FAIL: `Cannot find module '../src/devices/controller.ts'`.

- [ ] **Step 4: The client**

`apps/web/src/devices/api.ts`:

```ts
// The notification-alert routes, for the page. The credential travels only in the Authorization header.
import {
  type ChangeAnswer,
  type ChangeRequest,
  isMineAnswer,
  type MineAnswer,
  type ReadyAnswer,
  type ReadyRequest,
  type RotateRequest,
  type SeenAnswer,
  type SetupAnswer,
  type SetupRequest,
  type TestAnswer,
} from '@penge/contracts';
import { BASE } from '../links.ts';

export class DeviceApiError extends Error {
  override name = 'DeviceApiError';
  readonly kind: 'offline' | 'server' | 'refused';
  // Fields are declared and assigned, not constructor parameter properties (erasableSyntaxOnly).
  constructor(kind: 'offline' | 'server' | 'refused') {
    super(kind);
    this.kind = kind;
  }
}

export interface DeviceApi {
  setup(credential: string, body: SetupRequest, ownerToken?: string): Promise<SetupAnswer>;
  rotate(credential: string, body: RotateRequest): Promise<SetupAnswer>;
  ready(credential: string, body: ReadyRequest): Promise<ReadyAnswer | { result: 'limited'; activation: null }>;
  mine(credential: string): Promise<MineAnswer>;
  seen(credential: string): Promise<SeenAnswer>;
  change(credential: string, body: ChangeRequest): Promise<ChangeAnswer>;
  test(credential: string): Promise<TestAnswer>;
  turnOff(credential: string): Promise<{ deleted: true }>;
}

/**
 * Every request, its answer's body included, ends within this: a request that never answers is "offline", so nothing
 * waits on it (the driving page holds the driver lock while it sends; its checks run again within this time).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

async function call(method: string, path: string, credential: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}api/device-alerts${path}`, {
        method,
        credentials: 'same-origin',
        signal: abort.signal,
        headers: { authorization: `Device ${credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DeviceApiError('offline');
    }
    // The body is read under the same deadline: aborting it rejects the read, which is offline too.
    let data: unknown;
    try {
      data = (await res.json()) as unknown;
    } catch {
      if (abort.signal.aborted) throw new DeviceApiError('offline');
      data = null;
    }
    if (res.status >= 500) throw new DeviceApiError('server');
    if (res.status === 429 || res.status === 409 || res.status === 200) return { status: res.status, data };
    throw new DeviceApiError('refused');
  } finally {
    clearTimeout(timer);
  }
}

const object = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);

export const deviceApi: DeviceApi = {
  async setup(credential, body, ownerToken) {
    const r = await call('POST', '', credential, body, ownerToken ? { 'x-owner-token': ownerToken } : {});
    return r.status === 429 ? { outcome: 'limited', operation: null } : (r.data as SetupAnswer);
  },
  async rotate(credential, body) {
    const r = await call('POST', '/mine/subscription', credential, body);
    return r.status === 429 ? { outcome: 'limited', operation: null } : (r.data as SetupAnswer);
  },
  async ready(credential, body) {
    const r = await call('POST', '/ready', credential, body);
    return r.status === 429 ? { result: 'limited', activation: null } : (r.data as ReadyAnswer);
  },
  async mine(credential) {
    const r = await call('GET', '/mine', credential);
    if (!isMineAnswer(r.data)) throw new DeviceApiError(r.status === 429 ? 'server' : 'refused');
    return r.data;
  },
  async seen(credential) {
    const r = await call('POST', '/mine/seen', credential, {});
    if (r.status === 429 || !object(r.data)?.state) throw new DeviceApiError('server');
    return r.data as SeenAnswer;
  },
  async change(credential, body) {
    const r = await call('PUT', '/mine', credential, body);
    if (r.status === 429) throw new DeviceApiError('server');
    return r.data as ChangeAnswer;
  },
  async test(credential) {
    const r = await call('POST', '/mine/test', credential, {});
    return r.status === 429 ? { test: 'limited' } : (r.data as TestAnswer);
  },
  async turnOff(credential) {
    const r = await call('DELETE', '/mine', credential, {});
    if (object(r.data)?.deleted !== true) throw new DeviceApiError('server');
    return { deleted: true };
  },
};
```

- [ ] **Step 5: The controller**

`apps/web/src/devices/controller.ts`:

```ts
// What the page does for this device's notification alert (spec: "Notification alerts on a device"). Everything
// that changes local state goes through state.js (one record, one lock); network calls and waits happen outside
// the lock, and what they learn is written only if the operation and credential are still current (checked again
// under the lock by state.js). An operation keeps its result in the record until the next one replaces it, so a
// second tab or press that joined it reads the same result.
import type { Activation, AlertChoices, MineAnswer, OperationView, SetupAnswer } from '@penge/contracts';
import * as S from './state.js';
import { type DeviceApi, DeviceApiError } from './api.ts';

export const POLL_FAST_MS = 2000;
export const POLL_FAST_FOR_MS = 30_000;
export const POLL_SLOW_MS = 10_000;
export const ACK_RETRY_MS = 15_000;
export const REPEAT_AFTER_MS = [5000, 15_000, 45_000];
export const RENEW_EVERY_MS = 3_600_000;
export const RENEW_RETRY_MS = [60_000, 300_000, 900_000];
/** An operation whose server never answered is given up 2 minutes after it was made; one with an expiry, 30 s after it. */
export const UNANSWERED_MS = 120_000;
export const AFTER_EXPIRY_MS = 30_000;
/** A `preparing` operation no page carries on is taken over after this. */
export const PREPARING_STALE_MS = 10_000;

export const TEXT = {
  on: 'Notifications are on for this device.',
  cantFinish: "This browser can't finish setting up notifications.",
  slow: 'Still setting up. Check that notifications are allowed for this site.',
  expired: 'Setting up notifications took too long. Open PengePassportPH to try again.',
  full: 'Notifications are full right now. Email alerts still work.',
  didntFinish: "This notification setup didn't finish.",
  again: 'Notifications need setting up again on this device.',
  legacy: 'Close other tabs of this site and reopen it to set up notifications.',
  blocked: 'Notifications are blocked on this device, so we turned them off.',
  offDone: 'Notifications are off on this device.',
  offBrowser: "This browser didn't stop its subscription. Block notifications for this site in its settings to be sure.",
  offPending: "Deleting them from our server when you're back online.",
  finishingOff: 'Finishing turning notifications off on this device. Try again in a moment.',
  deadSubscription: 'This browser kept a subscription that no longer works. Block, then allow, notifications for this site in its settings, and try again.',
  testAccepted: 'Accepted by the push service. Check this device.',
  testUncertain: "Sent, but the push service didn't confirm. Check this device before trying again.",
  testRefused: "The push service didn't take it. Try again later.",
  updating: "Updating this device's notifications…",
  renewFailing: "We couldn't renew it just now; we'll try again.",
  unavailable: 'Notifications are not available right now. Email alerts still work.',
  limited: 'Too many tries from here just now. Try again in a while.',
  ownerOnly: 'Notifications are still being tested and are not open to everyone yet.',
  offline: 'We could not reach the server. Check your connection and try again.',
  changedMeanwhile: 'This alert changed meanwhile. Check it and try again.',
} as const;

export interface BrowserSub {
  json: S.SubscriptionJson;
  unsubscribe(): Promise<boolean>;
}
export interface Browser {
  permission(): NotificationPermission;
  subscription(): Promise<BrowserSub | null>;
  subscribe(vapidKey: string): Promise<BrowserSub>;
  workerReady(): Promise<boolean>;
  workerReads(op: string): Promise<boolean>;
  closeNotifications(): Promise<void>;
  /** Runs `fn` holding the driver lock if no other page holds it; null if one does. */
  drive<T>(fn: () => Promise<T>): Promise<T | null>;
  visible(): boolean;
}
export interface ControllerDeps {
  env: S.Env;
  api: DeviceApi;
  browser: Browser;
  /** Wall clock: stored times (creation, renewal) and server deadlines turned local. */
  now(): number;
  /** Monotonic clock (performance.now()): every wait and deadline within one page. */
  mono(): number;
  sleep(ms: number): Promise<void>;
  ownerToken(): string | null;
  forgetOwner(): void;
  vapidKey(): string | null;
}
export type RowView =
  | { kind: 'none' }
  | { kind: 'on'; alert: S.Known; renewFailing: boolean }
  | { kind: 'setting-up'; slow: boolean }
  | { kind: 'blocked' }
  | { kind: 'ended'; endedAt: number }
  | { kind: 'again' }
  /** Turned off: whether the browser confirmed its subscription gone, and whether the server confirmed the deletion. */
  | { kind: 'off'; unsubscribed: boolean; deleted: boolean }
  | { kind: 'cant-check' }
  | { kind: 'legacy' }
  | { kind: 'updating' };
export type SetupResult = { ok: true; text: string } | { ok: false; text: string; retry: boolean };
type Outcome = { result: string; activation: Activation | null };

const known = (a: Extract<MineAnswer, { state: 'active' }>['alert']): S.Known => ({
  alertId: a.alertId, incarnation: a.incarnation, generation: a.generation, revision: a.revision, fingerprint: a.fingerprint, endsAt: Date.parse(a.endsAt), choices: a.choices,
});
/** Answers to a setup or rotation request that mean the server stored nothing for it: the operation ends here. */
const NOT_ADMITTED = new Set(['off', 'unavailable', 'owner-only', 'full', 'changed']);

export class DeviceController {
  view: RowView = { kind: 'none' };
  private listeners = new Set<(v: RowView) => void>();
  private renewFails = 0;
  private renewTimer: Promise<void> | null = null;
  private rotations = 0;
  private readonly d: ControllerDeps;
  constructor(d: ControllerDeps) {
    this.d = d;
  }

  subscribe(listener: (v: RowView) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private show(v: RowView) {
    this.view = v;
    for (const l of this.listeners) l(v);
    return v;
  }
  private fp = (sub: BrowserSub) => S.fingerprint(this.d.env, sub.json);

  // ---- Turn-off left-overs and the channel release's state: resolved before anything else, every time. ----

  /** True when no unsubscribe claim remains: the subscription it names is confirmed gone, or belongs to a newer opt-in. */
  private async resolveClaim(): Promise<boolean> {
    for (let round = 0; round < 2; round++) {
      const s = await S.readState(this.d.env);
      if (!s.claim) return true;
      const current = await this.d.browser.subscription();
      if (!current) {
        await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: true });
        return true;
      }
      const fp = await this.fp(current);
      if (fp !== s.claim.fingerprint) {
        if (s.op?.fingerprint === fp || s.known?.fingerprint === fp) {
          // An opt-in started after the turn-off owns it: the claim is done with.
          await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: true });
          return true;
        }
        // Another subscription, nobody's: a claim for it replaces this one (then a second round unsubscribes it).
        await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: false, replaceWith: fp });
        continue;
      }
      const ok = await current.unsubscribe().catch(() => false);
      const after = await this.d.browser.subscription();
      const gone = ok && (!after || (await this.fp(after)) !== fp);
      await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: gone });
      return gone;
    }
    return false;
  }

  /** True when every retired credential's server deletion is confirmed (deleted, then nothing found under it). */
  private async resolveRetired(): Promise<boolean> {
    const s = await S.readState(this.d.env);
    let all = true;
    for (const r of s.retired.filter((x) => !x.deleted)) {
      try {
        await this.d.api.turnOff(r.credential);
        if ((await this.d.api.mine(r.credential)).state === 'none') await S.retiredDeleted(this.d.env, { credential: r.credential });
        else all = false;
      } catch {
        all = false;
      }
    }
    return all;
  }

  /** The channel release's local credential, retired before any setup; false when that cannot be done (or known). */
  private async retireLegacy(): Promise<boolean> {
    const legacy = await S.legacyCredential(this.d.env);
    if (legacy === 'no') return true;
    if (legacy === 'unknown') return false;
    if (legacy === 'empty') {
      try {
        await S.deleteLegacy(this.d.env);
        return true;
      } catch {
        return false; // an old tab holds it open: it could still make a credential there
      }
    }
    const current = await this.d.browser.subscription();
    if (current) {
      const fp = await this.fp(current);
      const wrote = await S.update(this.d.env, (s) =>
        s.claim || s.op?.fingerprint === fp || s.known?.fingerprint === fp ? { result: false } : { state: { ...s, claim: { task: S.newId(this.d.env), fingerprint: fp } }, result: true },
      );
      if (wrote && !(await this.resolveClaim())) return false;
    }
    try {
      await S.deleteLegacy(this.d.env);
      return true;
    } catch {
      return false;
    }
  }

  private async settleRetirement(): Promise<'ok' | 'pending' | 'legacy'> {
    if (!(await this.retireLegacy().catch(() => false))) return 'legacy';
    // The browser's subscription unknown (no worker yet): the claim stays, and setup waits.
    const claimOk = await this.resolveClaim().catch(() => false);
    const retiredOk = await this.resolveRetired();
    return claimOk && retiredOk ? 'ok' : 'pending';
  }

  /** Removes a subscription the server reported gone (through a claim, confirming it went) before any new one. */
  private async removeGone(fp: string): Promise<boolean> {
    await S.noteGone(this.d.env, fp);
    const current = await this.d.browser.subscription();
    if (!current || (await this.fp(current)) !== fp) return true;
    await S.update(this.d.env, (s) => (s.claim ? { result: undefined } : { state: { ...s, claim: { task: S.newId(this.d.env), fingerprint: fp } }, result: undefined }));
    return this.resolveClaim();
  }

  // ---- Reconcile on every opening and every return to the page. ----

  async reconcile(): Promise<RowView> {
    this.rotations = 0;
    try {
      const retirement = await this.settleRetirement();
      if (retirement === 'legacy') return this.show({ kind: 'legacy' });
      await this.settleStale().catch(() => undefined);
      const s = await S.readState(this.d.env);
      if (!s.credential) {
        if (s.retired.length > 0 || s.claim) return this.show({ kind: 'off', unsubscribed: !s.claim, deleted: s.retired.every((r) => r.deleted) });
        return this.show({ kind: 'none' });
      }
      if (this.d.browser.permission() === 'denied') {
        await this.turnOff();
        return this.show({ kind: 'blocked' });
      }
      const op = s.op;
      if (op && !op.result && !S.opDone(op, this.d.now())) {
        if (op.kind === 'change') return this.replayChange(op, s.credential);
        if (op.phase === 'preparing' || op.phase === 'attached') {
          if (this.d.now() - op.createdAt >= PREPARING_STALE_MS) void this.recoverPreparing(op, s.credential);
          return this.show({ kind: 'setting-up', slow: false });
        }
        this.show({ kind: 'setting-up', slow: false });
        void this.drive(op, s.credential).then((r) => this.result(op, s.credential!, r));
        return this.view;
      }
      return await this.afterRead(s.credential, await this.d.api.mine(s.credential), s);
    } catch (err) {
      if (err instanceof S.Unsupported) return this.show({ kind: 'none' });
      return this.show({ kind: 'cant-check' });
    }
  }

  private async afterRead(credential: string, mine: MineAnswer, before: S.DeviceState, depth = 0): Promise<RowView> {
    // A read that comes back after a turn-off or a new credential says nothing about this device any more; checked again
    // after every wait below, before anything is written or shown.
    const stale = async () => (await S.readState(this.d.env)).credential !== credential;
    if (await stale()) return this.view;
    // Every write from a read is fenced by the `knownVersion` it started from: if anything changed `known` meanwhile (a
    // setup that just finished, a turn-off, another read), this read writes nothing and the row is unchanged.
    if (mine.state === 'gone') {
      if (!(await S.setKnown(this.d.env, { credential, known: null, version: before.knownVersion }))) return this.view;
      await this.removeGone(mine.fingerprint);
      return this.show({ kind: 'again' });
    }
    if (mine.state === 'ended') {
      // Nothing to capture any more: the next setup is a first setup.
      if (!(await S.setKnown(this.d.env, { credential, known: null, version: before.knownVersion }))) return this.view;
      return this.show({ kind: 'ended', endedAt: Date.parse(mine.endedAt) });
    }
    if (mine.state === 'none') {
      const had = before.known !== null;
      if (!(await S.setKnown(this.d.env, { credential, known: null, version: before.knownVersion }))) return this.view;
      // A first setup whose subscription changed before it finished starts again with the saved choices.
      if (before.needsRotation && before.choices) {
        await S.setNeedsRotation(this.d.env, false);
        if (this.d.browser.permission() === 'granted') {
          void this.setup(before.choices);
          return this.show({ kind: 'setting-up', slow: false });
        }
        return this.show({ kind: 'again' });
      }
      return this.show(had ? { kind: 'again' } : { kind: 'none' });
    }
    const k = known(mine.alert);
    // An older revision than the device knows (a read overtaken by a change) is not written, and not shown.
    if (!(await S.setKnown(this.d.env, { credential, known: k, version: before.knownVersion }))) return this.view;
    // From here, this read owns `known` at version v; any other write since (a turn-off, a setup, another read) means
    // this read shows and does nothing more.
    let v = before.knownVersion + 1;
    const moved = async () => {
      const now = await S.readState(this.d.env);
      return now.credential !== credential || now.knownVersion !== v;
    };
    if (mine.alert.updating) return this.show({ kind: 'updating' });
    // "On" needs the browser's proof too (spec): permission granted and its subscription the alert's. Unknown (no worker
    // reached): can't check, nothing rotated or renewed. Not granted: set up again (blocked was handled before the read).
    const current = await this.d.browser.subscription().catch(() => undefined);
    const fp = current ? await this.fp(current) : null;
    if (await moved()) return this.view;
    if (current === undefined) return this.show({ kind: 'cant-check' });
    if (this.d.browser.permission() !== 'granted') return this.show({ kind: 'again' });
    if (fp !== k.fingerprint) {
      await S.setNeedsRotation(this.d.env, true);
      // One rotation per reconcile: a rotation answered "changed" is tried again at the next opening.
      if (this.rotations++ === 0) return this.rotate(credential, k);
      return this.show({ kind: 'updating' });
    }
    if (before.needsRotation) await S.setNeedsRotation(this.d.env, false);
    const renewal = await this.renew(credential, k);
    if (renewal === 'not-active') {
      // The server no longer has it active (ended or deleted between the read and the renewal): read it again, once.
      if (await moved()) return this.view;
      return depth === 0 ? this.reconcileAfter(credential, 1) : this.show({ kind: 'cant-check' });
    }
    if (renewal === 'wrote') v++;
    const now = await S.readState(this.d.env);
    // Shown only if nothing else changed `known` meanwhile, and from what is stored (never this read's copy) ...
    if (now.credential !== credential || now.knownVersion !== v || !now.known) return this.view;
    // ... and with the browser's proof taken again after the renewal's wait (permission or subscription may have moved).
    const proof = await this.proof(now.known.fingerprint);
    // The proof was a wait too: nothing is shown if `known` or the credential moved during it.
    const last = await S.readState(this.d.env);
    if (last.credential !== credential || last.knownVersion !== v || !last.known) return this.view;
    if (proof === 'unknown') return this.show({ kind: 'cant-check' });
    if (proof === 'not-granted') return this.show({ kind: 'again' });
    if (proof === 'other') return depth === 0 ? this.reconcileAfter(credential, 1) : this.show({ kind: 'updating' });
    return this.show({ kind: 'on', alert: last.known, renewFailing: this.renewFails > 0 });
  }

  /** The browser's side of "on": permission granted and its current subscription the one with this fingerprint. */
  private async proof(fingerprint: string): Promise<'ok' | 'unknown' | 'not-granted' | 'other'> {
    const current = await this.d.browser.subscription().catch(() => undefined);
    if (current === undefined) return 'unknown';
    if (this.d.browser.permission() !== 'granted') return 'not-granted';
    if (!current || (await this.fp(current)) !== fingerprint) return 'other';
    return 'ok';
  }

  /**
   * On opening, unless the last confirmed renewal is under an hour old (a time in the future is discarded). 'wrote':
   * the new end was written onto the same alert still known; 'kept': nothing written (not due, failing, or the alert
   * known changed meanwhile, which a renewal never undoes); 'not-active': the server has no active alert any more.
   */
  private async renew(credential: string, k: S.Known): Promise<'wrote' | 'kept' | 'not-active'> {
    const s = await S.readState(this.d.env);
    const at = s.renewedAt !== null && s.renewedAt <= this.d.now() ? s.renewedAt : null;
    if (at !== null && this.d.now() - at < RENEW_EVERY_MS) return 'kept';
    try {
      const r = await this.d.api.seen(credential);
      if (r.state !== 'active') return 'not-active';
      await S.setRenewed(this.d.env, { credential, at: this.d.now() });
      this.renewFails = 0;
      // Only the new end, onto the same alert if it is still the one known: a renewal never brings back a replaced or
      // cleared alert, nor older choices.
      const next = await S.setEndsAt(this.d.env, { credential, alertId: k.alertId, incarnation: k.incarnation, generation: k.generation, endsAt: Date.parse(r.endsAt) });
      return next ? 'wrote' : 'kept';
    } catch {
      this.renewFails++;
      this.scheduleRenewRetry(credential);
      return 'kept';
    }
  }

  /** Renewal retried while visible: after 1, 5 and 15 minutes, then hourly; one attempt per retry. */
  private scheduleRenewRetry(credential: string) {
    if (this.renewTimer) return;
    const wait = RENEW_RETRY_MS[this.renewFails - 1] ?? RENEW_EVERY_MS;
    this.renewTimer = this.d.sleep(wait).then(async () => {
      this.renewTimer = null;
      if (!this.d.browser.visible()) return;
      // Retried only for the same credential, from what is stored now (never this read's older copy).
      const now = await S.readState(this.d.env);
      if (now.credential !== credential || !now.known) return;
      // One full reconciliation: it renews once (still due), schedules the next retry if that fails, and decides the
      // row from the server's alert, the version fence and the browser's proof.
      const v = await this.reconcileAfter(credential);
      // The read itself failed before the renewal was tried: the schedule goes on (counted as a failed attempt).
      if (v.kind === 'cant-check' && !this.renewTimer && (await S.readState(this.d.env)).credential === credential) {
        this.renewFails++;
        this.scheduleRenewRetry(credential);
      }
    });
  }

  // ---- Setup, rotation and the driving page. ----

  async setup(choices: AlertChoices, depth = 0): Promise<SetupResult> {
    try {
      if (!(await this.d.browser.workerReady())) return { ok: false, text: TEXT.cantFinish, retry: false };
      const retirement = await this.settleRetirement();
      if (retirement === 'legacy') return { ok: false, text: TEXT.legacy, retry: false };
      if (retirement === 'pending') return { ok: false, text: TEXT.finishingOff, retry: true };
      if ((await this.settleStale()) === 'unverified') return { ok: false, text: TEXT.offline, retry: true };
      const s0 = await S.readState(this.d.env);
      const captured = s0.credential && s0.known ? { incarnation: s0.known.incarnation, generation: s0.known.generation, revision: s0.known.revision } : null;
      const r = await S.begin(this.d.env, { kind: 'setup', choices, captured, now: this.d.now() });
      if ('blocked' in r) return { ok: false, text: TEXT.finishingOff, retry: true };
      if ('joined' in r) {
        const credential = (await S.readState(this.d.env)).credential!;
        return this.result(r.joined, credential, await this.drive(r.joined, credential));
      }
      if ('waiting' in r) {
        if (depth > 0) return { ok: false, text: TEXT.slow, retry: true };
        const credential = (await S.readState(this.d.env)).credential!;
        await this.drive(r.waiting, credential);
        await this.reconcile();
        return this.setup(choices, depth + 1);
      }
      const { started: op, credential } = r;
      const prepared = await this.prepare(op);
      if (!prepared.ok) return prepared.result;
      return this.result(prepared.ready, credential, await this.drive(prepared.ready, credential));
    } catch (err) {
      if (err instanceof S.Unsupported) return { ok: false, text: TEXT.cantFinish, retry: false };
      if (err instanceof DeviceApiError) return { ok: false, text: TEXT.offline, retry: true };
      return { ok: false, text: TEXT.didntFinish, retry: true };
    }
  }

  /**
   * Preparing an operation, shared by setup and by recovery: a subscription (a gone one removed first), attached by
   * compare-and-set, the worker's proof it reads the same storage, and the VAPID key kept for re-subscribing.
   */
  private async prepare(op: S.Operation): Promise<{ ok: true; ready: S.Operation } | { ok: false; result: SetupResult }> {
    // This caller's attachment id: a failure here drops the operation only while it is still preparing or if this caller
    // attached it, never a request another page (or the worker) attached and sent.
    const by = S.newId(this.d.env);
    let attachedHere = false;
    const fail = async (text: string, retry: boolean) => {
      await S.abandon(this.d.env, { op: op.op, fingerprint: null, by: attachedHere ? by : null });
      return { ok: false as const, result: { ok: false as const, text, retry } };
    };
    const s0 = await S.readState(this.d.env);
    const vapid = this.d.vapidKey() ?? s0.vapidKey;
    if (!vapid) return fail(TEXT.unavailable, false);
    if (this.d.browser.permission() !== 'granted') return fail(TEXT.again, true);
    let sub = await this.d.browser.subscription();
    if (sub && s0.gone.includes(await this.fp(sub))) {
      if (!(await this.removeGone(await this.fp(sub)))) return fail(TEXT.deadSubscription, false);
      sub = null;
    }
    sub ??= await this.d.browser.subscribe(vapid);
    const fp = await this.fp(sub);
    if (s0.gone.includes(fp)) return fail(TEXT.deadSubscription, false);
    const attached = await S.attach(this.d.env, { op: op.op, epoch: op.epoch, subscription: sub.json, fingerprint: fp, by });
    if (attached === 'abandoned') {
      if (await S.abandon(this.d.env, { op: op.op, fingerprint: fp, by: null })) await this.resolveClaim().catch(() => false);
      return { ok: false, result: { ok: false, text: TEXT.didntFinish, retry: true } };
    }
    attachedHere = attached === 'ok';
    const stored = (await S.readState(this.d.env)).op;
    if (!stored || stored.op !== op.op || !stored.subscription) return { ok: false, result: { ok: false, text: TEXT.didntFinish, retry: true } };
    if (!attachedHere) {
      // 'already': another caller attached first. Its exact stored request stands and this page joins it; the drive
      // waits until that caller's handshake makes it ready. A different fingerprint here is the browser's newer
      // subscription: the alert is rotated to it at the next opening.
      if (stored.fingerprint !== fp) await S.setNeedsRotation(this.d.env, true);
      return { ok: true, ready: stored };
    }
    if (!(await this.d.browser.workerReads(op.op))) return fail(TEXT.cantFinish, false);
    await S.setVapid(this.d.env, vapid);
    if (!(await S.confirmReady(this.d.env, { op: op.op, by }))) {
      // A recovering page adopted it meanwhile (this page was slow): join the operation it made ready, if it did.
      const now = (await S.readState(this.d.env)).op;
      if (now?.op === op.op && (now.phase === 'ready' || now.phase === 'sent')) return { ok: true, ready: now };
      return { ok: false, result: { ok: false, text: TEXT.didntFinish, retry: true } };
    }
    return { ok: true, ready: { ...stored, phase: 'ready' } };
  }

  /**
   * An operation no page carried on (the page or worker that made it went away), recovered here under the driver lock:
   * still preparing, it is prepared; attached but never made ready, it is adopted from its recorded owner, and the
   * handshake is done here against its stored (immutable) subscription.
   */
  private async recoverPreparing(op: S.Operation, credential: string): Promise<void> {
    // The lock covers preparing and driving only; the outcome is presented (and may rotate, which drives under the same
    // lock) after it is released.
    const got = await this.d.browser.drive(async (): Promise<{ ready: S.Operation; outcome: Outcome } | null> => {
      const s = await S.readState(this.d.env);
      if (s.op?.op !== op.op || s.epoch !== op.epoch || s.op.result) return null;
      let ready: S.Operation;
      if (s.op.phase === 'preparing') {
        const prepared = await this.prepare(s.op);
        if (!prepared.ok) return null;
        ready = prepared.ready;
      } else if (s.op.phase === 'attached') {
        const by = S.newId(this.d.env);
        if (!(await S.adopt(this.d.env, { op: s.op.op, from: s.op.by, by }))) return null;
        if (!(await this.d.browser.workerReads(s.op.op))) {
          await S.abandon(this.d.env, { op: s.op.op, fingerprint: null, by });
          return null;
        }
        const vapid = this.d.vapidKey() ?? s.vapidKey;
        if (vapid) await S.setVapid(this.d.env, vapid);
        if (!(await S.confirmReady(this.d.env, { op: s.op.op, by }))) return null;
        ready = { ...s.op, phase: 'ready', by };
      } else return null;
      return { ready, outcome: await this.driveHere(ready, credential) };
    });
    if (got) await this.result(got.ready, credential, got.outcome);
  }

  private async rotate(credential: string, k: S.Known, attempt = 0): Promise<RowView> {
    const vapid = this.d.vapidKey() ?? (await S.readState(this.d.env)).vapidKey;
    if (!vapid) return this.show({ kind: 'again' });
    if ((await this.settleStale().catch(() => 'ok' as const)) === 'unverified') return this.show({ kind: 'cant-check' });
    const r = await S.begin(this.d.env, { kind: 'rotate', choices: null, captured: { incarnation: k.incarnation, generation: k.generation }, now: this.d.now() });
    if (!('started' in r)) return this.show({ kind: 'setting-up', slow: false });
    const by = S.newId(this.d.env);
    const sub = (await this.d.browser.subscription()) ?? (this.d.browser.permission() === 'granted' ? await this.d.browser.subscribe(vapid) : null);
    if (!sub) {
      await S.abandon(this.d.env, { op: r.started.op, fingerprint: null, by: null });
      return this.show({ kind: 'again' });
    }
    const fp = await this.fp(sub);
    const attached = await S.attach(this.d.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: fp, by });
    if (attached === 'abandoned') {
      if (await S.abandon(this.d.env, { op: r.started.op, fingerprint: fp, by: null })) await this.resolveClaim();
      return this.show({ kind: 'none' });
    }
    // 'ok': no handshake for a rotation (the worker that would read it is the one that started rotations before), so
    // it is ready at once. 'already' (the worker or a recovering page attached first): the stored request is driven,
    // once its attaching caller makes it ready.
    if (attached === 'ok') await S.confirmReady(this.d.env, { op: r.started.op, by });
    const ready = (await S.readState(this.d.env)).op;
    if (!ready || ready.op !== r.started.op || !ready.subscription) return this.reconcileAfter(credential);
    const outcome = await this.drive(ready, credential);
    if (outcome.result === 'changed' && attempt === 0) {
      // The alert changed under the rotation (a re-setup or a change won): read it again and rotate once more,
      // if the credential and the browser's subscription are as they were.
      const now = await S.readState(this.d.env);
      const cur = await this.d.browser.subscription();
      if (now.credential === credential && cur && (await this.fp(cur)) === ready.fingerprint) {
        const mine = await this.d.api.mine(credential).catch(() => null);
        if (mine?.state === 'active') return this.rotate(credential, known(mine.alert), 1);
      }
    }
    if (outcome.result === 'active') {
      // Cleared only if the browser still has the subscription that was proven.
      const now = await this.d.browser.subscription();
      if (now && (await this.fp(now)) === ready.fingerprint) await S.setNeedsRotation(this.d.env, false);
    }
    return this.reconcileAfter(credential);
  }

  private async reconcileAfter(credential: string, depth = 0): Promise<RowView> {
    try {
      // The state before the read is the read's starting point (afterRead's version fence).
      const before = await S.readState(this.d.env);
      return await this.afterRead(credential, await this.d.api.mine(credential), before, depth);
    } catch {
      return this.show({ kind: 'cant-check' });
    }
  }

  /**
   * Drives the operation to a terminal result or its end (spec, step 7). Only the visible page holding the driver lock
   * drives; another waits, reading the result the driver records, and takes over when the driver goes away.
   */
  private async drive(op: S.Operation, credential: string): Promise<Outcome> {
    const driveStart = this.d.mono();
    for (;;) {
      const s = await S.readState(this.d.env);
      if (s.credential !== credential || s.op?.op !== op.op) return { result: 'changed', activation: null };
      if (s.op.result) return { result: s.op.result, activation: s.op.activation };
      // A hidden page neither drives nor asks the server anything: it stops here (the operation stays unfinished) and
      // the next opening or return to the page carries it on (reconcile).
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      // Done by the wall clock: confirmed with the server first (a device clock that jumped ahead is not an expiry).
      if (S.opDone(s.op, this.d.now())) {
        const st = await this.serverOp(op.op, credential);
        if (st.kind === 'terminal') {
          await S.recordResult(this.d.env, { op: op.op, credential, result: st.result, activation: st.activation });
          return { result: st.result, activation: st.activation };
        }
        // Sent, and the server has no record of it: it expired and was reclaimed.
        if (st.kind === 'absent' && s.op.phase === 'sent') return { result: 'expired', activation: null };
        // Unknown (offline) for longer than any operation can last: given up.
        if (st.kind === 'unknown' && this.d.mono() - driveStart > UNANSWERED_MS + 300_000 + AFTER_EXPIRY_MS) return { result: 'expired', activation: null };
        // Open (its deadline refreshed by serverOp), or never sent (absent, ready): driven as usual.
      }
      // Driven here if no other page holds the driver lock; a 'hidden' from driveHere (the page was hidden while it
      // drove) ends this too. Not ready yet, or another page drives: wait and look again.
      const driven = await this.d.browser.drive(() => this.driveHere(s.op!, credential));
      if (driven && driven.result !== 'not-ready') return driven;
      await this.d.sleep(POLL_SLOW_MS);
    }
  }

  private async send(op: S.Operation, credential: string): Promise<SetupAnswer> {
    const sub = { endpoint: op.subscription!.endpoint, keys: op.subscription!.keys };
    if (op.kind === 'rotate') return this.d.api.rotate(credential, { op: op.op, seq: op.seq, subscription: sub, captured: { incarnation: op.captured!.incarnation, generation: op.captured!.generation } });
    const owner = op.captured ? undefined : (this.d.ownerToken() ?? undefined);
    return this.d.api.setup(credential, { op: op.op, seq: op.seq, subscription: sub, choices: op.choices!, captured: op.captured as never }, owner);
  }

  /**
   * What the server has of this operation: 'open' (its local deadline refreshed from the server's remaining time),
   * 'terminal' with its result, 'absent' (never stored, or reclaimed), or 'unknown' (the server could not be asked).
   */
  private async serverOp(op: string, credential: string): Promise<{ kind: 'open' | 'absent' | 'unknown' } | { kind: 'terminal'; result: string; activation: Activation | null }> {
    const mine = await this.d.api.mine(credential).catch(() => null);
    if (!mine) return { kind: 'unknown' };
    const o = mine.operation;
    if (!o || o.op !== op) return { kind: 'absent' };
    if (o.result) return { kind: 'terminal', result: o.result, activation: o.activation };
    if (o.remainingMs !== null) await S.markSent(this.d.env, { op, expiresAt: this.d.now() + o.remainingMs });
    return { kind: 'open' };
  }

  /**
   * Before starting anything: an unfinished operation whose wall-clock deadline passed is settled by what the server
   * says (its result kept, or its deadline refreshed), so a device clock that jumped never lets a new operation replace
   * one the server still has open.
   */
  private async settleStale(): Promise<'ok' | 'unverified'> {
    const s = await S.readState(this.d.env);
    const o = s.op;
    if (!s.credential || !o || o.result || !S.opDone(o, this.d.now())) return 'ok';
    const st = await this.serverOp(o.op, s.credential);
    if (st.kind === 'terminal') await S.recordResult(this.d.env, { op: o.op, credential: s.credential, result: st.result, activation: st.activation });
    // A sent operation the server could not be asked about may still be open there: nothing replaces it until it can be.
    if (st.kind === 'unknown' && o.phase === 'sent') return 'unverified';
    return 'ok';
  }

  /** Every answer's expiry becomes this device's own deadline (now + the server's remaining time); never its absolute time. */
  private async noteView(op: string, view: OperationView) {
    if (view.remainingMs !== null) await S.markSent(this.d.env, { op, expiresAt: this.d.now() + view.remainingMs });
  }

  private async driveHere(op: S.Operation, credential: string): Promise<Outcome> {
    // Not ready yet (preparing, or attached while its caller's handshake runs): the caller that attached it makes it
    // ready; this page keeps waiting for it ('not-ready' is never a result).
    if (op.phase === 'preparing' || op.phase === 'attached' || !op.subscription) return { result: 'not-ready', activation: null };
    if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
    const record = async (result: string, activation: Activation | null): Promise<Outcome> => {
      await S.recordResult(this.d.env, { op: op.op, credential, result, activation });
      const s = await S.readState(this.d.env);
      return s.op?.op === op.op && s.op.result ? { result: s.op.result, activation: s.op.activation } : { result, activation };
    };
    let view: OperationView | null = null;
    /** When (on this page's monotonic clock) the last view arrived: its relative times count from here. */
    let viewAt = 0;
    // Time on this page is measured monotonically (a wall-clock jump never ends or hurries an operation): the operation's
    // age is its wall-clock age when this page took it over, plus the monotonic time since.
    const startMono = this.d.mono();
    const startWall = this.d.now();
    const age = () => Math.max(0, startWall - op.createdAt) + (this.d.mono() - startMono);
    /** Reads an answer to the request; returns a terminal outcome, or null to keep driving. */
    const take = async (answer: SetupAnswer | null): Promise<Outcome | null> => {
      if (!answer || answer.outcome === 'limited' || answer.outcome === 'busy') return null;
      if (answer.outcome === 'pending' || answer.outcome === 'done') {
        if (answer.operation) {
          view = answer.operation;
          viewAt = this.d.mono();
          await this.noteView(op.op, view);
        }
        return null;
      }
      // A follow-up read only while visible; hidden, the loop's next check stops (the operation is kept).
      if (!this.d.browser.visible()) return null;
      if (answer.outcome === 'invalid') {
        // Not this operation (another request with its id, or one too old): read what the server has.
        const mine = await this.d.api.mine(credential).catch(() => null);
        if (mine?.operation?.op === op.op) {
          view = mine.operation;
          viewAt = this.d.mono();
          return null;
        }
        return record('failed', null);
      }
      if (NOT_ADMITTED.has(answer.outcome)) {
        // Refused before storage, unless an earlier request of this operation was stored (its answer lost): ask.
        const mine = await this.d.api.mine(credential).catch(() => null);
        if (mine?.operation?.op === op.op) {
          view = mine.operation;
          viewAt = this.d.mono();
          return null;
        }
        if (!mine) return null; // unknown: keep driving, the next repeat or read decides
        if (answer.outcome === 'owner-only') this.d.forgetOwner();
        return record(answer.outcome === 'off' ? 'unavailable' : answer.outcome, null);
      }
      return null;
    };
    // After every wait (a request, a sleep): still visible, still this credential's operation, still unfinished?
    // Otherwise the driver lock goes before another request.
    const stop = async (): Promise<Outcome | null> => {
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      const t = await S.readState(this.d.env);
      if (t.credential !== credential || t.op?.op !== op.op) return { result: 'changed', activation: null };
      if (t.op.result) return { result: t.op.result, activation: t.op.activation };
      return null;
    };
    const firstAnswer = await this.send(op, credential).catch(() => null);
    const firstHalt = await stop();
    if (firstHalt) return firstHalt;
    const first = await take(firstAnswer);
    if (first) return first;
    // Timing counts from the operation's start (kept in state), so a page taking over keeps the schedule.
    let repeats = 0;
    let lastRepeat = 0; // as age()
    let lastAck = -Infinity; // as mono()
    let slowShown = false;
    for (;;) {
      if (view?.result) return record(view.result, view.activation);
      const s = await S.readState(this.d.env);
      if (s.credential !== credential || s.op?.op !== op.op) return { result: 'changed', activation: null };
      if (s.op.result) return { result: s.op.result, activation: s.op.activation };
      // Hidden: the driver lock goes now, before any further request (each ends within REQUEST_TIMEOUT_MS); the
      // operation stays as it is, for the next visible page or this one when it shows again.
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      // The server's remaining time, once an answer here gave it, with 30 s for a late result; else the deadline another
      // page stored (as it stood when this page took over); else 2 minutes from the start.
      const deadline =
        view?.remainingMs != null
          ? viewAt + view.remainingMs + AFTER_EXPIRY_MS
          : s.op.expiresAt !== null
            ? startMono + Math.max(0, s.op.expiresAt + AFTER_EXPIRY_MS - startWall)
            : startMono + Math.max(0, UNANSWERED_MS - Math.min(UNANSWERED_MS, Math.max(0, startWall - op.createdAt)));
      // Nothing the server said yet: 2 minutes after creation (spec), its age carried over by the wall clock at takeover.
      // A wall clock that jumped could make that early, so the server is asked before the operation is called expired.
      if (this.d.mono() > deadline) {
        const st = await this.serverOp(op.op, credential);
        if (st.kind === 'terminal') return record(st.result, st.activation);
        if (st.kind !== 'open') return record('expired', null);
        const fresh = await this.d.api.mine(credential).catch(() => null);
        if (fresh?.operation?.op === op.op) {
          view = fresh.operation;
          viewAt = this.d.mono();
        }
        continue;
      }
      if (!slowShown && age() >= POLL_FAST_FOR_MS) {
        slowShown = true;
        this.show({ kind: 'setting-up', slow: true });
      }
      // The worker stored a nonce but no result came: acknowledge from here, every 15 s.
      if (s.op.nonce && this.d.mono() - lastAck >= ACK_RETRY_MS) {
        lastAck = this.d.mono();
        const r = await this.d.api.ready(credential, { op: op.op, nonce: s.op.nonce }).catch(() => null);
        if (r && r.result !== 'limited' && r.result !== 'invalid' && r.result !== 'unknown') return record(r.result, r.activation);
        const halt = await stop();
        if (halt) return halt;
      }
      // Unsent or retryable, or no answer yet: the identical request again, after 5, 15 and 45 s (or the server's retry time).
      const gap = REPEAT_AFTER_MS[Math.min(repeats, REPEAT_AFTER_MS.length - 1)]!;
      const retryAt = view?.retryInMs != null ? viewAt + view.retryInMs : 0;
      const waiting = view === null || view.dispatch === 'unsent' || view.dispatch === 'retryable';
      if (waiting && age() - lastRepeat >= gap && this.d.mono() >= retryAt) {
        repeats++;
        lastRepeat = age();
        const answer = await this.send(op, credential).catch(() => null);
        const halt = await stop();
        if (halt) return halt;
        const done = await take(answer);
        if (done) return done;
        continue;
      }
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      await this.d.sleep(age() < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);
      const halt = await stop();
      if (halt) return halt;
      const mine = await this.d.api.mine(credential).catch(() => null);
      if (mine?.operation?.op === op.op) {
        view = mine.operation;
        viewAt = this.d.mono();
        await this.noteView(op.op, view);
      }
    }
  }

  /** What an operation's outcome means for the person, checked against this operation, credential and subscription. */
  private async result(op: S.Operation, credential: string, r: Outcome): Promise<SetupResult> {
    // A hidden page reads nothing: a terminal result the server gave is already recorded locally (its truth), and the
    // next opening or return to the page reconciles and shows it.
    if (r.result === 'hidden' || !this.d.browser.visible()) return { ok: false, text: TEXT.slow, retry: false };
    if (r.result === 'active' && r.activation) {
      const act = r.activation;
      const before = await S.readState(this.d.env);
      // The operation as stored (a caller that joined it before it was attached holds a copy without its subscription).
      const fp = before.op?.op === op.op ? before.op.fingerprint : op.fingerprint;
      const mine = await this.d.api.mine(credential).catch(() => null);
      const a = mine?.state === 'active' ? mine.alert : null;
      // The server's current alert is this activation, with this operation's subscription.
      const serverOk = !!fp && !!a && a.incarnation === act.incarnation && a.generation === act.generation && a.fingerprint === fp;
      // The row follows the read (and may rotate or renew); the success itself is judged on fresh evidence, never on a
      // row another step left: this credential still current, the alert known is this activation's, and the browser's
      // proof taken now.
      if (mine) await this.afterRead(credential, mine, before);
      // This activation, exactly, is what the device knows: its incarnation, generation and subscription.
      const isThis = (s: S.DeviceState) => s.credential === credential && s.known?.incarnation === act.incarnation && s.known.generation === act.generation && s.known.fingerprint === fp;
      const now = await S.readState(this.d.env);
      const proof = fp ? await this.proof(fp) : 'other';
      // And still is after the proof's wait: the same epoch, `known` untouched, and still this activation.
      const last = await S.readState(this.d.env);
      const stable = last.epoch === now.epoch && last.knownVersion === now.knownVersion;
      if (serverOk && isThis(now) && isThis(last) && stable && proof === 'ok') return { ok: true, text: TEXT.on };
      if (proof === 'unknown') return { ok: false, text: TEXT.cantFinish, retry: true };
      return { ok: false, text: TEXT.again, retry: true };
    }
    if (r.result === 'gone' && op.fingerprint) {
      const removed = await this.removeGone(op.fingerprint);
      await this.reconcileAfter(credential);
      return removed ? { ok: false, text: TEXT.didntFinish, retry: true } : { ok: false, text: TEXT.deadSubscription, retry: false };
    }
    await this.reconcileAfter(credential).catch(() => undefined);
    switch (r.result) {
      case 'expired':
        return { ok: false, text: TEXT.expired, retry: true };
      case 'full':
        return { ok: false, text: TEXT.full, retry: true };
      case 'unavailable':
        return { ok: false, text: TEXT.unavailable, retry: true };
      case 'limited':
        return { ok: false, text: TEXT.limited, retry: true };
      case 'owner-only':
        return { ok: false, text: TEXT.ownerOnly, retry: false };
      default:
        return { ok: false, text: TEXT.didntFinish, retry: true };
    }
  }

  // ---- Change, test, turn off. ----

  async change(choices: AlertChoices): Promise<SetupResult> {
    if ((await this.settleStale().catch(() => 'ok' as const)) === 'unverified') return { ok: false, text: TEXT.offline, retry: true };
    const s = await S.readState(this.d.env);
    if (!s.credential || !s.known) return { ok: false, text: TEXT.again, retry: false };
    const r = await S.begin(this.d.env, { kind: 'change', choices, captured: { incarnation: s.known.incarnation, generation: s.known.generation, revision: s.known.revision }, now: this.d.now() });
    if ('blocked' in r) return { ok: false, text: TEXT.finishingOff, retry: true };
    if ('waiting' in r) return { ok: false, text: TEXT.slow, retry: true };
    if ('joined' in r) {
      // The same change pressed twice, or in two tabs: wait for that operation's own result.
      for (let i = 0; i < 12; i++) {
        const now = await S.readState(this.d.env);
        if (now.op?.op !== r.joined.op) break;
        if (now.op.result) return now.op.result === 'active' ? { ok: true, text: 'Saved.' } : { ok: false, text: TEXT.changedMeanwhile, retry: true };
        await this.d.sleep(POLL_FAST_MS);
      }
      return { ok: false, text: TEXT.slow, retry: true };
    }
    const v = await this.replayChange(r.started, s.credential);
    // Saved only on this operation's own result, never because the alert's revision moved (another change may have won).
    const after = (await S.readState(this.d.env)).op;
    if (after?.op === r.started.op && after.result === 'active') return { ok: true, text: 'Saved.' };
    if (after?.op === r.started.op && after.result) return { ok: false, text: TEXT.changedMeanwhile, retry: true };
    if (v.kind === 'cant-check') return { ok: false, text: TEXT.offline, retry: true };
    return { ok: false, text: TEXT.slow, retry: true };
  }

  /** Sends the exact change stored in the operation, until it has its own result (a lost answer is sent again). */
  private async replayChange(op: S.Operation, credential: string): Promise<RowView> {
    try {
      const a = await this.d.api.change(credential, { op: op.op, seq: op.seq, incarnation: op.captured!.incarnation, baseRevision: op.captured!.revision!, choices: op.choices! });
      if (a.result === 'busy') return this.show({ kind: 'setting-up', slow: false });
      await S.recordResult(this.d.env, { op: op.op, credential, result: a.result, activation: null });
      return await this.reconcileAfter(credential);
    } catch {
      // Kept: the next opening sends it again.
      return this.show({ kind: 'cant-check' });
    }
  }

  async test(): Promise<string> {
    const s = await S.readState(this.d.env);
    if (!s.credential) return TEXT.again;
    try {
      const r = await this.d.api.test(s.credential);
      if (r.test === 'accepted') return TEXT.testAccepted;
      if (r.test === 'uncertain') return TEXT.testUncertain;
      if (r.test === 'gone') {
        await this.reconcileAfter(s.credential);
        return r.updating ? TEXT.updating : TEXT.again;
      }
      if (r.test === 'unavailable') return TEXT.unavailable;
      if (r.test === 'limited') return 'You can send 3 tests an hour. Try again later.';
      if (r.test === 'none') return TEXT.again;
      return TEXT.testRefused;
    } catch {
      return TEXT.offline;
    }
  }

  /** Turn off: one local step (state.js), then unsubscribing and the server deletion, each reported on its own. */
  async turnOff(): Promise<RowView> {
    // The browser's subscription unknown (no worker reached): the turn-off goes on, and says it could not confirm.
    const current = await this.d.browser.subscription().catch(() => undefined);
    const fp = current === undefined ? S.UNKNOWN_SUBSCRIPTION : current ? await this.fp(current) : null;
    await S.turnOff(this.d.env, { fingerprint: fp });
    const [claimed, deleted] = await Promise.all([this.resolveClaim().catch(() => false), this.resolveRetired()]);
    const unsubscribed = current !== undefined && claimed;
    await this.d.browser.closeNotifications().catch(() => undefined);
    return this.show({ kind: 'off', unsubscribed, deleted });
  }
}
```

`apps/web/src/devices/browser.ts` (the adapter for the real page):

```ts
// The real browser behind the controller: the push manager of the active registration, the worker handshake,
// notifications on screen, visibility and the driver lock.
import * as S from './state.js';
import type { Browser, BrowserSub } from './controller.ts';
import { readyWorker } from '../notify/worker.ts';

const wrap = (s: PushSubscription): BrowserSub => {
  const j = s.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return { json: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }, unsubscribe: () => s.unsubscribe() };
};
const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function realBrowser(): Browser {
  const reg = async () => (await readyWorker(10_000))?.registration ?? null;
  return {
    permission: () => ('Notification' in window ? Notification.permission : 'denied'),
    // Null only when the push manager itself says there is none; no registration reached is an error (unknown).
    subscription: async () => {
      const r = await reg();
      if (!r) throw new S.Unsupported('no service worker registration');
      const s = await r.pushManager.getSubscription();
      return s ? wrap(s) : null;
    },
    subscribe: async (vapid) => {
      const r = await reg();
      if (!r) throw new S.Unsupported('no service worker');
      return wrap(await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapid) }));
    },
    workerReady: async () => (await readyWorker(10_000)) !== null,
    workerReads: async (op) => {
      const r = await reg();
      const worker = r?.active;
      if (!worker) return false;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(false), 3000);
        channel.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve((e.data as { op?: string } | null)?.op === op);
        };
        worker.postMessage({ type: 'read-operation' }, [channel.port2]);
      });
    },
    closeNotifications: async () => {
      const r = await reg();
      for (const n of (await r?.getNotifications()) ?? []) n.close();
    },
    drive: async (fn) => {
      if (!navigator.locks) return fn();
      return navigator.locks.request(S.DRIVER_LOCK, { ifAvailable: true }, async (lock) => (lock ? fn() : null));
    },
    visible: () => document.visibilityState === 'visible',
  };
}

export const browserEnv = (): S.Env => ({ indexedDB: window.indexedDB, locks: navigator.locks, crypto: window.crypto });
```

The worker's `read-operation` answer and `deviceAlerts: 1` come in Task 18; `readyWorker` checks `deviceAlerts` there.

- [ ] **Step 6: Watch them pass**

Run: `npm test -w @penge/web -- controller state`
Expected: PASS.

- [ ] **Step 7: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review of a page controller for one device's notification alert, against the spec's 'Setting up, with the ready check' (steps 1–8 and the outcome table), 'Changing, testing, turning off', 'When the subscription changes' and 'Lifetime and clean-up'. Look for a success reported for an expired or replaced operation, a write to local state after the operation or credential changed, a setup started while an unsubscribe claim or a retired credential is unresolved, a renewal not confirmed by the server, a late push mishandled, and any loop that can spin without sleeping."). Then:

```bash
git add apps/web/src/devices apps/web/test/controller.test.ts apps/web/test/fake-device-server.ts apps/web/test/state.test.ts
git commit -m "The page's notification controller: setup with the ready check, rotation, renewal, change, test, turn off"
```

---
### Task 16: The owner link, and one alerts form with the channel switches first

**Files:**
- Create: `apps/web/src/devices/owner.ts`, `apps/web/src/devices/instance.ts`
- Modify: `apps/web/src/main.tsx`, `apps/web/src/notify/context.ts` (owner by token), `apps/web/src/components/AlertSheet.tsx` (rewritten), `apps/web/src/styles.css` (the result lines)
- Test: `apps/web/test/owner-token.test.ts`, `apps/web/test/sheet.test.tsx` (the channel section rewritten; the email tests switch Email on first)

**Interfaces:**
- Consumes: Task 15's `DeviceController`, `realBrowser`, `browserEnv`, `deviceApi`, `TEXT`; `pushCapability` (context.ts).
- Produces:
  - owner.ts: `OWNER_KEY = 'pengepassportph-owner-token'`; `takeOwnerLink(w?: Window): { kept: boolean } | null` (run before the app renders or the worker registers); `ownerToken(w?): string | null`; `forgetOwner(w?): void`.
  - instance.ts: `deviceController(status: () => StatusResponse | null): DeviceController` (one per page).
  - `pushCapability(w, status, { owner: boolean; workerOk: boolean })` unchanged in shape; `owner` is now `ownerToken() !== null`; `ownerOverride` is deleted.
  - `AlertSheet` props: `{ api; status; offices; selected; initialApplicants?; onSelectedChange; onClose; controller: DeviceController | null; change?: AlertChoices }` (with `change`, the form edits only this device's alert).
  - Copy, verbatim: switch labels "Email", "Notifications on this device" (app or installed) / "Browser notifications" (tab); buttons "Turn on notifications", "Send confirmation email", "Turn on notifications and send confirmation email", "Save"; both on: "These choices apply to both now. Afterwards, change notifications on this device and email through its links."; results "Notifications are on for this device." and "Check your inbox for a link to start email alerts."; an iPhone tab: "To get notifications on iPhone, add this site to your Home Screen, then open it from there."; unsupported: "This browser can't show notifications."; pace hints "One notification…", "One email…", "One email and one notification…".

- [ ] **Step 1: Write the failing tests**

`apps/web/test/owner-token.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { forgetOwner, ownerToken, takeOwnerLink } from '../src/devices/owner.ts';

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
function fakeWindow(hash: string, storage: unknown = new MemoryStorage()) {
  const calls: string[] = [];
  const w = {
    location: { hash, pathname: '/pengepassportph/', search: '?office=486' },
    history: { state: null, replaceState: (_: unknown, __: string, url: string) => calls.push(url) },
    localStorage: storage,
  } as unknown as Window;
  return { w, calls };
}
const TOKEN = 'a'.repeat(40);

describe('the owner link', () => {
  it('keeps the token and removes it from the address bar', () => {
    const { w, calls } = fakeWindow(`#owner=${TOKEN}`);
    expect(takeOwnerLink(w)).toEqual({ kept: true });
    expect(ownerToken(w)).toBe(TOKEN);
    expect(calls).toEqual(['/pengepassportph/?office=486']);
  });

  it('trims and decodes a pasted link once (spaces, percent-encoding)', () => {
    const { w } = fakeWindow(`#owner=%20${TOKEN}%20`);
    takeOwnerLink(w);
    expect(ownerToken(w)).toBe(TOKEN);
    const twice = fakeWindow(`#owner=${encodeURIComponent(encodeURIComponent(' '))}${TOKEN}`);
    takeOwnerLink(twice.w);
    expect(ownerToken(twice.w)).toBeNull(); // "%20…" after one decode is not a token: refused, never decoded again
  });

  it('keeps other fragment parts, such as a confirmation token', () => {
    const { w, calls } = fakeWindow(`#token=abc&owner=${TOKEN}`);
    takeOwnerLink(w);
    expect(calls).toEqual(['/pengepassportph/?office=486#token=abc']);
  });

  it('says when the browser would not keep it', () => {
    const refusing = { getItem: () => null, setItem: () => { throw new DOMException('no', 'SecurityError'); }, removeItem: () => {} };
    const { w, calls } = fakeWindow(`#owner=${TOKEN}`, refusing);
    expect(takeOwnerLink(w)).toEqual({ kept: false });
    expect(calls).toHaveLength(1); // removed from the address bar all the same
  });

  it('does nothing without an owner link, and forgets the token on request', () => {
    const { w, calls } = fakeWindow('#token=abc');
    expect(takeOwnerLink(w)).toBeNull();
    expect(calls).toEqual([]);
    const s = fakeWindow(`#owner=${TOKEN}`);
    takeOwnerLink(s.w);
    forgetOwner(s.w);
    expect(ownerToken(s.w)).toBeNull();
  });
});
```

In `apps/web/test/sheet.test.tsx`:

1. Replace the `vi.mock` lines for `../src/notify/push.ts` and `../src/notify/shared.js` with none (those modules go in Task 17); keep the `../src/notify/worker.ts` mock.
2. `Harness` passes `controller={null}` by default, or a fake controller (`{ setup: vi.fn(), change: vi.fn() }` cast to `DeviceController`) where a test gives one.
   The office-picker test's own `Both` component (its `<AlertSheet …>` near line 49) also gets `controller={null}` (the prop is required).
   The successful-email test (near line 82) waits for the new result text, `'Check your inbox for a link to start email alerts.'`, instead of `'Check your inbox for a confirmation link.'`.
3. `open()` switches Email on first (Email is off by default), then reads the email field and the button:

```ts
function open(api = fakeApi(), initial: number[] = [], onClose = vi.fn()) {
  render(<Harness api={api} initial={initial} onClose={onClose} />);
  const sheet = screen.getByRole('dialog');
  fireEvent.click(within(sheet).getByRole('switch', { name: 'Email' }));
  return {
    api, onClose, sheet,
    email: within(sheet).getByLabelText('Your email') as HTMLInputElement,
    people: within(sheet).getByLabelText('Booking for') as HTMLSelectElement,
    pace: within(sheet).getByLabelText('How often') as HTMLSelectElement,
    honeypot: sheet.querySelector('input[name="website"]') as HTMLInputElement,
    boxes: () => within(sheet).queryAllByRole('checkbox') as HTMLInputElement[],
    submit: within(sheet).getByRole('button', { name: 'Send confirmation email' }),
  };
}
```

4. The fuzz test sends `{ email, siteIds, applicants, pace, website }` (no `channels`): change its expectation of the request body accordingly.
5. Replace the whole `describe('channels in the alert form', …)` block with:

```ts
const LIVE: StatusResponse = { ...STATUS, push: 'live', vapidPublicKey: 'B'.repeat(87) };
/** The form with notifications available (secure context, push, a worker), once its switch has shown. */
async function withNotifications(o: { permission?: NotificationPermission; request?: NotificationPermission; setup?: unknown; noSwitch?: boolean } = {}) {
  vi.stubGlobal('Notification', Object.assign(function () {}, { permission: o.permission ?? 'default', requestPermission: vi.fn(async () => o.request ?? 'granted') }));
  vi.stubGlobal('PushManager', function () {});
  vi.stubGlobal('isSecureContext', true); // pushCapability() requires it; jsdom leaves it undefined
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
  Object.defineProperty(navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
  const controller = { setup: vi.fn(async () => o.setup ?? { ok: true, text: 'Notifications are on for this device.' }), change: vi.fn() } as unknown as DeviceController;
  function Live() {
    const [selected, setSelected] = useState<number[]>([486]);
    return <AlertSheet api={fakeApi()} status={LIVE} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} controller={controller} />;
  }
  render(<Live />);
  const sheet = screen.getByRole('dialog');
  // The switch shows once the (mocked) worker check resolves: wait for it before any test touches it.
  if (!o.noSwitch) await within(sheet).findByRole('switch', { name: 'Browser notifications' });
  return { sheet, controller, email: () => within(sheet).getByRole('switch', { name: 'Email' }), notify: () => within(sheet).getByRole('switch', { name: 'Browser notifications' }) };
}

describe('one alerts form, two kinds of alert', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts with both switches off, the email field hidden, and nothing to send', async () => {
    const s = await withNotifications();
    expect(s.email().getAttribute('aria-checked')).toBe('false');
    expect(s.notify().getAttribute('aria-checked')).toBe('false');
    expect(within(s.sheet).queryByLabelText('Your email')).toBeNull();
    expect(within(s.sheet).getByRole('button', { name: /Turn on|Send/ })).toBeDisabled();
  });

  it('asks for permission inside the tap and never switches email on by itself', async () => {
    const s = await withNotifications({ request: 'denied' });
    fireEvent.click(s.notify());
    await waitFor(() => expect(within(s.sheet).getByText(/blocked for this site/)).toBeTruthy());
    expect(s.notify().getAttribute('aria-checked')).toBe('false');
    expect(s.email().getAttribute('aria-checked')).toBe('false');
  });

  it('names what the button will do', async () => {
    const s = await withNotifications();
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    fireEvent.click(s.email());
    expect(within(s.sheet).getByRole('button', { name: 'Turn on notifications and send confirmation email' })).toBeTruthy();
    expect(within(s.sheet).getByText('These choices apply to both now. Afterwards, change notifications on this device and email through its links.')).toBeTruthy();
    fireEvent.click(s.notify());
    expect(within(s.sheet).getByRole('button', { name: 'Send confirmation email' })).toBeTruthy();
  });

  it('turns on notifications with no email address sent anywhere', async () => {
    const s = await withNotifications();
    fireEvent.click(s.notify());
    const button = await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    fireEvent.click(button);
    await waitFor(() => within(s.sheet).getByText('Notifications are on for this device.'));
    expect(s.controller.setup).toHaveBeenCalledWith({ siteIds: [486], applicants: 1, pace: 'hourly' });
  });

  it('sends one setup for two submits in the same moment (before the button can disable)', async () => {
    const s = await withNotifications({ setup: { ok: false, text: 'Notifications are full right now. Email alerts still work.', retry: true } });
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    // Submit events straight on the form: the guard, not the disabled button, must stop the second.
    const form = s.sheet.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await within(s.sheet).findByRole('button', { name: 'Try notifications again' });
    expect(s.controller.setup).toHaveBeenCalledTimes(1);
  });

  it('runs both from one snapshot, shows each result, and offers a retry for only the one that failed', async () => {
    const s = await withNotifications({ setup: { ok: false, text: 'Notifications are full right now. Email alerts still work.', retry: true } });
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    fireEvent.click(s.email());
    fireEvent.change(within(s.sheet).getByLabelText('Your email'), { target: { value: 'juan@example.com' } });
    fireEvent.click(within(s.sheet).getByRole('button', { name: 'Turn on notifications and send confirmation email' }));
    await waitFor(() => within(s.sheet).getByText('Check your inbox for a link to start email alerts.'));
    expect(within(s.sheet).getByText('Notifications are full right now. Email alerts still work.')).toBeTruthy();
    const retry = within(s.sheet).getByRole('button', { name: 'Try notifications again' });
    fireEvent.click(retry);
    await waitFor(() => expect(s.controller.setup).toHaveBeenCalledTimes(2));
    expect((s.controller.setup as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toEqual({ siteIds: [486], applicants: 1, pace: 'hourly' });
  });

  it('speaks of the channels on in the pace hint', async () => {
    const s = await withNotifications();
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByText(/One notification with everything new/));
    fireEvent.click(s.email());
    expect(within(s.sheet).getByText(/One email and one notification with everything new/)).toBeTruthy();
  });

  it('edits only this device\'s alert from "Change": no switches, no email, a Save button', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    const controller = { change: vi.fn(async () => ({ ok: true, text: 'Saved.' })) } as unknown as DeviceController;
    render(<AlertSheet api={fakeApi()} status={LIVE} offices={OFFICES} selected={[486]} onSelectedChange={() => {}} onClose={() => {}} controller={controller} change={{ siteIds: [486], applicants: 2, pace: 'asap' }} />);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).queryAllByRole('switch')).toEqual([]);
    expect(within(sheet).queryByLabelText('Your email')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(controller.change).toHaveBeenCalledWith({ siteIds: [486], applicants: 2, pace: 'asap' }));
  });

  it('shows the Home Screen hint in an iPhone tab, and no switch', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605' });
    await withNotifications({ noSwitch: true });
    expect(await screen.findByText('To get notifications on iPhone, add this site to your Home Screen, then open it from there.')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /notifications/i })).toBeNull();
  });
});
```

(Add `import type { DeviceController } from '../src/devices/controller.ts';` and `import type { StatusResponse } from '@penge/contracts';` if missing.)

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/web -- owner-token sheet`
Expected: FAIL: `Cannot find module '../src/devices/owner.ts'`; the sheet has no Email switch.

- [ ] **Step 3: The owner link**

`apps/web/src/devices/owner.ts`:

```ts
// The owner link (spec: "Configuration", owner mode): #owner=<token>, read before the app renders or the worker
// registers, kept in local storage, and removed from the address bar (a fragment never reaches the server or its logs).
export const OWNER_KEY = 'pengepassportph-owner-token';
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export function takeOwnerLink(w: Window = window): { kept: boolean } | null {
  const hash = w.location.hash.replace(/^#/, '');
  const parts = hash.split('&');
  const at = parts.findIndex((p) => p.startsWith('owner='));
  if (at < 0) return null;
  let token = parts[at]!.slice('owner='.length);
  try {
    token = decodeURIComponent(token);
  } catch {
    token = '';
  }
  token = token.trim();
  parts.splice(at, 1);
  const rest = parts.filter(Boolean).join('&');
  w.history.replaceState(w.history.state, '', `${w.location.pathname}${w.location.search}${rest ? `#${rest}` : ''}`);
  if (!TOKEN.test(token)) return { kept: false };
  try {
    w.localStorage.setItem(OWNER_KEY, token);
    return { kept: true };
  } catch {
    return { kept: false };
  }
}

export function ownerToken(w: Window = window): string | null {
  try {
    const t = w.localStorage.getItem(OWNER_KEY);
    return t && TOKEN.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function forgetOwner(w: Window = window): void {
  try {
    w.localStorage.removeItem(OWNER_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
```

(In the `twice` case the value after one decode is `%20aaa…`, which fails `TOKEN` and is refused; the test expects `null`.)

`apps/web/src/main.tsx`, before `createRoot`:

```ts
import { takeOwnerLink } from './devices/owner.ts';

// Before rendering or registering the worker: the owner link leaves the address bar at once.
const owner = takeOwnerLink();
if (owner && !owner.kept) sessionStorage.setItem('pengepassportph-owner-unkept', '1');
```

(the sheet shows "This browser could not keep the owner link." when that flag is set; wrapped in `try` since `sessionStorage` can throw).

`apps/web/src/notify/context.ts`: delete `OWNER_KEY`, `ownerOverride`; `pushCapability` unchanged; callers pass `owner: ownerToken() !== null`. In the same step, `apps/web/test/notify.test.ts`: remove `ownerOverride` from its import and the case's `ownerOverride(...)` lines (the case keeps its `pushCapability` assertions; the owner link's own tests are `owner-token.test.ts`).

`apps/web/src/devices/instance.ts`:

```ts
// One controller per page, for the row and the form.
import type { StatusResponse } from '@penge/contracts';
import { deviceApi } from './api.ts';
import { browserEnv, realBrowser } from './browser.ts';
import { DeviceController } from './controller.ts';
import { forgetOwner, ownerToken } from './owner.ts';

let one: DeviceController | null = null;
/** The latest status any caller gave: the one controller always reads the current VAPID key. */
let latest: () => StatusResponse | null = () => null;

export function deviceController(status: () => StatusResponse | null): DeviceController {
  latest = status;
  one ??= new DeviceController({
    env: browserEnv(),
    api: deviceApi,
    browser: realBrowser(),
    now: Date.now,
    mono: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ownerToken: () => ownerToken(),
    forgetOwner: () => forgetOwner(),
    vapidKey: () => latest()?.vapidPublicKey ?? null,
  });
  return one;
}
```

- [ ] **Step 4: The form**

Rewrite `apps/web/src/components/AlertSheet.tsx`. It keeps the current file's modal behaviour (focus trap, inert background, Escape, the office picker, chips, area filter, limit) exactly; only the form's fields, order, switches, submission and results change. The new component:

```tsx
import { type AlertChoices, type Field, LIMITS, PACE_LABELS, PACES, type Pace, type StatusResponse, validateChoices, validateSubscribe } from '@penge/contracts';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Api, ApiFailure, errorText } from '../api.ts';
import { AREAS } from '../areas.ts';
import type { DeviceController, SetupResult } from '../devices/controller.ts';
import { ownerToken } from '../devices/owner.ts';
import { type Context, detectContext, pushCapability } from '../notify/context.ts';
import { registration } from '../notify/worker.ts';
import { matches, type Office, PARTY_SIZES, partyLabel } from '../office.ts';
import { CheckIcon, CloseIcon, SearchIcon } from './Icons.tsx';

interface Props {
  api: Api;
  status: StatusResponse;
  offices: Office[];
  selected: number[];
  initialApplicants?: number;
  onSelectedChange: (ids: number[]) => void;
  onClose: () => void;
  /** This page's notification controller; null where notifications cannot be set up. */
  controller: DeviceController | null;
  /** From "Change" on the device row: edit only this device's alert. */
  change?: AlertChoices;
}

const PICK_AREAS = [...AREAS, 'Abroad'] as const;
const pickArea = (o: Office) => (o.country ? 'Abroad' : o.area);
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select, [tabindex="0"]';

type Outcome = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; ok: boolean; text: string; retry: boolean };
const IDLE: Outcome = { kind: 'idle' };

/** The alerts form, as a modal sheet: from the bottom on phones, centred on wider screens. */
export function AlertSheet({ api, status, offices, selected, initialApplicants = 1, onSelectedChange, onClose, controller, change }: Props) {
  const id = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [applicants, setApplicants] = useState(change?.applicants ?? initialApplicants);
  const [pace, setPace] = useState<Pace>(change?.pace ?? 'hourly');
  const [website, setWebsite] = useState('');
  const [picking, setPicking] = useState(selected.length === 0);
  const [query, setQuery] = useState('');
  const [area, setArea] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [emailOn, setEmailOn] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // Each kind of alert's outcome for the last submission; a retry reuses that submission's snapshot.
  const [emailOutcome, setEmailOutcome] = useState<Outcome>(IDLE);
  const [notifyOutcome, setNotifyOutcome] = useState<Outcome>(IDLE);
  const snapshot = useRef<{ choices: AlertChoices; email: string } | null>(null);
  // Set in the same tick as the press, before any await or render: a second press (or a retry) while one runs does nothing.
  const busyRef = useRef(false);
  const context = useMemo(() => detectContext(), []);
  const [workerOk, setWorkerOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void registration().then((r) => live && setWorkerOk(!!r));
    return () => {
      live = false;
    };
  }, []);
  const capability = useMemo(() => {
    const base = pushCapability(window, status, { owner: ownerToken() !== null, workerOk: true });
    if (!base.ok) return base;
    if (workerOk === null || !controller) return { ok: false, reason: 'off' } as const;
    return workerOk ? base : ({ ok: false, reason: 'no-worker' } as const);
  }, [status, workerOk, controller]);

  const BLOCKED: Record<Context, string> = {
    browser: /Firefox\//.test(navigator.userAgent)
      ? 'Notifications are blocked for this site. Allow them from the padlock in the address bar, then try again.'
      : 'Notifications are blocked for this site. Allow them in the site settings (the icon left of the address), then try again.',
    installed: 'Notifications are blocked for this app. Allow them in your browser or phone settings, then try again.',
    play: "Allow notifications for PassportPH in your phone's Settings › Apps, then try again.",
  };
  useEffect(() => {
    if (capability.ok && 'Notification' in window && Notification.permission === 'denied') setNotifyNote(BLOCKED[context]);
    // Only when the switch first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capability.ok]);

  // Changing any choice after a submission makes the next press a new submission. While a submission runs the form's
  // controls are disabled (a fieldset), so its outcomes always belong to the choices shown.
  const submission = useRef(0);
  useEffect(() => {
    if (busyRef.current) return;
    submission.current++;
    snapshot.current = null;
    setEmailOutcome(IDLE);
    setNotifyOutcome(IDLE);
  }, [selected, applicants, pace, email]);

  function toggleNotify() {
    if (asking) return;
    if (notifyOn) {
      setNotifyOn(false);
      return;
    }
    setNotifyNote(null);
    if (Notification.permission === 'granted') {
      setNotifyOn(true);
      return;
    }
    if (Notification.permission === 'denied') {
      setNotifyNote(BLOCKED[context]);
      return;
    }
    setAsking(true);
    // Inside the tap, before anything else awaits: the browser must see the request as the person's.
    void Notification.requestPermission().then((p) => {
      setAsking(false);
      if (p === 'granted') setNotifyOn(true);
      else if (p === 'denied') setNotifyNote(BLOCKED[context]);
      // Dismissed: back off, nothing said.
    });
  }

  // (byId, shown, areas, the focus/inert effect, the focus-on-picking effect and toggle(officeId) are the current
  // file's, unchanged.)

  const label = change
    ? 'Save'
    : notifyOn && emailOn
      ? 'Turn on notifications and send confirmation email'
      : notifyOn
        ? 'Turn on notifications'
        : 'Send confirmation email';
  const canSend = change ? true : emailOn || notifyOn;

  async function runEmail(s: { choices: AlertChoices; email: string }) {
    const mine = submission.current;
    setEmailOutcome({ kind: 'busy' });
    const checked = validateSubscribe({ email: s.email, ...s.choices, website }, new Set(offices.map((o) => o.id)));
    if (!checked.ok) {
      setErrors(checked.errors);
      setEmailOutcome(IDLE);
      if (checked.errors.email) emailRef.current?.focus();
      return;
    }
    try {
      await api.subscribe({ ...checked.value, website });
      if (mine === submission.current) setEmailOutcome({ kind: 'done', ok: true, text: 'Check your inbox for a link to start email alerts.', retry: false });
    } catch (err) {
      if (mine !== submission.current) return;
      setErrors(err instanceof ApiFailure ? err.fields : {});
      setEmailOutcome({ kind: 'done', ok: false, text: errorText(err), retry: true });
    }
  }

  async function runNotify(s: { choices: AlertChoices }) {
    if (!controller) return;
    const mine = submission.current;
    setNotifyOutcome({ kind: 'busy' });
    const r: SetupResult = change ? await controller.change(s.choices) : await controller.setup(s.choices);
    if (mine === submission.current) setNotifyOutcome({ kind: 'done', ...r, retry: !r.ok && r.retry });
  }

  /** Runs one press (a submit or a retry) unless one is running; the guard is taken synchronously. */
  async function guarded(run: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await run();
    } finally {
      busyRef.current = false;
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSend || asking || busyRef.current) return;
    const checked = validateChoices({ siteIds: selected, applicants, pace }, new Set(offices.map((o) => o.id)));
    if (!checked.ok) {
      setErrors(checked.errors);
      if (checked.errors.siteIds) setPicking(true);
      return;
    }
    setErrors({});
    // One snapshot; when both are on, the two requests run independently from it. No address is sent with Email off.
    const s = { choices: checked.value, email };
    snapshot.current = s;
    void guarded(() => Promise.all([!change && emailOn ? runEmail(s) : null, change || notifyOn ? runNotify(s) : null]));
  }

  const busy = emailOutcome.kind === 'busy' || notifyOutcome.kind === 'busy';
  const ownerUnkept = useMemo(() => {
    try {
      return sessionStorage.getItem('pengepassportph-owner-unkept') === '1';
    } catch {
      return false;
    }
  }, []);
  const paceWho = change ? 'notification' : emailOn && notifyOn ? 'email and one notification' : notifyOn ? 'notification' : 'email';
  const resultLine = (o: Outcome, retryLabel: string, retry: () => void) =>
    o.kind === 'done' && (
      <div className={o.ok ? 'sheet-result' : 'sheet-result sheet-result-failed'} role="status">
        {o.ok && <CheckIcon />}
        <p>{o.text}</p>
        {o.retry && snapshot.current && (
          <button type="button" className="link-button" onClick={retry}>
            {retryLabel}
          </button>
        )}
      </div>
    );

  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <div className="sheet-head">
          <h2 id={`${id}-title`}>{change ? 'Change notifications on this device' : 'Alerts'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          {ownerUnkept && <p className="hint hint-strong">This browser could not keep the owner link, so notifications are not offered here. Allow this site to store data, then open the owner link again.</p>}
          <fieldset className="form-body" disabled={busy}>
          {!change && (
            <fieldset className="field channels">
              <legend>How should we tell you?</legend>
              <button type="button" role="switch" className="switch" aria-checked={emailOn} onClick={() => !busy && setEmailOn(!emailOn)}>
                <span className="switch-track" aria-hidden="true" /> Email
              </button>
              {capability.ok ? (
                <button type="button" role="switch" className="switch" aria-checked={notifyOn} aria-busy={asking || undefined} onClick={toggleNotify}>
                  <span className="switch-track" aria-hidden="true" /> {context === 'browser' ? 'Browser notifications' : 'Notifications on this device'}
                </button>
              ) : capability.reason === 'ios-tab' ? (
                <p className="hint">To get notifications on iPhone, add this site to your Home Screen, then open it from there.</p>
              ) : capability.reason === 'unsupported' ? (
                <p className="hint">This browser can't show notifications.</p>
              ) : capability.reason === 'no-worker' ? (
                <p className="hint">Notifications need the site to finish loading. Reload the page to turn them on.</p>
              ) : null}
              {notifyNote && <p className="hint hint-strong">{notifyNote}</p>}
              {emailOn && notifyOn && <p className="hint">These choices apply to both now. Afterwards, change notifications on this device and email through its links.</p>}
            </fieldset>
          )}

          {!change && emailOn && (
            <div className="field">
              <label htmlFor={`${id}-email`}>Your email</label>
              <input ref={emailRef} id={`${id}-email`} type="email" inputMode="email" autoComplete="email" spellCheck={false} maxLength={LIMITS.emailMaxLength}
                value={email} onChange={(ev) => setEmail(ev.target.value)} aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? `${id}-email-note ${id}-email-error` : `${id}-email-note`} placeholder="juan@example.com" />
              <p className="hint" id={`${id}-email-note`}>
                Our database and backups keep your address encrypted, and we use it only for these alerts. Unsubscribing deletes it; the last copies, in backups and mail-server logs, are gone within 14 days.
              </p>
              {errors.email && <p className="error" id={`${id}-email-error`}>{errors.email}</p>}
            </div>
          )}

          {/* The offices fieldset (chips, picker, hint, error) is the current file's, unchanged. */}

          <div className="field">
            <label htmlFor={`${id}-applicants`}>Booking for</label>
            <select id={`${id}-applicants`} value={applicants} onChange={(ev) => setApplicants(Number(ev.target.value))}>
              {PARTY_SIZES.map((n) => (
                <option key={n} value={n}>{partyLabel(n)}</option>
              ))}
            </select>
            <p className="hint">For a group, you only hear about dates with room for everyone.</p>
            {errors.applicants && <p className="error">{errors.applicants}</p>}
          </div>

          <div className="field">
            <label htmlFor={`${id}-pace`}>How often</label>
            <select id={`${id}-pace`} value={pace} onChange={(ev) => setPace(ev.target.value as Pace)}>
              {PACES.map((p) => (
                <option key={p} value={p}>{PACE_LABELS[p]}</option>
              ))}
            </select>
            <p className="hint">
              {pace === 'hourly'
                ? `One ${paceWho} with everything new since the last one, at most once an hour.`
                : `One ${paceWho} from each check that finds dates; checks run every 5 minutes.`}{' '}
              Dates that closed in the meantime are left out.
            </p>
            {errors.pace && <p className="error">{errors.pace}</p>}
          </div>

          <div className="hp" aria-hidden="true">
            <label htmlFor={`${id}-website`}>Website</label>
            <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(ev) => setWebsite(ev.target.value)} />
          </div>

          </fieldset>
          {resultLine(notifyOutcome, 'Try notifications again', () => {
            const s = snapshot.current;
            if (s) void guarded(() => runNotify(s));
          })}
          {resultLine(emailOutcome, 'Try email again', () => {
            const s = snapshot.current;
            if (s) void guarded(() => runEmail(s));
          })}
          {errors.form && <p className="error" role="alert">{errors.form}</p>}
          <button type="submit" className="btn btn-primary btn-block" aria-busy={busy} disabled={!canSend || busy}>
            {busy ? 'Working…' : label}
          </button>
          {!change && emailOn && <p className="hint sheet-fine">We email you a link first; email alerts start when you press it. Every alert has a one-click unsubscribe.</p>}
          {!change && notifyOn && <p className="hint sheet-fine">This device shows a setup notification first; notifications start once it arrives.</p>}
        </form>
      </div>
    </div>,
    document.body,
  );
}
```

Copy the current file's `byId`, `shown`, `areas`, the focus/inert `useEffect`, the picking-focus `useEffect` (its selector becomes `picking ? 'input[type="search"]' : 'button[role="switch"]'`), `toggle(officeId)` and the offices `<fieldset>` into the places marked, unchanged. The old `sent`/"Check your email" view, `pushLine`, `enablePush`, `markRequested` and every `notify/push.ts`/`notify/shared.js` import go.

`apps/web/src/styles.css`, after `.sheet-done`:

```css
.sheet-result { display: flex; gap: 0.5rem; align-items: flex-start; flex-wrap: wrap; margin: 0 0 0.75rem; }
.sheet-result p { margin: 0; flex: 1 1 12rem; }
.sheet-result svg { flex: none; color: var(--accent); }
.sheet-result-failed p { color: var(--danger, #b42318); }
```

`Home.tsx` passes `controller={status ? deviceController(() => status) : null}` (import from `../devices/instance.ts`).

- [ ] **Step 5: Watch them pass**

Run: `npm test -w @penge/web -- owner-token sheet`
Expected: PASS.

- [ ] **Step 6: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS (the old `notify-shared.test.ts` and `notify.test.ts` still pass: their modules are deleted in Task 17).

Codex pass (prompt: "Adversarial review of the alerts form (channel switches first, the email field only with Email on, both off by default, Email never switched on by itself, the permission asked inside the tap, one snapshot with independent requests and per-kind retry, Change mode) and of the owner link (read and removed from the address bar before render, trimmed and decoded once, stored locally, sent only with new setups). Check the copy against the spec verbatim, that no email address is sent with Email off, and that a pasted or double-encoded link cannot leak or be decoded twice."). Then:

```bash
git add apps/web/src apps/web/test/owner-token.test.ts apps/web/test/sheet.test.tsx
git commit -m "One alerts form with the channel switches first, and the owner link kept out of the address bar"
```

---
### Task 17: The device row, the entry buttons, the pages, and the channel contracts removed

**Files:**
- Modify: `apps/web/src/components/DeviceRow.tsx` (rewritten), `apps/web/src/pages/Home.tsx`, `apps/web/src/components/OfficeView.tsx`, `apps/web/src/pages/DeleteData.tsx`, `apps/web/src/pages/Privacy.tsx`, `apps/web/src/api.ts`, `apps/web/src/styles.css`, `packages/contracts/src/index.ts`, `packages/contracts/test/contracts.test.ts`, `apps/server/src/api.ts` (its preview type)
- Restore from `157bad9`: `apps/web/src/pages/Confirm.tsx`
- Delete: `apps/web/src/notify/shared.js`, `apps/web/src/notify/shared.d.ts`, `apps/web/src/notify/push.ts`, `apps/web/test/notify-shared.test.ts`; in `apps/web/test/notify.test.ts`, the cases for `enablePush`, `ownerOverride` and `deviceLabel`
- Test: `apps/web/test/device-row.test.tsx`, `apps/web/test/pages.test.tsx` (entry buttons, delete-data, confirm, privacy)

**Interfaces:**
- Consumes: Task 15's `DeviceController`, `RowView`, `TEXT`; Task 16's `AlertSheet` `change` prop and `deviceController`.
- Produces:
  - `DeviceRow({ controller, offices, onChange }: { controller: DeviceController; offices: Office[]; onChange: (choices: AlertChoices) => void })` — the row under the summary.
  - `rowText(view: RowView, names: (id: number) => string): string` (exported for tests).
  - Contracts without `Channels`, `readChannels`, `isCredential`, `isCredentialHash`, `ConfirmPreview`, `PushOutcome`, `DeviceState`, `isDeviceState`, `PushSubscriptionInput` stays; `SubscribeRequest` is `{ email; siteIds; applicants; pace }`; `Field` loses `'channels'`; `ConfirmResponse.channels` becomes optional (`channels?: { emailOn: boolean; pushOn: boolean; push: string }`, which only pages of the channel release read); `ApiError.code` is `'reload' | 'limited'`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/device-row.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceRow, rowText } from '../src/components/DeviceRow.tsx';
import type { DeviceController, RowView } from '../src/devices/controller.ts';
import { TEXT } from '../src/devices/controller.ts';

afterEach(cleanup);
const NAMES: Record<number, string> = { 486: 'Antipolo', 693: 'Pampanga', 10: 'Aseana' };
const names = (id: number) => NAMES[id] ?? `Office ${id}`;
const on = (o: Partial<{ siteIds: number[]; applicants: number; pace: 'asap' | 'hourly'; renewFailing: boolean }> = {}): RowView => ({
  kind: 'on',
  renewFailing: o.renewFailing ?? false,
  alert: { alertId: 'a', incarnation: 'i', generation: 1, revision: 1, fingerprint: 'f', endsAt: Date.parse('2027-04-04T00:00:00Z'), choices: { siteIds: o.siteIds ?? [486, 693, 10], applicants: o.applicants ?? 2, pace: o.pace ?? 'asap' } },
});

describe('the row for this device', () => {
  it('says what is on, for whom, how often and until when', () => {
    expect(rowText(on(), names)).toBe('Notifications on this device: Antipolo and 2 more · for 2 people · as soon as possible · until 4 Apr 2027');
    expect(rowText(on({ siteIds: [486], applicants: 1, pace: 'hourly' }), names)).toBe('Notifications on this device: Antipolo · for 1 person · at most once an hour · until 4 Apr 2027');
  });

  it.each([
    [{ kind: 'setting-up', slow: false }, 'Setting up notifications on this device…'],
    [{ kind: 'setting-up', slow: true }, TEXT.slow],
    [{ kind: 'blocked' }, TEXT.blocked],
    [{ kind: 'ended', endedAt: Date.parse('2027-04-04T00:00:00Z') }, 'Notifications on this device ended on 4 Apr 2027. Turn them on again to keep getting them.'],
    [{ kind: 'again' }, TEXT.again],
    [{ kind: 'off', unsubscribed: true, deleted: true }, TEXT.offDone],
    [{ kind: 'off', unsubscribed: true, deleted: false }, `${TEXT.offDone} ${TEXT.offPending}`],
    [{ kind: 'off', unsubscribed: false, deleted: false }, `${TEXT.offBrowser} ${TEXT.offPending}`],
    [{ kind: 'cant-check' }, "Can't check notifications on this device right now."],
    [{ kind: 'legacy' }, TEXT.legacy],
    [{ kind: 'updating' }, TEXT.updating],
  ] as [RowView, string][])('says %j as "%s"', (view, text) => {
    expect(rowText(view, names)).toBe(text);
  });

  it('puts Change, Send a test and Turn off together, and says when renewing is failing', async () => {
    let listener: (v: RowView) => void = () => {};
    const controller = {
      view: on({ renewFailing: true }),
      subscribe: (l: (v: RowView) => void) => ((listener = l), () => {}),
      reconcile: vi.fn(async () => on({ renewFailing: true })),
      test: vi.fn(async () => TEXT.testAccepted),
      turnOff: vi.fn(async (): Promise<RowView> => ({ kind: 'none' })),
    } as unknown as DeviceController;
    const onChange = vi.fn();
    render(<DeviceRow controller={controller} offices={[]} onChange={onChange} onSetUp={() => {}} names={names} />);
    await waitFor(() => screen.getByText(TEXT.renewFailing));
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    await waitFor(() => screen.getByText(TEXT.testAccepted));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onChange).toHaveBeenCalledWith({ siteIds: [486, 693, 10], applicants: 2, pace: 'asap' });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(controller.turnOff).toHaveBeenCalled());
    act(() => listener({ kind: 'none' }));
    expect(screen.queryByText(/Notifications on this device/)).toBeNull();
  });

  it('offers Turn off while setting up, and Set up again once ended', async () => {
    const turnOff = vi.fn(async (): Promise<RowView> => ({ kind: 'off', unsubscribed: true, deleted: true }));
    const setUp = vi.fn();
    const controller = { view: { kind: 'setting-up', slow: false }, subscribe: () => () => {}, reconcile: vi.fn(async (): Promise<RowView> => ({ kind: 'setting-up', slow: false })), turnOff } as unknown as DeviceController;
    render(<DeviceRow controller={controller} onChange={() => {}} onSetUp={setUp} names={names} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(turnOff).toHaveBeenCalled());
    cleanup();
    const ended = { view: { kind: 'ended', endedAt: Date.parse('2027-04-04T00:00:00Z') }, subscribe: () => () => {}, reconcile: vi.fn(async (): Promise<RowView> => ({ kind: 'ended', endedAt: Date.parse('2027-04-04T00:00:00Z') })) } as unknown as DeviceController;
    render(<DeviceRow controller={ended} onChange={() => {}} onSetUp={setUp} names={names} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up again' }));
    expect(setUp).toHaveBeenCalled();
  });

  it('reconciles on opening, on returning to the page, and every 30 s while setting up', async () => {
    vi.useFakeTimers();
    const controller = { view: { kind: 'setting-up', slow: false }, subscribe: () => () => {}, reconcile: vi.fn(async (): Promise<RowView> => ({ kind: 'setting-up', slow: false })) } as unknown as DeviceController;
    render(<DeviceRow controller={controller} offices={[]} onChange={() => {}} onSetUp={() => {}} names={names} />);
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(controller.reconcile).toHaveBeenCalledTimes(2);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(controller.reconcile).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
```

(`DeviceRow` takes `names` for office names; `Home` passes a function over its office list.)

In `apps/web/test/pages.test.tsx`, add (adapting the file's existing render helpers, `renderAt(path, api)` or whatever it uses for the home page):

```tsx
it('opens alerts from "Alerts" on the home page and "Alert me when dates open here" on an office', async () => {
  renderHome();
  expect(await screen.findByRole('button', { name: /^Alerts$/ })).toBeTruthy();
  openOffice(486);
  expect(await screen.findByRole('button', { name: /Alert me when dates open here/ })).toBeTruthy();
});

it('offers alerts when only notifications are available (mail not live)', async () => {
  renderHome({ status: { ...STATUS, mailLive: false, push: 'live', vapidPublicKey: 'B'.repeat(87) } });
  expect(await screen.findByRole('button', { name: /^Alerts$/ })).toBeTruthy();
});

it('splits "delete my data" into email and this device', async () => {
  renderAt('/delete-data');
  expect(await screen.findByRole('heading', { name: 'Email alerts' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'This device' })).toBeTruthy();
});

it('confirms an email alert without any channel lines', async () => {
  renderAt('/confirm#token=' + 't'.repeat(43));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm email alert' }));
  expect(await screen.findByText(/We will email you when a date opens/)).toBeTruthy();
  expect(screen.queryByText(/notification/i)).toBeNull();
});

it('states on the privacy page what notifications keep, and that they need no email', async () => {
  renderAt('/privacy');
  expect(await screen.findByText(/Notifications need no email address\./)).toBeTruthy();
  expect(screen.getByText(/180 days after the site or app was last opened on that device/)).toBeTruthy();
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/web -- device-row pages`
Expected: FAIL: `rowText` is not exported; the buttons are still "Email alerts" and "Email me when dates open here".

- [ ] **Step 3: The row**

`apps/web/src/components/DeviceRow.tsx`, whole file:

```tsx
// "Notifications on this device": this device's alert as the server, the permission and the browser's subscription
// agree it is, reconciled on opening, on returning, and every 30 s while setting up. Change, Send a test and
// Turn off sit together on their own line.
import type { AlertChoices } from '@penge/contracts';
import { useEffect, useState } from 'react';
import { type DeviceController, type RowView, TEXT } from '../devices/controller.ts';
import { formatShortDate } from '../time.ts';

const people = (n: number) => (n === 1 ? 'for 1 person' : `for ${n} people`);

export function rowText(view: RowView, names: (id: number) => string): string {
  switch (view.kind) {
    case 'on': {
      const { choices, endsAt } = view.alert;
      const offices = choices.siteIds.length > 1 ? `${names(choices.siteIds[0]!)} and ${choices.siteIds.length - 1} more` : names(choices.siteIds[0]!);
      const pace = choices.pace === 'asap' ? 'as soon as possible' : 'at most once an hour';
      return `Notifications on this device: ${offices} · ${people(choices.applicants)} · ${pace} · until ${formatShortDate(endsAt)}`;
    }
    case 'setting-up':
      return view.slow ? TEXT.slow : 'Setting up notifications on this device…';
    case 'blocked':
      return TEXT.blocked;
    case 'ended':
      return `Notifications on this device ended on ${formatShortDate(view.endedAt)}. Turn them on again to keep getting them.`;
    case 'again':
      return TEXT.again;
    case 'off':
      return `${view.unsubscribed ? TEXT.offDone : TEXT.offBrowser}${view.deleted ? '' : ` ${TEXT.offPending}`}`;
    case 'cant-check':
      return "Can't check notifications on this device right now.";
    case 'legacy':
      return TEXT.legacy;
    case 'updating':
      return TEXT.updating;
    case 'none':
      return '';
  }
}

export function DeviceRow({ controller, onChange, onSetUp, names }: { controller: DeviceController; offices?: unknown; onChange: (choices: AlertChoices) => void; onSetUp: () => void; names: (id: number) => string }) {
  const [view, setView] = useState<RowView>(controller.view);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const off = controller.subscribe(setView);
    const run = () => void controller.reconcile().then(setView, () => undefined);
    run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', run);
    const timer = setInterval(() => {
      if (controller.view.kind === 'setting-up') run();
    }, 30_000);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', run);
      clearInterval(timer);
    };
  }, [controller]);

  if (view.kind === 'none') return null;
  return (
    <div className="device-row" role="status">
      <span>{rowText(view, names)}</span>
      {view.kind === 'on' && view.renewFailing && <span className="hint">{TEXT.renewFailing}</span>}
      {view.kind === 'on' && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={() => onChange(view.alert.choices)}>
            Change
          </button>
          <button type="button" className="link-button" onClick={() => void controller.test().then(setNote)}>
            Send a test
          </button>
          <button type="button" className="link-button" onClick={() => void controller.turnOff().then(setView)}>
            Turn off
          </button>
        </span>
      )}
      {/* Only Turn off interrupts: it is there whenever this device has something to stop. */}
      {(view.kind === 'setting-up' || view.kind === 'updating' || view.kind === 'cant-check') && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={() => void controller.turnOff().then(setView)}>
            Turn off
          </button>
        </span>
      )}
      {(view.kind === 'ended' || view.kind === 'again' || view.kind === 'blocked') && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={onSetUp}>
            Set up again
          </button>
        </span>
      )}
      {view.kind === 'off' && !(view.unsubscribed && view.deleted) && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={() => void controller.reconcile().then(setView)}>
            Try again
          </button>
        </span>
      )}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}
```

`formatShortDate(ms)` in `apps/web/src/time.ts`: `new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Manila' }).format(ms)` gives `4 Apr 2027`.

- [ ] **Step 4: Home, office, delete-data, confirm, privacy**

`apps/web/src/pages/Home.tsx`:
- `alertsOpen` becomes `home.length > 0 && (status?.mailLive === true || (status?.push ?? 'off') !== 'off')`.
- The toolbar button text becomes `Alerts` (with its bell icon).
- The row: `{status && <DeviceRow controller={deviceController(() => status)} onChange={openChange} onSetUp={() => openAlert(null)} names={(id) => byId.get(id)?.place ?? \`Office ${id}\`} />}` ("Set up again" opens the alerts form) where `byId` is a `Map` of `[...home, ...posts]` by id, and `openChange(choices)` sets the chosen offices to `choices.siteIds`, the group size to `choices.applicants`, and opens the sheet with `change={choices}`. A row hidden while an office is open stays mounted: render it inside a `<div hidden={!!office}>`.
- `AlertSheet` gets `controller={deviceController(() => status)}` and, only in Change mode, `change`: `{...(changeChoices ? { change: changeChoices } : {})}` (the prop is optional and `exactOptionalPropertyTypes` refuses an explicit `undefined`); closing it clears `changeChoices`.

`apps/web/src/components/OfficeView.tsx`: the alert button's text becomes `Alert me when dates open here`.

`apps/web/src/pages/DeleteData.tsx`: the form section gets two parts. Above the existing email content (heading `Email alerts`, the current paragraphs and form, unchanged), and after it:

```tsx
      <h2>This device</h2>
      <DeviceDeletion />
```

with, in the same file:

```tsx
function DeviceDeletion() {
  const [text, setText] = useState<string | null>(null);
  const [has, setHas] = useState(false);
  useEffect(() => {
    void readState(browserEnv()).then((s) => setHas(!!s.credential || s.retired.length > 0), () => setHas(false));
  }, []);
  if (!has) return <p>This device has no notification alert.</p>;
  return (
    <>
      <p>Turning notifications off on this device stops them here and deletes them from our server. It does not touch email alerts.</p>
      {text ? <p role="status">{text}</p> : (
        <button type="button" className="btn btn-secondary" onClick={() => void deviceController(() => null).turnOff().then((v) => setText(rowText(v, (id) => `Office ${id}`) || TEXT.offDone))}>
          Turn off notifications on this device
        </button>
      )}
    </>
  );
}
```

The page's `<h1>` becomes `Stop alerts and delete your data`, the existing intro becomes the `Email alerts` part under `<h2>Email alerts</h2>`.

`apps/web/src/pages/Confirm.tsx`: `git checkout 157bad9 -- apps/web/src/pages/Confirm.tsx`. If `TokenAction`'s props changed since, keep the newer `TokenAction` and drop only its preview-only props from the call (none at `157bad9`).

`apps/web/src/pages/Privacy.tsx`: replace the push section (written for the channel design) with these paragraphs, verbatim from the spec, under a heading `Notifications`:

```tsx
<h2>Notifications</h2>
<p>Notifications need no email address. To send them we keep this browser's or app's push subscription, encrypted, and the alert's offices, group size and pace, next to a random number. Notifications pass through the browser maker's push service (Google, Mozilla, Microsoft or Apple), encrypted; that service keeps its own records of delivery under its own policy.</p>
<p>Turning notifications off stops them on this device when the browser confirms it (if it cannot, we say so and how to block them in the browser's settings), and deletes them from our server when it is reached. Notifications the push service had already accepted may still arrive. If you block notifications or remove the app, we may not learn of it; an alert ends 180 days after the site or app was last opened on that device and could reach us (to within an hour), and sooner if the push service tells us the subscription no longer exists.</p>
<p>Notification alerts are not in our subscriber backups. Deleted data stays in the database's own two files until both have been rewritten, normally within the hour. The same holds for email data.</p>
```

and the page's "last updated" date becomes the deploy day (set by the rollout task; until then `6 October 2026`).

`apps/web/src/api.ts`: delete `previewConfirm`, `pushDevice`, `pushOff`, `pushTest`, `isPreview`, `isDeviceAnswer`, `isOffAnswer`; `isConfirm` no longer requires `channels`; `FIELDS` loses `'channels'`; `CODES` becomes `['reload', 'limited']`; `subscribe` takes `{ email, siteIds, applicants, pace, website }`.

- [ ] **Step 5: Remove the channel contracts**

`packages/contracts/src/index.ts`: delete `Channels`, `B64URL_43`, `isCredential`, `isCredentialHash`, `DEVICE_LABEL`, `readChannels`, `ConfirmPreview`, `PushOutcome`, `DeviceState`, `DEVICE_STATES`, `isDeviceState`; `SubscribeRequest` loses `channels`; `Field` loses `'channels'`; `validateSubscribe` loses its channels lines (back to `157bad9`'s return value, with choices from `validateChoices`); `ApiError.code` becomes `'reload' | 'limited'`; `ConfirmResponse.channels` becomes optional (`channels?: { emailOn: boolean; pushOn: boolean; push: string }`). In `packages/contracts/test/contracts.test.ts` delete the `'channels in a subscribe request'` block.

`apps/server/src/api.ts`'s preview route answers `{ siteIds, applicants, pace, channels: null }` without the contracts type (it already returns `previewPending`'s own type).

Delete `apps/web/src/notify/shared.js`, `apps/web/src/notify/shared.d.ts`, `apps/web/src/notify/push.ts`, `apps/web/test/notify-shared.test.ts`, and the `enablePush`/`deviceLabel` cases in `apps/web/test/notify.test.ts` (with `deviceLabel` from `context.ts`, now unused).

In the same step, every test helper and test that used the removed interfaces:
- `apps/web/test/helpers.tsx`: `fakeApi()` loses `previewConfirm`, `pushDevice`, `pushOff` and `pushTest`; its `confirm` answers without `channels`.
- `apps/web/test/pages.test.tsx`: delete the channel-preview confirmation flows (the cases around its line 594 that render `channels-preview`, acknowledge channels, or read `PushOutcome`), and the subscribe expectation around its line 412 drops `channels` from the request body it expects.
- `apps/web/test/release-regressions.test.tsx`: any case that sends or expects `channels` drops it. In "makes background inert, contains focus and restores it after closing", the opener is `screen.findByRole('button', { name: 'Alerts' })`, and Shift+Tab from Close lands on the last enabled control (with both switches off the submit button is disabled, so not focusable):

  ```ts
      // The last enabled control the sheet cycles through: "How often" (the email field is hidden, the submit button
      // disabled, and the honeypot is out of the tab order).
      expect(document.activeElement).toBe(within(dialog).getByLabelText('How often'));
  ```
- `apps/web/test/pages.test.tsx`, its retained cases: `/Email me when dates open here/` becomes `/Alert me when dates open here/` (the office view's main action, and "offers email alerts for an office, with its group size"); in "offers posts abroad in the alert form, found by country" the opener is `/^Alerts$/`, and before filling "Your email" the case switches Email on (`fireEvent.click(within(sheet).getByRole('switch', { name: 'Email' }))`). Run `grep -n "Email alerts\|Email me when" apps/web/test` afterwards: only the delete-data page's "Email alerts" heading may remain.
- `apps/web/test/pwa.test.ts` (the worker now inlines `src/devices/state.js`, Step 6):
  - "gets a new version when only the worker changes": the temporary root gets `src/devices/state.js` (`mkdirSync(join(root, 'src/devices'), { recursive: true })`, copied from `join(web, 'src/devices/state.js')`) instead of `src/notify/shared.js`;
  - "gets a new version when only the shared push code changes" becomes "… when only the device state code changes", writing `src/devices/state.js` with `// changed` appended (and `src/sw.js` as is);
  - "inlines the shared push code without export statements" becomes "inlines the device state code without export statements": `expect(source).toMatch(/const DB_NAME = 'pengepassportph-device-alerts'/)` and no line starting with `export `;
  - "re-registers with the server when the browser renews the subscription" is deleted (the channel design's renewal protocol; Task 18's `worker.test.ts` tests the rotation that replaces it).
  The other cases stay as they are until Task 18.
Run `grep -rn "channels\|previewConfirm\|pushDevice\|pushOff\|pushTest\|DeviceState" apps/web/src apps/web/test` afterwards: only the server-answer compatibility in `api.ts`'s `isConfirm` comment may remain.

- [ ] **Step 6: Watch everything pass**

Run: `npm test && npm run typecheck`
Expected: PASS across all workspaces. (`sw-plugin.ts` still inlines `notify/shared.js` until Task 18: in this step change its path to `src/devices/state.js`, and in `sw.js` replace the `pushsubscriptionchange` handler's body with `event.waitUntil(Promise.resolve())`; Task 18 writes the real handler.)

- [ ] **Step 7: Codex, commit**

Codex pass (prompt: "Adversarial review: the device row's states and copy against the spec's 'On the home page', the entry buttons, 'delete my data' in two parts that never touch each other, the confirmation page back to 157bad9, the privacy text verbatim from the spec, and the removal of the channel contracts. Check nothing still sends or reads channel fields except the server's answers to 05cee09 pages, and that every user-visible string matches the spec."). Then:

```bash
git add -A apps/web packages/contracts apps/server/src/api.ts
git commit -m "The device row, Alerts buttons, two-part deletion, and the channel contracts removed"
```

---
### Task 18: The service worker: setup pushes and the ready check, rotation, and reloading old pages

**Files:**
- Modify: `apps/web/src/sw.js`, `apps/web/sw-plugin.ts` (inline `devices/state.js` as `/* __STATE__ */`), `apps/web/src/notify/worker.ts` (the handshake needs `deviceAlerts: 1`), `apps/web/test/notify.test.ts` and `apps/web/test/pwa.test.ts` (the handshake and the inlined file)
- Test: `apps/web/test/worker.test.ts`

**Interfaces:**
- Consumes: Task 14's `state.js` (inlined: `readState`, `update`, `storeNonce`, `recordResult`, `begin`, `attach`, `confirmReady`, `abandon`, `newId`, `settleClaim`, `markSent`, `finish`, `setNeedsRotation`, `fingerprint`); the setup payload `{ v: 1, title, body, tag, url: {}, kind: 'setup', op, nonce, expiresAt }` (Task 9).
- Produces: the worker answers `{ type: 'capabilities' }` with `{ version, push: true, deviceAlerts: 1 }` and `{ type: 'read-operation' }` with `{ op: string | null }`; `readyWorker()` resolves only for a worker announcing `deviceAlerts: 1`. Notification texts, verbatim: "Setting up notifications…"; "Notifications are ready" / "You'll get a notification like this when dates open at <offices>."; "This notification setup didn't finish."; "Setting up notifications took too long." / "Open PengePassportPH to try again."; "Notifications are full right now." / "Email alerts still work."; "Couldn't confirm the setup yet." / "Open PengePassportPH to finish.".

- [ ] **Step 1: Write the failing tests**

`apps/web/test/worker.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as S from '../src/devices/state.js';
import { fakeLocks } from './state.test.ts';
import { builtWorkerSource } from './worker-source.ts';

const SCOPE = 'https://penge.example/pengepassportph/';
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) } };

/** The built worker in a fake `self`, with a fake server for /api/device-alerts. */
function worker(o: { answers?: Record<string, unknown>[]; showFails?: boolean } = {}) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const shown: { title: string; body: string; tag?: string }[] = [];
  const posted: { path: string; body: unknown; auth: string | null }[] = [];
  const answers = [...(o.answers ?? [{ result: 'active', activation: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1 } }])];
  const indexedDB = new IDBFactory();
  const locks = fakeLocks();
  const navigated: string[] = [];
  const cachesStore = new Set<string>();
  const self = {
    registration: {
      scope: SCOPE,
      showNotification: vi.fn(async (title: string, opts: { body: string; tag?: string }) => {
        if (o.showFails) throw new TypeError('no permission');
        shown.push({ title, body: opts.body, tag: opts.tag });
      }),
      getNotifications: async () => [],
      pushManager: { getSubscription: async () => ({ toJSON: () => sub }) },
    },
    location: new URL(`${SCOPE}sw.js`),
    navigator: { locks },
    indexedDB,
    crypto: webcrypto,
    addEventListener: (t: string, f: (e: any) => void) => (listeners[t] ??= []).push(f),
    skipWaiting: () => {},
    clients: { claim: async () => {}, matchAll: async () => [{ url: `${SCOPE}?office=486`, navigate: async (u: string) => void navigated.push(u) }] },
  };
  const fetchFake = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const path = url.slice(`${SCOPE}api/device-alerts`.length);
    posted.push({ path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization ?? null });
    if (path === '/mine') return new Response(JSON.stringify({ state: 'active', operation: null, alert: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, choices: { siteIds: [486], applicants: 1, pace: 'asap' }, fingerprint: 'f', endsAt: '2027-04-04T00:00:00.000Z', updating: false } }));
    return new Response(JSON.stringify(answers.shift() ?? { result: 'invalid', activation: null }));
  };
  const caches = { open: async (n: string) => (cachesStore.add(n), { addAll: async () => {} }), keys: async () => [...cachesStore], delete: async (n: string) => cachesStore.delete(n), has: async (n: string) => cachesStore.has(n), match: async () => undefined };
  new Function('self', 'caches', 'fetch', 'Response', builtWorkerSource())(self, caches, fetchFake, Response);
  const env: S.Env = { indexedDB, locks: locks as never, crypto: webcrypto as Crypto };
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    for (const f of listeners[type] ?? []) f({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { self, env, shown, posted, navigated, fire };
}

async function pending(env: S.Env) {
  const r = (await S.begin(env, { kind: 'setup', choices: { siteIds: [486], applicants: 1, pace: 'asap' }, captured: null, now: Date.now() })) as { started: S.Operation; credential: string };
  await S.attach(env, { op: r.started.op, epoch: 0, subscription: sub, fingerprint: await S.fingerprint(env, sub), by: 'page' });
  await S.confirmReady(env, { op: r.started.op, by: 'page' });
  return r;
}
const setupPush = (op: string) => ({ data: { json: () => ({ v: 1, title: 'Setting up PengePassportPH notifications', body: 'Antipolo', tag: `setup-${op}`, url: {}, kind: 'setup', op, nonce: 'n'.repeat(43), expiresAt: new Date(Date.now() + 300_000).toISOString() }) } });

describe('the worker and the ready check', () => {
  it('announces deviceAlerts: 1 and reads the operation back', async () => {
    const w = worker();
    const { started } = await pending(w.env);
    const answers: unknown[] = [];
    await w.fire('message', { data: { type: 'capabilities' }, ports: [{ postMessage: (m: unknown) => answers.push(m) }] });
    await w.fire('message', { data: { type: 'read-operation' }, ports: [{ postMessage: (m: unknown) => answers.push(m) }] });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers[0]).toMatchObject({ push: true, deviceAlerts: 1 });
    expect(answers[1]).toEqual({ op: started.op });
  });

  it('shows the setup notification, stores the nonce, acknowledges with the credential, and says it is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const w = worker();
    const { started, credential } = await pending(w.env);
    await w.fire('push', setupPush(started.op));
    expect(w.shown.map((n) => n.title)).toEqual(['Setting up notifications…', 'Notifications are ready']);
    expect(w.shown[1]!.body).toBe("You'll get a notification like this when dates open at Antipolo.");
    expect(w.shown.every((n) => n.tag === `setup-${started.op}`)).toBe(true);
    expect(w.posted[0]).toEqual({ path: '/ready', body: { op: started.op, nonce: 'n'.repeat(43) }, auth: `Device ${credential}` });
    expect((await S.readState(w.env)).op).toMatchObject({ nonce: 'n'.repeat(43), result: 'active' });
    vi.useRealTimers();
  });

  it('never acknowledges a push for another operation, and says the setup did not finish', async () => {
    const w = worker();
    await pending(w.env);
    await w.fire('push', setupPush('o'.repeat(22)));
    expect(w.posted).toEqual([]);
    expect(w.shown.map((n) => n.title)).toEqual(["This notification setup didn't finish."]);
  });

  it('does not acknowledge when it cannot show the notification: the proof is that this browser shows it', async () => {
    const w = worker({ showFails: true });
    const { started } = await pending(w.env);
    await w.fire('push', setupPush(started.op));
    expect(w.posted).toEqual([]);
  });

  it.each([
    [{ result: 'expired', activation: null }, ['Setting up notifications took too long.', 'Open PengePassportPH to try again.']],
    [{ result: 'full', activation: null }, ['Notifications are full right now.', 'Email alerts still work.']],
    [{ result: 'gone', activation: null }, ["This notification setup didn't finish.", expect.any(String)]],
  ])('replaces its notification for %j', async (answer, [title, body]) => {
    const w = worker({ answers: [answer] });
    const { started } = await pending(w.env);
    await w.fire('push', setupPush(started.op));
    expect(w.shown.at(-1)).toMatchObject({ title, body });
  });

  it('reloads every open page the first time this design\'s worker activates, and never again', async () => {
    const w = worker();
    await w.fire('activate', {});
    await w.fire('activate', {});
    expect(w.navigated).toEqual([`${SCOPE}?office=486`]);
  });

  it('rotates in the background: after a "changed" answer it reads the alert and tries once more, then records it sent', async () => {
    const w = worker({
      answers: [
        { outcome: 'changed', operation: null },
        { outcome: 'pending', operation: { op: 'x'.repeat(22), seq: 2, kind: 'rotate', expiresAt: '2026-10-06T00:05:00.000Z', dispatch: 'accepted', retryAt: null, remainingMs: 300_000, retryInMs: null, reason: null, result: null, activation: null } },
      ],
    });
    const known = { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, fingerprint: 'old', endsAt: Date.now() + 1e9, choices: { siteIds: [486], applicants: 1, pace: 'asap' as const } };
    await S.update(w.env, (s) => ({ state: { ...s, credential: 'c'.repeat(43), known }, result: null }));
    await w.fire('pushsubscriptionchange', {});
    expect(w.posted.map((p) => p.path)).toEqual(['/mine/subscription', '/mine', '/mine/subscription']);
    const s = await S.readState(w.env);
    expect(s.op).toMatchObject({ kind: 'rotate', phase: 'sent', result: null });
    expect(s.op!.expiresAt).toBeGreaterThan(Date.now() + 290_000);
  });

  it('still shows alert pushes as before', async () => {
    const w = worker();
    await w.fire('push', { data: { json: () => ({ v: 1, title: 'Dates open at Antipolo', body: 'Fri 9 Oct · for 1 person · Checked 10:42', tag: 'alert-x', url: { office: 486 } }) } });
    expect(w.shown).toEqual([{ title: 'Dates open at Antipolo', body: 'Fri 9 Oct · for 1 person · Checked 10:42', tag: 'alert-x' }]);
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/web -- worker`
Expected: FAIL: the capabilities answer has no `deviceAlerts`; a setup push is shown as a plain alert.

- [ ] **Step 3: The worker**

`apps/web/sw-plugin.ts`: it reads `src/devices/state.js` since Task 17; strip `export ` the same way, and replace `/* __STATE__ */` (rename the placeholder in `sw.js`). `apps/web/test/pwa.test.ts` (Task 17 moved its file cases to `state.js`), for this activate and message handler:
- the fake `caches` gains `has: async (name: string) => stored.has(name),` (the activate handler asks whether its marker exists);
- "stores the shell on install, then drops only the last build's cache": after `activate`, the kept caches are `[w.cacheName, 'pengepassportph-device-alerts-v1', ...others].sort()` (the one-time reload's marker, which is never deleted);
- "answers the capabilities handshake" expects `{ version: expect.stringMatching(/^[0-9a-f]{12}$/), push: true, deviceAlerts: 1 }`.

`apps/web/src/sw.js`: keep the install, fetch and notificationclick handlers as they are; the activate handler, the message handler, the push handler and the pushsubscriptionchange handler become:

```js
// The first activation of a worker of this design reloads every page it controls, so no page of an older release
// (which could touch the browser's subscription) stays open (spec: "Old pages and the shared subscription").
const MARKER = `${PREFIX}device-alerts-v1`;

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE && key !== MARKER).map((key) => caches.delete(key)));
      await self.clients.claim();
      if (await caches.has(MARKER)) return;
      await caches.open(MARKER);
      for (const client of await self.clients.matchAll({ type: 'window' })) await client.navigate?.(client.url)?.catch(() => undefined);
    })(),
  );
});

/* __STATE__ */

const env = { indexedDB: self.indexedDB, locks: self.navigator?.locks, crypto: self.crypto };
const ICONS = { icon: `${scope}icons/icon-192.png`, badge: `${scope}icons/badge-96.png` };
const TERMINAL = ['active', 'expired', 'changed', 'full', 'owner-only', 'gone', 'failed'];
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
// Every request, its body included, ends within 15 s (as the page's client): a push event is never held by one.
const api = (path, credential, body, method = 'POST') => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  return fetch(`${self.registration.scope}api/device-alerts${path}`, {
    method,
    signal: abort.signal,
    headers: { authorization: `Device ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))
    .finally(() => clearTimeout(timer));
};

self.addEventListener('message', (event) => {
  const port = event.ports?.[0];
  if (event.data?.type === 'capabilities') port?.postMessage({ version: VERSION, push: true, deviceAlerts: 1 });
  if (event.data?.type === 'read-operation') {
    event.waitUntil?.(readState(env).then((s) => port?.postMessage({ op: s.op?.op ?? null }), () => port?.postMessage({ op: null })));
  }
});

async function currentFingerprint() {
  const sub = await self.registration.pushManager.getSubscription();
  return sub ? fingerprint(env, sub.toJSON()) : null;
}

/**
 * Before each step: the credential is not retired, the browser's subscription still has the operation's fingerprint,
 * and the push's op is the operation in progress, or (after acknowledging) its activation is what the device knows.
 */
async function stillOurs(data, credential, activation) {
  const fp = await currentFingerprint();
  return update(env, (s) => {
    if (!s.credential || (credential && s.credential !== credential)) return { result: null };
    if (s.op?.op === data.op && s.op.fingerprint === fp) return { result: s };
    const k = s.known;
    if (activation && k && k.incarnation === activation.incarnation && k.generation === activation.generation && k.fingerprint === fp) return { result: s };
    return { result: null };
  });
}

async function setupPush(data) {
  const tag = `setup-${data.op}`;
  const show = (title, body) => self.registration.showNotification(title, { body, tag, data: {}, ...ICONS });
  const didntFinish = () => show("This notification setup didn't finish.", 'Open PengePassportPH to see whether notifications are on.');
  let s = await stillOurs(data);
  if (!s) return didntFinish();
  try {
    await show('Setting up notifications…', 'This shows notifications work on this device.');
  } catch {
    return; // The proof is that this browser shows it: no acknowledgement without it.
  }
  const credential = s.credential;
  if (!(await stillOurs(data, credential))) return didntFinish();
  if (!(await storeNonce(env, { op: data.op, credential, fingerprint: s.op.fingerprint, nonce: data.nonce }))) return didntFinish();
  let answer = null;
  for (const wait of [0, 2000, 6000]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (!(await stillOurs(data, credential))) return didntFinish();
    try {
      const r = await api('/ready', credential, { op: data.op, nonce: data.nonce });
      if (r.status === 200 && typeof r.data?.result === 'string') {
        answer = r.data;
        break;
      }
    } catch {
      // No connection: try again, then leave it to the page (the nonce is stored).
    }
  }
  if (!answer) return show("Couldn't confirm the setup yet.", 'Open PengePassportPH to finish.');
  if (!TERMINAL.includes(answer.result)) return didntFinish();
  await recordResult(env, { op: data.op, credential, result: answer.result, activation: answer.activation ?? null });
  if (answer.result === 'active') {
    const mine = await api('/mine', credential, null, 'GET').catch(() => null);
    const a = mine?.data?.state === 'active' ? mine.data.alert : null;
    const act = answer.activation;
    if (!a || !act || a.incarnation !== act.incarnation || a.generation !== act.generation) return didntFinish();
    await show('Notifications are ready', `You'll get a notification like this when dates open at ${typeof data.body === 'string' ? data.body : 'your offices'}.`);
    // After showing it: still this credential, and the activation still the alert the device knows (or the operation).
    if (!(await stillOurs(data, credential, act))) await didntFinish();
    return;
  }
  if (answer.result === 'changed') {
    for (const n of await self.registration.getNotifications({ tag })) n.close();
    return;
  }
  if (answer.result === 'expired') return show('Setting up notifications took too long.', 'Open PengePassportPH to try again.');
  if (answer.result === 'full') return show('Notifications are full right now.', 'Email alerts still work.');
  return didntFinish();
}

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data?.json() ?? null;
  } catch {
    data = null;
  }
  const ok = data?.v === 1;
  if (ok && data.kind === 'setup' && typeof data.op === 'string' && typeof data.nonce === 'string' && env.locks && env.indexedDB) {
    event.waitUntil(setupPush(data).catch(() => self.registration.showNotification("This notification setup didn't finish.", { tag: `setup-${data.op}`, ...ICONS })));
    return;
  }
  // Never silent: a push that shows nothing loses the permission in Chrome.
  const title = ok && typeof data.title === 'string' ? data.title : 'New dates are open';
  const options = {
    body: ok && typeof data.body === 'string' ? data.body : 'Open PengePassportPH to see them.',
    data: ok && data.url && typeof data.url === 'object' ? data.url : null,
    ...ICONS,
  };
  if (ok && typeof data.tag === 'string') options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

// The push service replaced the subscription: a rotation, with this device's credential (no owner token), or a join of
// the one in progress. The page drives it on its next opening; here it is started.
self.addEventListener('pushsubscriptionchange', (event) => {
  if (!env.locks || !env.indexedDB) return;
  event.waitUntil(
    (async () => {
      await setNeedsRotation(env, true);
      let captured = null;
      // At most two tries: the second only after a "changed" answer, against the alert read again.
      for (let attempt = 0; attempt < 2; attempt++) {
        const s = await readState(env);
        if (!s.credential || !s.known) return;
        captured ??= { incarnation: s.known.incarnation, generation: s.known.generation };
        const r = await begin(env, { kind: 'rotate', choices: null, captured, now: Date.now() });
        if (!r.started) return;
        let sub = event.newSubscription ?? (await self.registration.pushManager.getSubscription());
        if (!sub && self.Notification?.permission === 'granted' && s.vapidKey) {
          sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(s.vapidKey) }).catch(() => null);
        }
        if (!sub) return finish(env, { op: r.started.op });
        const json = sub.toJSON();
        const fp = await fingerprint(env, json);
        const by = newId(env);
        const attached = await attach(env, { op: r.started.op, epoch: r.started.epoch, subscription: json, fingerprint: fp, by });
        // A page recovering this rotation attached it first: its stored request stands, and the page sends it.
        if (attached === 'already') return;
        if (attached !== 'ok') {
          // Turned off meanwhile (another epoch): a subscription made for this rotation goes, unless something uses it.
          const claim = await abandon(env, { op: r.started.op, fingerprint: fp, by: null });
          if (claim) {
            const ok = await sub.unsubscribe().catch(() => false);
            await settleClaim(env, { task: claim.task, unsubscribed: ok });
          }
          return;
        }
        // The worker reads its own storage: no handshake; ready at once, unless turned off meanwhile.
        if (!(await confirmReady(env, { op: r.started.op, by }))) return;
        const res = await api('/mine/subscription', r.credential, { op: r.started.op, seq: r.started.seq, subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, captured }).catch(() => null);
        const outcome = res?.data?.outcome;
        if (outcome === 'pending' || outcome === 'done') {
          // Admitted: 'sent', with the deadline on this device's clock (the server's remaining time from now).
          const remaining = res.data.operation?.remainingMs;
          await markSent(env, { op: r.started.op, expiresAt: typeof remaining === 'number' ? Date.now() + remaining : null });
          return;
        }
        // No answer, limited or busy: left ready and unsent; the page sends the same request at its next opening.
        if (!outcome || outcome === 'limited' || outcome === 'busy') return;
        // Refused before anything was stored: a terminal result, kept for the page to show.
        const result = outcome === 'off' ? 'unavailable' : outcome === 'invalid' ? 'failed' : outcome;
        await recordResult(env, { op: r.started.op, credential: r.credential, result, activation: null });
        if (outcome !== 'changed') return;
        // Another rotation or a re-setup won meanwhile: read the alert again and rotate once more against it, if the
        // credential, the epoch and the browser's subscription are as they were, and the winner did not already
        // register this subscription.
        const now = await readState(env);
        const cur = await self.registration.pushManager.getSubscription();
        if (now.credential !== r.credential || now.epoch !== r.started.epoch || !cur || (await fingerprint(env, cur.toJSON())) !== fp) return;
        const mine = await api('/mine', r.credential, null, 'GET').catch(() => null);
        if (mine?.data?.state !== 'active' || mine.data.alert.fingerprint === fp) return;
        captured = { incarnation: mine.data.alert.incarnation, generation: mine.data.alert.generation };
      }
    })().catch(() => undefined),
  );
});
```

The old `swEnv`, the old `message` and `push` handlers, `reconcile` and the `/* __SHARED__ */` placeholder go.

`apps/web/src/notify/worker.ts`: `ask()` resolves `{ deviceAlerts?: number }`, and `readyWorker` returns only when `(await until(ask(active, 1000)))?.deviceAlerts === 1`. In `notify.test.ts`, the fake new workers answer `{ push: true, deviceAlerts: 1 }`.

- [ ] **Step 4: Watch them pass**

Run: `npm test -w @penge/web -- worker pwa notify`
Expected: PASS.

- [ ] **Step 5: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test && npm run build -w @penge/web`
Expected: PASS; `apps/web/dist/sw.js` contains `deviceAlerts: 1` and no `__STATE__`.

Codex pass (prompt: "Adversarial review of the service worker against the spec's ready check step 5 and its outcome table, 'When the subscription changes' and 'Old pages and the shared subscription': the per-step checks under the lock, no acknowledgement without a shown notification, only this operation's notification replaced, the final check after 'ready', rotation from pushsubscriptionchange with no owner token, and the one-time reload on first activation (never again, never deleting its marker). Find a path that acknowledges another operation, leaves a stale 'ready' on screen, or reloads pages on every update."). Then:

```bash
git add apps/web/src/sw.js apps/web/sw-plugin.ts apps/web/src/notify/worker.ts apps/web/test/worker.test.ts apps/web/test/notify.test.ts apps/web/test/pwa.test.ts
git commit -m "The worker's ready check, rotation on a changed subscription, and a one-time reload of old pages"
```

---
### Task 19: Measure the largest footprint on Valkey, and set the limits from it

The spec asks the plan to measure, with maximum valid inputs, the largest footprint of each `pp:dev:` record, and to set `DEVICE_RECORD_LIMIT` so the whole namespace at its limits fits in 25% of `maxmemory` (64 MB in production), and the fan-out chunk so one takes under 50 ms at the ceiling. This task measures on a real Valkey (the CI job and the throwaway container) and pins the numbers.

**Files:**
- Create: `apps/server/test/devices-footprint.test.ts`
- Modify (only if the measurement says so): `apps/server/src/devices/store.ts` (`ALERT_UNITS`), `apps/server/src/config.ts` (defaults), `apps/server/src/devices/queue.ts` (`CHUNK_WORK`)

**Interfaces:**
- Consumes: Tasks 6–12's scripts and record layout; `UNIT_BYTES = 4096` (new, store.ts: the bytes one storage unit stands for).
- Produces: `UNIT_BYTES` exported from `store.ts`; the measured numbers written into this task's Ruling in the ledger.

- [ ] **Step 1: Write the measurement test (Valkey only)**

`apps/server/test/devices-footprint.test.ts`:

```ts
// Measured on a real Valkey: MEMORY USAGE of the largest valid records. Runs only with DEVICE_TEST_VALKEY.
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { ALERT_UNITS, UNIT_BYTES } from '../src/devices/store.ts';
import { CHUNK_WORK } from '../src/devices/queue.ts';
import { fanoutChunk, queueWrite } from '../src/devices/scripts-delivery.ts';
import { choices, seedAlert } from './device-fixtures.ts';
import { valkeyTargets } from './valkey.ts';

const valkey = valkeyTargets().find(([name]) => name === 'Valkey');
const T0 = Date.parse('2026-10-06T02:00:00Z');
const usage = (kv: Awaited<ReturnType<NonNullable<typeof valkey>[1]>>, key: string) =>
  kv.script({ name: 'usage', lua: "#!lua\nreturn tostring(redis.call('MEMORY', 'USAGE', KEYS[1], 'SAMPLES', '0') or 0)" }, [key], []).then(Number);

describe.skipIf(!valkey)('the largest footprint, measured', () => {
  it('fits an alert with its largest delivery state and end record in ALERT_UNITS units', async () => {
    const kv = await valkey![1]();
    const longEndpoint = { endpoint: `https://fcm.googleapis.com/fcm/send/${'x'.repeat(1024 - 36)}`, p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) };
    const offices = Array.from({ length: 10 }, (_, i) => 1_000_000_000 + i);
    const a = await seedAlert(kv, { now: T0, choices: choices({ siteIds: offices, applicants: 5, pace: 'hourly' }), sub: longEndpoint as never });
    const inc = (await kv.hGetAll(K.devAlert(a.id))).inc!;
    const stamps = Array.from({ length: 30 }, (_, i) => ({ wall: T0 + i, up: 123456789.123 + i, boot: '0f8fad5b-d9cb-469f-a165-70867728950e' }));
    const job = JSON.stringify({ i: a.id, n: inc, s: stamps, d: stamps.map((_, i) => [offices[i % 10], `2026-11-${String(i + 1).padStart(2, '0')}`, 5, i]) });
    expect(job.length).toBeLessThanOrEqual(4096);
    await kv.write([
      { op: 'hSet', key: K.devQueue, fields: { [a.id]: job } },
      { op: 'set', key: K.devHeld(a.id), value: job },
      { op: 'hSet', key: K.devClaim(a.id), fields: { cid: 'c'.repeat(22), run: 'r'.repeat(20), inc, gen: '999', rev: '999', day: '2026-10-06', prev: JSON.stringify(stamps[0]), at: JSON.stringify(stamps[1]), state: 'sending', job, checked: String(T0) } },
      { op: 'set', key: K.devLast(a.id), value: JSON.stringify(stamps[0]) },
      { op: 'set', key: K.devToday(a.id, '2026-10-06'), value: '288' },
      { op: 'hSet', key: K.devTried(a.id), fields: Object.fromEntries([['run', 'r'.repeat(20)], ...stamps.map((_, i) => [`${offices[i % 10]}|2026-11-${String(i + 1).padStart(2, '0')}|5`, '2'])]) },
      { op: 'hSet', key: K.devEnded(a.hash), fields: { reason: 'gone', at: String(T0), fp: 'f'.repeat(43) } },
    ]);
    let bytes = 0;
    for (const key of [K.devAlert(a.id), K.devHeld(a.id), K.devClaim(a.id), K.devLast(a.id), K.devToday(a.id, '2026-10-06'), K.devTried(a.id), K.devEnded(a.hash), K.devCred(a.hash), K.devEndpoint(a.ep)]) bytes += await usage(kv, key);
    // The queue entry, the index members and sorted-set entries: measured as the hash's growth for one field, plus a margin.
    bytes += job.length + 64 * (offices.length + 4);
    console.log(JSON.stringify({ alertBytes: bytes, unit: UNIT_BYTES, units: ALERT_UNITS }));
    expect(bytes).toBeLessThanOrEqual(ALERT_UNITS * UNIT_BYTES);
  });

  it('fits an operation record in one unit', async () => {
    const kv = await valkey![1]();
    const key = K.devOp('h'.repeat(43));
    const sealed = `v2.${'s'.repeat(2400)}`; // the sealed subscription (1,024-character endpoint), choices and nonce
    await kv.write([{ op: 'hSet', key, fields: { op: 'o'.repeat(22), seq: '9999999', maxseq: '9999999', kind: 'rotate', digest: 'd'.repeat(43), cap: JSON.stringify({ incarnation: 'i'.repeat(22), generation: 999, revision: 999 }), alert: 'a'.repeat(22), rsv: 'repl', other: 'b'.repeat(22), exp: String(T0), dsp: 'retryable', did: 'x'.repeat(22), dspAt: String(T0), retry: String(T0), why: 'backoff', result: '', act: JSON.stringify({ alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 999, revision: 999 }), done: String(T0), sealed, nh: 'n'.repeat(43), ep: 'e'.repeat(43), fp: 'f'.repeat(43), svc: 'mozilla', tok: 't'.repeat(43), acks: '10', started: String(T0) } }]);
    const bytes = (await usage(kv, key)) + 128; // its sorted-set entries
    console.log(JSON.stringify({ opBytes: bytes }));
    expect(bytes).toBeLessThanOrEqual(UNIT_BYTES);
  });

  it("keeps the namespace at its ceilings, with the limiter's worst case, within 25% of 64 MB", async () => {
    const kv = await valkey![1]();
    const { loadConfig } = await import('../src/config.ts');
    const { DEVICE_LIMITS, rateKeys } = await import('../src/devices/limits.ts');
    const b64 = () => Buffer.alloc(32, 1).toString('base64');
    // The configuration's ceilings (DEVICE_ALERT_LIMIT and DEVICE_RECORD_LIMIT cannot be set higher).
    const c = loadConfig({ REDIS_URL: 'redis://localhost:6379', EMAIL_ENC_KEY: b64(), EMAIL_HMAC_KEY: b64(), TOKEN_SECRET: b64() });
    // One rate counter, measured: the longest bucket name with a 43-character id.
    const sample = rateKeys(DEVICE_LIMITS.pendingReadCred, 'h'.repeat(43), T0).cur;
    await kv.set(sample, '240', { ttlSeconds: 7200 });
    const counterBytes = (await usage(kv, sample)) + 16; // and its expiry entry
    // Counters the gates allow, each living at most two windows: per network, keyed by the 4,096 ingress buckets (the
    // ingress gate and 8 classes); per credential, only for credentials holding a record (3 classes); per endpoint, only
    // for stored setups (at most 100 an hour); per alert (maintenance and tests); and the global pools.
    const perNetwork = 9 * 4096;
    const perCredential = 3 * (c.devices.alertLimit + c.devices.recordLimit);
    const perEndpoint = DEVICE_LIMITS.storedSetupAll.max;
    const perAlert = 2 * c.devices.alertLimit;
    const global = 13;
    const limiterBytes = 2 * (perNetwork + perCredential + perEndpoint + perAlert + global) * counterBytes;
    const fanoutBytes = 5 * 2000 * 64 + 5 * 4096;
    const total = c.devices.recordLimit * UNIT_BYTES + fanoutBytes + limiterBytes;
    console.log(JSON.stringify({ counterBytes, limiterBytes, recordBytes: c.devices.recordLimit * UNIT_BYTES, fanoutBytes, total, budget: 0.25 * 64 * 1024 * 1024 }));
    expect(total).toBeLessThanOrEqual(0.25 * 64 * 1024 * 1024);
  });

  it('at its memory limit: refuses scripts that grow storage before they start, writing nothing; reclamation still runs', async () => {
    const kv = await valkey![1]();
    const { createClient } = await import('@redis/client');
    const admin = createClient({ url: process.env.DEVICE_TEST_VALKEY });
    await admin.connect();
    try {
      const a = await seedAlert(kv, { now: T0, end: T0 - 1 });
      const used = Number(/used_memory:(\d+)/.exec(await admin.info('memory'))![1]);
      await admin.configSet('maxmemory', String(used - 1024));
      const { admit, reclaim, turnOff } = await import('../src/devices/scripts-api.ts');
      const before = await kv.hGetAll(K.devRecords);
      await expect(admit(kv, { now: T0, cred: 'h'.repeat(43), op: 'o'.repeat(22), seq: 1, kind: 'setup', cap: false, digest: 'd', ep: 'e', fp: 'f', svc: 'fcm', sealed: 'v2.x', nh: 'n', tok: '', exp: T0 + 1, stored: [], alertLimit: 10, recordLimit: 100 })).rejects.toThrow(/OOM/);
      expect(await kv.hGetAll(K.devRecords)).toEqual(before);
      expect((await reclaim(kv, T0)).ended).toBe(1); // allow-oom: runs over the limit, and frees the alert
      await turnOff(kv, { now: T0, cred: a.hash });
    } finally {
      await admin.configSet('maxmemory', '64mb');
      await admin.close();
    }
  });

  it('writes a fan-out chunk at the alert ceiling in under 50 ms', async () => {
    const kv = await valkey![1]();
    await kv.set(K.checkLock, 'r1');
    for (let i = 0; i < 500; i++) await seedAlert(kv, { now: T0, order: 0, choices: choices({ siteIds: [486] }) });
    await queueWrite(kv, { now: T0, run: 'r1', mark: 'measure', ops: [], batch: { id: 'b1', entries: Array.from({ length: 100 }, (_, i) => `486|2026-11-${String((i % 28) + 1).padStart(2, '0')}|1|0`), stamps: [{ wall: T0 }] } });
    const started = performance.now();
    await fanoutChunk(kv, { now: T0, run: 'r1', maxEntries: 100, maxWork: CHUNK_WORK });
    const ms = performance.now() - started;
    console.log(JSON.stringify({ chunkMs: ms, work: CHUNK_WORK }));
    expect(ms).toBeLessThan(50);
  });
});
```

`apps/server/src/devices/store.ts` gains:

```ts
/** The bytes one storage unit stands for: measured (devices-footprint.test.ts) with the largest valid records. */
export const UNIT_BYTES = 4096;
```

- [ ] **Step 2: Run it on the throwaway Valkey**

Run: `DEVICE_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- devices-footprint`
Expected: PASS, printing `alertBytes`, `opBytes`, the namespace total and `chunkMs`. If `alertBytes` exceeds `5 × 4096`, raise `ALERT_UNITS` (and Task 2's check `recordLimit >= alertLimit * ALERT_UNITS` with it); if the total exceeds the budget, lower the ceilings in `config.ts` (`DEVICE_ALERT_LIMIT` and `DEVICE_RECORD_LIMIT` are both default and maximum) until it fits; if `chunkMs ≥ 50`, halve `CHUNK_WORK` until it passes (a chunk now stops at exactly `CHUNK_WORK` recipients, even inside one entry). Record the measured numbers in the ledger as a Ruling.

- [ ] **Step 3: Full suite, Codex, commit**

Run: `npm test && npm run typecheck` (and the Valkey run above)
Expected: PASS.

Codex pass (prompt: "Review the footprint measurement: are these the largest valid inputs for each record (endpoint length, offices, job size, claim, tries, end record, operation), is anything stored per alert or per credential left out, and do the limits keep the pp:dev namespace within 25% of 64 MB including fan-out batches and indexes?"). Then:

```bash
git add apps/server/test/devices-footprint.test.ts apps/server/src/devices/store.ts apps/server/src/config.ts apps/server/src/devices/queue.ts
git commit -m "Measure the largest notification footprint on Valkey and pin the limits to it"
```

---
### Task 20: The local stack, the verification harness, the old pages against the new server, and the layout audit

**Files:**
- Modify: `apps/server/dev/local.ts` (notifications on), `apps/server/test/local-stack.test.ts`, `docs/superpowers/verification/harness/lib.mjs` (with the web-server swap helpers moved from `old-worker.mjs`), `docs/superpowers/verification/harness/old-worker.mjs` (imports them), `docs/superpowers/verification/harness/audit.mjs`, `docs/superpowers/verification/harness/cross.mjs`
- Create: `docs/superpowers/verification/harness/device-flow.mjs`, `docs/superpowers/verification/harness/old-pages.mjs`
- Delete: `docs/superpowers/verification/harness/push-flow.mjs` (the channel design's flow)

**Interfaces:**
- Consumes: everything above.
- Produces: `node device-flow.mjs chrome|firefox` and `node old-pages.mjs` print `PASS`/`FAIL` lines and write `docs/superpowers/verification/results/<name>.json`; `audit.mjs` covers the new form and every row state at 320, 360, 390, 768 and 1280 px.

- [ ] **Step 1: The local stack with notifications on**

`apps/server/dev/local.ts`:

```ts
import { webPushTransport } from '../src/devices/transport.ts';
…
  const push: PushConfig = { mode: 'live', vapid, ownerToken: null };
  const transport = webPushTransport(vapid);
  const app = createApi({
    kv, keys, mailer, log, publicBaseUrl: BASE, push, lookups, pushTransport: transport,
    devices: { alertLimit: 50, recordLimit: 350 },
    // The pages the local stack serves: vite preview over http, the https proxy, and the phone's view of that proxy
    // (PENGE_PHONE_ORIGIN, e.g. https://192.168.1.20:8443, set only when testing on a phone; never in production).
    devOrigins: ['http://localhost:4173', 'https://localhost:8443', ...(process.env.PENGE_PHONE_ORIGIN ? [process.env.PENGE_PHONE_ORIGIN] : [])],
    ...(o.kvUrl ? {} : { clientIp: () => '127.0.0.1' }),
  });
  const deps: CheckDeps = {
    kv, upstream, sink: noSink, mailer, keys, log, publicBaseUrl: BASE,
    mailDailyLimit: 2500, alertsPerSubscriberPerDay: 288, client: 'penge-local',
    devices: { mode: 'live', transport }, deviceLimits: { alertLimit: 50, recordLimit: 350 },
  };
```

Two more local-only routes on `devApp` (never in the production API): `POST /dev/mail-fail` and `POST /dev/mail-ok`, which set and clear a `refuseNext` flag on `CaptureMailer` (`apps/server/dev/capture-mailer.ts` gains it: while set, `send` throws an error `wasRefused()` recognises, as the real mailer does when the mail server refuses). The harness uses them for "both kinds, one failing".

`MemoryKv` (when `kvUrl` is null, the in-process tests) needs the Lua engine: `buildLocal` calls `installLua()` from `./lua-engine.ts` before creating it. `apps/server/dev/build.mjs` bundles `lua-engine.ts` with `wasmoon` external (`external: ['wasmoon']`), since the local stack runs from the repository where `wasmoon` is installed.

`apps/server/test/local-stack.test.ts`, a new case:

```ts
  it('serves the device routes to its own pages\' origin, and refuses others', async () => {
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    const call = (origin: string) => stack.app.request('/api/device-alerts', { method: 'POST', headers: { 'content-type': 'application/json', origin, authorization: `Device ${'c'.repeat(43)}` }, body: '{}' });
    expect((await call('http://localhost:4173')).status).toBe(400); // past the origin check, refused for its body
    expect((await call('https://evil.example')).status).toBe(403);
    await stack.close();
  });
```

Run: `npm test -w @penge/server -- local-stack`
Expected: PASS.

- [ ] **Step 2: The harness helpers**

`docs/superpowers/verification/harness/lib.mjs`:
- `openSheet(page)` clicks `Alerts` (not "Email alerts");
- `pushSwitch(page)` finds the switch named `Browser notifications` or `Notifications on this device`; `emailSwitch(page)` the one named `Email`;
- `send(page, email)` switches Email on first if it is off, then types the address, and presses whichever of the three button texts shows, and returns: it no longer waits for "Check your inbox" (a caller that expects the email waits for it, and for the captured mail, itself);
- new `pickOffice(page)`: in the open sheet, picks Antipolo if nothing is chosen;
- new `notifyOnly(page)`: opens the sheet, `pickOffice`, sets the pace to "As soon as a check finds dates", turns notifications on (waiting for `aria-checked="true"`), presses `Turn on notifications`, and waits for `Notifications are on for this device.` (60 s);
- `signUpAndConfirm` keeps its email path and loses its channel arguments;
- new `rowText(page)`: the `.device-row` text or `null`.

- [ ] **Step 3: The device flow, in both browsers**

`docs/superpowers/verification/harness/device-flow.mjs`:

```js
// node device-flow.mjs chrome|firefox — a notification alert on the Mac, end to end, against the local stack.
import { mkdirSync, writeFileSync } from 'node:fs';
import { clickText, devOpen, emailSwitch, IMG, launch, linkIn, mailMark, notifyOnly, openSheet, ORIGIN, pickOffice, publishedDay, pushSwitch, REPO, resetRateLimits, rowText, scan, send, shot, shown, sleep, SITE, valkey, waitMail, waitText, workerReady } from './lib.mjs';

const kind = process.argv[2];
const results = [];
const record = (item, pass, note = '') => {
  results.push({ item, pass, note });
  console.log(pass ? 'PASS' : 'FAIL', item, note);
};
mkdirSync(IMG, { recursive: true });
resetRateLimits();
const browser = await launch(kind, { prefs: { 'permissions.default.desktop-notification': 1 } });
if (kind === 'chrome') await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
const page = await browser.newPage();
// What the store held before this browser's flow: another browser's run (or case 7, which leaves a confirmed email
// subscriber for the rollback rehearsal) may have left email subscribers; notifications must never add or change one.
const subsBefore = scan('pp:sub:*').sort().join(',');
const credsBefore = scan('pp:dev:cred:*').length;
try {
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await workerReady(page);
  // 1. Notifications only: no email asked, the ready check, the row.
  await notifyOnly(page);
  await shot(page, `${kind}-device-on`);
  const setup = (await shown(page)).filter((n) => n.tag?.startsWith('setup-'));
  record('The ready check showed its notification', setup.some((n) => n.title === 'Notifications are ready'), JSON.stringify(setup.map((n) => n.title)));
  record('No email was asked for', !(await page.$('input[type="email"]')));
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  const row = await rowText(page);
  record('The row says what is on and until when', /^Notifications on this device: Antipolo · for 1 person · as soon as possible · until \d+ \w{3} \d{4}/.test(row ?? ''), row ?? '');
  record('The server holds no email for it', scan('pp:sub:*').sort().join(',') === subsBefore && scan('pp:dev:cred:*').length === credsBefore + 1);
  // 2. A real alert.
  const day = publishedDay(4);
  await devOpen(486, day);
  await sleep(3000);
  const alert = (await shown(page)).find((n) => n.tag?.startsWith('alert-'));
  record('An opening arrives as a notification, with when it was checked', !!alert && alert.title === 'Dates open at Antipolo' && / · Checked \d\d:\d\d$/.test(alert.body), JSON.stringify(alert ?? null));
  // 3. Change, test.
  await clickText(page, '.device-row button', 'Change');
  await page.waitForSelector('[role="dialog"]');
  record('Change has no switches and no email field', (await page.$$('[role="dialog"] [role="switch"]')).length === 0 && !(await page.$('[role="dialog"] input[type="email"]')));
  await page.select('select[id$="-applicants"]', '2');
  await clickText(page, 'button[type="submit"]', 'Save');
  await waitText(page, 'Saved.');
  await page.keyboard.press('Escape');
  await clickText(page, '.device-row button', 'Send a test');
  await waitText(page, 'Accepted by the push service. Check this device.');
  await sleep(2000);
  record('The test notification arrived', (await shown(page)).some((n) => n.title === 'Test notification'));
  // 4. Turn off, online.
  await clickText(page, '.device-row button', 'Turn off');
  await sleep(1500);
  record('Turned off: nothing left on the server', scan('pp:dev:cred:*').length === 0 && scan('pp:dev:op:*').length === 0);
  record('Turned off: the browser has no subscription', await page.evaluate(async () => !(await (await navigator.serviceWorker.ready).pushManager.getSubscription())));
  // 5. Turn off offline, then back online.
  await notifyOnly(page);
  await page.setOfflineMode?.(true);
  await clickText(page, '.device-row button', 'Turn off');
  await waitText(page, "Deleting them from our server when you're back online.");
  await shot(page, `${kind}-device-off-pending`);
  await page.setOfflineMode?.(false);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);
  record('Back online: the deletion went through', scan('pp:dev:cred:*').length === 0, await rowText(page) ?? '');
  // 6. Ended (the server's clock moved): the row says so.
  await notifyOnly(page);
  const id = valkey('--scan', '--pattern', 'pp:dev:cred:*').split('\n')[0];
  const alertId = valkey('GET', id);
  valkey('HSET', `pp:dev:${alertId}`, 'end', String(Date.now() - 1000));
  valkey('ZADD', 'pp:dev:ends', String(Date.now() - 1000), alertId);
  await page.reload({ waitUntil: 'networkidle0' });
  await waitText(page, 'Turn them on again to keep getting them.');
  await shot(page, `${kind}-device-ended`);
  record('An ended alert says so, with its date', /ended on \d+ \w{3} \d{4}/.test((await rowText(page)) ?? ''));
  const checked = (el) => el.evaluate((e) => e.getAttribute('aria-checked') === 'true');
  const dev = (path) => fetch(`http://127.0.0.1:8787/dev/${path}`, { method: 'POST' });
  // 7. Both kinds, one failing: the mail server refuses; notifications still turn on, and only email offers a retry.
  resetRateLimits();
  await dev('mail-fail');
  await openSheet(page);
  await pickOffice(page);
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 10_000 }, await pushSwitch(page));
  const both = `both-${Date.now()}@example.com`;
  await send(page, both);
  // Each kind's result on its own: notifications on, and email's failure with its retry.
  await waitText(page, 'Notifications are on for this device.', 60_000);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Try email again'), { timeout: 30_000 });
  const retries = await page.$$eval('[role="dialog"] button', (bs) => bs.map((b) => b.textContent));
  record('Both on, email refused: notifications on, and a retry for email only', retries.includes('Try email again') && !retries.includes('Try notifications again'), JSON.stringify(retries));
  await dev('mail-ok');
  const mark = mailMark();
  await clickText(page, '[role="dialog"] button', 'Try email again');
  await waitText(page, 'Check your inbox for a link to start email alerts.');
  const confirmMail = await waitMail(mark, 'confirm', both).catch(() => null);
  record('Email again, after the mail server is back: a confirmation email with its link was sent', !!confirmMail && linkIn(confirmMail.text, '/confirm').includes('/confirm'), confirmMail ? 'captured' : 'no mail');
  // Confirmed, so a real email subscriber follows Antipolo (the rollback rehearsal, Step 6, emails it).
  await page.keyboard.press('Escape');
  await page.goto(linkIn(confirmMail.text, '/confirm'), { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Confirm email alert');
  await waitText(page, 'We will email you');
  writeFileSync(`${REPO}/.local/email-subscriber.txt`, both); // for Step 6
  record('The email alert is confirmed', true, both);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  // 8. Delete this device's data.
  await page.goto(`${SITE}delete-data`, { waitUntil: 'networkidle0' });
  await clickText(page, 'button', 'Turn off notifications on this device');
  await sleep(1500);
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  record("Delete this device's data: nothing left on the server, and no row", scan('pp:dev:cred:*').length === 0 && (await rowText(page)) === null, (await rowText(page)) ?? '');
  // 9. Dismissed: the prompt answers 'default' (as a dismissed prompt does); the switch stays off, no hint, Email untouched.
  const dismissed = await browser.newPage();
  await dismissed.evaluateOnNewDocument(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    Notification.requestPermission = async () => 'default';
  });
  await dismissed.goto(SITE, { waitUntil: 'networkidle0' });
  await openSheet(dismissed);
  await (await pushSwitch(dismissed)).evaluate((e) => e.click());
  await sleep(1000);
  const dismissedText = await dismissed.$eval('[role="dialog"]', (d) => d.textContent ?? '');
  record('Dismissed: the switch stays off, no hint, Email untouched', !(await checked(await pushSwitch(dismissed))) && !(await checked(await emailSwitch(dismissed))) && !/blocked for this site/.test(dismissedText));
  await dismissed.close();
  // 10. Denied: a profile where notifications are denied; the switch stays off, with the hint.
  const deniedBrowser = kind === 'firefox' ? await launch(kind, { prefs: { 'permissions.default.desktop-notification': 2 } }) : null;
  const deniedCtx = deniedBrowser ? deniedBrowser.defaultBrowserContext() : await (browser.createBrowserContext?.() ?? browser.createIncognitoBrowserContext());
  if (!deniedBrowser) await deniedCtx.overridePermissions(ORIGIN, []); // every permission not listed is denied
  const denied = await deniedCtx.newPage();
  await denied.goto(SITE, { waitUntil: 'networkidle0' });
  await openSheet(denied);
  await (await pushSwitch(denied)).evaluate((e) => e.click());
  await sleep(1000);
  const deniedText = await denied.$eval('[role="dialog"]', (d) => d.textContent ?? '');
  record('Denied: the switch stays off, with the "blocked for this site" hint', !(await checked(await pushSwitch(denied))) && /blocked for this site/.test(deniedText), deniedText.slice(0, 200));
  await (deniedBrowser ?? deniedCtx).close();
  // 11. Blocked while an alert is on (Chrome: Puppeteer can change a granted permission only there): turned off, and said.
  if (kind === 'chrome') {
    resetRateLimits();
    await notifyOnly(page);
    await browser.defaultBrowserContext().clearPermissionOverrides();
    await browser.defaultBrowserContext().overridePermissions(ORIGIN, []);
    await page.reload({ waitUntil: 'networkidle0' });
    await waitText(page, 'Notifications are blocked on this device, so we turned them off.');
    await sleep(1500);
    record('Blocked while on: the row says it was turned off, and the server holds nothing', scan('pp:dev:cred:*').length === 0);
  }
} catch (err) {
  record('The flow ran to the end', false, String(err));
} finally {
  writeFileSync(`${REPO}/docs/superpowers/verification/results/device-flow-${kind}.json`, JSON.stringify({ browser: await browser.version(), results }, null, 2));
  await browser.close();
}
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
```

Cases 7–11 use the local-only `/dev/mail-fail` and `/dev/mail-ok` routes (Step 1) and a new `lib.mjs` helper, `pickOffice(page)`, factored out of `notifyOnly` (it picks Antipolo in the open sheet if nothing is chosen). The tap on an operating-system notification cannot be clicked from Puppeteer: it is covered by `worker.test.ts` (`notificationclick` opens the office with date and group) and on the phone (Task 23).

- [ ] **Step 4: The old pages against the new server**

`docs/superpowers/verification/harness/old-pages.mjs` builds the web app of `05cee09` and of `157bad9` from their commits in throwaway worktrees and serves each on its own port through Vite's preview, with `/api` proxied to the running local stack:

```js
// node old-pages.mjs — pages of the channel release and of the release before push, open in a browser after the
// deploy, against the new server: email works as it did; anything about notifications says to reload.
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { clickText, gone, lastMail, launch, linkIn, notifyOnly, ORIGIN, REPO, resetRateLimits, serveWeb, SITE, sleep, stopWeb, waitText, workerReady } from './lib.mjs';

// Any P-256 key binds a subscription (as the old page's own key did); the last 65 bytes of its SPKI form are the point.
const ANY_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).subarray(-65).toString('base64url');
const hasSub = (p) => p.evaluate(async () => !!(await (await navigator.serviceWorker.ready).pushManager.getSubscription()));
/** A subscription in the page's registration, if it has none. */
const subscribeAny = (p) =>
  p.evaluate(async (k) => {
    const reg = await navigator.serviceWorker.ready;
    const raw = Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    if (!(await reg.pushManager.getSubscription())) await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
  }, ANY_KEY);
/** The 05cee09 database's state ('pengepassportph-push', store 'state', key 'device'), as that release wrote it. */
const putOldState = (p, state) =>
  p.evaluate(
    (k, st) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('pengepassportph-push', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('state');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('state', 'readwrite');
          tx.objectStore('state').put({ credential: 'c'.repeat(43), revision: 1, fingerprint: null, applicationServerKey: k, ...st }, 'device');
          tx.oncomplete = () => (req.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    ANY_KEY,
    state,
  );
/**
 * Answers the old page's POST /api/push/device with "missing" (what the new server's answer means to it); counts them.
 * With `hold`, the answers wait until `release()`: the old page's reconcile stays suspended mid-call, as a frozen tab's.
 */
async function answerMissing(p, o = {}) {
  const held = [];
  const asked = { count: 0, release: () => held.splice(0).forEach((f) => f()) };
  const answer = (req) => void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'missing' }) });
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/push/device')) {
      asked.count++;
      if (o.hold) return void held.push(() => answer(req));
      return answer(req);
    }
    return void req.continue();
  });
  return asked;
}
/** Waits for the old page to be asked, then for its subscription to be (or stay) `want`. */
async function settleSub(p, asked, want) {
  for (let i = 0; i < 40 && asked.count === 0; i++) await sleep(250);
  let has = await hasSub(p);
  for (let i = 0; i < 20 && has !== want; i++) {
    await sleep(250);
    has = await hasSub(p);
  }
  if (want) {
    await sleep(1500); // and still kept a moment later
    has = await hasSub(p);
  }
  return has;
}

const results = [];
const record = (item, pass, note = '') => (results.push({ item, pass, note }), console.log(pass ? 'PASS' : 'FAIL', item, note));
resetRateLimits();
function serve(commit, port) {
  const dir = `/tmp/penge-old-${commit}`;
  if (!existsSync(dir)) execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', dir, commit], { stdio: 'inherit' });
  execFileSync('npm', ['ci'], { cwd: dir, stdio: 'inherit' });
  // The same BASE_PATH for the build and the preview: vite.config.ts derives the /api proxy's path from it.
  const env = { ...process.env, BASE_PATH: 'pengepassportph' };
  execFileSync('npm', ['run', 'build', '-w', '@penge/web'], { cwd: dir, stdio: 'inherit', env });
  return spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: `${dir}/apps/web`, stdio: 'ignore', env });
}
const servers = [serve('05cee09', 4174), serve('157bad9', 4175)];
// Ready when each preview serves the page and proxies the API.
for (const port of [4174, 4175]) {
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://localhost:${port}/pengepassportph/api/status`).then((r) => r.ok, () => false);
    if (ok) break;
    if (i === 59) throw new Error(`preview on ${port} did not come up`);
    await sleep(500);
  }
}
const browser = await launch('chrome');
try {
  for (const [commit, port] of [['05cee09', 4174], ['157bad9', 4175]]) {
    const page = await browser.newPage();
    const site = `http://localhost:${port}/pengepassportph/`;
    const email = `old-${commit}-${Date.now()}@example.com`;
    await page.goto(site, { waitUntil: 'networkidle0' });
    await clickText(page, 'button', 'Email alerts');
    await page.type('input[type="search"]', 'Antipolo');
    await page.click('.pick input[type="checkbox"]');
    await page.type('input[type="email"]', email);
    await clickText(page, 'button[type="submit"]', 'Send confirmation email');
    await waitText(page, 'Check your inbox');
    const link = linkIn(lastMail('confirm', email).text, '/confirm').replace(/localhost:\d+/, `localhost:${port}`);
    await page.goto(link, { waitUntil: 'networkidle0' });
    await clickText(page, 'button', commit === '05cee09' ? 'Confirm alert' : 'Confirm email alert');
    await waitText(page, 'We will email you');
    record(`A ${commit} page signs up and confirms an email alert`, true);
    await page.close();
  }
  // A 05cee09 page asking for notifications (owner link in the old way) is told to reload, and nothing is written.
  const page = await browser.newPage();
  await page.goto('http://localhost:4174/pengepassportph/?push=owner', { waitUntil: 'networkidle0' });
  const r = await page.evaluate(() =>
    fetch('/pengepassportph/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: null } }) }).then(async (res) => ({ status: res.status, body: await res.json() })),
  );
  record('A 05cee09 page asking for notifications is told to reload', r.status === 409 && r.body.error === 'This page is out of date. Reload it.', JSON.stringify(r));
  await page.close();

  // ---- The 05cee09 page's own reconcile, told "missing" (spec: the old page's 48-hour protection). ----
  // On its preview origin: it drops the subscription when its state was confirmed or asked over 48 hours ago, and keeps
  // it when asked under 48 hours ago.
  const OLD_ORIGIN = 'http://localhost:4174';
  await browser.defaultBrowserContext().overridePermissions(OLD_ORIGIN, ['notifications']);
  const cases = [
    { name: 'confirmed', state: { confirmed: true, askedAt: null }, kept: false },
    { name: 'unconfirmed, asked 49 hours ago', state: { confirmed: false, askedAt: Date.now() - 49 * 3_600_000 }, kept: false },
    { name: 'unconfirmed, asked 1 hour ago', state: { confirmed: false, askedAt: Date.now() - 3_600_000 }, kept: true },
  ];
  for (const c of cases) {
    const old = await browser.newPage();
    const asked = await answerMissing(old);
    await old.goto(`${OLD_ORIGIN}/pengepassportph/`, { waitUntil: 'networkidle0' });
    await subscribeAny(old);
    await putOldState(old, c.state);
    const before = await hasSub(old);
    await old.evaluate(() => window.dispatchEvent(new Event('focus'))); // resumed: the old row reconciles on focus
    const after = await settleSub(old, asked, c.kept);
    record(`A resumed 05cee09 page, ${c.name}, told "missing": ${c.kept ? 'keeps' : 'drops'} its subscription`, before && asked.count > 0 && after === c.kept, JSON.stringify({ before, asked: asked.count, after }));
    await old.evaluate(async () => {
      await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
      await new Promise((r) => {
        const d = indexedDB.deleteDatabase('pengepassportph-push');
        d.onsuccess = d.onerror = d.onblocked = r;
      });
    });
    await old.close();
  }

  // ---- One origin (spec: "Old pages and the shared subscription"): today's worker, a new alert, and an old page. ----
  // The 05cee09 page is served beside today's build on the local stack's own origin, so it shares today's worker and the
  // new alert's subscription. Today's worker fetches navigations from the network first, so /old-05cee09.html is the
  // old page, and its hashed assets load beside today's.
  const OLD_DIST = '/tmp/penge-old-05cee09/apps/web/dist';
  const NEW_DIST = `${REPO}/apps/web/dist`;
  const newSw = readFileSync(`${NEW_DIST}/sw.js`, 'utf8');
  const oldSw = readFileSync(`${OLD_DIST}/sw.js`, 'utf8');
  const newMain = /assets\/index-[\w-]+\.js/.exec(readFileSync(`${NEW_DIST}/index.html`, 'utf8'))?.[0] ?? 'missing';
  const added = [];
  try {
    for (const f of readdirSync(`${OLD_DIST}/assets`)) {
      if (existsSync(`${NEW_DIST}/assets/${f}`)) continue;
      copyFileSync(`${OLD_DIST}/assets/${f}`, `${NEW_DIST}/assets/${f}`);
      added.push(`${NEW_DIST}/assets/${f}`);
    }
    copyFileSync(`${OLD_DIST}/index.html`, `${NEW_DIST}/old-05cee09.html`);
    added.push(`${NEW_DIST}/old-05cee09.html`);
    await gone(stopWeb());
    await serveWeb(`${REPO}/apps/web`, (t) => t === newSw);
    await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['notifications']);
    // A frozen 05cee09 tab resumes after today's page retired its credential and set up a new alert (subscription B):
    // - frozen after reading its state but before reading its subscription, it reads B, is told "missing" and, unless
    //   its 48-hour protection holds, unsubscribes B: the spec's remaining case (the alert ends as gone);
    // - frozen with its request in flight, it holds the subscription it read before (A, which retirement replaced):
    //   its unsubscribe touches only A, and B stays.
    const variants = [
      { name: 'confirmed, frozen before reading its subscription', state: { confirmed: true, askedAt: null }, freeze: 'subscription', removes: true },
      { name: 'unconfirmed, asked 49 hours ago, frozen before reading its subscription', state: { confirmed: false, askedAt: Date.now() - 49 * 3_600_000 }, freeze: 'subscription', removes: true },
      { name: 'unconfirmed, asked 1 hour ago, frozen before reading its subscription', state: { confirmed: false, askedAt: Date.now() - 3_600_000 }, freeze: 'subscription', removes: false },
      { name: 'confirmed, frozen with its request in flight', state: { confirmed: true, askedAt: null }, freeze: 'request', removes: false },
    ];
    const endpointOf = (p) => p.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null);
    for (const c of variants) {
      resetRateLimits();
      const old = await browser.newPage();
      const asked = await answerMissing(old, { hold: c.freeze === 'request' });
      await old.goto(`${SITE}old-05cee09.html`, { waitUntil: 'networkidle0' });
      await subscribeAny(old);
      const a = await endpointOf(old);
      await putOldState(old, c.state);
      if (c.freeze === 'subscription') {
        // Frozen at its first subscription read: the old reconcile (which has read its state) waits here.
        await old.evaluate(() => {
          const orig = PushManager.prototype.getSubscription;
          const gate = new Promise((r) => (window.__thaw = r));
          let first = true;
          PushManager.prototype.getSubscription = function (...args) {
            if (!first) return orig.apply(this, args);
            first = false;
            window.__frozen = true;
            return gate.then(() => orig.apply(this, args));
          };
        });
      }
      await old.evaluate(() => window.dispatchEvent(new Event('focus')));
      if (c.freeze === 'subscription') await old.waitForFunction(() => window.__frozen === true, { timeout: 10_000 });
      else for (let i = 0; i < 40 && asked.count === 0; i++) await sleep(250);
      const frozenAsked = asked.count;
      // Meanwhile today's page opens: it retires the old credential (A goes) and sets up a new alert (B).
      const fresh = await browser.newPage();
      await fresh.goto(SITE, { waitUntil: 'networkidle0' });
      await workerReady(fresh);
      await notifyOnly(fresh);
      const b = await endpointOf(fresh);
      const credential = await fresh.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open('pengepassportph-device-alerts', 1);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const get = req.result.transaction('state').objectStore('state').get('device');
              get.onsuccess = () => (req.result.close(), resolve(get.result?.credential ?? null));
            };
          }),
      );
      // Closed: no page of today's build reconciles (and rotates) between the old tab's step and the next send.
      await fresh.close();
      // The old tab resumes.
      if (c.freeze === 'subscription') await old.evaluate(() => window.__thaw());
      else asked.release();
      for (let i = 0; i < 40 && asked.count === 0; i++) await sleep(250);
      await sleep(1500);
      const after = await endpointOf(old);
      const frozenOk = c.freeze === 'subscription' ? frozenAsked === 0 : frozenAsked > 0;
      record(
        `One origin, a frozen 05cee09 tab (${c.name}) resumed with "missing": ${c.removes ? 'removes' : 'leaves'} the new alert's subscription`,
        frozenOk && !!a && !!b && a !== b && asked.count > 0 && (c.removes ? after === null : after === b),
        JSON.stringify({ frozenOk, replaced: a !== b, asked: asked.count, after: after === null ? 'none' : after === b ? 'B' : 'other' }),
      );
      await old.evaluate(
        () =>
          new Promise((r) => {
            const d = indexedDB.deleteDatabase('pengepassportph-push');
            d.onsuccess = d.onerror = d.onblocked = r;
          }),
      );
      await old.close();
      const kept = !c.removes;
      // The next send: a test push through the API, as the row's "Send a test" sends it (up to 3 tries, 20 s apart,
      // while the push service catches up with an unsubscribe).
      const call = (method, path) =>
        fetch(`${SITE}api/device-alerts/${path}`, { method, headers: { authorization: `Device ${credential}`, 'content-type': 'application/json', origin: ORIGIN }, body: method === 'GET' ? undefined : '{}' }).then((r) => r.json());
      let test = null;
      for (let i = 0; i < (kept ? 1 : 3) && test !== 'gone'; i++) {
        if (i > 0) await sleep(20_000);
        test = (await call('POST', 'mine/test').catch(() => null))?.test ?? null;
      }
      const mine = await call('GET', 'mine').catch(() => null);
      const back = await browser.newPage();
      await back.goto(SITE, { waitUntil: 'networkidle0' });
      if (kept) {
        record('Left: the next send is accepted and the alert stays on', test === 'accepted' && mine?.state === 'active', JSON.stringify({ test, state: mine?.state }));
        await clickText(back, '.device-row button', 'Turn off'); // clean for the next run
        await sleep(1500);
      } else {
        record('Removed: the next send gets gone, and the server ends the alert as gone', test === 'gone' && mine?.state === 'gone', JSON.stringify({ test, state: mine?.state }));
        await waitText(back, 'Notifications need setting up again on this device.');
        record('Reopened, the row asks to set up again', true);
      }
      await back.close();
    }

    // ---- Today's worker reloads an open 05cee09 tab once, on its first activation (a fresh profile). ----
    const ctx = await (browser.createBrowserContext?.() ?? browser.createIncognitoBrowserContext());
    await gone(stopWeb());
    await serveWeb('/tmp/penge-old-05cee09/apps/web', (t) => t === oldSw);
    const tab = await ctx.newPage();
    await tab.goto(SITE, { waitUntil: 'networkidle0' });
    await tab.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', { timeout: 20_000 });
    await tab.evaluate(() => {
      window.__oldTab = true;
    });
    await gone(stopWeb());
    await serveWeb(`${REPO}/apps/web`, (t) => t === newSw);
    const other = await ctx.newPage();
    await other.goto(SITE, { waitUntil: 'networkidle0' }); // finds today's worker; it activates and reloads open pages
    await tab.waitForFunction(() => window.__oldTab === undefined, { timeout: 30_000 }).catch(() => undefined);
    const scripts = await tab.evaluate(() => (window.__oldTab === undefined ? [...document.scripts].map((x) => x.src).join(' ') : 'not reloaded'));
    record("Today's worker reloads an open 05cee09 tab on its first activation", scripts.includes(newMain), scripts);

    // ---- A 05cee09 credential from a refused signup, with its subscription: retired before today's setup. ----
    await ctx.overridePermissions(ORIGIN, ['notifications']);
    await subscribeAny(other);
    const oldEndpoint = await other.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null);
    await putOldState(other, { credential: 'c'.repeat(43), confirmed: false, askedAt: Date.now() });
    await other.reload({ waitUntil: 'networkidle0' });
    resetRateLimits();
    await notifyOnly(other);
    const now = await other.evaluate(async () => ({
      endpoint: (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null,
      legacy: (await indexedDB.databases()).some((d) => d.name === 'pengepassportph-push'),
    }));
    record('A 05cee09 credential is retired before setup: its database deleted, its subscription replaced, and setup succeeds', !now.legacy && !!now.endpoint && now.endpoint !== oldEndpoint, JSON.stringify({ legacy: now.legacy, replaced: now.endpoint !== oldEndpoint }));
    await ctx.close();
  } finally {
    for (const f of added) rmSync(f, { force: true });
    await gone(stopWeb());
    await serveWeb(`${REPO}/apps/web`, (t) => t === newSw); // today's build, as the local stack serves it
  }
} finally {
  writeFileSync(`${REPO}/docs/superpowers/verification/results/old-pages.json`, JSON.stringify(results, null, 2));
  await browser.close();
  for (const s of servers) s.kill();
}
process.exitCode = results.every((x) => x.pass) ? 0 : 1;
```

The `05cee09` worker and page cases are all in `old-pages.mjs` above, against the real `05cee09` bundle: its reconcile told "missing" in the three states; the one-origin case (a new alert's subscription removed by a resumed old page, the next send `gone`, the row asking to set up again); today's worker reloading an open old tab once; and a refused signup's local credential retired before setup. `old-worker.mjs` keeps its upgrade from the release before push (`OLD=<157bad9 worktree>`, the one `old-pages.mjs` builds at `/tmp/penge-old-157bad9`), with its channel-design steps replaced: after `restored = true;`, everything up to its last `record(...)` in the `try` becomes

```js
  await page.reload({ waitUntil: 'networkidle0' });
  const t0 = Date.now();
  await notifyOnly(page); // today's form: Notifications only, the ready check, "Notifications are on for this device."
  const took = Date.now() - t0;
  const after = await controllerInfo(page);
  record("After one reload: today's worker is the active one, controls the page, answers deviceAlerts: 1, and a subscription exists", after.isActive && after.reply?.deviceAlerts === 1 && !!after.endpoint, `${after.endpoint ? new URL(after.endpoint).host : 'no subscription'}`);
  record('Notifications came on within 60 s of the press, the ready check included', took <= 60_000, `${(took / 1000).toFixed(1)} s`);
  const seen = await shown(page);
  await devOpen(486, publishedDay(6));
  const fresh = await newNotes(page, seen);
  record('After the upgrade, a notification alert is delivered', fresh.length === 1 && fresh[0].title === 'Dates open at Antipolo', JSON.stringify(fresh.map((n) => `${n.title} / ${n.body}`)));
```

(its imports lose `emailSwitch`, `pushSwitch`, `send`, `mailMark`, `waitMail`, `linkIn`, `RUN` where now unused, and gain `notifyOnly`), and its `alive`, `stopWeb`, `gone`, `waitServing` and `serveWeb` move to `lib.mjs` as exports (with `PIDS` and `MARKER`), imported back by `old-worker.mjs`, so `old-pages.mjs` swaps the local stack's web server the same checked way. `old-pages.mjs` always ends serving today's build. Run it with the local stack up and no other harness running; `notifyOnly` uses the local stack's owner-free `live` mode (Step 1).

- [ ] **Step 5: The layout audit**

`audit.mjs` (its existing `inspect()` checks: horizontal page scroll, elements past the viewport, clipped text), at its widths (320 to 1280 px), in both colour schemes. In `audit()`, the width loop gains an inner loop over the schemes, and the screenshot name gains the scheme:

```js
    for (const scheme of ['light', 'dark']) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await sleep(150);
      if (prep) await page.evaluate(prep);
      const found = await page.evaluate(inspect);
      for (const f of found) findings.push({ state, width, scheme, ...f });
      const file = `${state}-${width}-${scheme}.png`;
      if (inDialog) await (await page.$('[role="dialog"]')).screenshot({ path: join(OUT, file) }).catch(() => page.screenshot({ path: join(OUT, file) }));
      else await page.screenshot({ path: join(OUT, file), fullPage: full });
    }
```

(replacing the body after `await sleep(400);`). The channel design's states, from `// The sheet: top, the switches, the end.` through the `sheet-blocked-hint` audit, are replaced by:

```js
  // The alerts form.
  resetRateLimits();
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await openSheet(page);
  await pickOffice(page);
  await page.evaluate(() => document.activeElement?.blur?.());
  await audit(page, 'form-both-off');
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await page.waitForFunction((el) => el.getAttribute('aria-checked') === 'true', { timeout: 20_000 }, await pushSwitch(page));
  await audit(page, 'form-notifications-on');
  await (await emailSwitch(page)).evaluate((e) => e.click());
  await audit(page, 'form-both-on', { prep: () => document.querySelector('input[type="email"]')?.scrollIntoView({ block: 'center' }) });
  // Both results, one retry: email refused by the mail server, notifications on.
  await fetch('http://127.0.0.1:8787/dev/mail-fail', { method: 'POST' });
  await send(page, `audit-${RUN}@example.com`);
  await waitText(page, 'Notifications are on for this device.', 60_000);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === 'Try email again'), { timeout: 30_000 });
  await audit(page, 'form-results-one-retry', { prep: () => { const d = document.querySelector('.sheet'); d.scrollTop = d.scrollHeight; } });
  await fetch('http://127.0.0.1:8787/dev/mail-ok', { method: 'POST' });
  await page.keyboard.press('Escape');
  // Change mode.
  await page.goto(SITE, { waitUntil: 'networkidle0' });
  await clickText(page, '.device-row button', 'Change');
  await page.waitForSelector('[role="dialog"]');
  await audit(page, 'form-change');
  await page.keyboard.press('Escape');
  // The row in every state, written through the VITE_LOCAL_DEBUG hook (the local stack's build sets it).
  const longest = 'Ciudad Autónoma de Buenos Aires (Philippine Embassy in the Argentine Republic, Argentina)';
  const alert = (o = {}) => ({ alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, fingerprint: 'f', endsAt: Date.now() + 179 * 86_400_000, choices: { siteIds: [486], applicants: 5, pace: 'hourly' }, ...o });
  const rows = {
    'row-on-longest': { kind: 'on', alert: alert({ officeNames: [longest] }), renewFailing: false },
    'row-on-renewal-note': { kind: 'on', alert: alert(), renewFailing: true },
    'row-setting-up': { kind: 'setting-up', slow: false },
    'row-setting-up-slow': { kind: 'setting-up', slow: true },
    'row-blocked': { kind: 'blocked' },
    'row-ended': { kind: 'ended', endedAt: Date.now() - 86_400_000 },
    'row-again': { kind: 'again' },
    'row-off-unconfirmed': { kind: 'off', unsubscribed: false, deleted: true },
    'row-off-pending': { kind: 'off', unsubscribed: true, deleted: false },
    'row-cant-check': { kind: 'cant-check' },
    'row-legacy': { kind: 'legacy' },
    'row-updating': { kind: 'updating' },
  };
  for (const [name, view] of Object.entries(rows)) {
    await page.evaluate((v) => window.__pengeRowView(v), view);
    await sleep(200);
    await audit(page, name);
  }
  // The form's hint when notifications are blocked for the site.
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setPermission', { origin: ORIGIN, permission: { name: 'notifications' }, setting: 'denied' });
  await page.reload({ waitUntil: 'networkidle0' });
  await openSheet(page);
  await (await pushSwitch(page)).evaluate((e) => e.click());
  await waitText(page, 'blocked for this site');
  await audit(page, 'form-blocked-hint');
```

The script's opening iPhone-tab audit moves inside the `try` (right after `try {`) and opens the form with `openSheet(page)` instead of clicking "Email alerts" (Task 17 renamed it "Alerts"); its `prep` scrolls to the switches with `document.querySelector('[role="switch"]')?.scrollIntoView({ block: 'center' })`, and so does every other `prep` that named `fieldset.channels`. After writing `audit.json`, the script sets `process.exitCode = done.length === STATES && findings.length === 0 ? 0 : 1`, so an audit that stopped early or found anything fails Step 7.

`STATES` becomes the number of `audit()` calls the script makes (count them after the edit); the imports gain `openSheet` and `pickOffice` and lose what is no longer used. The row's office names come from the catalogue by `siteIds`; for the longest-name state, the debug hook accepts an `officeNames` override on the alert (`DeviceRow` uses `alert.officeNames ?? names(alert.choices.siteIds)` in the `VITE_LOCAL_DEBUG` build only). The hook in `DeviceRow`: `if (import.meta.env.VITE_LOCAL_DEBUG === '1') (window as any).__pengeRowView = setView;`, and `scripts/local-stack.sh` builds the web app with `VITE_LOCAL_DEBUG=1` (the release build never sets it; `pwa.test.ts` gains a case that `apps/web/dist` from `npm run build` contains no `__pengeRowView`).

- [ ] **Step 6: Rehearse the rollback on the local stack**

A manual rehearsal, recorded by hand (Valkey commands run inside its container, `docker exec penge-local-valkey valkey-cli …`, in the Docker context `scripts/local-stack.sh` uses; there is no host `valkey-cli`), on the local stack's own Valkey (`redis://127.0.0.1:6391`, the `penge-local-valkey` container `scripts/local-stack.sh up` starts; it stays up throughout). Nothing here reaches production, R2 or a real mail server.

`apps/server/dev/local.ts` exports its `secrets(dir)` and `noSink` (both exist; add `export`). New `docs/superpowers/verification/harness/old-check.mts`, one run of an older release's checker against the local Valkey with the local stack's fakes:

```ts
// npx tsx docs/superpowers/verification/harness/old-check.mts <worktree> [<office> <date>] — that release's own checker
// code against the local Valkey, with the local stack's fake DFA, captured mail and no R2: one run, or, with an office
// and a published date, a run that sees the date closed and one that sees it open (so the opening is emailed).
// For the rollback rehearsal only.
import { join } from 'node:path';
import { FakeDfa } from '../../../../apps/server/dev/fake-upstream.ts';
import { CaptureMailer } from '../../../../apps/server/dev/capture-mailer.ts';
import { noSink, secrets } from '../../../../apps/server/dev/local.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: old-check.mts <worktree of the older release>');
const local = join(import.meta.dirname, '../../../../.local');
const { runCheck } = await import(join(dir, 'apps/server/src/checker.ts'));
const { connectRedis } = await import(join(dir, 'apps/server/src/kv.ts'));
const { log } = await import(join(dir, 'apps/server/src/log.ts'));
const kv = await connectRedis('redis://127.0.0.1:6391', (err: Error) => process.stderr.write(`redis: ${err.message}\n`));
const upstream = new FakeDfa();
const run = () =>
  runCheck({
    kv, upstream, sink: noSink, mailer: new CaptureMailer(local), keys: secrets(local).keys, log,
    publicBaseUrl: 'http://localhost:4173/pengepassportph/', mailDailyLimit: 2500, alertsPerSubscriberPerDay: 288, client: 'penge-rollback-rehearsal',
    runId: `rehearsal-${Date.now()}`,
  });
try {
  let report = await run();
  const [office, date] = process.argv.slice(3);
  if (office && date) {
    upstream.open.set(Number(office), [date]);
    report = await run();
  }
  console.log(JSON.stringify({ healthy: report.healthy, emailed: report.delivery?.sent ?? null }));
} finally {
  await kv.close();
}
```

(It passes the fields `157bad9`'s `CheckDeps` requires; `05cee09`'s takes the same plus an optional `push`, left out, which is its rollback configuration. If either release's `CheckDeps` names a required field this does not pass, read it with `git show <commit>:apps/server/src/checker.ts` and add it with a local value.)

`.local/rollback.env` (git-ignored, mode 0600), the configuration each older server starts with, written once by hand: every variable that release's `deploy/server.env.example` lists, with local values — `REDIS_URL=redis://127.0.0.1:6391`, `API_HOST=127.0.0.1`, `API_PORT=8790` (the local stack's own API keeps 8787), `PUBLIC_BASE_URL=http://localhost:8790/pengepassportph/`, the email keys exactly as `secrets('.local')` reads them, the mail settings pointing at `127.0.0.1:1` (nothing can be sent), R2 left as dummy values — plus the rollback's: `PUSH_MODE=off`, no `PUSH_OWNER_TOKEN`, `DEVICE_ALERT_LIMIT=300`, `DEVICE_RECORD_LIMIT=1750`.

With an active notification alert (from `device-flow.mjs`, stopped before turning off; note its alert id: `docker exec penge-local-valkey valkey-cli GET <its pp:dev:cred:* key>`), a tab open on it, and a retired credential from a second profile:

1. `docker exec penge-local-valkey valkey-cli SET pp:push:paused 1`. Then, from the repository root, for each of `157bad9` and `05cee09` (worktrees from `old-pages.mjs`, `/tmp/penge-old-<commit>`):

   ```bash
   c=157bad9   # then 05cee09
   (cd /tmp/penge-old-$c && npm run build -w @penge/server)
   (set -a; . .local/rollback.env; set +a; exec node /tmp/penge-old-$c/apps/server/dist/server.mjs) > .local/old-$c.log 2>&1 & pid=$!
   ok=no
   for i in $(seq 1 60); do
     kill -0 $pid 2>/dev/null || break                      # it exited: read .local/old-$c.log
     curl -fsS http://127.0.0.1:8790/api/ready >/dev/null 2>&1 && { ok=yes; break; }
     sleep 0.5
   done
   echo "$c ready: $ok"
   kill $pid 2>/dev/null; wait $pid 2>/dev/null              # gone before the next release starts on 8790
   npx tsx docs/superpowers/verification/harness/old-check.mts /tmp/penge-old-$c
   ```

   Expected for each: `ready: yes` (it starts with the new configuration and answers ready on its own `/api/ready`), and the wrapper prints `"healthy":true` (its checker runs against the same data — email subscribers, and notification alerts it does not know — without failing). Email continuity: `device-flow.mjs` case 7 confirmed an email subscriber following Antipolo (486) and wrote its address to `.local/email-subscriber.txt`. Run the wrapper once more as `npx tsx docs/superpowers/verification/harness/old-check.mts /tmp/penge-old-$c 486 <a published day not yet announced>`: it prints `"emailed"` of at least 1, and an alert email to that address was captured — `node -e "import('./docs/superpowers/verification/harness/lib.mjs').then((m) => console.log(!!m.lastMail('alert', require('node:fs').readFileSync('.local/email-subscriber.txt', 'utf8').trim())))"` prints `true` (record it).
2. Expire the alert as time would: `docker exec penge-local-valkey valkey-cli HSET pp:dev:<id> end <ms an hour ago>` and `docker exec penge-local-valkey valkey-cli ZADD pp:dev:ends <the same ms> <id>` (clean-up selects by the sorted set's score). Then, with the same env, `node apps/server/dist/admin.mjs device-cleanup` (this release's bundle, built by `npm run build -w @penge/server`): it exits 0; `EXISTS pp:dev:<id>` is 0, `ZSCORE pp:dev:ends <id>` is nil, and the alert's delivery keys (`K.devHeld(id)`, `K.devLast(id)`, `K.devTried(id)`, its field in `pp:dev:queue`; names in `apps/server/src/keys.ts`) are gone.
3. Roll forward: the local stack's API (this release) kept running throughout and the Valkey container was never stopped (`scripts/local-stack.sh down` would remove it and its data, so it is not used here); `docker exec penge-local-valkey valkey-cli DEL pp:push:paused`, reload the tab: the row says the alert ended (step 2 ended it); and in the second profile, reloaded, the retired credential's deletion completes (its `pp:dev:cred:*` key is gone after the page loads, and the row there shows no alert).

Record each step's command and output in `docs/superpowers/verification/results/rollback.json` by hand (`{ step, command, output, pass }`).

- [ ] **Step 7: Run them**

Run (with `scripts/local-stack.sh up`):

```bash
node docs/superpowers/verification/harness/device-flow.mjs chrome
node docs/superpowers/verification/harness/device-flow.mjs firefox
node docs/superpowers/verification/harness/old-pages.mjs
OLD=/tmp/penge-old-157bad9 node docs/superpowers/verification/harness/old-worker.mjs   # the worktree old-pages.mjs built
node docs/superpowers/verification/harness/audit.mjs
```

Expected: every line `PASS`. A `FAIL` is a bug: fix it test-first in the task that owns the code (a new failing unit test, then the fix), then run the harness again.

- [ ] **Step 8: Codex, commit**

Codex pass (prompt: "Review the local stack and verification harness changes: do they exercise every Mac verification item in the spec's 'Verification' step 2 (notifications only, email only, both, one failing, denied and dismissed, the ready check, change, test, tap, turn off online and offline, blocked, ended, delete this device's data, an open 05cee09 page, the layout audit at 320 to 1280 pixels), and can any of them touch anything outside the local stack?"). Then:

```bash
git add apps/server/dev apps/server/test/local-stack.test.ts docs/superpowers/verification/harness docs/superpowers/verification/results apps/web/src/components/DeviceRow.tsx
git commit -m "The local stack with notifications, and the harness for the new flow, old pages and the layout audit"
```

---
### Task 21: Leaving the channel design: inspect, dump and clean up, as commands

The maintenance window's steps 2–4 (spec: "Leaving the channel design behind") as tested commands instead of hand-typed `valkey-cli`, so the owner's data is read, backed up and changed exactly by the table.

**Files:**
- Create: `apps/server/src/migrate.ts`
- Modify: `apps/server/src/kv.ts` (`Kv.scan(pattern)`), `apps/server/src/admin.ts` (`channel-inspect`, `channel-dump`, `channel-clean --yes`, added to `COMMANDS` and `USAGE`)
- Test: `apps/server/test/migrate.test.ts`

**Interfaces:**
- Consumes: `K` (the channel release's key names are spelled out here, since Task 3 removed them from `keys.ts`).
- Produces:
  - `Kv.scan(pattern: string): Promise<string[]>` (Valkey `SCAN MATCH` with `COUNT 500`; MemoryKv: glob over live keys).
  - migrate.ts: `inspectChannels(kv): Promise<Inspection>` with `Inspection = { pushKeys: string[]; reservedKeys: string[]; pendingChannels: boolean; subscribers: { id: string; emailOn: string | null; fields: string[] }[]; pending: { key: string; index: string; emailOn: boolean }[]; livePending: { key: string; index: string }[]; stops: string[] }` (`stops`: subscribers with `emailOn=0`, and malformed flags anywhere); `dumpChannels(kv, i: Inspection): Promise<Record<string, unknown>>`; `cleanChannels(kv, i: Inspection): Promise<{ deleted: number; subscribersCleaned: number; pendingCancelled: number; pendingCleaned: number; reservedDeleted: number; stops: string[] }>` (refuses to run, changing nothing, while `stops` is not empty).

- [ ] **Step 1: Write the failing tests**

`apps/server/test/migrate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cleanChannels, dumpChannels, inspectChannels } from '../src/migrate.ts';
import { K } from '../src/keys.ts';
import { MemoryKv } from './helpers.ts';

/** Data as the channel release (05cee09) could have left it. */
async function channelData(kv: MemoryKv, o: { emailOff?: boolean } = {}) {
  await kv.write([
    { op: 'hSet', key: K.subscriber('A'), fields: { email: 'v1.x', index: 'idxA', sites: '486', applicants: '1', emailOn: '1', pushOn: '1' } },
    { op: 'hSet', key: K.subscriber('B'), fields: { email: 'v1.y', index: 'idxB', sites: '486', applicants: '1' } },
    { op: 'sAdd', key: K.allSubscribers, members: ['A', 'B'] },
    { op: 'hSet', key: 'pp:push:A', fields: { d1: 'v2.sealed' } },
    { op: 'hSet', key: 'pp:push:meta:A', fields: { d1: 'r|1|cred|ep|sh' } },
    { op: 'set', key: 'pp:push:cred:cred', value: 'A/d1' },
    { op: 'set', key: 'pp:push:endpoint:ep', value: 'A/d1' },
    { op: 'set', key: K.pushPaused, value: '1' },
    { op: 'set', key: K.pushBackoff('fcm'), value: '0' },
    { op: 'set', key: K.pending('t1'), value: JSON.stringify({ sealedEmail: 'v1.p', index: 'idxP', siteIds: [486], applicants: 1, requestedAt: '', channels: { emailOn: false, pushOn: true } }) },
    { op: 'set', key: K.pending('t2'), value: JSON.stringify({ sealedEmail: 'v1.q', index: 'idxQ', siteIds: [486], applicants: 1, requestedAt: '', channels: { emailOn: true, pushOn: true } }) },
    { op: 'sAdd', key: K.pendingFor('idxP'), members: ['t1'] },
    { op: 'sAdd', key: 'pp:pending:channels', members: ['t1|idxP', 't2|idxQ'] },
    { op: 'set', key: 'pp:reserved:idxP', value: 'R1' },
    { op: 'set', key: 'pp:reserved:idxQ', value: 'R2' },
  ]);
  if (o.emailOff) await kv.write([{ op: 'hSet', key: K.subscriber('B'), fields: { emailOn: '0', pushOn: '1' } }]);
}

describe('leaving the channel design', () => {
  it('finds every channel key and field, and never the new ones (paused, backoff)', async () => {
    const kv = new MemoryKv();
    await channelData(kv);
    const i = await inspectChannels(kv);
    expect(i.pushKeys.sort()).toEqual(['pp:push:A', 'pp:push:cred:cred', 'pp:push:endpoint:ep', 'pp:push:meta:A']);
    expect(i.reservedKeys.sort()).toEqual(['pp:reserved:idxP', 'pp:reserved:idxQ']);
    expect(i.pendingChannels).toBe(true);
    expect(i.subscribers).toEqual([{ id: 'A', emailOn: '1', fields: ['emailOn', 'pushOn'] }]);
    expect(i.pending.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: K.pending('t1'), index: 'idxP', emailOn: false },
      { key: K.pending('t2'), index: 'idxQ', emailOn: true },
    ]);
    expect(i.stops).toEqual([]);
    expect(i.livePending.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: K.pending('t1'), index: 'idxP' },
      { key: K.pending('t2'), index: 'idxQ' },
    ]);
  });

  it('dumps exactly those keys with their values, for the backup', async () => {
    const kv = new MemoryKv();
    await channelData(kv);
    const dump = await dumpChannels(kv, await inspectChannels(kv));
    expect(Object.keys(dump).sort()).toEqual(['pp:pending:channels', 'pp:pending:t1', 'pp:pending:t2', 'pp:push:A', 'pp:push:cred:cred', 'pp:push:endpoint:ep', 'pp:push:meta:A', 'pp:reserved:idxP', 'pp:reserved:idxQ', 'pp:sub:A'].sort());
    expect(dump['pp:push:meta:A']).toEqual({ d1: 'r|1|cred|ep|sh' });
  });

  it('cleans by the table: push keys deleted, fields removed, email-off requests cancelled, the rest kept as email', async () => {
    const kv = new MemoryKv();
    await channelData(kv);
    const r = await cleanChannels(kv, await inspectChannels(kv));
    expect(r).toMatchObject({ subscribersCleaned: 1, pendingCancelled: 1, pendingCleaned: 1, reservedDeleted: 1 });
    expect(await kv.hGetAll(K.subscriber('A'))).toEqual({ email: 'v1.x', index: 'idxA', sites: '486', applicants: '1' });
    expect(await kv.get(K.pending('t1'))).toBeNull();
    expect(await kv.sMembers(K.pendingFor('idxP'))).toEqual([]);
    expect(JSON.parse((await kv.get(K.pending('t2')))!)).not.toHaveProperty('channels');
    expect(await kv.get('pp:reserved:idxQ')).toBe('R2'); // a kept request still needs it
    expect(await kv.get('pp:reserved:idxP')).toBeNull();
    expect(await kv.get(K.pushPaused)).toBe('1');
    expect(await kv.get(K.pushBackoff('fcm'))).toBe('0');
    expect(await inspectChannels(kv)).toMatchObject({ pushKeys: [], pendingChannels: false, subscribers: [] });
  });

  it('stops, changing nothing, when a subscriber has email off', async () => {
    const kv = new MemoryKv();
    await channelData(kv, { emailOff: true });
    const i = await inspectChannels(kv);
    expect(i.stops).toEqual(['B: email off']);
    const before = kv.dump();
    await expect(cleanChannels(kv, i)).rejects.toThrow(/B: email off/);
    expect(kv.dump()).toBe(before);
  });

  it('finds an email-off subscriber reachable only through an office, and stops', async () => {
    const kv = new MemoryKv();
    await channelData(kv);
    await kv.write([
      { op: 'hSet', key: K.subscriber('C'), fields: { email: 'v1.z', index: 'idxC', sites: '486', applicants: '1', emailOn: '0' } },
      { op: 'sAdd', key: K.siteSubscribers(486), members: ['C'] },
    ]);
    const i = await inspectChannels(kv);
    expect(i.stops).toEqual(expect.arrayContaining(['C: has a record but is not in the list of all subscribers', 'C: email off']));
    const before = kv.dump();
    await expect(cleanChannels(kv, i)).rejects.toThrow(/owner decides/);
    expect(kv.dump()).toBe(before);
  });

  it('stops on malformed flags anywhere, changing nothing', async () => {
    const kv = new MemoryKv();
    await channelData(kv);
    await kv.write([{ op: 'hSet', key: K.subscriber('A'), fields: { pushOn: 'yes' } }]);
    await kv.set(K.pending('t3'), JSON.stringify({ index: 'idxR', channels: { emailOn: 'maybe' } }));
    await kv.set(K.pending('t5'), JSON.stringify({ index: 'idxS', channels: { pushOn: true } })); // emailOn missing
    await kv.set(K.pending('t6'), JSON.stringify({ index: 'idxT', channels: { emailOn: true, pushOn: 'yes' } }));
    const i = await inspectChannels(kv);
    expect(i.stops.sort()).toEqual(['A: malformed channel flags', 'pp:pending:t3: malformed channels', 'pp:pending:t5: malformed channels', 'pp:pending:t6: malformed channels']);
    await expect(cleanChannels(kv, i)).rejects.toThrow(/owner decides/);
  });

  it('keeps a reservation an email-only pending request still needs, and a kept request\'s remaining life', async () => {
    const kv = new MemoryKv();
    await channelData(kv);
    await kv.set(K.pending('t4'), JSON.stringify({ sealedEmail: 'v1.r', index: 'idxP', siteIds: [486], applicants: 1, requestedAt: '' }), { ttlSeconds: 600 });
    await kv.set(K.pending('t2'), (await kv.get(K.pending('t2')))!, { ttlSeconds: 900 });
    await cleanChannels(kv, await inspectChannels(kv));
    expect(await kv.get('pp:reserved:idxP')).toBe('R1'); // t1 was cancelled, but t4 (no channels) still needs it
    const ttl = await kv.script({ name: 't', lua: "#!lua\nreturn tostring(redis.call('TTL', KEYS[1]))" }, [K.pending('t2')], []);
    expect(Number(ttl)).toBeGreaterThan(890);
    expect(Number(ttl)).toBeLessThanOrEqual(900);
  });

  it('is idempotent', async () => {
    const kv = new MemoryKv();
    await channelData(kv);
    await cleanChannels(kv, await inspectChannels(kv));
    const after = kv.dump();
    await cleanChannels(kv, await inspectChannels(kv));
    expect(kv.dump()).toBe(after);
  });
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- migrate`
Expected: FAIL: `Cannot find module '../src/migrate.ts'`.

- [ ] **Step 3: `scan`, and the commands**

`apps/server/src/kv.ts`: `Kv` gains `scan(pattern: string): Promise<string[]>`. In `connectRedis`:

```ts
    async scan(pattern) {
      const out: string[] = [];
      for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 500 })) out.push(...(Array.isArray(keys) ? keys : [keys]));
      return [...new Set(out)];
    },
```

In `MemoryKv`:

```ts
  async scan(pattern: string) {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return this.keys().filter((k) => re.test(k));
  }
```

`apps/server/src/migrate.ts`:

```ts
// Leaving the channel design (spec: "Leaving the channel design behind", steps 2–4): what the channel release
// (05cee09) may have stored, found read-only, dumped for the backup, and cleaned by the spec's table. Run with the API
// and the checker stopped. A subscriber with email off stops it: the owner decides; it is never turned into email.
import { K } from './keys.ts';
import type { Kv, ScriptDef, WriteOp } from './kv.ts';

const CHANNEL_FIELDS = ['emailOn', 'pushOn', 'pushCredentialHash', 'device'];
/** The channel release's keys under pp:push:, which this release does not use (it keeps pp:push:paused and pp:push:backoff:*). */
const isChannelPushKey = (k: string) => k !== K.pushPaused && !k.startsWith(K.pushBackoff(''));

export interface Inspection {
  pushKeys: string[];
  reservedKeys: string[];
  pendingChannels: boolean;
  subscribers: { id: string; emailOn: string | null; fields: string[] }[];
  /** Pending requests that carry channels, with their (boolean) `emailOn`. */
  pending: { key: string; index: string; emailOn: boolean }[];
  /** Every live pending request, with or without channels: a reservation one of them still needs is kept. */
  livePending: { key: string; index: string }[];
  /** What the owner must decide before anything is cleaned: subscribers with email off, and malformed flags anywhere. */
  stops: string[];
}

const FLAG = (v: unknown) => v === undefined || v === '0' || v === '1';

export async function inspectChannels(kv: Kv): Promise<Inspection> {
  const pushKeys = (await kv.scan('pp:push:*')).filter(isChannelPushKey);
  const reservedKeys = await kv.scan('pp:reserved:*');
  const pendingChannels = (await kv.scan('pp:pending:channels')).length > 0;
  const subscribers: Inspection['subscribers'] = [];
  const stops: string[] = [];
  // Every subscriber however it is reachable: the list of all of them, every office's set (the checker sends by these),
  // and every subscriber hash. A record or membership outside the others is inconsistent: the owner decides first.
  const all = new Set(await kv.sMembers(K.allSubscribers));
  const inOffices = new Set<string>();
  for (const key of await kv.scan(K.siteSubscribers(0).replace(/:0:subs$/, ':*:subs'))) for (const id of await kv.sMembers(key)) inOffices.add(id);
  const hashes = new Set((await kv.scan(K.subscriber('*'))).map((k) => k.slice(K.subscriber('').length)));
  for (const id of [...new Set([...all, ...inOffices, ...hashes])].sort()) {
    if (!hashes.has(id)) {
      stops.push(`${id}: listed${all.has(id) ? '' : ' in an office'} but has no record`);
      continue;
    }
    if (!all.has(id)) stops.push(`${id}: has a record but is not in the list of all subscribers`);
    const h = await kv.hGetAll(K.subscriber(id));
    const fields = CHANNEL_FIELDS.filter((f) => f in h);
    if (fields.length === 0) continue;
    subscribers.push({ id, emailOn: h.emailOn ?? null, fields });
    if (h.emailOn === '0') stops.push(`${id}: email off`);
    else if (!FLAG(h.emailOn) || !FLAG(h.pushOn)) stops.push(`${id}: malformed channel flags`);
  }
  const pending: Inspection['pending'] = [];
  const livePending: Inspection['livePending'] = [];
  for (const key of await kv.scan('pp:pending:*')) {
    if (key === 'pp:pending:channels') continue;
    const raw = await kv.get(key);
    if (!raw) continue;
    let p: { index?: unknown; channels?: unknown };
    try {
      p = JSON.parse(raw) as typeof p;
    } catch {
      stops.push(`${key}: not readable`);
      continue;
    }
    if (typeof p.index === 'string') livePending.push({ key, index: p.index });
    if (p.channels === undefined) continue;
    // The channel release always wrote a boolean emailOn, and pushOn as a boolean when present: anything else is
    // malformed, and the owner decides.
    const c = p.channels as { emailOn?: unknown; pushOn?: unknown } | null;
    if (typeof c !== 'object' || c === null || typeof c.emailOn !== 'boolean' || (c.pushOn !== undefined && typeof c.pushOn !== 'boolean')) {
      stops.push(`${key}: malformed channels`);
      continue;
    }
    pending.push({ key, index: typeof p.index === 'string' ? p.index : '', emailOn: c.emailOn });
  }
  return { pushKeys, reservedKeys, pendingChannels, subscribers, pending, livePending, stops };
}

/** Exactly the keys inspection found, with their values, for `channel-keys-<stamp>-expires-<stamp>.json`. */
export async function dumpChannels(kv: Kv, i: Inspection): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const keys = [...i.pushKeys, ...i.reservedKeys, ...i.pending.map((p) => p.key), ...i.subscribers.map((s) => K.subscriber(s.id)), ...(i.pendingChannels ? ['pp:pending:channels'] : [])];
  for (const key of keys) {
    const type = await kv.script({ name: 'type', lua: "#!lua flags=no-writes\nreturn redis.call('TYPE', KEYS[1]).ok" }, [key], []);
    if (type === 'string') out[key] = await kv.get(key);
    else if (type === 'hash') out[key] = await kv.hGetAll(key);
    else if (type === 'set') out[key] = await kv.sMembers(key);
  }
  return out;
}

/** A pending request rewritten without its channels, keeping the life it has left (at most 48 hours); an expired one is left to expire. */
const PENDING_REWRITE: ScriptDef = {
  name: 'pending-rewrite',
  lua: `#!lua
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 or ttl == 0 then return 'gone' end
local max = tonumber(ARGV[2])
if ttl < 0 or ttl > max then ttl = max end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
return 'ok'`,
};

export async function cleanChannels(kv: Kv, i: Inspection) {
  if (i.stops.length > 0) throw new Error(`the owner decides first (spec, step 4): ${i.stops.join('; ')}`);
  const ops: WriteOp[] = [];
  for (const key of i.pushKeys) ops.push({ op: 'del', key });
  for (const s of i.subscribers) ops.push({ op: 'hDel', key: K.subscriber(s.id), fields: CHANNEL_FIELDS });
  const cancelled = new Set<string>(); // pending keys
  let pendingCancelled = 0;
  let pendingCleaned = 0;
  for (const p of i.pending) {
    const raw = await kv.get(p.key);
    if (!raw) continue;
    const hash = p.key.slice(K.pending('').length);
    if (p.emailOn === false) {
      // Never turned into email consent: cancelled, with its index entry.
      ops.push({ op: 'del', key: p.key }, { op: 'sRem', key: K.pendingFor(p.index), members: [hash] });
      cancelled.add(p.key);
      pendingCancelled++;
    } else {
      const { channels: _c, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      if ((await kv.script(PENDING_REWRITE, [p.key], [JSON.stringify(rest), String(48 * 3600_000)])) === 'ok') pendingCleaned++;
    }
  }
  // A reservation stays while any live pending request (with or without channels) not cancelled here needs it.
  const needed = new Set(i.livePending.filter((p) => !cancelled.has(p.key)).map((p) => p.index));
  let reservedDeleted = 0;
  for (const key of i.reservedKeys) {
    if (needed.has(key.slice('pp:reserved:'.length))) continue;
    ops.push({ op: 'del', key });
    reservedDeleted++;
  }
  if (i.pendingChannels) ops.push({ op: 'del', key: 'pp:pending:channels' });
  await kv.write(ops);
  return { deleted: i.pushKeys.length, subscribersCleaned: i.subscribers.length, pendingCancelled, pendingCleaned, reservedDeleted, stops: [] as string[] };
}
```

`apps/server/src/admin.ts` gains three commands, added to the list and the usage text:

```ts
const COMMANDS = ['backup', 'restore', 'scans', 'device-cleanup', 'channel-inspect', 'channel-dump', 'channel-clean'];
const USAGE =
  'usage: admin.mjs backup > file.json | admin.mjs restore <file.json[.gz]> --yes | admin.mjs scans <YYYY-MM-DD> [abroad] > day.jsonl | admin.mjs device-cleanup | admin.mjs channel-inspect | admin.mjs channel-dump > channel-keys.json | admin.mjs channel-clean --yes\n';
```

They read **only `REDIS_URL`** (not `loadConfig`, which refuses the channel release's `PUSH_OWNER_EMAILS`), so the runbook can run them from the new release's unpacked bundle, before it is activated, with production's current `server.env`:

```ts
if (command === 'channel-inspect' || command === 'channel-dump' || command === 'channel-clean') {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    process.stderr.write('REDIS_URL is not set\n');
    process.exit(2);
  }
  // Written in full before the process ends: a dump through a pipe (ssh, gzip) is never cut short.
  const out = (text: string) => new Promise<void>((resolve, reject) => process.stdout.write(text, (err) => (err ? reject(err) : resolve())));
  const kv = await connectRedis(url, (err) => process.stderr.write(`redis: ${err.message}\n`));
  try {
    const inspection = await inspectChannels(kv);
    if (command === 'channel-inspect') await out(`${JSON.stringify(inspection, null, 2)}\n`);
    else if (command === 'channel-dump') await out(`${JSON.stringify(await dumpChannels(kv, inspection))}\n`);
    else if (file !== '--yes') {
      await out(`${JSON.stringify(inspection, null, 2)}\nadd --yes to clean\n`);
      process.exitCode = 2;
    } else await out(`${JSON.stringify(await cleanChannels(kv, inspection))}\n`);
  } finally {
    await kv.close();
  }
  process.exit();
}
```

As commands:
- `channel-inspect`: prints `inspectChannels` as JSON to stdout (read only).
- `channel-dump`: prints `dumpChannels` as JSON (the operator writes it to `channel-keys-<stamp>-expires-<stamp>.json`, mode 0600).
- `channel-clean --yes`: runs `inspectChannels` then `cleanChannels`, printing the result; without `--yes` it prints the inspection and exits 2.

`deploy/penge-backup-expire.sh`'s test (`apps/server/test/backup-expire.test.ts`) gains a case: a file named `channel-keys-20261007T010000Z-expires-20261021T010000Z.json` older than its expiry is deleted, one not yet expired is kept.

- [ ] **Step 4: Watch them pass**

Run: `npm test -w @penge/server -- migrate backup-expire`
Expected: PASS.

- [ ] **Step 5: Typecheck, Codex, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

Codex pass (prompt: "Adversarial review of the commands that leave the channel design, against the spec's migration table (step 4): find a row applied wrongly, a key of the new release touched (pp:push:paused, pp:push:backoff:*, pp:dev:*), a pending request's link broken or its life extended, an email-off subscriber turned into an email subscriber, or anything written before the stop check."). Then:

```bash
git add apps/server/src/migrate.ts apps/server/src/kv.ts apps/server/src/admin.ts apps/server/test/migrate.test.ts apps/server/test/backup-expire.test.ts
git commit -m "Commands to inspect, dump and clean the channel design's data by the migration table"
```

---
### Task 22: The runbook, the docs, the rollback drop-in, and the Mac verification record

**Files:**
- Create: `deploy/systemd/penge-check.service.d/device-cleanup.conf` (installed only when rolling back), `docs/superpowers/verification/2026-10-alerts-mac.md`
- Modify: `deploy/README.md` (sections "Push notifications", "Rolling back once push is on", "Rollout backups", "Keys and backups", "Daily numbers", and `server.env` notes), `deploy/server.env.example`, `docs/how-it-works.md` ("Alerts by email and push"), `docs/alert-timing.md`, `docs/android.md` ("Notifications (version 1.1.0)"), `docs/legal/README.md` (RA 10173 section), `apps/server/dev/README.md`
- Test: `apps/server/test/units.test.ts` (the drop-in and the env example), `apps/server/test/privacy.test.ts` (the docs state the spec's retention)

**Interfaces:**
- Consumes: the commands of Tasks 12 (`device-cleanup`) and 21 (`channel-inspect`, `channel-dump`, `channel-clean`); the config of Task 2.
- Produces: the runbook the owner follows in Task 24.

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/units.test.ts` (it imports only `node:fs/promises` today: add `import { readFileSync } from 'node:fs';`; paths are relative to this file through `import.meta.dirname`, as `__dirname` does not exist in these ES modules):

```ts
describe('the rollback pre-step', () => {
  it('runs device clean-up before the old checker, never stopping it, within 130 s', () => {
    const conf = readFileSync(join(import.meta.dirname, '../../../deploy/systemd/penge-check.service.d/device-cleanup.conf'), 'utf8');
    expect(conf).toMatch(/^\[Service\]$/m);
    expect(conf).toMatch(/^ExecStartPre=-\/usr\/bin\/timeout --kill-after=10s 120s \/usr\/local\/bin\/node --enable-source-maps \/opt\/penge\/device-cleanup\/admin\.mjs device-cleanup$/m);
    // The same Node the checker itself runs with (deploy/node-install.sh links it at /usr/local/bin/node).
    const check = readFileSync(join(import.meta.dirname, '../../../deploy/systemd/penge-check.service'), 'utf8');
    const node = /^ExecStart=(\S+)/m.exec(check)?.[1];
    expect(conf).toContain(`120s ${node} `);
  });

  it('documents every new setting in the env example, and no owner addresses', () => {
    const env = readFileSync(join(import.meta.dirname, '../../../deploy/server.env.example'), 'utf8');
    for (const name of ['PUSH_MODE', 'PUSH_OWNER_TOKEN', 'DEVICE_ALERT_LIMIT', 'DEVICE_RECORD_LIMIT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) expect(env).toContain(name);
    expect(env).not.toContain('PUSH_OWNER_EMAILS');
  });

  it('gives limits in the env example that the server accepts: the measured ceilings', async () => {
    const text = readFileSync(join(import.meta.dirname, '../../../deploy/server.env.example'), 'utf8');
    const value = (name: string) => text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
    expect(value('DEVICE_ALERT_LIMIT')).toBe('300');
    expect(value('DEVICE_RECORD_LIMIT')).toBe('1750');
    const { loadConfig } = await import('../src/config.ts');
    const env = { ...baseEnv(), DEVICE_ALERT_LIMIT: value('DEVICE_ALERT_LIMIT'), DEVICE_RECORD_LIMIT: value('DEVICE_RECORD_LIMIT') };
    expect(loadConfig(env).devices).toEqual({ alertLimit: 300, recordLimit: 1750 });
  });
});
```

In `apps/server/test/privacy.test.ts` (it already reads the privacy page and the docs), a case that the runbook's retention lines match the spec's retention table: `deploy/README.md` contains "180 days after the last opening that reached us", "operation result until the next operation or 24 hours", "end records 30 days", and "both have been rewritten" (the AOF and the snapshot).

- [ ] **Step 2: Watch them fail**

Run: `npm test -w @penge/server -- units privacy`
Expected: FAIL: the drop-in file does not exist; the example still names `PUSH_OWNER_EMAILS`.

- [ ] **Step 3: The drop-in and the example**

`deploy/systemd/penge-check.service.d/device-cleanup.conf`:

```ini
# Installed only when rolling back to a release that does not know notification alerts (deploy/README.md,
# "Rolling back once notifications are on"). Runs the new release's clean-up, pinned outside releases/, before each
# run of the old checker: the "-" lets the checker start whatever it returns, and timeout ends it within 130 s.
[Service]
ExecStartPre=-/usr/bin/timeout --kill-after=10s 120s /usr/local/bin/node --enable-source-maps /opt/penge/device-cleanup/admin.mjs device-cleanup
```

`deploy/server.env.example`: remove `PUSH_OWNER_EMAILS`; add, with comments, `PUSH_OWNER_TOKEN=` ("owner mode: at least 32 random characters, `openssl rand -base64 33 | tr '+/' '-_' | tr -d '='`; the owner opens the site once with `#owner=<token>`"), `DEVICE_ALERT_LIMIT=300`, `DEVICE_RECORD_LIMIT=1750` (the defaults and ceilings; the comment gives Task 19's measured numbers and says a value above the ceiling is refused at start).

`baseEnv()` is a function in this test file returning a copy of the valid environment that `apps/server/test/units.test.ts` builds inside its config `describe` (`const env = {` near line 175): move that object to a top-level `export const validEnv` in `units.test.ts`'s neighbour `apps/server/test/helpers.ts`, use it from both files, and define `const baseEnv = () => ({ ...validEnv });` here.

- [ ] **Step 4: The runbook**

`deploy/README.md`:

1. Replace "Push notifications" with **"Notifications"**: what they are (no email; the ready check; 180 days, renewed on opening); the modes table (copy the spec's "What each mode allows"); the emergency stop (`valkey-cli SET pp:push:paused 1`, and `DEL` to resume; checked by every send, setup and test); the owner link (generate the token, set `PUSH_OWNER_TOKEN`, restart `penge-api`, open `https://alphaexperiments.com/pengepassportph/#owner=<token>` once per browser; revoke by changing it and restarting); the VAPID keys (kept with the server's configuration; never rotate them while alerts exist); the limits and what the daily report flags at 80%; `admin.mjs device-cleanup` (what it does; that a run does it anyway).
2. Replace "Rolling back once push is on" with **"Rolling back once notifications are on"**, exactly the spec's "Rolling back" steps: set `pp:push:paused`; `systemctl disable --now penge-check.timer` and wait for `penge-check.service` to be inactive; set `PUSH_MODE=off`, remove `PUSH_OWNER_TOKEN`; copy the current release's server bundle to `/opt/penge/device-cleanup/` (`install -d -o root -g root /opt/penge/device-cleanup && cp -a /opt/penge/current/server/. /opt/penge/device-cleanup/`; a release holds `server/*.mjs` and `web/`, as `deploy/release.sh` packs it), install the drop-in (`install -D -m 0644 deploy/systemd/penge-check.service.d/device-cleanup.conf /etc/systemd/system/penge-check.service.d/device-cleanup.conf && systemctl daemon-reload`); switch the release as "Deploying" says; re-enable the timer. Rolling forward: remove the drop-in and `/opt/penge/device-cleanup/`, `daemon-reload`, deploy, `DEL pp:push:paused`. State what remains (stored alerts stop; already-accepted notifications may still show; a retried deletion gets 404 until rolled forward; email unchanged).
3. A new section **"Leaving the channel design (one maintenance window)"**, the spec's steps 1–5 with the commands: `systemctl disable --now penge-check.timer`, `systemctl show -p ActiveState penge-check.service` until `inactive`, `systemctl stop penge-api`; **stage** the new release without activating it (the deploy workflow's upload and `penge-receive`, as "Deploying" describes, which unpacks it under `/opt/penge/releases/<release>.partial` and stops there; `penge-activate <release>` moves it into place later); run its maintenance commands from that unpacked bundle with production's current `REDIS_URL` (they read nothing else): `set -a; . /etc/penge/server.env; set +a; node /opt/penge/releases/<release>.partial/server/admin.mjs channel-inspect`; backups named `…-expires-YYYYMMDDTHHMMSSZ[.json]` in `/root/penge-backups` (server.env; the subscriber export with the **current** release's `admin.mjs backup`, which runs with the current configuration; and, only if the inspection found anything, the staged release's `admin.mjs channel-dump` to `channel-keys-<stamp>-expires-<stamp>.json`, `chmod 0600`); `admin.mjs channel-clean --yes` only if the inspection found anything (it stops on a subscriber with email off: the owner decides); `server.env` edits (`PUSH_MODE=off`, remove `PUSH_OWNER_EMAILS`, add `PUSH_OWNER_TOKEN`); activate the staged release (`penge-activate <release>`); `systemctl enable --now penge-check.timer`; check a run (`journalctl -u penge-check -n 50`); then `PUSH_MODE=owner` and `systemctl restart penge-api`. The deploy's automatic fallback note from the spec's step 5, and the remaining old-tab case (frozen across the reload, then resumed: the alert ends as gone and the row asks to set up again).
4. "Keys and backups": backups hold email subscribers only, version 1; the importer reads 1 and 2; restores need `EMAIL_ENC_KEY`, `EMAIL_HMAC_KEY`, `TOKEN_SECRET`; restore with the API and checker stopped; after losing Valkey, devices are asked to set up again.
5. "Where a subscriber's address goes" gains the retention lines of the spec's table for notifications, word for word, including deleted data in both the append-only file and `dump.rdb` until both are rewritten. Beside it, how to read the daily report's "Last append-only rewrite known finished" line (a rewrite that started after the first time and finished by the second; data deleted before the first time is out of the AOF), and that turning the AOF off or signalling a running rewrite cancels it without the report noticing, so neither is ever done.
6. "Daily numbers": the `pp:stats:v2:` section and its gauges, and the deploy day's split.

`docs/how-it-works.md` "Alerts by email and push" → **"Alerts: email and notifications"**: the two kinds behind one form; the ready check; Lua scripts as the only writers of `pp:dev:*`; the checker's three passes; queueing in two writes; where each counter lives.

`docs/alert-timing.md`: a section **"Notifications"**: pace across reboots as email's, the daily cap shared in value, a date's original announcement kept, unknown ages dropped (not given a new window, unlike email), one attempt per run, 60 s per batch.

`docs/android.md` "Notifications (version 1.1.0)": notifications need no email; setup shows a "Setting up notifications…" notification first; the Data safety answers (device or other IDs, app functionality, push services as service providers).

`docs/legal/README.md` RA 10173: the personal data notifications process (a push subscription, encrypted; offices, group size, pace next to a random id), its legal basis (consent through the permission prompt), the push services as processors under their own policies, retention as the spec's table.

`apps/server/dev/README.md`: the local stack now sets up notification alerts (`devOrigins`), and how to run `device-flow.mjs`, `old-pages.mjs` and `audit.mjs`.

- [ ] **Step 5: The Mac verification record**

Run Task 20's harness again (`scripts/local-stack.sh up`, then the five commands) and write `docs/superpowers/verification/2026-10-alerts-mac.md`: date, browser versions (from the results JSON), each item of the spec's Verification step 2 with PASS and the screenshot names, and anything that failed and how it was fixed (with its commit). Every item must be PASS before Task 23.

- [ ] **Step 6: Watch everything pass**

Run: `npm test && npm run typecheck && shellcheck -x deploy/*.sh`
Expected: PASS.

- [ ] **Step 7: Codex, commit**

Codex pass (prompt: "Review the runbook and docs against the spec: the maintenance window's steps and table, rollback and roll-forward exactly as specified (pause first, wait for the running check, the pinned bundle and drop-in with its timeout), the emergency stop, the owner link and its revocation, backups and restores, retention word for word from the spec's table, and the privacy and legal texts. Find a step that could lose a subscriber, stop email, or leave notification data beyond its stated life."). Then:

```bash
git add deploy docs apps/server/dev/README.md apps/server/test/units.test.ts apps/server/test/privacy.test.ts
git commit -m "Runbook, docs and legal register for notification alerts; the rollback drop-in; the Mac verification record"
```

---

### Task 23: The owner's phone (owner gate)

Stop and ask the owner before this task: it installs a debug build on their phone and uses their browser. Do not install anything without their yes (memory: "Android emulator testing", "never install on the user's phone unasked").

**Files:**
- Create: `docs/superpowers/verification/2026-10-alerts-phone.md`

- [ ] **Step 1: Ask**

Ask the owner (AskUserQuestion): "Ready to verify notifications on your phone against the local stack over the https proxy: a Chrome tab and the web app installed from that tab. It shows test notifications and reads the screen over adb. (The release app is checked after the deploy, in owner mode, on its real origin.) May I go ahead?" Options: "Yes, go ahead (Recommended)", "Not now".

- [ ] **Step 2: With the yes, run the two contexts**

For a Chrome tab and the web app installed from that tab (the release app is checked against production in Task 24, Step 3, on its verified origin): start the local stack with `PENGE_PHONE_ORIGIN=https://<mac-ip>:8443` so the device routes accept the phone's origin, and open `https://<mac-ip>:8443/pengepassportph/` (the https proxy), turn notifications on (Android's own prompt for the app names it), see "Setting up notifications…" then "Notifications are ready", run `npm run dev:alert -w @penge/server -- --office 486 --date <a published day>`, see the alert notification, tap it (the office opens with the date and group), Change, Send a test, block notifications in Android settings and reopen (the row says blocked and turned off), turn on again, Turn off. Screenshots by `adb exec-out screencap -p`, cropped of anything personal (autofill, accounts) before saving under `docs/superpowers/verification/img/`.

- [ ] **Step 3: Record**

Write `docs/superpowers/verification/2026-10-alerts-phone.md` with each item, PASS/FAIL, and the screenshots. A failure is fixed test-first in the owning task and the phone step repeated. Commit (`git add docs/superpowers/verification && git commit -m "Notifications verified on the owner's phone: Chrome tab and installed web app"`).

---

### Task 24: Rollout (owner gate)

Stop and ask the owner before each step that touches GitHub or the server (memory: push and server changes only with the owner's yes; never rerun `deploy/provision.sh`; never reference the other project on the server).

- [ ] **Step 1: Ask to push and deploy**

Ask: "Everything is verified locally, and on your phone in a Chrome tab and the installed web app. Push the branch to GitHub (CI must pass, including the Valkey job), then run the maintenance window from the runbook's 'Leaving the channel design' with you watching? The release app is checked afterwards, in owner mode, before anything goes live." Options: "Yes (Recommended)", "Not yet".

- [ ] **Step 2: The maintenance window**

Follow `deploy/README.md` "Leaving the channel design (one maintenance window)" step by step, reading each output before the next. Expected along the way: the inspection finds nothing (owner mode only ever served the owner); the subscriber export holds every subscriber (count it against `SCARD pp:subs`); the new release becomes ready; the first checker run logs `check finished` with `healthy: true`; email alerts still go (watch the next opening's email in the journal or the owner's inbox).

- [ ] **Step 3: Owner mode, and the owner's own devices**

Set `PUSH_MODE=owner` with the token and restart `penge-api`. Give the owner the owner link through a channel they choose (never committed, never in a log). The owner closes every tab of the site on every browser that ever opened the old owner link, opens the owner link on the phone (tab, installed app) and the Mac, and sets up notifications.

The release app (spec: "The Android app"), with the owner's yes to install it: the upload-signed `android/out/pengepassportph-2.apk` (`adb install -r`; the serial never written to any file), opened on its verified production origin with the owner link: Android's own permission prompt names the app; the setup and alert notifications are posted by the app's package (`adb shell dumpsys notification --noredact | grep -A3 pengepassportph`, read on the Mac, never saved); tapping opens the office; denied and blocked show the right row. If Chrome does not delegate to the app, notifications still work as Chrome's, and the owner decides whether to ship 1.1.0. Next morning: the daily report shows the notification section with sane numbers.

Record it: `docs/superpowers/verification/2026-10-alerts-release-app.md` with each release-app item above (prompt names the app; setup and alert notifications posted by the app's package; tap opens the office; denied; blocked), PASS/FAIL, the screenshots (cropped as in Task 23), and the next morning's report numbers; commit it (`git add docs/superpowers/verification && git commit -m "Notifications verified in the release app, in owner mode"`). A failure is fixed test-first, released, and this step repeated.

- [ ] **Step 4: Live**

Only with the release-app record all PASS (or, for the delegation item alone, the owner's recorded decision), and with the owner's yes: publish the privacy page (already in the release), set `PUSH_MODE=live`, restart `penge-api`. Android 1.1.0 to Play needs the owner's Play app-signing SHA-256 and support email (memory: Play Store status); the Data safety form as `docs/android.md` says.

- [ ] **Step 5: Record**

Update the memory files (`push-notifications-progress.md` → this redesign's progress; `push-redesign.md`) and the ledger with what was deployed, when, and the backups' expiry dates.

---
