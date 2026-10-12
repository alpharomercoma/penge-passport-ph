import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { type Browser, type BrowserSub, DeviceController, TEXT } from '../src/devices/controller.ts';
import * as S from '../src/devices/state.js';
import { FakeDeviceServer } from './fake-device-server.ts';
import { env as stateEnv } from './state.test.ts';
import { rowText } from '../src/components/DeviceRow.tsx';

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

describe('a device clock corrected backward', () => {
  it('recovers a setup left preparing by a page whose clock ran a day ahead, within seconds, not a day', async () => {
    const w = world();
    // A page whose clock was a day ahead began a setup, then went away before preparing it.
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() + 86_400_000 })) as { started: S.Operation };
    expect(r.started.phase).toBe('preparing');
    const t0 = w.now();
    await w.c.reconcile(); // the row's reconcile: it carries the operation on in the background
    const stuck = async () => {
      const s = await S.readState(w.env);
      return s.op?.op === r.started.op && (s.op.phase === 'preparing' || s.op.phase === 'attached') && !s.op.result;
    };
    // Recovered once this page has watched it for a few seconds of its own (monotonic) time.
    for (let i = 0; i < 300 && (await stuck()) && w.now() - t0 < 60_000; i++) await new Promise((res) => setTimeout(res, 5));
    expect(await stuck()).toBe(false);
    expect(w.now() - t0).toBeLessThan(60_000);
  }, 15_000);
});

describe('a device clock corrected backward, with the server unreachable', () => {
  it('gives up on a sent setup whose stored deadline is a day away within the longest an operation lives, not a day', async () => {
    const w = world();
    const day = 86_400_000;
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() + day })) as { started: S.Operation };
    const sub = await w.browser.subscribe('B'.repeat(87));
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: await S.fingerprint(w.env, sub.json), by: 'gone-page' });
    await S.confirmReady(w.env, { op: r.started.op, by: 'gone-page' });
    await S.markSent(w.env, { op: r.started.op, expiresAt: w.now() + day + 300_000 });
    // Offline: every request fails.
    for (const k of Object.keys(w.server.api) as (keyof typeof w.server.api)[]) (w.server.api as unknown as Record<string, unknown>)[k] = async () => Promise.reject(new TypeError('Failed to fetch'));
    const t0 = w.now();
    await w.c.reconcile();
    const open = async () => !(await S.readState(w.env)).op?.result;
    for (let i = 0; i < 600 && (await open()) && w.now() - t0 < 3_600_000; i++) await new Promise((res) => setTimeout(res, 5));
    expect(await open()).toBe(false);
    expect(w.now() - t0).toBeLessThan(10 * 60_000);
  }, 20_000);
});

