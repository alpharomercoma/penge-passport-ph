// Every device step is one Lua script on Valkey (Lua 5.1), run as is on MemoryKv in tests. Each script is this
// prelude plus its body, in Valkey's flagged form: scripts that may grow storage are refused before they start when
// memory is full; reclamation scripts (`reclaim`) run anyway (`allow-oom`), and write only small counters and removals.
//
// Inside a script: K.<name> is the key passed under that name, A.<name> the argument, NOW the time (ms) the caller
// passed, KEY.<kind> the prefix of keys a script names by id. Scripts check every key's type and every value before
// their first write, so nothing after the first write can fail on its input; they return JSON.
import { K } from '../keys.ts';
import type { Kv, ScriptDef } from '../kv.ts';

const KEY_PREFIXES = {
  alert: K.devAlert(''),
  endpoint: K.devEndpoint(''),
  cred: K.devCred(''),
  site: K.devSite(''),
  op: K.devOp(''),
  ended: K.devEnded(''),
  held: K.devHeld(''),
  claim: K.devClaim(''),
  fanout: K.devFanout(''),
  last: K.devLast(''),
  today: K.devToday('', '').slice(0, -1), // "pp:dev:today:" — then "<id>:<day>"
  tried: K.devTried(''),
  backoff: K.pushBackoff(''),
  // Fixed keys, by name.
  records: K.devRecords,
  garbage: K.devGarbage,
  deadlines: K.devDeadlines,
  ops: K.devOps,
  ends: K.devEnds,
  order: K.devOrder,
  queue: K.devQueue,
  queued: K.devQueued,
  fanouts: K.devFanouts,
  cursorDomestic: K.devCursor('domestic'),
  cursorAbroad: K.devCursor('abroad'),
  paused: K.pushPaused,
  lock: K.checkLock,
  cleanupLock: K.devCleanupLock,
};

const PRELUDE = `
local K = {}
do
  local names = cjson.decode(ARGV[1])
  for i = 1, #names do K[names[i]] = KEYS[i] end
end
local A = cjson.decode(ARGV[2])
local NOW = A.now
local KEY = cjson.decode('${JSON.stringify(KEY_PREFIXES)}')
-- A run whose id starts with "cleanup-" (admin.mjs device-cleanup, the rollback's pre-step) is fenced by its own lock,
-- never the checker's: a clean-up killed while holding it can never keep an older checker (and its email) from running.
-- (A checker run id is "<ms in base 36>-<random>": it reads "cleanup" only at 1970-11-14T07:19:49.825Z.)
if type(A.run) == 'string' and string.sub(A.run, 1, 8) == 'cleanup-' then KEY.lock = KEY.cleanupLock end
local function I(n) return string.format('%.0f', n) end
local function N(s)
  local n = tonumber(s)
  if n == nil then error('not a number: ' .. tostring(s)) end
  return n
end
local function TYPE(k) return redis.call('TYPE', k).ok end
local function need(k, t)
  local got = TYPE(k)
  if got ~= 'none' and got ~= t then error('WRONGTYPE ' .. k .. ' is a ' .. got .. ', not a ' .. t) end
end
local function hgetall(k)
  local flat = redis.call('HGETALL', k)
  local t = {}
  for i = 1, #flat, 2 do t[flat[i]] = flat[i + 1] end
  return t
end
-- Counters live in the day's pp:stats:v2:<day> hash, kept as long as the v1 numbers (40 days); "since" says when the
-- day's first one was written, so the report can split the deploy day between the two schemas.
-- Counting can never fail a step: a damaged statistics key costs a number, not a change (redis.pcall).
local function count(name, by)
  if K.stats == nil then return end
  local r = redis.pcall('HINCRBY', K.stats, name, by or 1)
  if type(r) == 'table' and r.err then return end
  local ttl = redis.pcall('PTTL', K.stats)
  if type(ttl) == 'number' and ttl < 0 then redis.pcall('EXPIRE', K.stats, 3456000) end
  if redis.pcall('HEXISTS', K.stats, 'since') == 0 then redis.pcall('HSET', K.stats, 'since', I(NOW)) end
end
-- A counter that is not an integer stops the step here, before anything is written.
local function counter(k)
  local v = redis.call('GET', k)
  if not v then return 0 end
  local n = tonumber(v)
  -- As INCR would read it: a canonical integer that adding one cannot overflow.
  -- "-0" too: Lua 5.1 reads it as negative zero and prints it back unchanged, but INCR refuses it.
  if v == '-0' or n == nil or n ~= math.floor(n) or I(n) ~= v or math.abs(n) >= 9007199254740991 then error('not a counter: ' .. k) end
  return n
end
local function rate_room(cur, prev, overlap, max)
  return counter(cur) + 1 + counter(prev) * overlap <= max
end
-- A window's counter lives until its next window ends (ttlMs from now), so at most two of a key's windows exist.
local function rate_take(cur, ttlMs)
  redis.call('INCR', cur)
  if redis.call('PTTL', cur) < 0 then redis.call('PEXPIRE', cur, ttlMs) end
end
-- clock.ts's elapsed(): uptime within one boot; the wall clock only where neither stamp has uptime; else unknown (nil).
local function elapsed(t, n)
  local timed = t.boot ~= nil and t.up ~= nil
  if n.boot ~= nil and n.up ~= nil then
    if timed and t.boot == n.boot and t.up <= n.up then return n.up - t.up end
    return nil
  end
  if timed then return nil end
  local w = n.wall - t.wall
  if w >= 0 then return w end
  return nil
end
`;

export interface DeviceScript {
  def: ScriptDef;
  run<T = unknown>(kv: Kv, keys: Record<string, string>, args: Record<string, unknown>): Promise<T>;
}

export const DEVICE_SCRIPTS: DeviceScript[] = [];

export function deviceScript(name: string, body: string, opts: { reclaim?: boolean } = {}): DeviceScript {
  const def: ScriptDef = { name, lua: `#!lua${opts.reclaim ? ' flags=allow-oom' : ''}\n${PRELUDE}\n${body}` };
  const script: DeviceScript = {
    def,
    async run<T>(kv: Kv, keys: Record<string, string>, args: Record<string, unknown>): Promise<T> {
      const names = Object.keys(keys);
      const out = await kv.script(def, names.map((n) => keys[n]!), [JSON.stringify(names), JSON.stringify(args)]);
      return JSON.parse(out) as T;
    },
  };
  DEVICE_SCRIPTS.push(script);
  return script;
}
