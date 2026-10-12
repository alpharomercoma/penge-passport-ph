// The checker's atomic steps for notification delivery. Every one checks the run still holds the checker's lock
// (KEY.lock = pp:lock:check), and reads and type-checks everything before its first write.
import type { Stamp } from '../clock.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv, WriteOp } from '../kv.ts';
import { DELIVERY_LIB } from './delivery-lua.ts';
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
