// The API's atomic steps for notification alerts (spec: "Setting up, with the ready check", steps 3 and 4).
// Each checks every key's type first, so a failure writes nothing; refusals write nothing either, except the
// tidying the spec asks for in passing (an expired operation ended, the credential's own ended alert ended).
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
local items = {}
if o.cap ~= '' then
  items = A.maintItems
else
  local owner = redis.call('GET', K.endpoint) or nil
  if not owner or redis.call('HGET', KEY.alert .. owner, 'cred') ~= A.cred then items = A.epItems end
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
