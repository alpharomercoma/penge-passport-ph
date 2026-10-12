// The API's atomic steps for notification alerts (spec: "Setting up, with the ready check", steps 3 and 4).
// Each checks every key's type first, so a failure writes nothing; refusals write nothing either, except the
// tidying the spec asks for in passing (an expired operation ended, the credential's own ended alert ended).
import type { Activation, ReadyResult } from '@penge/contracts';
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { deviceScript } from './lua.ts';
import { STORE_LIB } from './store-lua.ts';
import { type OpRecord, RECLAIM_BATCH } from './store.ts';

export interface RateItem {
  cur: string;
  prev: string;
  overlap: number;
  max: number;
  ttl: number;
  bucket: string;
}

export interface AdmitInput {
  now: number;
  /** The credential's SHA-256. */
  cred: string;
  op: string;
  seq: number;
  kind: 'setup' | 'rotate';
  /** A setup's captured alert, or a rotation's incarnation and generation; false for a first setup. */
  cap: { incarnation: string; generation: number; revision?: number } | false;
  digest: string;
  ep: string;
  fp: string;
  svc: string;
  sealed: string;
  /** SHA-256 of the nonce: what the acknowledgement is compared with. */
  nh: string;
  /** SHA-256 of the owner token this setup came with, or "". */
  tok: string;
  exp: number;
  /** The "new setups stored" counters (first setups only). */
  stored: RateItem[];
  alertLimit: number;
  recordLimit: number;
}

export const admitScript = deviceScript(
  'dev-admit',
  `${STORE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.endpoint, 'string') need(K.backoff, 'string') need_store()
-- The stored counters are read (so checked) here too: rate_room runs only after the expired operation is ended.
for i = 1, #A.stored do need(A.stored[i].cur, 'string') need(A.stored[i].prev, 'string') counter(A.stored[i].cur) counter(A.stored[i].prev) end
local cred = A.cred
-- Everything this step reads, read (and so type-checked) before its first write.
local o = hgetall(K.op)
local alertId = redis.call('GET', K.cred) or nil
local a = alert_get(alertId)
local owner = redis.call('GET', K.endpoint) or nil
local oa = alert_get(owner)
local co = {}
if oa and oa.cand ~= nil and oa.cand ~= '' and oa.cand ~= cred then need(KEY.op .. oa.cand, 'hash') co = hgetall(KEY.op .. oa.cand) end
alert_check(alertId, a) alert_check(owner, oa) op_check(cred, o)
if co.exp ~= nil and co.exp ~= '' then integer(co.exp, 'candidate exp') end
local function refuse(why) count('refused_' .. why) return cjson.encode({ outcome = why }) end
-- A repeat of the credential's current or last operation answers its state and changes nothing.
if o.op == A.op then
  if o.digest == A.digest then return cjson.encode({ outcome = 'repeat', o = o }) end
  return refuse('invalid')
end
local highest = tonumber(o.maxseq or '0') or 0
if a then highest = math.max(highest, tonumber(a.seq or '0') or 0) end
if A.seq <= highest then return refuse('invalid') end
if o.op ~= nil and o.result == '' and N(o.exp) > NOW then return refuse('busy') end
-- Admitted only if its push can be sent now: the stop and the push service's backoff, checked again here, atomically.
if redis.call('EXISTS', KEY.paused) == 1 then return refuse('unavailable') end
if counter(K.backoff) > NOW then return refuse('unavailable') end
-- Tidying the spec asks for in passing: valid whatever happens next.
if o.op ~= nil and o.result == '' then
  op_finish(cred, o, 'expired')
  -- Finishing an expired rotation can delete the alert (its old subscription was gone): read it again.
  alertId = redis.call('GET', K.cred) or nil
  a = alert_get(alertId)
  owner = redis.call('GET', K.endpoint) or nil
  oa = alert_get(owner)
end
if a and is_ended(a) then
  alert_delete(alertId, a, 'ended')
  if owner == alertId then owner = nil oa = nil end
  a = nil
  alertId = nil
end
local cap = A.cap
if A.kind == 'setup' and not cap then
  if a then return refuse('changed') end
elseif A.kind == 'setup' then
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation or N(a.rev) ~= cap.revision then return refuse('changed') end
else
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation then return refuse('changed') end
end
local rsv, other = '', ''
local units = 0
if redis.call('EXISTS', K.op) == 0 then units = 1 end
if A.kind == 'setup' and not cap then
  if oa and not is_ended(oa) then
    -- One replacement candidate per endpoint: another credential's unfinished, unexpired setup for it blocks this one.
    if co.result == '' and co.other == owner and N(co.exp) > NOW then return refuse('busy') end
    if rec('repl') + 1 > math.floor(A.alertLimit / 10) then return refuse('full') end
    rsv = 'repl'
    other = owner
  else
    if rec('alerts') + 1 > A.alertLimit then return refuse('full') end
    rsv = 'alert'
  end
  units = units + ALERT_UNITS
  for i = 1, #A.stored do
    local it = A.stored[i]
    if not rate_room(it.cur, it.prev, it.overlap, it.max) then return refuse('limited') end
  end
end
if rec('units') + units > A.recordLimit then return refuse('full') end
if A.kind == 'setup' and not cap then for i = 1, #A.stored do rate_take(A.stored[i].cur, A.stored[i].ttl) end end
if rsv == 'alert' then rec_add('alerts', 1) end
if rsv == 'repl' then rec_add('repl', 1) redis.call('HSET', KEY.alert .. other, 'cand', cred) end
rec_add('units', units)
local maxseq = math.max(highest, A.seq)
local capJson = ''
if cap then capJson = cjson.encode(cap) end
redis.call('DEL', K.op)
redis.call('HSET', K.op, 'op', A.op, 'seq', I(A.seq), 'maxseq', I(maxseq), 'kind', A.kind, 'digest', A.digest, 'cap', capJson,
  'alert', alertId or '', 'rsv', rsv, 'other', other, 'exp', I(A.exp), 'dsp', 'unsent', 'did', '', 'dspAt', '', 'retry', I(NOW),
  'why', '', 'result', '', 'act', '', 'done', '', 'sealed', A.sealed, 'nh', A.nh, 'ep', A.ep, 'fp', A.fp, 'svc', A.svc,
  'tok', A.tok, 'acks', '0', 'started', I(NOW))
if a then redis.call('HSET', KEY.alert .. alertId, 'seq', I(maxseq)) end
redis.call('ZADD', KEY.ops, A.exp, cred)
redis.call('ZREM', KEY.deadlines, 'op|' .. cred)
count('ops_started')
return cjson.encode({ outcome = 'pending', o = hgetall(K.op) })
`,
);

