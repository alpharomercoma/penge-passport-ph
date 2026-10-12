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

  it('finds who owns an address from the live records themselves, not the index pointer (missing here)', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_B, 'juan@example.com', { emailOn: '0', pushOn: '1' }));
    await kv.write([{ op: 'del', key: K.emailIndex(emailIndex('juan@example.com', keys.index)) }]);
    const before = await kv.hGetAll(K.subscriber(ID_B));
    const r = await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com')] });
    expect(r.skipped).toEqual([{ id: ID_A, reason: 'address-taken' }]);
    expect(await kv.hGetAll(K.subscriber(ID_B))).toEqual(before);
    expect(await kv.hGetAll(K.subscriber(ID_A))).toEqual({});
  });

  it.each([
    ['a live record whose address is not its index', async (kv: MemoryKv) => {
      await live(kv, { ...record(ID_A, 'pedro@example.com'), fields: { ...record(ID_A, 'pedro@example.com').fields, index: emailIndex('juan@example.com', keys.index) } });
    }],
    ['a live record of the wrong type', async (kv: MemoryKv) => {
      await kv.write([{ op: 'set', key: K.subscriber(ID_B), value: 'oops' }, { op: 'sAdd', key: K.allSubscribers, members: [ID_B] }]);
    }],
  ])('stops before writing anything when %s exists (whose address cannot be known)', async (_, damage) => {
    const kv = new MemoryKv();
    await damage(kv);
    const before = kv.dump();
    await expect(importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record('cccccccccccccccccccccc', 'ana@example.com'), record(ID_A, 'juan@example.com')] })).rejects.toThrow(/damaged/);
    expect(kv.dump()).toBe(before);
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

  it('skips a record whose address pointer has the wrong type, and still restores the others', async () => {
    const kv = new MemoryKv();
    await kv.write([{ op: 'sAdd', key: K.emailIndex(emailIndex('juan@example.com', keys.index)), members: ['x'] }]);
    const r = await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_B, 'ana@example.com'), record(ID_A, 'juan@example.com')] });
    expect(r).toMatchObject({ restored: 1, skipped: [{ id: ID_A, reason: 'damaged-keys' }] });
    expect(await kv.hGetAll(K.subscriber(ID_A))).toEqual({});
  });

  it('writes nothing when the restore lock is lost just before a record is written', async () => {
    const kv = new MemoryKv();
    const script = kv.script.bind(kv);
    kv.script = async (def, k, a) => {
      if (def.name === 'restore-one') await kv.set(K.importLock, 'another-restore');
      return script(def, k, a);
    };
    await expect(importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [record(ID_A, 'juan@example.com')] })).rejects.toThrow(/lock/);
    expect(await kv.hGetAll(K.subscriber(ID_A))).toEqual({});
    expect(await kv.get(K.importLock)).toBe('another-restore'); // not ours: left alone
  });

  it('restores a record from before paces existed as hourly, whatever pace it has now', async () => {
    const kv = new MemoryKv();
    await live(kv, record(ID_A, 'juan@example.com', { pace: 'asap' }));
    const old = record(ID_A, 'juan@example.com');
    const { pace: _p, ...fields } = old.fields;
    await importSubscribers(kv, keys, { version: 1, exportedAt: '', subscribers: [{ id: ID_A, fields }] });
    expect((await kv.hGetAll(K.subscriber(ID_A))).pace).toBe('hourly');
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
