// Putting a claim back (spec: "Claims and sending", step 4). Appended after STORE_LIB and DELIVERY_LIB.
export const CLAIM_LIB = `
local MAX_TRIES = 3
-- Today's count goes down on the claim's charged day, only if that counter still exists and never below zero.
local function give_back(id, c)
  local tk = KEY.today .. id .. ':' .. c.day
  local v = tonumber(redis.call('GET', tk) or '')
  if v ~= nil and v > 0 then redis.call('DECR', tk) end
end
-- A claim as the claim script writes it, and its charged counter (a string holding a canonical integer), checked before
-- a step's first write: putting it back writes or compares every one of these fields.
local function charged_ok(id, c)
  for _, f in ipairs({ 'cid', 'run', 'inc', 'gen', 'rev', 'day', 'prev', 'at', 'state', 'job' }) do
    if type(c[f]) ~= 'string' then error('damaged claim ' .. id .. ': ' .. f) end
  end
  local tk = KEY.today .. id .. ':' .. c.day
  need(tk, 'string')
  counter(tk)
end
-- The claim's dates go back into the alert's current held work (filtered, original times kept); its count is given
-- back; its pace stamp is restored only if it still holds this claim's stamp. As a refusal each date's tries go up
-- (dropped after MAX_TRIES); unattempted, tries are untouched and the run's attempt mark is removed. Everything is read
-- and decided, and every value encoded, before the first write.
local function put_back(id, c, a, refusal, nowst)
  charged_ok(id, c)
  local job = job_decode(c.job)
  local tries = {}
  local dropped = 0
  local heldJson = false
  if a and job and job.n == a.inc then
    local back = {}
    for _, d in ipairs(job.d) do
      if refusal then
        local k = dkey(d)
        local t = (tonumber(redis.call('HGET', KEY.tried .. id, k) or '0') or 0) + 1
        if t >= MAX_TRIES then tries[#tries + 1] = { k, false } dropped = dropped + 1
        else tries[#tries + 1] = { k, t } back[#back + 1] = d end
      else
        back[#back + 1] = d
      end
    end
    local held = job_decode(redis.call('GET', KEY.held .. id))
    if not held or held.n ~= a.inc then held = { i = id, n = a.inc, s = {}, d = {} } end
    if #back > 0 then job_merge(held, job_with(job, back)) end
    local pruned, drop = job_prune(held, a, nowst)
    local bounded, overflow = nil, 0
    if pruned then bounded, overflow = job_bound(pruned) end
    heldJson = bounded and cjson.encode(bounded) or nil
    -- Then write.
    count_drops(drop)
    if overflow > 0 then count('dates_dropped_overflow', overflow) end
  end
  for _, t in ipairs(tries) do
    if t[2] then redis.call('HSET', KEY.tried .. id, t[1], t[2]) else redis.call('HDEL', KEY.tried .. id, t[1]) end
  end
  if dropped > 0 then count('dates_dropped_tries', dropped) end
  if heldJson then redis.call('SET', KEY.held .. id, heldJson) elseif heldJson == nil then redis.call('DEL', KEY.held .. id) end
  give_back(id, c)
  if redis.call('GET', KEY.last .. id) == c.at then
    if c.prev ~= '' then redis.call('SET', KEY.last .. id, c.prev) else redis.call('DEL', KEY.last .. id) end
  end
  if not refusal and redis.call('HGET', KEY.tried .. id, 'run') == c.run then redis.call('HDEL', KEY.tried .. id, 'run') end
  redis.call('DEL', KEY.claim .. id)
  if refusal then count('claims_refused') else count('claims_unattempted') end
end
`;