export async function admit(kv: Kv, a: AdmitInput): Promise<{ outcome: 'pending' | 'repeat' | 'busy' | 'invalid' | 'changed' | 'full' | 'limited' | 'unavailable'; o?: OpRecord }> {
  // The endpoint index is passed as a key; the alert record of its owner is reached by prefix.
  return admitScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), endpoint: K.devEndpoint(a.ep), backoff: K.pushBackoff(a.svc) }, { ...a });
}

export const dispatchBeginScript = deviceScript(
  'dev-dispatch-begin',
  `${STORE_LIB}
need(K.op, 'hash') need(K.backoff, 'string') need(K.endpoint, 'string') need_store()
local o = hgetall(K.op)
-- Everything finishing the operation may touch (an expired rotation can delete its alert) is checked before any write.
op_check(A.cred, o)
if o.op ~= A.op or o.result ~= '' then return cjson.encode({ go = false, o = o }) end
if N(o.exp) <= NOW then op_finish(A.cred, o, 'expired') return cjson.encode({ go = false, o = hgetall(K.op) }) end
if o.dsp ~= 'unsent' and o.dsp ~= 'retryable' then return cjson.encode({ go = false, o = o }) end
local function hold(why, at)
  redis.call('HSET', K.op, 'why', why, 'retry', I(at))
  count('dispatch_held_' .. why)
  return cjson.encode({ go = false, o = hgetall(K.op) })
end
if not A.modeOk then return hold('mode', NOW + 30000) end
if redis.call('EXISTS', KEY.paused) == 1 then return hold('paused', NOW + 30000) end
local b = tonumber(redis.call('GET', K.backoff) or '0') or 0
if b > NOW then return hold('backoff', b) end
-- A setup with a captured alert or a rotation spends its alert's maintenance pool; any setup push to an endpoint
-- whose alert this credential does not own also spends that endpoint's (spec: "Setup pushes to one endpoint from
-- credentials that do not own its alert"), so a rotation naming another browser's subscription is held to it too.
local items = {}
if o.cap ~= '' then for i = 1, #A.maintItems do items[#items + 1] = A.maintItems[i] end end
local owner = redis.call('GET', K.endpoint) or nil
if owner then need(KEY.alert .. owner, 'hash') end
if not owner or redis.call('HGET', KEY.alert .. owner, 'cred') ~= A.cred then
  for i = 1, #A.epItems do items[#items + 1] = A.epItems[i] end
end
for i = 1, #items do need(items[i].cur, 'string') need(items[i].prev, 'string') end
for i = 1, #items do
  if not rate_room(items[i].cur, items[i].prev, items[i].overlap, items[i].max) then return hold('limited', NOW + 30000) end
end
for i = 1, #items do rate_take(items[i].cur, items[i].ttl) end
redis.call('HSET', K.op, 'dsp', 'sending', 'did', A.did, 'dspAt', I(NOW), 'why', '')
return cjson.encode({ go = true, o = hgetall(K.op) })
`,
);

