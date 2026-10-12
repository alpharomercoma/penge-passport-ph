import { afterEach, describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import type { Kv } from '../src/kv.ts';
import { cleanChannels, dumpChannels, inspectChannels } from '../src/migrate.ts';
import { valkeyTargets } from './valkey.ts';

/** Every key with its type, value and whether it expires: the same on MemoryKv and on Valkey. */
async function snapshot(kv: Kv) {
  const out: Record<string, unknown> = {};
  for (const key of (await kv.scan('*')).filter((k) => k !== K.testMark).sort()) {
    const type = await kv.script({ name: 'type', lua: "#!lua flags=no-writes\nreturn redis.call('TYPE', KEYS[1]).ok" }, [key], []);
    const ttl = Number(await kv.script({ name: 'ttl', lua: "#!lua flags=no-writes\nreturn tostring(redis.call('PTTL', KEYS[1]))" }, [key], []));
    const value = type === 'string' ? await kv.get(key) : type === 'hash' ? await kv.hGetAll(key) : type === 'set' ? (await kv.sMembers(key)).sort() : type;
    out[key] = { type, value, expires: ttl >= 0 };
  }
  return JSON.stringify(out);
}

/** Data as the channel release (05cee09) could have left it. */
async function channelData(kv: Kv, o: { emailOff?: boolean } = {}) {
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

const open: Kv[] = [];
afterEach(async () => {
  for (const kv of open.splice(0)) await kv.close();
});

describe.each(valkeyTargets())('leaving the channel design (%s)', (_target, make) => {
  const fresh = async () => {
    const kv = await make();
    open.push(kv);
    return kv;
  };

  it('finds every channel key and field, and never the new ones (paused, backoff)', async () => {
    const kv = await fresh();
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
    const kv = await fresh();
    await channelData(kv);
    const dump = await dumpChannels(kv, await inspectChannels(kv));
    expect(Object.keys(dump).sort()).toEqual(['pp:pending:channels', 'pp:pending:t1', 'pp:pending:t2', 'pp:pending-idx:idxP', 'pp:push:A', 'pp:push:cred:cred', 'pp:push:endpoint:ep', 'pp:push:meta:A', 'pp:reserved:idxP', 'pp:reserved:idxQ', 'pp:sub:A'].sort());
    expect(dump['pp:push:meta:A']).toEqual({ d1: 'r|1|cred|ep|sh' });
  });

  it('the dump holds every key the clean changes or deletes (a cancelled request\'s index set too, sole member or not)', async () => {
    const kv = await fresh();
    await channelData(kv);
    // idxQ's index set holds the kept request and an unrelated one; idxP's holds only the cancelled one.
    await kv.write([{ op: 'sAdd', key: K.pendingFor('idxQ'), members: ['t2', 'other'] }]);
    const before = JSON.parse(await snapshot(kv)) as Record<string, unknown>;
    const dump = await dumpChannels(kv, await inspectChannels(kv));
    await cleanChannels(kv, await inspectChannels(kv));
    const after = JSON.parse(await snapshot(kv)) as Record<string, unknown>;
    const touched = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((k) => !(k in dump))).toEqual([]);
  });

  it('cleans by the table: push keys deleted, fields removed, email-off requests cancelled, the rest kept as email', async () => {
    const kv = await fresh();
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
    const kv = await fresh();
    await channelData(kv, { emailOff: true });
    const i = await inspectChannels(kv);
    expect(i.stops).toEqual(['B: email off']);
    const before = (await snapshot(kv));
    await expect(cleanChannels(kv, i)).rejects.toThrow(/B: email off/);
    expect((await snapshot(kv))).toBe(before);
  });

  it('finds an email-off subscriber reachable only through an office, and stops', async () => {
    const kv = await fresh();
    await channelData(kv);
    await kv.write([
      { op: 'hSet', key: K.subscriber('C'), fields: { email: 'v1.z', index: 'idxC', sites: '486', applicants: '1', emailOn: '0' } },
      { op: 'sAdd', key: K.siteSubscribers(486), members: ['C'] },
    ]);
    const i = await inspectChannels(kv);
    expect(i.stops).toEqual(expect.arrayContaining(['C: has a record but is not in the list of all subscribers', 'C: email off']));
    const before = (await snapshot(kv));
    await expect(cleanChannels(kv, i)).rejects.toThrow(/owner decides/);
    expect((await snapshot(kv))).toBe(before);
  });

  it('stops on malformed flags anywhere, changing nothing', async () => {
    const kv = await fresh();
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
    const kv = await fresh();
    await channelData(kv);
    await kv.set(K.pending('t4'), JSON.stringify({ sealedEmail: 'v1.r', index: 'idxP', siteIds: [486], applicants: 1, requestedAt: '' }), { ttlSeconds: 600 });
    await kv.set(K.pending('t2'), (await kv.get(K.pending('t2')))!, { ttlSeconds: 900 });
    await cleanChannels(kv, await inspectChannels(kv));
    expect(await kv.get('pp:reserved:idxP')).toBe('R1'); // t1 was cancelled, but t4 (no channels) still needs it
    const ttl = await kv.script({ name: 't', lua: "#!lua\nreturn tostring(redis.call('TTL', KEYS[1]))" }, [K.pending('t2')], []);
    expect(Number(ttl)).toBeGreaterThan(890);
    expect(Number(ttl)).toBeLessThanOrEqual(900);
  });

  it('scans only with * and ?, the same on MemoryKv and Valkey, and refuses any other pattern', async () => {
    const kv = await fresh();
    await kv.set('pp:x:A', '1');
    await kv.set('pp:x:BC', '1');
    expect((await kv.scan('pp:x:?')).sort()).toEqual(['pp:x:A']);
    expect((await kv.scan('pp:x:*')).sort()).toEqual(['pp:x:A', 'pp:x:BC']);
    for (const pattern of ['pp:x:[AB]', 'pp:x:\\*', 'pp:x:[^A]*']) await expect(kv.scan(pattern)).rejects.toThrow(/only \* and \?/);
    // As Valkey matches: over bytes (é is two in UTF-8), and * across a newline.
    await kv.set('pp:y:é', '1');
    await kv.set('pp:y:A\nB', '1');
    expect(await kv.scan('pp:y:?')).toEqual([]);
    expect(await kv.scan('pp:y:??')).toEqual(['pp:y:é']);
    expect(await kv.scan('pp:y:A*')).toEqual(['pp:y:A\nB']);
    // A trailing newline is a byte like any other: neither a literal pattern nor ? ends before it.
    await kv.set('pp:z:A\n', '1');
    expect(await kv.scan('pp:z:A')).toEqual([]);
    expect(await kv.scan('pp:z:?')).toEqual([]);
    expect(await kv.scan('pp:z:??')).toEqual(['pp:z:A\n']);
  });

  it('is idempotent', async () => {
    const kv = await fresh();
    await channelData(kv);
    await cleanChannels(kv, await inspectChannels(kv));
    const after = (await snapshot(kv));
    await cleanChannels(kv, await inspectChannels(kv));
    expect((await snapshot(kv))).toBe(after);
  });
});
