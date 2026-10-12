// Runs scripts' real Lua on MemoryKv, for tests and the local stack: Lua 5.4 (wasmoon) with Valkey's redis.call,
// redis.pcall and cjson, synchronously, so nothing else touches the store while a script runs.
import { LuaFactory } from 'wasmoon';
import { MemoryKv, type Reply } from '../src/kv.ts';
import { CJSON_LUA } from './cjson-lua.ts';

const factory = new LuaFactory();

/** A Lua string literal of the exact UTF-8 bytes, valid in Lua 5.1 and 5.4. */
const literal = (s: string) =>
  `"${[...Buffer.from(s, 'utf8')].map((b) => (b >= 32 && b < 127 && b !== 34 && b !== 92 ? String.fromCharCode(b) : `\\${String(b).padStart(3, '0')}`)).join('')}"`;
// Three digits always: "\10" followed by "1" would otherwise read as "\101".

const PRELUDE = `
unpack = unpack or table.unpack
-- The bridge to MemoryKv, kept as locals (the sealed globals below no longer show them to scripts).
local __call_, __value_, __len_, __item_ = __call, __value, __len, __item
local function conv(kind)
  if kind == 'nil' then return false end
  if kind == 'status' then return { ok = __value_() } end
  if kind == 'array' then
    local t = {}
    for i = 1, __len_() do
      local v = __item_(i)
      if v == nil then v = false end
      t[i] = v
    end
    return t
  end
  return __value_()
end
-- The engine carries text, not bytes (wasmoon decodes strings as UTF-8): a string that is not UTF-8 text, or holds a
-- NUL, would arrive changed. It is refused instead, so such a script fails here rather than passing wrongly.
local function __text(s, where)
  if type(s) == 'string' and (utf8.len(s) == nil or string.find(s, '\0', 1, true)) then
    error('MemoryKv Lua engine: a NUL byte or broken UTF-8 in ' .. where .. ' (the engine carries text only)', 0)
  end
  return s
end
local function __args(...)
  for i = 1, select('#', ...) do __text((select(i, ...)), 'a command argument') end
end
-- A script's answer as the Valkey client prints it (connectRedis.script: String(reply)), converted here in Lua as
-- Valkey converts it: a number to an integer (toward zero), true to 1, false and nil to nil, a table to its ok or err,
-- else its array part up to the first nil, nested arrays flattened as String() of an array does.
local function __resp(v, top)
  local t = type(v)
  if t == 'string' then return __text(v, 'a reply') end
  if t == 'number' then
    if v >= 0 then return string.format('%.0f', math.floor(v)) end
    return string.format('%.0f', math.ceil(v))
  end
  if t == 'boolean' and v then return '1' end
  if t == 'table' then
    if type(v.err) == 'string' then error(v.err, 0) end
    if type(v.ok) == 'string' then return __text(v.ok, 'a reply') end
    local parts, i = {}, 1
    while v[i] ~= nil do
      parts[i] = __resp(v[i], false)
      i = i + 1
    end
    return table.concat(parts, ',')
  end
  if top then return 'null' end
  return ''
end
redis = { LOG_DEBUG = 0, LOG_VERBOSE = 1, LOG_NOTICE = 2, LOG_WARNING = 3 }
function redis.call(...) __args(...) return conv(__call_(...)) end
function redis.pcall(...)
  __args(...)
  local ok, kind = pcall(__call_, ...)
  if not ok then return { err = tostring(kind) } end
  return conv(kind)
end
function redis.error_reply(m) return { err = m } end
function redis.status_reply(m) return { ok = m } end
function redis.log() end
-- Lua 5.1 prints a number with %.14g (1.0 is "1"); Lua 5.4 would print "1.0". (Concatenating a float still differs:
-- device scripts format numbers with I() or string.format, never by concatenation.)
do
  local tostring_ = tostring
  tostring = function(v)
    if type(v) == 'number' then return string.format('%.14g', v) end
    return tostring_(v)
  end
end
`;