export function dispatchBegin(
  kv: Kv,
  a: { now: number; cred: string; op: string; did: string; svc: string; ep: string; modeOk: boolean; epItems: RateItem[]; maintItems: RateItem[] },
): Promise<{ go: boolean; o: OpRecord }> {
  return dispatchBeginScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), backoff: K.pushBackoff(a.svc), endpoint: K.devEndpoint(a.ep) }, { ...a });
}

export const dispatchEndScript = deviceScript(
  'dev-dispatch-end',
  `${STORE_LIB}
need(K.op, 'hash') need(K.backoff, 'string') need_store()
local o = hgetall(K.op)
op_check(A.cred, o)
if o.op ~= A.op or o.did ~= A.did or o.dsp ~= 'sending' or o.result ~= '' then return '{"ok":false}' end
local b = tonumber(redis.call('GET', K.backoff) or '0') or 0
if A.backoffUntil and A.backoffUntil > b then
  redis.call('SET', K.backoff, I(A.backoffUntil))
  b = A.backoffUntil
end
count('dispatch_' .. A.outcome)
if A.outcome == 'accepted' or A.outcome == 'uncertain' then
  redis.call('HSET', K.op, 'dsp', A.outcome)
elseif A.outcome == 'retryable' then
  redis.call('HSET', K.op, 'dsp', 'retryable', 'retry', I(math.max(NOW, b)))
else
  -- Spec step 4: bug and gone both leave the dispatch state failed; the result says which.
  redis.call('HSET', K.op, 'dsp', 'failed')
  op_finish(A.cred, o, A.outcome)
end
return '{"ok":true}'
`,
);

export function dispatchEnd(
  kv: Kv,
  a: { now: number; cred: string; op: string; did: string; svc: string; outcome: 'accepted' | 'uncertain' | 'retryable' | 'failed' | 'gone'; backoffUntil: number | null },
): Promise<{ ok: boolean }> {
  return dispatchEndScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), backoff: K.pushBackoff(a.svc) }, { ...a, backoffUntil: a.backoffUntil ?? false });
}

export const reclaimScript = deviceScript(
  'dev-reclaim',
  `${STORE_LIB}
need_store()
return cjson.encode(reclaim(A.limit))
`,
  { reclaim: true },
);

export function reclaim(kv: Kv, now: number, limit = RECLAIM_BATCH): Promise<{ expired: number; ended: number; deleted: number }> {
  return reclaimScript.run(kv, { stats: statsKey(now) }, { now, limit });
}

export const statsKey = (now: number) => K.statsV2(manilaDay(now));

/** The subscription and choices Node unsealed from the operation, the subscription sealed again for the alert. */
export interface Prepared {
  sub: string;
  ep: string;
  fp: string;
  svc: string;
  offices?: string;
  group?: string;
  pace?: string;
}

