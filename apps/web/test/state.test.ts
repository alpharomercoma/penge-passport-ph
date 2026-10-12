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

  it('attaches nothing while an unsubscribe claim stands: the claimed subscription is about to go', async () => {
    const e = env();
    const a = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    // A expires; B starts; A's late abandon claims its subscription F.
    const b = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T + 121_000 })) as { started: S.Operation };
    const fp = await S.fingerprint(e, sub);
    expect(await S.abandon(e, { op: a.started.op, fingerprint: fp, by: 'a' })).toMatchObject({ fingerprint: fp });
    expect(await S.attach(e, { op: b.started.op, epoch: b.started.epoch, subscription: sub, fingerprint: fp, by: 'b' })).toBe('abandoned');
  });

  it('finishes only an operation that has a result or is still preparing, never another caller\'s attached request', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'rotate', choices: null, captured: { incarnation: 'i', generation: 1 }, now: T })) as { started: S.Operation };
    const fp = await S.fingerprint(e, sub);
    await S.attach(e, { op: started.op, epoch: started.epoch, subscription: sub, fingerprint: fp, by: 'page' });
    await S.confirmReady(e, { op: started.op, by: 'page' });
    await S.finish(e, { op: started.op });
    expect((await S.readState(e)).op).toMatchObject({ op: started.op, phase: 'ready' });
    const two = env();
    const p = (await S.begin(two, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    await S.finish(two, { op: p.started.op });
    expect((await S.readState(two)).op).toBeNull();
  });

  it('marks sent only a ready (or sent) operation with its subscription, never a finished one', async () => {
    const e = env();
    const { started } = (await S.begin(e, { kind: 'setup', choices, captured: null, now: T })) as { started: S.Operation };
    expect(await S.markSent(e, { op: started.op, expiresAt: T + 300_000 })).toBe(false);
    const fp = await S.fingerprint(e, sub);
    await S.attach(e, { op: started.op, epoch: started.epoch, subscription: sub, fingerprint: fp, by: 'page' });
    expect(await S.markSent(e, { op: started.op, expiresAt: T + 300_000 })).toBe(false);
    await S.confirmReady(e, { op: started.op, by: 'page' });
    expect(await S.markSent(e, { op: started.op, expiresAt: T + 300_000 })).toBe(true);
    const s = await S.readState(e);
    await S.recordResult(e, { op: started.op, credential: s.credential!, result: 'expired', activation: null });
    expect(await S.markSent(e, { op: started.op, expiresAt: T + 600_000 })).toBe(false);
  });

  it('changes the rotation flag only for the credential and epoch that asked', async () => {
    const e = env();
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    const old = await S.readState(e);
    await S.setNeedsRotation(e, { on: true, credential: old.credential!, epoch: old.epoch });
    expect((await S.readState(e)).needsRotation).toBe(true);
    await S.turnOff(e, { fingerprint: null });
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T + 1 });
    const now = await S.readState(e);
    await S.setNeedsRotation(e, { on: true, credential: now.credential!, epoch: now.epoch });
    // The earlier caller's late clear changes nothing.
    await S.setNeedsRotation(e, { on: false, credential: old.credential!, epoch: old.epoch });
    expect((await S.readState(e)).needsRotation).toBe(true);
  });

  it('reads and writes a change in one IndexedDB transaction', async () => {
    const e = env();
    const factory = e.indexedDB!;
    const kinds: string[] = [];
    const open = factory.open.bind(factory);
    (factory as unknown as { open: typeof open }).open = (...args: Parameters<typeof open>) => {
      const req = open(...args);
      req.addEventListener('success', () => {
        const db = req.result;
        const tx = db.transaction.bind(db);
        (db as unknown as { transaction: typeof tx }).transaction = ((names: string, mode?: IDBTransactionMode) => (kinds.push(mode ?? 'readonly'), tx(names, mode))) as typeof tx;
      });
      return req;
    };
    await S.begin(e, { kind: 'setup', choices, captured: null, now: T });
    expect(kinds).toEqual(['readwrite']);
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