// After the engine's globals and KEYS/ARGV are set, the global table and every library table are read-only, and
// reading a global that does not exist is an error, as in Valkey's sandbox. The bridge's globals are removed.
const SEAL = `
do
  local _G, pairs, rawset, setmetatable, error, tostring, type = _G, pairs, rawset, setmetatable, error, tostring, type
  local G = {}
  for k, v in pairs(_G) do G[k] = v end
  local function readonly(t, name)
    return setmetatable({}, {
      __index = t,
      __newindex = function(_, k) error('Attempt to modify a readonly table: ' .. name .. '.' .. tostring(k), 2) end,
      __metatable = false,
    })
  end
  for k, v in pairs(G) do
    if type(v) == 'table' and k ~= '_G' and k ~= 'KEYS' and k ~= 'ARGV' then G[k] = readonly(v, k) end
  end
  G.__call, G.__value, G.__len, G.__item = nil, nil, nil, nil
  for k in pairs(G) do rawset(_G, k, nil) end
  setmetatable(_G, {
    __index = function(_, n)
      local v = G[n]
      if v == nil then error("Script attempted to access nonexistent global variable '" .. tostring(n) .. "'", 2) end
      return v
    end,
    __newindex = function(_, n) error('Attempt to modify a readonly table: ' .. tostring(n), 2) end,
    __metatable = false,
  })
end
`;

/** A NUL byte would be cut short crossing into Lua: refused. (Broken UTF-8 is caught on the Lua side.) */
function carried(s: string, where: string): string {
  if (s.includes('\u0000')) throw new Error(`MemoryKv Lua engine: a NUL byte in ${where} (the engine carries text only)`);
  return s;
}

/** Null when `source` compiles as a script body (the shebang line dropped), else the compiler's message. Runs nothing. */
export async function compileError(source: string): Promise<string | null> {
  const engine = await factory.createEngine({ enableProxy: false, injectObjects: false });
  try {
    const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
    const r = engine.doStringSync(`local f, err = load(${literal(`return function() ${body}\nend`)}) if f then return '' end return err`);
    return r === '' ? null : String(r);
  } finally {
    engine.global.close();
  }
}

export function installLua(): void {
  MemoryKv.lua = async (source, keys, args, call) => {
    const engine = await factory.createEngine({ enableProxy: false, injectObjects: false });
    let last: Reply = null;
    const usable = (a: unknown): a is string | number => typeof a === 'string' || typeof a === 'number';
    engine.global.set('__call', (...argv: unknown[]) => {
      // As Valkey: only strings and numbers may be arguments; a number is sent as %.17g would print it.
      if (argv.length === 0 || !argv.every(usable)) {
        throw new Error('Lua redis lib command arguments must be strings or integers');
      }
      last = call(argv.map((a) => (typeof a === 'number' ? (Number.isInteger(a) ? String(a) : String(Number(a.toPrecision(17)))) : carried(a, 'a command argument'))));
      if (typeof last === 'string') carried(last, 'a stored value');
      if (Array.isArray(last)) for (const v of last) if (typeof v === 'string') carried(v, 'a stored value');
      if (last === null) return 'nil';
      if (Array.isArray(last)) return 'array';
      if (typeof last === 'object') return 'status';
      return 'value';
    });
    engine.global.set('__value', () => (last !== null && typeof last === 'object' && !Array.isArray(last) ? last.ok : (last ?? undefined)));
    engine.global.set('__len', () => (Array.isArray(last) ? last.length : 0));
    engine.global.set('__item', (i: number) => (Array.isArray(last) ? (last[i - 1] ?? undefined) : undefined));
    const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
    for (const k of keys) carried(k, 'a key');
    for (const a of args) carried(a, 'an argument');
    const program = `${CJSON_LUA}\n${PRELUDE}\nKEYS = {${keys.map(literal).join(',')}}\nARGV = {${args.map(literal).join(',')}}\n${SEAL}\nreturn __resp((function()\n${body}\nend)(), true)`;
    return () => {
      try {
        // __resp has already printed the reply as the client would: a string, always.
        return String(engine.doStringSync(program));
      } finally {
        engine.global.close();
      }
    };
  };
}