describe('when this browser\'s storage fails', () => {
  it("an alert that is on never vanishes from the row when storage fails: it says it can't check", async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    w.env.indexedDB!.open = () => {
      throw new DOMException('refused', 'UnknownError');
    };
    expect((await w.c.reconcile()).kind).toBe('cant-check');
  });

  it('a browser without IndexedDB at all shows no row (nothing could ever be set up there)', async () => {
    const w = world();
    delete (w.env as { indexedDB?: unknown }).indexedDB;
    expect((await w.c.reconcile()).kind).toBe('none');
  });

  it('Turn off with storage refused never fails silently: the row says to block notifications in the settings', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    w.env.indexedDB!.open = () => {
      throw new DOMException('refused', 'UnknownError');
    };
    expect(await w.c.reconcile()).toEqual({ kind: 'cant-check', storage: true });
    const v = await w.c.turnOff();
    expect(v).toEqual({ kind: 'cant-check', storage: true });
    expect(rowText(v, () => 'Antipolo')).toBe(TEXT.storageRow);
    expect(TEXT.storageRow).toMatch(/block them for this site in its settings/);
  });

  it('a change joining its own unfinished operation sends it again, rather than only waiting', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const next = { siteIds: [486], applicants: 2, pace: 'asap' as const };
    // A tab began this change and went away before sending it.
    const s = await S.readState(w.env);
    await S.begin(w.env, { kind: 'change', choices: next, captured: { incarnation: s.known!.incarnation, generation: s.known!.generation, revision: s.known!.revision }, now: w.now() });
    expect(await w.c.change(next)).toEqual({ ok: true, text: 'Saved.' });
  });

  it('a service worker out of reach (storage working) is an ordinary "can\'t check", never the storage message', async () => {
    const w = world();
    // An operation that ended "gone", its subscription not yet remembered: reconcile removes it, asking the browser.
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation };
    const sub = await w.browser.subscribe('B'.repeat(87));
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: await S.fingerprint(w.env, sub.json), by: 'page' });
    await S.recordResult(w.env, { op: r.started.op, credential: (await S.readState(w.env)).credential!, result: 'gone', activation: null });
    w.browser.subscription = async () => {
      throw new S.Unsupported('no service worker registration');
    };
    const v = await w.c.reconcile();
    expect(v).not.toEqual({ kind: 'cant-check', storage: true });
  });

  it('a change answers a failure with a retry, never throws', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    // From now on, opening the database fails (storage refused, a quota, a private window turning strict).
    w.env.indexedDB!.open = () => {
      throw new DOMException('refused', 'UnknownError');
    };
    const r = await w.c.change({ siteIds: [486], applicants: 2, pace: 'asap' });
    expect(r).toMatchObject({ ok: false, retry: true });
  });
});