const ACTIVATE_LIB = `
local function index_sites(id, offices, group)
  for office in string.gmatch(offices, '[^,]+') do redis.call('SADD', KEY.site .. office, id .. ':' .. group) end
end
local function unindex_sites(id, offices, group)
  for office in string.gmatch(offices, '[^,]+') do redis.call('SREM', KEY.site .. office, id .. ':' .. group) end
end
-- The endpoint now belongs to this alert: any other alert holding it is deleted (proof of the endpoint wins).
local function take_endpoint(id, epKey, epOwner, x)
  if x then
    local why = 'replaced'
    if is_ended(x) then why = 'ended' end
    alert_delete(epOwner, x, why)
  end
  redis.call('SET', epKey, id)
end
`;

export const readyScript = deviceScript(
  'dev-ready',
  `${STORE_LIB}${ACTIVATE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.endpoint, 'string') need(KEY.order, 'string') need_store()
local cred = A.cred
local o = hgetall(K.op)
if o.op == nil or o.op ~= A.op then return cjson.encode({ result = 'unknown' }) end
if o.result ~= '' then
  local act = false
  if o.act ~= '' then act = cjson.decode(o.act) end
  return cjson.encode({ result = o.result, activation = act })
end
if o.kind == 'change' then return cjson.encode({ result = 'invalid' }) end
if N(o.acks) >= MAX_ACKS then return cjson.encode({ result = 'limited' }) end
-- Read everything before the first write.
local alertId = redis.call('GET', K.cred) or nil
local a = alert_get(alertId)
local epOwner = redis.call('GET', K.endpoint) or nil
local x = nil
if epOwner and epOwner ~= alertId then x = alert_get(epOwner) end
alert_check(alertId, a) alert_check(epOwner, x) op_check(cred, o)
-- Where activation will write: the new offices' index sets, and the order counter.
if A.prep and A.prep.offices then for office in string.gmatch(A.prep.offices, '[^,]+') do need(KEY.site .. office, 'set') end end
counter(KEY.order)
-- The new alert's key is unused (a random id), so writing it cannot fail after the endpoint has been taken; and the
-- prepared choices a setup writes are all there.
need(KEY.alert .. A.newId, 'hash')
if redis.call('EXISTS', KEY.alert .. A.newId) == 1 then error('alert id taken: ' .. A.newId) end
if A.prep and o.kind == 'setup' and (type(A.prep.offices) ~= 'string' or type(A.prep.group) ~= 'string' or type(A.prep.pace) ~= 'string') then error('prepared choices') end
local capOk, capValue = pcall(cjson.decode, o.cap ~= '' and o.cap or '0')
if o.cap ~= '' and (not capOk or type(capValue) ~= 'table') then error('op cap') end
redis.call('HINCRBY', K.op, 'acks', 1)
count('acks')
if o.nh ~= A.nh or not A.prep or A.prep.fp ~= o.fp or A.prep.ep ~= o.ep then return cjson.encode({ result = 'invalid' }) end
local function finish(result) op_finish(cred, o, result) return cjson.encode({ result = result }) end
if N(o.exp) <= NOW then return finish('expired') end
local cap = false
if o.cap ~= '' then cap = capValue end
if a and is_ended(a) then
  alert_delete(alertId, a, 'ended')
  a = nil
  if cap then return finish('expired') end
end
if o.kind == 'setup' and not cap then
  if a then return finish('changed') end
elseif o.kind == 'setup' then
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation or N(a.rev) ~= cap.revision then return finish('changed') end
else
  if not a or a.inc ~= cap.incarnation or N(a.gen) ~= cap.generation then return finish('changed') end
end
local p = A.prep
local activation
if not cap then
  if A.ownerMode and o.tok ~= A.ownerTok then return finish('owner-only') end
  -- A reserved alert counts itself already: above the ceiling now (it fell since admission, as when maxmemory is
  -- lowered) it ends as full, and finish releases the reservation.
  if o.rsv == 'alert' and rec('alerts') > A.alertLimit then return finish('full') end
  -- A target that ended meanwhile is ended now, so its slot is free for the check below.
  if x and is_ended(x) then
    alert_delete(epOwner, x, 'ended')
    x = nil
  end
  if o.rsv == 'repl' then
    -- Replacing a live alert adds none; if the target is gone, this creates one, which needs a free slot now.
    if not x and rec('alerts') + 1 > A.alertLimit then return finish('full') end
    rec_add('alerts', 1)
  end
  local id = A.newId
  local order = redis.call('INCR', KEY.order)
  take_endpoint(id, K.endpoint, epOwner, x)
  redis.call('HSET', KEY.alert .. id, 'sub', p.sub, 'offices', p.offices, 'group', p.group, 'pace', p.pace, 'created', I(NOW),
    'order', I(order), 'cred', cred, 'op', o.op, 'inc', A.newInc, 'gen', '1', 'rev', '1', 'fp', p.fp, 'ep', p.ep, 'svc', p.svc,
    'end', I(NOW + ALERT_MS), 'renewed', I(NOW), 'seq', o.maxseq)
  redis.call('SET', K.cred, id)
  index_sites(id, p.offices, p.group)
  redis.call('ZADD', KEY.ends, NOW + ALERT_MS, id)
  count('alerts_created')
  activation = { alertId = id, incarnation = A.newInc, generation = 1, revision = 1 }
else
  local id = alertId
  local rev = N(a.rev)
  local gen = N(a.gen)
  if o.kind == 'setup' then
    unindex_sites(id, a.offices, a.group)
    rev = rev + 1
    redis.call('HSET', KEY.alert .. id, 'offices', p.offices, 'group', p.group, 'pace', p.pace, 'rev', I(rev))
    index_sites(id, p.offices, p.group)
    count('alerts_changed')
  end
  if p.fp ~= a.fp then
    gen = gen + 1
    if redis.call('GET', KEY.endpoint .. a.ep) == id then redis.call('DEL', KEY.endpoint .. a.ep) end
    take_endpoint(id, K.endpoint, epOwner, x)
    redis.call('HSET', KEY.alert .. id, 'sub', p.sub, 'fp', p.fp, 'ep', p.ep, 'svc', p.svc, 'gen', I(gen))
  end
  redis.call('HDEL', KEY.alert .. id, 'gone')
  if o.kind == 'rotate' then count('rotations_completed') end
  activation = { alertId = id, incarnation = a.inc, generation = gen, revision = rev }
end
op_finish(cred, o, 'active', activation)
return cjson.encode({ result = 'active', activation = activation })
`,
);

