// Lua for delivery work (spec: "Encrypted or not", "Bounds", "Claims and sending"). Jobs are plain JSON:
// { i, n, s: stamps, d: [[office, date, group, stamp index], …] }. A date's identity is office, date and group; it
// keeps its original announcement stamp through every merge. Only the checker runs these, under its lock.
export const DELIVERY_LIB = `
local WINDOW_MS = 3 * 3600000
local MAX_DATES = 30
local MAX_JOB_BYTES = 4096

local function lock_ok()
  if redis.call('GET', KEY.lock) ~= A.run then return false end
  -- A clean-up run (its own lock, admin.mjs device-cleanup) stops while a checker holds the checker's: it must never
  -- take a live run's claims for abandoned ones. A checker that starts after a clean-up step finds that step done.
  if KEY.lock ~= KEY.checkLock and redis.call('EXISTS', KEY.checkLock) == 1 then return false end
  return true
end
local function slice(t, i, j)
  local out = {}
  for k = i, math.min(j, #t) do out[#out + 1] = t[k] end
  return out
end
-- A pace stamp as clock.ts makes it: a wall time, and an uptime with its boot id, or neither.
local function finite(v) return type(v) == 'number' and v == v and v ~= math.huge and v ~= -math.huge end
local function stamp_ok(st)
  if type(st) ~= 'table' or not finite(st.wall) then return false end
  if st.up == nil and st.boot == nil then return true end
  return finite(st.up) and type(st.boot) == 'string'
end
-- A job whose every stamp is a stamp and every date points at one; anything else reads as no job (dropped).
local function job_decode(raw)
  if not raw then return nil end
  local ok, j = pcall(cjson.decode, raw)
  if not ok or type(j) ~= 'table' or type(j.d) ~= 'table' or type(j.s) ~= 'table' or type(j.n) ~= 'string' then return nil end
  for _, st in ipairs(j.s) do if not stamp_ok(st) then return nil end end
  local function whole(v) return type(v) == 'number' and v == math.floor(v) end
  for _, d in ipairs(j.d) do
    if type(d) ~= 'table' or not whole(d[1]) or type(d[2]) ~= 'string' or not whole(d[3]) or not whole(d[4])
      or d[4] < 0 or d[4] >= #j.s then return nil end
  end
  return j
end
local function dkey(d) return I(d[1]) .. '|' .. d[2] .. '|' .. I(d[3]) end
local function stamp_of(job, d) return job.s[d[4] + 1] end
local function same_stamp(a, b) return a.wall == b.wall and a.up == b.up and a.boot == b.boot end
local function stamp_index(job, st)
  for i = 1, #job.s do if same_stamp(job.s[i], st) then return i - 1 end end
  job.s[#job.s + 1] = st
  return #job.s - 1
end
-- The job with only these dates, its stamp table rebuilt.
local function job_with(job, dates)
  local out = { i = job.i, n = job.n, s = {}, d = {} }
  for _, d in ipairs(dates) do out.d[#out.d + 1] = { d[1], d[2], d[3], stamp_index(out, stamp_of(job, d)) } end
  return out
end
-- Adds src's dates that dst lacks; a date already there keeps its own (original) stamp.
local function job_merge(dst, src)
  local have = {}
  for _, d in ipairs(dst.d) do have[dkey(d)] = true end
  for _, d in ipairs(src.d) do
    if not have[dkey(d)] then
      have[dkey(d)] = true
      dst.d[#dst.d + 1] = { d[1], d[2], d[3], stamp_index(dst, stamp_of(src, d)) }
    end
  end
  return dst
end
local function by_age(job)
  local list = {}
  for _, d in ipairs(job.d) do list[#list + 1] = d end
  table.sort(list, function(a, b)
    local wa, wb = stamp_of(job, a).wall, stamp_of(job, b).wall
    if wa ~= wb then return wa < wb end
    return dkey(a) < dkey(b)
  end)
  return list
end
-- At most MAX_DATES dates and MAX_JOB_BYTES bytes, the oldest dropped first. Returns the job (nil if empty) and the drops.
local function job_bound(job)
  local list = by_age(job)
  local dropped = 0
  while #list > MAX_DATES do table.remove(list, 1) dropped = dropped + 1 end
  local j = job_with(job, list)
  while #j.d > 0 and #cjson.encode(j) > MAX_JOB_BYTES do
    table.remove(list, 1)
    dropped = dropped + 1
    j = job_with(job, list)
  end
  if #j.d == 0 then return nil, dropped end
  return j, dropped
end
local function oldest_wall(job)
  local w = nil
  for _, d in ipairs(job.d) do
    local x = stamp_of(job, d).wall
    if w == nil or x < w then w = x end
  end
  return w
end
-- The dates still for alert a (its incarnation, offices and group) and inside their window as of stamp nowst. A date
-- whose age cannot be known is dropped, never given a new window. Returns the job (nil if empty) and drops by reason.
local function job_prune(job, a, nowst)
  local drop = { choices = 0, window = 0, unknown = 0 }
  if not a or job.n ~= a.inc then drop.choices = #job.d return nil, drop end
  local offices = {}
  for o in string.gmatch(a.offices, '[^,]+') do offices[o] = true end
  local keep = {}
  for _, d in ipairs(job.d) do
    local age = elapsed(stamp_of(job, d), nowst)
    if not offices[I(d[1])] or I(d[3]) ~= a.group then drop.choices = drop.choices + 1
    elseif age == nil then drop.unknown = drop.unknown + 1
    elseif age > WINDOW_MS then drop.window = drop.window + 1
    else keep[#keep + 1] = d end
  end
  if #keep == 0 then return nil, drop end
  return job_with(job, keep), drop
end
local function count_drops(drop)
  if drop.choices > 0 then count('dates_dropped_choices', drop.choices) end
  if drop.window > 0 then count('dates_dropped_window', drop.window) end
  if drop.unknown > 0 then count('dates_dropped_unknown_age', drop.unknown) end
end
`;
