# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Web Push as a second alert channel (beside email) to PengePassportPH's website, installed PWA and Google Play app, verified locally on Mac Chrome, Mac Firefox and the owner's phone before anything reaches the server or GitHub.

**Architecture:** The server keeps one alert decision per person and delivers it to every available channel. Push devices are bound by a credential the browser makes itself; every change to who owns a device is one atomic Valkey script (with a single-step twin in `MemoryKv`) that checks everything before it writes. The web app detects its context, asks for permission inside the click, and shares its push state with the service worker through IndexedDB under one Web Lock. A local stack (Docker Valkey, a capturing mailer, a fake DFA, local HTTPS) runs the real checker for every check before the rollout.

**Tech Stack:** TypeScript, Node 22, Hono, `@redis/client` against Valkey (Lua `EVAL`), `web-push` (new server dependency), React 19 + Vite 8, vitest (+ jsdom, `fake-indexeddb`), Bubblewrap/Gradle for the Android app, Docker (colima) locally.

**Spec:** `docs/superpowers/specs/2026-10-05-push-notifications-design.md` (committed as `5cbae0d`; Codex SPEC READY after 14 passes). Read it before any task; this plan argues from it and does not repeat its reasoning.

## Global Constraints

- Nothing is pushed to GitHub and nothing changes on the server until Tasks 1–18 are done, the Mac verification (Task 17) and the phone gate (Task 18) have passed, and the owner says go (Task 21).
- Run tests through the workspace scripts so each package's own Vitest config loads: `npm test -w @penge/contracts -- <file>`, `npm test -w @penge/server -- <file>`, `npm test -w @penge/web -- <file>`. Typecheck with `npm run typecheck`.
- Before every commit: the package's tests and the typecheck pass; every new test has been seen failing first, and each fix has been broken on purpose once to see its test fail (undo the break before committing); then an adversarial Codex pass on the diff, in the background with a `CODEX-DONE` marker: `codex exec -m gpt-6.1-sol -c model_reasoning_effort="medium" --skip-git-repo-check "$(cat prompt.md)" < /dev/null > out 2> err; echo CODEX-DONE $? >> out`. Fingerprint the repo before and after (`git status --porcelain; git diff | shasum; shasum .secrets/*; ls -R android/out | shasum`): the sandbox flag is not enforced on this machine. Fix every real finding test-first and repeat until Codex says ship.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never source `.secrets/server.env` locally: it points at a cloud Redis and the real R2 bucket. Local runs use the Task 16 stack only. Tests that need a real Valkey run only against the local throwaway instance, guarded as in Task 4.
- Never install anything on the owner's phone (wireless adb, model 2602BPC18G) without asking in that moment.
- Never reference the other project hosted on the server, and never rerun `deploy/provision.sh`; systemd units and Caddy changes are applied by hand.
- No personal email anywhere: examples use `juan@example.com`; `VAPID_SUBJECT` is a dedicated address the owner chooses.
- Write prose (comments, docs, UI copy) the way the repo does: plain words, short sentences.
- `PUSH_MODE` is `off`, `owner` or `live`. No production dry-run for push.
- Push endpoints, keys, credentials and payloads never appear in logs.
- Device ownership changes only through `pushBind`, `pushRegister` and `pushRemove` (Task 4). Every change to a subscriber's devices, including failure cleanup and notes, runs under that subscriber's address lock.
- Allowlisted push hosts: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`. Endpoint and keys are checked before storing and before every send.
- Limits: 5 devices per subscriber; pending and credential-pending 48 h; provisional device keys 72 h; an awaiting device of an existing subscriber is dropped after 48 h; revoked marker 72 h; push TTL 30 min; 8 sends in flight; 5 s per send; 60 s push budget per delivery pass; worker handshake 1 s inside a 10 s overall wait; device calls 600 an hour per network and 300 an hour per credential (turning off is limited per network only); test notifications 3 an hour per device.

## Review Focus

Inputs the spec implies but no other test would hit; each has a test in the task named.

1. **Updating offices from a laptop must not switch off a phone's notifications** (Task 5).
2. **Permission already denied before the sheet opens**: no prompt, a hint, the switch stays off (Task 13).
3. **A browser with `PushManager` that refuses `subscribe()`** (Firefox private windows): the switch turns back off with a reason; email stays on (Task 13).
4. **A notification for 10 offices with many dates** stays under 3 KB (Task 7).
5. **Tapping a notification while the app is open on another office** navigates that window instead of opening another (Task 12).

---

## Phase A: server foundations

### Task 1: Contracts for channels, push subscriptions, preview and status

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Produces:
  - `type PushMode = 'off' | 'owner' | 'live'`, `isPushMode(v): v is PushMode`
  - `interface Channels { emailOn: boolean; pushOn: boolean; pushCredentialHash: string | null; device: string | null }`
  - `SubscribeRequest` gains `channels: Channels | null` (null: a page made before channels)
  - `Field` gains `'channels'`
  - `isCredential(raw): raw is string`, `isCredentialHash(raw): raw is string` (43-character base64url)
  - `interface PushSubscriptionInput { endpoint: string; p256dh: string; auth: string }`, `parsePushSubscription(raw: unknown): PushSubscriptionInput | null` (shape and lengths only; the server checks hosts and the key itself)
  - `interface ConfirmPreview { siteIds: number[]; applicants: number; pace: Pace; channels: { emailOn: boolean; pushOn: boolean; device: string | null; requestedAt: string; pushCredentialHash: string | null; devicesKept: number } | null }`
  - `type PushOutcome = 'bound' | 'kept' | 'skipped-owned' | 'skipped-revoked' | 'skipped-off' | 'none'`
  - `ConfirmResponse` gains `channels: { emailOn: boolean; pushOn: boolean; push: PushOutcome }`
  - `ApiError` gains `code?: 'reload' | 'push-unavailable' | 'full'`
  - `StatusResponse` gains `push: PushMode; vapidPublicKey: string | null`; `isStatusResponse` treats both missing (an old server) as `push: 'off'`, `vapidPublicKey: null`
  - `type DeviceState = 'registered' | 'awaiting' | 'pending' | 'stale' | 'missing' | 'endpoint-taken'`, `isDeviceState(v)`

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/test/contracts.test.ts` (add `isCredentialHash`, `isStatusResponse`, `parsePushSubscription` to its existing import from `../src/index.ts`):

```ts
describe('channels in a subscribe request', () => {
  const base = { email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'hourly' };
  const hash = 'a'.repeat(43);

  it('reads a request from a page that predates channels as null', () => {
    const r = validateSubscribe(base);
    expect(r.ok && r.value.channels).toBeNull();
  });

  it('accepts email only, push only, and both', () => {
    for (const channels of [
      { emailOn: true, pushOn: false },
      { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' },
      { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Firefox on Mac' },
    ]) expect(validateSubscribe({ ...base, channels }).ok).toBe(true);
  });

  it('refuses no channel at all, and push without a credential hash', () => {
    const none = validateSubscribe({ ...base, channels: { emailOn: false, pushOn: false } });
    expect(!none.ok && none.errors.channels).toMatch(/at least one/i);
    const bare = validateSubscribe({ ...base, channels: { emailOn: true, pushOn: true } });
    expect(!bare.ok && bare.errors.channels).toBeTruthy();
  });

  it('refuses a device label that could carry markup, a line break, or is too long', () => {
    for (const device of ['<b>x</b>', 'x'.repeat(61), 'a\nb']) {
      expect(validateSubscribe({ ...base, channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device } }).ok).toBe(false);
    }
  });

  it('checks a credential hash', () => {
    expect(isCredentialHash(hash)).toBe(true);
    expect(isCredentialHash('a'.repeat(42))).toBe(false);
    expect(isCredentialHash(`${'a'.repeat(42)}=`)).toBe(false);
  });
});

describe('status from a server without push', () => {
  it('reads as push off', () => {
    const old: Record<string, unknown> = { checkedAt: null, lastHealthyAt: null, healthy: true, mailLive: true, sites: [] };
    expect(isStatusResponse(old)).toBe(true);
    expect(old.push).toBe('off');
    expect(old.vapidPublicKey).toBeNull();
  });

  it('refuses an unknown push mode', () => {
    expect(isStatusResponse({ checkedAt: null, lastHealthyAt: null, healthy: true, mailLive: true, sites: [], push: 'maybe', vapidPublicKey: null })).toBe(false);
  });
});

describe('push subscription shape', () => {
  const p256dh = Buffer.alloc(65, 4).toString('base64url');
  const auth = Buffer.alloc(16, 1).toString('base64url');

  it('reads the JSON a browser gives', () => {
    expect(parsePushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh, auth } })).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh, auth,
    });
  });

  it('refuses wrong key lengths, a missing endpoint, and anything too long', () => {
    expect(parsePushSubscription({ endpoint: 'https://x', keys: { p256dh: auth, auth } })).toBeNull();
    expect(parsePushSubscription({ keys: { p256dh, auth } })).toBeNull();
    expect(parsePushSubscription({ endpoint: `https://${'x'.repeat(1100)}`, keys: { p256dh, auth } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/contracts`
Expected: FAIL (`isCredentialHash`, `parsePushSubscription` not exported; `channels` undefined; `push` not set).

- [ ] **Step 3: Implement**

In `packages/contracts/src/index.ts`:

```ts
export type PushMode = 'off' | 'owner' | 'live';
export const isPushMode = (v: unknown): v is PushMode => v === 'off' || v === 'owner' || v === 'live';

/** How a person is told: email, push on the device that asked, or both. */
export interface Channels {
  emailOn: boolean;
  pushOn: boolean;
  /** SHA-256 of the credential the asking browser made, base64url. Set when pushOn. */
  pushCredentialHash: string | null;
  /** A coarse label from the user agent, "Chrome on Android", shown before confirming. */
  device: string | null;
}

export interface SubscribeRequest {
  email: string;
  siteIds: number[];
  applicants: number;
  pace: Pace;
  /** Null from a page made before channels existed: change offices, size and pace only. */
  channels: Channels | null;
}

export type Field = 'email' | 'siteIds' | 'applicants' | 'pace' | 'channels' | 'form';

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
/** A credential a browser made: 32 random bytes, base64url. */
export const isCredential = (raw: unknown): raw is string => typeof raw === 'string' && B64URL_43.test(raw);
/** Its SHA-256, base64url: also 43 characters. */
export const isCredentialHash = isCredential;

const DEVICE_LABEL = /^[A-Za-z0-9 .,()'-]{1,60}$/;

function readChannels(raw: unknown): { ok: true; value: Channels | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'Choose how to be told.' };
  const c = raw as Record<string, unknown>;
  if (typeof c.emailOn !== 'boolean' || typeof c.pushOn !== 'boolean') return { ok: false, error: 'Choose how to be told.' };
  if (!c.emailOn && !c.pushOn) return { ok: false, error: 'Turn on at least one: email or notifications.' };
  if (!c.pushOn) return { ok: true, value: { emailOn: c.emailOn, pushOn: false, pushCredentialHash: null, device: null } };
  if (!isCredentialHash(c.pushCredentialHash)) return { ok: false, error: 'Turn notifications on again on this device.' };
  const device = c.device === undefined || c.device === null ? null : c.device;
  if (device !== null && (typeof device !== 'string' || !DEVICE_LABEL.test(device))) {
    return { ok: false, error: 'Turn notifications on again on this device.' };
  }
  return { ok: true, value: { emailOn: c.emailOn, pushOn: true, pushCredentialHash: c.pushCredentialHash, device } };
}
```

Inside `validateSubscribe`, before `if (Object.keys(errors).length > 0)`:

```ts
  const channels = readChannels(body.channels);
  if (!channels.ok) errors.channels = channels.error;
```

and in its returned `value` add `channels: channels.ok ? channels.value : null`.

The push subscription and API types:

```ts
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Base64url (padding allowed) of exactly `n` bytes. */
function isB64urlOf(s: unknown, n: number): s is string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return false;
  const clean = s.replace(/=+$/, '');
  return Math.floor((clean.length * 6) / 8) === n && clean.length === Math.ceil((n * 8) / 6);
}

/** PushSubscription.toJSON(), checked for shape only. The server checks the host and the key. */
export function parsePushSubscription(raw: unknown): PushSubscriptionInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (typeof r.endpoint !== 'string' || r.endpoint.length > 1024 || !r.endpoint.startsWith('https://')) return null;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  if (!isB64urlOf(p256dh, 65) || !isB64urlOf(auth, 16)) return null;
  return { endpoint: r.endpoint, p256dh: p256dh.replace(/=+$/, ''), auth: auth.replace(/=+$/, '') };
}

export interface ConfirmPreview {
  siteIds: number[];
  applicants: number;
  pace: Pace;
  /** Null for a request made before channels existed: email, as always. */
  /**
   * `devicesKept`: how many devices of this address already get notifications and keep
   * them whatever this request says (a request with notifications off adds none, and removes none).
   */
  channels: { emailOn: boolean; pushOn: boolean; device: string | null; requestedAt: string; pushCredentialHash: string | null; devicesKept: number } | null;
}

export type PushOutcome = 'bound' | 'kept' | 'skipped-owned' | 'skipped-revoked' | 'skipped-off' | 'none';

export type DeviceState = 'registered' | 'awaiting' | 'pending' | 'stale' | 'missing' | 'endpoint-taken';
const DEVICE_STATES: readonly DeviceState[] = ['registered', 'awaiting', 'pending', 'stale', 'missing', 'endpoint-taken'];
export const isDeviceState = (v: unknown): v is DeviceState => (DEVICE_STATES as readonly unknown[]).includes(v);
```

Replace `ConfirmResponse` and `ApiError`:

```ts
export interface ConfirmResponse {
  status: 'confirmed' | 'updated';
  siteIds: number[];
  applicants: number;
  pace: Pace;
  channels: { emailOn: boolean; pushOn: boolean; push: PushOutcome };
}

export interface ApiError {
  error: string;
  fields?: Partial<Record<Field, string>>;
  /** reload: an old page; push-unavailable: push could not be turned on and email is off; full: 5 devices already. */
  code?: 'reload' | 'push-unavailable' | 'full';
}
```

In `StatusResponse` add:

```ts
  /** Whether push can be turned on: off, only for the owner's test addresses, or for everyone. */
  push: PushMode;
  /** The VAPID public key browsers subscribe with; null when push is off. */
  vapidPublicKey: string | null;
```

In `isStatusResponse`, inside the guard after the value is known to be an object (use the guard's own local name for it; below it is `v`), before the other checks:

```ts
  // A server from before push says nothing about it: that is push off.
  if (v.push === undefined) v.push = 'off';
  if (v.vapidPublicKey === undefined) v.vapidPublicKey = null;
  if (!isPushMode(v.push) || (v.vapidPublicKey !== null && typeof v.vapidPublicKey !== 'string')) return false;
```

- [ ] **Step 4: Fix everything the new required fields break, in this task**

Run: `npm run typecheck`. Fix every error here, so the gate passes before Task 2:
- Where a `SubscribeRequest` is built without `channels` (server tests calling `createPending`, the web's `AlertSheet`): add `channels: null` (JSON `null` reads as "a page from before channels", like a missing field).
- The stored status: `api.ts` and `checker.ts` parse `pp:status` as `Omit<StatusResponse, 'mailLive'>`. Add to `checker.ts` `export type StoredStatus = Omit<StatusResponse, 'mailLive' | 'push' | 'vapidPublicKey'>;` and use it in those three places.
- `/api/status` in `api.ts` adds `push: 'off', vapidPublicKey: null` to its answer (Task 6 reads the real values).
- `/api/confirm` in `api.ts` adds `channels: { emailOn: true, pushOn: false, push: 'none' }` to its answer (Task 6 returns the real ones).
- The web's `test/helpers.tsx`: `STATUS` gains `push: 'off', vapidPublicKey: null`; `fakeApi().confirm` answers with `channels: { emailOn: true, pushOn: false, push: 'none' as const }`. `api.ts`'s `isConfirm` accepts the new field (it may be checked loosely until Task 13).

Then the existing exact assertions that the new fields change at run time (the typecheck does not catch these):
- `packages/contracts/test/contracts.test.ts`, "accepts a normal request": the expected `value` gains `channels: null`.
- `apps/server/test/api.test.ts`, the confirm answer: `toEqual({ status: 'confirmed', siteIds: [486, 693], applicants: 2, pace: 'hourly', channels: { emailOn: true, pushOn: false, push: 'none' } })`.
- `apps/web/test/sheet.test.tsx` (the request the form sends) and `apps/web/test/pages.test.tsx` (the Dubai request): each `toHaveBeenCalledWith({ … })` gains `channels: null`. The sheet's fuzz test needs nothing here: its oracle and the form both go through `validateSubscribe`, which now returns `channels: null` for both.

- [ ] **Step 5: Run every test**

Run: `npm test -w @penge/contracts && npm test -w @penge/server && npm test -w @penge/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Codex pass, then commit**

```bash
git add packages/contracts apps
git commit -m "Contracts for alert channels, push subscriptions and confirmation previews

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Configuration, keys and a `persist` write

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/keys.ts`, `apps/server/src/kv.ts`, `deploy/server.env.example`
- Test: `apps/server/test/units.test.ts`, `apps/server/test/kv.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface PushConfig { mode: PushMode; vapid: { publicKey: string; privateKey: string; subject: string } | null; ownerEmails: string[] }`; `Config.push: PushConfig`
  - `K.pushDevices(id)`, `K.pushMeta(id)`, `K.pushAddress(id)`, `K.pushEndpoint(hmac)`, `K.pushCred(hash)`, `K.pushPending(hash)`, `K.pushRevoked(hash)`, `K.pendingChannels`, `K.reserved(index)`, `K.pushPaused`, `K.pushTestMark`
  - `WriteOp` gains `{ op: 'persist'; key: string }`

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/units.test.ts`, in the existing config `describe` (it already has an `env` object with the required variables):

```ts
  it('keeps push off unless every push setting is there', () => {
    expect(loadConfig(env).push).toEqual({ mode: 'off', vapid: null, ownerEmails: [] });
    expect(() => loadConfig({ ...env, PUSH_MODE: 'live' })).toThrow(/VAPID_PUBLIC_KEY/);
    expect(() => loadConfig({ ...env, PUSH_MODE: 'sometimes' })).toThrow(/PUSH_MODE/);
  });

  it('reads push settings, and owner mode needs owner addresses', () => {
    const vapid = { VAPID_PUBLIC_KEY: 'B'.repeat(87), VAPID_PRIVATE_KEY: 'p'.repeat(43), VAPID_SUBJECT: 'mailto:alerts@example.com' };
    expect(() => loadConfig({ ...env, ...vapid, PUSH_MODE: 'owner' })).toThrow(/PUSH_OWNER_EMAILS/);
    const c = loadConfig({ ...env, ...vapid, PUSH_MODE: 'owner', PUSH_OWNER_EMAILS: 'Juan@Example.com, ana@example.com' });
    expect(c.push.mode).toBe('owner');
    expect(c.push.ownerEmails).toEqual(['juan@example.com', 'ana@example.com']);
    expect(() => loadConfig({ ...env, ...vapid, PUSH_MODE: 'live', VAPID_SUBJECT: 'https://x' })).toThrow(/VAPID_SUBJECT/);
  });
```

Create `apps/server/test/kv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryKv } from '../src/kv.ts';
import { clock } from './helpers.ts';

describe('MemoryKv persist', () => {
  it('removes a key expiry, as PERSIST does', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    await kv.set('k', 'v', { ttlSeconds: 10 });
    await kv.write([{ op: 'persist', key: 'k' }]);
    t.advance(60_000);
    expect(await kv.get('k')).toBe('v');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/server -- test/units.test.ts test/kv.test.ts`
Expected: FAIL (`push` is undefined; `persist` is not an op).

- [ ] **Step 3: Implement**

`config.ts`: import `isPushMode`, `type PushMode` from `@penge/contracts` beside `normalizeEmail`; add `PushConfig` (as in Interfaces) and `push: PushConfig` to `Config`; in `loadConfig`, after the mail settings:

```ts
  const pushModeRaw = env.PUSH_MODE?.trim() || 'off';
  if (!isPushMode(pushModeRaw)) throw new ConfigError('PUSH_MODE must be off, owner or live');
  let push: PushConfig = { mode: 'off', vapid: null, ownerEmails: [] };
  if (pushModeRaw !== 'off') {
    const publicKey = need('VAPID_PUBLIC_KEY');
    const privateKey = need('VAPID_PRIVATE_KEY');
    const subject = need('VAPID_SUBJECT');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)) throw new ConfigError('VAPID_PUBLIC_KEY is not a VAPID public key');
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(privateKey)) throw new ConfigError('VAPID_PRIVATE_KEY is not a VAPID private key');
    if (!subject.startsWith('mailto:') || !normalizeEmail(subject.slice(7))) throw new ConfigError('VAPID_SUBJECT must be mailto: and an address');
    const listed = (env.PUSH_OWNER_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const ownerEmails = listed.map((s) => normalizeEmail(s));
    if (ownerEmails.some((e) => e === null)) throw new ConfigError('PUSH_OWNER_EMAILS has an address that is not valid');
    if (pushModeRaw === 'owner' && ownerEmails.length === 0) throw new ConfigError('PUSH_MODE=owner needs PUSH_OWNER_EMAILS');
    push = { mode: pushModeRaw, vapid: { publicKey, privateKey, subject }, ownerEmails: ownerEmails as string[] };
  }
```

and `push` in the returned object.

`keys.ts`, in `K`:

```ts
  /** Hash: device id → sealed device (endpoint and keys, label, created, last success, last failure). */
  pushDevices: (subscriberId: string) => `${P}push:${subscriberId}`,
  /** Hash: device id → "state|revision|credential hash|endpoint hmac|subscription hmac"; what the scripts compare. */
  pushMeta: (subscriberId: string) => `${P}push:meta:${subscriberId}`,
  /** "<subscriber id>/<device id>": one owner per endpoint. */
  pushEndpoint: (endpointHmac: string) => `${P}push:endpoint:${endpointHmac}`,
  /** "<subscriber id>/<device id>": one owner per credential. */
  pushCred: (credentialHash: string) => `${P}push:cred:${credentialHash}`,
  /** Set of pending-token hashes asking push for this credential; 48 h. */
  pushPending: (credentialHash: string) => `${P}push:pending:${credentialHash}`,
  /** A credential turned off; 72 h, longer than any confirmation link. */
  pushRevoked: (credentialHash: string) => `${P}push:revoked:${credentialHash}`,
  /** Set of "<token hash>|<address index>" for pending requests that change channels (push-downgrade reads it). */
  pendingChannels: `${P}pending:channels`,
  /** The subscriber id an address will get while it has none. */
  reserved: (index: string) => `${P}reserved:${index}`,
  /** The operator's emergency stop for push alone. */
  pushPaused: `${P}push:paused`,
  /** The address index a provisional subscriber id belongs to; written with its first device, gone when the subscriber exists. */
  pushAddress: (subscriberId: string) => `${P}push:address:${subscriberId}`,
  /** Present only in a throwaway local Valkey: tests that wipe data refuse any other. */
  pushTestMark: `${P}test:disposable`,
```

`kv.ts`: add `| { op: 'persist'; key: string }` to `WriteOp`; in the Redis `write` switch:

```ts
          case 'persist':
            multi.persist(op.key);
            break;
```

and in `MemoryKv.write`:

```ts
        case 'persist': {
          const entry = this.entry(op.key);
          if (entry) entry.expiresAt = null;
          break;
        }
```

`deploy/server.env.example`, after `MAIL_DAILY_LIMIT`:

```sh
# Push notifications (deploy/README.md, "Push notifications"): off, owner or live.
PUSH_MODE=off
# npx web-push generate-vapid-keys; keep an offline copy of the private key.
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
# A monitored address of the site, never a personal one.
VAPID_SUBJECT=mailto:alerts@example.com
# PUSH_MODE=owner only: who may turn push on while it is being tested.
PUSH_OWNER_EMAILS=
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @penge/server && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Codex pass, then commit** (`Push settings, keys and a persist write`, with the attribution line).

---

### Task 3: Endpoint checks, labelled sealing, and log-safe push errors

**Files:**
- Modify: `apps/server/src/crypto.ts`, `apps/server/test/helpers.ts`
- Create: `apps/server/src/push/endpoint.ts`, `apps/server/src/push/errors.ts`
- Test: `apps/server/test/push-endpoint.test.ts`

**Interfaces:**
- Consumes: `parsePushSubscription`, `PushSubscriptionInput` (Task 1).
- Produces:
  - `seal(plain, key, label): string`, `unseal(sealed, key, label): string` (AES-256-GCM with `label` as associated data; format `v2.<base64url>`)
  - `keyedHash(key, label, value): string` (HMAC-SHA256, base64url, 43 characters)
  - `PUSH_HOSTS`, `checkPushSubscription(raw: unknown): PushSubscriptionInput | null` (allowlisted host, HTTPS on the default port, no user info, and a `p256dh` that is a valid uncompressed P-256 point)
  - `endpointHmac(key, endpoint)`, `subscriptionHmac(key, s)`
  - `interface PushFailure { status: number | null; category: 'gone' | 'refused' | 'too-big' | 'uncertain' }`, `classifyPushError(err: unknown): PushFailure`
  - In `test/helpers.ts`: `PUSH_KEYS: { p256dh: string; auth: string }` (a real P-256 public key and 16 random bytes), `fcmSubscription(id?: string): { endpoint; keys: { p256dh; auth } }`

- [ ] **Step 1: Add the test keys to the helpers**

In `apps/server/test/helpers.ts`:

```ts
import { createECDH } from 'node:crypto';

/** A real P-256 public key and auth secret, as a browser would send them. */
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
export const PUSH_KEYS = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
export const fcmSubscription = (id = randomBytes(8).toString('hex')) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: { ...PUSH_KEYS },
});
```

- [ ] **Step 2: Write the failing tests**

`apps/server/test/push-endpoint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keyedHash, seal, unseal } from '../src/crypto.ts';
import { line } from '../src/log.ts';
import { checkPushSubscription, endpointHmac, subscriptionHmac } from '../src/push/endpoint.ts';
import { classifyPushError } from '../src/push/errors.ts';
import { keys, PUSH_KEYS } from './helpers.ts';

const sub = (endpoint: string, p256dh = PUSH_KEYS.p256dh) => ({ endpoint, keys: { p256dh, auth: PUSH_KEYS.auth } });

describe('push endpoints', () => {
  it('accepts the browsers push services', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://db5p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/QAbc',
    ]) expect(checkPushSubscription(sub(e))).not.toBeNull();
  });

  it('refuses anything that could make the server call somewhere else', () => {
    for (const e of [
      'http://fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://notify.windows.com.evil/x',
      'https://push.apple.com/x',
    ]) expect(checkPushSubscription(sub(e))).toBeNull();
  });

  it('gives equivalent spellings of one endpoint one canonical form, and refuses fragments', () => {
    const a = checkPushSubscription(sub('https://FCM.googleapis.com:443/fcm/send/abc'))!;
    const b = checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc'))!;
    expect(a.endpoint).toBe(b.endpoint);
    expect(endpointHmac(keys.index, a.endpoint)).toBe(endpointHmac(keys.index, b.endpoint));
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc#x'))).toBeNull();
  });

  it('refuses a key that is not a P-256 point', () => {
    const notUncompressed = Buffer.from(PUSH_KEYS.p256dh, 'base64url');
    notUncompressed[0] = 0x02;
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/x', notUncompressed.toString('base64url')))).toBeNull();
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/x', Buffer.alloc(65, 4).toString('base64url')))).toBeNull();
  });

  it('hashes an endpoint, and a whole subscription differently when only the keys change', () => {
    const a = checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc'))!;
    const b = { ...a, auth: Buffer.alloc(16, 2).toString('base64url') };
    expect(endpointHmac(keys.index, a.endpoint)).toBe(endpointHmac(keys.index, b.endpoint));
    expect(subscriptionHmac(keys.index, a)).not.toBe(subscriptionHmac(keys.index, b));
  });
});

describe('sealing with a label', () => {
  it('opens only with the same label', () => {
    const s = seal('secret', keys.email, 'push:v1');
    expect(s).toMatch(/^v2\.[A-Za-z0-9_-]+$/);
    expect(unseal(s, keys.email, 'push:v1')).toBe('secret');
    expect(() => unseal(s, keys.email, 'email:v1')).toThrow();
    expect(keyedHash(keys.index, 'x', 'y')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('push errors in logs', () => {
  it('keeps only a status and a category', () => {
    const err = Object.assign(new Error('Received unexpected response code'), {
      statusCode: 410,
      endpoint: 'https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT',
      body: '{"reason":"secret body"}',
      headers: { authorization: 'vapid t=SECRET' },
    });
    const summary = classifyPushError(err);
    expect(summary).toEqual({ status: 410, category: 'gone' });
    expect(line('warn', 'push failed', { push: summary })).not.toMatch(/SECRET|secret body/);
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 404 })).category).toBe('gone');
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 413 })).category).toBe('too-big');
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 429 })).category).toBe('refused');
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 503 })).category).toBe('refused');
    expect(classifyPushError(new Error('Socket timeout'))).toEqual({ status: null, category: 'uncertain' });
    expect(classifyPushError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).category).toBe('uncertain');
    expect(classifyPushError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).category).toBe('refused');
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -w @penge/server -- test/push-endpoint.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement**

`crypto.ts`, after `decryptEmail`:

```ts
/** AES-256-GCM with `label` as associated data: a value sealed for one purpose never opens as another. */
export function seal(plain: string, key: Buffer, label: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(label));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v2.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

export function unseal(sealed: string, key: Buffer, label: string): string {
  const [version, payload] = sealed.split('.');
  if (version !== 'v2' || !payload) throw new Error('unknown sealed format');
  const raw = Buffer.from(payload, 'base64url');
  if (raw.length < 12 + 16 + 1) throw new Error('sealed value is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(label));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}

/** A keyed hash for one purpose: without the key it reveals nothing. */
export function keyedHash(key: Buffer, label: string, value: string): string {
  return createHmac('sha256', key).update(`${label}:${value}`).digest('base64url');
}
```

`push/endpoint.ts`:

```ts
// Where the server may send a push: only the browsers' push services, over
// HTTPS on the default port, to a key that really is a P-256 point. Anything
// else could make the server call an address a visitor chose (SSRF), or fail
// later when the message is encrypted.
import { createECDH } from 'node:crypto';
import { parsePushSubscription, type PushSubscriptionInput } from '@penge/contracts';
import { keyedHash } from '../crypto.ts';

/** Exact hosts, and suffixes (".notify.windows.com") for services that shard by host. */
export const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'] as const;

const allowedHost = (host: string) => PUSH_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));

function isP256Point(b64: string): boolean {
  const point = Buffer.from(b64, 'base64url');
  if (point.length !== 65 || point[0] !== 0x04) return false;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(point); // throws for a point that is not on the curve
    return true;
  } catch {
    return false;
  }
}

export function checkPushSubscription(raw: unknown): PushSubscriptionInput | null {
  const s = parsePushSubscription(raw);
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.hash) return null;
  if (!allowedHost(url.hostname)) return null;
  if (!isP256Point(s.p256dh)) return null;
  // One spelling per endpoint (lower-case host, no default port), so the same
  // push resource always hashes the same and has one owner.
  return { ...s, endpoint: url.href };
}

export const endpointHmac = (key: Buffer, endpoint: string) => keyedHash(key, 'push-endpoint', endpoint);
export const subscriptionHmac = (key: Buffer, s: PushSubscriptionInput) => keyedHash(key, 'push-subscription', `${s.endpoint}\n${s.p256dh}\n${s.auth}`);
```

`push/errors.ts`:

```ts
// What a failed push may put in a log: a status and a category. web-push's
// errors carry the endpoint, the response body and the request headers,
// none of which may be logged.
export interface PushFailure {
  status: number | null;
  category: 'gone' | 'refused' | 'too-big' | 'uncertain';
}

/** Connection errors that mean the request never reached the push service. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED']);

export function classifyPushError(err: unknown): PushFailure {
  const e = (err ?? {}) as { statusCode?: unknown; code?: unknown };
  const status = typeof e.statusCode === 'number' ? e.statusCode : null;
  if (status === 404 || status === 410) return { status, category: 'gone' };
  if (status === 413) return { status, category: 'too-big' };
  if (status !== null) return { status, category: 'refused' };
  if (typeof e.code === 'string' && NEVER_SENT.has(e.code)) return { status: null, category: 'refused' };
  return { status: null, category: 'uncertain' };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @penge/server && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Codex pass, then commit** (`Push endpoint checks, labelled sealing and log-safe push errors`).

---

### Task 4: Atomic device operations (`pushBind`, `pushRegister`, `pushRemove`)

**Files:**
- Modify: `apps/server/src/kv.ts`
- Create: `apps/server/src/push/atomic.ts`
- Test: `apps/server/test/push-atomic.test.ts`

**Interfaces:**
- Consumes: `K` (Task 2).
- Produces:
  - In `kv.ts`:
    - `interface ScriptTx { type(key): 'none' | 'string' | 'hash' | 'set' | 'list' | 'other'; get(key): string | null; set(key, value): void; del(key): void; exists(key): boolean; ttl(key): number /* -2 missing, -1 none, else seconds */; expire(key, seconds): void; hGet(key, field): string | null; hSet(key, field, value): void; hDel(key, field): void; hLen(key): number }` (hash methods throw `WRONGTYPE` on a key of another type, as Valkey does)
    - `interface ScriptDef { name: string; lua: string; memory(tx: ScriptTx, keys: string[], args: string[]): string }`
    - `Kv.script(def: ScriptDef, keys: string[], args: string[]): Promise<string>`
  - In `push/atomic.ts`:
    - `interface Meta { state: 'a' | 'r'; revision: number; credentialHash: string; endpointHmac: string; subscriptionHmac: string }`, `parseMeta(raw)`, `formatMeta(m)`
    - `pushBind(kv, a: { subscriberId; deviceId; credentialHash; sealedAwaiting; addressIndex; provisionalTtlSeconds; maxDevices }): Promise<'bound' | 'kept' | 'owned' | 'revoked' | 'full'>` (for a subscriber that does not exist yet it also writes `pp:push:address:<id>` = the address index, with the same expiry, so a turn-off can always take that address's lock)
    - `pushRegister(kv, a: { subscriberId; deviceId; revision; endpointHmac; subscriptionHmac; sealed }): Promise<'registered' | 'stale' | 'missing' | 'endpoint-taken'>`
    - `pushRemove(kv, a: { subscriberId; deviceId; revokeSeconds; onlyIfEndpointHmac: string | null; onlyIfAwaiting?: boolean }): Promise<'removed' | 'kept' | 'missing'>`
    - `revokeCredential(kv, credentialHash, seconds): Promise<void>` (sets the revoked marker; one `SET … EX`)
    - `PROVISIONAL_TTL_SECONDS = 259200`, `REVOKED_TTL_SECONDS = 259200`, `MAX_DEVICES = 5`

Every script first checks the type of every key it touches (and the shape of any metadata it reads), and returns `'wrongtype'` (the wrapper throws) before its first write. All writes come last, and none of them can fail on its inputs.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/push-atomic.test.ts` runs every case on `MemoryKv`, and on a throwaway local Valkey when `PUSH_TEST_VALKEY` is set. The Valkey target refuses to run unless the URL is on `127.0.0.1` and the database holds the disposable mark that the local stack (Task 16) or the command in Step 6 sets:

```ts
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { connectRedis, type Kv, MemoryKv, type WriteOp } from '../src/kv.ts';
import { MAX_DEVICES, parseMeta, PROVISIONAL_TTL_SECONDS, pushBind, pushRegister, pushRemove, revokeCredential } from '../src/push/atomic.ts';

const ttl = (kv: Kv, key: string) =>
  kv.script({ name: 'ttl', lua: "return tostring(redis.call('TTL', KEYS[1]))", memory: (tx, k) => String(tx.ttl(k[0]!)) }, [key], []).then(Number);

async function disposableValkey(url: string): Promise<Kv> {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1') throw new Error('PUSH_TEST_VALKEY must be a local throwaway Valkey on 127.0.0.1');
  const kv = await connectRedis(url, () => {});
  if ((await kv.get(K.pushTestMark)) !== '1') throw new Error('this Valkey is not marked disposable; refusing to wipe it');
  await kv.script({ name: 'wipe', lua: "redis.call('FLUSHDB') redis.call('SET', KEYS[1], '1') return 'ok'", memory: () => 'ok' }, [K.pushTestMark], []);
  return kv;
}

const targets: [string, () => Promise<Kv>][] = [['MemoryKv', async () => new MemoryKv()]];
if (process.env.PUSH_TEST_VALKEY) targets.push(['Valkey', () => disposableValkey(process.env.PUSH_TEST_VALKEY!)]);

const subscriber = (kv: Kv, ...ids: string[]) => kv.write(ids.map((id) => ({ op: 'hSet' as const, key: K.subscriber(id), fields: { email: 'x' } })));
const bind = (kv: Kv, sub: string, dev: string, cred: string) =>
  pushBind(kv, { subscriberId: sub, deviceId: dev, credentialHash: cred, sealedAwaiting: 'v2.awaiting', addressIndex: 'idx', provisionalTtlSeconds: PROVISIONAL_TTL_SECONDS, maxDevices: MAX_DEVICES });
const register = (kv: Kv, sub: string, dev: string, revision: number, ep: string, sh: string) =>
  pushRegister(kv, { subscriberId: sub, deviceId: dev, revision, endpointHmac: ep, subscriptionHmac: sh, sealed: `v2.${ep}${sh}` });
const remove = (kv: Kv, sub: string, dev: string, o: { revoke?: boolean; only?: string; awaiting?: boolean } = {}) =>
  pushRemove(kv, { subscriberId: sub, deviceId: dev, revokeSeconds: o.revoke ? 3600 : 0, onlyIfEndpointHmac: o.only ?? null, ...(o.awaiting ? { onlyIfAwaiting: true } : {}) });

for (const [name, make] of targets) {
  describe(`push devices on ${name}`, () => {
    it('binds a credential once, keeps it for the same owner, refuses another owner', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('bound');
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('kept');
      expect(await bind(kv, 'B', 'd2', 'c1')).toBe('owned');
      expect(parseMeta((await kv.hGetAll(K.pushMeta('A'))).d1!)).toMatchObject({ state: 'a', credentialHash: 'c1' });
    });

    it('never binds a revoked credential', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      await revokeCredential(kv, 'c1', 3600);
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('revoked');
      expect(await bind(kv, 'B', 'd2', 'c1')).toBe('revoked');
      expect(await kv.get(K.pushCred('c1'))).toBeNull();
    });

    it('turns a device off and revokes its credential in one step, so no other subscriber can take it', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      await bind(kv, 'A', 'd1', 'c1');
      expect(await remove(kv, 'A', 'd1', { revoke: true })).toBe('removed');
      expect(await bind(kv, 'B', 'd2', 'c1')).toBe('revoked');
    });

    it('lets two subscribers race for one credential and gives it to exactly one', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      const results = await Promise.all([bind(kv, 'A', 'd1', 'c1'), bind(kv, 'B', 'd2', 'c1')]);
      expect(results.sort()).toEqual(['bound', 'owned']);
    });

    it('gives a device of a subscriber that does not exist yet a limited life, and extends the reservation', async () => {
      const kv = await make();
      await kv.set(K.reserved('idx'), 'A', { ttlSeconds: 60 });
      expect(await bind(kv, 'A', 'd1', 'c1')).toBe('bound');
      for (const key of [K.pushMeta('A'), K.pushDevices('A'), K.pushCred('c1'), K.reserved('idx'), K.pushAddress('A')]) {
        expect(await ttl(kv, key)).toBeGreaterThan(PROVISIONAL_TTL_SECONDS - 5);
      }
    });

    it('refuses a sixth device', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      for (let i = 0; i < MAX_DEVICES; i++) expect(await bind(kv, 'A', `d${i}`, `c${i}`)).toBe('bound');
      expect(await bind(kv, 'A', 'd9', 'c9')).toBe('full');
    });

    it('registers by revision: higher applies, same is a repeat, lower or same-with-new-keys is stale', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's1')).toBe('registered');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's1')).toBe('registered');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's2')).toBe('stale');
      expect(await register(kv, 'A', 'd1', 2, 'e2', 's3')).toBe('registered');
      expect(await register(kv, 'A', 'd1', 1, 'e1', 's1')).toBe('stale');
      expect(await kv.get(K.pushEndpoint('e1'))).toBeNull();
      expect(await kv.get(K.pushEndpoint('e2'))).toBe('A/d1');
    });

    it('gives an endpoint one owner even when two subscribers register it at once', async () => {
      const kv = await make();
      await subscriber(kv, 'A', 'B');
      await bind(kv, 'A', 'd1', 'c1');
      await bind(kv, 'B', 'd2', 'c2');
      const results = await Promise.all([register(kv, 'A', 'd1', 1, 'e1', 's1'), register(kv, 'B', 'd2', 1, 'e1', 's1')]);
      expect(results.sort()).toEqual(['endpoint-taken', 'registered']);
    });

    it('frees an endpoint whose owner no longer exists', async () => {
      const kv = await make();
      await subscriber(kv, 'B');
      await kv.set(K.pushEndpoint('e1'), 'GONE/d0');
      await bind(kv, 'B', 'd2', 'c2');
      expect(await register(kv, 'B', 'd2', 1, 'e1', 's1')).toBe('registered');
    });

    it('a late 410 removes a device only if it still has the endpoint that was sent to', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      await register(kv, 'A', 'd1', 1, 'e1', 's1');
      await register(kv, 'A', 'd1', 2, 'e2', 's2');
      expect(await remove(kv, 'A', 'd1', { only: 'e1' })).toBe('kept');
      expect(await remove(kv, 'A', 'd1', { only: 'e2' })).toBe('removed');
      expect(await kv.get(K.pushEndpoint('e2'))).toBeNull();
      expect(await kv.get(K.pushCred('c1'))).toBeNull();
      expect(await kv.hGetAll(K.pushDevices('A'))).toEqual({});
    });

    it('removes an awaiting device only while it is still awaiting', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      await register(kv, 'A', 'd1', 1, 'e1', 's1');
      expect(await remove(kv, 'A', 'd1', { awaiting: true })).toBe('kept');
    });

    it('is a no-op when repeated after success (a lost answer)', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      await register(kv, 'A', 'd1', 1, 'e1', 's1');
      expect(await remove(kv, 'A', 'd1')).toBe('removed');
      expect(await remove(kv, 'A', 'd1')).toBe('missing');
    });

    it('refuses bad input before writing anything', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await bind(kv, 'A', 'd1', 'c1');
      const before = JSON.stringify([await kv.hGetAll(K.pushMeta('A')), await kv.get(K.pushCred('c1'))]);
      await expect(pushRegister(kv, { subscriberId: 'A', deviceId: 'd|1', revision: 1, endpointHmac: 'e', subscriptionHmac: 's', sealed: 'v2.x' })).rejects.toThrow(/bad/);
      await expect(pushRegister(kv, { subscriberId: 'A', deviceId: 'd1', revision: -1, endpointHmac: 'e', subscriptionHmac: 's', sealed: 'v2.x' })).rejects.toThrow(/bad/);
      await expect(pushBind(kv, { subscriberId: 'A', deviceId: 'd2', credentialHash: 'c2', sealedAwaiting: 'v2.x', addressIndex: 'i', provisionalTtlSeconds: 0, maxDevices: 5 })).rejects.toThrow(/bad/);
      expect(JSON.stringify([await kv.hGetAll(K.pushMeta('A')), await kv.get(K.pushCred('c1'))])).toBe(before);
    });

    it('changes nothing when a key it would write has the wrong type', async () => {
      const kv = await make();
      await subscriber(kv, 'A');
      await kv.set(K.pushDevices('A'), 'not a hash');
      await expect(bind(kv, 'A', 'd1', 'c1')).rejects.toThrow(/wrongtype/i);
      expect(await kv.get(K.pushCred('c1'))).toBeNull();
      expect(await kv.hGetAll(K.pushMeta('A'))).toEqual({});
    });
  });
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/server -- test/push-atomic.test.ts`
Expected: FAIL (`kv.script` and `push/atomic.ts` missing).

- [ ] **Step 3: Implement `Kv.script`**

In `kv.ts` add the two interfaces from Interfaces, and `script(def: ScriptDef, keys: string[], args: string[]): Promise<string>;` to `Kv`.

Redis side, in the object `connectRedis` returns:

```ts
    async script(def, keys, args) {
      return String(await client.eval(def.lua, { keys, arguments: args }));
    },
```

`MemoryKv` side. Its body runs synchronously, so nothing interleaves, which is what a Lua script gives on Valkey. Hash methods throw on other types, as Valkey's do:

```ts
  async script(def: ScriptDef, keys: string[], args: string[]): Promise<string> {
    const hashOf = (key: string, create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof Map)) throw new Error(`WRONGTYPE ${key}`);
      if (!e && create) return this.typed(key, () => new Map<string, string>(), (v) => v instanceof Map);
      return (e?.value as Map<string, string> | undefined) ?? null;
    };
    const tx: ScriptTx = {
      type: (key) => {
        const e = this.entry(key);
        if (!e) return 'none';
        if (typeof e.value === 'string') return 'string';
        if (e.value instanceof Map) return 'hash';
        if (e.value instanceof Hll) return 'string';
        if (e.value instanceof Set) return 'set';
        return Array.isArray(e.value) ? 'list' : 'other';
      },
      get: (key) => this.string(key),
      set: (key, value) => void this.data.set(key, { value, expiresAt: null }),
      del: (key) => void this.data.delete(key),
      exists: (key) => this.entry(key) !== undefined,
      ttl: (key) => {
        const e = this.entry(key);
        if (!e) return -2;
        return e.expiresAt === null ? -1 : Math.ceil((e.expiresAt - this.now()) / 1000);
      },
      expire: (key, seconds) => {
        const e = this.entry(key);
        if (e) e.expiresAt = this.now() + seconds * 1000;
      },
      hGet: (key, field) => hashOf(key, false)?.get(field) ?? null,
      hSet: (key, field, value) => void hashOf(key, true)!.set(field, value),
      hDel: (key, field) => {
        hashOf(key, false)?.delete(field);
        this.tidy(key);
      },
      hLen: (key) => hashOf(key, false)?.size ?? 0,
    };
    return def.memory(tx, keys, args);
  }
```

- [ ] **Step 4: Implement the operations**

`push/atomic.ts`:

```ts
// Every change to who owns a push device is one of these operations. On
// Valkey each is one Lua script, so nothing runs between its parts. A Lua
// error does not undo writes already made, so each script first checks the
// type of every key it touches and the shape of what it reads, and writes
// only at the end. MemoryKv runs the same steps in one synchronous call.
// Scripts never read the sealed device (Lua cannot decrypt); they compare the
// metadata, which holds no secret.
import { K } from '../keys.ts';
import type { Kv, ScriptDef, ScriptTx } from '../kv.ts';

export const PROVISIONAL_TTL_SECONDS = 72 * 3600;
export const REVOKED_TTL_SECONDS = 72 * 3600;
export const MAX_DEVICES = 5;

export interface Meta {
  state: 'a' | 'r';
  revision: number;
  credentialHash: string;
  endpointHmac: string;
  subscriptionHmac: string;
}

const META = /^([ar])\|(\d+)\|([A-Za-z0-9_-]*)\|([A-Za-z0-9_-]*)\|([A-Za-z0-9_-]*)$/;
export const formatMeta = (m: Meta) => [m.state, m.revision, m.credentialHash, m.endpointHmac, m.subscriptionHmac].join('|');
export function parseMeta(raw: string): Meta {
  const m = META.exec(raw);
  if (!m) throw new Error('bad device metadata');
  return { state: m[1] as 'a' | 'r', revision: Number(m[2]), credentialHash: m[3]!, endpointHmac: m[4]!, subscriptionHmac: m[5]! };
}

const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const SEALED = /^v2\.[A-Za-z0-9_-]{1,4096}$/;
function check(values: Record<string, string>) {
  for (const [name, v] of Object.entries(values)) {
    const ok = name === 'sealed' || name === 'sealedAwaiting' ? SEALED.test(v) : SAFE.test(v);
    if (!ok) throw new Error(`bad ${name}`);
  }
}
const positive = (name: string, n: number, min = 1) => {
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`bad ${name}`);
};
const answer = <T extends string>(raw: string): T => {
  if (raw === 'wrongtype') throw new Error('WRONGTYPE: a push key has the wrong type; nothing was changed');
  return raw as T;
};

// Lua helpers shared by the scripts.
const LUA = `
local function typeOk(key, want)
  local t = redis.call('TYPE', key).ok
  return t == 'none' or t == want
end
local function meta(raw)
  return string.match(raw, '^([ar])|(%d+)|([%w_-]*)|([%w_-]*)|([%w_-]*)$')
end
local function ownerAlive(owner, metaPrefix)
  local s, d = string.match(owner, '^([^/]+)/(.+)$')
  if not s then return false end
  local mk = metaPrefix .. s
  if redis.call('TYPE', mk).ok ~= 'hash' then return false end
  return redis.call('HEXISTS', mk, d) == 1
end
`;

function ownerAlive(tx: ScriptTx, owner: string, metaPrefix: string): boolean {
  const slash = owner.indexOf('/');
  if (slash <= 0) return false;
  const mk = `${metaPrefix}${owner.slice(0, slash)}`;
  if (tx.type(mk) !== 'hash') return false;
  return tx.hGet(mk, owner.slice(slash + 1)) !== null;
}
const typeOk = (tx: ScriptTx, key: string, want: string) => {
  const t = tx.type(key);
  return t === 'none' || t === want;
};

// KEYS: cred, revoked, meta, devices, subscriber, reserved, address
// ARGV: subscriberId, deviceId, credentialHash, sealedAwaiting, provisionalTtl, maxDevices, metaPrefix, addressIndex
const BIND: ScriptDef = {
  name: 'pushBind',
  lua: `${LUA}
if not (typeOk(KEYS[1], 'string') and typeOk(KEYS[2], 'string') and typeOk(KEYS[3], 'hash') and typeOk(KEYS[4], 'hash') and typeOk(KEYS[5], 'hash') and typeOk(KEYS[6], 'string') and typeOk(KEYS[7], 'string')) then return 'wrongtype' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'revoked' end
local me = ARGV[1] .. '/' .. ARGV[2]
local owner = redis.call('GET', KEYS[1])
if owner and owner ~= me and ownerAlive(owner, ARGV[7]) then return 'owned' end
if owner == me and redis.call('HEXISTS', KEYS[3], ARGV[2]) == 1 then return 'kept' end
if redis.call('HLEN', KEYS[3]) >= tonumber(ARGV[6]) then return 'full' end
local provisional = redis.call('EXISTS', KEYS[5]) == 0
local ttl = tonumber(ARGV[5])
local reservedTtl = redis.call('TTL', KEYS[6])
redis.call('SET', KEYS[1], me)
redis.call('HSET', KEYS[3], ARGV[2], 'a|0|' .. ARGV[3] .. '||')
redis.call('HSET', KEYS[4], ARGV[2], ARGV[4])
if provisional then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
  redis.call('EXPIRE', KEYS[4], ttl)
  redis.call('SET', KEYS[7], ARGV[8], 'EX', ttl)
  if reservedTtl ~= -2 and reservedTtl < ttl then redis.call('EXPIRE', KEYS[6], ttl) end
end
return 'bound'`,
  memory(tx, k, a) {
    const [cred, revoked, metaKey, devicesKey, subscriberKey, reservedKey, addressKey] = k as [string, string, string, string, string, string, string];
    const [sub, dev, credHash, sealed, ttlRaw, maxRaw, metaPrefix, addressIndex] = a as [string, string, string, string, string, string, string, string];
    if (!(typeOk(tx, cred, 'string') && typeOk(tx, revoked, 'string') && typeOk(tx, metaKey, 'hash') && typeOk(tx, devicesKey, 'hash') && typeOk(tx, subscriberKey, 'hash') && typeOk(tx, reservedKey, 'string') && typeOk(tx, addressKey, 'string'))) return 'wrongtype';
    if (tx.exists(revoked)) return 'revoked';
    const me = `${sub}/${dev}`;
    const owner = tx.get(cred);
    if (owner && owner !== me && ownerAlive(tx, owner, metaPrefix)) return 'owned';
    if (owner === me && tx.hGet(metaKey, dev) !== null) return 'kept';
    if (tx.hLen(metaKey) >= Number(maxRaw)) return 'full';
    const provisional = !tx.exists(subscriberKey);
    const ttl = Number(ttlRaw);
    const reservedTtl = tx.ttl(reservedKey);
    tx.set(cred, me);
    tx.hSet(metaKey, dev, `a|0|${credHash}||`);
    tx.hSet(devicesKey, dev, sealed);
    if (provisional) {
      tx.expire(cred, ttl);
      tx.expire(metaKey, ttl);
      tx.expire(devicesKey, ttl);
      tx.set(addressKey, addressIndex);
      tx.expire(addressKey, ttl);
      if (reservedTtl !== -2 && reservedTtl < ttl) tx.expire(reservedKey, ttl);
    }
    return 'bound';
  },
};

// KEYS: meta, devices, newEndpoint
// ARGV: subscriberId, deviceId, revision, endpointHmac, subscriptionHmac, sealed, endpointPrefix, metaPrefix
const REGISTER: ScriptDef = {
  name: 'pushRegister',
  lua: `${LUA}
if not (typeOk(KEYS[1], 'hash') and typeOk(KEYS[2], 'hash') and typeOk(KEYS[3], 'string')) then return 'wrongtype' end
local raw = redis.call('HGET', KEYS[1], ARGV[2])
if not raw then return 'missing' end
local state, rev, cred, ep, sh = meta(raw)
if not state then return 'wrongtype' end
rev = tonumber(rev)
local r = tonumber(ARGV[3])
if state == 'r' and r == rev then
  if sh == ARGV[5] then return 'registered' end
  return 'stale'
end
if r < rev or (state == 'r' and r <= rev) then return 'stale' end
local me = ARGV[1] .. '/' .. ARGV[2]
local owner = redis.call('GET', KEYS[3])
if owner and owner ~= me and ownerAlive(owner, ARGV[8]) then return 'endpoint-taken' end
local oldKey = ARGV[7] .. ep
if ep ~= '' and not typeOk(oldKey, 'string') then return 'wrongtype' end
local releaseOld = ep ~= '' and ep ~= ARGV[4] and redis.call('GET', oldKey) == me
redis.call('SET', KEYS[3], me)
if releaseOld then redis.call('DEL', oldKey) end
redis.call('HSET', KEYS[1], ARGV[2], 'r|' .. ARGV[3] .. '|' .. cred .. '|' .. ARGV[4] .. '|' .. ARGV[5])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[6])
return 'registered'`,
  memory(tx, k, a) {
    const [metaKey, devicesKey, newEndpoint] = k as [string, string, string];
    const [sub, dev, revRaw, ep, sh, sealed, endpointPrefix, metaPrefix] = a as [string, string, string, string, string, string, string, string];
    if (!(typeOk(tx, metaKey, 'hash') && typeOk(tx, devicesKey, 'hash') && typeOk(tx, newEndpoint, 'string'))) return 'wrongtype';
    const raw = tx.hGet(metaKey, dev);
    if (raw === null) return 'missing';
    let m: Meta;
    try {
      m = parseMeta(raw);
    } catch {
      return 'wrongtype';
    }
    const r = Number(revRaw);
    if (m.state === 'r' && r === m.revision) return m.subscriptionHmac === sh ? 'registered' : 'stale';
    if (r < m.revision || (m.state === 'r' && r <= m.revision)) return 'stale';
    const me = `${sub}/${dev}`;
    const owner = tx.get(newEndpoint);
    if (owner && owner !== me && ownerAlive(tx, owner, metaPrefix)) return 'endpoint-taken';
    const oldKey = `${endpointPrefix}${m.endpointHmac}`;
    if (m.endpointHmac !== '' && !typeOk(tx, oldKey, 'string')) return 'wrongtype';
    const releaseOld = m.endpointHmac !== '' && m.endpointHmac !== ep && tx.get(oldKey) === me;
    tx.set(newEndpoint, me);
    if (releaseOld) tx.del(oldKey);
    tx.hSet(metaKey, dev, formatMeta({ state: 'r', revision: r, credentialHash: m.credentialHash, endpointHmac: ep, subscriptionHmac: sh }));
    tx.hSet(devicesKey, dev, sealed);
    return 'registered';
  },
};

// KEYS: meta, devices
// ARGV: subscriberId, deviceId, revokeSeconds, onlyIfEndpointHmac ('' any), onlyIfAwaiting ('1'/'0'), credPrefix, endpointPrefix, revokedPrefix
const REMOVE: ScriptDef = {
  name: 'pushRemove',
  lua: `${LUA}
if not (typeOk(KEYS[1], 'hash') and typeOk(KEYS[2], 'hash')) then return 'wrongtype' end
local raw = redis.call('HGET', KEYS[1], ARGV[2])
if not raw then return 'missing' end
local state, rev, cred, ep, sh = meta(raw)
if not state then return 'wrongtype' end
if ARGV[4] ~= '' and ep ~= ARGV[4] then return 'kept' end
if ARGV[5] == '1' and state ~= 'a' then return 'kept' end
local me = ARGV[1] .. '/' .. ARGV[2]
local credKey = ARGV[6] .. cred
local epKey = ARGV[7] .. ep
local revokedKey = ARGV[8] .. cred
if not (typeOk(credKey, 'string') and typeOk(epKey, 'string') and typeOk(revokedKey, 'string')) then return 'wrongtype' end
local dropCred = cred ~= '' and redis.call('GET', credKey) == me
local dropEp = ep ~= '' and redis.call('GET', epKey) == me
local revoke = tonumber(ARGV[3]) > 0 and cred ~= ''
if dropCred then redis.call('DEL', credKey) end
if dropEp then redis.call('DEL', epKey) end
if revoke then redis.call('SET', revokedKey, '1', 'EX', tonumber(ARGV[3])) end
redis.call('HDEL', KEYS[1], ARGV[2])
redis.call('HDEL', KEYS[2], ARGV[2])
return 'removed'`,
  memory(tx, k, a) {
    const [metaKey, devicesKey] = k as [string, string];
    const [sub, dev, revokeRaw, only, onlyAwaiting, credPrefix, endpointPrefix, revokedPrefix] = a as [string, string, string, string, string, string, string, string];
    if (!(typeOk(tx, metaKey, 'hash') && typeOk(tx, devicesKey, 'hash'))) return 'wrongtype';
    const raw = tx.hGet(metaKey, dev);
    if (raw === null) return 'missing';
    let m: Meta;
    try {
      m = parseMeta(raw);
    } catch {
      return 'wrongtype';
    }
    if (only !== '' && m.endpointHmac !== only) return 'kept';
    if (onlyAwaiting === '1' && m.state !== 'a') return 'kept';
    const me = `${sub}/${dev}`;
    const credKey = `${credPrefix}${m.credentialHash}`;
    const epKey = `${endpointPrefix}${m.endpointHmac}`;
    const revokedKey = `${revokedPrefix}${m.credentialHash}`;
    if (!(typeOk(tx, credKey, 'string') && typeOk(tx, epKey, 'string') && typeOk(tx, revokedKey, 'string'))) return 'wrongtype';
    const dropCred = m.credentialHash !== '' && tx.get(credKey) === me;
    const dropEp = m.endpointHmac !== '' && tx.get(epKey) === me;
    const revoke = Number(revokeRaw) > 0 && m.credentialHash !== '';
    if (dropCred) tx.del(credKey);
    if (dropEp) tx.del(epKey);
    if (revoke) {
      tx.set(revokedKey, '1');
      tx.expire(revokedKey, Number(revokeRaw));
    }
    tx.hDel(metaKey, dev);
    tx.hDel(devicesKey, dev);
    return 'removed';
  },
};

export async function pushBind(
  kv: Kv,
  a: { subscriberId: string; deviceId: string; credentialHash: string; sealedAwaiting: string; addressIndex: string; provisionalTtlSeconds: number; maxDevices: number },
): Promise<'bound' | 'kept' | 'owned' | 'revoked' | 'full'> {
  check({ subscriberId: a.subscriberId, deviceId: a.deviceId, credentialHash: a.credentialHash, sealedAwaiting: a.sealedAwaiting, addressIndex: a.addressIndex });
  positive('provisionalTtlSeconds', a.provisionalTtlSeconds);
  positive('maxDevices', a.maxDevices);
  return answer(await kv.script(
    BIND,
    [K.pushCred(a.credentialHash), K.pushRevoked(a.credentialHash), K.pushMeta(a.subscriberId), K.pushDevices(a.subscriberId), K.subscriber(a.subscriberId), K.reserved(a.addressIndex), K.pushAddress(a.subscriberId)],
    [a.subscriberId, a.deviceId, a.credentialHash, a.sealedAwaiting, String(a.provisionalTtlSeconds), String(a.maxDevices), K.pushMeta(''), a.addressIndex],
  ));
}

export async function pushRegister(
  kv: Kv,
  a: { subscriberId: string; deviceId: string; revision: number; endpointHmac: string; subscriptionHmac: string; sealed: string },
): Promise<'registered' | 'stale' | 'missing' | 'endpoint-taken'> {
  positive('revision', a.revision);
  check({ subscriberId: a.subscriberId, deviceId: a.deviceId, endpointHmac: a.endpointHmac, subscriptionHmac: a.subscriptionHmac, sealed: a.sealed });
  return answer(await kv.script(
    REGISTER,
    [K.pushMeta(a.subscriberId), K.pushDevices(a.subscriberId), K.pushEndpoint(a.endpointHmac)],
    [a.subscriberId, a.deviceId, String(a.revision), a.endpointHmac, a.subscriptionHmac, a.sealed, K.pushEndpoint(''), K.pushMeta('')],
  ));
}

export async function pushRemove(
  kv: Kv,
  a: { subscriberId: string; deviceId: string; revokeSeconds: number; onlyIfEndpointHmac: string | null; onlyIfAwaiting?: boolean },
): Promise<'removed' | 'kept' | 'missing'> {
  positive('revokeSeconds', a.revokeSeconds, 0);
  check({ subscriberId: a.subscriberId, deviceId: a.deviceId, ...(a.onlyIfEndpointHmac ? { onlyIfEndpointHmac: a.onlyIfEndpointHmac } : {}) });
  return answer(await kv.script(
    REMOVE,
    [K.pushMeta(a.subscriberId), K.pushDevices(a.subscriberId)],
    [a.subscriberId, a.deviceId, String(a.revokeSeconds), a.onlyIfEndpointHmac ?? '', a.onlyIfAwaiting ? '1' : '0', K.pushCred(''), K.pushEndpoint(''), K.pushRevoked('')],
  ));
}

/** Revokes a credential that may have no device yet (turned off before confirmation). */
export async function revokeCredential(kv: Kv, credentialHash: string, seconds: number): Promise<void> {
  check({ credentialHash });
  positive('seconds', seconds);
  await kv.set(K.pushRevoked(credentialHash), '1', { ttlSeconds: seconds });
}
```

- [ ] **Step 5: Run the tests on MemoryKv**

Run: `npm test -w @penge/server -- test/push-atomic.test.ts`
Expected: PASS.

- [ ] **Step 6: Run them on a throwaway local Valkey**

```bash
docker run -d --rm --name penge-push-test -p 127.0.0.1:6390:6379 valkey/valkey:8
docker exec penge-push-test valkey-cli SET pp:test:disposable 1
PUSH_TEST_VALKEY=redis://127.0.0.1:6390 npm test -w @penge/server -- test/push-atomic.test.ts
docker stop penge-push-test
```

Expected: PASS on both targets, including the two `Promise.all` races (real concurrency on Valkey).

- [ ] **Step 7: Break it on purpose**

Delete the `'revoked'` check from both twins of `BIND`; run: "never binds a revoked credential" FAILS. Restore. Remove the `ARGV[4]`/`only` condition from both twins of `REMOVE`; run: "a late 410" FAILS. Restore. Move `typeOk` checks in `BIND` after the `SET`; run on Valkey: "changes nothing when a key … has the wrong type" FAILS. Restore.

- [ ] **Step 8: Codex pass, then commit** (`Atomic push device operations on Valkey and MemoryKv`).

---

### Task 5: Subscribe, preview and confirm with channels

**Files:**
- Modify: `apps/server/src/subscribers.ts`
- Create: `apps/server/src/push/devices.ts`
- Test: `apps/server/test/subscribers-push.test.ts`

**Interfaces:**
- Consumes: `Channels`, `ConfirmPreview`, `PushOutcome` (Task 1); `K` (Task 2); `seal`, `unseal` (Task 3); `pushBind`, `pushRemove`, `parseMeta`, `PROVISIONAL_TTL_SECONDS`, `REVOKED_TTL_SECONDS`, `MAX_DEVICES` (Task 4).
- Produces:
  - `Subscriber` gains `emailOn: boolean; pushOn: boolean`
  - `export async function withAddressLock<T>(kv, index, fn): Promise<T>` (exported)
  - `export async function removeSubscriberByIndex(kv, index): Promise<void>` (caller holds the lock)
  - `createPending(kv, keys, request: SubscribeRequest, now): Promise<string>`
  - `previewPending(kv, token): Promise<ConfirmPreview | null>`
  - `confirm(kv, keys, token, now, acknowledge?: { emailOn: boolean; pushOn: boolean }, opts?: { pushAllowed?: (email: string) => boolean }): Promise<ConfirmResult>`, where `ConfirmResult` is
    `{ status: 'confirmed' | 'updated'; subscriberId; siteIds; applicants; pace; channels: { emailOn; pushOn; push: PushOutcome } } | { status: 'invalid' } | { status: 'reload' } | { status: 'push-unavailable'; reason: 'owned' | 'revoked' | 'off' } | { status: 'full' }`
  - `push/devices.ts`: `interface SealedDevice { endpoint: string | null; p256dh: string | null; auth: string | null; label: string | null; createdAt: string; lastSuccessAt?: string; lastFailure?: string }`; `sealDevice(keys, d)`, `openDevice(keys, sealed)`; `newDeviceId()`; `listDevices(kv, subscriberId): Promise<{ id: string; meta: Meta }[]>`; `pruneAwaiting(kv, keys, subscriberId, now): Promise<number>` (removes awaiting devices older than 48 h, conditionally, through `pushRemove` with `onlyIfAwaiting`; caller holds the address lock); `removeAllDevices(kv, subscriberId, opts: { revoke: boolean }): Promise<number>`

What this task implements, from the spec ("Binding a device", "Compatibility"): one reservation per address; a read-only preview carrying the credential hash; channel requests need a matching acknowledgement (else `reload`, token kept); owner/off mode re-checked at confirmation; crash-safe order bind → write the subscriber (persisting provisional keys, deleting the reservation) → use up the token; a refused push with email off applies nothing and keeps the token; a refused push with email on applies the rest; a form without push from a browser with no credential keeps existing devices; deleting an address removes devices under the subscriber id and under the reservation before deleting pending requests.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/subscribers-push.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Channels, SubscribeRequest } from '@penge/contracts';
import { K } from '../src/keys.ts';
import { type Kv, MemoryKv, type WriteOp } from '../src/kv.ts';
import { pushRemove, REVOKED_TTL_SECONDS } from '../src/push/atomic.ts';
import { listDevices } from '../src/push/devices.ts';
import { confirm, createDeletion, createPending, deleteWithToken, load, previewPending } from '../src/subscribers.ts';
import { clock, keys } from './helpers.ts';

const hashOf = (s: string) => createHash('sha256').update(s).digest('base64url');
const newCredHash = () => hashOf(randomBytes(32).toString('base64url'));
const req = (channels: Channels | null, over: Partial<SubscribeRequest> = {}): SubscribeRequest => ({
  email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels, ...over,
});
const emailOnly: Channels = { emailOn: true, pushOn: false, pushCredentialHash: null, device: null };
const pushOnly = (h: string): Channels => ({ emailOn: false, pushOn: true, pushCredentialHash: h, device: 'Chrome on Android' });
const both = (h: string): Channels => ({ emailOn: true, pushOn: true, pushCredentialHash: h, device: 'Chrome on Android' });
const ack = (c: Channels) => ({ emailOn: c.emailOn, pushOn: c.pushOn });
const idOf = (r: Awaited<ReturnType<typeof confirm>>) => (r.status === 'confirmed' || r.status === 'updated' ? r.subscriberId : '');

/** A kv on which the write that creates or updates a subscriber hash fails, as if the process died there. */
function dyingAtSubscriberWrite(kv: MemoryKv): Kv {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === 'write') {
        return async (ops: WriteOp[]) => {
          if (ops.some((o) => o.op === 'hSet' && o.key.startsWith(K.subscriber('')))) throw new Error('process died');
          return target.write(ops);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Kv;
}
/** A kv on which using up a token fails, after the subscriber was written. */
function dyingAtTokenUse(kv: MemoryKv): Kv {
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === 'write') {
        return async (ops: WriteOp[]) => {
          if (ops.some((o) => o.op === 'del' && o.key.startsWith(K.pending('')))) throw new Error('process died');
          return target.write(ops);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Kv;
}
const pushKeys = (kv: MemoryKv) => kv.keys().filter((k) => k.startsWith('pp:push') && !k.startsWith(K.pushRevoked('')));

describe('subscribing with channels', () => {
  it('previews without changing anything, with the credential hash', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    const token = await createPending(kv, keys, req(pushOnly(h)), t.now());
    const before = kv.dump();
    expect(await previewPending(kv, token)).toMatchObject({ siteIds: [486], channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', pushCredentialHash: h, devicesKept: 0 } });
    expect(kv.dump()).toBe(before);
  });

  it('refuses a channel request confirmed without acknowledgement, and keeps the token usable', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    expect((await confirm(kv, keys, token, t.now())).status).toBe('reload');
    expect((await confirm(kv, keys, token, t.now(), { emailOn: true, pushOn: true })).status).toBe('reload');
    expect(await confirm(kv, keys, token, t.now(), ack(c))).toMatchObject({ status: 'confirmed', channels: { emailOn: false, pushOn: true, push: 'bound' } });
  });

  it('still confirms a pending request from before channels with the token alone', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const token = await createPending(kv, keys, req(null), t.now());
    expect(await confirm(kv, keys, token, t.now())).toMatchObject({ status: 'confirmed', channels: { emailOn: true, pushOn: false, push: 'none' } });
  });

  it('never turns email on when push cannot be bound and email is off, and keeps the token', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    await confirm(kv, keys, await createPending(kv, keys, req(pushOnly(h), { email: 'ana@example.com' }), t.now()), t.now(), ack(pushOnly(h)));
    const b = await createPending(kv, keys, req(pushOnly(h), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), ack(pushOnly(h)))).toEqual({ status: 'push-unavailable', reason: 'owned' });
    expect(await kv.get(K.pending(hashOf(b)))).not.toBeNull();
    expect(await kv.sMembers(K.allSubscribers)).toHaveLength(1);
  });

  it('applies the rest when push cannot be bound but email is on', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    await confirm(kv, keys, await createPending(kv, keys, req(pushOnly(h), { email: 'ana@example.com' }), t.now()), t.now(), ack(pushOnly(h)));
    const b = await createPending(kv, keys, req(both(h), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), ack(both(h)))).toMatchObject({ status: 'confirmed', channels: { emailOn: true, pushOn: false, push: 'skipped-owned' } });
  });

  it('recovers from an owned credential: turn it off there, submit again with a fresh credential', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    const a = await confirm(kv, keys, await createPending(kv, keys, req(pushOnly(h), { email: 'ana@example.com' }), t.now()), t.now(), ack(pushOnly(h)));
    const [dev] = await listDevices(kv, idOf(a));
    await pushRemove(kv, { subscriberId: idOf(a), deviceId: dev!.id, revokeSeconds: REVOKED_TTL_SECONDS, onlyIfEndpointHmac: null });
    const fresh = newCredHash();
    const b = await createPending(kv, keys, req(pushOnly(fresh), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), ack(pushOnly(fresh)))).toMatchObject({ status: 'confirmed', channels: { push: 'bound' } });
  });

  it('respects push being off, or owner-only, at confirmation time', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const off = () => false;
    const a = await createPending(kv, keys, req(pushOnly(newCredHash()), { email: 'ana@example.com' }), t.now());
    expect(await confirm(kv, keys, a, t.now(), { emailOn: false, pushOn: true }, { pushAllowed: off })).toEqual({ status: 'push-unavailable', reason: 'off' });
    const b = await createPending(kv, keys, req(both(newCredHash()), { email: 'ben@example.com' }), t.now());
    expect(await confirm(kv, keys, b, t.now(), { emailOn: true, pushOn: true }, { pushAllowed: off })).toMatchObject({ channels: { emailOn: true, pushOn: false, push: 'skipped-off' } });
    const ownerOnly = (email: string) => email === 'juan@example.com';
    const c = await createPending(kv, keys, req(both(newCredHash())), t.now());
    expect(await confirm(kv, keys, c, t.now(), { emailOn: true, pushOn: true }, { pushAllowed: ownerOnly })).toMatchObject({ channels: { push: 'bound' } });
  });

  it('keeps a phone\'s notifications when offices are changed from a laptop (Review Focus 1)', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const h = newCredHash();
    const first = await confirm(kv, keys, await createPending(kv, keys, req(both(h)), t.now()), t.now(), ack(both(h)));
    const laptop = await createPending(kv, keys, req(emailOnly, { siteIds: [486, 693] }), t.now());
    await confirm(kv, keys, laptop, t.now(), ack(emailOnly));
    expect(await load(kv, idOf(first))).toMatchObject({ pushOn: true, siteIds: [486, 693] });
    expect(await listDevices(kv, idOf(first))).toHaveLength(1);
  });

  it('finishes a confirmation that died after binding when the link is retried', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    await expect(confirm(dyingAtSubscriberWrite(kv), keys, token, t.now(), ack(c))).rejects.toThrow('process died');
    expect(await confirm(kv, keys, token, t.now(), ack(c))).toMatchObject({ status: 'confirmed', channels: { push: 'kept' } });
  });

  it('finishes a confirmation that died after writing the subscriber, before using up the token', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    await expect(confirm(dyingAtTokenUse(kv), keys, token, t.now(), ack(c))).rejects.toThrow('process died');
    const r = await confirm(kv, keys, token, t.now(), ack(c));
    expect(r).toMatchObject({ status: 'updated', channels: { push: 'kept' } });
    expect(await listDevices(kv, idOf(r))).toHaveLength(1);
    expect(await kv.get(K.reserved(await indexOf(kv, idOf(r))))).toBeNull();
  });

  it('uses one id for every confirmation of one address, even after a crash', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const a = await createPending(kv, keys, req(c), t.now());
    const b = await createPending(kv, keys, req(emailOnly), t.now());
    await expect(confirm(dyingAtSubscriberWrite(kv), keys, a, t.now(), ack(c))).rejects.toThrow('process died');
    const rb = await confirm(kv, keys, b, t.now(), ack(emailOnly));
    const ra = await confirm(kv, keys, a, t.now(), ack(c));
    expect(rb.status).toBe('confirmed');
    expect(ra).toMatchObject({ status: 'updated', channels: { emailOn: false, pushOn: true } });
    expect(idOf(ra)).toBe(idOf(rb));
  });

  it('leaves no device after deleting an address whose confirmation died after binding past the link expiry', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = pushOnly(newCredHash());
    const token = await createPending(kv, keys, req(c), t.now());
    t.advance(47 * 3600_000);
    await expect(confirm(dyingAtSubscriberWrite(kv), keys, token, t.now(), ack(c))).rejects.toThrow('process died');
    t.advance(2 * 3600_000); // the link has expired; the reservation was extended by the bind
    await deleteWithToken(kv, await createDeletion(kv, keys, 'juan@example.com'));
    expect(pushKeys(kv)).toEqual([]);
    expect(kv.keys().filter((k) => k.startsWith('pp:reserved'))).toEqual([]);
    expect(await kv.get(K.pushRevoked(c.pushCredentialHash!))).toBe('1'); // revoked markers stay for their 72 h
  });

  it('cancels a turned-off credential: a second confirmation cannot bring it back', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const c = both(newCredHash());
    const a = await createPending(kv, keys, req(c), t.now());
    const b = await createPending(kv, keys, req(c), t.now());
    const ra = await confirm(kv, keys, a, t.now(), ack(c));
    const [dev] = await listDevices(kv, idOf(ra));
    await pushRemove(kv, { subscriberId: idOf(ra), deviceId: dev!.id, revokeSeconds: REVOKED_TTL_SECONDS, onlyIfEndpointHmac: null });
    expect(await confirm(kv, keys, b, t.now(), ack(c))).toMatchObject({ channels: { push: 'skipped-revoked' } });
  });

  it('drops an awaiting device of an existing subscriber after 48 hours, freeing its slot', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const first = await confirm(kv, keys, await createPending(kv, keys, req(emailOnly), t.now()), t.now(), ack(emailOnly));
    for (let i = 0; i < 5; i++) {
      const c = both(newCredHash());
      await confirm(kv, keys, await createPending(kv, keys, req(c), t.now()), t.now(), ack(c));
    }
    const sixth = both(newCredHash());
    expect((await confirm(kv, keys, await createPending(kv, keys, req(sixth), t.now()), t.now(), ack(sixth))).status).toBe('full');
    t.advance(49 * 3600_000);
    const later = both(newCredHash());
    expect(await confirm(kv, keys, await createPending(kv, keys, req(later), t.now()), t.now(), ack(later))).toMatchObject({ channels: { push: 'bound' } });
    expect(await listDevices(kv, idOf(first))).toHaveLength(1);
  });

  it('lets an abandoned sign-up leave nothing but a stale pending-channels member once its links expire', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    await createPending(kv, keys, req(pushOnly(newCredHash())), t.now());
    t.advance(50 * 3600_000);
    expect(kv.keys().filter((k) => !k.startsWith('pp:rate') && k !== K.pendingChannels)).toEqual([]);
    // The stale member points at a pending record that no longer exists; push-downgrade (Task 11) skips and removes it.
    expect(await kv.sMembers(K.pendingChannels)).toHaveLength(1);
  });
});

async function indexOf(kv: Kv, id: string) {
  return (await kv.hGetAll(K.subscriber(id))).index!;
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/server -- test/subscribers-push.test.ts`
Expected: FAIL (`previewPending`, `listDevices` missing; `confirm` takes `keys`).

- [ ] **Step 3: Implement `push/devices.ts`**

```ts
// Reading a subscriber's devices and their sealed records. Ownership changes go
// through push/atomic.ts only; callers hold the subscriber's address lock.
import { randomBytes } from 'node:crypto';
import { seal, unseal } from '../crypto.ts';
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Keys } from '../subscribers.ts';
import { type Meta, parseMeta, pushRemove, REVOKED_TTL_SECONDS } from './atomic.ts';

export interface SealedDevice {
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  label: string | null;
  createdAt: string;
  /** Notes from sending: kept here, sealed, like the rest. */
  lastSuccessAt?: string;
  lastFailure?: string;
}

const LABEL = 'push:v1';
/** An awaiting device of an existing subscriber is dropped after this long. */
export const AWAITING_MAX_MS = 48 * 3600_000;

export const sealDevice = (keys: Keys, d: SealedDevice) => seal(JSON.stringify(d), keys.email, LABEL);
export const openDevice = (keys: Keys, sealed: string) => JSON.parse(unseal(sealed, keys.email, LABEL)) as SealedDevice;
export const newDeviceId = () => randomBytes(12).toString('base64url');

export async function listDevices(kv: Kv, subscriberId: string): Promise<{ id: string; meta: Meta }[]> {
  return Object.entries(await kv.hGetAll(K.pushMeta(subscriberId))).map(([id, raw]) => ({ id, meta: parseMeta(raw) }));
}

/** Removes awaiting devices older than 48 hours (a registration in between keeps them). */
export async function pruneAwaiting(kv: Kv, keys: Keys, subscriberId: string, now: number): Promise<number> {
  const sealed = await kv.hGetAll(K.pushDevices(subscriberId));
  let n = 0;
  for (const d of await listDevices(kv, subscriberId)) {
    if (d.meta.state !== 'a' || !sealed[d.id]) continue;
    if (now - Date.parse(openDevice(keys, sealed[d.id]!).createdAt) <= AWAITING_MAX_MS) continue;
    if ((await pushRemove(kv, { subscriberId, deviceId: d.id, revokeSeconds: 0, onlyIfEndpointHmac: null, onlyIfAwaiting: true })) === 'removed') n++;
  }
  return n;
}

/** Every device of a subscriber, removed the atomic way. */
export async function removeAllDevices(kv: Kv, subscriberId: string, opts: { revoke: boolean }): Promise<number> {
  let n = 0;
  for (const d of await listDevices(kv, subscriberId)) {
    const r = await pushRemove(kv, { subscriberId, deviceId: d.id, revokeSeconds: opts.revoke ? REVOKED_TTL_SECONDS : 0, onlyIfEndpointHmac: null });
    if (r === 'removed') n++;
  }
  return n;
}
```

- [ ] **Step 4: Implement the subscriber changes**

In `subscribers.ts` (keep every existing comment that still holds):

Imports: add `type Channels, type ConfirmPreview, type PushOutcome` from `@penge/contracts`; `decryptEmail` from `./crypto.ts`; `MAX_DEVICES, PROVISIONAL_TTL_SECONDS, pushBind` from `./push/atomic.ts`; `listDevices, newDeviceId, pruneAwaiting, removeAllDevices, sealDevice` from `./push/devices.ts`.

`Subscriber` gains `emailOn: boolean; pushOn: boolean;`. `Pending` gains `channels?: Channels`.

Make `withAddressLock` `export`.

```ts
/** Seconds left on a key (-2 missing, -1 none), read through a script so MemoryKv and Valkey agree. */
const ttlOf = async (kv: Kv, key: string) =>
  Number(await kv.script({ name: 'ttl', lua: "return tostring(redis.call('TTL', KEYS[1]))", memory: (tx, k) => String(tx.ttl(k[0]!)) }, [key], []));

/** Store a pending subscription; returns the token for the confirmation link. */
export async function createPending(kv: Kv, keys: Keys, request: SubscribeRequest, now: number): Promise<string> {
  const token = randomToken();
  const pending: Pending = {
    sealedEmail: encryptEmail(request.email, keys.email),
    index: emailIndex(request.email, keys.index),
    siteIds: request.siteIds,
    applicants: request.applicants,
    pace: request.pace,
    ...(request.channels ? { channels: request.channels } : {}),
    requestedAt: new Date(now).toISOString(),
  };
  const hash = hashToken(token);
  await withAddressLock(kv, pending.index, async () => {
    const ops: WriteOp[] = [
      { op: 'set', key: K.pending(hash), value: JSON.stringify(pending), ttlSeconds: PENDING_TTL_SECONDS },
      { op: 'sAdd', key: K.pendingFor(pending.index), members: [hash] },
      { op: 'expire', key: K.pendingFor(pending.index), ttlSeconds: PENDING_TTL_SECONDS },
    ];
    // One reserved id per address while it has none. It lives as long as the latest
    // pending request, and is never shortened (pushBind may have extended it).
    // An hour longer than the token, so the token can never outlive it.
    const reservedTtl = PENDING_TTL_SECONDS + 3600;
    if (!(await kv.get(K.emailIndex(pending.index)))) {
      await kv.set(K.reserved(pending.index), newId(), { nx: true, ttlSeconds: reservedTtl });
      if ((await ttlOf(kv, K.reserved(pending.index))) < reservedTtl) {
        ops.push({ op: 'expire', key: K.reserved(pending.index), ttlSeconds: reservedTtl });
      }
    }
    const ch = request.channels;
    if (ch && (ch.pushOn || !ch.emailOn)) ops.push({ op: 'sAdd', key: K.pendingChannels, members: [`${hash}|${pending.index}`] });
    if (ch?.pushCredentialHash) {
      ops.push(
        { op: 'sAdd', key: K.pushPending(ch.pushCredentialHash), members: [hash] },
        { op: 'expire', key: K.pushPending(ch.pushCredentialHash), ttlSeconds: PENDING_TTL_SECONDS },
      );
    }
    await kv.write(ops);
  });
  return token;
}

export async function previewPending(kv: Kv, token: string): Promise<ConfirmPreview | null> {
  const raw = await kv.get(K.pending(hashToken(token)));
  if (!raw) return null;
  const p = JSON.parse(raw) as Pending;
  const c = p.channels;
  const existing = await kv.get(K.emailIndex(p.index));
  const devicesKept = existing ? (await listDevices(kv, existing)).length : 0;
  return {
    siteIds: p.siteIds,
    applicants: p.applicants,
    pace: p.pace ?? 'hourly',
    channels: c ? { emailOn: c.emailOn, pushOn: c.pushOn, device: c.device, requestedAt: p.requestedAt, pushCredentialHash: c.pushCredentialHash, devicesKept } : null,
  };
}

export type ConfirmResult =
  | { status: 'confirmed' | 'updated'; subscriberId: string; siteIds: number[]; applicants: number; pace: Pace; channels: { emailOn: boolean; pushOn: boolean; push: PushOutcome } }
  | { status: 'invalid' }
  | { status: 'reload' }
  | { status: 'push-unavailable'; reason: 'owned' | 'revoked' | 'off' }
  | { status: 'full' };

/**
 * Use a confirmation token (once). Its steps, in an order that a retry of the
 * same link can always finish: (1) bind the asking device (idempotent for the
 * same owner); (2) write the subscriber, making a provisional device permanent
 * and dropping the address's reservation, in one write; (3) use up the token.
 */
export async function confirm(
  kv: Kv,
  keys: Keys,
  token: string,
  now: number,
  acknowledge?: { emailOn: boolean; pushOn: boolean },
  opts: { pushAllowed?: (email: string) => boolean } = {},
): Promise<ConfirmResult> {
  const hash = hashToken(token);
  const key = K.pending(hash);
  const peek = await kv.get(key);
  if (!peek) return { status: 'invalid' };
  return withAddressLock(kv, (JSON.parse(peek) as Pending).index, async () => {
    const raw = await kv.get(key);
    if (!raw) return { status: 'invalid' };
    const pending = JSON.parse(raw) as Pending;
    const ch = pending.channels;
    // A page from before channels must not confirm a request that changes them.
    if (ch && (!acknowledge || acknowledge.emailOn !== ch.emailOn || acknowledge.pushOn !== ch.pushOn)) return { status: 'reload' };

    const existingId = await kv.get(K.emailIndex(pending.index));
    const existing = existingId ? await load(kv, existingId) : null;
    let id = existing?.id ?? (await kv.get(K.reserved(pending.index)));
    if (!id) {
      // The reservation lapsed (it outlives the token by an hour, so only after a clock jump):
      // make one now, before binding, so a device bound below can always be found by address.
      id = newId();
      await kv.set(K.reserved(pending.index), id, { ttlSeconds: PENDING_TTL_SECONDS + 3600 });
    }
    await pruneAwaiting(kv, keys, id, now);

    // (1) Bind the asking device.
    let push: PushOutcome = 'none';
    if (ch?.pushOn && ch.pushCredentialHash) {
      const allowed = opts.pushAllowed ? opts.pushAllowed(decryptEmail(pending.sealedEmail, keys.email)) : true;
      if (!allowed) {
        if (!ch.emailOn) return { status: 'push-unavailable', reason: 'off' };
        push = 'skipped-off';
      } else {
        const owned = await kv.get(K.pushCred(ch.pushCredentialHash));
        const deviceId = owned?.startsWith(`${id}/`) ? owned.slice(id.length + 1) : newDeviceId();
        const r = await pushBind(kv, {
          subscriberId: id, deviceId, credentialHash: ch.pushCredentialHash,
          sealedAwaiting: sealDevice(keys, { endpoint: null, p256dh: null, auth: null, label: ch.device, createdAt: new Date(now).toISOString() }),
          addressIndex: pending.index, provisionalTtlSeconds: PROVISIONAL_TTL_SECONDS, maxDevices: MAX_DEVICES,
        });
        if (r === 'full') return { status: 'full' };
        push = r === 'bound' ? 'bound' : r === 'kept' ? 'kept' : r === 'owned' ? 'skipped-owned' : 'skipped-revoked';
        if ((push === 'skipped-owned' || push === 'skipped-revoked') && !ch.emailOn) {
          return { status: 'push-unavailable', reason: push === 'skipped-owned' ? 'owned' : 'revoked' };
        }
      }
    }

    // Email as asked (unchanged for a page from before channels); push on while any device exists.
    const devices = await listDevices(kv, id);
    const emailOn = ch ? ch.emailOn : (existing?.emailOn ?? true);
    const pushOn = devices.length > 0;
    if (!emailOn && !pushOn) return { status: 'push-unavailable', reason: 'revoked' };

    // (2) Write the subscriber.
    const at = new Date(now).toISOString();
    const ops: WriteOp[] = [];
    for (const siteId of existing?.siteIds ?? []) {
      if (!pending.siteIds.includes(siteId)) ops.push({ op: 'sRem', key: K.siteSubscribers(siteId), members: [id] });
    }
    ops.push(
      {
        op: 'hSet',
        key: K.subscriber(id),
        fields: {
          email: pending.sealedEmail,
          index: pending.index,
          sites: pending.siteIds.join(','),
          applicants: String(pending.applicants),
          pace: pending.pace ?? 'hourly',
          emailOn: emailOn ? '1' : '0',
          pushOn: pushOn ? '1' : '0',
          createdAt: existing?.createdAt ?? at,
          confirmedAt: at,
        },
      },
      { op: 'set', key: K.emailIndex(pending.index), value: id },
      { op: 'sAdd', key: K.allSubscribers, members: [id] },
      ...pending.siteIds.map((siteId): WriteOp => ({ op: 'sAdd', key: K.siteSubscribers(siteId), members: [id] })),
      { op: 'persist', key: K.pushMeta(id) },
      { op: 'persist', key: K.pushDevices(id) },
      ...devices.filter((d) => d.meta.credentialHash).map((d): WriteOp => ({ op: 'persist', key: K.pushCred(d.meta.credentialHash) })),
      { op: 'del', key: K.reserved(pending.index) },
      { op: 'del', key: K.pushAddress(id) },
    );
    await kv.write(ops);

    // (3) Use up the token.
    await kv.write([
      { op: 'del', key },
      { op: 'sRem', key: K.pendingFor(pending.index), members: [hash] },
      { op: 'sRem', key: K.pendingChannels, members: [`${hash}|${pending.index}`] },
      ...(ch?.pushCredentialHash ? [{ op: 'sRem', key: K.pushPending(ch.pushCredentialHash), members: [hash] } as WriteOp] : []),
    ]);
    return {
      status: existing ? 'updated' : 'confirmed',
      subscriberId: id,
      siteIds: pending.siteIds,
      applicants: pending.applicants,
      pace: pending.pace ?? 'hourly',
      channels: { emailOn, pushOn, push },
    };
  });
}
```

Delete the old `upsert` (its body now lives in step (2) above). Note on "updated" after a crash between (2) and (3): the retry finds the subscriber it wrote, so it answers `updated`; that is what the test expects.

`removeAddress` (replace the whole function):

```ts
/** Delete subscription data, devices and every unused confirmation/deletion link for an address. Caller holds its lock. */
async function removeAddress(kv: Kv, index: string, subscriber: Subscriber | null): Promise<void> {
  // Devices first, under the subscriber id and under the address's reservation
  // (a confirmation that died after binding), while those ids can still be found.
  const reserved = await kv.get(K.reserved(index));
  for (const id of new Set([subscriber?.id, reserved].filter((x): x is string => !!x))) {
    await removeAllDevices(kv, id, { revoke: true });
    await kv.write([{ op: 'del', key: K.pushAddress(id) }]);
  }
  const waiting = await kv.sMembers(K.pendingFor(index));
  const deletions = await kv.sMembers(K.deletionsFor(index));
  const credentialSets: WriteOp[] = [];
  for (const hash of waiting) {
    const raw = await kv.get(K.pending(hash));
    const c = raw ? (JSON.parse(raw) as Pending).channels : undefined;
    if (c?.pushCredentialHash) credentialSets.push({ op: 'sRem', key: K.pushPending(c.pushCredentialHash), members: [hash] });
  }
  await kv.write([
    ...(subscriber
      ? [
          ...subscriber.siteIds.map((siteId): WriteOp => ({ op: 'sRem', key: K.siteSubscribers(siteId), members: [subscriber.id] })),
          { op: 'del', key: K.subscriber(subscriber.id) } as WriteOp,
          { op: 'sRem', key: K.allSubscribers, members: [subscriber.id] } as WriteOp,
          { op: 'del', key: K.held(subscriber.id) } as WriteOp,
          { op: 'sRem', key: K.heldSubscribers, members: [subscriber.id] } as WriteOp,
          { op: 'del', key: K.lastAlert(subscriber.id) } as WriteOp,
        ]
      : []),
    { op: 'del', key: K.emailIndex(index) },
    { op: 'del', key: K.reserved(index) },
    ...credentialSets,
    ...waiting.map((hash): WriteOp => ({ op: 'del', key: K.pending(hash) })),
    ...waiting.map((hash): WriteOp => ({ op: 'sRem', key: K.pendingChannels, members: [`${hash}|${index}`] })),
    { op: 'del', key: K.pendingFor(index) },
    ...deletions.map((hash): WriteOp => ({ op: 'del', key: K.deletion(hash) })),
    { op: 'del', key: K.deletionsFor(index) },
  ]);
}

/** For push-downgrade and restore: remove an address the way unsubscribing does. Caller holds its lock. */
export async function removeSubscriberByIndex(kv: Kv, index: string): Promise<void> {
  const id = await kv.get(K.emailIndex(index));
  await removeAddress(kv, index, id ? await load(kv, id) : null);
}
```

`load` returns, in addition, `emailOn: h.emailOn !== '0', pushOn: h.pushOn === '1'`.

- [ ] **Step 5: Update the callers**

`api.ts`'s `/api/confirm` calls `confirm(kv, keys, token, now())` for now (Task 6 adds acknowledgement and `pushAllowed`), and handles every result, so the typecheck passes in this task:

```ts
    const result = await confirm(kv, keys, token, now());
    if (result.status === 'invalid') return fail(c, 404, 'That link has expired or was already used. Subscribe again to get a new one.');
    if (result.status === 'reload' || result.status === 'full' || result.status === 'push-unavailable') {
      // Task 6 words these; a request with channels cannot reach this route from today's page yet.
      return c.json<ApiError>({ error: 'This page is out of date. Reload it, then open the confirmation link from your email again.', code: 'reload' }, 409);
    }
    deps.stats?.count(result.status === 'confirmed' ? 'confirmed' : 'updated');
    return c.json<ConfirmResponse>({ status: result.status, siteIds: result.siteIds, applicants: result.applicants, pace: result.pace, channels: result.channels });
```

(`fail`'s status union gains `409` here.) Test helpers that call `confirm(kv, token, now)` (in `checker.test.ts`, `abroad.test.ts`, `deletion.test.ts`, `stats.test.ts` and others: `grep -rn "confirm(kv" apps/server/test`) change to `confirm(kv, keys, token, now)`; they create requests with `channels: null`, which still confirm with the token alone. Each helper that checked only `if (result.status === 'invalid') throw …` before using `result.subscriberId` now narrows to success:

```ts
    if (result.status !== 'confirmed' && result.status !== 'updated') throw new Error(`confirm failed: ${result.status}`);
```

- [ ] **Step 6: Run everything**

Run: `npm test -w @penge/server && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Break it on purpose**

Swap steps (1) and (2) in `confirm`: "finishes a confirmation that died after binding" FAILS (the retry finds a subscriber with push off and no device). Restore. In `createPending`, always `expire` the reservation to 48 h (drop the `ttlOf` check), then add this test temporarily and see it FAIL: bind for a new address (crash after binding), call `createPending` again for the same address, advance 50 h, delete the address: a device key survives. Restore and delete the temporary test.

- [ ] **Step 8: Codex pass, then commit** (`Channels on subscribe and confirm, with a read-only preview and crash-safe binding`).

---

### Task 6: API routes for preview, confirm, devices and status

**Files:**
- Modify: `apps/server/src/api.ts`, `apps/server/src/limits.ts`, `apps/server/src/server.ts`
- Create: `apps/server/src/push/register.ts`
- Test: `apps/server/test/api-push.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `ApiDeps` gains `push: PushConfig`
  - Routes:
    - `POST /api/confirm/preview { token }` → `ConfirmPreview` | 400 | 404
    - `POST /api/confirm { token, acknowledge? }` → `ConfirmResponse` | 404 | 409 `{ error, code: 'reload' | 'push-unavailable' | 'full' }`
    - `POST /api/push/device { credential, subscription?, revision? }` → `{ state: DeviceState }` | 400
    - `DELETE /api/push/device { credential }` → `{ ok: true, noChannel: boolean }`
    - `GET /api/status` adds `push` and `vapidPublicKey`
  - `API_LIMITS.devicePerIp = { bucket: 'push-ip', max: 600, windowSeconds: 3600 }`, `API_LIMITS.devicePerCredential = { bucket: 'push-cred', max: 300, windowSeconds: 3600 }` (turning a device off counts against the network limit only, so it always gets through for its own device)
  - `push/register.ts`: `credentialHash(credential): string`; `findDevice(kv, hash): Promise<{ subscriberId; deviceId } | null>`; `deviceCall(kv, keys, a: { credential; subscription: PushSubscriptionInput | null; revision: number | null; now: number }): Promise<DeviceState>`; `turnOffDevice(kv, credential): Promise<{ noChannel: boolean }>`

`turnOffDevice` revokes the credential **first** (so a confirmation racing it cannot bind it), then removes a bound device if there is one, under its subscriber's address lock; with no device left the subscription's `pushOn` becomes `0`, and `noChannel` is true when email is off too.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/api-push.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api.ts';
import type { PushConfig } from '../src/config.ts';
import { K } from '../src/keys.ts';
import { MemoryKv } from '../src/kv.ts';
import { silentLog } from '../src/log.ts';
import { emailIndex } from '../src/crypto.ts';
import { clock, FakeMailer, fcmSubscription, keys, PUSH_KEYS, SITES } from './helpers.ts';

const PHONE = 'Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile';
const VAPID = { publicKey: 'B'.repeat(87), privateKey: 'p'.repeat(43), subject: 'mailto:alerts@example.com' };
const LIVE: PushConfig = { mode: 'live', vapid: VAPID, ownerEmails: [] };
type Ch = { emailOn: boolean; pushOn: boolean; pushCredentialHash?: string; device?: string };

export async function site(push: PushConfig = LIVE, pushTransport?: unknown) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  await kv.set(K.sites, JSON.stringify(SITES.map((s) => ({ id: s.id, name: s.name }))));
  const mailer = new FakeMailer();
  let ip = '203.0.113.1';
  const app = createApi({ kv, keys, mailer, log: silentLog, publicBaseUrl: 'https://penge.example', now: t.now, clientIp: () => ip, push, ...(pushTransport ? { pushTransport } : {}) } as Parameters<typeof createApi>[0]);
  const send = (method: string, path: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', 'user-agent': PHONE }, body: JSON.stringify(body) });
  const post = (path: string, body: unknown) => send('POST', path, body);
  const state = async (body: unknown) => ((await (await post('/api/push/device', body)).json()) as { state: string }).state;
  const credential = () => {
    const c = randomBytes(32).toString('base64url');
    return { credential: c, hash: createHash('sha256').update(c).digest('base64url') };
  };
  const signUp = async (email: string, channels: Ch) => {
    const res = await post('/api/subscribe', { email, siteIds: [693], applicants: 1, pace: 'asap', channels });
    expect(res.status).toBe(202);
    const token = /\/confirm#token=([A-Za-z0-9_-]{43})/.exec(mailer.sent.at(-1)!.text)![1]!;
    return { token, confirm: () => post('/api/confirm', { token, acknowledge: { emailOn: channels.emailOn, pushOn: channels.pushOn } }) };
  };
  return { t, kv, mailer, app, send, post, state, credential, signUp, setIp: (v: string) => (ip = v) };
}

describe('push API', () => {
  it('previews then confirms a push-only request, and a token-only confirm of it gets 409 without using it', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { token } = await s.signUp('juan@example.com', { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    const preview = (await (await s.post('/api/confirm/preview', { token })).json()) as { channels: unknown };
    expect(preview.channels).toMatchObject({ emailOn: false, pushOn: true, device: 'Chrome on Android', pushCredentialHash: hash });
    const old = await s.post('/api/confirm', { token });
    expect(old.status).toBe(409);
    expect(((await old.json()) as { code: string }).code).toBe('reload');
    const ok = await s.post('/api/confirm', { token, acknowledge: { emailOn: false, pushOn: true } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { channels: unknown }).channels).toEqual({ emailOn: false, pushOn: true, push: 'bound' });
    expect(await s.state({ credential })).toBe('awaiting');
  });

  it('answers pending before confirmation, registers after, and refuses an old revision as stale', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { confirm } = await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    expect(await s.state({ credential })).toBe('pending');
    expect((await confirm()).status).toBe(200);
    expect(await s.state({ credential })).toBe('awaiting');
    const a = fcmSubscription('a');
    expect(await s.state({ credential, subscription: a, revision: 1 })).toBe('registered');
    expect(await s.state({ credential, subscription: a, revision: 1 })).toBe('registered');
    expect(await s.state({ credential, subscription: { ...a, keys: { ...a.keys, auth: Buffer.alloc(16, 2).toString('base64url') } }, revision: 1 })).toBe('stale');
    expect(await s.state({ credential, subscription: fcmSubscription('b'), revision: 2 })).toBe('registered');
    expect(await s.state({ credential })).toBe('registered');
  });

  it('refuses a push endpoint outside the push services, or a bad key, with 400', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { confirm } = await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    await confirm();
    expect((await s.post('/api/push/device', { credential, subscription: { endpoint: 'https://127.0.0.1/x', keys: PUSH_KEYS }, revision: 1 })).status).toBe(400);
    expect((await s.post('/api/push/device', { credential, subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { ...PUSH_KEYS, p256dh: Buffer.alloc(65, 4).toString('base64url') } }, revision: 1 })).status).toBe(400);
  });

  it('turns a device off, and a second confirmation cannot bring the credential back', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const ch = { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    const first = await s.signUp('juan@example.com', ch);
    const second = await s.signUp('juan@example.com', ch);
    await first.confirm();
    expect(await (await s.send('DELETE', '/api/push/device', { credential })).json()).toEqual({ ok: true, noChannel: false });
    expect(await s.state({ credential })).toBe('pending'); // the second request is still waiting
    const r = (await (await second.confirm()).json()) as { channels: { push: string } };
    expect(r.channels.push).toBe('skipped-revoked');
    expect(await s.state({ credential })).toBe('missing');
  });

  it('revokes a credential turned off before anyone confirmed', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const ch = { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    const req = await s.signUp('juan@example.com', ch);
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
    const r = (await (await req.confirm()).json()) as { channels: { push: string } };
    expect(r.channels.push).toBe('skipped-revoked');
  });

  it('turns off a device whose confirmation died after binding, and a retried confirmation cannot leave push-only with no device', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const { token } = await s.signUp('juan@example.com', { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' });
    const write = s.kv.write.bind(s.kv);
    s.kv.write = async (ops) => {
      if (ops.some((o) => o.op === 'hSet' && o.key.startsWith('pp:sub:'))) throw new Error('process died');
      return write(ops);
    };
    expect((await s.post('/api/confirm', { token, acknowledge: { emailOn: false, pushOn: true } })).status).toBe(500);
    s.kv.write = write;
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
    const retry = await s.post('/api/confirm', { token, acknowledge: { emailOn: false, pushOn: true } });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { code: string }).code).toBe('push-unavailable');
    expect(await s.kv.sMembers(K.allSubscribers)).toEqual([]);
  });

  it('takes the right address lock when one browser has requests pending for two addresses', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    const ch = { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    await s.signUp('ana@example.com', ch);
    const ben = await s.signUp('ben@example.com', ch);
    const write = s.kv.write.bind(s.kv);
    s.kv.write = async (ops) => {
      if (ops.some((o) => o.op === 'hSet' && o.key.startsWith('pp:sub:'))) throw new Error('process died');
      return write(ops);
    };
    expect((await s.post('/api/confirm', { token: ben.token, acknowledge: { emailOn: false, pushOn: true } })).status).toBe(500);
    s.kv.write = write;
    // The device belongs to ben's address: turning it off must use that lock, whatever ana's request says.
    const locks: string[] = [];
    const set = s.kv.set.bind(s.kv);
    s.kv.set = async (key, value, opts) => {
      if (key.startsWith('pp:lock:idx:')) locks.push(key);
      return set(key, value, opts);
    };
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
    const benIndex = (await s.kv.keys()).find((k) => k.startsWith('pp:push:address:'));
    expect(benIndex).toBeUndefined(); // removed with the device
    expect(locks).toHaveLength(1);
    expect(locks[0]).toBe(`pp:lock:idx:${emailIndex('ben@example.com', keys.index)}`);
  });

  it('writes nothing when the address was deleted while turning off waited', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    await (await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' })).confirm();
    const ids = await s.kv.sMembers(K.allSubscribers);
    const del = await s.post('/api/deletion-request', { email: 'juan@example.com' });
    expect(del.status).toBe(202);
    const delToken = /#token=([A-Za-z0-9_-]{43})/.exec(s.mailer.sent.at(-1)!.text)![1];
    await Promise.all([s.post('/api/delete-data', { token: delToken }), s.send('DELETE', '/api/push/device', { credential })]);
    expect(await s.kv.hGetAll(K.subscriber(ids[0]!))).toEqual({});
  });

  it('says when turning off the last device leaves no channel', async () => {
    const s = await site();
    const { credential, hash } = s.credential();
    await (await s.signUp('juan@example.com', { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' })).confirm();
    expect(await (await s.send('DELETE', '/api/push/device', { credential })).json()).toEqual({ ok: true, noChannel: true });
  });

  it('in owner mode accepts push sign-ups only for owner addresses, and says owner in the status', async () => {
    const s = await site({ mode: 'owner', vapid: VAPID, ownerEmails: ['juan@example.com'] });
    const status = (await (await s.app.request('/api/status', { headers: { 'user-agent': PHONE } })).json()) as { push: string; vapidPublicKey: string };
    expect(status).toMatchObject({ push: 'owner', vapidPublicKey: VAPID.publicKey });
    const { hash } = s.credential();
    const channels = { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' };
    const other = await s.post('/api/subscribe', { email: 'ana@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { fields: { channels: string } }).fields.channels).toMatch(/not available/);
    expect((await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels })).status).toBe(202);
  });

  it('refuses push sign-ups when push is off, and still takes email-only ones', async () => {
    const s = await site({ mode: 'off', vapid: null, ownerEmails: [] });
    const { hash } = s.credential();
    expect((await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } })).status).toBe(400);
    expect((await s.post('/api/subscribe', { email: 'juan@example.com', siteIds: [693], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: false } })).status).toBe(202);
  });

  it('lets two views wait for a confirmation for an hour, and turning off still works after', async () => {
    const s = await site();
    const { credential } = s.credential();
    // The sheet and the row each ask every 30 s: 240 calls in the hour.
    for (let i = 0; i < 240; i++) {
      expect((await s.post('/api/push/device', { credential })).status).toBe(200);
      s.t.advance(15_000);
    }
    expect((await s.send('DELETE', '/api/push/device', { credential })).status).toBe(200);
  });

  it('rate-limits device calls per credential and per network, but never blocks turning off', async () => {
    const s = await site();
    const one = s.credential();
    for (let i = 0; i < 300; i++) expect((await s.post('/api/push/device', { credential: one.credential })).status).toBe(200);
    s.setIp('203.0.113.2');
    expect((await s.post('/api/push/device', { credential: one.credential })).status).toBe(429); // per credential
    expect((await s.send('DELETE', '/api/push/device', { credential: one.credential })).status).toBe(200); // turning off still works
    for (let i = 0; i < 598; i++) await s.post('/api/push/device', { credential: s.credential().credential });
    expect((await s.post('/api/push/device', { credential: s.credential().credential })).status).toBe(429); // 600 from this network
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/server -- test/api-push.test.ts`
Expected: FAIL (routes missing).

- [ ] **Step 3: Implement `push/register.ts`**

```ts
// What a browser can do with its own credential: ask how its device is,
// register or replace its endpoint, turn it off. Answers say only what the
// credential's holder already knows.
import { createHash } from 'node:crypto';
import type { DeviceState, PushSubscriptionInput } from '@penge/contracts';
import { K } from '../keys.ts';
import type { Kv, ScriptDef } from '../kv.ts';
import { type Keys, load, withAddressLock } from '../subscribers.ts';
import { parseMeta, pushRegister, pushRemove, revokeCredential, REVOKED_TTL_SECONDS } from './atomic.ts';
import { listDevices, openDevice, pruneAwaiting, sealDevice } from './devices.ts';
import { endpointHmac, subscriptionHmac } from './endpoint.ts';

export const credentialHash = (credential: string) => createHash('sha256').update(credential).digest('base64url');

/** Deletes a credential entry only if it still names that owner and the owner's device is gone: one atomic step. */
const DEL_IF_ORPHAN: ScriptDef = {
  name: 'delIfOrphan',
  lua: `
if redis.call('TYPE', KEYS[1]).ok ~= 'string' or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'kept' end
local s, d = string.match(ARGV[1], '^([^/]+)/(.+)$')
local mk = ARGV[2] .. s
if redis.call('TYPE', mk).ok == 'hash' and redis.call('HEXISTS', mk, d) == 1 then return 'kept' end
redis.call('DEL', KEYS[1])
return 'deleted'`,
  memory: (tx, k, a) => {
    if (tx.type(k[0]!) !== 'string' || tx.get(k[0]!) !== a[0]) return 'kept';
    const slash = a[0]!.indexOf('/');
    const mk = `${a[1]}${a[0]!.slice(0, slash)}`;
    if (tx.type(mk) === 'hash' && tx.hGet(mk, a[0]!.slice(slash + 1)) !== null) return 'kept';
    tx.del(k[0]!);
    return 'deleted';
  },
};

/** The device a credential owns, or null. An entry naming a device that no longer exists is removed. */
export async function findDevice(kv: Kv, hash: string): Promise<{ subscriberId: string; deviceId: string } | null> {
  const owner = await kv.get(K.pushCred(hash));
  if (!owner) return null;
  const slash = owner.indexOf('/');
  const subscriberId = owner.slice(0, slash);
  const deviceId = owner.slice(slash + 1);
  if ((await kv.hGetAll(K.pushMeta(subscriberId)))[deviceId] === undefined) {
    // Rechecked inside the script: a confirmation may have bound it again meanwhile.
    if ((await kv.script(DEL_IF_ORPHAN, [K.pushCred(hash)], [owner, K.pushMeta('')])) === 'kept') return findDevice(kv, hash);
    return null;
  }
  return { subscriberId, deviceId };
}

async function hasPendingRequest(kv: Kv, hash: string): Promise<boolean> {
  for (const tokenHash of await kv.sMembers(K.pushPending(hash))) if (await kv.get(K.pending(tokenHash))) return true;
  return false;
}

export async function deviceCall(
  kv: Kv,
  keys: Keys,
  a: { credential: string; subscription: PushSubscriptionInput | null; revision: number | null; now: number },
): Promise<DeviceState> {
  const hash = credentialHash(a.credential);
  const found = await findDevice(kv, hash);
  if (!found) return (await hasPendingRequest(kv, hash)) ? 'pending' : 'missing';
  const subscriber = await load(kv, found.subscriberId);
  // Bound by a confirmation that has not finished writing the subscriber: still pending.
  if (!subscriber) return 'pending';
  return withAddressLock(kv, subscriber.index, async () => {
    await pruneAwaiting(kv, keys, found.subscriberId, a.now);
    const raw = (await kv.hGetAll(K.pushMeta(found.subscriberId)))[found.deviceId];
    if (raw === undefined) return 'missing';
    if (!a.subscription) return parseMeta(raw).state === 'r' ? 'registered' : 'awaiting';
    const s = a.subscription;
    const sealed = (await kv.hGetAll(K.pushDevices(found.subscriberId)))[found.deviceId];
    const before = sealed ? openDevice(keys, sealed) : null;
    const next = sealDevice(keys, { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, label: before?.label ?? null, createdAt: before?.createdAt ?? new Date(a.now).toISOString() });
    return pushRegister(kv, {
      subscriberId: found.subscriberId, deviceId: found.deviceId, revision: a.revision!,
      endpointHmac: endpointHmac(keys.index, s.endpoint), subscriptionHmac: subscriptionHmac(keys.index, s), sealed: next,
    });
  });
}

/** Revoke first, so a confirmation racing this cannot bind the credential; then remove a bound device, under its address lock. */
export async function turnOffDevice(kv: Kv, credential: string): Promise<{ noChannel: boolean }> {
  const hash = credentialHash(credential);
  await revokeCredential(kv, hash, REVOKED_TTL_SECONDS);
  const found = await findDevice(kv, hash);
  if (!found) return { noChannel: false };
  const remove = () => pushRemove(kv, { subscriberId: found.subscriberId, deviceId: found.deviceId, revokeSeconds: REVOKED_TTL_SECONDS, onlyIfEndpointHmac: null });
  const subscriber = await load(kv, found.subscriberId);
  // A device bound by a confirmation that has not written its subscriber yet carries
  // its address (pp:push:address, written with it): take that address's lock, the one
  // any confirmation for it holds. Neither found: the provisional keys have expired.
  const index = subscriber?.index ?? (await kv.get(K.pushAddress(found.subscriberId)));
  if (!index) {
    await remove();
    return { noChannel: false };
  }
  return withAddressLock(kv, index, async () => {
    await remove();
    if ((await listDevices(kv, found.subscriberId)).length === 0) await kv.write([{ op: 'del', key: K.pushAddress(found.subscriberId) }]);
    // Read again under the lock: the address may have been deleted while this waited.
    const now = await load(kv, found.subscriberId);
    if (!now) return { noChannel: false };
    if ((await listDevices(kv, found.subscriberId)).length > 0) return { noChannel: false };
    await kv.write([{ op: 'hSet', key: K.subscriber(found.subscriberId), fields: { pushOn: '0' } }]);
    return { noChannel: !now.emailOn };
  });
}
```

- [ ] **Step 4: Implement the routes**

`limits.ts`, in `API_LIMITS`:

```ts
  /** Push device calls (state, register, turn off) from one network address: a household's few devices, each polling. */
  devicePerIp: { bucket: 'push-ip', max: 600, windowSeconds: 3600 },
  /**
   * The same, for one device credential, from anywhere. Sized for the waiting views: the sheet
   * and the row each ask every 30 s (240 an hour together), with room for retries.
   */
  devicePerCredential: { bucket: 'push-cred', max: 300, windowSeconds: 3600 },
```

`api.ts`: import `checkPushSubscription` from `./push/endpoint.ts`; `credentialHash, deviceCall, turnOffDevice` from `./push/register.ts`; `previewPending` from `./subscribers.ts`; `type ConfirmPreview, type DeviceState, isCredential` from `@penge/contracts`; `type PushConfig` from `./config.ts`. Add `push: PushConfig` to `ApiDeps`. `fail`'s status union gains `409`.

`/api/status` returns, in addition, `push: deps.push.mode, vapidPublicKey: deps.push.vapid?.publicKey ?? null`.

After `validateSubscribe` in `/api/subscribe`:

```ts
    const ch = request.channels;
    const pushAllowed = (email: string) => deps.push.mode === 'live' || (deps.push.mode === 'owner' && deps.push.ownerEmails.includes(email));
    if (ch?.pushOn && !pushAllowed(request.email)) {
      return fail(c, 400, 'Please fix the highlighted fields.', { channels: 'Notifications are not available yet.' });
    }
```

(define `pushAllowed` once at the top of `createApi` and reuse it in `/api/confirm`.)

Replace `/api/confirm`:

```ts
  app.post('/api/confirm', async (c) => {
    if (await limited(c, API_LIMITS.tokenPerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body as { token?: unknown; acknowledge?: { emailOn?: unknown; pushOn?: unknown } } | null;
    const token = body?.token;
    if (!isToken(token)) return fail(c, 400, 'That link is not valid. Copy the whole link from the email.');
    const a = body?.acknowledge;
    const acknowledge = a && typeof a.emailOn === 'boolean' && typeof a.pushOn === 'boolean' ? { emailOn: a.emailOn, pushOn: a.pushOn } : undefined;
    const result = await confirm(kv, keys, token, now(), acknowledge, { pushAllowed });
    if (result.status === 'invalid') return fail(c, 404, 'That link has expired or was already used. Subscribe again to get a new one.');
    if (result.status === 'reload') {
      return c.json<ApiError>({ error: 'This page is out of date. Reload it, then open the confirmation link from your email again.', code: 'reload' }, 409);
    }
    if (result.status === 'full') {
      return c.json<ApiError>({ error: 'This alert already has notifications on 5 devices. Turn them off on one of them first.', code: 'full' }, 409);
    }
    if (result.status === 'push-unavailable') {
      const why = {
        owned: 'This device already gets alerts for another email address. Turn notifications off for that address on this device, then fill in the form again.',
        revoked: 'Notifications were turned off on this device. Fill in the form again to turn them back on, or choose email.',
        off: 'Notifications are not available right now. Fill in the form again with email on.',
      }[result.reason];
      return c.json<ApiError>({ error: why, code: 'push-unavailable' }, 409);
    }
    deps.stats?.count(result.status === 'confirmed' ? 'confirmed' : 'updated');
    return c.json<ConfirmResponse>({ status: result.status, siteIds: result.siteIds, applicants: result.applicants, pace: result.pace, channels: result.channels });
  });

  app.post('/api/confirm/preview', async (c) => {
    if (await limited(c, API_LIMITS.tokenPerIp)) return fail(c, 429, TOO_MANY);
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const token = (parsed.body as { token?: unknown } | null)?.token;
    if (!isToken(token)) return fail(c, 400, 'That link is not valid. Copy the whole link from the email.');
    const preview = await previewPending(kv, token);
    if (!preview) return fail(c, 404, 'That link has expired or was already used. Subscribe again to get a new one.');
    return c.json<ConfirmPreview>(preview);
  });
```

The device routes:

```ts
  /**
   * A device call: counted per network, and per credential unless it turns the device off
   * (turning off must always work for the device's holder; it only removes).
   */
  async function deviceRequest(c: Context, opts: { perCredential: boolean } = { perCredential: true }): Promise<{ ok: true; credential: string; body: Record<string, unknown> } | { ok: false; res: Response }> {
    if (await limited(c, API_LIMITS.devicePerIp)) return { ok: false, res: fail(c, 429, TOO_MANY) };
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed;
    const body = (parsed.body ?? {}) as Record<string, unknown>;
    if (!isCredential(body.credential)) return { ok: false, res: fail(c, 400, 'That device answer is not valid.') };
    if (opts.perCredential && !(await hit(kv, API_LIMITS.devicePerCredential, credentialHash(body.credential), now()))) return { ok: false, res: fail(c, 429, TOO_MANY) };
    return { ok: true, credential: body.credential, body };
  }

  app.post('/api/push/device', async (c) => {
    const r = await deviceRequest(c);
    if (!r.ok) return r.res;
    let subscription = null;
    let revision: number | null = null;
    if (r.body.subscription !== undefined) {
      subscription = checkPushSubscription(r.body.subscription);
      revision = typeof r.body.revision === 'number' && Number.isSafeInteger(r.body.revision) && r.body.revision >= 1 ? r.body.revision : null;
      if (!subscription || revision === null) return fail(c, 400, 'That device answer is not valid.');
    }
    const state = await deviceCall(kv, keys, { credential: r.credential, subscription, revision, now: now() });
    return c.json<{ state: DeviceState }>({ state });
  });

  app.delete('/api/push/device', async (c) => {
    const r = await deviceRequest(c, { perCredential: false });
    if (!r.ok) return r.res;
    const { noChannel } = await turnOffDevice(kv, r.credential);
    return c.json({ ok: true, noChannel });
  });
```

`server.ts` passes `push: config.push` to `createApi`. Existing API tests that build `createApi` without `push` add `push: { mode: 'off', vapid: null, ownerEmails: [] }` (`grep -rn "createApi(" apps/server/test`).

- [ ] **Step 5: Run every test and the typecheck**

Run: `npm test -w @penge/server && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Break it on purpose**

Let `/api/confirm` ignore `acknowledge` (always pass `{ emailOn: ch.emailOn, pushOn: ch.pushOn }` from the pending record): the 409 test FAILS. Restore. Move `revokeCredential` after `findDevice` in `turnOffDevice` and return early when nothing is found: "revokes a credential turned off before anyone confirmed" FAILS. Restore.

- [ ] **Step 7: Codex pass, then commit** (`API for confirmation previews, channel-aware confirm, and push devices`).

---

## Phase B: delivery and data

### Task 7: The push sender, and test notifications

**Files:**
- Modify: `apps/server/package.json` (add `web-push`, `@types/web-push`), `apps/server/src/api.ts`, `apps/server/src/limits.ts`, `apps/server/src/server.ts`
- Create: `apps/server/src/push/payload.ts`, `apps/server/src/push/sender.ts`
- Test: `apps/server/test/push-sender.test.ts`, `apps/server/test/api-push.test.ts`

**Interfaces:**
- Consumes: `Opening` (exported by `templates.ts`); `formatDate`, `shortName` (contracts); `checkPushSubscription`, `endpointHmac` (Task 3); `classifyPushError` (Task 3); `pushRemove` (Task 4); `listDevices`, `openDevice` (Task 5); `withAddressLock`, `load` (Task 5); `findDevice`, `credentialHash` (Task 6).
- Produces:
  - `buildPayload(a: { openings: Opening[]; applicants: number; decisionId: string }): string` (JSON, at most 3,000 bytes)
  - `interface PushTransport { send(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts: { TTL: number; urgency: 'high'; timeout: number }): Promise<void> }`, `webPushTransport(vapid): PushTransport`
  - `class PushPool { constructor(o: { transport; inFlight; budgetMs; timeoutMs; now }); hasBudget(): boolean; reserve(): boolean; send(deviceId, endpointHmac, sub, payload): Promise<DeviceOutcome>; settle(): Promise<void> }`
  - `type DeviceOutcome = { deviceId: string; endpointHmac: string; result: 'accepted' | 'gone' | 'refused' | 'too-big' | 'uncertain' | 'invalid'; status: number | null }`
  - `pushDecision(deps: { kv; keys; pool; log; now }, a: { subscriberId; index; payload; onlyDeviceId?: string }): Promise<{ any: 'accepted' | 'uncertain' | 'none'; outcomes: DeviceOutcome[] }>`
  - Constants `PUSH_TTL_SECONDS = 1800`, `PUSH_IN_FLIGHT = 8`, `PUSH_TIMEOUT_MS = 5000`, `PUSH_BUDGET_MS = 60_000`
  - Route `POST /api/push/test { credential }` → `{ ok: true }` | 404 | 429; `API_LIMITS.testPerDevice = { bucket: 'push-test', max: 3, windowSeconds: 3600 }`; `ApiDeps.pushTransport?: PushTransport`

`pushDecision` reads the sealed devices and their metadata together under the subscriber's address lock, checks each stored subscription with `checkPushSubscription` before sending (an invalid one is removed, conditionally, and never reaches the transport), sends outside the lock, then under the lock again removes `gone` and `invalid` devices with `onlyIfEndpointHmac` and writes notes (`lastSuccessAt`, `lastFailure`) into the sealed record only for devices whose metadata still has the endpoint that was sent to.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/push-sender.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { K } from '../src/keys.ts';
import { MemoryKv } from '../src/kv.ts';
import { silentLog } from '../src/log.ts';
import { listDevices, openDevice, sealDevice } from '../src/push/devices.ts';
import { buildPayload } from '../src/push/payload.ts';
import { deviceCall } from '../src/push/register.ts';
import { PushPool, type PushTransport, pushDecision } from '../src/push/sender.ts';
import { confirm, createPending, load } from '../src/subscribers.ts';
import { clock, fcmSubscription, keys } from './helpers.ts';

describe('push payload', () => {
  it('names one office, or counts them, and the group size', () => {
    const one = JSON.parse(buildPayload({ openings: [{ id: 486, name: 'Antipolo (SM Center, Antipolo City, Rizal)', dates: ['2026-10-09', '2026-10-12'] }], applicants: 2, decisionId: 'd1' }));
    expect(one).toMatchObject({ v: 1, title: 'Dates open at Antipolo', tag: 'alert-d1', url: { office: 486, date: '2026-10-09', people: 2 } });
    expect(one.body).toBe('Fri 9 Oct and Mon 12 Oct · for 2 people');
  });

  it('stays under 3 KB for ten offices with many dates (Review Focus 4)', () => {
    const dates = Array.from({ length: 40 }, (_, i) => `2026-11-${String((i % 28) + 1).padStart(2, '0')}`);
    const openings = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, name: `Office ${i} (A very long mall name, ${'x'.repeat(80)})`, dates }));
    const p = buildPayload({ openings, applicants: 1, decisionId: 'd2' });
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(3000);
    expect(JSON.parse(p).title).toBe('Dates open at 10 offices');
    expect(JSON.parse(p).body).toMatch(/and \d+ more · for 1 person$/);
  });
});

const sub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } };

describe('push pool', () => {
  it('keeps at most 8 sends in flight', async () => {
    let inFlight = 0;
    let most = 0;
    const transport: PushTransport = {
      async send() {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: clock().now });
    await Promise.all(Array.from({ length: 30 }, (_, i) => pool.send(`d${i}`, 'e', sub, '{}')));
    expect(most).toBe(8);
  });

  it('stops offering slots once the budget is spent, and still settles started sends', async () => {
    const t = clock();
    const transport: PushTransport = { async send() { t.advance(30_000); } };
    const pool = new PushPool({ transport, inFlight: 1, budgetMs: 60_000, timeoutMs: 5000, now: t.now });
    expect(pool.reserve()).toBe(true);
    await pool.send('d1', 'e', sub, '{}');
    expect(pool.reserve()).toBe(true);
    await pool.send('d2', 'e', sub, '{}');
    expect(pool.hasBudget()).toBe(false);
    expect(pool.reserve()).toBe(false);
    await pool.settle();
  });

  it('gives up on a transport that never answers, frees its slot, and calls it uncertain', async () => {
    vi.useFakeTimers();
    const transport: PushTransport = { send: () => new Promise(() => {}) };
    const pool = new PushPool({ transport, inFlight: 1, budgetMs: 60_000, timeoutMs: 5000, now: Date.now });
    const first = pool.send('d1', 'e1', sub, '{}');
    const second = pool.send('d2', 'e2', sub, '{}'); // waits for the only slot
    await vi.advanceTimersByTimeAsync(6000);
    expect((await first).result).toBe('uncertain');
    await vi.advanceTimersByTimeAsync(6000);
    expect((await second).result).toBe('uncertain');
    await pool.settle();
    vi.useRealTimers();
  });

  it('turns a timeout into uncertain and a 410 into gone', async () => {
    const transport: PushTransport = {
      async send(s) {
        if (s.endpoint.endsWith('gone')) throw Object.assign(new Error('x'), { statusCode: 410 });
        throw new Error('Socket timeout');
      },
    };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: clock().now });
    expect((await pool.send('d1', 'e1', { ...sub, endpoint: 'https://fcm.googleapis.com/gone' }, '{}')).result).toBe('gone');
    expect((await pool.send('d2', 'e2', sub, '{}')).result).toBe('uncertain');
  });
});

/** A subscriber with `n` registered devices on fcm.googleapis.com. */
async function withDevices(n: number) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  const creds: string[] = [];
  let id = '';
  for (let i = 0; i < n; i++) {
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(kv, keys, { email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, t.now());
    const r = await confirm(kv, keys, token, t.now(), { emailOn: true, pushOn: true });
    if (r.status !== 'confirmed' && r.status !== 'updated') throw new Error(r.status);
    id = r.subscriberId;
    const s = fcmSubscription(`dev${i}`);
    expect(await deviceCall(kv, keys, { credential, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 1, now: t.now() })).toBe('registered');
    creds.push(credential);
  }
  const index = (await load(kv, id))!.index;
  return { t, kv, id, index, creds };
}

describe('pushing one decision', () => {
  it('removes a gone device and keeps the other', async () => {
    const w = await withDevices(2);
    const transport: PushTransport = { async send(s) { if (s.endpoint.endsWith('dev0')) throw Object.assign(new Error('x'), { statusCode: 410 }); } };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    const r = await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' });
    expect(r.any).toBe('accepted');
    const [kept] = await listDevices(w.kv, w.id);
    expect(kept).toBeTruthy();
    expect(openDevice(keys, (await w.kv.hGetAll(K.pushDevices(w.id)))[kept!.id]!).lastSuccessAt).toBeTruthy();
  });

  it('never removes a device when a rotation races a push', async () => {
    for (let i = 0; i < 20; i++) {
      const w = await withDevices(1);
      const transport: PushTransport = { async send() { throw Object.assign(new Error('x'), { statusCode: 410 }); } };
      const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
      const s = fcmSubscription(`rot${i}`);
      await Promise.all([
        pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' }),
        deviceCall(w.kv, keys, { credential: w.creds[0]!, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 2, now: w.t.now() }),
      ]);
      // Either the 410 was for the old endpoint and the device kept its new one, or the rotation came after the removal and says missing.
      const left = await listDevices(w.kv, w.id);
      if (left.length === 1) expect(left[0]!.meta.revision).toBe(2);
    }
  });

  it('keeps a device whose endpoint changed while the 410 was on its way', async () => {
    const w = await withDevices(1);
    const transport: PushTransport = {
      async send() {
        const s = fcmSubscription('rotated');
        await deviceCall(w.kv, keys, { credential: w.creds[0]!, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 2, now: w.t.now() });
        throw Object.assign(new Error('x'), { statusCode: 410 });
      },
    };
    const pool = new PushPool({ transport, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' });
    expect(await listDevices(w.kv, w.id)).toHaveLength(1);
  });

  it('never sends to a stored endpoint that fails the checks, and removes it', async () => {
    const w = await withDevices(1);
    const [dev] = await listDevices(w.kv, w.id);
    await w.kv.write([{ op: 'hSet', key: K.pushDevices(w.id), fields: { [dev!.id]: sealDevice(keys, { endpoint: 'https://127.0.0.1/x', p256dh: fcmSubscription().keys.p256dh, auth: fcmSubscription().keys.auth, label: null, createdAt: new Date(w.t.now()).toISOString() }) } }]);
    let sent = 0;
    const pool = new PushPool({ transport: { async send() { sent++; } }, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    const r = await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}' });
    expect(sent).toBe(0);
    expect(r.any).toBe('none');
    expect(await listDevices(w.kv, w.id)).toHaveLength(0);
  });

  it('sends only to the named device when asked', async () => {
    const w = await withDevices(2);
    const seen: string[] = [];
    const pool = new PushPool({ transport: { async send(s) { seen.push(s.endpoint); } }, inFlight: 8, budgetMs: 60_000, timeoutMs: 5000, now: w.t.now });
    const [, second] = await listDevices(w.kv, w.id);
    await pushDecision({ kv: w.kv, keys, pool, log: silentLog, now: w.t.now }, { subscriberId: w.id, index: w.index, payload: '{}', onlyDeviceId: second!.id });
    expect(seen).toHaveLength(1);
  });
});
```

Append to `apps/server/test/api-push.test.ts`:

```ts
it('sends a test notification to the requesting device only, three an hour', async () => {
  const sent: string[] = [];
  const transport = { async send(s: { endpoint: string }) { sent.push(s.endpoint); } };
  const s = await site(undefined, transport);
  const a = s.credential();
  const b = s.credential();
  await (await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: a.hash, device: 'Chrome on Android' })).confirm();
  await (await s.signUp('juan@example.com', { emailOn: true, pushOn: true, pushCredentialHash: b.hash, device: 'Firefox on Mac' })).confirm();
  expect((await s.post('/api/push/test', { credential: a.credential })).status).toBe(404); // not registered yet
  await s.post('/api/push/device', { credential: a.credential, subscription: fcmSubscription('phone'), revision: 1 });
  await s.post('/api/push/device', { credential: b.credential, subscription: fcmSubscription('mac'), revision: 1 });
  for (let i = 0; i < 3; i++) expect((await s.post('/api/push/test', { credential: a.credential })).status).toBe(200);
  expect((await s.post('/api/push/test', { credential: a.credential })).status).toBe(429);
  expect(sent).toEqual(Array(3).fill('https://fcm.googleapis.com/fcm/send/phone'));
  await s.kv.set(K.pushPaused, '1');
  s.setIp('203.0.113.9');
  expect((await s.post('/api/push/test', { credential: b.credential })).status).toBe(503);
  expect(sent).toHaveLength(3);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/server -- test/push-sender.test.ts test/api-push.test.ts`
Expected: FAIL (modules and route missing).

- [ ] **Step 3: Add the dependency**

```bash
npm install -w @penge/server web-push@^3.6.7
npm install -w @penge/server -D @types/web-push
npm run build -w @penge/server
```

Expected: the build still writes `dist/server.mjs`, `dist/check.mjs`, `dist/admin.mjs` (esbuild bundles `web-push`; it has no native parts).

- [ ] **Step 4: Implement `payload.ts`**

```ts
// What a push alert says. One notification per decision, like one email, and
// under 3 KB so every push service takes it (their limit is 4 KB).
import { formatDate, shortName } from '@penge/contracts';
import type { Opening } from '../templates.ts';

const LIMIT = 3000;
const day = (d: string) => formatDate(d).replace(/ \d{4}$/, '');

export function buildPayload(a: { openings: Opening[]; applicants: number; decisionId: string }): string {
  const first = a.openings[0]!;
  const title = a.openings.length === 1 ? `Dates open at ${shortName(first.name)}` : `Dates open at ${a.openings.length} offices`;
  const dates = [...new Set(a.openings.flatMap((o) => o.dates))].sort();
  const people = a.applicants === 1 ? 'for 1 person' : `for ${a.applicants} people`;
  const url = { office: first.id, date: first.dates[0] ?? null, people: a.applicants };
  const make = (body: string) => JSON.stringify({ v: 1, title, body, tag: `alert-${a.decisionId}`, url });
  for (let shown = Math.min(dates.length, 6); shown >= 1; shown--) {
    const named = dates.slice(0, shown).map(day);
    const rest = dates.length - shown;
    const list = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]!;
    const p = make(`${list} · ${people}`);
    if (Buffer.byteLength(p) <= LIMIT) return p;
  }
  return make(people);
}
```

- [ ] **Step 5: Implement `sender.ts`**

```ts
// Sends pushes: at most PUSH_IN_FLIGHT at once, PUSH_TIMEOUT_MS each, and no
// new decision after PUSH_BUDGET_MS of a delivery pass, so slow push services
// cannot hold up email or outlast the checker's lock.
import webpush from 'web-push';
import { K } from '../keys.ts';
import type { Kv } from '../kv.ts';
import type { Logger } from '../log.ts';
import { type Keys, withAddressLock } from '../subscribers.ts';
import { parseMeta, pushRemove } from './atomic.ts';
import { listDevices, openDevice, sealDevice } from './devices.ts';
import { checkPushSubscription, endpointHmac } from './endpoint.ts';
import { classifyPushError } from './errors.ts';

export const PUSH_TTL_SECONDS = 1800;
export const PUSH_IN_FLIGHT = 8;
export const PUSH_TIMEOUT_MS = 5000;
export const PUSH_BUDGET_MS = 60_000;

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };

export interface PushTransport {
  send(sub: Sub, payload: string, opts: { TTL: number; urgency: 'high'; timeout: number }): Promise<void>;
}

export function webPushTransport(vapid: { publicKey: string; privateKey: string; subject: string }): PushTransport {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(sub, payload, opts) {
      await webpush.sendNotification(sub, payload, { TTL: opts.TTL, urgency: opts.urgency, timeout: opts.timeout });
    },
  };
}

export type DeviceOutcome = {
  deviceId: string;
  endpointHmac: string;
  result: 'accepted' | 'gone' | 'refused' | 'too-big' | 'uncertain' | 'invalid';
  status: number | null;
};

export class PushPool {
  private readonly started: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly o: { transport: PushTransport; inFlight: number; budgetMs: number; timeoutMs: number; now: () => number }) {
    this.started = o.now();
  }
  hasBudget() {
    return this.o.now() - this.started < this.o.budgetMs;
  }
  /** Room for one more decision's pushes; asked before the claim. */
  reserve() {
    return this.hasBudget();
  }
  async send(deviceId: string, endpointHmac: string, sub: Sub, payload: string): Promise<DeviceOutcome> {
    if (this.running >= this.o.inFlight) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    // web-push closes its socket after `timeout`; this deadline also covers a transport
    // that never settles, so a slot is never held for good. Past it, the push may have
    // gone out: uncertain, so it is never sent twice.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Socket timeout')), this.o.timeoutMs + 1000);
    });
    const job = Promise.race([this.o.transport.send(sub, payload, { TTL: PUSH_TTL_SECONDS, urgency: 'high', timeout: this.o.timeoutMs }), deadline])
      .finally(() => clearTimeout(timer))
      .then((): DeviceOutcome => ({ deviceId, endpointHmac, result: 'accepted', status: 201 }))
      .catch((err: unknown): DeviceOutcome => {
        const f = classifyPushError(err);
        return { deviceId, endpointHmac, result: f.category, status: f.status };
      })
      .finally(() => {
        this.running--;
        this.waiting.shift()?.();
      });
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
    return job;
  }
  /** Waits for every send that started. */
  async settle() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

/** One decision's pushes, to every registered device of a subscriber (or to one). */
export async function pushDecision(
  deps: { kv: Kv; keys: Keys; pool: PushPool; log: Logger; now: () => number },
  a: { subscriberId: string; index: string; payload: string; onlyDeviceId?: string },
): Promise<{ any: 'accepted' | 'uncertain' | 'none'; outcomes: DeviceOutcome[]; removed: number }> {
  // The sealed records and their metadata are read together, under the lock, so a
  // registration cannot slip between the two reads. The sends happen outside it.
  const snapshot = await withAddressLock(deps.kv, a.index, async () => ({
    sealed: await deps.kv.hGetAll(K.pushDevices(a.subscriberId)),
    devices: await listDevices(deps.kv, a.subscriberId),
  }));
  const sends: Promise<DeviceOutcome>[] = [];
  const invalid: DeviceOutcome[] = [];
  for (const d of snapshot.devices) {
    if (d.meta.state !== 'r' || (a.onlyDeviceId && d.id !== a.onlyDeviceId) || !snapshot.sealed[d.id]) continue;
    const dev = openDevice(deps.keys, snapshot.sealed[d.id]!);
    const checked = checkPushSubscription({ endpoint: dev.endpoint, keys: { p256dh: dev.p256dh, auth: dev.auth } });
    if (!checked || endpointHmac(deps.keys.index, checked.endpoint) !== d.meta.endpointHmac) {
      invalid.push({ deviceId: d.id, endpointHmac: d.meta.endpointHmac, result: 'invalid', status: null });
      continue;
    }
    sends.push(deps.pool.send(d.id, d.meta.endpointHmac, { endpoint: checked.endpoint, keys: { p256dh: checked.p256dh, auth: checked.auth } }, a.payload));
  }
  const outcomes = [...invalid, ...(await Promise.all(sends))];
  const at = new Date(deps.now()).toISOString();
  let removed = 0;
  // Clean-up and notes under the address lock, and only for devices that still have the endpoint sent to.
  await withAddressLock(deps.kv, a.index, async () => {
    const meta = await deps.kv.hGetAll(K.pushMeta(a.subscriberId));
    const sealed = await deps.kv.hGetAll(K.pushDevices(a.subscriberId));
    const notes: Record<string, string> = {};
    for (const o of outcomes) {
      if (o.result === 'gone' || o.result === 'invalid') {
        if ((await pushRemove(deps.kv, { subscriberId: a.subscriberId, deviceId: o.deviceId, revokeSeconds: 0, onlyIfEndpointHmac: o.endpointHmac || null })) === 'removed') removed++;
        continue;
      }
      const raw = meta[o.deviceId];
      if (!raw || parseMeta(raw).endpointHmac !== o.endpointHmac || !sealed[o.deviceId]) continue;
      const dev = openDevice(deps.keys, sealed[o.deviceId]!);
      const next = o.result === 'accepted' ? { ...dev, lastSuccessAt: at } : { ...dev, lastFailure: `${at} ${o.status ?? ''} ${o.result}`.replace(/\s+/g, ' ').trim() };
      notes[o.deviceId] = sealDevice(deps.keys, next);
    }
    if (Object.keys(notes).length > 0) await deps.kv.write([{ op: 'hSet', key: K.pushDevices(a.subscriberId), fields: notes }]);
  });
  for (const o of outcomes) if (o.result !== 'accepted') deps.log.warn('push not accepted', { device: o.deviceId, status: o.status, category: o.result });
  const any = outcomes.some((o) => o.result === 'accepted') ? 'accepted' : outcomes.some((o) => o.result === 'uncertain') ? 'uncertain' : 'none';
  return { any, outcomes, removed };
}
```

- [ ] **Step 6: The test notification route**

`limits.ts`: `testPerDevice: { bucket: 'push-test', max: 3, windowSeconds: 3600 },`. `api.ts`: `ApiDeps` gains `pushTransport?: PushTransport`; the route:

```ts
  app.post('/api/push/test', async (c) => {
    const r = await deviceRequest(c);
    if (!r.ok) return r.res;
    const hash = credentialHash(r.credential);
    const found = await findDevice(kv, hash);
    const subscriber = found ? await load(kv, found.subscriberId) : null;
    const meta = found ? (await kv.hGetAll(K.pushMeta(found.subscriberId)))[found.deviceId] : undefined;
    if (!found || !subscriber || !meta || parseMeta(meta).state !== 'r' || !deps.pushTransport) {
      return fail(c, 404, 'Notifications are not on for this device yet.');
    }
    if (await kv.get(K.pushPaused)) return fail(c, 503, 'Notifications are paused for maintenance. Try again later.');
    if (!(await hit(kv, API_LIMITS.testPerDevice, hash, now()))) return fail(c, 429, 'You can send 3 test notifications an hour. Try again later.');
    const pool = new PushPool({ transport: deps.pushTransport, inFlight: 1, budgetMs: PUSH_TIMEOUT_MS * 2, timeoutMs: PUSH_TIMEOUT_MS, now });
    const payload = JSON.stringify({ v: 1, title: 'Test notification', body: 'Notifications work on this device.', tag: 'test', url: {} });
    const { any } = await pushDecision({ kv, keys, pool, log, now }, { subscriberId: found.subscriberId, index: subscriber.index, payload, onlyDeviceId: found.deviceId });
    if (any === 'none') return fail(c, 404, 'That test did not reach this device. Turn notifications off and on again.');
    return c.json({ ok: true });
  });
```

`server.ts` spreads `...(config.push.vapid ? { pushTransport: webPushTransport(config.push.vapid) } : {})` into `createApi`'s deps (with `exactOptionalPropertyTypes`, an optional property is left out, never `undefined`). The `site()` helper in `api-push.test.ts` already passes a `pushTransport` when given one.

- [ ] **Step 7: Run every test and the typecheck** → PASS.

- [ ] **Step 8: Break it on purpose**: drop the `checkPushSubscription` call in `pushDecision`: "never sends to a stored endpoint that fails the checks" FAILS. Restore. Drop `onlyIfEndpointHmac` from the `gone` clean-up: "keeps a device whose endpoint changed" FAILS. Restore.

- [ ] **Step 9: Codex pass, then commit** (`Push sender: payload, a bounded pool, per-device outcomes, and test notifications`).

---

### Task 8: Each alert to every available channel (the checker)

**Files:**
- Modify: `apps/server/src/checker.ts`, `apps/server/src/check.ts`, `apps/server/test/helpers.ts`, `apps/server/test/stats.test.ts`, `apps/server/test/checker.test.ts`
- Test: `apps/server/test/checker-push.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 7.
- Produces:
  - `CheckDeps` gains `push?: { mode: PushMode; transport: PushTransport | null }` and `lockCheck?: () => Promise<void>`
  - `DeliveryReport` becomes `{ sent; dryRun; skipped; failed; dropped; held; remaining; stoppedBy: 'all channels' | null; emailBlocked: 'paused' | 'daily limit' | 'mail errors' | 'off' | null; push: { accepted: number; refused: number; uncertain: number; gone: number; heldNoChannel: number } }`
  - `export function shouldRunAbroadDelivery(report: DeliveryReport): boolean` (`report.stoppedBy !== 'all channels'`)
  - `export function settleOutcome(email: EmailOutcome, push: 'accepted' | 'uncertain' | 'none', pushChosen: boolean): 'delivered' | 'retry'` with `type EmailOutcome = 'sent' | 'dry-run' | 'refused' | 'uncertain' | 'none'`
  - `COUNTS` (stats) gains `'pushAccepted' | 'pushRefused' | 'pushUncertain' | 'pushGone' | 'pushDevicesRemoved'` (`pushGone` counts sends that came back gone or invalid; `pushDevicesRemoved` counts devices actually removed, by that or by expiry)

- [ ] **Step 1: Share the test log helper**

`recordingLog` is defined privately in `apps/server/test/stats.test.ts` and `apps/server/test/checker.test.ts`. Move it to `apps/server/test/helpers.ts`, export it, and import it in both:

```ts
import type { Logger } from '../src/log.ts';

export function recordingLog() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m, f) => lines.push(JSON.stringify({ m, f })),
    warn: (m, f) => lines.push(JSON.stringify({ m, f })),
    error: (m, f) => lines.push(JSON.stringify({ m, f })),
  };
  return { log, lines };
}
```

Run: `npm test -w @penge/server`. Expected: PASS (nothing else changed).

- [ ] **Step 2: Write the failing tests**

`apps/server/test/checker-push.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Pace } from '@penge/contracts';
import { type CheckDeps, type DeliveryReport, runCheck, settleOutcome, shouldRunAbroadDelivery } from '../src/checker.ts';
import { K, manilaDay } from '../src/keys.ts';
import { MemoryKv } from '../src/kv.ts';
import { deviceCall } from '../src/push/register.ts';
import type { PushTransport } from '../src/push/sender.ts';
import { confirm, createPending } from '../src/subscribers.ts';
import { clock, FakeMailer, FakeUpstream, fcmSubscription, keys, MemorySink, recordingLog } from './helpers.ts';

class FakePush implements PushTransport {
  sent: { endpoint: string; payload: string }[] = [];
  attempts = 0;
  answer: (endpoint: string) => Promise<void> = async () => {};
  async send(sub: { endpoint: string }, payload: string) {
    this.attempts++;
    await this.answer(sub.endpoint);
    this.sent.push({ endpoint: sub.endpoint, payload });
  }
}

async function world(over: Partial<CheckDeps> = {}, start?: number) {
  const t = clock(start);
  const kv = new MemoryKv(t.now);
  const upstream = new FakeUpstream();
  const mailer = (over.mailer as FakeMailer | undefined) ?? new FakeMailer();
  const push = new FakePush();
  const { log, lines } = recordingLog();
  const deps: CheckDeps = {
    kv, upstream, sink: new MemorySink(), mailer, keys, log,
    publicBaseUrl: 'https://penge.example', mailDailyLimit: 300, alertsPerSubscriberPerDay: 288,
    client: 'penge-passport-ph@test', uptime: () => null, now: t.now,
    push: { mode: 'live', transport: push },
    ...over,
  };
  let n = 0;
  const run = async () => {
    const report = await runCheck({ ...deps, runId: `run${++n}` });
    t.advance(10 * 60_000);
    return report;
  };
  const subscribeWith = async (email: string, siteIds: number[], ch: { emailOn: boolean; pushOn: boolean }, pace: Pace = 'asap') => {
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(kv, keys, {
      email, siteIds, applicants: 1, pace,
      channels: { ...ch, pushCredentialHash: ch.pushOn ? hash : null, device: ch.pushOn ? 'Chrome on Android' : null },
    }, t.now());
    const r = await confirm(kv, keys, token, t.now(), ch);
    if (r.status !== 'confirmed' && r.status !== 'updated') throw new Error(`confirm: ${r.status}`);
    if (ch.pushOn) {
      const s = fcmSubscription();
      const state = await deviceCall(kv, keys, { credential, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 1, now: t.now() });
      if (state !== 'registered') throw new Error(`register: ${state}`);
    }
    return r.subscriberId;
  };
  return { t, kv, upstream, mailer, push, deps, lines, run, subscribeWith };
}

const alerts = (m: FakeMailer) => m.sent.filter((x) => x.kind === 'alert');
type World = Awaited<ReturnType<typeof world>>;
/** A baseline run, then a run where Antipolo opens a date. */
async function opens(w: World, dates = ['2026-10-06']) {
  await w.run();
  w.upstream.open.set('486', dates);
  return w.run();
}

describe('delivering to every channel', () => {
  it('sends push to a push-only person and no email', async () => {
    const w = await world();
    const id = await w.subscribeWith('ana@example.com', [486], { emailOn: false, pushOn: true });
    await opens(w);
    expect(w.push.sent).toHaveLength(1);
    expect(JSON.parse(w.push.sent[0]!.payload).title).toBe('Dates open at Antipolo');
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(await w.kv.get(K.mailSentToday(manilaDay(w.t.now())))).toBeNull();
    expect(await w.kv.get(K.lastAlert(id))).not.toBeNull();
  });

  it('sends both to a person with both on, and charges email once', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await opens(w);
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(1);
    expect(await w.kv.get(K.mailSentToday(manilaDay(w.t.now())))).toBe('1');
  });

  it('removes an awaiting device older than 48 hours before anyone is considered', async () => {
    const w = await world();
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: false });
    const id = (await w.kv.sMembers(K.allSubscribers))[0]!;
    const t2 = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    await confirm(w.kv, keys, t2, w.t.now(), { emailOn: true, pushOn: true });
    expect(Object.keys(await w.kv.hGetAll(K.pushMeta(id)))).toHaveLength(1);
    w.t.advance(49 * 3600_000);
    await w.run();
    expect(await w.kv.hGetAll(K.pushMeta(id))).toEqual({});
  });

  it('holds a push-only person whose device is still awaiting registration, uncharged', async () => {
    const w = await world();
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(w.kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, w.t.now());
    const r = await confirm(w.kv, keys, token, w.t.now(), { emailOn: false, pushOn: true });
    const id = r.status === 'confirmed' ? r.subscriberId : '';
    const report = await opens(w);
    expect(w.push.attempts).toBe(0);
    expect(await w.kv.get(K.lastAlert(id))).toBeNull();
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([id]);
    expect(report.delivery!.push.heldNoChannel).toBe(1);
  });

  it('keeps pushing when the email limit is reached, and holds email-only people', async () => {
    const w = await world({ mailDailyLimit: 0 });
    const emailOnly = await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: false });
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    const report = await opens(w);
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([emailOnly]);
    expect(report.delivery!.emailBlocked).toBe('daily limit');
    expect(report.delivery!.stoppedBy).toBeNull();
  });

  it('keeps pushing while mail is paused', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.upstream.open.set('486', ['2026-10-06']);
    const report = await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(0);
    expect(report.delivery!.emailBlocked).toBe('paused');
  });

  it('keeps pushing after three mail errors in a row', async () => {
    const w = await world();
    for (const name of ['a', 'b', 'c', 'd']) await w.subscribeWith(`${name}@example.com`, [486], { emailOn: true, pushOn: true });
    await w.run();
    w.mailer.failNext = 3;
    w.upstream.open.set('486', ['2026-10-06']);
    const report = await w.run();
    expect(w.push.sent).toHaveLength(4);
    expect(report.delivery!.emailBlocked).toBe('mail errors');
  });

  it('pushes for a post abroad while email is blocked, in the abroad delivery pass', async () => {
    const { abroadWorld } = await import('./abroad-world.ts');
    const push = new FakePush();
    const w = await abroadWorld({ mailDailyLimit: 0, push: { mode: 'live', transport: push } });
    await w.subscribeWith('ana@example.com', [497], { emailOn: true, pushOn: true });
    await w.run(); // the first look at the post is a baseline
    w.abroad.open.set('497', ['2026-10-06']);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    const report = await w.run();
    expect(report.abroad).toMatchObject({ trusted: true, queued: 1 });
    expect(push.sent).toHaveLength(1);
    expect(JSON.parse(push.sent[0]!.payload).title).toBe('Dates open at Copenhagen');
    expect(w.mailer.sent.filter((m) => m.kind === 'alert')).toHaveLength(0);
  });

  it('gives each delivery its own notification tag, even when a held job goes out in two parts', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: false, pushOn: true }, 'hourly');
    await w.run();
    w.upstream.open.set('486', ['2026-10-05']);
    await w.run(); // delivered now; the next waits an hour (hourly pace)
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    await w.run(); // 6 and 7 are news: held, as one job
    for (let i = 0; i < 6; i++) {
      w.upstream.open.set('486', ['2026-10-05', '2026-10-06']); // 7 is closed when the hour is up
      await w.run();
    }
    expect(w.push.sent).toHaveLength(2); // 5, then 6; 7 still waits with the same job
    w.upstream.open.set('486', ['2026-10-05', '2026-10-06', '2026-10-07']);
    for (let i = 0; i < 7; i++) await w.run();
    expect(w.push.sent).toHaveLength(3); // then 7, from the job's leftover
    const tags = w.push.sent.map((p) => JSON.parse(p.payload).tag as string);
    expect(new Set(tags).size).toBe(3);
  });

  it('runs the abroad delivery pass unless every channel was unavailable', () => {
    const base = { sent: 0, dryRun: 0, skipped: 0, failed: 0, dropped: 0, held: 0, remaining: 0, emailBlocked: 'daily limit', push: { accepted: 0, refused: 0, uncertain: 0, gone: 0, heldNoChannel: 0 } } as const;
    expect(shouldRunAbroadDelivery({ ...base, stoppedBy: null } as DeliveryReport)).toBe(true);
    expect(shouldRunAbroadDelivery({ ...base, stoppedBy: 'all channels' } as DeliveryReport)).toBe(false);
  });

  it('settles every outcome as the spec table says', () => {
    expect(settleOutcome('sent', 'none', true)).toBe('delivered');
    expect(settleOutcome('refused', 'accepted', true)).toBe('delivered');
    expect(settleOutcome('refused', 'uncertain', true)).toBe('delivered');
    expect(settleOutcome('refused', 'none', true)).toBe('retry');
    expect(settleOutcome('uncertain', 'none', true)).toBe('delivered');
    expect(settleOutcome('none', 'accepted', true)).toBe('delivered');
    expect(settleOutcome('none', 'none', true)).toBe('retry');
    expect(settleOutcome('dry-run', 'none', false)).toBe('delivered');
    expect(settleOutcome('dry-run', 'none', true)).toBe('retry');
  });

  it('refunds the email allowance when email is refused but push got through, and does not retry', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    w.mailer.failNext = 1;
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(await w.kv.get(K.mailSentToday(manilaDay(w.t.now())))).toBe('0');
    await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(0);
  });

  it('undoes everything and retries when email is refused and every push is refused', async () => {
    const w = await world();
    const id = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    await w.run();
    w.mailer.failNext = 1;
    w.push.answer = async () => { throw Object.assign(new Error('x'), { statusCode: 503 }); };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(await w.kv.get(K.lastAlert(id))).toBeNull();
    expect(await w.kv.sMembers(K.heldSubscribers)).toEqual([id]);
    w.push.answer = async () => {};
    await w.run();
    expect(w.push.sent).toHaveLength(1);
    expect(alerts(w.mailer)).toHaveLength(1);
  });

  it('treats a timed-out push as delivered and never sends it again', async () => {
    const w = await world();
    await w.subscribeWith('ana@example.com', [486], { emailOn: false, pushOn: true });
    w.push.answer = async () => { throw new Error('Socket timeout'); };
    await opens(w);
    await w.run();
    expect(w.push.attempts).toBe(1);
  });

  it('counts a simulated email only for people without push', async () => {
    const w = await world({ mailer: new FakeMailer('dry-run') });
    w.push.answer = async () => { throw Object.assign(new Error('x'), { statusCode: 503 }); };
    const both = await w.subscribeWith('ana@example.com', [486], { emailOn: true, pushOn: true });
    const emailOnly = await w.subscribeWith('ben@example.com', [486], { emailOn: true, pushOn: false });
    await opens(w);
    expect(await w.kv.get(K.lastAlert(emailOnly))).not.toBeNull();
    expect(await w.kv.get(K.lastAlert(both))).toBeNull();
  });

  it('gives a new Manila day a fresh email allowance in a run that crosses midnight', async () => {
    // 23:40 in Manila on 27 September; the baseline run moves the clock to 23:50.
    const w = await world({ mailDailyLimit: 1 }, Date.parse('2026-09-27T15:40:00Z'));
    await w.subscribeWith('a@example.com', [486], { emailOn: true, pushOn: false });
    await w.subscribeWith('b@example.com', [486], { emailOn: true, pushOn: true });
    await w.subscribeWith('c@example.com', [486], { emailOn: true, pushOn: false });
    await w.run();
    // b's push takes 15 minutes: c is considered on the 28th.
    w.push.answer = async () => { w.t.advance(15 * 60_000); };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(alerts(w.mailer)).toHaveLength(2); // a on the 27th, c on the 28th; b's email was blocked by the 27th's limit
    expect(w.push.sent).toHaveLength(1);
    expect(await w.kv.get(K.mailSentToday('2026-09-28'))).toBe('1');
  });

  it('stops starting pushes after the budget and lets email carry on', async () => {
    const w = await world();
    for (const name of ['a', 'b', 'c']) await w.subscribeWith(`${name}@example.com`, [486], { emailOn: true, pushOn: true });
    await w.run();
    w.push.answer = async () => { w.t.advance(30_000); };
    w.upstream.open.set('486', ['2026-10-06']);
    await w.run();
    expect(w.push.sent).toHaveLength(2);
    expect(alerts(w.mailer)).toHaveLength(3);
  });

  it('checks the lock once a pass has run for 30 seconds, and stops if it was lost', async () => {
    let checks = 0;
    const w = await world({ lockCheck: async () => { checks++; throw new Error('lost the checker lock; stopping this run'); } });
    for (const name of ['a', 'b', 'c']) await w.subscribeWith(`${name}@example.com`, [486], { emailOn: false, pushOn: true });
    await w.run();
    w.push.answer = async () => { w.t.advance(20_000); };
    w.upstream.open.set('486', ['2026-10-06']);
    await expect(w.run()).rejects.toThrow(/lost the checker lock/);
    expect(checks).toBe(1);
    expect(w.push.sent).toHaveLength(2);
  });
});
```

The abroad test needs the posts-abroad fake that `abroad.test.ts` keeps privately. Move `FakeAbroad`, `post()` and that file's `world()` into `apps/server/test/abroad-world.ts` as `export class FakeAbroad`, `export function post` and `export async function abroadWorld(over: Partial<CheckDeps> = {})` (its `world()` with `...over` spread into `deps`, and a `subscribeWith(email, siteIds, channels)` helper written like the one above), and import them back into `abroad.test.ts` (whose own `world()` becomes `abroadWorld()`); `ACTIVE_EVERY_MINUTES` is imported in `checker-push.test.ts` from `../src/abroad.ts`, as `abroad.test.ts` does. Run `npm test -w @penge/server -- test/abroad.test.ts`: PASS (a move only).

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -w @penge/server -- test/checker-push.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `checker.ts`:

Imports: `type PushMode` from `@penge/contracts`; `newId` from `./crypto.ts`; `buildPayload` from `./push/payload.ts`; `PUSH_BUDGET_MS, PUSH_IN_FLIGHT, PUSH_TIMEOUT_MS, PushPool, type PushTransport, pushDecision` from `./push/sender.ts`; `listDevices, pruneAwaiting` from `./push/devices.ts`; `withAddressLock` from `./subscribers.ts`.

Awaiting devices are pruned for everyone once per pass (the spec: "dropped the next time the hash is read"; the daily numbers read it too, at most a pass later):

```ts
/** Every subscriber's awaiting devices older than 48 hours, removed under each address lock. Returns how many. */
async function pruneAllAwaiting(kv: Kv, keys: Keys, now: number): Promise<number> {
  let removed = 0;
  for (const id of await kv.sMembers(K.allSubscribers)) {
    const meta = await kv.hGetAll(K.pushMeta(id));
    if (!Object.values(meta).some((m) => m.startsWith('a|'))) continue;
    const sub = await load(kv, id);
    if (sub) removed += await withAddressLock(kv, sub.index, () => pruneAwaiting(kv, keys, id, now));
  }
  return removed;
}
```

`CheckDeps` gains:

```ts
  /** Push delivery; without it, or with mode off, alerts go by email only. */
  push?: { mode: PushMode; transport: PushTransport | null };
  /** Checks the run still holds its lock (runCheck sets it); a long delivery pass calls it. */
  lockCheck?: () => Promise<void>;
```

`DeliveryReport` as in Interfaces. Add:

```ts
export type EmailOutcome = 'sent' | 'dry-run' | 'refused' | 'uncertain' | 'none';

/** The spec's outcome table: an alert counts as delivered when any channel delivered it, or may have. */
export function settleOutcome(email: EmailOutcome, push: 'accepted' | 'uncertain' | 'none', pushChosen: boolean): 'delivered' | 'retry' {
  if (email === 'sent' || email === 'uncertain') return 'delivered';
  if (push === 'accepted' || push === 'uncertain') return 'delivered';
  // A simulated email (local runs and tests) delivers only for someone without push, as before.
  if (email === 'dry-run' && !pushChosen) return 'delivered';
  return 'retry';
}

export const shouldRunAbroadDelivery = (report: DeliveryReport) => report.stoppedBy !== 'all channels';

/** What a delivery pass knows about its channels. */
interface Pass {
  failuresInARow: number;
  emailed: Set<string>;
  checks: ReadonlyMap<number, DeliveryCheck>;
  limitNoted: Set<string>;
  /** Why email cannot go out now; a daily-limit block holds only for its own Manila day. */
  emailBlock: { reason: 'paused' | 'daily limit' | 'mail errors' | 'off'; day?: string } | null;
  pool: PushPool | null;
  startedAt: number;
  /** People already considered in this pass: work held or retried now waits for a later pass. */
  seen: Set<string>;
}

async function emailAvailable(deps: CheckDeps, pass: Pass, day: string): Promise<boolean> {
  if (deps.mailer.mode === 'off') {
    pass.emailBlock = { reason: 'off' };
    return false;
  }
  if (await deps.kv.get(K.mailPaused)) {
    pass.emailBlock = { reason: 'paused' };
    return false;
  }
  const b = pass.emailBlock;
  if (b?.reason === 'mail errors') return false;
  if (b?.reason === 'daily limit' && b.day === day) return false;
  if (b && b.reason !== 'mail errors') pass.emailBlock = null; // un-paused, or a new day
  return true;
}

async function pushAvailable(deps: CheckDeps, pass: Pass): Promise<boolean> {
  if (!pass.pool || !deps.push || deps.push.mode === 'off') return false;
  if (await deps.kv.get(K.pushPaused)) return false;
  return pass.pool.hasBudget();
}
```

`deliver` (replace the whole function):

```ts
/** Send verified news within every cap, on every available channel. No current scan means no alert may go out. */
export async function deliver(
  deps: CheckDeps,
  now: () => number = deps.now ?? Date.now,
  /** People already alerted in this check; each is alerted once per check. */
  emailed: Set<string> = new Set(),
  /** Only scans from this invocation of runCheck; do not load these from stored history. */
  scans: readonly DeliveryScan[] = [],
): Promise<DeliveryReport> {
  const { kv, log } = deps;
  const report: DeliveryReport = {
    sent: 0, dryRun: 0, skipped: 0, failed: 0, dropped: 0, held: 0, remaining: 0, stoppedBy: null, emailBlocked: null,
    push: { accepted: 0, refused: 0, uncertain: 0, gone: 0, heldNoChannel: 0 },
  };
  const transport = deps.push && deps.push.mode !== 'off' ? deps.push.transport : null;
  const pass: Pass = {
    failuresInARow: 0, emailed, checks: deliveryChecks(scans), limitNoted: new Set<string>(), emailBlock: null,
    pool: transport ? new PushPool({ transport, inFlight: PUSH_IN_FLIGHT, budgetMs: PUSH_BUDGET_MS, timeoutMs: PUSH_TIMEOUT_MS, now }) : null,
    startedAt: now(),
    seen: new Set<string>(),
  };
  // Awaiting devices older than 48 hours go before anyone is considered.
  const pruned = await pruneAllAwaiting(kv, deps.keys, now());
  if (pruned > 0) deps.stats?.count('pushDevicesRemoved', pruned, manilaDay(now()));
  const lockStillMine = async () => {
    if (now() - pass.startedAt > 30_000) await deps.lockCheck?.();
  };

  // What the checks found, one entry per person, each joining what that person already has waiting.
  for (let i = 0; i < 5000; i++) {
    await lockStillMine();
    const raw = await kv.lPop(K.outbox);
    if (raw === null) break;
    const job = openJob(raw, deps.keys.token);
    if (!job) {
      report.dropped++;
      log.warn('dropped an outbox entry with a bad signature');
      continue;
    }
    pass.seen.add(job.subscriberId);
    await consider(deps, job, false, now, report, pass);
  }
  // People whose alerts waited for their pace, and may now be due. Not those just
  // considered above: what this pass held or put back waits for the next one.
  for (const id of await kv.sMembers(K.heldSubscribers)) {
    if (pass.seen.has(id)) continue;
    await lockStillMine();
    const raw = await kv.get(K.held(id));
    const job = raw === null ? null : openJob(raw, deps.keys.token);
    if (!job || job.subscriberId !== id) {
      if (raw !== null) {
        report.dropped++;
        log.warn('dropped a held alert with a bad signature');
      }
      await clearHeld(kv, id);
      continue;
    }
    await consider(deps, job, true, now, report, pass);
  }
  await pass.pool?.settle();
  report.emailBlocked = pass.emailBlock?.reason ?? null;
  const day = manilaDay(now());
  if (!(await emailAvailable(deps, pass, day)) && !(await pushAvailable(deps, pass))) report.stoppedBy = 'all channels';
  report.held = (await kv.sMembers(K.heldSubscribers)).length;
  report.remaining = await kv.lLen(K.outbox);
  return report;
}
```

`consider` keeps everything up to and including `const next = jobOf(openings);` and the per-person cap check, with the parameter type changed from the inline object to `Pass` and the return type to `Promise<void>` (every `return 'next'` becomes `return`). Replace everything after the per-person cap check with:

```ts
  // Which channels can carry this alert now. Push needs a registered device and a slot in this pass's budget.
  const registered = sub.pushOn && (await listDevices(kv, id)).some((d) => d.meta.state === 'r');
  const wantPush = registered && (await pushAvailable(deps, run)) && run.pool!.reserve();
  let wantEmail = sub.emailOn && (await emailAvailable(deps, run, day));
  if (wantEmail) {
    await noteMailLimit(deps, run.limitNoted, day);
    if ((await kv.incr(K.mailSentToday(day), COUNTER_TTL_SECONDS)) > deps.mailDailyLimit) {
      await kv.write([{ op: 'decr', key: K.mailSentToday(day) }]);
      if (run.emailBlock?.reason !== 'daily limit' || run.emailBlock.day !== day) {
        deps.stats?.count('mailLimitHits', 1, day);
        log.warn('daily email limit reached; email waits, push goes on', { limit: deps.mailDailyLimit });
      }
      run.emailBlock = { reason: 'daily limit', day };
      wantEmail = false;
    }
  }
  if (!wantEmail && !wantPush) {
    // Nothing can carry it now: it all waits, uncharged.
    if (sub.emailOn || sub.pushOn) report.push.heldNoChannel++;
    await hold(deps, jobOf(wanted));
    return;
  }
  const todays = await kv.incr(K.alertsToday(id, day), COUNTER_TTL_SECONDS);
  // Unsubscribed a moment ago? Then nothing goes out, and nothing is kept.
  if (!(await load(kv, id))) {
    await kv.write([...(wantEmail ? [{ op: 'decr', key: K.mailSentToday(day) } as WriteOp] : []), { op: 'decr', key: K.alertsToday(id, day) }, ...holdOps(null)]);
    report.skipped++;
    return;
  }
  // Claimed before anything goes out: a crash after a send can lose this alert, never send it twice.
  await kv.write([{ op: 'set', key: K.lastAlert(id), value: JSON.stringify(at) }, ...holdOps(leftover)]);
  run.emailed.add(id);

  const sendEmail = async (): Promise<EmailOutcome> => {
    if (!wantEmail) return 'none';
    const links = unsubscribeLinks(deps.publicBaseUrl, id, deps.keys);
    const content = alertEmail({ openings, applicants: next.applicants, unsubscribeUrl: links.page, manageUrl: `${deps.publicBaseUrl}/`, lastToday: todays === deps.alertsPerSubscriberPerDay });
    try {
      const result = await mailer.send({ ...content, to: emailOf(sub, deps.keys), kind: 'alert', unsubscribeUrl: links.oneClick });
      run.failuresInARow = 0;
      if (result === 'sent') {
        report.sent++;
        deps.stats?.count('alertsSent', 1, day);
        return 'sent';
      }
      if (result === 'dry-run') {
        report.dryRun++;
        return 'dry-run';
      }
      report.skipped++;
      return 'none';
    } catch (err) {
      report.failed++;
      run.failuresInARow++;
      if (run.failuresInARow >= 3) run.emailBlock = { reason: 'mail errors' };
      if (wasRefused(err)) {
        log.error('alert email refused', { job: next.id, err: err as Error });
        return 'refused';
      }
      log.error('alert email may or may not have gone out; not sending it again', { job: next.id, err: err as Error });
      return 'uncertain';
    }
  };
  const sendPush = async () => {
    if (!wantPush) return { any: 'none' as const, outcomes: [], removed: 0 };
    return pushDecision(
      { kv, keys: deps.keys, pool: run.pool!, log, now },
      // A fresh id for this delivery: a held job keeps its id across partial deliveries, and a
      // notification's tag must differ each time, or a later one replaces an earlier one.
      { subscriberId: id, index: sub.index, payload: buildPayload({ openings, applicants: next.applicants, decisionId: newId() }) },
    );
  };
  const [email, pushed] = await Promise.all([sendEmail(), sendPush()]);
  if (pushed.removed > 0) deps.stats?.count('pushDevicesRemoved', pushed.removed, day);
  for (const o of pushed.outcomes) {
    if (o.result === 'accepted') report.push.accepted++, deps.stats?.count('pushAccepted', 1, day);
    else if (o.result === 'uncertain') report.push.uncertain++, deps.stats?.count('pushUncertain', 1, day);
    else if (o.result === 'gone' || o.result === 'invalid') report.push.gone++, deps.stats?.count('pushGone', 1, day);
    else report.push.refused++, deps.stats?.count('pushRefused', 1, day);
  }

  if (settleOutcome(email, pushed.any, sub.pushOn) === 'delivered') {
    // Email surely refused while push got through: give the allowance back, on the day it was charged.
    if (email === 'refused') await kv.write([{ op: 'decr', key: K.mailSentToday(day) }]);
    return;
  }
  // Nothing got through for sure: undo the claim and try again later, each date at most MAX_MAIL_ATTEMPTS times.
  run.emailed.delete(id);
  for (const o of openings) for (const d of o.dates) tries.set(dateKey(o.id, d), (tries.get(dateKey(o.id, d)) ?? 0) + 1);
  const retry = wanted
    .map((o) => ({ ...o, dates: o.dates.filter((d) => (tries.get(dateKey(o.id, d)) ?? 0) < MAX_MAIL_ATTEMPTS) }))
    .filter((o) => o.dates.length > 0);
  await kv.write([
    ...(wantEmail ? [{ op: 'decr', key: K.mailSentToday(day) } as WriteOp] : []),
    { op: 'decr', key: K.alertsToday(id, day) },
    lastValue === null ? { op: 'del', key: K.lastAlert(id) } : { op: 'set', key: K.lastAlert(id), value: lastValue },
    ...holdOps(retry.length > 0 ? jobOf(retry) : null),
  ]);
```

(The parameter keeps its name `run` inside `consider`, typed `Pass`. Use `if/else` blocks instead of the comma expressions above if the repo's lint config refuses them: `{ report.push.accepted++; deps.stats?.count('pushAccepted', 1, day); }`.)

In `runCheck`: pass `lockCheck: given.lockCheck ?? holdLock` into the `deps` it builds (after `holdLock` is defined), and replace `if (abroad.trusted && !delivery.stoppedBy)` with `if (abroad.trusted && shouldRunAbroadDelivery(delivery))`. `addDelivery` sums the new `push` counters and keeps the first non-null `stoppedBy`/`emailBlocked`.

In `stats.ts`, `COUNTS` gains `'pushAccepted', 'pushRefused', 'pushUncertain', 'pushGone', 'pushDevicesRemoved'`. `pushDecision` returns `removed` (how many `pushRemove` calls answered `removed`) alongside `any` and `outcomes`; `consider` counts it into `pushDevicesRemoved`, and `deliver` counts what `pruneAllAwaiting` (which now returns its total) removed.

`check.ts` builds `push: { mode: config.push.mode, transport: config.push.vapid ? webPushTransport(config.push.vapid) : null }`.

- [ ] **Step 5: Update the existing tests that expected a stopped pass**

Run: `npm test -w @penge/server`. The tests in `checker.test.ts` and `stats.test.ts` that assert `stoppedBy: 'daily limit'`, `'paused'` or `'mail errors'` build their world without push, so email was the only channel: they now assert `emailBlocked` with that value and `stoppedBy: 'all channels'` (and email-only people are still held, uncharged, as those tests already check). A test that expected a refused email to be retried within the same run now sees it retried on the next run (`w.run()` once more). And where a test expected blocked jobs to stay in the outbox, they are now held (uncharged) instead: for example "drops alerts that waited too long" expects `{ emailBlocked: 'paused', stoppedBy: 'all channels', remaining: 0, held: 1 }`, and "stops after three mail failures in a row" expects `{ failed: 3, emailBlocked: 'mail errors', stoppedBy: 'all channels', remaining: 0, held: 4 }`; the same change applies to the equivalent expectations in `abroad.test.ts` (`grep -n "remaining:" apps/server/test/*.ts`). Keep each test's later checks that the held jobs go out, uncharged, on a later run. Run again: PASS.

- [ ] **Step 6: Break it on purpose**

Make the daily-limit branch `return` as it used to (stopping the person loop): "keeps pushing when the email limit is reached" FAILS. Restore. In `settleOutcome`, drop the `push === 'uncertain'` case: "treats a timed-out push as delivered" FAILS. Restore. Use `wantPush` instead of `sub.pushOn` as the third argument of `settleOutcome`: "counts a simulated email only for people without push" still passes, so add a temporary test where push is paused for a push-on person with dry-run email and see it FAIL with the wrong argument (the alert must be retried, not consumed); keep that test.

- [ ] **Step 7: Codex pass, then commit** (`Deliver each alert to every available channel`).

---

### Task 9: The daily numbers count push

**Files:**
- Modify: `apps/server/src/stats.ts`, `apps/server/src/templates.ts`
- Test: `apps/server/test/stats.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 8.
- Produces: `DailyStats` gains `channels: { push: number; pushOnly: number; noChannel: number; devicesRegistered: number; devicesAwaiting: number }`; the daily email gains rows.

- [ ] **Step 1: Write the failing test** (in `stats.test.ts`, using `createPending`/`confirm`/`deviceCall` as in Task 8's `subscribeWith`, copied into this file as a local helper):

```ts
it('counts subscribers by channel and devices by state', async () => {
  const t = clock();
  const kv = new MemoryKv(t.now);
  await subscribeWith(kv, t, 'a@example.com', { emailOn: true, pushOn: false }, true);
  await subscribeWith(kv, t, 'b@example.com', { emailOn: true, pushOn: true }, true);
  await subscribeWith(kv, t, 'c@example.com', { emailOn: false, pushOn: true }, true);
  await subscribeWith(kv, t, 'd@example.com', { emailOn: false, pushOn: true }, false); // awaiting
  const s = await dailyStats(kv, manilaDay(t.now()), t.now());
  expect(s.channels).toEqual({ push: 3, pushOnly: 2, noChannel: 1, devicesRegistered: 2, devicesAwaiting: 1 });
  expect(dailyStatsEmail(s).text).toMatch(/Devices with notifications: 2 \(1 waiting to finish\)/);
  expect(dailyStatsEmail(s).text).toMatch(/Subscribers with notifications on: 3 \(2 push only\)/);
});
```

with the helper:

```ts
async function subscribeWith(kv: MemoryKv, t: { now: () => number }, email: string, ch: { emailOn: boolean; pushOn: boolean }, register: boolean) {
  const credential = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(credential).digest('base64url');
  const token = await createPending(kv, keys, { email, siteIds: [486], applicants: 1, pace: 'asap', channels: { ...ch, pushCredentialHash: ch.pushOn ? hash : null, device: ch.pushOn ? 'Chrome on Android' : null } }, t.now());
  await confirm(kv, keys, token, t.now(), ch);
  if (ch.pushOn && register) {
    const s = fcmSubscription();
    await deviceCall(kv, keys, { credential, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 1, now: t.now() });
  }
}
```

The existing fixtures that build a `DailyStats` by hand for `dailyStatsEmail()` (the `base` and `base0` objects in `stats.test.ts`) gain `channels: { push: 0, pushOnly: 0, noChannel: 0, devicesRegistered: 0, devicesAwaiting: 0 }`, so their tests keep compiling and running.

- [ ] **Step 2: Run it to see it fail** → FAIL.

- [ ] **Step 3: Implement**

In `dailyStats`, after the existing counts:

```ts
  const channels = { push: 0, pushOnly: 0, noChannel: 0, devicesRegistered: 0, devicesAwaiting: 0 };
  for (const id of await kv.sMembers(K.allSubscribers)) {
    const h = await kv.hGetAll(K.subscriber(id));
    const emailOn = h.emailOn !== '0';
    const devices = Object.values(await kv.hGetAll(K.pushMeta(id)));
    const registered = devices.filter((m) => m.startsWith('r|')).length;
    channels.devicesRegistered += registered;
    channels.devicesAwaiting += devices.length - registered;
    if (h.pushOn === '1') channels.push++;
    if (h.pushOn === '1' && !emailOn) channels.pushOnly++;
    if (!emailOn && registered === 0) channels.noChannel++;
  }
```

and `channels` in the returned object. In `templates.ts`'s `dailyStatsEmail`, in the "Alerts" section after "Alerts sent":

```ts
        ['Push notifications delivered', String(c.pushAccepted)],
        ['Push not delivered (refused, unsure, device gone)', `${c.pushRefused}, ${c.pushUncertain}, ${c.pushGone}`],
        ['Subscribers with notifications on', `${stats.channels.push} (${stats.channels.pushOnly} push only)`],
        ['Subscribers with no working channel', String(stats.channels.noChannel)],
        ['Devices with notifications', `${stats.channels.devicesRegistered} (${stats.channels.devicesAwaiting} waiting to finish)`],
        ['Devices removed (gone, or never finished)', String(c.pushDevicesRemoved)],
```

- [ ] **Step 4: Run every test** → PASS.

- [ ] **Step 5: Codex pass, then commit** (`Daily numbers for push`).

---

### Task 10: The confirmation email says what it will change

**Files:**
- Modify: `apps/server/src/templates.ts`, `apps/server/src/api.ts`
- Test: `apps/server/test/templates.test.ts` (create if absent)

**Interfaces:**
- Produces: `confirmationEmail(input: { confirmUrl; deletionUrl?; sites; applicants; pace; channels?: { emailOn: boolean; pushOn: boolean; device: string | null; requestedAt: string; devicesKept: number } })`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { confirmationEmail } from '../src/templates.ts';

describe('confirmation email', () => {
  it('says the channels, and the asking device, before the link', () => {
    const m = confirmationEmail({
      confirmUrl: 'https://penge.example/confirm#token=x', sites: [{ id: 486, name: 'Antipolo (SM Center)' }], applicants: 1, pace: 'asap',
      channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 0 },
    });
    expect(m.text).toMatch(/Email: off/);
    expect(m.text).toMatch(/Notifications: on, for the device and browser that asked \(Chrome on Android, Mon 5 Oct, 10:02\)/);
    expect(m.text.indexOf('Notifications: on')).toBeLessThan(m.text.indexOf('https://penge.example/confirm'));
    expect(m.html).toContain('Chrome on Android');
    expect(m.text).toMatch(/If you did not ask for this, ignore this email/);
  });

  it('reads as before for a request from a page without channels', () => {
    const m = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly' });
    expect(m.text).not.toMatch(/Notifications:/);
  });

  it('says email is on, and that devices with notifications keep them, for an email-only request', () => {
    const m = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly', channels: { emailOn: true, pushOn: false, device: null, requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 1 } });
    expect(m.text).toMatch(/Email: on/);
    expect(m.text).toMatch(/Notifications: none added by this request\./);
    expect(m.text).toMatch(/The 1 device that already gets notifications keeps them\./);
    expect(m.text).not.toMatch(/Notifications: off/);
  });

  it('escapes the device label in the HTML', () => {
    const m = confirmationEmail({ confirmUrl: 'u', sites: [], applicants: 1, pace: 'hourly', channels: { emailOn: true, pushOn: true, device: "O'Brien's", requestedAt: '2026-10-05T02:02:00.000Z', devicesKept: 0 } });
    expect(m.html).toContain('O&#39;Brien&#39;s');
  });
});
```

- [ ] **Step 2: Run them to see them fail** → FAIL.

- [ ] **Step 3: Implement**

In `templates.ts`, with a Manila time that needs no locale data (as `formatDate` does):

```ts
/** "2026-10-05T02:02:00Z" → "Mon 5 Oct, 10:02" in Manila (UTC+8, no daylight saving). */
function manilaWhen(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  const date = formatDate(d.toISOString().slice(0, 10)).replace(/ \d{4}$/, '');
  return `${date}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function channelLines(c: { emailOn: boolean; pushOn: boolean; device: string | null; requestedAt: string; devicesKept: number } | undefined): string[] {
  // Every request that says its channels shows them, email-only too (it may turn email back on).
  if (!c) return [];
  const kept = c.devicesKept === 1 ? 'The 1 device that already gets notifications keeps them.' : `The ${c.devicesKept} devices that already get notifications keep them.`;
  return [
    `Email: ${c.emailOn ? 'on' : 'off'}`,
    c.pushOn
      ? `Notifications: on, for the device and browser that asked (${c.device ?? 'a browser'}, ${manilaWhen(c.requestedAt)})`
      : 'Notifications: none added by this request.',
    ...(c.devicesKept > 0 ? [kept] : []),
    'If you did not ask for this, ignore this email: nothing changes.',
  ];
}
```

In `confirmationEmail`, take `channels?` in the input; insert `...channelLines(input.channels), ''` after the `often` line in the text (only when non-empty), and the same lines as `<p style="margin:0 0 12px">${esc(line)}</p>` before the button in the HTML.

`/api/subscribe` counts the devices the address already has (`const existing = await kv.get(K.emailIndex(emailIndex(request.email, keys.index)))`, then `existing ? (await listDevices(kv, existing)).length : 0`) and spreads `...(request.channels ? { channels: { emailOn: request.channels.emailOn, pushOn: request.channels.pushOn, device: request.channels.device, requestedAt: new Date(now()).toISOString(), devicesKept } } : {})` into the input (the repository sets `exactOptionalPropertyTypes`, so an optional property is left out, never set to `undefined`).

- [ ] **Step 4: Run every test** → PASS.

- [ ] **Step 5: Codex pass, then commit** (`Confirmation emails state the channels and the asking device`).

---

### Task 11: Backups version 2, a safe restore, and push-downgrade

**Files:**
- Modify: `apps/server/src/backup.ts`, `apps/server/src/admin.ts`
- Create: `apps/server/test/fixtures/v0.2/backup.ts`, `apps/server/test/fixtures/v0.2/subscribers.ts` (copies of the current release's code)
- Test: `apps/server/test/backup-push.test.ts`

**Interfaces:**
- Consumes: `removeAllDevices` (Task 5), `withAddressLock`, `removeSubscriberByIndex`, `load` (Task 5), `K` (Task 2).
- Produces:
  - `interface BackupV1 { version: 1; … }`, `interface Backup { version: 2; exportedAt: string; subscribers: { id: string; fields: Record<string, string> }[] }`
  - `exportSubscribers(…): Promise<Backup>` (version 2, with `emailOn`, `pushOn`)
  - `importSubscribers(kv, backup: BackupV1 | Backup): Promise<{ restored: number; skipped: string[] }>`
  - `toV1(backup: Backup): { backup: BackupV1; leftOut: number }`
  - `pushDowngrade(kv): Promise<{ devicesRemoved: number; pendingCancelled: number; unsubscribed: number }>`
  - `admin.mjs` commands: `backup`, `restore <file> --yes`, `backup-to-v1 <file>`, `push-downgrade --yes`

- [ ] **Step 1: Keep the current release's code as test fixtures**

```bash
mkdir -p apps/server/test/fixtures/v0.2
for f in backup subscribers; do
  { echo '// @ts-nocheck'; echo "// From 157bad9 (the release before push), to test what that release would do."; \
    git show 157bad9:apps/server/src/$f.ts | sed "s#from '\./#from '../../../src/#"; } > apps/server/test/fixtures/v0.2/$f.ts
done
```

These import today's `keys.ts`, `kv.ts` and `crypto.ts`, which are compatible (only additions).

- [ ] **Step 2: Write the failing tests**

`apps/server/test/backup-push.test.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Backup, exportSubscribers, importSubscribers, pushDowngrade, toV1 } from '../src/backup.ts';
import { emailIndex, encryptEmail } from '../src/crypto.ts';
import { MemoryKv } from '../src/kv.ts';
import { listDevices } from '../src/push/devices.ts';
import { deviceCall } from '../src/push/register.ts';
import { confirm, createDeletion, createPending, deleteWithToken, load } from '../src/subscribers.ts';
import * as old from './fixtures/v0.2/subscribers.ts';
import * as oldBackup from './fixtures/v0.2/backup.ts';
import { clock, fcmSubscription, keys } from './helpers.ts';

async function signUp(kv: MemoryKv, now: number, email: string, ch: { emailOn: boolean; pushOn: boolean }) {
  const credential = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(credential).digest('base64url');
  const token = await createPending(kv, keys, { email, siteIds: [486], applicants: 1, pace: 'asap', channels: { ...ch, pushCredentialHash: ch.pushOn ? hash : null, device: ch.pushOn ? 'Chrome on Android' : null } }, now);
  const r = await confirm(kv, keys, token, now, ch);
  if (r.status !== 'confirmed' && r.status !== 'updated') throw new Error(r.status);
  if (ch.pushOn) {
    const s = fcmSubscription();
    await deviceCall(kv, keys, { credential, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 1, now });
  }
  return r.subscriberId;
}
const deleteAddress = async (kv: MemoryKv, email: string) => deleteWithToken(kv, await createDeletion(kv, keys, email));
const liveKeys = (kv: MemoryKv, pattern: RegExp) => kv.keys().filter((k) => pattern.test(k) && !k.startsWith('pp:push:revoked:'));

describe('backups with channels', () => {
  it('exports version 2, which the release before push refuses to import', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: false });
    const backup = await exportSubscribers(kv, [486], t.now());
    expect(backup.version).toBe(2);
    expect(backup.subscribers[0]!.fields.emailOn).toBe('1');
    // The old importer's type says version 1; giving it version 2 is the point of this test.
    await expect(oldBackup.importSubscribers(new MemoryKv(), backup as unknown as Parameters<typeof oldBackup.importSubscribers>[1])).rejects.toThrow('not a PengePassportPH backup');
  });

  it('restores a version 1 backup as email on, push off', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const id = 'A'.repeat(22);
    const v1 = { version: 1 as const, exportedAt: 'x', subscribers: [{ id, fields: {
      email: encryptEmail('juan@example.com', keys.email), index: emailIndex('juan@example.com', keys.index),
      sites: '486', applicants: '1', pace: 'hourly', createdAt: 'x', confirmedAt: 'x' } }] };
    expect(await importSubscribers(kv, v1)).toEqual({ restored: 1, skipped: [] });
    expect(await load(kv, id)).toMatchObject({ emailOn: true, pushOn: false });
  });

  it('never displaces a live subscriber: backup, delete, subscribe again with push, restore, delete again leaves nothing', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const a = await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: false });
    const backup = await exportSubscribers(kv, [486], t.now());
    await deleteAddress(kv, 'juan@example.com');
    const b = await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: true });
    expect(b).not.toBe(a);
    expect(await importSubscribers(kv, backup)).toEqual({ restored: 0, skipped: [a] });
    expect(await listDevices(kv, b)).toHaveLength(1);
    await deleteAddress(kv, 'juan@example.com');
    expect(liveKeys(kv, /^pp:(sub|push|idx|reserved|site)/)).toEqual([]);
  });

  it('restores an old record without channel fields as email on, over a newer push-only choice', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const a = await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: false });
    const backup = await exportSubscribers(kv, [486], t.now());
    delete backup.subscribers[0]!.fields.emailOn; // as a backup written before channels would be
    await signUp(kv, t.now(), 'juan@example.com', { emailOn: false, pushOn: true });
    await importSubscribers(kv, backup);
    expect(await load(kv, a)).toMatchObject({ emailOn: true, pushOn: false });
  });

  it('removes the devices of a restored subscriber, so a restore never revives one', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const a = await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: true });
    const backup = await exportSubscribers(kv, [486], t.now());
    await importSubscribers(kv, backup);
    expect(await listDevices(kv, a)).toHaveLength(0);
    expect(await load(kv, a)).toMatchObject({ emailOn: true, pushOn: false });
    expect(liveKeys(kv, /^pp:push/)).toEqual([]);
  });

  it('converts version 2 to version 1 without people who turned email off', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: false });
    await signUp(kv, t.now(), 'ana@example.com', { emailOn: false, pushOn: true });
    const { backup, leftOut } = toV1((await exportSubscribers(kv, [486], t.now())) as Backup);
    expect(leftOut).toBe(1);
    expect(backup.version).toBe(1);
    expect(backup.subscribers).toHaveLength(1);
    expect(Object.keys(backup.subscribers[0]!.fields)).not.toContain('emailOn');
    expect(await oldBackup.importSubscribers(new MemoryKv(), backup)).toBe(1);
  });

  it('push-downgrade removes devices, cancels channel requests, unsubscribes push-only people, and is idempotent', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const both = await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: true });
    const only = await signUp(kv, t.now(), 'ana@example.com', { emailOn: false, pushOn: true });
    const hash = createHash('sha256').update(randomBytes(32)).digest('base64url');
    const token = await createPending(kv, keys, { email: 'ben@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, t.now());
    expect(await pushDowngrade(kv)).toEqual({ devicesRemoved: 2, pendingCancelled: 1, unsubscribed: 1 });
    expect(await pushDowngrade(kv)).toEqual({ devicesRemoved: 0, pendingCancelled: 0, unsubscribed: 0 });
    expect(liveKeys(kv, /^pp:(push|reserved)/)).toEqual([]);
    expect(await load(kv, only)).toBeNull();
    expect(await load(kv, both)).toMatchObject({ emailOn: true });
    // The release before push: its confirmation finds nothing to confirm, and its deletion leaves nothing.
    expect((await old.confirm(kv, token, t.now())).status).toBe('invalid');
    await old.deleteWithToken(kv, await old.createDeletion(kv, keys, 'juan@example.com'));
    expect(liveKeys(kv, /^pp:(sub|push|idx|reserved)/)).toEqual([]);
  });

  it('push-downgrade also clears a confirmation that died after binding', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(kv, keys, { email: 'ana@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, pushCredentialHash: hash, device: 'Chrome on Android' } }, t.now());
    const dying = new Proxy(kv, {
      get(target, prop) {
        if (prop === 'write') return async (ops: { op: string; key: string }[]) => {
          if (ops.some((o) => o.op === 'hSet' && o.key.startsWith('pp:sub:'))) throw new Error('process died');
          return target.write(ops as never);
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(confirm(dying as MemoryKv, keys, token, t.now(), { emailOn: false, pushOn: true })).rejects.toThrow('process died');
    expect(liveKeys(kv, /^pp:push:meta/)).toHaveLength(1);
    expect(await pushDowngrade(kv)).toEqual({ devicesRemoved: 1, pendingCancelled: 1, unsubscribed: 0 });
    expect(liveKeys(kv, /^pp:(push|reserved)/)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to see them fail** → FAIL.

- [ ] **Step 4: Implement**

`backup.ts`:

```ts
// Subscribers live only in Redis. Once a day the checker copies them, exactly as
// stored (addresses stay encrypted), to R2; `admin.mjs restore` puts a copy back.
// A backup is useless without the EMAIL_ENC_KEY that sealed it. Push devices are
// never in a backup: a restore must not revive a device someone turned off.
import { isPace } from '@penge/contracts';
import { K } from './keys.ts';
import type { Kv, WriteOp } from './kv.ts';
import { removeAllDevices } from './push/devices.ts';
import { load, removeSubscriberByIndex, withAddressLock } from './subscribers.ts';

type Record_ = { id: string; fields: Record<string, string> };
export interface BackupV1 { version: 1; exportedAt: string; subscribers: Record_[] }
export interface Backup { version: 2; exportedAt: string; subscribers: Record_[] }

const ID = /^[A-Za-z0-9_-]{16,32}$/;
const V1_FIELDS = ['email', 'index', 'sites', 'applicants', 'pace', 'createdAt', 'confirmedAt'];
const FIELDS = [...V1_FIELDS, 'emailOn', 'pushOn'];

export async function exportSubscribers(kv: Kv, siteIds: number[], now: number): Promise<Backup> {
  const ids = new Set<string>(await kv.sMembers(K.allSubscribers));
  for (const siteId of siteIds) for (const id of await kv.sMembers(K.siteSubscribers(siteId))) ids.add(id);
  const subscribers: Record_[] = [];
  for (const id of [...ids].sort()) {
    const fields = await kv.hGetAll(K.subscriber(id));
    if (fields.email && fields.index && fields.sites) {
      subscribers.push({ id, fields: Object.fromEntries(FIELDS.filter((f) => typeof fields[f] === 'string').map((f) => [f, fields[f]!])) });
    }
  }
  return { version: 2, exportedAt: new Date(now).toISOString(), subscribers };
}

/** One record, checked and cleaned. Throws before anything is written. */
function validated(r: Record_, version: 1 | 2): Record_ & { sites: number[] } {
  const { id, fields } = r;
  if (!ID.test(id) || typeof fields !== 'object' || fields === null) throw new Error(`bad subscriber ${String(id)}`);
  const clean = Object.fromEntries(FIELDS.filter((f) => typeof fields[f] === 'string').map((f) => [f, fields[f]!]));
  if (version === 1) {
    delete clean.emailOn;
    delete clean.pushOn;
  }
  // Absent means email on (every subscriber from before channels): say so, so a
  // restore never keeps a newer "email off" by leaving the field alone.
  clean.emailOn ??= '1';
  // Absent in backups from before paces existed; anything else must be a pace.
  if (fields.pace !== undefined && !isPace(fields.pace)) throw new Error(`bad subscriber ${id}`);
  if (clean.emailOn !== undefined && clean.emailOn !== '0' && clean.emailOn !== '1') throw new Error(`bad subscriber ${id}`);
  if (clean.pushOn !== undefined && clean.pushOn !== '0' && clean.pushOn !== '1') throw new Error(`bad subscriber ${id}`);
  const sites = (clean.sites ?? '').split(',').map(Number);
  if (!clean.email || !clean.index || !sites.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error(`bad subscriber ${id}`);
  return { id, fields: clean, sites };
}

/**
 * Put subscribers back. A record whose address now belongs to a different live
 * subscriber is skipped (listed), never displacing them. A restored subscriber's
 * devices are removed and push is off: devices are not in backups.
 */
export async function importSubscribers(kv: Kv, backup: BackupV1 | Backup): Promise<{ restored: number; skipped: string[] }> {
  if ((backup?.version !== 1 && backup?.version !== 2) || !Array.isArray(backup.subscribers)) throw new Error('not a PengePassportPH backup');
  const records = backup.subscribers.map((r) => validated(r, backup.version));
  const skipped: string[] = [];
  let restored = 0;
  for (const r of records) {
    await withAddressLock(kv, r.fields.index!, async () => {
      const current = await kv.get(K.emailIndex(r.fields.index!));
      if (current && current !== r.id && (await load(kv, current))) {
        skipped.push(r.id);
        return;
      }
      await removeAllDevices(kv, r.id, { revoke: false });
      await kv.write([
        { op: 'hSet', key: K.subscriber(r.id), fields: { ...r.fields, pushOn: '0' } },
        { op: 'set', key: K.emailIndex(r.fields.index!), value: r.id },
        { op: 'sAdd', key: K.allSubscribers, members: [r.id] },
        ...r.sites.map((siteId): WriteOp => ({ op: 'sAdd', key: K.siteSubscribers(siteId), members: [r.id] })),
      ]);
      restored++;
    });
  }
  return { restored, skipped };
}

/** A version 1 copy for the release before push, without the people who turned email off. */
export function toV1(backup: Backup): { backup: BackupV1; leftOut: number } {
  const kept = backup.subscribers.filter((r) => r.fields.emailOn !== '0');
  return {
    backup: { version: 1, exportedAt: backup.exportedAt, subscribers: kept.map(({ id, fields }) => ({ id, fields: Object.fromEntries(V1_FIELDS.filter((f) => fields[f] !== undefined).map((f) => [f, fields[f]!])) })) },
    leftOut: backup.subscribers.length - kept.length,
  };
}

/**
 * Before running the release from before push: removes every device and push
 * index, cancels pending requests that change channels (that release would
 * confirm them as email), and unsubscribes people who chose push only.
 * Idempotent. Run with the API and the checker stopped (deploy/README.md).
 */
export async function pushDowngrade(kv: Kv): Promise<{ devicesRemoved: number; pendingCancelled: number; unsubscribed: number }> {
  let devicesRemoved = 0;
  let pendingCancelled = 0;
  let unsubscribed = 0;
  for (const member of await kv.sMembers(K.pendingChannels)) {
    const [hash, index] = member.split('|') as [string, string];
    await withAddressLock(kv, index, async () => {
      const raw = await kv.get(K.pending(hash));
      const ch = raw ? (JSON.parse(raw) as { channels?: { pushCredentialHash?: string | null } }).channels : undefined;
      const reserved = await kv.get(K.reserved(index));
      if (reserved && !(await load(kv, reserved))) {
        devicesRemoved += await removeAllDevices(kv, reserved, { revoke: false });
        await kv.write([{ op: 'del', key: K.pushAddress(reserved) }]);
      }
      await kv.write([
        { op: 'del', key: K.pending(hash) },
        { op: 'sRem', key: K.pendingFor(index), members: [hash] },
        { op: 'sRem', key: K.pendingChannels, members: [member] },
        ...(ch?.pushCredentialHash ? [{ op: 'del', key: K.pushPending(ch.pushCredentialHash) } as WriteOp] : []),
        ...(reserved && !(await kv.get(K.emailIndex(index))) ? [{ op: 'del', key: K.reserved(index) } as WriteOp] : []),
      ]);
      if (raw) pendingCancelled++;
    });
  }
  for (const id of await kv.sMembers(K.allSubscribers)) {
    const sub = await load(kv, id);
    if (!sub) continue;
    await withAddressLock(kv, sub.index, async () => {
      devicesRemoved += await removeAllDevices(kv, id, { revoke: false });
      if (!sub.emailOn) {
        await removeSubscriberByIndex(kv, sub.index);
        unsubscribed++;
      } else {
        await kv.write([{ op: 'hDel', key: K.subscriber(id), fields: ['emailOn', 'pushOn'] }]);
      }
    });
  }
  return { devicesRemoved, pendingCancelled, unsubscribed };
}
```

`admin.ts`: replace the `USAGE` line, the command check, the restore guard, and the final `backup`/`restore` block with:

```ts
const USAGE =
  'usage: admin.mjs backup > file.json | admin.mjs restore <file.json[.gz]> --yes | admin.mjs backup-to-v1 <file.json[.gz]> > v1.json | admin.mjs push-downgrade --yes | admin.mjs scans <YYYY-MM-DD> [abroad] > day.jsonl\n';
const [command, file, confirm] = process.argv.slice(2);
const COMMANDS = ['backup', 'restore', 'backup-to-v1', 'push-downgrade', 'scans'];
if (!command || !COMMANDS.includes(command)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

/** A backup file, plain or gzipped. */
function readBackup(path: string): BackupV1 | Backup {
  let data = readFileSync(path);
  if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
  return JSON.parse(data.toString('utf8')) as BackupV1 | Backup;
}
```

(the existing `scans` block stays as it is, between these and what follows)

```ts
if (command === 'restore' && (!file || confirm !== '--yes')) {
  process.stderr.write('restore overwrites subscribers with the same ids (never another live subscriber); add --yes to go ahead\n');
  process.exit(2);
}
if (command === 'push-downgrade' && file !== '--yes') {
  process.stderr.write('push-downgrade removes every push device, cancels channel requests and unsubscribes people with email off; stop the API and the checker first (deploy/README.md), then add --yes\n');
  process.exit(2);
}

if (command === 'backup-to-v1') {
  if (!file) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const backup = readBackup(file);
  if (backup.version !== 2) {
    process.stderr.write('that backup is already version 1\n');
    process.exit(2);
  }
  const { backup: v1, leftOut } = toV1(backup);
  process.stdout.write(`${JSON.stringify(v1)}\n`);
  process.stderr.write(`left out ${leftOut} people who turned email off\n`);
}

if (command === 'backup' || command === 'restore' || command === 'push-downgrade') {
  const config = loadConfig();
  const kv = await connectRedis(config.redisUrl, (err) => process.stderr.write(`redis: ${err.message}\n`));
  try {
    if (command === 'backup') {
      const raw = await kv.get(K.sites);
      const siteIds = raw ? (JSON.parse(raw) as { id: number }[]).map((s) => s.id) : [];
      process.stdout.write(`${JSON.stringify(await exportSubscribers(kv, siteIds, Date.now()))}\n`);
    } else if (command === 'restore') {
      const { restored, skipped } = await importSubscribers(kv, readBackup(file!));
      process.stderr.write(`restored ${restored}, skipped ${skipped.length} (their address now belongs to another subscriber)${skipped.length ? `: ${skipped.join(', ')}` : ''}\n`);
    } else {
      const channelRequests = (await kv.sMembers(K.pendingChannels)).length;
      let withPush = 0;
      let pushOnly = 0;
      for (const id of await kv.sMembers(K.allSubscribers)) {
        const h = await kv.hGetAll(K.subscriber(id));
        if (h.pushOn === '1') withPush++;
        if (h.emailOn === '0') pushOnly++;
      }
      process.stderr.write(`push-downgrade: ${channelRequests} pending channel requests, ${withPush} subscribers with push, ${pushOnly} with email off (they will be unsubscribed)\n`);
      const r = await pushDowngrade(kv);
      process.stderr.write(`done: removed ${r.devicesRemoved} devices, cancelled ${r.pendingCancelled} requests, unsubscribed ${r.unsubscribed}\n`);
    }
  } finally {
    await kv.close();
  }
}
```

Its imports gain `type BackupV1, pushDowngrade, toV1` from `./backup.ts`.

- [ ] **Step 5: Run every test and the typecheck** → PASS. The existing backup test in `checker.test.ts` (`expect(await importSubscribers(fresh, backup)).toBe(1)`) changes to `toEqual({ restored: 1, skipped: [] })`. (If `tsc` complains about the fixtures despite `// @ts-nocheck`, add `"exclude": ["test/fixtures"]` to `apps/server/tsconfig.json`.)

- [ ] **Step 6: Break it on purpose**: drop the "different live subscriber" check in `importSubscribers`: the displacement test FAILS. Restore. Drop the reserved-id clean-up in `pushDowngrade`: "clears a confirmation that died after binding" FAILS. Restore.

- [ ] **Step 7: Codex pass, then commit** (`Backup version 2, a restore that never displaces a subscriber, and push-downgrade`).

---

## Phase C: the web app

### Task 12: Shared push state, the service worker's handlers, and notification icons

**Files:**
- Create: `apps/web/src/notify/shared.js`, `apps/web/src/notify/shared.d.ts`, `apps/web/public/icons/mark-monochrome.svg`, `apps/web/public/icons/badge-96.png`, `apps/web/public/icons/monochrome-512.png`
- Modify: `apps/web/src/sw.js`, `apps/web/sw-plugin.ts`, `apps/web/scripts/icons.mjs`, `apps/web/package.json` (dev dependency `fake-indexeddb`)
- Test: `apps/web/test/notify-shared.test.ts`, `apps/web/test/pwa.test.ts`

**Interfaces:**
- Produces (in `shared.js`, typed by `shared.d.ts`; every function takes an `env` with `indexedDB`, `locks` and `crypto`, so tests pass fakes):
  - `interface PushState { credential: string | null; confirmed: boolean; askedAt: number | null; revision: number; fingerprint: string | null; applicationServerKey: string | null }`
  - `interface PushEnv { indexedDB: IDBFactory; locks: LockManager; crypto: Crypto }`
  - `interface Registration { pushManager: { getSubscription(): Promise<BrowserSubscription | null>; subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<BrowserSubscription> } }`, `interface BrowserSubscription { toJSON(): { endpoint?: string; keys?: Record<string, string> }; unsubscribe(): Promise<boolean> }`
  - `type Post = (path: string, body: unknown, method?: 'POST' | 'DELETE') => Promise<any>`
  - `LOCK_NAME`, `readState(env)`, `writeState(env, patch)`, `withPushLock(env, fn)`, `fingerprint(env, json)`, `newCredential(env)`, `credentialHash(env, credential)`, `keyBytes(b64url)`
  - `ensureSubscribed(env, a: { registration: Registration; applicationServerKey: string }): Promise<{ credentialHash: string }>` — under the lock: keeps the existing credential (makes one if none), keeps the existing browser subscription (subscribes if none), remembers the key
  - `reconcile(env, a: { registration: Registration; post: Post; permission: NotificationPermission }): Promise<{ state: DeviceState } | null>` — under the lock: if the browser has no subscription and permission is granted, subscribes again with the remembered key; raises the revision when the subscription changed; on `endpoint-taken` unsubscribes, subscribes again and retries once; on `missing` clears the credential only if it was confirmed or is older than 48 h
  - `turnOff(env, a: { registration: Registration; post: Post }): Promise<{ ok: true; noChannel: boolean } | null>` — under the lock; clears the credential only if it is still the one turned off
- `sw.js` handlers: `message` (`{ type: 'capabilities' }` → `{ version, push: true }`), `push`, `notificationclick`, `pushsubscriptionchange`
- `sw-plugin.ts` replaces `/* __SHARED__ */` in `sw.js` with `shared.js` (its `export ` keywords removed), and hashes it into the version
- Icons: `public/icons/badge-96.png` (white mark on transparent, for the notification badge) and `public/icons/monochrome-512.png` (the same at 512, for the Android app's notifications), both rendered by `scripts/icons.mjs`

- [ ] **Step 1: Write the failing tests**

```bash
npm install -w @penge/web -D fake-indexeddb
```

`apps/web/test/notify-shared.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSubscribed, markRequested, readState, reconcile, turnOff, withPushLock, writeState } from '../src/notify/shared.js';

/** Web Locks with one queue per name, like the browser's. */
function locks() {
  let tail: Promise<unknown> = Promise.resolve();
  return { request: (_name: string, fn: () => Promise<unknown>) => { const run = tail.then(fn); tail = run.then(() => undefined, () => undefined); return run; } } as unknown as LockManager;
}
let dbCount = 0;
// jsdom's crypto has no `subtle`: the tests use Node's Web Crypto, as browsers have.
const env = () => ({ indexedDB: new IDBFactory(), locks: locks(), crypto: webcrypto as unknown as Crypto, name: `t${dbCount++}` });

const P256 = `B${'A'.repeat(86)}`;
type FakeSub = { toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } }; unsubscribe: ReturnType<typeof vi.fn> };
/** A browser's push manager: unsubscribing really drops the subscription. */
function registration(initialEndpoint: string | null, auth = 'AQEBAQEBAQEBAQEBAQEBAQ') {
  let current: FakeSub | null = null;
  const make = (endpoint: string, a = auth): FakeSub => {
    const s: FakeSub = { toJSON: () => ({ endpoint, keys: { p256dh: P256, auth: a } }), unsubscribe: vi.fn(async () => { if (current === s) current = null; return true; }) };
    return s;
  };
  if (initialEndpoint) current = make(initialEndpoint);
  return {
    make,
    set(s: FakeSub | null) { current = s; },
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => (current = make(`https://fcm.googleapis.com/new-${Math.random()}`))),
    },
  };
}

describe('shared push state', () => {
  let e: ReturnType<typeof env>;
  beforeEach(() => { e = env(); });

  it('keeps an existing credential and subscription when turned on again', async () => {
    const reg = registration('https://fcm.googleapis.com/a');
    const first = await ensureSubscribed(e, { registration: reg, applicationServerKey: P256 });
    const second = await ensureSubscribed(e, { registration: reg, applicationServerKey: P256 });
    expect(second.credentialHash).toBe(first.credentialHash);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('raises the revision when the subscription changes, keys included, and not otherwise', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, revision: 0, fingerprint: null, applicationServerKey: P256 });
    const reg = registration('https://fcm.googleapis.com/a');
    const post = vi.fn(async () => ({ state: 'registered' }));
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    expect((await readState(e)).revision).toBe(1);
    reg.set(reg.make('https://fcm.googleapis.com/a', 'AgICAgICAgICAgICAgICAg'));
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    expect((await readState(e)).revision).toBe(2);
    expect(post).toHaveBeenLastCalledWith('/api/push/device', expect.objectContaining({ revision: 2 }));
  });

  it('subscribes again when the browser dropped the subscription and permission is still granted', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, revision: 3, fingerprint: 'old', applicationServerKey: P256 });
    const reg = registration(null);
    const post = vi.fn(async () => ({ state: 'registered' }));
    await reconcile(e, { registration: reg, post, permission: 'granted' });
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/push/device', expect.objectContaining({ revision: 4 }));
  });

  it('takes a fresh endpoint once when the server says the endpoint is taken', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, revision: 1, fingerprint: null, applicationServerKey: P256 });
    const reg = registration('https://fcm.googleapis.com/copied');
    const post = vi.fn(async (_p: string, body: { subscription?: { endpoint: string } }) => ({ state: body.subscription?.endpoint.endsWith('copied') ? 'endpoint-taken' : 'registered' }));
    expect(await reconcile(e, { registration: reg, post, permission: 'granted' })).toEqual({ state: 'registered', subscribed: true });
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribes and registers in one call when the server says awaiting and this browser has no subscription', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null, applicationServerKey: P256 });
    const reg = registration(null);
    const post = vi.fn(async (_p: string, body: { subscription?: unknown }) => ({ state: body.subscription ? 'registered' : 'awaiting' }));
    expect(await reconcile(e, { registration: reg, post, permission: 'granted' })).toEqual({ state: 'registered', subscribed: true });
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
  });

  it('counts the 48 hours from the latest request', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: true, askedAt: 1, revision: 1, fingerprint: 'f', applicationServerKey: P256 });
    await markRequested(e);
    const st = await readState(e);
    expect(st.confirmed).toBe(false);
    expect(Date.now() - st.askedAt!).toBeLessThan(5000);
    expect(st.revision).toBe(1);
  });

  it('keeps an unconfirmed credential when the server says missing', async () => {
    await writeState(e, { credential: 'c'.repeat(43), confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null, applicationServerKey: P256 });
    await reconcile(e, { registration: registration(null), post: async () => ({ state: 'missing' }), permission: 'default' });
    expect((await readState(e)).credential).toBe('c'.repeat(43));
  });

  it('does not let a slow turn-off in one tab wipe a fresh credential another tab made', async () => {
    await writeState(e, { credential: 'o'.repeat(43), confirmed: true, revision: 1, fingerprint: 'f', applicationServerKey: P256 });
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const slowPost = vi.fn(() => { entered(); return new Promise<{ ok: true; noChannel: false }>((r) => (release = () => r({ ok: true, noChannel: false }))); });
    const off = turnOff(e, { registration: registration('https://fcm.googleapis.com/a'), post: slowPost });
    await inside;
    let otherRan = false;
    const other = withPushLock(e, async () => { otherRan = true; await writeState(e, { credential: 'n'.repeat(43), confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null }); });
    await Promise.resolve();
    expect(otherRan).toBe(false); // the other tab waits for the lock
    release();
    expect(await off).toEqual({ ok: true, noChannel: false });
    await other;
    expect((await readState(e)).credential).toBe('n'.repeat(43));
  });

  it('does not let turning on in one tab and turning off in another leave a credential with no subscription', async () => {
    await writeState(e, { credential: 'o'.repeat(43), confirmed: true, revision: 1, fingerprint: 'f', applicationServerKey: P256 });
    const reg = registration('https://fcm.googleapis.com/a');
    const post = vi.fn(async () => ({ ok: true, noChannel: false }));
    // The lock runs them one after the other: off first (it asked first), then on again.
    await Promise.all([turnOff(e, { registration: reg, post }), ensureSubscribed(e, { registration: reg, applicationServerKey: P256 })]);
    const state = await readState(e);
    expect(state.credential).not.toBeNull();
    expect(state.credential).not.toBe('o'.repeat(43)); // a fresh credential: the old one was turned off
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1); // a fresh subscription: the old one was dropped
    expect(await reg.pushManager.getSubscription()).not.toBeNull();
  });
});
```

(`env()` gives each test its own `IDBFactory`, so tests do not share a database.)

In `apps/web/test/pwa.test.ts`:

1. In the existing test "gets a new version when only the worker changes", copy the shared file into the temporary root, since the plugin now reads it:

```ts
    mkdirSync(join(root, 'src/notify'), { recursive: true });
    writeFileSync(join(root, 'src/notify/shared.js'), readFileSync(join(web, 'src/notify/shared.js'), 'utf8'));
```

2. Add:

```ts
  it('gets a new version when only the shared push code changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'penge-sw-'));
    mkdirSync(join(root, 'src/notify'), { recursive: true });
    writeFileSync(join(root, 'src/sw.js'), readFileSync(join(web, 'src/sw.js'), 'utf8'));
    writeFileSync(join(root, 'src/notify/shared.js'), `${readFileSync(join(web, 'src/notify/shared.js'), 'utf8')}\n// changed\n`);
    expect(built(BUILD, root).version).not.toBe(built(BUILD).version);
  });

  it('inlines the shared push code without export statements', () => {
    const { source } = built(BUILD);
    expect(source).toMatch(/const withPushLock = /);
    expect(source).not.toMatch(/^export /m);
  });
```

3. Extend `worker()`. Its fake `self` gains what the new handlers use, its listeners are kept by type, and a `fire()` helper runs one:

```ts
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const self = {
    // …the fields worker() already sets (location, skipWaiting, …), and:
    registration: { scope: SCOPE, showNotification: vi.fn(async (_title: string, _options: unknown) => {}), pushManager: { getSubscription: vi.fn(async (): Promise<unknown> => null), subscribe: vi.fn() } },
    clients: { claim: vi.fn(), matchAll: vi.fn(async (): Promise<unknown[]> => []), openWindow: vi.fn(async (_url: string) => null) },
    indexedDB: opts.indexedDB,
    navigator: { locks: opts.locks },
    crypto: webcrypto,
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] ??= []).push(fn),
  };
  /** Runs the worker's listeners for one event and waits for what they handed to waitUntil. */
  async function fire(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners[type] ?? []) fn({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
```

(`worker(opts)` gains `indexedDB?: IDBFactory`, `locks?: unknown` and `fetch?: typeof fetch` options; when `fetch` is given, it is what the harness passes as the worker's `fetch` parameter instead of `network`, `import { webcrypto } from 'node:crypto'` and `import 'fake-indexeddb/auto'` at the top, and returns `fire` with the rest. Where it used to keep one listener per type, the existing tests' calls go through `fire` or `listeners[type]![0]!` as before.) Then:

```ts
it('shows a notification for every push, even an unreadable one', async () => {
  const w = worker();
  await w.fire('push', { data: { json: () => ({ v: 1, title: 'Dates open at Antipolo', body: 'Fri 9 Oct · for 1 person', tag: 'alert-d1', url: { office: 486, date: '2026-10-09', people: 1 } }) } });
  expect(w.self.registration.showNotification).toHaveBeenCalledWith('Dates open at Antipolo', expect.objectContaining({ body: 'Fri 9 Oct · for 1 person', tag: 'alert-d1' }));
  await w.fire('push', { data: { json: () => { throw new Error('bad'); } } });
  expect(w.self.registration.showNotification).toHaveBeenLastCalledWith('New dates are open', expect.objectContaining({ body: expect.any(String) }));
});

it('navigates an open window to the office instead of opening another (Review Focus 5)', async () => {
  const w = worker();
  const client = { url: `${SCOPE}?office=693`, navigate: vi.fn(async () => client), focus: vi.fn(async () => client) };
  w.self.clients.matchAll = vi.fn(async () => [client]);
  await w.fire('notificationclick', { notification: { data: { office: 486, date: '2026-10-09', people: 2 }, close: vi.fn() } });
  expect(client.navigate).toHaveBeenCalledWith(`${SCOPE}?office=486&date=2026-10-09&people=2`);
  expect(client.focus).toHaveBeenCalled();
  expect(w.self.clients.openWindow).not.toHaveBeenCalled();
});

it('opens the app when no window is open, and ignores a bad link in the payload', async () => {
  const w = worker();
  await w.fire('notificationclick', { notification: { data: { office: 'javascript:alert(1)', date: 'x', people: 99 }, close: vi.fn() } });
  expect(w.self.clients.openWindow).toHaveBeenCalledWith(SCOPE);
});

it('re-registers with the server when the browser renews the subscription', async () => {
  const locks = { request: (_n: string, fn: () => Promise<unknown>) => fn() };
  const idb = new IDBFactory();
  const posted: unknown[] = [];
  // The worker's own fetch (the harness passes it into the worker's scope).
  const renewFetch = vi.fn(async (_url: string, init?: { body?: string }) => {
    posted.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({ state: 'registered' }));
  }) as unknown as typeof fetch;
  const w = worker({ indexedDB: idb, locks, fetch: renewFetch });
  // This browser had push on: a credential and the key, as the page stores them.
  const { writeState } = await import('../src/notify/shared.js');
  await writeState({ indexedDB: idb, locks: locks as unknown as LockManager, crypto: webcrypto as unknown as Crypto }, { credential: 'c'.repeat(43), confirmed: true, revision: 1, fingerprint: 'old', applicationServerKey: `B${'A'.repeat(86)}` });
  const renewed = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/renewed', keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'AQEBAQEBAQEBAQEBAQEBAQ' } }), unsubscribe: vi.fn() };
  w.self.registration.pushManager.getSubscription = vi.fn(async () => renewed);
  await w.fire('pushsubscriptionchange', {});
  expect(posted).toEqual([expect.objectContaining({ credential: 'c'.repeat(43), revision: 2, subscription: expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/renewed' }) })]);
});

it('answers the capabilities handshake', async () => {
  const w = worker();
  const port = { postMessage: vi.fn() };
  await w.fire('message', { data: { type: 'capabilities' }, ports: [port] });
  expect(port.postMessage).toHaveBeenCalledWith({ version: expect.stringMatching(/^[0-9a-f]{12}$/), push: true });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/web -- test/notify-shared.test.ts test/pwa.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `shared.js`**

```js
// Push state shared by the page and the service worker: one IndexedDB store and
// one Web Lock, so the two never act on a subscription the other has changed.
// Plain JavaScript: sw-plugin.ts inlines this file into sw.js. Types: shared.d.ts.
export const LOCK_NAME = 'pengepassportph-push';
const DB = 'pengepassportph-push';
const STORE = 'state';
const KEY = 'device';
const UNCONFIRMED_MS = 48 * 3600 * 1000;

const empty = () => ({ credential: null, confirmed: false, askedAt: null, revision: 0, fingerprint: null, applicationServerKey: null });

function open(env) {
  return new Promise((resolve, reject) => {
    const req = env.indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readState(env) {
  const db = await open(env);
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve({ ...empty(), ...(req.result ?? {}) });
    req.onerror = () => reject(req.error);
  });
}

export async function writeState(env, patch) {
  const db = await open(env);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get(KEY);
    get.onsuccess = () => store.put({ ...empty(), ...(get.result ?? {}), ...patch }, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const withPushLock = (env, fn) => env.locks.request(LOCK_NAME, fn);

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sha256 = async (env, text) => b64url(await env.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export const fingerprint = (env, json) => sha256(env, `${json.endpoint}\n${json.keys?.p256dh}\n${json.keys?.auth}`);
export const newCredential = (env) => b64url(env.crypto.getRandomValues(new Uint8Array(32)));
export const credentialHash = (env, c) => sha256(env, c);

/** Turn push on in this browser: keep what exists, make what is missing. */
export function ensureSubscribed(env, { registration, applicationServerKey }) {
  return withPushLock(env, async () => {
    const state = await readState(env);
    const credential = state.credential ?? newCredential(env);
    if (!(await registration.pushManager.getSubscription())) {
      await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(applicationServerKey) });
    }
    await writeState(env, {
      credential,
      applicationServerKey,
      ...(state.credential ? {} : { confirmed: false, askedAt: Date.now(), revision: 0, fingerprint: null }),
    });
    return { credentialHash: await credentialHash(env, credential) };
  });
}

/** Bring the server in line with this browser's subscription. Null when this browser has no credential. */
export function reconcile(env, { registration, post, permission }) {
  return withPushLock(env, async () => {
    let state = await readState(env);
    if (!state.credential) return null;
    let freshEndpoint = false;
    let serverKnows = state.confirmed;
    for (let attempt = 0; attempt < 4; attempt++) {
      let current = await registration.pushManager.getSubscription();
      if (!current && permission === 'granted' && state.applicationServerKey && serverKnows) {
        current = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.applicationServerKey) });
      }
      const json = current ? current.toJSON() : null;
      let body = { credential: state.credential };
      if (json?.endpoint) {
        const fp = await fingerprint(env, json);
        if (fp !== state.fingerprint) {
          state = { ...state, revision: state.revision + 1, fingerprint: fp };
          await writeState(env, { revision: state.revision, fingerprint: fp });
        }
        body = { ...body, subscription: json, revision: state.revision };
      }
      const answer = await post('/api/push/device', body);
      if (answer.state === 'stale') continue;
      // Someone else holds this endpoint (a copied subscription): take a fresh one, once.
      if (answer.state === 'endpoint-taken' && current && state.applicationServerKey && !freshEndpoint) {
        freshEndpoint = true;
        await current.unsubscribe();
        await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.applicationServerKey) });
        continue;
      }
      if (answer.state === 'registered' || answer.state === 'awaiting') await writeState(env, { confirmed: true });
      // Confirmed elsewhere, and this browser has no subscription to register yet: make one now, in this same call.
      if (answer.state === 'awaiting' && !current && permission === 'granted' && state.applicationServerKey && !serverKnows) {
        serverKnows = true;
        continue;
      }
      if (answer.state === 'missing') {
        const young = !state.confirmed && state.askedAt !== null && Date.now() - state.askedAt < UNCONFIRMED_MS;
        if (!young) {
          await current?.unsubscribe();
          await writeState(env, empty());
        }
      }
      // What this browser has, as well as what the server says: "on" needs both.
      return { state: answer.state, subscribed: !!current };
    }
    return { state: 'stale', subscribed: false };
  });
}

/** After a sign-up request with push on: the 48-hour protection counts from this request, not from the credential's birth. */
export function markRequested(env) {
  return withPushLock(env, () => writeState(env, { confirmed: false, askedAt: Date.now() }));
}

/** Turn this device off: on the server, in the browser, and here, unless another tab made a new credential meanwhile. */
export function turnOff(env, { registration, post }) {
  return withPushLock(env, async () => {
    const state = await readState(env);
    if (!state.credential) return null;
    const answer = await post('/api/push/device', { credential: state.credential }, 'DELETE');
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    const now = await readState(env);
    if (now.credential === state.credential) await writeState(env, empty());
    return answer;
  });
}
```

`shared.d.ts`:

```ts
import type { DeviceState } from '@penge/contracts';

export interface PushState {
  credential: string | null;
  confirmed: boolean;
  askedAt: number | null;
  revision: number;
  fingerprint: string | null;
  applicationServerKey: string | null;
}
export interface PushEnv {
  indexedDB: IDBFactory;
  locks: Pick<LockManager, 'request'>;
  crypto: Crypto;
}
export interface BrowserSubscription {
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}
export interface Registration {
  pushManager: {
    getSubscription(): Promise<BrowserSubscription | null>;
    subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<BrowserSubscription>;
  };
}
export type Post = (path: string, body: unknown, method?: 'POST' | 'DELETE') => Promise<any>;

export const LOCK_NAME: string;
export function readState(env: PushEnv): Promise<PushState>;
export function writeState(env: PushEnv, patch: Partial<PushState>): Promise<void>;
export function withPushLock<T>(env: PushEnv, fn: () => Promise<T>): Promise<T>;
export function fingerprint(env: PushEnv, json: { endpoint?: string; keys?: Record<string, string> }): Promise<string>;
export function newCredential(env: PushEnv): string;
export function credentialHash(env: PushEnv, credential: string): Promise<string>;
export function keyBytes(b64url: string): Uint8Array;
export function ensureSubscribed(env: PushEnv, a: { registration: Registration; applicationServerKey: string }): Promise<{ credentialHash: string }>;
export function reconcile(env: PushEnv, a: { registration: Registration; post: Post; permission: NotificationPermission }): Promise<{ state: DeviceState; subscribed: boolean } | null>;
export function turnOff(env: PushEnv, a: { registration: Registration; post: Post }): Promise<{ ok: true; noChannel: boolean } | null>;
export function markRequested(env: PushEnv): Promise<void>;
```

- [ ] **Step 4: Implement the worker handlers**

At the end of `apps/web/src/sw.js`:

```js
/* __SHARED__ */

const swEnv = { indexedDB: self.indexedDB, locks: self.navigator?.locks, crypto: self.crypto };

self.addEventListener('message', (event) => {
  if (event.data?.type === 'capabilities') event.ports?.[0]?.postMessage({ version: VERSION, push: true });
});

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data?.json() ?? null;
  } catch {
    data = null;
  }
  const ok = data?.v === 1;
  // Never silent: a push that shows nothing loses the permission in Chrome.
  const title = ok && typeof data.title === 'string' ? data.title : 'New dates are open';
  const options = {
    body: ok && typeof data.body === 'string' ? data.body : 'Open PengePassportPH to see them.',
    data: ok && data.url && typeof data.url === 'object' ? data.url : null,
    icon: `${scope}icons/icon-192.png`,
    badge: `${scope}icons/badge-96.png`,
  };
  if (ok && typeof data.tag === 'string') options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const u = event.notification.data ?? {};
  const q = new URLSearchParams();
  if (Number.isSafeInteger(u.office) && u.office > 0) q.set('office', String(u.office));
  if (typeof u.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u.date)) q.set('date', u.date);
  if (Number.isSafeInteger(u.people) && u.people >= 1 && u.people <= 5) q.set('people', String(u.people));
  const query = q.toString();
  const target = `${self.registration.scope}${query ? `?${query}` : ''}`;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      const mine = list.find((c) => c.url.startsWith(self.registration.scope));
      if (mine) {
        const moved = (await mine.navigate?.(target)) ?? mine;
        return moved.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // A fast path only: the page also reconciles every time it opens.
  if (!swEnv.locks || !swEnv.indexedDB) return;
  const post = (path, body, method = 'POST') =>
    fetch(`${self.registration.scope}${path.slice(1)}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  // (`fetch` here is the worker's global; the test harness passes its own into the worker's scope.)
  event.waitUntil(reconcile(swEnv, { registration: self.registration, post, permission: 'granted' }).catch(() => undefined));
});
```

`sw-plugin.ts`, in `generateBundle`:

```ts
      const shared = readFileSync(join(root, 'src/notify/shared.js'), 'utf8').replace(/^export /gm, '');
      const hash = createHash('sha256').update(worker).update(shared);
      for (const name of Object.keys(bundle).sort()) {
        const file = bundle[name]!;
        hash.update(`${name}\n`).update(file.type === 'chunk' ? file.code : file.source);
      }
      for (const name of PUBLIC_SHELL) hash.update(`${name}\n`).update(readFileSync(join(publicDir, name)));
      const source = worker
        .replace('/* __SHARED__ */', () => shared)
        .replace('__VERSION__', () => hash.digest('hex').slice(0, 12))
        .replace('__SHELL__', () => JSON.stringify(shell));
```

Add `'icons/badge-96.png'` to `PUBLIC_SHELL`.

- [ ] **Step 5: Render the two icons from a monochrome mark**

The full-colour mark has an opaque calendar body, so turning it white would make one solid shape. The Android app already has a mark drawn for one colour, `android/res/drawable/ic_launcher_monochrome.xml`: an outline, a header line, two rings, faint days (35% alpha) and one solid open day. The same drawing as an SVG, `apps/web/public/icons/mark-monochrome.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 8 74 78">
  <!-- The site's mark in one colour, for notification icons: the system uses only alpha.
       Copied from android/res/drawable/ic_launcher_monochrome.xml (keep the two the same). -->
  <g fill="none" stroke="#fff" stroke-width="4">
    <path d="M23,18 H71 A11,11 0 0 1 82,29 V73 A11,11 0 0 1 71,84 H23 A11,11 0 0 1 12,73 V29 A11,11 0 0 1 23,18 Z" />
    <path d="M12,34 H82" />
  </g>
  <path fill="#fff" d="M32.5,10 H32.5 A3,3 0 0 1 35.5,13 V21 A3,3 0 0 1 32.5,24 H32.5 A3,3 0 0 1 29.5,21 V13 A3,3 0 0 1 32.5,10 Z M61.5,10 H61.5 A3,3 0 0 1 64.5,13 V21 A3,3 0 0 1 61.5,24 H61.5 A3,3 0 0 1 58.5,21 V13 A3,3 0 0 1 61.5,10 Z" />
  <path fill="#fff" fill-opacity="0.35" d="M24.2,38 H28.8 A2.2,2.2 0 0 1 31,40.2 V43.8 A2.2,2.2 0 0 1 28.8,46 H24.2 A2.2,2.2 0 0 1 22,43.8 V40.2 A2.2,2.2 0 0 1 24.2,38 Z M36.7,38 H41.3 A2.2,2.2 0 0 1 43.5,40.2 V43.8 A2.2,2.2 0 0 1 41.3,46 H36.7 A2.2,2.2 0 0 1 34.5,43.8 V40.2 A2.2,2.2 0 0 1 36.7,38 Z M49.2,38 H53.8 A2.2,2.2 0 0 1 56,40.2 V43.8 A2.2,2.2 0 0 1 53.8,46 H49.2 A2.2,2.2 0 0 1 47,43.8 V40.2 A2.2,2.2 0 0 1 49.2,38 Z M61.7,38 H66.3 A2.2,2.2 0 0 1 68.5,40.2 V43.8 A2.2,2.2 0 0 1 66.3,46 H61.7 A2.2,2.2 0 0 1 59.5,43.8 V40.2 A2.2,2.2 0 0 1 61.7,38 Z M24.2,49.5 H28.8 A2.2,2.2 0 0 1 31,51.7 V55.3 A2.2,2.2 0 0 1 28.8,57.5 H24.2 A2.2,2.2 0 0 1 22,55.3 V51.7 A2.2,2.2 0 0 1 24.2,49.5 Z M36.7,49.5 H41.3 A2.2,2.2 0 0 1 43.5,51.7 V55.3 A2.2,2.2 0 0 1 41.3,57.5 H36.7 A2.2,2.2 0 0 1 34.5,55.3 V51.7 A2.2,2.2 0 0 1 36.7,49.5 Z M61.7,49.5 H66.3 A2.2,2.2 0 0 1 68.5,51.7 V55.3 A2.2,2.2 0 0 1 66.3,57.5 H61.7 A2.2,2.2 0 0 1 59.5,55.3 V51.7 A2.2,2.2 0 0 1 61.7,49.5 Z M24.2,61 H28.8 A2.2,2.2 0 0 1 31,63.2 V66.8 A2.2,2.2 0 0 1 28.8,69 H24.2 A2.2,2.2 0 0 1 22,66.8 V63.2 A2.2,2.2 0 0 1 24.2,61 Z M36.7,61 H41.3 A2.2,2.2 0 0 1 43.5,63.2 V66.8 A2.2,2.2 0 0 1 41.3,69 H36.7 A2.2,2.2 0 0 1 34.5,66.8 V63.2 A2.2,2.2 0 0 1 36.7,61 Z M49.2,61 H53.8 A2.2,2.2 0 0 1 56,63.2 V66.8 A2.2,2.2 0 0 1 53.8,69 H49.2 A2.2,2.2 0 0 1 47,66.8 V63.2 A2.2,2.2 0 0 1 49.2,61 Z M61.7,61 H66.3 A2.2,2.2 0 0 1 68.5,63.2 V66.8 A2.2,2.2 0 0 1 66.3,69 H61.7 A2.2,2.2 0 0 1 59.5,66.8 V63.2 A2.2,2.2 0 0 1 61.7,61 Z" />
  <path fill="#fff" d="M49.2,49.5 H53.8 A2.2,2.2 0 0 1 56,51.7 V55.3 A2.2,2.2 0 0 1 53.8,57.5 H49.2 A2.2,2.2 0 0 1 47,55.3 V51.7 A2.2,2.2 0 0 1 49.2,49.5 Z" />
</svg>
```

In `apps/web/scripts/icons.mjs`, after the existing loop and before `browser.close()`:

```js
// Notification icons: the one-colour mark (white on transparent; the system reads only alpha).
const mono = readFileSync(join(web, 'public/icons/mark-monochrome.svg'), 'utf8');
for (const { file, size } of [
  { file: join(web, 'public/icons/badge-96.png'), size: 96 },
  { file: join(web, 'public/icons/monochrome-512.png'), size: 512 },
]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * 0.86);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;display:grid;place-items:center">${mono.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await page.screenshot({ path: file, omitBackground: true });
  console.log('wrote', file.slice(repo.length + 1));
}
```

Run: `node apps/web/scripts/icons.mjs`, then `git status --short apps/web/public android/res`: the two new PNGs and the SVG are new; if any existing icon shows as changed, restore it with `git checkout -- <file>` (the script re-renders them, and font or renderer differences can change bytes). Look at both new PNGs (Read tool), on a dark background if the viewer allows: a white calendar outline with rings, faint days and one solid day.

A test pins the two drawings together, in `apps/web/test/pwa.test.ts`:

```ts
it('keeps the notification mark the same drawing as the Android monochrome icon', () => {
  const svg = readFileSync(join(web, 'public/icons/mark-monochrome.svg'), 'utf8');
  const xml = readFileSync(join(web, '../../android/res/drawable/ic_launcher_monochrome.xml'), 'utf8');
  const paths = (text: string, attr: RegExp) => [...text.matchAll(attr)].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
  expect(paths(svg, / d="([^"]+)"/g)).toEqual(paths(xml, /android:pathData="([^"]+)"/g));
  for (const size of [96, 512]) {
    const png = readFileSync(join(web, `public/icons/${size === 96 ? 'badge-96' : 'monochrome-512'}.png`));
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(`${size}x${size}`);
  }
});
```

- [ ] **Step 6: Run the web tests, the typecheck and a build**

Run: `npm test -w @penge/web && npm run typecheck && BASE_PATH=pengepassportph npm run build -w @penge/web && grep -c 'const withPushLock' apps/web/dist/sw.js`
Expected: PASS, and `1`.

- [ ] **Step 7: Break it on purpose**: run `turnOff`'s body without `withPushLock`: the slow-turn-off test FAILS (the other tab gets in early). Restore. In `ensureSubscribed`, always make a new credential: "keeps an existing credential" FAILS. Restore. Remove the `serverKnows` continue in `reconcile`: "subscribes and registers in one call" FAILS. Restore.

- [ ] **Step 8: Codex pass, then commit** (`Service worker: notifications, taps and renewal, with push state shared with the page`).

---

### Task 13: Where the app runs, the worker, and turning push on

**Files:**
- Create: `apps/web/src/notify/context.ts`, `apps/web/src/notify/worker.ts`, `apps/web/src/notify/push.ts`
- Modify: `apps/web/src/main.tsx`, `apps/web/src/api.ts`, `apps/web/test/helpers.tsx`, `apps/web/test/setup.ts`
- Test: `apps/web/test/notify.test.ts`

**Interfaces:**
- Consumes: Task 12; `StatusResponse.push`, `ConfirmPreview`, `ConfirmResponse`, `DeviceState`, `isDeviceState` (Task 1).
- Produces:
  - `type Context = 'play' | 'installed' | 'browser'`; `detectContext(w?: Window): Context`
  - `ownerOverride(w?: Window): boolean`
  - `type Capability = { ok: true } | { ok: false; reason: 'ios-tab' | 'unsupported' | 'off' | 'no-worker' }`; `pushCapability(w: Window, status: StatusResponse, o: { owner: boolean; workerOk: boolean }): Capability`
  - `deviceLabel(ua: string): string`
  - `worker.ts`: `register(): void`, `skipRegistration(): void`, `registration(): Promise<ServiceWorkerRegistration | null>` (resolves once registration finished or was skipped), `workerFailed(): boolean`, `readyWorker(): Promise<{ registration: ServiceWorkerRegistration } | null>`
  - `push.ts`: `pushEnv(): PushEnv`; `PUSH_CHANGED` (the window event name the sheet and the confirmation page send, and the row listens to); `enablePush(a: { vapidPublicKey: string; timeoutMs?: number }): Promise<{ ok: true; credentialHash: string } | { ok: false; reason: 'denied' | 'dismissed' | 'no-worker' | 'subscribe-failed' }>`; `postToApi: Post` (wraps `api.pushDevice` / `api.pushOff`)
  - `Api` gains `previewConfirm(token): Promise<ConfirmPreview>`, `confirm(token, acknowledge?)`, `pushDevice(body): Promise<{ state: DeviceState }>`, `pushOff(credential): Promise<{ ok: true; noChannel: boolean }>`, `pushTest(credential): Promise<void>`; `ApiFailure` gains `code: string | null`
  - `fakeApi()` in `test/helpers.tsx` gains those four methods, and `confirm` answers with `channels: { emailOn: true, pushOn: false, push: 'none' }`; `STATUS` gains `push: 'off', vapidPublicKey: null`
  - A debug line (`<p class="debug-context">context: play</p>`) shown on the home page only in builds made with `VITE_LOCAL_DEBUG=1`

- [ ] **Step 1: Write the failing tests**

`apps/web/test/notify.test.ts`. The worker module is mocked once, at the top (hoisted), with behaviour each test sets:

```ts
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATUS } from './helpers.tsx';

const workerMock = vi.hoisted(() => ({ ready: vi.fn(), failed: vi.fn(() => false) }));
vi.mock('../src/notify/worker.ts', () => ({
  register: vi.fn(),
  registration: vi.fn(async () => null),
  workerFailed: workerMock.failed,
  readyWorker: workerMock.ready,
}));
const sharedMock = vi.hoisted(() => ({ ensureSubscribed: vi.fn() }));
vi.mock('../src/notify/shared.js', async (orig) => ({ ...(await orig<object>()), ensureSubscribed: sharedMock.ensureSubscribed }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectContext, deviceLabel, ownerOverride, pushCapability } from '../src/notify/context.ts';
import { enablePush } from '../src/notify/push.ts';
import { builtWorkerSource } from './worker-source.ts';

const LIVE = { ...STATUS, push: 'live' as const, vapidPublicKey: 'B'.repeat(87) };

/** A Storage that keeps what it is given, like the browser's. */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
function fakeWindow(over: Record<string, unknown> = {}, storage = new MemoryStorage()) {
  return {
    document: { referrer: '' },
    matchMedia: (q: string) => ({ matches: false, media: q }),
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile', serviceWorker: {}, locks: {} },
    PushManager: function () {},
    Notification: { permission: 'default' },
    isSecureContext: true,
    sessionStorage: storage,
    location: { search: '' },
    ...over,
  } as unknown as Window;
}

afterEach(() => {
  vi.unstubAllGlobals();
  workerMock.ready.mockReset();
  sharedMock.ensureSubscribed.mockReset();
});

describe('where the app runs', () => {
  it('knows the Play app by its exact package, and remembers it', () => {
    const storage = new MemoryStorage();
    expect(detectContext(fakeWindow({ document: { referrer: 'android-app://com.alphaexperiments.pengepassportph/' } }, storage))).toBe('play');
    expect(detectContext(fakeWindow({}, storage))).toBe('play'); // the referrer is gone after the first page
    expect(detectContext(fakeWindow({ document: { referrer: 'android-app://com.alphaexperiments.pengepassportph.evil/' } }))).toBe('browser');
    expect(detectContext(fakeWindow({ document: { referrer: 'android-app://com.alphaexperiments.pengepassportph/https/alphaexperiments.com/pengepassportph/' } }))).toBe('play');
  });

  it('knows an installed app by its display mode', () => {
    for (const mode of ['standalone', 'minimal-ui', 'fullscreen']) {
      expect(detectContext(fakeWindow({ matchMedia: (q: string) => ({ matches: q.includes(mode) }) }))).toBe('installed');
    }
  });

  it('offers nothing in an iPhone tab, whatever the APIs say', () => {
    const iphone = fakeWindow({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605', serviceWorker: {}, locks: {} } });
    expect(pushCapability(iphone, LIVE, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'ios-tab' });
  });

  it('hides push when the server has it off, and in owner mode unless ?push=owner, which it remembers', () => {
    expect(pushCapability(fakeWindow(), { ...LIVE, push: 'off' }, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'off' });
    expect(pushCapability(fakeWindow(), { ...LIVE, push: 'owner' }, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'off' });
    expect(pushCapability(fakeWindow(), { ...LIVE, push: 'owner' }, { owner: true, workerOk: true })).toEqual({ ok: true });
    const storage = new MemoryStorage();
    expect(ownerOverride(fakeWindow({ location: { search: '?push=owner' } }, storage))).toBe(true);
    expect(ownerOverride(fakeWindow({ location: { search: '' } }, storage))).toBe(true);
    expect(ownerOverride(fakeWindow({ location: { search: '' } }))).toBe(false);
  });

  it('treats a browser without Web Locks, or whose worker failed to register, as not capable', () => {
    expect(pushCapability(fakeWindow({ navigator: { userAgent: 'x', serviceWorker: {} } }), LIVE, { owner: false, workerOk: true })).toEqual({ ok: false, reason: 'unsupported' });
    expect(pushCapability(fakeWindow(), LIVE, { owner: false, workerOk: false })).toEqual({ ok: false, reason: 'no-worker' });
  });

  it('labels a device coarsely', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Gecko/20100101 Firefox/143.0')).toBe('Firefox on Mac');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile')).toBe('Chrome on Android');
    expect(deviceLabel('<script>')).toBe('A browser');
  });
});

describe('turning push on', () => {
  beforeEach(() => vi.stubGlobal('navigator', { ...navigator, locks: { request: (_: string, fn: () => unknown) => fn() } }));

  it('waits for the new worker when the real old one (from the last release) is active', async () => {
    // A fresh copy of the module: its registration state is set once per page load.
    vi.resetModules();
    const { readyWorker: realReady, register } = await vi.importActual<typeof import('../src/notify/worker.ts')>('../src/notify/worker.ts');
    // A worker built from a source: postMessage reaches its 'message' listeners, if it has any.
    const workerFrom = (source: string) => {
      const listeners: Record<string, ((e: unknown) => void)[]> = {};
      const self = { registration: { scope: 'https://x/' }, location: new URL('https://x/sw.js'), addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f), skipWaiting: () => {}, clients: { claim: () => {} } };
      new Function('self', 'caches', 'fetch', 'Response', source)(self, {}, () => {}, Response);
      return { postMessage: (data: unknown, ports: MessagePort[]) => listeners.message?.forEach((f) => f({ data, ports })) } as unknown as ServiceWorker;
    };
    const oldSource = readFileSync(join(__dirname, 'fixtures/v0.2/sw.js'), 'utf8').replace('__VERSION__', 'old').replace('__SHELL__', '[]');
    const newSource = builtWorkerSource();
    const swListeners: Record<string, () => void> = {};
    const reg = { active: workerFrom(oldSource), update: vi.fn(async () => { reg.active = workerFrom(newSource); swListeners.controllerchange?.(); }) };
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), addEventListener: (t: string, f: () => void) => (swListeners[t] = f), removeEventListener: () => {} },
    });
    register();
    expect(await realReady()).toEqual({ registration: reg });
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it("notices a new worker that took over during the old one's silent handshake", async () => {
    vi.resetModules();
    const { readyWorker: realReady, register } = await vi.importActual<typeof import('../src/notify/worker.ts')>('../src/notify/worker.ts');
    const swListeners: Record<string, () => void> = {};
    const newWorker = { postMessage: (_d: unknown, ports: MessagePort[]) => ports[0]!.postMessage({ push: true }) } as unknown as ServiceWorker;
    const reg: { active: ServiceWorker; update: ReturnType<typeof vi.fn> } = {
      // The old worker never answers; while it is being asked, the browser swaps in the new one.
      active: { postMessage: () => { setTimeout(() => { reg.active = newWorker; swListeners.controllerchange?.(); }, 10); } } as unknown as ServiceWorker,
      update: vi.fn(async () => {}), // finds nothing newer: no further event
    };
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), addEventListener: (t: string, f: () => void) => (swListeners[t] = f), removeEventListener: () => {} },
    });
    register();
    expect(await realReady()).toEqual({ registration: reg });
  });

  it('gives a hint without asking when permission was already denied (Review Focus 2)', async () => {
    const request = vi.fn();
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: request });
    expect(await enablePush({ vapidPublicKey: LIVE.vapidPublicKey })).toEqual({ ok: false, reason: 'denied' });
    expect(request).not.toHaveBeenCalled();
  });

  it('turns back off when subscribe() is refused (Review Focus 3)', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });
    workerMock.ready.mockResolvedValue({ registration: {} });
    sharedMock.ensureSubscribed.mockRejectedValue(new DOMException('no', 'AbortError'));
    expect(await enablePush({ vapidPublicKey: LIVE.vapidPublicKey })).toEqual({ ok: false, reason: 'subscribe-failed' });
  });

  it('gives up after 10 s when no push-capable worker takes over', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });
    workerMock.ready.mockReturnValue(new Promise(() => {}));
    const result = enablePush({ vapidPublicKey: LIVE.vapidPublicKey });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ ok: false, reason: 'no-worker' });
    vi.useRealTimers();
  });

  it('passes a channel error from the server to the form', async () => {
    const { api, ApiFailure } = await vi.importActual<typeof import('../src/api.ts')>('../src/api.ts');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Please fix the highlighted fields.', fields: { channels: 'Notifications are not available yet.' } }), { status: 400 })));
    const err = await api.subscribe({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: null, website: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as InstanceType<typeof ApiFailure>).fields.channels).toBe('Notifications are not available yet.');
  });

  it('returns the credential hash once subscribed', async () => {
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
    workerMock.ready.mockResolvedValue({ registration: {} });
    sharedMock.ensureSubscribed.mockResolvedValue({ credentialHash: 'h'.repeat(43) });
    expect(await enablePush({ vapidPublicKey: LIVE.vapidPublicKey })).toEqual({ ok: true, credentialHash: 'h'.repeat(43) });
  });
});
```

Also add to `apps/web/test/setup.ts` (jsdom has no `matchMedia`; the sheet now calls it through `detectContext`):

```ts
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
```

The old worker is the real one from the release before push, and the new one is the real build:

```bash
mkdir -p apps/web/test/fixtures/v0.2
git show 157bad9:apps/web/src/sw.js > apps/web/test/fixtures/v0.2/sw.js
```

`apps/web/test/worker-source.ts` exports `builtWorkerSource()`, the same build `pwa.test.ts` makes (move its `built()` helper and `BUILD` constant there and import them in both files), returning the `source`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/web -- test/notify.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `context.ts`**

```ts
// Where the app runs (it only chooses wording), and whether push can work here.
// Detection is never a security check: the server checks everything again.
import type { StatusResponse } from '@penge/contracts';

export type Context = 'play' | 'installed' | 'browser';
const PLAY = 'com.alphaexperiments.pengepassportph';
const DEBUG = 'com.alphaexperiments.pengepassportph.dev';
const CONTEXT_KEY = 'pengepassportph-context';
const OWNER_KEY = 'pengepassportph-push-owner';

function remember(w: Window, key: string, value: string) {
  try {
    w.sessionStorage.setItem(key, value);
  } catch {
    // Private modes can refuse storage: detect again next time instead.
  }
}
function recall(w: Window, key: string): string | null {
  try {
    return w.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function detectContext(w: Window = window): Context {
  if (recall(w, CONTEXT_KEY) === 'play') return 'play';
  let pkg: string | null = null;
  try {
    const u = new URL(w.document.referrer);
    if (u.protocol === 'android-app:') pkg = u.hostname;
  } catch {
    // No referrer, or not a URL.
  }
  if (pkg === PLAY || (import.meta.env.VITE_LOCAL_DEBUG === '1' && pkg === DEBUG)) {
    remember(w, CONTEXT_KEY, 'play');
    return 'play';
  }
  if (['standalone', 'minimal-ui', 'fullscreen'].some((m) => w.matchMedia(`(display-mode: ${m})`).matches)) return 'installed';
  if ((w.navigator as Navigator & { standalone?: boolean }).standalone === true) return 'installed';
  return 'browser';
}

export function ownerOverride(w: Window = window): boolean {
  if (new URLSearchParams(w.location.search).get('push') === 'owner') remember(w, OWNER_KEY, '1');
  return recall(w, OWNER_KEY) === '1' || new URLSearchParams(w.location.search).get('push') === 'owner';
}

export type Capability = { ok: true } | { ok: false; reason: 'ios-tab' | 'unsupported' | 'off' | 'no-worker' };

export function pushCapability(w: Window, status: StatusResponse, o: { owner: boolean; workerOk: boolean }): Capability {
  if (status.push === 'off' || !status.vapidPublicKey || (status.push === 'owner' && !o.owner)) return { ok: false, reason: 'off' };
  const ua = w.navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in w.document);
  if (ios && detectContext(w) === 'browser') return { ok: false, reason: 'ios-tab' };
  const n = w.navigator as Navigator & { locks?: unknown };
  if (!w.isSecureContext || !('serviceWorker' in n) || !('PushManager' in w) || !('Notification' in w) || !n.locks) return { ok: false, reason: 'unsupported' };
  if (!o.workerOk) return { ok: false, reason: 'no-worker' };
  return { ok: true };
}

export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  if (!browser) return 'A browser';
  return os ? `${browser} on ${os}` : browser;
}
```

- [ ] **Step 4: Implement `worker.ts`, `push.ts` and the API calls**

`notify/worker.ts`:

```ts
// The service worker this page registers, and a check that the active one can
// handle pushes. An old worker has no message handler and never answers: silence
// means old, so the page asks for the new one and waits for it to take over.
import { BASE } from '../links.ts';

let failed = false;
let settle!: (r: ServiceWorkerRegistration | null) => void;
/** Resolves once registration has finished (or was skipped): anyone may wait on it from the start. */
const done = new Promise<ServiceWorkerRegistration | null>((r) => (settle = r));

export function register(): void {
  if (!('serviceWorker' in navigator)) return settle(null);
  navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).then(settle, () => {
    failed = true;
    settle(null);
  });
}
/** Development builds register no worker. */
export const skipRegistration = () => settle(null);
export const registration = () => done;
export const workerFailed = () => failed;

function ask(worker: ServiceWorker, ms: number): Promise<{ push?: boolean } | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ms);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data as { push?: boolean });
    };
    worker.postMessage({ type: 'capabilities' }, [channel.port2]);
  });
}

/** A registration whose active worker handles pushes, or null. The caller bounds the wait. */
export async function readyWorker(): Promise<{ registration: ServiceWorkerRegistration } | null> {
  const reg = await done;
  if (!reg) return null;
  // Listening from the start: the browser's own update can swap the worker in at any moment,
  // the handshake's second included, and that change must not be missed.
  let wake = () => {};
  const onChange = () => wake();
  navigator.serviceWorker.addEventListener('controllerchange', onChange);
  try {
    let updated = false;
    for (let round = 0; round < 3; round++) {
      const active = reg.active ?? (await navigator.serviceWorker.ready).active;
      if (active && (await ask(active, 1000))?.push) return { registration: reg };
      // Swapped while we asked: ask the new one.
      if (reg.active && reg.active !== active) continue;
      const swapped = new Promise<void>((r) => (wake = r));
      if (!updated) {
        updated = true;
        await reg.update().catch(() => undefined);
      }
      if (reg.active === active) await swapped;
    }
    return null;
  } finally {
    navigator.serviceWorker.removeEventListener('controllerchange', onChange);
  }
}
```

`main.tsx`: replace the inline registration with `import { register, skipRegistration } from './notify/worker.ts';` and `if (import.meta.env.PROD) window.addEventListener('load', register); else skipRegistration();`. Everyone who awaits `registration()` (the row, the confirmation page, the sheet's poll) now waits for the real outcome instead of an early `null`.

`notify/push.ts`:

```ts
// Turning push on in this browser: the permission first (inside the click),
// then a push-capable worker, then a subscription and a credential, both under
// the shared lock. Anything that fails turns the switch back off with a reason.
import { api } from '../api.ts';
import { ensureSubscribed, type PushEnv, type Post } from './shared.js';
import { readyWorker } from './worker.ts';

export const pushEnv = (): PushEnv => ({ indexedDB, locks: navigator.locks, crypto });
/** Sent on window when this browser's push state changes (the sheet, the confirmation page); the row listens. */
export const PUSH_CHANGED = 'pengepassportph-push-changed';
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

export const postToApi: Post = (path, body, method = 'POST') => {
  const b = body as { credential: string };
  if (method === 'DELETE') return api.pushOff(b.credential);
  return api.pushDevice(b);
};

export type EnableResult = { ok: true; credentialHash: string } | { ok: false; reason: 'denied' | 'dismissed' | 'no-worker' | 'subscribe-failed' };

export async function enablePush(a: { vapidPublicKey: string; timeoutMs?: number }): Promise<EnableResult> {
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  // Asked first, before any await, so the browser still sees the click.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
  const ready = await within(readyWorker(), a.timeoutMs ?? 10_000);
  if (!ready) return { ok: false, reason: 'no-worker' };
  try {
    const { credentialHash } = await ensureSubscribed(pushEnv(), { registration: ready.registration, applicationServerKey: a.vapidPublicKey });
    return { ok: true, credentialHash };
  } catch {
    return { ok: false, reason: 'subscribe-failed' };
  }
}
```

`api.ts`: `FIELDS` gains `'channels'` (so a server's channel error reaches the form), `ApiFailure` gains `readonly code: string | null` (read from the error body's `code` when it is one of `reload`, `push-unavailable`, `full`). Add guards and calls:

```ts
const isPreview = (v: unknown): v is ConfirmPreview => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const c = r.channels as Record<string, unknown> | null | undefined;
  return Array.isArray(r.siteIds) && Number.isSafeInteger(r.applicants) && isPace(r.pace) &&
    (c === null || (typeof c === 'object' && typeof c.emailOn === 'boolean' && typeof c.pushOn === 'boolean' && typeof c.requestedAt === 'string'));
};
const isDeviceAnswer = (v: unknown): v is { state: DeviceState } => typeof v === 'object' && v !== null && isDeviceState((v as { state?: unknown }).state);
const isOffAnswer = (v: unknown): v is { ok: true; noChannel: boolean } =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === true && typeof (v as { noChannel?: unknown }).noChannel === 'boolean';
```

`isConfirm` also requires `channels` with `emailOn`, `pushOn` booleans and a `push` string. `call` gains a `method` argument (`'POST' | 'DELETE'`). In `Api` and `api`:

```ts
  previewConfirm: async (token) => expect(await call(`${BASE}api/confirm/preview`, { token }), isPreview),
  confirm: async (token, acknowledge) => expect(await call(`${BASE}api/confirm`, acknowledge ? { token, acknowledge } : { token }), isConfirm),
  pushDevice: async (body) => expect(await call(`${BASE}api/push/device`, body), isDeviceAnswer),
  pushOff: async (credential) => expect(await call(`${BASE}api/push/device`, { credential }, 'DELETE'), isOffAnswer),
  pushTest: async (credential) => {
    await call(`${BASE}api/push/test`, { credential });
  },
```

`test/helpers.tsx`: `STATUS` gains `push: 'off', vapidPublicKey: null`; `fakeApi()` gains

```ts
    previewConfirm: vi.fn(async () => ({ siteIds: [486], applicants: 1, pace: 'hourly' as const, channels: null })),
    pushDevice: vi.fn(async () => ({ state: 'missing' as const })),
    pushOff: vi.fn(async () => ({ ok: true as const, noChannel: false })),
    pushTest: vi.fn(async () => {}),
```

and its `confirm` answer gains `channels: { emailOn: true, pushOn: false, push: 'none' as const }`.

The debug line, in `Home.tsx` just under the summary:

```tsx
      {import.meta.env.VITE_LOCAL_DEBUG === '1' && <p className="debug-context">context: {detectContext()}</p>}
```

- [ ] **Step 5: Run the web tests and the typecheck** → PASS.

- [ ] **Step 6: Codex pass, then commit** (`Detect where the app runs, check the worker, and turn push on inside the click`).

---

### Task 14: Email and notification switches in the alert form

**Files:**
- Modify: `apps/web/src/components/AlertSheet.tsx`, `apps/web/src/pages/Home.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/sheet.test.tsx`

**Interfaces:**
- Consumes: Tasks 12–13.
- Produces: `AlertSheet` props gain `status: StatusResponse`; the request it sends carries `channels`.

- [ ] **Step 1: Write the failing tests**

At the top of `apps/web/test/sheet.test.tsx`, hoisted mocks:

```ts
const pushMock = vi.hoisted(() => ({ enable: vi.fn() }));
vi.mock('../src/notify/push.ts', () => ({ enablePush: pushMock.enable, pushEnv: () => ({}), postToApi: vi.fn(), PUSH_CHANGED: 'pengepassportph-push-changed' }));
vi.mock('../src/notify/shared.js', () => ({ reconcile: vi.fn(async () => ({ state: 'pending' })), readState: vi.fn(async () => ({ credential: null })), markRequested: vi.fn(async () => {}) }));
const workerMock = vi.hoisted(() => ({ registration: vi.fn(async () => ({}) as unknown) }));
vi.mock('../src/notify/worker.ts', () => ({ workerFailed: () => false, registration: workerMock.registration, readyWorker: async () => null, register: () => {} }));
```

The existing `Harness` and `open()` pass `status={STATUS}` (push off, so every existing test sees no new switch). New tests:

```ts
const LIVE = { ...STATUS, push: 'live' as const, vapidPublicKey: 'B'.repeat(87) };
const ANDROID = 'Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605';

function openWith(status = LIVE, ua = ANDROID, permission: NotificationPermission = 'default') {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  vi.stubGlobal('PushManager', function () {});
  vi.stubGlobal('Notification', { permission });
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
  Object.defineProperty(navigator, 'locks', { value: {}, configurable: true });
  const api = fakeApi();
  function H() {
    const [selected, setSelected] = useState<number[]>([486]);
    return <AlertSheet api={api} status={status} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} />;
  }
  render(<H />);
  const sheet = screen.getByRole('dialog');
  return {
    api,
    sheet,
    email: within(sheet).getByLabelText('Your email') as HTMLInputElement,
    emailSwitch: within(sheet).getByRole('switch', { name: 'Email' }),
    pushSwitch: () => within(sheet).queryByRole('switch', { name: /notifications/i }),
    submit: within(sheet).getByRole('button', { name: /Send confirmation email/ }),
  };
}

describe('channels in the alert form', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    pushMock.enable.mockReset();
  });

  it('sends email only by default, with channels', async () => {
    const s = openWith();
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    await waitFor(() => expect(s.api.subscribe).toHaveBeenCalled());
    expect(s.api.subscribe.mock.calls[0]![0].channels).toEqual({ emailOn: true, pushOn: false, pushCredentialHash: null, device: null });
  });

  it('turns push on with a credential hash and a device label', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    await waitFor(() => expect(s.api.subscribe).toHaveBeenCalled());
    expect(s.api.subscribe.mock.calls[0]![0].channels).toEqual({ emailOn: true, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: 'Chrome on Android' });
  });

  it('calls enablePush inside the click, before anything else awaits', async () => {
    pushMock.enable.mockReturnValueOnce(new Promise(() => {}));
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    expect(pushMock.enable).toHaveBeenCalledTimes(1); // synchronously, in the same task as the click
  });

  it('refuses to send with no channel', async () => {
    const s = openWith();
    fireEvent.click(s.emailSwitch);
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    expect(await within(s.sheet).findByText('Turn on at least one: email or notifications.')).toBeTruthy();
    expect(s.api.subscribe).not.toHaveBeenCalled();
  });

  it('turns email back on when notifications are switched off and email was off', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(s.emailSwitch);
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(s.pushSwitch()!);
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('true');
  });

  it('shows how to allow notifications as soon as the sheet opens when they are already blocked (Review Focus 2)', async () => {
    const s = openWith(LIVE, ANDROID, 'denied');
    expect(await within(s.sheet).findByText(/Notifications are blocked for this site/)).toBeTruthy();
    expect(pushMock.enable).not.toHaveBeenCalled();
  });

  it('hides the switch and says why when the service worker failed to register', async () => {
    workerMock.registration.mockResolvedValueOnce(null);
    const s = openWith();
    expect(await within(s.sheet).findByText(/Reload the page to turn them on; email still works/)).toBeTruthy();
    expect(s.pushSwitch()).toBeNull();
  });

  it('shows the denied hint and leaves the switch off', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: false, reason: 'denied' });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    expect(await within(s.sheet).findByText(/Notifications are blocked for this site/)).toBeTruthy();
    expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('false');
  });

  it('says what the device really is while waiting, and tells the row only when it changes', async () => {
    const shared = await import('../src/notify/shared.js');
    const reconcile = vi.mocked(shared.reconcile);
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seen: unknown[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('pengepassportph-push-changed', listen);
    const s = openWith(LIVE, ANDROID, 'granted');
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    reconcile.mockResolvedValue({ state: 'registered', subscribed: false });
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    expect(await within(s.sheet).findByText('Waiting for you to confirm by email.')).toBeTruthy(); // registered, but no subscription here: not "on"
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toHaveLength(1); // three answers, one change
    reconcile.mockResolvedValue({ state: 'missing', subscribed: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await within(s.sheet).findByText(/were not turned on for this device/)).toBeTruthy();
    expect(seen).toHaveLength(2);
    window.removeEventListener('pengepassportph-push-changed', listen);
    vi.useRealTimers();
  });

  it('turns email back on when push fails to come on and email was off', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: false, reason: 'dismissed' });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.emailSwitch);
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.emailSwitch.getAttribute('aria-checked')).toBe('true'));
  });

  it('shows the subscribe-failed reason and keeps email on', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: false, reason: 'subscribe-failed' });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    expect(await within(s.sheet).findByText(/This browser would not turn notifications on/)).toBeTruthy();
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('true');
  });

  it('shows no switch in an iPhone tab, with the Home Screen hint', () => {
    const s = openWith(LIVE, IPHONE);
    expect(s.pushSwitch()).toBeNull();
    expect(within(s.sheet).getByText(/add this site to your Home Screen/)).toBeTruthy();
  });

  it('shows no switch when the server has push off', () => {
    const s = openWith({ ...STATUS, push: 'off', vapidPublicKey: null });
    expect(s.pushSwitch()).toBeNull();
  });
});
```

The existing sheet tests change with the form, which now sends explicit email-only channels by default:
- "sends the request …" (the one expecting `{ email: 'juan@example.com', siteIds: [486], applicants: 3, pace: 'asap', … }`) and the Dubai request in `pages.test.tsx` expect `channels: { emailOn: true, pushOn: false, pushCredentialHash: null, device: null }` instead of `channels: null`.
- The fuzz test's oracle gives `validateSubscribe` the same channels the form sends: `validateSubscribe({ email: s.email.value, siteIds: chosen, applicants, pace, website, channels: { emailOn: true, pushOn: false, pushCredentialHash: null, device: null } }, KNOWN)`.

- [ ] **Step 2: Run them to see them fail**

Run: `npm test -w @penge/web -- test/sheet.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `AlertSheet.tsx`: `Props` gains `status: StatusResponse`. New state and handlers:

```tsx
  const [emailOn, setEmailOn] = useState(true);
  const [pushOn, setPushOn] = useState(false);
  const [pushHash, setPushHash] = useState<string | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const context = useMemo(() => detectContext(), []);
  // The switch appears only once the service worker has registered: null while unknown.
  const [workerOk, setWorkerOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void registration().then((r) => live && setWorkerOk(!!r));
    return () => {
      live = false;
    };
  }, []);
  const capability = useMemo(() => {
    // What the browser and the server allow does not wait for the worker (so an iPhone tab
    // says so at once); only the switch itself waits until the worker has registered.
    const base = pushCapability(window, status, { owner: ownerOverride(), workerOk: true });
    if (!base.ok) return base;
    if (workerOk === null) return { ok: false, reason: 'off' } as const;
    return workerOk ? base : ({ ok: false, reason: 'no-worker' } as const);
  }, [status, workerOk]);
  // Blocked already: say how to allow it as soon as the switch shows, without asking.
  useEffect(() => {
    if (capability.ok && 'Notification' in window && Notification.permission === 'denied') setPushNote(BLOCKED[context]);
  }, [capability.ok]);

  const BLOCKED: Record<Context, string> = {
    browser: /Firefox\//.test(navigator.userAgent)
      ? 'Notifications are blocked for this site. Allow them from the padlock in the address bar, then try again.'
      : 'Notifications are blocked for this site. Allow them in the site settings (the icon left of the address), then try again.',
    installed: 'Notifications are blocked for this app. Allow them in your browser or phone settings, then try again.',
    play: "Allow notifications for PassportPH in your phone's Settings › Apps, then try again.",
  };

  function togglePush() {
    if (pushOn) {
      setPushOn(false);
      setPushHash(null);
      if (!emailOn) setEmailOn(true);
      return;
    }
    setPushNote(null);
    // No await before this: the browser must see the permission request as part of the click.
    void enablePush({ vapidPublicKey: status.vapidPublicKey! }).then((r) => {
      if (r.ok) {
        setPushOn(true);
        setPushHash(r.credentialHash);
        return;
      }
      // Push did not come on: turn email back on, so a channel is always on.
      setEmailOn(true);
      setPushNote(
        r.reason === 'denied' ? BLOCKED[context]
        : r.reason === 'no-worker' ? 'Notifications need the site to finish loading. Reload the page and try again.'
        : r.reason === 'subscribe-failed' ? 'This browser would not turn notifications on (private windows often refuse). Email still works.'
        : null,
      );
    });
  }
```

In `submit`, build `channels` and pass them to both `validateSubscribe` and `api.subscribe`:

```tsx
    const channels = { emailOn, pushOn, pushCredentialHash: pushOn ? pushHash : null, device: pushOn ? deviceLabel(navigator.userAgent) : null };
    const checked = validateSubscribe({ email, siteIds: selected, applicants, pace, website, channels }, new Set(offices.map((o) => o.id)));
```

The group, before the honeypot `div`:

```tsx
            <fieldset className="field channels">
              <legend>How should we tell you?</legend>
              <button type="button" role="switch" className="switch" aria-checked={emailOn} onClick={() => setEmailOn(!emailOn)}>
                <span className="switch-track" aria-hidden="true" /> Email
              </button>
              {capability.ok ? (
                <>
                  <button type="button" role="switch" className="switch" aria-checked={pushOn} onClick={togglePush}>
                    <span className="switch-track" aria-hidden="true" /> {context === 'browser' ? 'Browser notifications' : 'Notifications on this device'}
                  </button>
                  {context === 'browser' && <p className="hint">Works best in the app: add it to your home screen or get it on Google Play.</p>}
                </>
              ) : capability.reason === 'ios-tab' ? (
                <p className="hint">To get notifications on iPhone, add this site to your Home Screen, then open it from there.</p>
              ) : capability.reason === 'unsupported' ? (
                <p className="hint">This browser can’t show notifications. Email still works.</p>
              ) : capability.reason === 'no-worker' ? (
                <p className="hint">Notifications need the site to finish loading. Reload the page to turn them on; email still works.</p>
              ) : null}
              {pushNote && <p className="hint hint-strong">{pushNote}</p>}
              {errors.channels && <p className="error">{errors.channels}</p>}
            </fieldset>
```

The sheet title becomes `{sent ? 'Check your email' : 'Tell me when dates open'}`. Under the submit button, when `pushOn`: `<p className="hint sheet-fine">We email you a link first, even for notifications only; nothing starts until you press it.</p>` (in place of the existing fine print).

In `submit`, after `api.subscribe` succeeds with push on: `await markRequested(pushEnv())`, so the 48-hour protection counts from this request.

The "Check your email" view, after a submit with push on, waits for confirmation:

```tsx
  const [pushAnswer, setPushAnswer] = useState<{ state: DeviceState; subscribed: boolean } | null>(null);
  useEffect(() => {
    if (!sent || !pushOn) return;
    let live = true;
    let last = '';
    const tick = async () => {
      const reg = await registration();
      if (!reg || !live) return;
      const answer = await reconcile(pushEnv(), { registration: reg, post: postToApi, permission: Notification.permission }).catch(() => null);
      if (!live || !answer) return;
      setPushAnswer(answer);
      // Shared with the row, only when it changed: the row takes it as is, without asking the server again.
      const key = `${answer.state}|${answer.subscribed}`;
      if (key !== last) {
        last = key;
        window.dispatchEvent(new CustomEvent(PUSH_CHANGED, { detail: answer }));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sent, pushOn]);
```

and in the done view, under the message, the state as it really is:

```tsx
  {pushOn && <p className="hint">{pushLine(pushAnswer)}</p>}
```

```tsx
/** What the waiting sheet says about this device: "on" needs the server, the permission and the browser to agree. */
function pushLine(a: { state: DeviceState; subscribed: boolean } | null): string {
  if (!a) return 'Waiting for you to confirm by email.';
  if (Notification.permission === 'denied') return 'Notifications are blocked on this device. Allow them in your browser or phone settings.';
  if (a.state === 'registered' && a.subscribed && Notification.permission === 'granted') return 'Notifications are on for this device.';
  if (a.state === 'missing') return 'Notifications were not turned on for this device. Fill in the form again to try once more.';
  if (a.state === 'stale' || a.state === 'endpoint-taken') return 'Notifications are still being set up on this device.';
  return 'Waiting for you to confirm by email.';
}
```

`styles.css`:

```css
.channels { display: grid; gap: 4px; }
.switch {
  display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0;
  background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.switch-track {
  position: relative; flex: none; width: 40px; height: 24px; border-radius: 12px;
  background: var(--line-strong); transition: background 0.15s;
}
.switch-track::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
  background: var(--bg); transition: transform 0.15s;
}
.switch[aria-checked='true'] .switch-track { background: var(--open); }
.switch[aria-checked='true'] .switch-track::after { transform: translateX(16px); }
.switch:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 6px; }
.device-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 0 0 12px; }
.channels-preview { margin: 0 0 12px; padding-left: 20px; }
.debug-context { font: 12px/1.4 ui-monospace, monospace; opacity: 0.7; }
@media (prefers-reduced-motion: reduce) { .switch-track, .switch-track::after { transition: none; } }
```

`Home.tsx` passes `status={status}` to `AlertSheet`.

`styles.css`: a `.switch` row (flex, gap, 44px tall touch target), `.switch-track` (a pill drawn with the theme's border and accent tokens, its knob moved by `[aria-checked='true']`), focus ring like other buttons. No new colours: reuse the existing CSS custom properties.

- [ ] **Step 4: Run all web tests** → PASS.

- [ ] **Step 5: Codex pass, then commit** (`Email and notification switches in the alert form`).

---

### Task 15: Confirmation preview, the notifications row, and group size in links

**Files:**
- Modify: `apps/web/src/pages/Confirm.tsx`, `apps/web/src/components/TokenAction.tsx`, `apps/web/src/pages/Home.tsx`
- Create: `apps/web/src/components/DeviceRow.tsx`
- Test: `apps/web/test/pages.test.tsx`

**Interfaces:**
- Consumes: Tasks 12–13.
- Produces:
  - `TokenAction` gains optional `prepare?: (token: string) => Promise<{ intro: ReactNode; data: unknown }>`; when given, it runs on mount, shows its `intro`, and enables the button only after it resolves; `act(token, data)` receives it.
  - `DeviceRow({ api, status })`
  - `Home` reads `people=1..5` from the address.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/pages.test.tsx` (it already has `visit`, `fakeApi`, `afterEach` cleanup):

```ts
const sharedMock = vi.hoisted(() => ({ reconcile: vi.fn(), turnOff: vi.fn(), readState: vi.fn(), credentialHash: vi.fn(async () => 'h'.repeat(43)) }));
vi.mock('../src/notify/shared.js', () => sharedMock);
vi.mock('../src/notify/worker.ts', () => ({ registration: async () => ({ pushManager: { getSubscription: async () => null } }), readyWorker: async () => null, register: () => {}, workerFailed: () => false }));
vi.mock('../src/notify/push.ts', () => ({ pushEnv: () => ({}), postToApi: vi.fn(), enablePush: vi.fn(), PUSH_CHANGED: 'pengepassportph-push-changed' }));

const NO_CREDENTIAL = { credential: null, confirmed: false, askedAt: null, revision: 0, fingerprint: null, applicationServerKey: null };
beforeEach(() => {
  for (const f of Object.values(sharedMock)) f.mockReset();
  sharedMock.credentialHash.mockResolvedValue('h'.repeat(43));
  sharedMock.readState.mockResolvedValue(NO_CREDENTIAL);
});
const CONFIRMED = { credential: 'c'.repeat(43), confirmed: true, askedAt: 0, revision: 1, fingerprint: 'f', applicationServerKey: 'B'.repeat(87) };
const LIVE = { ...STATUS, push: 'live' as const, vapidPublicKey: 'B'.repeat(87) };

describe('confirming with channels', () => {
  const token = 't'.repeat(43);
  const preview = { siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', pushCredentialHash: 'h'.repeat(43), devicesKept: 0 } };
  beforeEach(() => sharedMock.readState.mockResolvedValue(NO_CREDENTIAL));

  it('shows the channels before the confirm button and sends the acknowledgement', async () => {
    visit(`/confirm#token=${token}`);
    const api = fakeApi({ previewConfirm: vi.fn(async () => preview) });
    render(<App path="/confirm" api={api} />);
    expect(await screen.findByText(/Email: off/)).toBeTruthy();
    expect(screen.getByText(/Notifications: on, for the device and browser that asked \(Chrome on Android/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm alert' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(token, { emailOn: false, pushOn: true }));
  });

  it('keeps the button off until the preview has loaded', async () => {
    visit(`/confirm#token=${token}`);
    render(<App path="/confirm" api={fakeApi({ previewConfirm: vi.fn(() => new Promise(() => {})) })} />);
    expect((await screen.findByRole('button', { name: /Confirm alert|Loading/ })).hasAttribute('disabled')).toBe(true);
  });

  it('shows the out-of-date message on 409 reload', async () => {
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => { throw new ApiFailure('This page is out of date. Reload it, then open the confirmation link from your email again.', 409); }),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/open the confirmation link from your email again/)).toBeTruthy();
  });

  it('registers this device right after confirming in the browser that asked', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'c'.repeat(43), askedAt: Date.now() });
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    vi.stubGlobal('Notification', { permission: 'granted' });
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'bound' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/Notifications are on for this device/)).toBeTruthy();
    expect(sharedMock.reconcile).toHaveBeenCalled();
  });

  it('does not say notifications are on without permission or a browser subscription', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'c'.repeat(43), askedAt: Date.now() });
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: false });
    vi.stubGlobal('Notification', { permission: 'default' });
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'kept' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/almost ready on this device/)).toBeTruthy();
    expect(screen.queryByText('Notifications are on for this device.')).toBeNull();
  });

  it('keeps the confirmation when registering this browser fails', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'c'.repeat(43), askedAt: Date.now() });
    sharedMock.reconcile.mockRejectedValue(new Error('network'));
    vi.stubGlobal('Notification', { permission: 'granted' });
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'bound' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText('You are subscribed')).toBeTruthy();
    expect(screen.getByText(/could not be set up on this device yet/)).toBeTruthy();
  });

  it('does not register a different local credential, and says where notifications are on', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'x'.repeat(43), askedAt: Date.now() });
    sharedMock.credentialHash.mockResolvedValueOnce('z'.repeat(43));
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'bound' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/Notifications are on for the device where you asked for them/)).toBeTruthy();
    expect(sharedMock.reconcile).not.toHaveBeenCalled();
  });
});

describe('an old confirmation page left open across the deploy', () => {
  it('shows the server message on its token-only confirm, then the new page confirms the reopened link', async () => {
    const token = 't'.repeat(43);
    const preview = { siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', pushCredentialHash: 'h'.repeat(43), devicesKept: 0 } };
    // A stand-in for the server: the old page posts { token } only and gets 409 reload, as Task 6 tests on the real server.
    const server = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { acknowledge?: unknown };
      if (url.endsWith('/api/confirm/preview')) return new Response(JSON.stringify(preview), { status: 200 });
      if (!body.acknowledge) return new Response(JSON.stringify({ error: 'This page is out of date. Reload it, then open the confirmation link from your email again.', code: 'reload' }), { status: 409 });
      return new Response(JSON.stringify({ status: 'confirmed', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, push: 'bound' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', server);
    visit(`/confirm#token=${token}`);
    const { Confirm: OldConfirm } = await import('./fixtures/v0.2/Confirm.tsx');
    const old = render(<OldConfirm api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm email alert' }));
    expect(await screen.findByText(/open the confirmation link from your email again/)).toBeTruthy();
    old.unmount();
    // The person reopens the link from the email: the new page.
    visit(`/confirm#token=${token}`);
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText('You are subscribed')).toBeTruthy();
  });
});

describe('the notifications row', () => {
  beforeEach(() => visit('/'));

  it.each([
    [{ state: 'registered' }, 'granted', /Notifications on this device: On/],
    [{ state: 'pending' }, 'granted', /Waiting for you to confirm by email/],
    [{ state: 'registered' }, 'denied', /Notifications are blocked on this device/],
    [{ state: 'missing' }, 'granted', /Notifications are off for this device/],
  ])('shows %o with permission %s', async (answer, permission, text) => {
    vi.stubGlobal('Notification', { permission });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ ...answer, subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('turns the device off from the row, and warns when nothing is left', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    sharedMock.turnOff.mockResolvedValue({ ok: true, noChannel: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText(/You will get no alerts now/)).toBeTruthy();
    expect(screen.queryByText(/Notifications on this device: On/)).toBeNull();
  });

  it('still offers Turn off while push is switched off on the server', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => ({ ...LIVE, push: 'off' as const, vapidPublicKey: null }) })} />);
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('shows blocked, with Turn off, for an awaiting device whose permission was revoked', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'awaiting', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/Notifications are blocked on this device/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('shows blocked after permission is revoked in settings and the page comes back', async () => {
    const perm = { permission: 'granted' as NotificationPermission };
    vi.stubGlobal('Notification', perm);
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/Notifications on this device: On/)).toBeTruthy();
    perm.permission = 'denied'; // turned off in Android settings, away from the page
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByText(/Notifications are blocked on this device/)).toBeTruthy();
  });

  it('takes the sheet\'s answer without asking the server again', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'pending', subscribed: false });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/Waiting for you to confirm by email/)).toBeTruthy();
    const calls = sharedMock.reconcile.mock.calls.length;
    act(() => void window.dispatchEvent(new CustomEvent('pengepassportph-push-changed', { detail: { state: 'registered', subscribed: true } })));
    expect(await screen.findByText(/Notifications on this device: On/)).toBeTruthy();
    expect(sharedMock.reconcile.mock.calls.length).toBe(calls);
  });

  it('appears when push is turned on later, without reloading the page', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(NO_CREDENTIAL);
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    await screen.findByText(/DFA offices in the Philippines/);
    expect(screen.queryByText(/Waiting for you to confirm/)).toBeNull();
    sharedMock.readState.mockResolvedValue({ ...CONFIRMED, confirmed: false });
    sharedMock.reconcile.mockResolvedValue({ state: 'pending', subscribed: false });
    act(() => void window.dispatchEvent(new Event('pengepassportph-push-changed')));
    expect(await screen.findByText(/Waiting for you to confirm by email/)).toBeTruthy();
  });

  it('does not say On without permission or a browser subscription', async () => {
    vi.stubGlobal('Notification', { permission: 'default' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: false });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/not allowed on this device yet/)).toBeTruthy();
    expect(screen.queryByText(/: On/)).toBeNull();
  });

  it('does not call an unresolved device On', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'stale', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/need setting up again/)).toBeTruthy();
    expect(screen.queryByText(/: On/)).toBeNull();
  });

  it('shows nothing when this browser never turned push on', async () => {
    sharedMock.readState.mockResolvedValue(NO_CREDENTIAL);
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    await screen.findByText(/DFA offices in the Philippines/);
    expect(screen.queryByText(/Notifications/)).toBeNull();
  });
});

it('opens an office for a group from ?people=', async () => {
  visit('/?office=486&date=2026-10-09&people=2');
  const api = fakeApi();
  render(<App path="/" api={api} />);
  expect(await screen.findByRole('heading', { name: 'Antipolo' })).toBeTruthy();
  await waitFor(() => expect(api.officeDates).toHaveBeenCalledWith(486, 2));
  expect((screen.getByLabelText('Booking for') as HTMLSelectElement).value).toBe('2');
});
```

The existing confirm-page tests change: their button name from "Confirm email alert" to "Confirm alert"; every click on it waits for the preview first, with `fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }))` (the button reads "Loading…" and is disabled until then); and their `fake.confirm` expectation becomes `toHaveBeenCalledWith(token, undefined)` for a request without channels (the default preview answers `channels: null`).

The old page is the real one from the release before push, with its imports pointed at today's modules (only `api.ts` changed, and only by adding):

```bash
mkdir -p apps/web/test/fixtures/v0.2
for f in pages/Confirm.tsx components/TokenAction.tsx; do
  { echo '// @ts-nocheck'; echo '// From 157bad9 (the release before push).'; \
    git show 157bad9:apps/web/src/$f | sed -e "s#from '\.\./components/TokenAction\.tsx'#from './TokenAction.tsx'#" -e "s#from '\.\./#from '../../../src/#"; \
  } > apps/web/test/fixtures/v0.2/$(basename $f)
done
```

(`apps/web/tsconfig.json` gains `"exclude": ["test/fixtures"]` if `tsc` still checks them.)

- [ ] **Step 2: Run them to see them fail** → FAIL.

- [ ] **Step 3: Implement**

`TokenAction.tsx`: `Props` gains `prepare?` and `act(token, data)`. In `TokenActionBody`:

```tsx
  const [prepared, setPrepared] = useState<{ intro: ReactNode; data: unknown } | null>(null);
  useEffect(() => {
    if (!prepare || !token || !isValid(token)) return;
    let live = true;
    prepare(token).then(
      (p) => live && setPrepared(p),
      (err) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [token]);
  const waiting = !!prepare && !prepared;
```

The intro shown is `prepared?.intro ?? intro`; the button is `disabled={busy || waiting}` and reads `waiting ? 'Loading…' : button`; `go()` calls `act(token!, prepared?.data)`. It keeps removing the token from the address bar after reading it.

`Confirm.tsx`:

```tsx
export function Confirm({ api }: { api: Api }) {
  return (
    <TokenAction
      title="Confirm your alert"
      intro={<p>Loading what this link will do…</p>}
      button="Confirm alert"
      isValid={isToken}
      prepare={async (token) => {
        const p = await api.previewConfirm(token);
        const c = p.channels;
        return {
          data: p,
          intro: (
            <>
              <p>
                This turns on alerts for {plural(p.siteIds.length, 'office')}, for {p.applicants === 1 ? 'one person' : `${p.applicants} people`},{' '}
                {p.pace === 'asap' ? 'as soon as a check finds dates' : 'at most once an hour'}.
              </p>
              {c && (
                <ul className="channels-preview">
                  <li>Email: {c.emailOn ? 'on' : 'off'}</li>
                  <li>
                    Notifications: {c.pushOn ? `on, for the device and browser that asked (${c.device ?? 'a browser'}, ${manilaWhen(c.requestedAt)})` : 'none added by this request'}
                  </li>
                  {c.devicesKept > 0 && <li>{c.devicesKept === 1 ? 'The 1 device that already gets notifications keeps them.' : `The ${c.devicesKept} devices that already get notifications keep them.`}</li>}
                </ul>
              )}
              <p className="hint">If you did not ask for this, close this page: nothing changes.</p>
            </>
          ),
        };
      }}
      act={async (token, data) => {
        const p = data as ConfirmPreview;
        const ack = p.channels ? { emailOn: p.channels.emailOn, pushOn: p.channels.pushOn } : undefined;
        const r = await api.confirm(token, ack);
        // The confirmation has succeeded whatever happens below: registering this
        // browser is a second step, and its trouble is shown, not thrown.
        let here: 'on' | 'waiting' | 'blocked' | 'retry' | 'elsewhere' | null = null;
        if (r.channels.push === 'bound' || r.channels.push === 'kept') {
          try {
            const env = pushEnv();
            const state = await readState(env);
            const mine = state.credential && p.channels?.pushCredentialHash && (await credentialHash(env, state.credential)) === p.channels.pushCredentialHash;
            if (!mine) here = 'elsewhere';
            else if (Notification.permission === 'denied') here = 'blocked';
            else {
              const reg = await registration();
              const answer = reg ? await reconcile(env, { registration: reg, post: postToApi, permission: Notification.permission }) : null;
              const ready = answer?.state === 'registered' && answer.subscribed && Notification.permission === 'granted';
              here = ready ? 'on' : answer?.state === 'registered' || answer?.state === 'awaiting' || answer?.state === 'pending' ? 'waiting' : 'retry';
            }
          } catch {
            here = 'retry';
          }
        }
        return (
          <>
            <CheckIcon />
            <h1>{r.status === 'updated' ? 'Your alert is updated' : 'You are subscribed'}</h1>
            <p>
              {r.channels.emailOn ? 'We will email you' : 'We will tell you'} when a date opens at {plural(r.siteIds.length, 'office')}, for{' '}
              {r.applicants === 1 ? 'one person' : `${r.applicants} people`}, {r.pace === 'asap' ? 'as soon as a check finds dates' : 'at most once an hour'}.
            </p>
            {here === 'on' && <p>Notifications are on for this device.</p>}
            {here === 'waiting' && <p>Notifications are almost ready on this device. Keep the app open for a moment, or open it again later.</p>}
            {here === 'blocked' && <p>Notifications are blocked on this device. Allow them in your browser or phone settings, then open the app again.</p>}
            {here === 'retry' && <p>Notifications could not be set up on this device yet. Open the app again in a moment to finish.</p>}
            {here === 'elsewhere' && <p>Notifications are on for the device where you asked for them. Open the app there once to finish.</p>}
            {r.channels.push.startsWith('skipped') && <p className="hint">Notifications were not turned on: {SKIPPED[r.channels.push]}</p>}
            <p>
              <a className="btn btn-secondary" href={BASE}>See open dates now</a>
            </p>
            <p><a href={`${BASE}delete-data`}>Stop alerts and delete your data</a></p>
          </>
        );
      }}
    />
  );
}

const SKIPPED: Record<string, string> = {
  'skipped-owned': 'that device already gets alerts for another email address.',
  'skipped-revoked': 'they were turned off on that device. Fill in the form again to turn them back on.',
  'skipped-off': 'they are not available right now.',
};

/** The same Manila time as the confirmation email: "Mon 5 Oct, 10:02". */
function manilaWhen(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  return `${formatDate(d.toISOString().slice(0, 10)).replace(/ \d{4}$/, '')}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
```

`DeviceRow.tsx`:

```tsx
// "Notifications on this device", for a browser that turned push on: its state
// as the server and the browser see it now, a test, and a way to turn it off.
import type { DeviceState, StatusResponse } from '@penge/contracts';
import { useEffect, useState } from 'react';
import { type Api, errorText } from '../api.ts';
import { PUSH_CHANGED, pushEnv, postToApi } from '../notify/push.ts';
import { readState, reconcile, turnOff } from '../notify/shared.js';
import { registration } from '../notify/worker.ts';

type Shown = { kind: 'none' } | { kind: 'state'; state: DeviceState; blocked: boolean; ready: boolean } | { kind: 'off'; noChannel: boolean };

export function DeviceRow({ api, status }: { api: Api; status: StatusResponse }) {
  const [shown, setShown] = useState<Shown>({ kind: 'none' });
  const [note, setNote] = useState<string | null>(null);
  // Runs whatever the push mode: with push switched off for an emergency, a device
  // that has it on must still be able to see that and turn it off.
  useEffect(() => {
    if (!('Notification' in window)) return;
    let live = true;
    const refresh = async () => {
      const env = pushEnv();
      if (!(await readState(env)).credential) return;
      const reg = await registration();
      if (!reg) return;
      const answer = await reconcile(env, { registration: reg, post: postToApi, permission: Notification.permission });
      if (live && answer) {
        setShown({ kind: 'state', state: answer.state, blocked: Notification.permission === 'denied', ready: Notification.permission === 'granted' && answer.subscribed });
      }
    };
    const run = () => void refresh().catch(() => undefined);
    run();
    // Again when the sheet or the confirmation page changes this browser's push state. The
    // sheet sends what it just learned, so the row takes it without asking the server again
    // (the sheet and the row together stay at two calls a minute, within the device limit).
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ state: DeviceState; subscribed: boolean } | undefined>).detail;
      if (detail && live) setShown({ kind: 'state', state: detail.state, blocked: Notification.permission === 'denied', ready: Notification.permission === 'granted' && detail.subscribed });
      else run();
    };
    window.addEventListener(PUSH_CHANGED, onChange);
    // Back from the browser's or the phone's settings: look again (permission may have changed).
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', run);
    let permission: PermissionStatus | null = null;
    void navigator.permissions?.query({ name: 'notifications' as PermissionName }).then(
      (p) => {
        permission = p;
        p.addEventListener('change', run);
      },
      () => undefined,
    );
    const timer = setInterval(() => {
      if (live) setShown((now) => (now.kind === 'state' && (now.state === 'pending' || now.state === 'awaiting') ? (run(), now) : now));
    }, 30_000);
    return () => {
      live = false;
      window.removeEventListener(PUSH_CHANGED, onChange);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', run);
      permission?.removeEventListener('change', run);
      clearInterval(timer);
    };
  }, []);

  async function off() {
    const reg = await registration();
    if (!reg) return;
    const answer = await turnOff(pushEnv(), { registration: reg, post: postToApi });
    setShown({ kind: 'off', noChannel: !!answer?.noChannel });
  }
  async function test() {
    setNote(null);
    try {
      const { credential } = await readState(pushEnv());
      if (credential) await api.pushTest(credential);
      setNote('Sent. It should arrive in a few seconds.');
    } catch (err) {
      setNote(errorText(err));
    }
  }

  if (shown.kind === 'none') return null;
  if (shown.kind === 'off') {
    return (
      <p className="device-row" role="status">
        Notifications are off for this device.{shown.noChannel && ' You will get no alerts now: fill in the alert form to choose email or notifications again.'}
      </p>
    );
  }
  if (shown.state === 'missing') {
    return <p className="device-row">Notifications are off for this device. Fill in the alert form to turn them on again.</p>;
  }
  if (shown.blocked) {
    return (
      <div className="device-row">
        <span>Notifications are blocked on this device.</span>
        <button type="button" className="link-button" onClick={off}>
          Turn off
        </button>
      </div>
    );
  }
  if (shown.state === 'pending' || shown.state === 'awaiting') {
    return (
      <div className="device-row">
        <span>Waiting for you to confirm by email.</span>
        <button type="button" className="link-button" onClick={off}>
          Cancel
        </button>
      </div>
    );
  }
  if (shown.state === 'registered' && !shown.ready) {
    return (
      <div className="device-row">
        <span>Notifications are not allowed on this device yet. Allow them in your browser or phone settings.</span>
        <button type="button" className="link-button" onClick={off}>
          Turn off
        </button>
      </div>
    );
  }
  if (shown.state === 'stale' || shown.state === 'endpoint-taken') {
    return (
      <div className="device-row">
        <span>Notifications need setting up again on this device.</span>
        <button type="button" className="link-button" onClick={off}>
          Turn off
        </button>
      </div>
    );
  }
  return (
    <div className="device-row">
      <span>Notifications on this device: On</span>
      <button type="button" className="link-button" onClick={test}>
        Send a test
      </button>
      <button type="button" className="link-button" onClick={off}>
        Turn off
      </button>
      {note && <p className="hint">{note}</p>}
    </div>
  );
}
```

`Home.tsx`: the group size from a link is read on its own, so the route state (`{ office, date, scope }`, which `setRoute` builds in several places) keeps its type:

```ts
/** ?people=2 from a notification's link: the group size to open the office with. */
function readPeople(): number | null {
  const n = Number(new URLSearchParams(window.location.search).get('people'));
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}
```

and `useState(1)` for `applicants` becomes `useState(() => readPeople() ?? 1)`. `<DeviceRow api={api} status={status} />` is rendered under the summary when `status` is loaded.

- [ ] **Step 4: Run all web tests, the typecheck and a production build** → PASS.

- [ ] **Step 5: Codex pass, then commit** (`Confirmation preview, the notifications row, and group size in links`).

---

## Phase D: local stack and verification

### Task 16: The local stack

**Files:**
- Create: `apps/server/dev/capture-mailer.ts`, `apps/server/dev/fake-upstream.ts`, `apps/server/dev/local.ts`, `apps/server/dev/alert.ts`, `apps/server/dev/build.mjs`, `apps/server/dev/https-proxy.mjs`, `apps/server/dev/README.md`, `scripts/local-stack.sh`
- Modify: `apps/server/package.json` (scripts `dev:build`, `dev:local`, `dev:alert`), `apps/web/vite.config.ts`, `deploy/release.sh` (one line), `.gitignore` (`.local/`, `android/out-dev/`, `android/project-dev/`)
- Test: `apps/server/test/local-stack.test.ts`

**Interfaces:**
- Consumes: `createApi` (Task 6), `runCheck` (Task 8), `webPushTransport` (Task 7), `MemoryKv`, `connectRedis`.
- Produces:
  - `buildLocal(o: { kvUrl: string | null; dir: string }): Promise<{ app; kv; mailer: CaptureMailer; deps: CheckDeps; upstream: FakeDfa; close(): Promise<void> }>`
  - `class CaptureMailer implements Mailer { mode: 'live'; captured: Mail[] }` (writes each email to `<dir>/mail/NNN-<kind>.txt`; never opens a socket)
  - `class FakeDfa implements Upstream { open: Map<number, string[]> }` (a small office catalog, no network)
  - Commands: `npm run dev:local -w @penge/server` (API on `127.0.0.1:8787`), `npm run dev:alert -w @penge/server -- --office 486 --date 2026-10-09` (one real checker run that opens that date), `scripts/local-stack.sh up|down`

Rules: never reads `.secrets/` (it builds its own config); no R2 (a no-op sink); no DFA (the fake, which also answers the lookups for group dates and hours); keys, VAPID keys and a TLS certificate live in the repository's `.local/` (ignored by git), passed as an absolute path; it only connects to `127.0.0.1:6391`, and only once `scripts/local-stack.sh` has marked that Valkey disposable (`pp:test:disposable`); it never marks a database itself.

- [ ] **Step 1: Write the failing test**

`apps/server/test/local-stack.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLocal } from '../dev/local.ts';

describe('the local stack', () => {
  it('never builds the DFA client, and has no R2', async () => {
    for (const file of ['local.ts', 'alert.ts', 'fake-upstream.ts']) {
      const source = readFileSync(join(__dirname, '../dev', file), 'utf8');
      // No DFA client and no R2 client is made (the lookups factory is fine: it gets the fake).
      expect(source).not.toMatch(/new PengePassportPH|r2Sink\(|requireR2\(/);
    }
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    expect(stack.deps.sink.putObject).toBeUndefined();
    expect(stack.deps.upstream.constructor.name).toBe('FakeDfa');
    await stack.close();
  });

  it('does not read .secrets or server.env', () => {
    for (const file of ['local.ts', 'alert.ts', 'capture-mailer.ts', 'fake-upstream.ts']) {
      // A path in a string, not a word in a comment.
      expect(readFileSync(join(__dirname, '../dev', file), 'utf8')).not.toMatch(/['"`][^'"`\n]*(\.secrets|server\.env)/);
    }
  });

  it('refuses any Valkey but the marked local one', async () => {
    await expect(buildLocal({ kvUrl: 'redis://db.example.com:6379', dir: mkdtempSync(join(tmpdir(), 'penge-local-')) })).rejects.toThrow(/only uses the throwaway Valkey/);
    await expect(buildLocal({ kvUrl: 'redis://127.0.0.1:6379', dir: mkdtempSync(join(tmpdir(), 'penge-local-')) })).rejects.toThrow(/only uses the throwaway Valkey/);
  });

  it('answers group dates and hours from the fake DFA', async () => {
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    const day = stack.upstream.published()[0]!;
    stack.upstream.open.set(486, [day]);
    const ua = { headers: { 'user-agent': 'Mozilla/5.0 Chrome/141' } };
    const dates = await stack.app.request('/api/offices/486/dates?applicants=2', ua);
    expect(dates.status).toBe(200);
    expect(((await dates.json()) as { openDates: string[] }).openDates).toEqual([day]);
    const times = await stack.app.request(`/api/offices/486/times?date=${day}&applicants=1`, ua);
    expect(times.status).toBe(200);
    expect(((await times.json()) as { slots: { available: boolean }[] }).slots[0]!.available).toBe(true);
    await stack.close();
  });

  it('opens a date for the running API through its local-only route, past a cached closed answer, every time', async () => {
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    const day = stack.upstream.published()[1]!;
    const ua = { headers: { 'user-agent': 'Mozilla/5.0 Chrome/141' } };
    // A visitor looked first: the closed answer is cached.
    expect(((await (await stack.app.request('/api/offices/486/dates?applicants=1', ua)).json()) as { openDates: string[] }).openDates).toEqual([]);
    const open = () => stack.devApp.request('/dev/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ office: 486, date: day }) });
    expect((await open()).status).toBe(200);
    expect(((await (await stack.app.request('/api/offices/486/dates?applicants=1', ua)).json()) as { openDates: string[] }).openDates).toEqual([day]);
    // A second trigger for the same date is a fresh opening again.
    const second = (await (await open()).json()) as { delivery: { push: unknown } | null };
    expect(second.delivery).not.toBeNull();
    await stack.close();
  });

  it('captures a confirmation email with its link instead of sending it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'penge-local-'));
    const stack = await buildLocal({ kvUrl: null, dir });
    const res = await stack.app.request('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/141' },
      body: JSON.stringify({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: false } }),
    });
    expect(res.status).toBe(202);
    expect(stack.mailer.captured.at(-1)!.text).toMatch(/\/confirm#token=/);
    expect(readdirSync(join(dir, 'mail'))).toEqual(['001-confirm.txt']);
    await stack.close();
  });

  it('runs the real checker against the fake DFA and alerts by email', async () => {
    const stack = await buildLocal({ kvUrl: null, dir: mkdtempSync(join(tmpdir(), 'penge-local-')) });
    const sub = await stack.app.request('/api/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/141' },
      body: JSON.stringify({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: true, pushOn: false } }),
    });
    expect(sub.status).toBe(202);
    const token = /#token=([A-Za-z0-9_-]{43})/.exec(stack.mailer.captured.at(-1)!.text)![1];
    await stack.app.request('/api/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, acknowledge: { emailOn: true, pushOn: false } }) });
    stack.upstream.open.set(486, ['2026-10-09']);
    await stack.runOnce();
    expect(stack.mailer.captured.at(-1)!.kind).toBe('alert');
    await stack.close();
  });
});
```

(`buildLocal` with `kvUrl: null` uses `MemoryKv`, so the test needs no Docker. It runs one baseline checker run while building, so the office list exists and a later opening is news.)

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w @penge/server -- test/local-stack.test.ts`
Expected: FAIL (`dev/local.ts` missing).

- [ ] **Step 3: Implement**

`dev/capture-mailer.ts`:

```ts
// The local stack's mailer: keeps every email, and writes each to a file with
// its links, instead of sending it. It says it is live, so sign-up works.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mail, Mailer, SendResult } from '../src/mailer.ts';

export class CaptureMailer implements Mailer {
  readonly mode = 'live' as const;
  readonly captured: Mail[] = [];
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = join(dir, 'mail');
  }
  async send(mail: Mail): Promise<SendResult> {
    this.captured.push(mail);
    mkdirSync(this.dir, { recursive: true });
    const n = String(this.captured.length).padStart(3, '0');
    writeFileSync(join(this.dir, `${n}-${mail.kind}.txt`), `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`);
    return 'sent';
  }
  close() {}
}
```

`dev/fake-upstream.ts`:

```ts
// A pretend passport.gov.ph for the local stack: three offices, four published
// days, and whatever dates the alert script opens. No network.
import type { Availability, Site, TimeSlot } from 'penge-passport-ph';
import type { Upstream } from '../src/checker.ts';
import type { LookupUpstream } from '../src/lookups.ts';

const SITES: Site[] = [
  { id: 486, name: 'Antipolo (SM Center, Antipolo City, Rizal)' },
  { id: 693, name: 'Baguio (SM City Baguio)' },
  { id: 20, name: 'Cebu (ROBINSONS GALLERIA , CEBU CITY )' },
].map((s) => ({ ...s, description: null, address: null, telephone: null, hours: null, mapUrl: null, utcOffsetMinutes: 480 }));

export class FakeDfa implements Upstream, LookupUpstream {
  readonly open = new Map<number, string[]>();
  published(): string[] {
    const today = Date.now();
    return [3, 4, 7, 8].map((d) => new Date(today + d * 86_400_000).toISOString().slice(0, 10));
  }
  async sites() {
    return SITES;
  }
  async availability({ siteId, applicants }: { siteId: number; applicants: number }): Promise<Availability> {
    const published = [...new Set([...this.published(), ...(this.open.get(siteId) ?? [])])].sort();
    const open = this.open.get(siteId) ?? [];
    return {
      siteId, applicants, from: published[0]!, to: published.at(-1)!, earliest: open[0] ?? null, availableDates: open,
      days: published.map((date) => ({ date, available: open.includes(date) })), fetchedAt: new Date().toISOString(), cached: false,
    };
  }
  /** Two hours each open day: the morning with room, the afternoon full. */
  async timeSlots({ siteId, date }: { siteId: number; date: string; applicants: number }): Promise<TimeSlot[]> {
    const open = (this.open.get(siteId) ?? []).includes(date);
    return [
      { start: '08:00', end: '09:00', available: open, remaining: open ? 2 : 0, status: open ? 'Available Slots: 2' : 'Fully Booked', note: null },
      { start: '13:00', end: '14:00', available: false, remaining: 0, status: 'Fully Booked', note: null },
    ];
  }
  async warmSession() {
    return true;
  }
}
```

`dev/local.ts`:

```ts
// The local push test stack's server: the real API and the real checker, with a
// throwaway Valkey (or MemoryKv), a capturing mailer, a fake DFA and no R2.
// It never reads .secrets/: its keys live in the directory it is given.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import webpush from 'web-push';
import { createApi } from '../src/api.ts';
import { type CheckDeps, runCheck } from '../src/checker.ts';
import type { PushConfig } from '../src/config.ts';
import { K } from '../src/keys.ts';
import { connectRedis, type Kv, MemoryKv, type WriteOp } from '../src/kv.ts';
import { log } from '../src/log.ts';
import { createLookups } from '../src/lookups.ts';
import { webPushTransport } from '../src/push/sender.ts';
import type { SnapshotSink } from '../src/r2.ts';
import { CaptureMailer } from './capture-mailer.ts';
import { FakeDfa } from './fake-upstream.ts';

const BASE = 'http://localhost:4173/pengepassportph';

function secrets(dir: string) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'secrets.json');
  if (!existsSync(file)) {
    const vapid = webpush.generateVAPIDKeys();
    const b = () => randomBytes(32).toString('base64');
    writeFileSync(file, JSON.stringify({ email: b(), index: b(), token: b(), vapid }, null, 2), { mode: 0o600 });
  }
  const s = JSON.parse(readFileSync(file, 'utf8')) as { email: string; index: string; token: string; vapid: { publicKey: string; privateKey: string } };
  return {
    keys: { email: Buffer.from(s.email, 'base64'), index: Buffer.from(s.index, 'base64'), token: Buffer.from(s.token, 'base64') },
    vapid: { ...s.vapid, subject: 'mailto:alerts@example.com' },
  };
}

/** Records go nowhere: the local stack has no R2. */
const noSink: SnapshotSink = { store: async () => 'uploaded' };

/** Only the throwaway Valkey that scripts/local-stack.sh starts, and only once it is marked disposable. */
async function localKv(url: string): Promise<Kv> {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '6391' || u.username || u.password) {
    throw new Error('the local stack only uses the throwaway Valkey on 127.0.0.1:6391');
  }
  const kv = await connectRedis(url, (err) => log.error('redis', { err }));
  if ((await kv.get(K.pushTestMark)) !== '1') {
    await kv.close();
    throw new Error('that Valkey is not marked disposable (scripts/local-stack.sh marks it); refusing to use it');
  }
  return kv;
}

export async function buildLocal(o: { kvUrl: string | null; dir: string }) {
  const kv: Kv = o.kvUrl ? await localKv(o.kvUrl) : new MemoryKv();
  const { keys, vapid } = secrets(o.dir);
  const mailer = new CaptureMailer(o.dir);
  const upstream = new FakeDfa();
  const push: PushConfig = { mode: 'live', vapid, ownerEmails: [] };
  const transport = webPushTransport(vapid);
  // Lookups (group dates, hours) answered by the fake DFA: no network here either.
  const lookups = createLookups({ kv, upstream, log });
  const app = createApi({
    kv, keys, mailer, log, publicBaseUrl: BASE, push, pushTransport: transport, lookups,
    // With MemoryKv the API is called in-process (tests): there is no socket to read an address from.
    ...(o.kvUrl ? {} : { clientIp: () => '127.0.0.1' }),
  });
  const deps: CheckDeps = {
    kv, upstream, sink: noSink, mailer, keys, log, publicBaseUrl: BASE,
    mailDailyLimit: 2500, alertsPerSubscriberPerDay: 288, client: 'penge-local', push: { mode: 'live', transport },
  };
  let n = 0;
  const runOnce = () => runCheck({ ...deps, runId: `local${++n}-${Date.now()}` });
  await runOnce(); // the office list and a baseline

  // A local-only route, never part of the production API: opens a date in this
  // process's fake DFA (the one the API's lookups read too) and runs the checker.
  const devApp = new Hono();
  devApp.post('/dev/open', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { office?: unknown; date?: unknown } | null;
    const office = Number(body?.office);
    const date = String(body?.date ?? '');
    if (!Number.isSafeInteger(office) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'office and date' }, 400);
    // A fresh opening every time: first a run that sees the date closed, then one that sees it
    // open; a date is announced once in 3 hours, so forget an earlier announcement of it.
    // Cached lookups for the office (group dates, hours) go too, so a tap sees the date open.
    const clear = async () => {
      const ops: WriteOp[] = [];
      for (let applicants = 1; applicants <= 5; applicants++) {
        ops.push({ op: 'del', key: K.announced(office, applicants, date) }, { op: 'del', key: K.lookup(`dates:${office}:${applicants}`) }, { op: 'del', key: K.lookup(`times:${office}:${date}:${applicants}`) });
      }
      await kv.write(ops);
    };
    upstream.open.set(office, (upstream.open.get(office) ?? []).filter((d) => d !== date));
    await runOnce();
    await clear();
    upstream.open.set(office, [...(upstream.open.get(office) ?? []), date]);
    const report = await runOnce();
    await clear();
    return c.json({ delivery: report.delivery });
  });
  devApp.route('/', app);
  return { app, devApp, kv, mailer, deps, upstream, runOnce, close: () => kv.close() };
}

/** The repository's .local/, wherever npm runs this from (INIT_CWD is where npm was started). */
export const localDir = () => process.env.PENGE_LOCAL_DIR ?? resolve(process.env.INIT_CWD ?? process.cwd(), '.local');

if (process.argv[1]?.endsWith('local.mjs')) {
  const stack = await buildLocal({ kvUrl: process.env.PENGE_LOCAL_KV ?? 'redis://127.0.0.1:6391', dir: localDir() });
  serve({ fetch: stack.devApp.fetch, hostname: '127.0.0.1', port: 8787 }, () => log.info('local api on 127.0.0.1:8787'));
}
```

`dev/alert.ts` (asks the running local API to open a date, so the API's own fake DFA and the checker see the same thing):

```ts
// npm run dev:alert -w @penge/server -- --office 486 --date 2026-10-09
// Opens that date at that office in the running local stack's fake DFA, and has it
// run the real checker once, so subscribers there get a real alert and a tap on the
// notification finds the date open.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { office: { type: 'string' }, date: { type: 'string' } } });
const res = await fetch('http://127.0.0.1:8787/dev/open', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ office: Number(values.office), date: values.date }),
});
process.stderr.write(`${res.status} ${await res.text()}\n`);
process.exitCode = res.ok ? 0 : 1;
```

`dev/build.mjs` (the same bundling as `build.mjs`, for the two dev entries, into `.local/dist/`):

```js
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: { local: 'dev/local.ts', alert: 'dev/alert.ts' },
  outdir: '../../.local/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
```

`apps/server/package.json` scripts:

```json
    "dev:build": "node dev/build.mjs",
    "dev:local": "node dev/build.mjs && node ../../.local/dist/local.mjs",
    "dev:alert": "node dev/build.mjs && node ../../.local/dist/alert.mjs"
```

`dev/https-proxy.mjs` (local HTTPS on 8443 for the Android debug app; everything goes to `vite preview`, which proxies the API):

```js
// Local HTTPS for the debug Android app (it only opens https://). A self-signed
// certificate for localhost, made by scripts/local-stack.sh, kept in .local/tls/.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const tls = { key: readFileSync('.local/tls/key.pem'), cert: readFileSync('.local/tls/cert.pem') };
createServer(tls, (req, res) => {
  const upstream = request({ host: '127.0.0.1', port: 4173, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost:4173' } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502);
    res.end('the local site is not running');
  });
  req.pipe(upstream);
}).listen(8443, '127.0.0.1', () => console.log('https://localhost:8443/pengepassportph/'));
```

`apps/web/vite.config.ts`: one proxy for both `vite dev` and `vite preview`, and a refusal of a release build with the debug flag:

```ts
const apiProxy = { [`${base}api`]: { target: 'http://127.0.0.1:8787', rewrite: (p: string) => p.slice(base.length - 1) } };
// …in defineConfig:
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
```

and:

```ts
if (process.env.RELEASE === '1' && process.env.VITE_LOCAL_DEBUG === '1') {
  throw new Error('VITE_LOCAL_DEBUG must not be set for a release build');
}
```

`deploy/release.sh`: its web build line gets `RELEASE=1` in front.

`scripts/local-stack.sh`:

```sh
#!/bin/sh
# The local push test stack: never touches .secrets/, R2, the DFA or the server.
#   scripts/local-stack.sh up | down
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
up)
  mkdir -p .local/tls .local/mail
  docker run -d --rm --name penge-local-valkey -p 127.0.0.1:6391:6379 valkey/valkey:8 >/dev/null
  until docker exec penge-local-valkey valkey-cli PING >/dev/null 2>&1; do sleep 0.2; done
  docker exec penge-local-valkey valkey-cli SET pp:test:disposable 1 >/dev/null
  [ -f .local/tls/cert.pem ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
    -subj /CN=localhost -addext subjectAltName=DNS:localhost -keyout .local/tls/key.pem -out .local/tls/cert.pem 2>/dev/null
  BASE_PATH=pengepassportph VITE_LOCAL_DEBUG=1 npm run build -w @penge/web
  (PENGE_LOCAL_KV=redis://127.0.0.1:6391 PENGE_LOCAL_DIR="$PWD/.local" npm run dev:local -w @penge/server > .local/api.log 2>&1 &)
  (cd apps/web && BASE_PATH=pengepassportph npx vite preview --port 4173 --strictPort > ../../.local/web.log 2>&1 &)
  (node apps/server/dev/https-proxy.mjs > .local/proxy.log 2>&1 &)
  echo "web   http://localhost:4173/pengepassportph/"
  echo "https https://localhost:8443/pengepassportph/   mail in .local/mail/"
  printf 'SPKI hash for Chrome: '
  openssl x509 -in .local/tls/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
  ;;
down)
  pkill -f '.local/dist/local.mjs' || true
  pkill -f 'vite preview --port 4173' || true
  pkill -f 'apps/server/dev/https-proxy.mjs' || true
  docker stop penge-local-valkey >/dev/null 2>&1 || true
  ;;
*)
  echo "usage: scripts/local-stack.sh up|down" >&2
  exit 2
  ;;
esac
```

`apps/server/dev/README.md`: what each piece is, the commands, that nothing here touches `.secrets/`, R2, the DFA or the server, and how to read `.local/mail/`.

- [ ] **Step 4: Run the test, then the real stack**

```bash
npm test -w @penge/server -- test/local-stack.test.ts
scripts/local-stack.sh up
curl -s localhost:8787/api/status | jq '{push, sites: (.sites | length)}'
curl -sk https://localhost:8443/pengepassportph/ | head -c 200
PUSH_TEST_VALKEY=redis://127.0.0.1:6391 npm test -w @penge/server -- test/push-atomic.test.ts
scripts/local-stack.sh down
```

Expected: tests PASS; status shows `"push": "live"` and 3 sites; the HTTPS proxy serves the page; Task 4's tests pass on the real Valkey. (Running Task 4's tests wipes and re-marks the local Valkey; run them before, not during, the checks in Task 17.)

- [ ] **Step 5: Codex pass, then commit** (`A local stack for push: throwaway Valkey, captured mail, a fake DFA and local HTTPS`).

---

### Task 17: Verify on Mac Chrome and Mac Firefox

**Files:**
- Create: `docs/superpowers/verification/2026-10-push-mac.md`, screenshots in `docs/superpowers/verification/img/`

No product code. `scripts/local-stack.sh up`, then in **each** of Chrome and Firefox at `http://localhost:4173/pengepassportph/`, record pass or fail, with a screenshot, for each item. Read captured emails in `.local/mail/`; trigger alerts with `npm run dev:alert -w @penge/server -- --office 486 --date <a date shown as published>`; inspect Valkey with `docker exec penge-local-valkey valkey-cli --scan --pattern 'pp:push*'`.

- [ ] Permission: allow; deny (the switch shows the hint); dismiss (the switch stays off, no hint).
- [ ] Email only: confirmation email captured; confirm; an alert produces a captured alert email and no notification.
- [ ] Push only: the confirmation email says "Email: off" and "Notifications: on, for … (Chrome on Mac, …)"; the confirmation page shows the same before its button; confirm; the row reads "Waiting…" then "On"; an alert shows a notification "Dates open at Antipolo"; tapping it opens Antipolo with the date selected and the group size.
- [ ] Both: one email and one notification for one alert.
- [ ] Confirm in the other browser: subscribe with push in Chrome, open the captured link in Firefox, confirm there (it says "Notifications are on for the device where you asked for them"); back in Chrome the row turns "On" within 30 s; an alert reaches Chrome.
- [ ] Test notification: arrives on this browser only; a fourth within the hour is refused with the rate-limit message.
- [ ] Turn off: the row says off; an alert sends nothing to that browser; no `pp:push:meta` entry for it remains.
- [ ] Turn on again in the same browser after turning off, then confirm: a new credential is used and push works.
- [ ] Delete my data: removes every `pp:push*` (except `pp:push:revoked:*`) and `pp:reserved*` key for that address.
- [ ] Old worker: `git worktree add ../penge-old 157bad9`, build its web app with `BASE_PATH=pengepassportph`, serve it with `vite preview --port 4173 --strictPort` from that worktree, open it and let its worker install; stop it, serve the new build on the same port, reload once, flip the switch: the page updates the worker and subscribes within 10 s. Then `git worktree remove ../penge-old`.
- [ ] Firefox private window: the switch turns back off with the subscribe-failed reason; email stays on.
- [ ] Dark mode in both browsers: the switches and the row are readable.

Any failure: fix it test-first in the task that owns the code, Codex pass, commit, and repeat the whole checklist. Then `scripts/local-stack.sh down`.

- [ ] **Codex read of the checklist** for claims the screenshots do not show, **then commit** (`Push verified on Mac Chrome and Firefox`).

---

## Phase E: Android

### Task 18: The phone gate (a debug app over local HTTPS)

**Files:**
- Create: `android/dev/twa-manifest.dev.json`, `android/dev/build-dev.sh`, `android/dev/README.md`, `docs/superpowers/verification/2026-10-push-phone.md`

**Ask the owner before Step 3:** "May I install the debug app `com.alphaexperiments.pengepassportph.dev` on your phone, and set a test-only Chrome command line that I remove afterwards?" Do not continue without a yes in that moment.

- [ ] **Step 1: The debug manifest and build script**

`android/dev/twa-manifest.dev.json`: `android/twa-manifest.json` with `packageId` `com.alphaexperiments.pengepassportph.dev`, `host` `localhost:8443`, `name` `PengePassportPH (debug)`, `launcherName` `PassportPH dev`, `startUrl` `/pengepassportph/`, `iconUrl` `https://localhost:8443/pengepassportph/icons/icon-512.png`, `maskableIconUrl` `https://localhost:8443/pengepassportph/icons/maskable-512.png`, `monochromeIconUrl` `https://localhost:8443/pengepassportph/icons/monochrome-512.png` (made in Task 12), `webManifestUrl` `https://localhost:8443/pengepassportph/manifest.webmanifest`, `fullScopeUrl` `https://localhost:8443/pengepassportph/`, `enableNotifications: true`, `signingKey` `{ "path": "../../.local/android/debug.keystore", "alias": "debug" }`, `appVersionCode` `2`, `appVersion` `1.1.0-dev`.

`android/dev/build-dev.sh` (the same steps as `android/build.sh`, for a separate debug app that opens the local stack; it never touches `android/project/`, `android/out/` or the upload key):

```bash
#!/usr/bin/env bash
# Builds the debug Android app for the phone gate: package ...pengepassportph.dev,
# opening https://localhost:8443/pengepassportph/ (the local stack, through adb
# reverse), signed with a throwaway debug key. Output: android/out-dev/.
# Needs the local stack running (scripts/local-stack.sh up): Bubblewrap fetches the
# icons from it, trusting its certificate.
set -euo pipefail

BUBBLEWRAP=@bubblewrap/cli@1.25.0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android="$(dirname "$here")"
repo="$(dirname "$android")"
manifest="$here/twa-manifest.dev.json"
project="$android/project-dev"
out="$android/out-dev"
key="$repo/.local/android/debug.keystore"
cert="$repo/.local/tls/cert.pem"

java_home="${JAVA_HOME_17:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
sdk="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

fail() { echo "android/dev/build-dev.sh: $*" >&2; exit 1; }
grep -qs 'JAVA_VERSION="17\.' "$java_home/release" || fail "no JDK 17 at $java_home (set JAVA_HOME_17)"
[[ -d "$sdk/build-tools/36.1.0" ]] || fail "no Android SDK with build-tools 36.1.0 at $sdk (set ANDROID_HOME)"
[[ -f "$cert" ]] || fail "no local certificate: run scripts/local-stack.sh up first"
curl -sf --cacert "$cert" https://localhost:8443/pengepassportph/manifest.webmanifest >/dev/null || fail "the local stack is not answering on https://localhost:8443"

mkdir -p "$project" "$out" "$(dirname "$key")"
if [[ ! -f "$key" ]]; then
  keytool -genkeypair -keystore "$key" -alias debug -keyalg RSA -keysize 2048 -validity 30 \
    -dname CN=debug -storepass android -keypass android >/dev/null
fi

# The same SDK view and Bubblewrap settings as android/build.sh.
view="$sdk"
if [[ ! -d "$sdk/bin" && ! -d "$sdk/tools" ]]; then
  view="$project/sdk"
  rm -rf "$view"
  mkdir "$view"
  for entry in "$sdk"/*; do ln -s "$entry" "$view/"; done
  ln -s "$sdk/cmdline-tools/latest/bin" "$view/bin"
fi
jdk="$java_home"
[[ "$(uname)" == Darwin ]] && jdk="${java_home%/Contents/Home}"
config="$project/bubblewrap-config.json"
printf '{"jdkPath":"%s","androidSdkPath":"%s"}\n' "$jdk" "$view" > "$config"

export BUBBLEWRAP_KEYSTORE_PASSWORD=android BUBBLEWRAP_KEY_PASSWORD=android
# Bubblewrap downloads the icons from the local stack: trust its certificate for that.
export NODE_EXTRA_CA_CERTS="$cert"

cd "$project"
npx --yes "$BUBBLEWRAP" update --skipVersionUpgrade --manifest="$manifest" --directory="$project" --config="$config"
# As android/build.sh: android/res/ first (the patch refers to @drawable/ic_launcher_monochrome), then the patch.
cp -R "$android/res/." "$project/app/src/main/res/"
node "$android/patch.cjs" "$project" "$manifest"
npx --yes "$BUBBLEWRAP" build --manifest="$manifest" --directory="$project" --config="$config" --signingKeyPath="$key"

grep -q 'android.permission.POST_NOTIFICATIONS' "$project/app/src/main/AndroidManifest.xml" || fail "no notification permission"
grep -q 'DelegationService' "$project/app/src/main/AndroidManifest.xml" || fail "no notification delegation"
grep -q '"https://" + twaManifest.hostName' "$project/app/build.gradle" || fail "the launch URL is not https"
grep -q "hostName: 'localhost:8443'" "$project/app/build.gradle" || fail "the debug app does not open localhost:8443"

cp app-release-signed.apk "$out/pengepassportph-dev.apk"
echo
ls -l "$out/pengepassportph-dev.apk"
```

If Bubblewrap refuses `localhost:8443` as a host (the `update` step fails on it), stop: that ends the gate. Report it to the owner; nothing goes further.

- [ ] **Step 2: Build it**

```bash
scripts/local-stack.sh up
sh android/dev/build-dev.sh
```

Expected: `android/out-dev/pengepassportph-dev.apk`; the four checks pass.

- [ ] **Step 3: On the phone (after the owner's yes)**

```sh
ADB="adb -s $ADB_SERIAL"
${=ADB} reverse tcp:8443 tcp:8443
${=ADB} reverse tcp:4173 tcp:4173
SPKI=$(openssl x509 -in .local/tls/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
echo "_ --ignore-certificate-errors-spki-list=$SPKI --disable-digital-asset-link-verification-for-url=https://localhost:8443" | ${=ADB} shell 'cat > /data/local/tmp/chrome-command-line'
${=ADB} install android/out-dev/pengepassportph-dev.apk
```

The owner turns on chrome://flags › "Enable command line on non-rooted devices" and restarts Chrome. Record pass or fail with a screenshot each (`${=ADB} exec-out screencap -p > docs/superpowers/verification/img/<name>.png`):

- [ ] Chrome tab at `http://localhost:4173/pengepassportph/`: "Browser notifications"; the push-only flow; an alert arrives as a Chrome notification.
- [ ] Installed from Chrome (Add to Home screen) at the same address: "Notifications on this device"; the flow works.
- [ ] The debug app opens with no address bar, and its debug line says `context: play`.
- [ ] Turning the switch on shows Android's own permission prompt naming "PassportPH dev"; allowed: an alert shows as the app's notification (its icon and name); tapping it opens the office.
- [ ] Denied in the prompt: the switch shows the Android settings hint.
- [ ] Allowed, then turned off in Android Settings › Apps › PassportPH dev › Notifications: the row says "Notifications are blocked on this device".
- [ ] Dark mode (`${=ADB} shell cmd uimode night yes`): readable.

If the debug app shows an address bar after the flags, or no Android permission prompt appears: stop. Nothing goes to the server or GitHub. Tell the owner exactly what failed and wait for their decision.

- [ ] **Step 4: Clean up the phone**

```sh
${=ADB} uninstall com.alphaexperiments.pengepassportph.dev
${=ADB} shell rm /data/local/tmp/chrome-command-line
${=ADB} reverse --remove-all
${=ADB} shell cmd uimode night no
scripts/local-stack.sh down
```

Ask the owner to turn the Chrome flag back off and restart Chrome; record that in the checklist.

- [ ] **Step 5: Codex read of the checklist, then commit** (`Push verified on the owner's phone: Chrome, installed, and the debug app`).

---

### Task 19: The release Android build (1.1.0)

**Files:**
- Modify: `android/twa-manifest.json`, `android/check-play-release.mjs`, `docs/android.md`
- Create: `android/check-manifest.mjs`

- [ ] **Step 1: An offline check that fails today**

`android/check-manifest.mjs` (no network; run before every release build):

```js
// Checks android/twa-manifest.json, and the generated project when it exists,
// for what notifications need. No network: the live checks are in check-play-release.mjs.
import { existsSync, readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync(new URL('./twa-manifest.json', import.meta.url), 'utf8'));
const fail = (msg) => { console.error(`check-manifest: ${msg}`); process.exit(1); };
if (m.enableNotifications !== true) fail('enableNotifications is not true');
if (m.monochromeIconUrl !== 'https://alphaexperiments.com/pengepassportph/icons/monochrome-512.png') fail('monochromeIconUrl is not the site icon');
if (m.appVersionCode !== 2 || m.appVersion !== '1.1.0') fail('version is not 2 / 1.1.0');
// --project: also the generated project, which android/build.sh regenerates from the manifest.
if (process.argv.includes('--project')) {
  const manifest = new URL('./project/app/src/main/AndroidManifest.xml', import.meta.url);
  if (!existsSync(manifest)) fail('no generated project yet: run android/build.sh first');
  const xml = readFileSync(manifest, 'utf8');
  if (!xml.includes('android.permission.POST_NOTIFICATIONS')) fail('the generated app does not ask for notifications');
  if (!xml.includes('DelegationService')) fail('the generated app has no notification delegation');
}
console.log('check-manifest: ok');
```

Run: `node android/check-manifest.mjs`. Expected: FAIL (`enableNotifications is not true`).

- [ ] **Step 2: Set** `enableNotifications: true`, `monochromeIconUrl` as above, `appVersionCode: 2`, `appVersion: "1.1.0"`. Run: `node android/check-manifest.mjs` → `ok`. (`--project`, which checks the generated Android project, runs after `android/build.sh` regenerates it in Task 21; the project in the checkout now is version 1's.)

- [ ] **Step 3: Extend the live check**: in `android/check-play-release.mjs` (it already requires `--play-sha256` and `--support-email` and fetches live assets with its `fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })` pattern), after its existing asset checks:

```js
// The status-bar icon notifications use: served, a PNG, 512 square.
const mono = await fetch(m.monochromeIconUrl, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
if (mono.status !== 200 || !mono.headers.get('content-type')?.startsWith('image/png')) fail(`monochromeIconUrl answers ${mono.status} ${mono.headers.get('content-type')}`);
const png = Buffer.from(await mono.arrayBuffer());
if (png.readUInt32BE(16) !== 512 || png.readUInt32BE(20) !== 512) fail('monochromeIconUrl is not 512x512');
```

(`m` is the parsed `twa-manifest.json` there; use its existing variable name and `fail` helper.) It runs only after the web deploy (Task 21, Step 4).

- [ ] **Step 4: Update `docs/android.md`**: notifications (delegation, the Android 13+ prompt), the phone gate (Task 18), and the owner's Play Console steps: Data safety "Device or other IDs" (push endpoint) for app functionality; Play's app-signing certificate in `assetlinks.json`; upload of 1.1.0.

- [ ] **Step 5: Codex pass, then commit** (`Android 1.1.0: notifications through the app`). The AAB is built in Task 21, after the icon is live.

---

## Phase F: documentation and rollout

### Task 20: Documentation, the privacy page, and the backup expiry files

**Files:**
- Modify: `apps/web/src/pages/Privacy.tsx`, `docs/legal/README.md`, `deploy/README.md`, `docs/how-it-works.md`, `docs/alert-timing.md`, `README.md`
- Create: `deploy/penge-backup-expire.sh`, `deploy/systemd/penge-backup-expire.service`, `deploy/systemd/penge-backup-expire.timer`
- Test: `apps/web/test/pages.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
describe('privacy page', () => {
  it('explains notifications: what is kept, who carries them, how to stop them, and for how long', async () => {
    render(<App path="/privacy" api={fakeApi()} />);
    const text = document.body.textContent!;
    expect(text).toMatch(/push subscription/i);
    expect(text).toMatch(/Google/);
    expect(text).toMatch(/Mozilla/);
    expect(text).toMatch(/Apple/);
    expect(text).toMatch(/encrypted/i);
    expect(text).toMatch(/Turn off/);
    expect(text).toMatch(/not (kept )?in (our )?backups/i);
  });
});
```

In the existing privacy test, the asserted list of section headings gains `'Notifications'`, after `'If you sign up for email alerts'`:

```ts
    expect(sections).toEqual(['If you only look at dates', 'If you sign up for email alerts', 'Notifications', 'Deleting your address', 'Where it is kept', 'Changes and questions']);
```

Run: `npm test -w @penge/web -- test/pages.test.tsx`. Expected: FAIL.

- [ ] **Step 2: Write the docs**

- `Privacy.tsx`: a "Notifications" section (an `<h2>`, placed after the email alerts section) in the page's voice: when you turn notifications on, your browser gives us a push subscription (an address at your browser maker's push service, and keys) that we keep encrypted with your alert; alerts reach your device through that service (Google for Chrome and the Android app, Mozilla for Firefox, Apple for Safari), encrypted so the service cannot read them; turn them off with "Turn off" on the home page, in your browser or phone settings, or by deleting your data; the subscription is deleted when you turn notifications off, unsubscribe or delete your data, and is not kept in backups.
- `docs/legal/README.md`: rows for devices (sealed endpoint and keys, label, created), device metadata and notes, credential hashes, endpoint index, pending and revoked markers, reservations: what each is, why, and how long it lives.
- `deploy/README.md`:
  - "Push notifications": `PUSH_MODE` (`off`, `owner`, `live`); the VAPID keys and the owner's offline copy; `VAPID_SUBJECT`; `PUSH_OWNER_EMAILS` and `?push=owner`; the emergency stops with commands:
    ```sh
    sudo -u penge sh -c 'set -a; . /etc/penge/server.env; valkey-cli -u "$REDIS_URL" --no-auth-warning SET pp:push:paused 1'
    sudo -u penge sh -c 'set -a; . /etc/penge/server.env; valkey-cli -u "$REDIS_URL" --no-auth-warning DEL pp:push:paused'
    ```
    (and the same for `pp:mail:paused`); what the daily numbers show.
  - "Rolling back once push is on": switch push off on the new release first. If the old release is really needed, in a maintenance window:
    ```sh
    systemctl disable --now penge-check.timer
    systemctl stop penge-check.service penge-api
    sudo -u penge sh -c 'set -a; . /etc/penge/server.env; node /opt/penge/current/server/admin.mjs push-downgrade --yes'
    ln -sfn /opt/penge/releases/<the release before push> /opt/penge/current
    systemctl start penge-api
    systemctl enable --now penge-check.timer
    ```
    and `admin.mjs backup-to-v1` for restoring a backup into the old release.
  - "Rollout backups": `/root/penge-backups/`, the expiry time in each name, `penge-backup-expire.timer`, and each backup's restore command:
    ```sh
    # server.env
    install -m 0640 -o root -g penge /root/penge-backups/server.env-<stamp>-expires-<stamp> /etc/penge/server.env
    # subscribers: a copy the penge user can read, removed straight after
    install -m 0600 -o penge -g penge /root/penge-backups/subscribers-<stamp>-expires-<stamp>.json /var/lib/penge/restore.json
    sudo -u penge sh -c 'set -a; . /etc/penge/server.env; node /opt/penge/current/server/admin.mjs restore /var/lib/penge/restore.json --yes'
    shred -u /var/lib/penge/restore.json
    # the previous release: ONLY before anyone has turned push on or asked for it.
    # After that, use "Rolling back once push is on" (stop, push-downgrade, then switch).
    ln -sfn /opt/penge/releases/<previous> /opt/penge/current && systemctl restart penge-api
    ```
- `docs/how-it-works.md`: the channel flow and device binding, in a few paragraphs.
- `docs/alert-timing.md`: channels share one pace; when email is blocked and push delivers, that email is not kept.
- `README.md`: the feature list mentions push notifications.
- `deploy/penge-backup-expire.sh`, with full UTC timestamps (`YYYYMMDDTHHMMSSZ`) so nothing goes early, and a clean exit:
  ```sh
  #!/bin/sh
  # Deletes rollout backups in /root/penge-backups/ whose expiry time, written in
  # their name as ...-expires-YYYYMMDDTHHMMSSZ, has passed. penge-backup-expire.timer
  # runs it hourly, and catches up after a reboot.
  set -eu
  now=$(date -u +%Y%m%dT%H%M%SZ)
  for f in /root/penge-backups/*-expires-*; do
    [ -e "$f" ] || continue
    stamp=${f##*-expires-}
    stamp=${stamp%%.*}
    if [ "$stamp" \< "$now" ] || [ "$stamp" = "$now" ]; then rm -f -- "$f"; fi
  done
  exit 0
  ```
- `deploy/systemd/penge-backup-expire.service`:
  ```ini
  [Unit]
  Description=Delete PengePassportPH rollout backups past their expiry time

  [Service]
  Type=oneshot
  ExecStart=/usr/local/sbin/penge-backup-expire
  ```
- `deploy/systemd/penge-backup-expire.timer`:
  ```ini
  [Unit]
  Description=Hourly check for expired PengePassportPH rollout backups

  [Timer]
  OnCalendar=hourly
  Persistent=true

  [Install]
  WantedBy=timers.target
  ```
  (Hourly, so a backup goes at most an hour after its expiry time.)

- [ ] **Step 3: Test the expiry script locally**

```bash
d=$(mktemp -d) && mkdir -p "$d/root/penge-backups"
touch "$d/root/penge-backups/a-expires-20000101T000000Z.json" "$d/root/penge-backups/b-expires-29990101T000000Z.json"
sed "s#/root/penge-backups#$d/root/penge-backups#" deploy/penge-backup-expire.sh | sh && ls "$d/root/penge-backups"
```

Expected: only `b-expires-29990101T000000Z.json` remains, and the exit status is 0.

- [ ] **Step 4: Run the web tests** → PASS.

- [ ] **Step 5: Codex pass on the docs for claims the code does not support, then commit** (`Document push notifications: privacy, legal register, operations, rollback and backups`).

---

### Task 21: Rollout (only after the owner's go)

Ask the owner: "Everything is verified locally (Tasks 17 and 18). May I push to GitHub and start the rollout?" Wait for a yes. Then one step at a time, reporting each. Server commands use the owner's key and the passphrase approach used before (a throwaway askpass script in the scratchpad, deleted afterwards).

- [ ] **Step 1: Backups on the server, each with an expiry 14 days from now**

```sh
ssh root@213.250.173.234 'set -eu
install -d -m 0700 /root/penge-backups
now=$(date -u +%Y%m%dT%H%M%SZ)
exp=$(date -u -d "+14 days" +%Y%m%dT%H%M%SZ)
cp -p /etc/penge/server.env "/root/penge-backups/server.env-$now-expires-$exp"
sudo -u penge sh -c "set -a; . /etc/penge/server.env; node /opt/penge/current/server/admin.mjs backup" > "/root/penge-backups/subscribers-$now-expires-$exp.json"
chmod 0600 /root/penge-backups/*
readlink /opt/penge/current
ls -l /root/penge-backups'
```

Install the expiry timer by hand: copy `deploy/penge-backup-expire.sh` to `/usr/local/sbin/penge-backup-expire` (mode 0755) and the two units to `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now penge-backup-expire.timer && systemctl list-timers penge-backup-expire.timer`. Run it once now (`systemctl start penge-backup-expire.service`) and check both backups are still there.

- [ ] **Step 2: Push and deploy with push off**: `git push` (CI, then Deploy; rerun Deploy if it fails "CI has not passed", the known race). Check: the release symlink, `penge-api` active, `/api/status` has `"push": "off"`, the next scan healthy, alerts flowing as before (`check finished` lines show `emailBlocked: null`).
- [ ] **Step 3: Owner mode**: make VAPID keys locally (`npx web-push generate-vapid-keys --json`); give the owner the private key for their offline copy; on the server, back up `server.env` again (as in Step 1), add `PUSH_MODE=owner`, the keys, `VAPID_SUBJECT` (the dedicated address the owner chose) and `PUSH_OWNER_EMAILS`; `systemctl restart penge-api` (the checker reads the file every run). The owner subscribes with `?push=owner` on their phone (Chrome and installed) and Mac browsers; wait for a real alert or send a test; check the next morning's numbers.
- [ ] **Step 4: Android release build**: with the monochrome icon live, `android/build.sh`, then `node android/check-manifest.mjs --project` and `node android/check-play-release.mjs --play-sha256 <Play's app-signing SHA-256> --support-email <the dedicated address>` (both values from the owner). Hand `pengepassportph-2.aab` and `.apk` to the owner with the Play Console steps from `docs/android.md`.
- [ ] **Step 5: Live**: with the owner's yes, `PUSH_MODE=live` (back up `server.env` first), `systemctl restart penge-api`. Watch the first day's numbers.
- [ ] **Step 6: Memory**: update the memory notes: push is live (with the date), where the rollout backups are and when they expire, and the owner's remaining Play steps.
