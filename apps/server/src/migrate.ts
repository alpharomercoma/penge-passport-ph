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

/** Every key the clean changes or deletes, with its value, for `channel-keys-<stamp>-expires-<stamp>.json`. */
export async function dumpChannels(kv: Kv, i: Inspection): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  // The index sets of the requests the clean cancels: it removes their entries (and a set left empty goes with them).
  const indexSets = [...new Set(i.pending.filter((p) => !p.emailOn && p.index).map((p) => K.pendingFor(p.index)))];
  const keys = [...i.pushKeys, ...i.reservedKeys, ...i.pending.map((p) => p.key), ...indexSets, ...i.subscribers.map((s) => K.subscriber(s.id)), ...(i.pendingChannels ? ['pp:pending:channels'] : [])];
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