export async function ready(
  kv: Kv,
  a: { now: number; cred: string; op: string; nh: string; prep: Prepared | false; newId: string; newInc: string; ownerMode: boolean; ownerTok: string; alertLimit: number },
): Promise<{ result: ReadyResult | 'limited'; activation: Activation | null }> {
  // Without a prepared subscription (an op with nothing sealed), the endpoint key is a placeholder no alert uses.
  const ep = a.prep ? a.prep.ep : '-';
  const r = await readyScript.run<{ result: ReadyResult | 'limited'; activation?: Activation | false }>(
    kv,
    { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), endpoint: K.devEndpoint(ep) },
    { ...a },
  );
  return { result: r.result, activation: r.activation || null };
}

export const changeScript = deviceScript(
  'dev-change',
  `${STORE_LIB}${ACTIVATE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need_store()
local cred = A.cred
local o = hgetall(K.op)
local alertId = redis.call('GET', K.cred) or nil
local a = alert_get(alertId)
alert_check(alertId, a) op_check(cred, o)
for office in string.gmatch(A.offices, '[^,]+') do need(KEY.site .. office, 'set') end
if o.op == A.op then
  if o.kind == 'change' and o.digest == A.digest then
    if o.result == 'active' then return cjson.encode({ result = 'active', revision = cjson.decode(o.act).revision }) end
    return cjson.encode({ result = o.result })
  end
  return cjson.encode({ result = 'invalid' })
end
local highest = tonumber(o.maxseq or '0') or 0
if a then highest = math.max(highest, tonumber(a.seq or '0') or 0) end
if A.seq <= highest then return cjson.encode({ result = 'invalid' }) end
if o.op ~= nil and o.result == '' and N(o.exp) > NOW then return cjson.encode({ result = 'busy' }) end
local units = 0
if o.op == nil then units = 1 end
if rec('units') + units > A.recordLimit then return cjson.encode({ result = 'full' }) end
if o.op ~= nil and o.result == '' then
  op_finish(cred, o, 'expired')
  -- Finishing an expired rotation can delete the alert: read it again, never write to a deleted one.
  alertId = redis.call('GET', K.cred) or nil
  a = alert_get(alertId)
end
if a and is_ended(a) then alert_delete(alertId, a, 'ended') a = nil end
local result = 'changed'
local act = ''
local rev = 0
if a and a.inc == A.inc and N(a.rev) == A.baseRev then
  rev = N(a.rev) + 1
  unindex_sites(alertId, a.offices, a.group)
  redis.call('HSET', KEY.alert .. alertId, 'offices', A.offices, 'group', A.group, 'pace', A.pace, 'rev', I(rev), 'seq', I(math.max(highest, A.seq)))
  index_sites(alertId, A.offices, A.group)
  result = 'active'
  act = cjson.encode({ alertId = alertId, incarnation = a.inc, generation = N(a.gen), revision = rev })
  count('changes_applied')
else
  -- Refused, the request's number still counts: kept on the alert, it outlives the result a day from now.
  if a then redis.call('HSET', KEY.alert .. alertId, 'seq', I(math.max(highest, A.seq))) end
  count('changes_refused')
end
count('ops_started')
count('ops_' .. result)
rec_add('units', units)
redis.call('DEL', K.op)
redis.call('HSET', K.op, 'op', A.op, 'seq', I(A.seq), 'maxseq', I(math.max(highest, A.seq)), 'kind', 'change', 'digest', A.digest,
  'cap', '', 'alert', alertId or '', 'rsv', '', 'other', '', 'exp', I(NOW), 'dsp', '', 'did', '', 'dspAt', '', 'retry', '', 'why', '',
  'result', result, 'act', act, 'done', I(NOW), 'ep', '', 'fp', '', 'svc', '', 'tok', '', 'acks', '0', 'started', I(NOW))
redis.call('ZREM', KEY.ops, cred)
redis.call('ZADD', KEY.deadlines, NOW + RESULT_KEEP_MS, 'op|' .. cred)
if result == 'active' then return cjson.encode({ result = 'active', revision = rev }) end
return cjson.encode({ result = 'changed' })
`,
);

