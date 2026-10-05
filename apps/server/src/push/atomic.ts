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
  // As the Lua pattern '^([^/]+)/(.+)$': both parts non-empty.
  if (slash <= 0 || slash === owner.length - 1) return false;
  const mk = `${metaPrefix}${owner.slice(0, slash)}`;
  if (tx.type(mk) !== 'hash') return false;
  return tx.hGet(mk, owner.slice(slash + 1)) !== null;
}
const tryMeta = (raw: string): Meta | null => {
  try {
    return parseMeta(raw);
  } catch {
    return null;
  }
};
const typeOk = (tx: ScriptTx, key: string, want: string) => {
  const t = tx.type(key);
  return t === 'none' || t === want;
};

// KEYS: cred, revoked, meta, devices, subscriber, reserved, address
// ARGV: subscriberId, deviceId, credentialHash, sealedAwaiting, provisionalTtl, maxDevices, metaPrefix, addressIndex, credPrefix
const BIND: ScriptDef = {
  name: 'pushBind',
  lua: `${LUA}
if not (typeOk(KEYS[1], 'string') and typeOk(KEYS[2], 'string') and typeOk(KEYS[3], 'hash') and typeOk(KEYS[4], 'hash') and typeOk(KEYS[5], 'hash') and typeOk(KEYS[6], 'string') and typeOk(KEYS[7], 'string')) then return 'wrongtype' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'revoked' end
local me = ARGV[1] .. '/' .. ARGV[2]
local owner = redis.call('GET', KEYS[1])
if owner and owner ~= me and ownerAlive(owner, ARGV[7]) then return 'owned' end
local slot = redis.call('HGET', KEYS[3], ARGV[2])
if slot then
  local st, rv, cr = meta(slot)
  if not st then return 'wrongtype' end
  -- A device keeps one credential for life: another never replaces it.
  if cr ~= ARGV[3] then return 'owned' end
  if owner ~= me then
    redis.call('SET', KEYS[1], me)
    local left = redis.call('PTTL', KEYS[3])
    if left > 0 then redis.call('PEXPIRE', KEYS[1], left) end
  end
  return 'kept'
end
if redis.call('HLEN', KEYS[3]) >= tonumber(ARGV[6]) then return 'full' end
local provisional = redis.call('EXISTS', KEYS[5]) == 0
local ttl = tonumber(ARGV[5])
-- Every device of a subscriber that does not exist yet lives as long as the newest, credentials included.
local extend = {}
if provisional then
  local all = redis.call('HGETALL', KEYS[3])
  for i = 1, #all, 2 do
    local st, rv, cr = meta(all[i + 1])
    if not st then return 'wrongtype' end
    if cr ~= '' then
      local ck = ARGV[9] .. cr
      if not typeOk(ck, 'string') then return 'wrongtype' end
      if redis.call('GET', ck) == ARGV[1] .. '/' .. all[i] then extend[#extend + 1] = ck end
    end
  end
end
local reservedLeft = redis.call('PTTL', KEYS[6])
redis.call('SET', KEYS[1], me)
redis.call('HSET', KEYS[3], ARGV[2], 'a|0|' .. ARGV[3] .. '||')
redis.call('HSET', KEYS[4], ARGV[2], ARGV[4])
if provisional then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
  redis.call('EXPIRE', KEYS[4], ttl)
  for _, ck in ipairs(extend) do redis.call('EXPIRE', ck, ttl) end
  redis.call('SET', KEYS[7], ARGV[8], 'EX', ttl)
  -- In milliseconds: whole seconds would read a reservation ending a moment sooner as long enough.
  -- One without an expiry keeps none.
  if reservedLeft >= 0 and reservedLeft < ttl * 1000 then redis.call('EXPIRE', KEYS[6], ttl) end
end
return 'bound'`,
  memory(tx, k, a) {
    const [cred, revoked, metaKey, devicesKey, subscriberKey, reservedKey, addressKey] = k as [string, string, string, string, string, string, string];
    const [sub, dev, credHash, sealed, ttlRaw, maxRaw, metaPrefix, addressIndex, credPrefix] = a as [string, string, string, string, string, string, string, string, string];
    if (!(typeOk(tx, cred, 'string') && typeOk(tx, revoked, 'string') && typeOk(tx, metaKey, 'hash') && typeOk(tx, devicesKey, 'hash') && typeOk(tx, subscriberKey, 'hash') && typeOk(tx, reservedKey, 'string') && typeOk(tx, addressKey, 'string'))) return 'wrongtype';
    if (tx.exists(revoked)) return 'revoked';
    const me = `${sub}/${dev}`;
    const owner = tx.get(cred);
    if (owner && owner !== me && ownerAlive(tx, owner, metaPrefix)) return 'owned';
    const slot = tx.hGet(metaKey, dev);
    if (slot !== null) {
      const m = tryMeta(slot);
      if (!m) return 'wrongtype';
      if (m.credentialHash !== credHash) return 'owned';
      if (owner !== me) {
        tx.set(cred, me);
        const left = tx.pttl(metaKey);
        if (left > 0) tx.expire(cred, left / 1000);
      }
      return 'kept';
    }
    if (tx.hLen(metaKey) >= Number(maxRaw)) return 'full';
    const provisional = !tx.exists(subscriberKey);
    const ttl = Number(ttlRaw);
    const extend: string[] = [];
    if (provisional) {
      for (const [field, raw] of Object.entries(tx.hGetAll(metaKey))) {
        const m = tryMeta(raw);
        if (!m) return 'wrongtype';
        if (m.credentialHash === '') continue;
        const ck = `${credPrefix}${m.credentialHash}`;
        if (!typeOk(tx, ck, 'string')) return 'wrongtype';
        if (tx.get(ck) === `${sub}/${field}`) extend.push(ck);
      }
    }
    const reservedLeft = tx.pttl(reservedKey);
    tx.set(cred, me);
    tx.hSet(metaKey, dev, `a|0|${credHash}||`);
    tx.hSet(devicesKey, dev, sealed);
    if (provisional) {
      tx.expire(cred, ttl);
      tx.expire(metaKey, ttl);
      tx.expire(devicesKey, ttl);
      for (const ck of extend) tx.expire(ck, ttl);
      tx.set(addressKey, addressIndex);
      tx.expire(addressKey, ttl);
      if (reservedLeft >= 0 && reservedLeft < ttl * 1000) tx.expire(reservedKey, ttl);
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
    [a.subscriberId, a.deviceId, a.credentialHash, a.sealedAwaiting, String(a.provisionalTtlSeconds), String(a.maxDevices), K.pushMeta(''), a.addressIndex, K.pushCred('')],
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
