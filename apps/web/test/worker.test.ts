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
function worker(o: { answers?: Record<string, unknown>[]; showFails?: boolean; navigateHangs?: boolean; onShow?: (title: string) => Promise<void>; mineFingerprint?: string; beforeMine?: () => Promise<void>; readyFails?: number; onReady?: (n: number) => Promise<void> } = {}) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const shown: { title: string; body: string; tag?: string | undefined }[] = [];
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
        await o.onShow?.(title);
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
    clients: {
      claim: async () => {},
      // Chromium settles a navigation only once it commits, which (on a first activation) waits for the activation.
      matchAll: async () => [{ url: `${SCOPE}?office=486`, navigate: (u: string) => (navigated.push(u), o.navigateHangs ? new Promise(() => {}) : Promise.resolve()) }],
    },
  };
  const fetchFake = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const path = url.slice(`${SCOPE}api/device-alerts`.length);
    posted.push({ path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization ?? null });
    if (path === '/mine') await o.beforeMine?.();
    if (path === '/ready') await o.onReady?.(posted.filter((p) => p.path === '/ready').length);
    if (path === '/ready' && (o.readyFails ?? 0) > 0) {
      o.readyFails = (o.readyFails ?? 0) - 1;
      await o.beforeMine?.();
      throw new TypeError('Failed to fetch');
    }
    if (path === '/mine') return new Response(JSON.stringify({ state: 'active', operation: null, alert: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, choices: { siteIds: [486], applicants: 1, pace: 'asap' }, fingerprint: o.mineFingerprint ?? (await S.fingerprint(env, sub)), endsAt: '2027-04-04T00:00:00.000Z', updating: false } }));
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
      mineFingerprint: 'f', // the winner registered another subscription than this one
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

  it('never waits, while activating, for the pages it reloads', async () => {
    const w = worker({ navigateHangs: true });
    await w.fire('activate', {});
    expect(w.navigated).toEqual([`${SCOPE}?office=486`]);
  });

  it('starts no rotation while a page holds the driver lock: that page carries it on', async () => {
    const w = worker();
    const known = { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, fingerprint: 'old', endsAt: Date.now() + 1e9, choices: { siteIds: [486], applicants: 1, pace: 'asap' as const } };
    await S.update(w.env, (s) => ({ state: { ...s, credential: 'c'.repeat(43), known }, result: null }));
    let release!: () => void;
    const held = w.env.locks!.request(S.DRIVER_LOCK, () => new Promise<void>((r) => (release = r)));
    await w.fire('pushsubscriptionchange', {});
    expect((await S.readState(w.env)).op).toBeNull();
    expect(w.posted).toEqual([]);
    release();
    await held;
  });

  it('remembers the alert a setup it completed made, so a later subscription change can rotate it', async () => {
    const w = worker();
    const r = await pending(w.env);
    await w.fire('push', setupPush(r.started.op));
    expect(w.shown.at(-1)!.title).toBe('Notifications are ready');
    expect((await S.readState(w.env)).known).toMatchObject({ incarnation: 'i'.repeat(22), generation: 1 });
  });

  it('takes the success back when the device stopped knowing the alert while it showed it', async () => {
    let env!: S.Env;
    const w = worker({
      onShow: async (title) => {
        if (title === 'Notifications are ready') await S.update(env, (s) => ({ state: { ...s, known: null, knownVersion: s.knownVersion + 1 }, result: null }));
      },
    });
    env = w.env;
    const r = await pending(w.env);
    await w.fire('push', setupPush(r.started.op));
    expect(w.shown.at(-1)!.title).toBe("This notification setup didn't finish.");
  });

  it('never brings back an alert a newer read cleared while its own read was out', async () => {
    let env!: S.Env;
    const w = worker({
      beforeMine: async () => {
        // A newer page read found no alert and cleared it.
        await S.update(env, (s) => ({ state: { ...s, known: null, knownVersion: s.knownVersion + 1 }, result: null }));
      },
    });
    env = w.env;
    const r = await pending(w.env);
    await w.fire('push', setupPush(r.started.op));
    expect((await S.readState(w.env)).known).toBeNull();
    expect(w.shown.map((n) => n.title)).not.toContain('Notifications are ready');
  });

  it('says nothing false when the page finished this setup and moved on while the acknowledgement was lost', async () => {
    let env!: S.Env;
    let opId = '';
    const w = worker({
      readyFails: 1,
      beforeMine: async () => {
        // The page acknowledged, remembered the alert and started a change.
        const s = await S.readState(env);
        if (s.op?.op !== opId) return;
        await S.recordResult(env, { op: opId, credential: s.credential!, result: 'active', activation: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1 } });
        const fp = await S.fingerprint(env, sub);
        await S.update(env, (t) => ({ state: { ...t, known: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, fingerprint: fp, endsAt: Date.now() + 1e9, choices: { siteIds: [486], applicants: 1, pace: 'asap' } }, knownVersion: t.knownVersion + 1 }, result: null }));
        await S.begin(env, { kind: 'change', choices: { siteIds: [693], applicants: 1, pace: 'asap' }, captured: { incarnation: 'i'.repeat(22), generation: 1, revision: 1 }, now: Date.now() + 200_000 });
      },
    });
    env = w.env;
    const r = await pending(w.env);
    opId = r.started.op;
    await w.fire('push', setupPush(r.started.op));
    expect(w.shown.map((n) => n.title)).not.toContain("This notification setup didn't finish.");
  });

  it('keeps the success when the same setup push arrives twice', async () => {
    const w = worker();
    const r = await pending(w.env);
    await w.fire('push', setupPush(r.started.op));
    await w.fire('push', setupPush(r.started.op));
    expect(w.shown.at(-1)!.title).toBe('Notifications are ready');
  });

  it.each([
    ['answered unknown', { answers: [{ result: 'unknown', activation: null }], readyFails: 0, during: 1 }],
    ['lost on its last try', { answers: [], readyFails: 3, during: 3 }],
  ])('closes quietly when the page finished this setup and moved on while /ready was %s', async (_, c) => {
    let env!: S.Env;
    let opId = '';
    const w = worker({
      answers: c.answers,
      readyFails: c.readyFails,
      // While the given /ready request is out, the page acknowledges, remembers the alert and starts a change.
      onReady: async (n) => {
        if (n !== c.during) return;
        const s = await S.readState(env);
        await S.recordResult(env, { op: opId, credential: s.credential!, result: 'active', activation: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1 } });
        const fp = await S.fingerprint(env, sub);
        await S.update(env, (t) => ({ state: { ...t, known: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, fingerprint: fp, endsAt: Date.now() + 1e9, choices: { siteIds: [486], applicants: 1, pace: 'asap' } }, knownVersion: t.knownVersion + 1 }, result: null }));
        await S.begin(env, { kind: 'change', choices: { siteIds: [693], applicants: 1, pace: 'asap' }, captured: { incarnation: 'i'.repeat(22), generation: 1, revision: 1 }, now: Date.now() + 200_000 });
      },
    });
    env = w.env;
    const r = await pending(w.env);
    opId = r.started.op;
    await w.fire('push', setupPush(r.started.op));
    const titles = w.shown.map((n) => n.title);
    expect(titles).not.toContain("This notification setup didn't finish.");
    expect(titles).not.toContain("Couldn't confirm the setup yet.");
  }, 15_000); // the retries wait 2 and 6 seconds for real

  it('says the setup did not finish, not "couldn\'t confirm yet", when it was turned off while /ready went unanswered', async () => {
    let env!: S.Env;
    const w = worker({
      answers: [],
      readyFails: 3,
      onReady: async (n) => {
        if (n === 3) await S.turnOff(env, { fingerprint: null });
      },
    });
    env = w.env;
    const r = await pending(w.env);
    await w.fire('push', setupPush(r.started.op));
    expect(w.shown.at(-1)!.title).toBe("This notification setup didn't finish.");
  }, 15_000);

  it('still shows alert pushes as before', async () => {
    const w = worker();
    await w.fire('push', { data: { json: () => ({ v: 1, title: 'Dates open at Antipolo', body: 'Fri 9 Oct · for 1 person · Checked 10:42', tag: 'alert-x', url: { office: 486 } }) } });
    expect(w.shown).toEqual([{ title: 'Dates open at Antipolo', body: 'Fri 9 Oct · for 1 person · Checked 10:42', tag: 'alert-x' }]);
  });
});