describe('setting up on this device', () => {
  it('turns notifications on once this browser has shown the setup notification and proved it', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    expect(w.c.view).toMatchObject({ kind: 'on', alert: { choices } });
  });

  it("shows the alert on when the worker stores it while the page's own read is out (the worker's write wins the fence)", async () => {
    const w = world();
    const mine = w.server.api.mine.bind(w.server.api);
    let raced = false;
    w.server.api.mine = async (credential: string) => {
      const answer = await mine(credential);
      if (!raced && answer.state === 'active') {
        // As sw.js does after the ready check: the known alert, fenced by the version it read first.
        raced = true;
        const s = await S.readState(w.env);
        const a = answer.alert;
        await S.setKnown(w.env, { credential, known: { alertId: a.alertId, incarnation: a.incarnation, generation: a.generation, revision: a.revision, fingerprint: a.fingerprint, endsAt: Date.parse(a.endsAt), choices: a.choices }, version: s.knownVersion });
      }
      return answer;
    };
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    expect(raced).toBe(true);
    expect(w.c.view).toMatchObject({ kind: 'on', alert: { choices } });
  });

  /** The worker's known write lands while the page's success read is out, every time (as sw.js does after the ready check). */
  const workerWinsFence = (w: ReturnType<typeof world>) => {
    const mine = w.server.api.mine.bind(w.server.api);
    let races = 0;
    w.server.api.mine = async (credential: string) => {
      const answer = await mine(credential);
      const s = await S.readState(w.env);
      if (answer.state === 'active' && s.op?.result === 'active') {
        races++;
        const a = answer.alert;
        await S.setKnown(w.env, { credential, known: { alertId: a.alertId, incarnation: a.incarnation, generation: a.generation, revision: a.revision, fingerprint: a.fingerprint, endsAt: Date.parse(a.endsAt), choices: a.choices }, version: s.knownVersion });
      }
      return answer;
    };
    return () => races;
  };

  it('a re-setup with new choices shows them, even when the worker stores the alert first', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const races = workerWinsFence(w);
    const next = { siteIds: [486], applicants: 3, pace: 'hourly' as const };
    expect(await w.c.setup(next)).toEqual({ ok: true, text: TEXT.on });
    expect(races()).toBeGreaterThan(0);
    expect(w.c.view).toMatchObject({ kind: 'on', alert: { choices: next } });
  });

  it("an older setup's success never replaces a newer operation's row", async () => {
    const w = world();
    const races = workerWinsFence(w);
    // While the older result takes its browser proof, a newer setup begins (another tab, say).
    const subscription = w.browser.subscription;
    let begun = false;
    w.browser.subscription = async () => {
      const s = await S.readState(w.env);
      if (!begun && s.op?.result === 'active') {
        begun = true;
        await S.begin(w.env, { kind: 'setup', choices: { siteIds: [486], applicants: 2, pace: 'asap' }, captured: null, now: w.now() });
      }
      return subscription();
    };
    await w.c.setup(choices);
    expect(begun && races() > 0).toBe(true);
    expect(w.c.view.kind).not.toBe('on');
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

  it('removes the subscription it made when the worker cannot read the operation, unless something uses it', async () => {
    const w = world({ workerReads: false });
    expect(await w.c.setup(choices)).toEqual({ ok: false, text: TEXT.cantFinish, retry: false });
    expect(w.current()).toBeNull();
    expect((await S.readState(w.env)).claim).toBeNull();
  });

  it('never starts an automatic setup for a credential a turn-off replaced', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const before = await S.readState(w.env);
    await w.c.turnOff();
    const r = await (w.c as unknown as { setup(c: typeof choices, d: number, e: { credential: string; epoch: number }): Promise<{ ok: boolean }> }).setup(choices, 0, { credential: before.credential!, epoch: before.epoch });
    expect(r.ok).toBe(false);
    expect((await S.readState(w.env)).credential).toBeNull();
  });

  it('never claims a subscription the server called gone once this device\'s alert uses it again', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const s = await S.readState(w.env);
    const fp = s.known!.fingerprint;
    await (w.c as unknown as { removeGone(fp: string, credential: string, epoch: number): Promise<boolean> }).removeGone(fp, s.credential!, s.epoch);
    expect(w.current()).not.toBeNull();
    expect((await S.readState(w.env)).claim).toBeNull();
  });

  it('shows nothing from a read that failed after a turn-off finished', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const mine = w.server.api.mine;
    w.server.api.mine = async () => {
      // The turn-off runs (and reads) with the real server; this read then fails.
      w.server.api.mine = mine;
      await w.c.turnOff();
      throw Object.assign(new Error('lost'), { kind: 'offline' });
    };
    await w.c.reconcile();
    expect(w.c.view.kind).toBe('off');
  });

  it('keeps an automatic setup fenced while it waits behind another operation', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const before = await S.readState(w.env);
    // Another operation in progress (a change), so the automatic setup waits behind it; a turn-off comes meanwhile.
    await S.begin(w.env, { kind: 'change', choices: { ...choices, applicants: 2 }, captured: { incarnation: before.known!.incarnation, generation: before.known!.generation, revision: before.known!.revision }, now: w.now() });
    const mine = w.server.api.mine;
    w.server.api.mine = async (cred) => {
      w.server.api.mine = mine;
      await w.c.turnOff();
      return mine(cred);
    };
    await (w.c as unknown as { setup(c: typeof choices, d: number, e: { credential: string; epoch: number }): Promise<unknown> }).setup(choices, 0, { credential: before.credential!, epoch: before.epoch });
    expect((await S.readState(w.env)).credential).toBeNull();
  });

  it('never starts a rotation for a credential a turn-off replaced', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const before = await S.readState(w.env);
    await w.c.turnOff();
    await (w.c as unknown as { rotate(c: string, k: S.Known, a: number, e: { credential: string; epoch: number }): Promise<unknown> }).rotate(before.credential!, before.known!, 0, { credential: before.credential!, epoch: before.epoch });
    expect((await S.readState(w.env)).credential).toBeNull();
    expect((await S.readState(w.env)).op).toBeNull();
  });

  it('shows "off" only if nothing newer happened while the turn-off finished', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    let once = true;
    w.browser.closeNotifications = async () => {
      if (!once) return;
      once = false;
      await w.c.setup(choices);
    };
    await w.c.turnOff();
    expect(w.c.view.kind).toBe('on');
  });

  it('starts nothing new over a request whose answer was lost while the server cannot be asked', async () => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation };
    const sub = await w.browser.subscribe('B'.repeat(87));
    const fp = await S.fingerprint(w.env, sub.json);
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: fp, by: 'p' });
    await S.confirmReady(w.env, { op: r.started.op, by: 'p' });
    // Sent, its answer lost (still 'ready'); an hour later by this device's clock, the server cannot be reached.
    w.jump(3_600_000);
    w.server.api.mine = async () => {
      throw Object.assign(new Error('offline'), { kind: 'offline' });
    };
    expect(await w.c.setup({ ...choices, applicants: 2 })).toEqual({ ok: false, text: TEXT.offline, retry: true });
    expect((await S.readState(w.env)).op?.op).toBe(r.started.op);
  });

  it('shows nothing from a gone read once a turn-off finished during its clean-up', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const s = await S.readState(w.env);
    const real = w.browser.subscription;
    let once = true;
    w.browser.subscription = async () => {
      if (once) {
        once = false;
        w.browser.subscription = real;
        await w.c.turnOff();
      }
      return real();
    };
    await (w.c as unknown as { afterRead(c: string, m: unknown, b: S.DeviceState): Promise<unknown> }).afterRead(s.credential!, { state: 'gone', endedAt: new Date(w.now()).toISOString(), fingerprint: s.known!.fingerprint, operation: null }, s);
    expect(w.c.view.kind).toBe('off');
  });

  it('cleans up after a worker proof that throws, as after one that fails', async () => {
    const w = world();
    w.browser.workerReads = async () => {
      throw new Error('postMessage failed');
    };
    expect((await w.c.setup(choices)).ok).toBe(false);
    expect((await S.readState(w.env)).op).toBeNull();
    expect(w.current()).toBeNull();
  });

  it.each(['preparing', 'attached'] as const)('carries on an operation a page left %s, opened again 5 seconds later', async (phase) => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation };
    if (phase === 'attached') {
      const sub = await w.browser.subscribe('B'.repeat(87));
      await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: await S.fingerprint(w.env, sub.json), by: 'gone-page' });
    }
    w.advance(5000);
    await w.c.reconcile();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
  });

  it('leaves the row as it is when a rotation is fenced out by a turn-off', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const before = await S.readState(w.env);
    await w.c.turnOff();
    const view = w.c.view;
    await (w.c as unknown as { rotate(c: string, k: S.Known, a: number, e: { credential: string; epoch: number }): Promise<unknown> }).rotate(before.credential!, before.known!, 0, { credential: before.credential!, epoch: before.epoch });
    expect(w.c.view).toEqual(view);
  });

  it('never lets recovery cancel a setup that is only slow to get its subscription', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const w = world();
    const subscribe = w.browser.subscribe;
    let first = true;
    // Known to be waiting in subscribe (its lookup done), not assumed after some milliseconds: under a loaded run it
    // could still be before its lookup, and meet the failing one installed below.
    let reachedSubscribe = () => {};
    const reached = new Promise<void>((r) => (reachedSubscribe = r));
    w.browser.subscribe = async (vapid) => {
      if (first) {
        first = false;
        reachedSubscribe();
        await held; // the browser's permission prompt, say
      }
      return subscribe(vapid);
    };
    const setup = w.c.setup(choices);
    await reached;
    w.advance(11_000);
    // Another opening recovers what looks orphaned; its own subscription lookup fails.
    const sub = w.browser.subscription;
    w.browser.subscription = async () => {
      throw new S.Unsupported('no registration');
    };
    await w.c.reconcile();
    await new Promise((r) => setTimeout(r, 20));
    w.browser.subscription = sub;
    release();
    expect(await setup).toEqual({ ok: true, text: TEXT.on });
  });

  it('never lets recovery cancel a rotation that is only slow to get its subscription', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const s = await S.readState(w.env);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const subscribe = w.browser.subscribe;
    const subscription = w.browser.subscription;
    w.browser.subscription = async () => null; // the push service dropped it: a new one is made
    // The rotation is known to be waiting for its subscription (not assumed to be after some milliseconds: under a
    // loaded run it could still be before its lookup, and meet the failing one installed below).
    let reachedSubscribe = () => {};
    const reached = new Promise<void>((r) => (reachedSubscribe = r));
    w.browser.subscribe = async (vapid) => {
      reachedSubscribe();
      await held;
      w.browser.subscription = subscription;
      return subscribe(vapid);
    };
    const rotation = (w.c as unknown as { rotate(c: string, k: S.Known): Promise<unknown> }).rotate(s.credential!, s.known!);
    await reached;
    w.advance(11_000);
    const lookup = w.browser.subscription;
    w.browser.subscription = async () => {
      throw new S.Unsupported('no registration');
    };
    await w.c.reconcile();
    await new Promise((r) => setTimeout(r, 20));
    w.browser.subscription = lookup;
    release();
    await rotation;
    expect(w.server.calls).toContain('rotate');
  });

  it('keeps trying to recover an operation found stale on opening while another page held the driver lock', async () => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation };
    const sub = await w.browser.subscribe('B'.repeat(87));
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: await S.fingerprint(w.env, sub.json), by: 'page-a' });
    w.advance(11_000);
    const drive = w.browser.drive;
    let busy = 2; // page A holds the lock a little longer
    w.browser.drive = async (fn) => (busy-- > 0 ? null : drive(fn));
    await w.c.reconcile();
    for (let i = 0; i < 50 && !(await S.readState(w.env)).op?.result; i++) await new Promise((res) => setTimeout(res, 5));
    expect(w.server.calls).toContain('setup');
    expect((await S.readState(w.env)).op?.result).toBe('active');
  });

  it('removes and remembers a subscription an operation ended "gone" with, on the next opening', async () => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation; credential: string };
    const sub = await w.browser.subscribe('B'.repeat(87));
    const fp = await S.fingerprint(w.env, sub.json);
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: fp, by: 'p' });
    await S.confirmReady(w.env, { op: r.started.op, by: 'p' });
    await S.recordResult(w.env, { op: r.started.op, credential: r.credential, result: 'gone', activation: null });
    await w.c.reconcile();
    expect(w.current()).toBeNull();
    expect((await S.readState(w.env)).gone).toContain(fp);
  });

  it('removes the dead subscription for a page that joined the operation before it had one', async () => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation; credential: string };
    const snapshot = r.started; // joined while preparing: no fingerprint in this copy
    const sub = await w.browser.subscribe('B'.repeat(87));
    const fp = await S.fingerprint(w.env, sub.json);
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: fp, by: 'p' });
    await S.confirmReady(w.env, { op: r.started.op, by: 'p' });
    // The driver recorded the result; this page, holding its copy from before the attach, presents it.
    await S.recordResult(w.env, { op: r.started.op, credential: r.credential, result: 'gone', activation: null });
    await (w.c as unknown as { result(op: S.Operation, c: string, o: { result: string; activation: null }): Promise<unknown> }).result(snapshot, r.credential, { result: 'gone', activation: null });
    expect(w.current()).toBeNull();
  });

  it('drives a rotation whose preparation found the driver lock taken', async () => {
    const w = world();
    expect(await w.c.setup(choices)).toEqual({ ok: true, text: TEXT.on });
    const s = await S.readState(w.env);
    const drive = w.browser.drive;
    let first = true;
    w.browser.drive = async (fn) => {
      if (first) {
        first = false;
        return null; // another page held it, and went away
      }
      return drive(fn);
    };
    await (w.c as unknown as { rotate(c: string, k: S.Known): Promise<unknown> }).rotate(s.credential!, s.known!);
    expect(w.server.calls).toContain('rotate');
  });

  it('drops nothing when a hidden page\'s worker proof throws', async () => {
    const w = world();
    let shown = true;
    w.browser.visible = () => shown;
    w.browser.workerReads = async () => {
      shown = false;
      throw new Error('postMessage failed');
    };
    await w.c.setup(choices).catch(() => undefined);
    expect((await S.readState(w.env)).op).toMatchObject({ phase: 'attached' });
    expect(w.current()).not.toBeNull();
  });

  it('recovers nothing on a hidden page, and drops nothing there', async () => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation };
    const sub = await w.browser.subscribe('B'.repeat(87));
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: await S.fingerprint(w.env, sub.json), by: 'gone-page' });
    w.advance(11_000);
    w.browser.visible = () => false;
    await (w.c as unknown as { recoverPreparing(op: S.Operation, c: string): Promise<void> }).recoverPreparing((await S.readState(w.env)).op!, (await S.readState(w.env)).credential!);
    expect((await S.readState(w.env)).op).toMatchObject({ op: r.started.op, phase: 'attached' });
    expect(w.current()).not.toBeNull();
  });

  it('removes the subscription a setup ending "gone" was made with', async () => {
    const w = world();
    const r = (await S.begin(w.env, { kind: 'setup', choices, captured: null, now: w.now() })) as { started: S.Operation; credential: string };
    const sub = await w.browser.subscribe('B'.repeat(87));
    const fp = await S.fingerprint(w.env, sub.json);
    await S.attach(w.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: fp, by: 'p' });
    await S.confirmReady(w.env, { op: r.started.op, by: 'p' });
    await S.recordResult(w.env, { op: r.started.op, credential: r.credential, result: 'gone', activation: null });
    const st = await S.readState(w.env);
    await (w.c as unknown as { removeGone(fp: string, c: string, e: number): Promise<boolean> }).removeGone(fp, r.credential, st.epoch);
    expect(w.current()).toBeNull();
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

  it('repeats an unsent request exactly 5, 15 and 45 seconds apart', async () => {
    const w = world({ deliverAfterMs: null });
    w.server.dispatch = ['retryable', 'retryable', 'retryable', 'retryable', 'retryable'];
    const at: number[] = [];
    const orig = w.server.api.setup;
    w.server.api.setup = async (cred, body, token) => (at.push(w.now()), orig(cred, body, token));
    await w.c.setup(choices);
    expect(at.slice(1, 4).map((t, i) => t - at[i]!)).toEqual([5000, 15_000, 45_000]);
  });

  it('a page taking over the drive asks the server first and keeps its backoff', async () => {
    const w = world({ deliverAfterMs: null });
    let shown = true;
    w.browser.visible = () => shown;
    w.server.dispatch = ['retryable', 'retryable', 'accepted'];
    w.server.retryIn = 60_000;
    const at: number[] = [];
    const orig = w.server.api.setup;
    w.server.api.setup = async (cred, body, token) => {
      at.push(w.now());
      const r = await orig(cred, body, token);
      if (at.length === 1) shown = false; // hidden right after the first answer
      return r;
    };
    await w.c.setup(choices);
    shown = true;
    w.advance(2000);
    await w.c.setup(choices); // the same choices: joins the operation and drives it
    // Nothing sent again inside the server's 60-second retry time (the takeover read the server first).
    expect(at.filter((t) => t > at[0]! && t < at[0]! + 60_000)).toEqual([]);
    expect(w.server.calls.indexOf('mine')).toBeGreaterThan(w.server.calls.indexOf('setup'));
  });

  it('says a setup refused for limits each time was limited, not that it took too long', async () => {
    const w = world();
    w.server.api.setup = async () => ({ outcome: 'limited', operation: null });
    expect(await w.c.setup(choices)).toEqual({ ok: false, text: TEXT.limited, retry: true });
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