export function change(
  kv: Kv,
  a: { now: number; cred: string; op: string; seq: number; digest: string; inc: string; baseRev: number; offices: string; group: string; pace: string; recordLimit: number },
): Promise<{ result: 'active' | 'changed' | 'busy' | 'invalid' | 'full'; revision?: number }> {
  return changeScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred) }, { ...a });
}

export const renewScript = deviceScript(
  'dev-renew',
  `${STORE_LIB}
need(K.cred, 'string') need_store()
local id = redis.call('GET', K.cred) or nil
local a = alert_get(id)
alert_check(id, a)
if not a then return '{"state":"none"}' end
if is_ended(a) then alert_delete(id, a, 'ended') return '{"state":"ended"}' end
local e = math.max(N(a['end']), NOW + ALERT_MS)
redis.call('HSET', KEY.alert .. id, 'end', I(e), 'renewed', I(NOW))
redis.call('ZADD', KEY.ends, e, id)
count('renewals')
return cjson.encode({ state = 'active', endsAt = e })
`,
  { reclaim: true },
);

export function renew(kv: Kv, a: { now: number; cred: string }): Promise<{ state: 'active'; endsAt: number } | { state: 'ended' | 'none' }> {
  return renewScript.run(kv, { stats: statsKey(a.now), cred: K.devCred(a.cred) }, { ...a });
}

export const readScript = deviceScript(
  'dev-read',
  `${STORE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.ended, 'hash') need_store()
local o = hgetall(K.op)
local id = redis.call('GET', K.cred) or nil
local a = alert_get(id)
alert_check(id, a) op_check(A.cred, o)
if o.op ~= nil and o.result == '' and N(o.exp) <= NOW then op_finish(A.cred, o, 'expired') o = hgetall(K.op) end
a = alert_get(id)
if a and is_ended(a) then alert_delete(id, a, 'ended') a = nil end
local e = hgetall(K.ended)
local out = { a = false, id = false, o = false, e = false }
if a then a.sub = nil out.a = a out.id = id end
if o.op ~= nil then o.sealed = nil o.nh = nil out.o = o end
if e.reason ~= nil then out.e = e end
return cjson.encode(out)
`,
  { reclaim: true },
);

