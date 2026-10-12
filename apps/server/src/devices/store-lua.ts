// Lua functions shared by every script that changes alert records (appended after the prelude of lua.ts). Units are
// kept here and only here: every record that takes storage is created and deleted through these functions.
import { ALERT_MS, ALERT_UNITS, ENDED_KEEP_MS, MAX_ACKS, RESULT_KEEP_MS } from './store.ts';

export const STORE_LIB = `
local ALERT_UNITS = ${ALERT_UNITS}
local RESULT_KEEP_MS = ${RESULT_KEEP_MS}
local ENDED_KEEP_MS = ${ENDED_KEEP_MS}
local ALERT_MS = ${ALERT_MS}
local MAX_ACKS = ${MAX_ACKS}

local function rec(field) return tonumber(redis.call('HGET', KEY.records, field) or '0') or 0 end
local function rec_add(field, n) if n ~= 0 then redis.call('HINCRBY', KEY.records, field, n) end end

local function alert_get(id)
  if not id then return nil end
  need(KEY.alert .. id, 'hash')
  local a = hgetall(KEY.alert .. id)
  if a.inc == nil then return nil end
  return a
end

-- As Valkey's HINCRBY and INCR read a stored value: a canonical decimal integer ("1", never "1.0", "1e0" or "01"),
-- up to the largest a double holds exactly (2^53 - 1, the contracts' largest sequence number). Lua 5.1 prints negative
-- zero as "-0", so that spelling would pass the round trip there: refused by name.
local function integer(v, what)
  local n = tonumber(v)
  if v == '-0' or n == nil or n ~= math.floor(n) or math.abs(n) > 9007199254740991 then error('not an integer: ' .. what) end
  if type(v) == 'string' and I(n) ~= v then error('not an integer: ' .. what) end
  return n
end

-- Everything deleting or changing this alert may touch, checked before a step's first write: key types, and the
-- fields a script reads as numbers. A step that fails here has written nothing.
local function alert_check(id, a)
  if not a then return end
  need(KEY.cred .. a.cred, 'string') need(KEY.endpoint .. a.ep, 'string') need(KEY.ended .. a.cred, 'hash')
  for office in string.gmatch(a.offices or '', '[^,]+') do need(KEY.site .. office, 'set') end
  for _, f in ipairs({ 'end', 'gen', 'rev', 'order', 'group' }) do integer(a[f], 'alert ' .. id .. ' ' .. f) end
  -- Deletion walks the offices and may keep the fingerprint: both present before anything is deleted.
  if type(a.offices) ~= 'string' or not string.find(a.offices, '^%d[%d,]*$') then error('damaged alert ' .. id .. ': offices') end
  if type(a.fp) ~= 'string' then error('damaged alert ' .. id .. ': fp') end
  if a.seq ~= nil and a.seq ~= '' then integer(a.seq, 'alert ' .. id .. ' seq') end
end

-- The same for a credential's operation record, and for the alerts finishing it may touch.
local function op_check(cred, o)
  if o.op == nil then return end
  -- Every writer sets these four: one missing or empty is damage, refused before a script's first write.
  for _, f in ipairs({ 'seq', 'maxseq', 'exp', 'acks' }) do integer(o[f], 'op ' .. f) end
  if o.other ~= nil and o.other ~= '' then alert_check(o.other, alert_get(o.other)) end
  if o.alert ~= nil and o.alert ~= '' then alert_check(o.alert, alert_get(o.alert)) end
end

local function is_ended(a) return N(a['end']) <= NOW end

-- Deletes an alert's record and indexes (each index only if it still names this alert). Its delivery keys stay for
-- the checker, charged as garbage. 'ended' and 'gone' leave an end record for its credential, in the unit the alert
-- reserved for it; 'off' and 'replaced' leave none.
local function alert_delete(id, a, reason)
  redis.call('DEL', KEY.alert .. id)
  if redis.call('GET', KEY.cred .. a.cred) == id then redis.call('DEL', KEY.cred .. a.cred) end
  if redis.call('GET', KEY.endpoint .. a.ep) == id then redis.call('DEL', KEY.endpoint .. a.ep) end
  for office in string.gmatch(a.offices, '[^,]+') do redis.call('SREM', KEY.site .. office, id .. ':' .. a.group) end
  redis.call('ZREM', KEY.ends, id)
  rec_add('alerts', -1)
  local garbage = ALERT_UNITS
  if reason == 'ended' or reason == 'gone' then
    local ek = KEY.ended .. a.cred
    if redis.call('EXISTS', ek) == 1 then rec_add('units', -1) end
    local fp = ''
    if reason == 'gone' then fp = a.fp end
    redis.call('DEL', ek)
    redis.call('HSET', ek, 'reason', reason, 'at', I(NOW), 'fp', fp)
    redis.call('ZADD', KEY.deadlines, NOW + ENDED_KEEP_MS, 'ended|' .. a.cred)
    garbage = ALERT_UNITS - 1
  end
  redis.call('HSET', KEY.garbage, id, garbage)
  count('alerts_' .. reason)
end

-- Ends a credential's unfinished operation with a terminal result, releasing what it reserved. With 'active' the
-- reservation has become the alert (activation did that). A rotation that ends any other way deletes an alert whose
-- old subscription was reported gone meanwhile.
local function op_finish(cred, o, result, activation)
  local ok = KEY.op .. cred
  if o.rsv == 'alert' and result ~= 'active' then rec_add('alerts', -1) rec_add('units', -ALERT_UNITS) end
  if o.rsv == 'repl' then
    rec_add('repl', -1)
    if result ~= 'active' then rec_add('units', -ALERT_UNITS) end
  end
  if o.other ~= nil and o.other ~= '' and redis.call('HGET', KEY.alert .. o.other, 'cand') == cred then
    redis.call('HDEL', KEY.alert .. o.other, 'cand')
  end
  if o.kind == 'rotate' and result ~= 'active' and o.alert ~= '' then
    local a = alert_get(o.alert)
    if a and a.gone ~= nil and a.gone ~= '' then alert_delete(o.alert, a, 'gone') end
  end
  local act = ''
  if activation then act = cjson.encode(activation) end
  redis.call('HSET', ok, 'result', result, 'done', I(NOW), 'act', act, 'rsv', '')
  redis.call('HDEL', ok, 'sealed', 'nh')
  redis.call('ZREM', KEY.ops, cred)
  redis.call('ZADD', KEY.deadlines, NOW + RESULT_KEEP_MS, 'op|' .. cred)
  count('ops_' .. result)
end

-- Ends what is overdue, at most n things: unfinished operations past their expiry, alerts past their end, and
-- results and end records past their deadline. Never touches delivery keys (only the checker does).
local function reclaim(n)
  -- Checked first, so a damaged item fails the step having written nothing. A change never brings an item into these
  -- ranges, but taking one out moves later ones up: each finished operation deletes at most one alert (so the ends
  -- phase reaches no further than the first n) and pushes at most two deadlines out, each deleted alert one more (so
  -- the deadlines phase reaches no further than n + the operations, at most the first 2n).
  for _, cred in ipairs(redis.call('ZRANGEBYSCORE', KEY.ops, '-inf', NOW, 'LIMIT', 0, n)) do
    need(KEY.op .. cred, 'hash') op_check(cred, hgetall(KEY.op .. cred))
  end
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEY.ends, '-inf', NOW, 'LIMIT', 0, n)) do alert_check(id, alert_get(id)) end
  for _, m in ipairs(redis.call('ZRANGEBYSCORE', KEY.deadlines, '-inf', NOW, 'LIMIT', 0, 2 * n)) do
    local sep = string.find(m, '|', 1, true)
    if not sep then error('damaged deadline: ' .. m) end
    local cred = string.sub(m, sep + 1)
    need(KEY.op .. cred, 'hash') need(KEY.ended .. cred, 'hash')
  end
  -- Then changed, each kind read after the one before has run, as each change leaves well-formed records.
  local out = { expired = 0, ended = 0, deleted = 0 }
  local left = n
  for _, cred in ipairs(redis.call('ZRANGEBYSCORE', KEY.ops, '-inf', NOW, 'LIMIT', 0, left)) do
    local o = hgetall(KEY.op .. cred)
    if o.op ~= nil and o.result == '' then op_finish(cred, o, 'expired') out.expired = out.expired + 1
    else redis.call('ZREM', KEY.ops, cred) end
    left = left - 1
  end
  if left > 0 then
    for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEY.ends, '-inf', NOW, 'LIMIT', 0, left)) do
      local a = alert_get(id)
      if a then alert_delete(id, a, 'ended') out.ended = out.ended + 1 else redis.call('ZREM', KEY.ends, id) end
      left = left - 1
    end
  end
  if left > 0 then
    for _, m in ipairs(redis.call('ZRANGEBYSCORE', KEY.deadlines, '-inf', NOW, 'LIMIT', 0, left)) do
      local sep = string.find(m, '|', 1, true)
      local kind = string.sub(m, 1, sep - 1)
      local cred = string.sub(m, sep + 1)
      if kind == 'op' then
        local o = hgetall(KEY.op .. cred)
        if o.op ~= nil and o.result ~= '' then redis.call('DEL', KEY.op .. cred) rec_add('units', -1) out.deleted = out.deleted + 1 end
      elseif kind == 'ended' then
        if redis.call('EXISTS', KEY.ended .. cred) == 1 then redis.call('DEL', KEY.ended .. cred) rec_add('units', -1) out.deleted = out.deleted + 1 end
      end
      redis.call('ZREM', KEY.deadlines, m)
      left = left - 1
    end
  end
  return out
end

-- The fixed keys every store script touches, and the counters it adds to, checked before its first write.
local function need_store()
  need(KEY.records, 'hash') need(KEY.garbage, 'hash') need(KEY.deadlines, 'zset') need(KEY.ops, 'zset') need(KEY.ends, 'zset')
  for _, f in ipairs({ 'units', 'alerts', 'repl' }) do
    local v = redis.call('HGET', KEY.records, f)
    if v then integer(v, 'records ' .. f) end
  end
end
`;
