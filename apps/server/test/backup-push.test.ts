import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Backup, exportSubscribers, importSubscribers, pushDowngrade, toV1 } from '../src/backup.ts';
import { emailIndex, encryptEmail } from '../src/crypto.ts';
import { K } from '../src/keys.ts';
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

  it('leaves a restored subscriber only in the offices of the backup', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    const a = await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: false });
    const backup = await exportSubscribers(kv, [486], t.now());
    backup.subscribers[0]!.fields.sites = '693';
    await importSubscribers(kv, backup);
    expect(await kv.sMembers(K.siteSubscribers(486))).toEqual([]);
    expect(await kv.sMembers(K.siteSubscribers(693))).toEqual([a]);
  });

  it('refuses a backup with a malformed channel flag or group size, before writing anything', async () => {
    const t = clock(); const kv = new MemoryKv(t.now);
    await signUp(kv, t.now(), 'juan@example.com', { emailOn: true, pushOn: false });
    await signUp(kv, t.now(), 'ana@example.com', { emailOn: true, pushOn: false });
    const good = await exportSubscribers(kv, [486], t.now());
    for (const bad of [{ emailOn: 0 }, { emailOn: false }, { emailOn: null }, { pushOn: 'yes' }, { applicants: undefined }, { applicants: '0' }, { applicants: '6' }, { applicants: '1.5' }]) {
      const fresh = new MemoryKv(t.now);
      const backup = structuredClone(good);
      Object.assign(backup.subscribers[1]!.fields, bad);
      if ('applicants' in bad && bad.applicants === undefined) delete backup.subscribers[1]!.fields.applicants;
      await expect(importSubscribers(fresh, backup as Backup)).rejects.toThrow(/bad subscriber/);
      expect(fresh.keys()).toEqual([]);
    }
  });
});