export function readMine(kv: Kv, a: { now: number; cred: string }): Promise<{ a: Record<string, string> | false; id: string | false; o: OpRecord | false; e: Record<string, string> | false }> {
  return readScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), ended: K.devEnded(a.cred) }, { ...a });
}

export const turnOffScript = deviceScript(
  'dev-turn-off',
  `${STORE_LIB}
need(K.op, 'hash') need(K.cred, 'string') need(K.ended, 'hash') need_store()
local cred = A.cred
local id = redis.call('GET', K.cred) or nil
local a = alert_get(id)
local o = hgetall(K.op)
alert_check(id, a) op_check(cred, o)
if a then alert_delete(id, a, 'off') end
if o.op ~= nil then
  if o.result == '' then op_finish(cred, o, 'off') end
  redis.call('DEL', K.op)
  rec_add('units', -1)
  redis.call('ZREM', KEY.deadlines, 'op|' .. cred)
end
if redis.call('EXISTS', K.ended) == 1 then
  redis.call('DEL', K.ended)
  rec_add('units', -1)
  redis.call('ZREM', KEY.deadlines, 'ended|' .. cred)
end
return '{"deleted":true}'
`,
  { reclaim: true },
);

export function turnOff(kv: Kv, a: { now: number; cred: string }): Promise<{ deleted: true }> {
  return turnOffScript.run(kv, { stats: statsKey(a.now), op: K.devOp(a.cred), cred: K.devCred(a.cred), ended: K.devEnded(a.cred) }, { ...a });
}

export const goneScript = deviceScript(
  'dev-gone',
  `${STORE_LIB}
need_store()
local a = alert_get(A.id)
alert_check(A.id, a)
if not a or a.inc ~= A.inc then return '{"gone":"none"}' end
if N(a.gen) ~= A.gen then return '{"gone":"older"}' end
need(KEY.op .. a.cred, 'hash')
local o = hgetall(KEY.op .. a.cred)
op_check(a.cred, o)
if o.op ~= nil and o.result == '' and o.kind == 'rotate' and o.alert == A.id and N(o.exp) > NOW then
  redis.call('HSET', KEY.alert .. A.id, 'gone', I(A.gen))
  count('gone_kept')
  return '{"gone":"kept"}'
end
alert_delete(A.id, a, 'gone')
return '{"gone":"deleted"}'
`,
  { reclaim: true },
);

/** A push service said the alert's subscription no longer exists (spec: "Gone" and "When the subscription changes"). */
export function markGone(kv: Kv, a: { now: number; id: string; inc: string; gen: number }): Promise<{ gone: 'deleted' | 'kept' | 'older' | 'none' }> {
  return goneScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const backoffScript = deviceScript(
  'dev-backoff',
  `need(K.backoff, 'string')
local b = tonumber(redis.call('GET', K.backoff) or '0') or 0
if A.till > b then redis.call('SET', K.backoff, I(A.till)) end
return '"ok"'`,
  { reclaim: true },
);

export const testCaptureScript = deviceScript(
  'dev-test-capture',
  `${STORE_LIB}
need_store()
local a = alert_get(A.id)
if not a or a.inc ~= A.inc or is_ended(a) then return '{"state":"none"}' end
if a.gone ~= nil and a.gone ~= '' then return '{"state":"gone"}' end
if redis.call('EXISTS', KEY.paused) == 1 then return '{"state":"unavailable"}' end
need(KEY.backoff .. a.svc, 'string')
if counter(KEY.backoff .. a.svc) > NOW then return '{"state":"unavailable"}' end
return cjson.encode({ state = 'ok', alert = a })
`,
  { reclaim: true },
);

/** The alert as one atomic read, with the stop and its push service's backoff, for a test send. */
export function testCapture(kv: Kv, a: { now: number; id: string; inc: string }): Promise<{ state: 'ok'; alert: Record<string, string> } | { state: 'none' | 'gone' | 'unavailable' }> {
  return testCaptureScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

/** A push service answered 429: every sender waits until `until` (never shortened). */
export async function setBackoff(kv: Kv, svc: string, until: number): Promise<void> {
  // "until" is a Lua keyword: the field is "till".
  await backoffScript.run(kv, { backoff: K.pushBackoff(svc) }, { now: until, till: until });
}
