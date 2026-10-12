// The checker's atomic steps for notification delivery. Every one checks the run still holds the checker's lock
// (KEY.lock = pp:lock:check), and reads and type-checks everything before its first write.
import type { Stamp } from '../clock.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv, WriteOp } from '../kv.ts';
import { PACE_SPACING_MS } from '../pace.ts';
import { CLAIM_LIB } from './claims-lua.ts';
import { DELIVERY_LIB } from './delivery-lua.ts';
import type { SendResult } from './transport.ts';
import { deviceScript } from './lua.ts';
import { STORE_LIB } from './store-lua.ts';

export class LostLock extends Error {
  override name = 'LostLock';
  constructor() {
    super('lost the checker lock; stopping this run');
  }
}

export interface FanoutBatch {
  id: string;
  entries: string[];
  stamps: Stamp[];
}

const statsKey = (now: number) => K.statsV2(manilaDay(now));

export const queueWriteScript = deviceScript(
  'dev-queue-write',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(K.mark, 'string')
if not lock_ok() then return '{"lost":true}' end
-- Applied already (a retry after a lost answer): nothing again. The mark is this step's last write.
if redis.call('EXISTS', K.mark) == 1 then return '{"ok":true,"again":true}' end
-- Everything checked before the first write, so nothing after it can fail on its input (Valkey keeps the writes a
-- failing script made): key types, every value a string, every expiry a positive integer, the counters integers.
local function str(v, what) if type(v) ~= 'string' then error('not a string: ' .. what) end end
-- As kv.write would apply them, in order: a set or a delete replaces whatever was there; a hash or list write needs
-- the type the key has by then (what an earlier op in this write left, else what is stored); an empty one writes nothing.
local types = { set = 'string', hSet = 'hash', rPush = 'list', del = 'none' }
local left = {}
for _, op in ipairs(A.ops) do
  local t = types[op.op]
  if t == nil then error('unknown write ' .. tostring(op.op)) end
  str(op.key, 'key')
  local empty = (op.op == 'hSet' and next(op.fields) == nil) or (op.op == 'rPush' and #op.values == 0)
  if (op.op == 'hSet' or op.op == 'rPush') and not empty then
    local was = left[op.key]
    if was == nil then need(op.key, t)
    elseif was ~= 'none' and was ~= t then error('WRONGTYPE ' .. op.key .. ' is a ' .. was .. ', not a ' .. t) end
  end
  if not empty then left[op.key] = t end
  if op.op == 'set' then
    str(op.value, op.key)
    if op.ttlSeconds ~= nil and (type(op.ttlSeconds) ~= 'number' or op.ttlSeconds < 1 or op.ttlSeconds ~= math.floor(op.ttlSeconds)) then error('bad expiry ' .. op.key) end
  elseif op.op == 'hSet' then
    for f, v in pairs(op.fields) do str(f, op.key) str(v, op.key) end
  elseif op.op == 'rPush' then
    for i = 1, #op.values do str(op.values[i], op.key) end
  end
end
local b = A.batch
local fk, sk
if b then
  fk = KEY.fanout .. b.id
  sk = fk .. ':stamps'
  need(KEY.fanouts, 'list') need(fk, 'list') need(sk, 'string') need(KEY.order, 'string')
  counter(KEY.order)
  for i = 1, #b.entries do str(b.entries[i], 'entry') end
end
for _, op in ipairs(A.ops) do
  if op.op == 'set' then
    if op.ttlSeconds then redis.call('SET', op.key, op.value, 'EX', op.ttlSeconds) else redis.call('SET', op.key, op.value) end
  elseif op.op == 'del' then
    redis.call('DEL', op.key)
  elseif op.op == 'hSet' then
    local args = {}
    for f, v in pairs(op.fields) do args[#args + 1] = f args[#args + 1] = v end
    if #args > 0 then redis.call('HSET', op.key, unpack(args)) end
  elseif op.op == 'rPush' then
    for i = 1, #op.values, 500 do redis.call('RPUSH', op.key, unpack(slice(op.values, i, i + 499))) end
  end
end
if b then
  if redis.call('LLEN', KEY.fanouts) >= 5 then
    count('fanout_dropped_batches')
    count('fanout_dropped_entries', #b.entries)
  elseif #b.entries > 0 then
    local order = redis.call('INCR', KEY.order)
    for i = 1, #b.entries, 500 do redis.call('RPUSH', fk, unpack(slice(b.entries, i, i + 499))) end
    redis.call('SET', sk, cjson.encode({ order = order, stamps = b.stamps }))
    redis.call('RPUSH', KEY.fanouts, b.id)
    count('fanout_batches')
  end
end
redis.call('SET', K.mark, '1', 'EX', 86400)
return '{"ok":true}'
`,
);

/**
 * The first queueing write: the email write as at 157bad9, plus the fan-out batch, while the run holds the lock.
 * `mark` names this write (run and domestic/abroad): a retry after a lost answer applies nothing twice.
 */
export async function queueWrite(kv: Kv, a: { now: number; run: string; mark: string; ops: WriteOp[]; batch: FanoutBatch | null }): Promise<void> {
  const ops = a.ops.filter((op) => op.op === 'set' || op.op === 'del' || op.op === 'hSet' || op.op === 'rPush');
  if (ops.length !== a.ops.length) throw new Error('the queueing write has an operation the script does not apply');
  const r = await queueWriteScript.run<{ ok?: true; lost?: true }>(kv, { stats: statsKey(a.now), mark: K.queueMark(a.mark) }, { now: a.now, run: a.run, ops, batch: a.batch ?? false });
  if (r.lost) throw new LostLock();
}

export const fanoutChunkScript = deviceScript(
  'dev-fanout-chunk',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(KEY.fanouts, 'list') need(KEY.queue, 'hash') need(KEY.queued, 'zset')
if not lock_ok() then return '{"lost":true}' end
local id = redis.call('LINDEX', KEY.fanouts, 0)
if not id then return '{"done":true}' end
local fk = KEY.fanout .. id
local sk = fk .. ':stamps'
need(fk, 'list') need(sk, 'string')
local metaOk, meta = pcall(cjson.decode, redis.call('GET', sk) or '{"order":0,"stamps":[]}')
local function meta_ok(m)
  if type(m) ~= 'table' or type(m.stamps) ~= 'table' or not finite(m.order) or m.order ~= math.floor(m.order) then return false end
  if m.resume == nil then return true end
  return type(m.resume) == 'table' and type(m.resume.entry) == 'string' and type(m.resume.after) == 'string'
end
if not metaOk or not meta_ok(meta) then
  -- A batch whose stamps cannot be read would block every batch after it: dropped, and counted.
  redis.call('DEL', fk, sk)
  redis.call('LREM', KEY.fanouts, 0, id)
  count('fanout_dropped_batches')
  return cjson.encode({ batch = id, entries = 0, work = 0 })
end
-- Read and decide everything first. Members are taken in sorted order, so a chunk can stop inside an entry, at
-- exactly maxWork recipients, and the next one resume after the last member it handled (meta.resume).
local entries = redis.call('LRANGE', fk, 0, A.maxEntries - 1)
local resume = meta.resume
local jobs = {}
local touched = {}
local work, n = 0, 0
local stopped = nil
for idx, e in ipairs(entries) do
  local office, date, group, si = string.match(e, '^(%d+)|(%d%d%d%d%-%d%d%-%d%d)|(%d+)|(%d+)$')
  local st = nil
  if office then st = meta.stamps[N(si) + 1] end
  -- An entry without a real stamp is dropped (consumed and counted): its dates' age could not be known.
  if st ~= nil and not stamp_ok(st) then st = nil end
  if st == nil then count('fanout_dropped_entries') end
  local skipping = idx == 1 and type(resume) == 'table' and resume.entry == e
  local last = ''
  if skipping then last = resume.after end
  if st then
    need(KEY.site .. office, 'set')
    local members = redis.call('SMEMBERS', KEY.site .. office)
    table.sort(members)
    for _, m in ipairs(members) do
      local aid, g = string.match(m, '^(.+):(%d+)$')
      if (not skipping or m > resume.after) and g == group then
        if work >= A.maxWork then stopped = { entry = e, after = last } break end
        work = work + 1
        last = m
        need(KEY.alert .. aid, 'hash')
        local a = alert_get(aid)
        local follows = false
        if a then for o in string.gmatch(a.offices, '[^,]+') do if o == office then follows = true end end end
        if a and follows and a.group == group and N(a.order) < meta.order and not is_ended(a) and (a.gone == nil or a.gone == '') then
          local job = jobs[aid]
          if not job then
            job = job_decode(redis.call('HGET', KEY.queue, aid))
            if not job or job.n ~= a.inc then job = { i = aid, n = a.inc, s = {}, d = {} } end
            jobs[aid] = job
            touched[#touched + 1] = aid
          end
          job_merge(job, { s = { st }, d = { { N(office), date, N(group), 0 } } })
        end
      end
    end
  end
  if stopped then break end
  n = n + 1
end
-- Every job bounded and encoded before the first write, so nothing can fail half-way through the writes.
local dropped = 0
local ready = {}
for _, aid in ipairs(touched) do
  local bounded, dr = job_bound(jobs[aid])
  dropped = dropped + dr
  if bounded then ready[#ready + 1] = { aid, cjson.encode(bounded), oldest_wall(bounded) } else ready[#ready + 1] = { aid } end
end
-- The batch's state after this chunk, encoded before the first write too.
local remaining = redis.call('LLEN', fk) - n
meta.resume = stopped
local metaJson = nil
if remaining > 0 then metaJson = cjson.encode(meta) end
-- Then write.
for _, r in ipairs(ready) do
  if r[2] then
    redis.call('HSET', KEY.queue, r[1], r[2])
    redis.call('ZADD', KEY.queued, r[3], r[1])
  else
    redis.call('HDEL', KEY.queue, r[1])
    redis.call('ZREM', KEY.queued, r[1])
  end
end
if n > 0 then redis.call('LPOP', fk, n) end
if metaJson then redis.call('SET', sk, metaJson) end
if remaining <= 0 then
  redis.call('DEL', fk, sk)
  redis.call('LREM', KEY.fanouts, 0, id)
end
if #touched > 0 then count('fanout_merged', #touched) end
if dropped > 0 then count('dates_dropped_overflow', dropped) end
return cjson.encode({ batch = id, entries = n, work = work })
`,
);

/** One chunk of the second queueing write: up to maxEntries entries of the oldest pending batch, and at most maxWork recipients (stopping inside an entry if need be). */
export function fanoutChunk(kv: Kv, a: { now: number; run: string; maxEntries: number; maxWork: number }): Promise<{ lost?: true; done?: true; batch?: string; entries?: number; work?: number }> {
  return fanoutChunkScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const heldPairsScript = deviceScript(
  'dev-held-pairs',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.ends, 'zset')
local oldest = {}
local order = {}
for _, id in ipairs(redis.call('ZRANGE', KEY.ends, 0, -1)) do
  need(KEY.held .. id, 'string')
  local job = job_decode(redis.call('GET', KEY.held .. id))
  if job then
    for _, d in ipairs(job.d) do
      local k = I(d[1]) .. ':' .. I(d[3])
      local w = stamp_of(job, d).wall
      if oldest[k] == nil then order[#order + 1] = k end
      if oldest[k] == nil or w < oldest[k] then oldest[k] = w end
    end
  end
end
local out = {}
for _, k in ipairs(order) do
  local o, g = string.match(k, '^(%d+):(%d+)$')
  out[#out + 1] = { N(o), N(g), oldest[k] }
end
table.sort(out, function(a, b) if a[3] ~= b[3] then return a[3] < b[3] end if a[1] ~= b[1] then return a[1] < b[1] end return a[2] < b[2] end)
return cjson.encode(out)
`,
  { reclaim: true },
);

/** (office, group, oldest announcement) for every pair with held notification work. Read only. */
export async function heldPairs(kv: Kv): Promise<[number, number, number][]> {
  const out = await heldPairsScript.run<[number, number, number][] | Record<string, never>>(kv, {}, { now: 0 });
  return Array.isArray(out) ? out : [];
}

const ALL_LIBS = `${STORE_LIB}${DELIVERY_LIB}${CLAIM_LIB}`;
// Every key a delivery step may touch for one alert, type-checked before the first write.
const NEED_ALERT = `
local function need_alert(id)
  need(KEY.alert .. id, 'hash') need(KEY.held .. id, 'string') need(KEY.claim .. id, 'hash') need(KEY.last .. id, 'string')
  need(KEY.tried .. id, 'hash') need(KEY.queue, 'hash') need(KEY.queued, 'zset') need(KEY.lock, 'string')
end
`;

export const workListScript = deviceScript(
  'dev-work-list',
  `${ALL_LIBS}
need(KEY.ends, 'zset') need(KEY.queue, 'hash')
local seen, out = {}, {}
for _, id in ipairs(redis.call('HKEYS', KEY.queue)) do if not seen[id] then seen[id] = true out[#out + 1] = id end end
for _, id in ipairs(redis.call('ZRANGE', KEY.ends, 0, -1)) do
  if not seen[id] and redis.call('EXISTS', KEY.held .. id) == 1 then seen[id] = true out[#out + 1] = id end
end
table.sort(out)
return cjson.encode(out)
`,
  { reclaim: true },
);

export async function workList(kv: Kv): Promise<string[]> {
  const out = await workListScript.run<string[] | Record<string, never>>(kv, {}, { now: 0 });
  return Array.isArray(out) ? out : [];
}

export interface ClaimInput {
  now: number;
  run: string;
  id: string;
  cid: string;
  stamp: Stamp;
  day: string;
  cap: number;
  batch: 'domestic' | 'abroad';
  /** "<office>|<group>" → the dates this run verified open for that pair, and when (ms). */
  open: Record<string, { d: string[]; at: number }>;
  /** The alert's offices that are posts abroad. */
  abroad: Record<string, true>;
}

export type Job = { i: string; n: string; s: Stamp[]; d: [number, string, number, number][] };
export type ClaimAnswer = { ok: true; job: Job; checked: number; svc: string } | { ok: false; why: 'lost' | 'none' | 'ended' | 'claimed' | 'attempted' | 'empty' | 'deferred' | 'unverified' | 'pace' | 'cap' };

export const claimScript = deviceScript(
  'dev-claim',
  `${ALL_LIBS}${NEED_ALERT}
local id = A.id
need_alert(id)
local tk = KEY.today .. id .. ':' .. A.day
need(tk, 'string')
if not lock_ok() then return '{"ok":false,"why":"lost"}' end
local a = alert_get(id)
local function no(why) count('claims_refused_' .. why) return cjson.encode({ ok = false, why = why }) end
if not a then return no('none') end
if is_ended(a) or (a.gone ~= nil and a.gone ~= '') then return no('ended') end
if redis.call('EXISTS', KEY.claim .. id) == 1 then return no('claimed') end
if redis.call('HGET', KEY.tried .. id, 'run') == A.run then return no('attempted') end
local spacing = { asap = ${PACE_SPACING_MS.asap}, hourly = ${PACE_SPACING_MS.hourly} }
local lastRaw = redis.call('GET', KEY.last .. id) or nil
-- Checked before any write: the pace stamp reads as a stamp, today's count is an integer.
local last = nil
if lastRaw then
  local ok, v = pcall(cjson.decode, lastRaw)
  if not ok or not stamp_ok(v) then error('pace stamp of ' .. id) end
  last = v
end
if not stamp_ok(A.stamp) then error("the run's stamp") end
local today = counter(tk)
alert_check(id, alert_get(id))
-- All the alert's work, merged: held first, then queued; pruned to its incarnation, choices and window.
local work = job_decode(redis.call('GET', KEY.held .. id))
local queued = job_decode(redis.call('HGET', KEY.queue, id))
if work and work.n ~= a.inc then work = nil end
if queued and queued.n == a.inc then
  if work then job_merge(work, queued) else work = queued end
end
local pruned = nil
local drop = { choices = 0, window = 0, unknown = 0 }
if work then pruned, drop = job_prune(work, a, A.stamp) end
-- The merged work is bounded like any job (30 dates, 4 KB) before a claim is cut from it.
local overflow = 0
if pruned then pruned, overflow = job_bound(pruned) end
-- Decide everything, and encode every value to write, before the first write.
if spacing[a.pace] == nil then error('pace of ' .. id) end
local function encoded(job)
  if not job then return nil, 0 end
  local bounded, dr = job_bound(job)
  if bounded then return cjson.encode(bounded), dr end
  return nil, dr
end
local why, heldJob, claimed, checked = nil, nil, nil, nil
local restartPace = false
local open, rest = {}, {}
if not pruned then why = 'empty'
else
  -- Split into the dates verified open in this run and the rest.
  local oldestOpenDomestic, oldestWaitingAbroad = nil, nil
  for _, d in ipairs(pruned.d) do
    local pair = A.open[I(d[1]) .. '|' .. I(d[3])]
    local isOpen = false
    if pair then for _, x in ipairs(pair.d) do if x == d[2] then isOpen = true end end end
    local wall = stamp_of(pruned, d).wall
    if isOpen then
      open[#open + 1] = d
      if checked == nil or pair.at < checked then checked = pair.at end
      if not A.abroad[I(d[1])] and (oldestOpenDomestic == nil or wall < oldestOpenDomestic) then oldestOpenDomestic = wall end
    else
      rest[#rest + 1] = d
    end
    if A.abroad[I(d[1])] and not isOpen and (oldestWaitingAbroad == nil or wall < oldestWaitingAbroad) then oldestWaitingAbroad = wall end
  end
  heldJob = pruned
  if #open == 0 then why = 'unverified'
  elseif A.batch == 'domestic' and oldestWaitingAbroad ~= nil and oldestOpenDomestic ~= nil and oldestWaitingAbroad < oldestOpenDomestic then why = 'deferred'
  elseif last and elapsed(last, A.stamp) == nil then
    -- A stamp from another boot restarts the gap; it never shortens it.
    why = 'pace'
    restartPace = true
  elseif last and elapsed(last, A.stamp) < spacing[a.pace] then why = 'pace'
  elseif today >= A.cap then why = 'cap'
  else
    claimed = job_with(pruned, open)
    heldJob = nil
    if #rest > 0 then heldJob = job_with(pruned, rest) end
  end
end
local heldJson, heldDropped = encoded(heldJob)
local claimJson = claimed and cjson.encode(claimed) or nil
local stampJson = cjson.encode(A.stamp)
-- Then write.
count_drops(drop)
if overflow > 0 then count('dates_dropped_overflow', overflow) end
if heldDropped > 0 then count('dates_dropped_overflow', heldDropped) end
redis.call('HDEL', KEY.queue, id)
redis.call('ZREM', KEY.queued, id)
if heldJson then redis.call('SET', KEY.held .. id, heldJson) else redis.call('DEL', KEY.held .. id) end
if why then
  if restartPace then redis.call('SET', KEY.last .. id, stampJson) end
  if why == 'cap' then count('dates_held_cap', #pruned.d) end
  return no(why)
end
redis.call('HSET', KEY.claim .. id, 'cid', A.cid, 'run', A.run, 'inc', a.inc, 'gen', a.gen, 'rev', a.rev, 'day', A.day,
  'prev', lastRaw or '', 'at', stampJson, 'state', 'claimed', 'job', claimJson, 'checked', I(checked))
redis.call('SET', KEY.last .. id, stampJson)
redis.call('INCR', tk)
if redis.call('PTTL', tk) < 0 then redis.call('EXPIRE', tk, 172800) end
redis.call('HSET', KEY.tried .. id, 'run', A.run)
count('claims')
return cjson.encode({ ok = true, job = claimed, checked = checked, svc = a.svc or 'fcm' })
`,
);

export function claim(kv: Kv, a: ClaimInput): Promise<ClaimAnswer> {
  return claimScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const sendGateScript = deviceScript(
  'dev-send-gate',
  `${ALL_LIBS}${NEED_ALERT}
local id = A.id
need_alert(id)
need(KEY.backoff .. A.svc, 'string')
if not lock_ok() then return '{"go":false,"why":"lost"}' end
local c = hgetall(KEY.claim .. id)
if c.cid ~= A.cid or c.state ~= 'claimed' or c.run ~= A.run then return '{"go":false,"why":"claim"}' end
local a = alert_get(id)
local why = nil
if not a or a.inc ~= c.inc or a.gen ~= c.gen or a.rev ~= c.rev then why = 'changed'
elseif is_ended(a) or (a.gone ~= nil and a.gone ~= '') then why = 'ended'
elseif not A.modeOk then why = 'mode'
elseif redis.call('EXISTS', KEY.paused) == 1 then why = 'paused'
elseif (tonumber(redis.call('GET', KEY.backoff .. A.svc) or '0') or 0) > NOW then why = 'backoff'
else
  local job = job_decode(c.job)
  local pruned, drop = nil, nil
  if job then pruned, drop = job_prune(job, a, A.stamp) end
  if not pruned or #pruned.d ~= #job.d then why = 'age' end
end
if why then
  put_back(id, c, a, false, A.stamp)
  return cjson.encode({ go = false, why = why })
end
redis.call('HSET', KEY.claim .. id, 'state', 'sending')
return cjson.encode({ go = true, sub = a.sub })
`,
);

export function sendGate(kv: Kv, a: { now: number; run: string; id: string; cid: string; stamp: Stamp; modeOk: boolean; svc: string }): Promise<{ go: true; sub: string } | { go: false; why: string }> {
  return sendGateScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const settleScript = deviceScript(
  'dev-settle',
  `${ALL_LIBS}${NEED_ALERT}
local id = A.id
need_alert(id)
need(KEY.backoff .. A.svc, 'string')
need_store()
local c = hgetall(KEY.claim .. id)
-- Only the run that holds the lock settles: a run that lost it leaves its claim to the next run's recovery
-- (a claim still "sending" is then settled as uncertain).
if not lock_ok() or c.cid ~= A.cid then return '{"ok":false}' end
local a = alert_get(id)
alert_check(id, a)
-- What the branches below may read or change, checked before the first write: the owner's operation (gone) and the
-- claim's charged day (give_back).
if a then need(KEY.op .. a.cred, 'hash') op_check(a.cred, hgetall(KEY.op .. a.cred)) end
charged_ok(id, c)
local r = A.result
if A.backoffUntil and A.backoffUntil > (tonumber(redis.call('GET', KEY.backoff .. A.svc) or '0') or 0) then
  redis.call('SET', KEY.backoff .. A.svc, I(A.backoffUntil))
end
if r == 'accepted' or r == 'uncertain' then
  redis.call('DEL', KEY.claim .. id)
  count('claims_' .. r)
  return cjson.encode({ ok = true, outcome = r })
end
-- Passed the gate but never handed to the push service (the run stopped first): back as unattempted.
if r == 'unattempted' then
  put_back(id, c, a, false, A.stamp)
  return '{"ok":true,"outcome":"unattempted"}'
end
if r == 'bug' then
  give_back(id, c)
  redis.call('DEL', KEY.claim .. id)
  count('claims_bug')
  return '{"ok":true,"outcome":"bug"}'
end
if r == 'gone' and a and a.inc == c.inc and a.gen == c.gen then
  give_back(id, c)
  redis.call('DEL', KEY.claim .. id)
  count('claims_gone')
  local o = hgetall(KEY.op .. a.cred)
  if o.op ~= nil and o.result == '' and o.kind == 'rotate' and o.alert == id and N(o.exp) > NOW then
    redis.call('HSET', KEY.alert .. id, 'gone', a.gen)
    return '{"ok":true,"outcome":"kept"}'
  end
  alert_delete(id, a, 'gone')
  return '{"ok":true,"outcome":"deleted"}'
end
-- refused, throttled, rejected, and gone for an older generation: put back as a refusal.
if r == 'rejected' then count('claims_rejected') end
if r == 'throttled' then count('claims_throttled') end
put_back(id, c, a, true, A.stamp)
return '{"ok":true,"outcome":"put-back"}'
`,
  { reclaim: true },
);

export const cursorScript = deviceScript(
  'dev-cursor',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(K.cursor, 'string')
if not lock_ok() then return 'false' end
redis.call('SET', K.cursor, A.id)
return 'true'
`,
);

/** A batch's fair-order cursor moves past an alert considered; only while the run holds the lock. */
export function setCursor(kv: Kv, a: { now: number; run: string; kind: 'domestic' | 'abroad'; id: string }): Promise<boolean> {
  return cursorScript.run(kv, { stats: statsKey(a.now), cursor: K.devCursor(a.kind) }, { ...a });
}

export function settle(kv: Kv, a: { now: number; run: string; id: string; cid: string; stamp: Stamp; result: SendResult['kind'] | 'unattempted'; backoffUntil: number | null; svc?: string }): Promise<{ ok: boolean; outcome?: string }> {
  return settleScript.run(kv, { stats: statsKey(a.now) }, { ...a, svc: a.svc ?? 'fcm', backoffUntil: a.backoffUntil ?? false });
}

export const reclaimLockedScript = deviceScript(
  'dev-reclaim-locked',
  `${STORE_LIB}${DELIVERY_LIB}
need_store() need(KEY.lock, 'string')
if not lock_ok() then return '{"lost":true}' end
return cjson.encode(reclaim(A.limit))
`,
  { reclaim: true },
);

export function reclaimLocked(kv: Kv, a: { now: number; run: string; limit: number }): Promise<{ lost?: true; expired: number; ended: number; deleted: number }> {
  return reclaimLockedScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const garbageScript = deviceScript(
  'dev-garbage',
  `${ALL_LIBS}
need_store() need(KEY.lock, 'string') need(KEY.queue, 'hash') need(KEY.queued, 'zset')
if not lock_ok() then return '{"lost":true}' end
local all = hgetall(KEY.garbage)
local ids = {}
for id, units in pairs(all) do
  integer(units, 'garbage ' .. id)
  ids[#ids + 1] = id
end
table.sort(ids)
local removed = 0
for i = 1, math.min(#ids, A.limit) do
  local id = ids[i]
  local keys = { KEY.held .. id, KEY.claim .. id, KEY.last .. id, KEY.tried .. id }
  for _, day in ipairs(A.days) do keys[#keys + 1] = KEY.today .. id .. ':' .. day end
  redis.call('DEL', unpack(keys))
  redis.call('HDEL', KEY.queue, id)
  redis.call('ZREM', KEY.queued, id)
  redis.call('HDEL', KEY.garbage, id)
  rec_add('units', -N(all[id]))
  removed = removed + 1
end
if removed > 0 then count('garbage_removed', removed) end
return cjson.encode({ removed = removed, left = #ids - removed })
`,
  { reclaim: true },
);

export function collectGarbage(kv: Kv, a: { now: number; run: string; limit: number; days: string[] }): Promise<{ lost?: true; removed: number; left: number }> {
  return garbageScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const aliveScript = deviceScript('dev-alive', `need(KEY.ends, 'zset') return cjson.encode(redis.call('ZRANGE', KEY.ends, 0, -1))`, { reclaim: true });

export async function aliveAlerts(kv: Kv): Promise<string[]> {
  const out = await aliveScript.run<string[] | Record<string, never>>(kv, {}, { now: 0 });
  return Array.isArray(out) ? out : [];
}

export const sweepScript = deviceScript(
  'dev-sweep',
  `${ALL_LIBS}${NEED_ALERT}
for _, id in ipairs(A.ids) do need_alert(id) end
if not lock_ok() then return '{"lost":true}' end
-- Every claim this sweep will put back has its charged counter checked before the first write (put_back's own check
-- would come after earlier alerts' writes).
for _, id in ipairs(A.ids) do
  local c = hgetall(KEY.claim .. id)
  if c.cid ~= nil and c.run ~= A.run and c.state ~= 'sending' then charged_ok(id, c) end
  -- And every alert's fields the pruning reads (offices, group, numbers): one damaged alert stops the chunk unwritten.
  alert_check(id, alert_get(id))
end
local out = { recovered = 0, uncertain = 0, pruned = 0 }
for _, id in ipairs(A.ids) do
  local a = alert_get(id)
  -- Claims left by a run that lost the lock: still claimed, put back unattempted; sending, settled as uncertain.
  local c = hgetall(KEY.claim .. id)
  if c.cid ~= nil and c.run ~= A.run then
    if c.state == 'sending' then
      redis.call('DEL', KEY.claim .. id)
      count('claims_recovered_uncertain')
      out.uncertain = out.uncertain + 1
    else
      put_back(id, c, a, false, A.stamp)
      count('claims_recovered')
      out.recovered = out.recovered + 1
    end
  end
  -- Queued and held work: only this incarnation's, choices and window.
  local live = {}
  local q = job_decode(redis.call('HGET', KEY.queue, id))
  if q then
    local kept, drop = job_prune(q, a, A.stamp)
    count_drops(drop)
    out.pruned = out.pruned + drop.choices + drop.window + drop.unknown
    if kept then
      redis.call('HSET', KEY.queue, id, cjson.encode(kept))
      redis.call('ZADD', KEY.queued, oldest_wall(kept), id)
      for _, d in ipairs(kept.d) do live[dkey(d)] = true end
    else
      redis.call('HDEL', KEY.queue, id)
      redis.call('ZREM', KEY.queued, id)
    end
  end
  local h = job_decode(redis.call('GET', KEY.held .. id))
  if h then
    local kept, drop = job_prune(h, a, A.stamp)
    count_drops(drop)
    out.pruned = out.pruned + drop.choices + drop.window + drop.unknown
    if kept then
      redis.call('SET', KEY.held .. id, cjson.encode(kept))
      for _, d in ipairs(kept.d) do live[dkey(d)] = true end
    else
      redis.call('DEL', KEY.held .. id)
    end
  end
  local cj = job_decode(redis.call('HGET', KEY.claim .. id, 'job'))
  if cj then for _, d in ipairs(cj.d) do live[dkey(d)] = true end end
  -- Tries are kept only for dates still in the alert's work.
  for field in pairs(hgetall(KEY.tried .. id)) do
    if field ~= 'run' and not live[field] then redis.call('HDEL', KEY.tried .. id, field) end
  end
end
return cjson.encode(out)
`,
  { reclaim: true },
);

export function sweep(kv: Kv, a: { now: number; run: string; stamp: Stamp; ids: string[] }): Promise<{ lost?: true; recovered: number; uncertain: number; pruned: number }> {
  return sweepScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const fanoutExpireScript = deviceScript(
  'dev-fanout-expire',
  `${STORE_LIB}${DELIVERY_LIB}
need(KEY.lock, 'string') need(KEY.fanouts, 'list')
if not lock_ok() then return '{"lost":true}' end
-- A batch whose every announcement is past its 3-hour window (or of unknown age) holds nothing sendable: it goes,
-- even while the notification pass is not running (a cooldown, a rollback's pre-step).
-- Every batch read and decided first; a stamp that is not one has no known age. Then the writes.
local gone = {}
for _, id in ipairs(redis.call('LRANGE', KEY.fanouts, 0, -1)) do
  local fk = KEY.fanout .. id
  local sk = fk .. ':stamps'
  need(fk, 'list') need(sk, 'string')
  local ok, meta = pcall(cjson.decode, redis.call('GET', sk) or 'null')
  local live = false
  if ok and type(meta) == 'table' and type(meta.stamps) == 'table' then
    for _, st in ipairs(meta.stamps) do
      if stamp_ok(st) then
        local age = elapsed(st, A.stamp)
        if age ~= nil and age <= WINDOW_MS then live = true end
      end
    end
  end
  if not live then gone[#gone + 1] = id end
end
local removed = 0
for _, id in ipairs(gone) do
  local fk = KEY.fanout .. id
  redis.call('DEL', fk, fk .. ':stamps')
  redis.call('LREM', KEY.fanouts, 0, id)
  removed = removed + 1
end
if removed > 0 then count('fanout_expired', removed) end
return cjson.encode({ removed = removed })
`,
  { reclaim: true },
);

export function expireFanouts(kv: Kv, a: { now: number; run: string; stamp: Stamp }): Promise<{ lost?: true; removed: number }> {
  return fanoutExpireScript.run(kv, { stats: statsKey(a.now) }, { ...a });
}

export const recountScript = deviceScript(
  'dev-recount',
  `${STORE_LIB}${DELIVERY_LIB}
need_store() need(KEY.lock, 'string')
if not lock_ok() then return '{"lost":true}' end
local alive = redis.call('ZCARD', KEY.ends)
local rsvAlert, rsvRepl, unfinished = 0, 0, 0
for _, cred in ipairs(redis.call('ZRANGE', KEY.ops, 0, -1)) do
  unfinished = unfinished + 1
  local rsv = redis.call('HGET', KEY.op .. cred, 'rsv')
  if rsv == 'alert' then rsvAlert = rsvAlert + 1 elseif rsv == 'repl' then rsvRepl = rsvRepl + 1 end
end
local finishedOps, ended = 0, 0
for _, m in ipairs(redis.call('ZRANGE', KEY.deadlines, 0, -1)) do
  if string.sub(m, 1, 3) == 'op|' then finishedOps = finishedOps + 1 else ended = ended + 1 end
end
local garbage = 0
for _, v in pairs(hgetall(KEY.garbage)) do garbage = garbage + N(v) end
local expectedUnits = alive * ALERT_UNITS + unfinished + finishedOps + ended + garbage + (rsvAlert + rsvRepl) * ALERT_UNITS
local out = { units = rec('units'), expectedUnits = expectedUnits, alerts = rec('alerts'), expectedAlerts = alive + rsvAlert }
redis.call('HSET', K.stats, 'recounted', '1')
if out.units ~= out.expectedUnits or out.alerts ~= out.expectedAlerts then count('recount_differences') end
return cjson.encode(out)
`,
  { reclaim: true },
);

export async function recount(kv: Kv, now: number, run: string): Promise<{ units: number; expectedUnits: number; alerts: number; expectedAlerts: number }> {
  const r = await recountScript.run<{ lost?: true; units: number; expectedUnits: number; alerts: number; expectedAlerts: number }>(kv, { stats: statsKey(now) }, { now, run });
  if (r.lost) throw new LostLock();
  return r;
}
