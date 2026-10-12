// Subscribers live only in Redis. Once a day the checker copies them, exactly
// as stored (addresses stay encrypted), to R2; `admin.mjs restore` puts a copy
// back. A backup is useless without the EMAIL_ENC_KEY that sealed it (and the
// EMAIL_HMAC_KEY its indexes were made with). Backups hold email subscribers
// only, in version 1, the format of the release before push; notification
// alerts are never in a backup and a restore never touches them.
import { isPace, LIMITS } from '@penge/contracts';
import { decryptEmail, emailIndex, randomToken } from './crypto.ts';
import { K } from './keys.ts';
import type { Kv, ScriptDef } from './kv.ts';
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
  // A record from before paces existed is hourly, as load() reads it; written so, it replaces any pace stored now.
  clean.pace ??= 'hourly';
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
/**
 * One record restored atomically. KEYS: the restore lock, the subscriber, its address pointer, the set of all
 * subscribers, then every office set it touches. Answers 'lost' (the lock is not this restore's), a skip reason, or 'ok'.
 * Every check comes before the first write: types ('damaged-keys'), this id holding another address ('id-taken'),
 * email off now ('email-off-now'), the address pointing at another live record ('address-taken').
 */
const RESTORE_ONE: ScriptDef = {
  name: 'restore-one',
  lua: `#!lua
local a = cjson.decode(ARGV[2])
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'lost' end
local function typed(k, t) local g = redis.call('TYPE', k).ok return g == 'none' or g == t end
if not typed(KEYS[2], 'hash') or not typed(KEYS[3], 'string') or not typed(KEYS[4], 'set') then return 'damaged-keys' end
for i = 5, #KEYS do if not typed(KEYS[i], 'set') then return 'damaged-keys' end end
if redis.call('EXISTS', KEYS[2]) == 1 and redis.call('HGET', KEYS[2], 'index') ~= a.index then return 'id-taken' end
local on = redis.call('HGET', KEYS[2], 'emailOn')
if on and on ~= '1' then return 'email-off-now' end
local owner = redis.call('GET', KEYS[3])
if owner and owner ~= a.id and redis.call('TYPE', a.subPrefix .. owner).ok ~= 'none' then return 'address-taken' end
for _, k in ipairs(a.dropped) do redis.call('SREM', k, a.id) end
redis.call('HDEL', KEYS[2], unpack(a.channelFields))
local flat = {}
for f, v in pairs(a.fields) do flat[#flat + 1] = f flat[#flat + 1] = v end
redis.call('HSET', KEYS[2], unpack(flat))
redis.call('SET', KEYS[3], a.id)
redis.call('SADD', KEYS[4], a.id)
for _, k in ipairs(a.sites) do redis.call('SADD', k, a.id) end
return 'ok'`,
};

/** Releases the restore lock only if it is still this restore's (compare and delete, atomically). */
const RELEASE: ScriptDef = {
  name: 'import-release',
  lua: "#!lua flags=allow-oom\nif redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end return 'ok'",
};

/**
 * Who every live subscriber is, from their records themselves (their sealed address decrypted and its index computed),
 * never from the index pointers, which a damaged store may lack or contradict. A record that cannot be read so (wrong
 * type, unreadable address, or an index that is not its address's) stops the restore before anything is written.
 */
async function liveIdentities(kv: Kv, keys: Keys, extraIds: string[], extraSites: number[]) {
  const ids = new Set<string>([...(await kv.sMembers(K.allSubscribers)), ...extraIds]);
  const raw = await kv.get(K.sites);
  const siteIds = new Set<number>([...extraSites, ...(raw ? (JSON.parse(raw) as { id: number }[]).map((s) => s.id) : [])]);
  // An office set of the wrong type is left to the per-record check, which skips the records needing it ('damaged-keys').
  for (const siteId of siteIds) {
    if ((await kv.script(TYPE, [K.siteSubscribers(siteId)], [])) !== 'set') continue;
    for (const id of await kv.sMembers(K.siteSubscribers(siteId))) ids.add(id);
  }
  const byId = new Map<string, { index: string; emailOff: boolean }>();
  const byIndex = new Map<string, Set<string>>();
  for (const id of ids) {
    const type = await kv.script(TYPE, [K.subscriber(id)], []);
    if (type === 'none') continue;
    if (type !== 'hash') throw new Error(`live subscriber ${id} is damaged (its record is a ${type}); fix it before restoring`);
    const h = await kv.hGetAll(K.subscriber(id));
    if (Object.keys(h).length === 0) continue;
    let index: string;
    try {
      index = emailIndex(decryptEmail(h.email ?? '', keys.email), keys.index);
    } catch {
      throw new Error(`live subscriber ${id} is damaged (its address cannot be read); fix it before restoring`);
    }
    if (h.index !== index) throw new Error(`live subscriber ${id} is damaged (its address is not its index); fix it before restoring`);
    byId.set(id, { index, emailOff: h.emailOn !== undefined && h.emailOn !== '1' });
    byIndex.set(index, new Set([...(byIndex.get(index) ?? []), id]));
  }
  return { byId, byIndex };
}

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
    // Read before anything is written: a damaged live record stops the whole restore here.
    const live = await liveIdentities(kv, keys, records.map((r) => r.id), records.flatMap((r) => r.sites));
    const skipped: { id: string; reason: Skip }[] = [];
    let restored = 0;
    for (const r of records) {
      // Still this restore's lock (an hour), checked before each record.
      if ((await kv.get(K.importLock)) !== lock) throw new Error('the restore lock expired or was taken; stopped');
      // By the records themselves: an address another live subscriber holds, or this id holding another address.
      const owners = [...(live.byIndex.get(r.fields.index!) ?? [])].filter((id) => id !== r.id);
      if (owners.length > 0) {
        skipped.push({ id: r.id, reason: 'address-taken' });
        continue;
      }
      const here = live.byId.get(r.id);
      if (here && here.index !== r.fields.index) {
        skipped.push({ id: r.id, reason: 'id-taken' });
        continue;
      }
      if (here?.emailOff) {
        skipped.push({ id: r.id, reason: 'email-off-now' });
        continue;
      }
      await withAddressLock(kv, r.fields.index!, async () => {
        // The record as it is now (its type was checked with every live identity): the offices it follows and the
        // backup does not name are left.
        const current = await kv.hGetAll(K.subscriber(r.id));
        const dropped = (current.sites ?? '').split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0 && !r.sites.includes(n));
        const sites = [...new Set([...dropped, ...r.sites])].map((n) => K.siteSubscribers(n));
        // One atomic step: still this restore's lock, every key's type, the identity checks again, then the writes.
        const out = await kv.script(
          RESTORE_ONE,
          [K.importLock, K.subscriber(r.id), K.emailIndex(r.fields.index!), K.allSubscribers, ...sites],
          [lock, JSON.stringify({ id: r.id, index: r.fields.index, fields: r.fields, dropped: dropped.map((n) => K.siteSubscribers(n)), sites: r.sites.map((n) => K.siteSubscribers(n)), subPrefix: K.subscriber(''), channelFields: CHANNEL_FIELDS })],
        );
        if (out === 'lost') throw new Error('the restore lock expired or was taken; stopped');
        if (out !== 'ok') {
          skipped.push({ id: r.id, reason: out as Skip });
          return;
        }
        restored++;
      });
    }
    return { restored, skipped, emailOff: checked.length - records.length };
  } finally {
    await kv.script(RELEASE, [K.importLock], [lock]);
  }
}
