import { describe, expect, it } from 'vitest';
import { type Kv, MemoryKv, type ScriptDef } from '../src/kv.ts';
import { clock } from './helpers.ts';
import { lintLua51 } from './lua-subset.ts';
import { valkeyTargets } from './valkey.ts';

const lua = (name: string, source: string): ScriptDef => ({ name, lua: `#!lua\n${source}` });
const run = (kv: Kv, source: string, keys: string[] = [], args: string[] = []) => kv.script(lua('t', source), keys, args);

for (const [name, make] of valkeyTargets()) {
  describe(`Lua scripts on ${name}`, () => {
    it('passes KEYS and ARGV as strings, byte for byte', async () => {
      const kv = await make();
      const out = await run(kv, "return KEYS[1] .. '|' .. ARGV[1] .. '|' .. #ARGV[2]", ['k"\\'], ['a\nb', 'é']);
      expect(out).toBe('k"\\|a\nb|2');
    });

    it('answers missing values with false, and status replies as tables', async () => {
      const kv = await make();
      const out = await run(kv, "redis.call('SET', 's', 'v') return tostring(redis.call('GET', 'nope')) .. '|' .. redis.call('TYPE', 's').ok .. '|' .. redis.call('TYPE', 'nope').ok");
      expect(out).toBe('false|string|none');
    });

    it('keeps hashes, sets, sorted sets and lists as Valkey does', async () => {
      const kv = await make();
      const out = await run(
        kv,
        `redis.call('HSET', 'h', 'a', '1', 'b', '2')
         redis.call('HINCRBY', 'h', 'a', 4)
         redis.call('SADD', 'st', 'x', 'y')
         redis.call('SREM', 'st', 'x')
         redis.call('ZADD', 'z', 30, 'c', 10, 'a', 20, 'b')
         redis.call('RPUSH', 'l', 'p', 'q')
         local r = redis.call('ZRANGEBYSCORE', 'z', '-inf', '(30', 'LIMIT', 0, 5)
         local first = redis.call('LPOP', 'l')
         return table.concat({ redis.call('HGET', 'h', 'a'), redis.call('HLEN', 'h'), table.concat(redis.call('SMEMBERS', 'st'), ','),
           table.concat(r, ','), redis.call('ZSCORE', 'z', 'c'), redis.call('ZCARD', 'z'), first, redis.call('LLEN', 'l'),
           tostring(redis.call('HMGET', 'h', 'a', 'zz')[2]) }, '|')`,
      );
      expect(out).toBe('5|2|y|a,b|30|3|p|1|false');
    });

    it('fails the whole script on a wrong type, and redis.pcall catches it', async () => {
      const kv = await make();
      await run(kv, "redis.call('SET', 's', 'v') return 'ok'");
      await expect(run(kv, "return redis.call('HGET', 's', 'f')")).rejects.toThrow(/WRONGTYPE/);
      expect(await run(kv, "local r = redis.pcall('HGET', 's', 'f') return type(r.err)")).toBe('string');
    });

    it('decodes and encodes JSON with cjson', async () => {
      const kv = await make();
      const out = await run(kv, "local t = cjson.decode(ARGV[1]) return cjson.encode({ n = t.n + 1, s = t.s, a = t.a })", [], ['{"n":1791261968326,"s":"x\\"y","a":[1,2]}']);
      expect(JSON.parse(out)).toEqual({ n: 1791261968327, s: 'x"y', a: [1, 2] });
    });

    it('decodes JSON null to cjson.null, not nil, as Valkey does', async () => {
      const kv = await make();
      expect(await run(kv, "local t = cjson.decode(ARGV[1]) return tostring(t.a == nil) .. '|' .. tostring(t.a == cjson.null)", [], ['{"a":null}'])).toBe('false|true');
    });

    it.each(['{"a":1;"b":2}', '[1;2]', '{"a" 1}', '{a:1}', '{"a":1}x', '{"a":}', '"\\q"', '"\\ud800"', '"\\udc00"', '"\\ud800\\u0041"'])('refuses malformed JSON %s as cjson does', async (bad) => {
      const kv = await make();
      expect(await run(kv, "local ok = pcall(cjson.decode, ARGV[1]) return tostring(ok)", [], [bad])).toBe('false');
    });

    it('decodes a surrogate pair to one 4-byte character, and encodes nil as null, as cjson does', async () => {
      const kv = await make();
      expect(await run(kv, "return cjson.decode(ARGV[1])", [], ['"\\ud83d\\ude00"'])).toBe('\u{1F600}');
      expect(await run(kv, "return cjson.encode(nil)", [], [])).toBe('null');
    });

    it('keeps a control byte followed by a digit exact', async () => {
      const kv = await make();
      expect(await run(kv, "return ARGV[1]", [], ['\n1\\2\u00012'])).toBe('\n1\\2\u00012');
    });

    it('refuses a table or boolean as a command argument', async () => {
      const kv = await make();
      await expect(run(kv, "return redis.call('SET', 'k', true)")).rejects.toThrow(/arguments must be strings or integers/);
    });

    it('lists hash fields with HKEYS', async () => {
      const kv = await make();
      expect(await run(kv, "redis.call('HSET', 'h', 'a', '1', 'b', '2') local k = redis.call('HKEYS', 'h') table.sort(k) return table.concat(k, ',')")).toBe('a,b');
    });

    it('refuses a command with the wrong number of arguments, or a bad option, before it changes anything', async () => {
      const kv = await make();
      expect(await run(kv, "local r = redis.pcall('GET') return type(r) == 'table' and type(r.err)")).toBe('string');
      await expect(run(kv, "return redis.call('GET', 'k', 'extra')")).rejects.toThrow(/wrong number of arg/i);
      await expect(run(kv, "return redis.call('SET', 'k', 'v', 'PX', 0)")).rejects.toThrow(/invalid expire/);
      await expect(run(kv, "return redis.call('EXPIRE', 'missing', 'bad')")).rejects.toThrow(/not an integer/);
      expect(await run(kv, "return tostring(redis.call('GET', 'k'))")).toBe('false');
    });

    it('refuses writes in a no-writes script, and an unknown flag', async () => {
      const kv = await make();
      await expect(kv.script({ name: 'ro', lua: "#!lua flags=no-writes\nredis.call('SET', 'k', 'v') return 'ok'" }, [], [])).rejects.toThrow(/not allowed/);
      expect(await run(kv, "return tostring(redis.call('GET', 'k'))")).toBe('false');
      await expect(kv.script({ name: 'bad', lua: "#!lua flags=bogus\nreturn 'ok'" }, [], [])).rejects.toThrow(/Unexpected flag/);
    });

    it('answers false, nil, true and arrays as the client reads them', async () => {
      const kv = await make();
      expect(await run(kv, 'return false')).toBe('null');
      expect(await run(kv, 'return nil')).toBe('null');
      expect(await run(kv, 'return true')).toBe('1');
      expect(await run(kv, "return {1, 'a'}")).toBe('1,a');
      expect(await run(kv, 'return tostring(1.0) .. "|" .. tostring(3 / 2)')).toBe('1|1.5');
    });

    it('validates every argument before writing: ZADD and HINCRBY', async () => {
      const kv = await make();
      expect(await run(kv, "redis.pcall('ZADD', 'z', 1, 'a', 'bad', 'b') return redis.call('ZCARD', 'z')")).toBe('0');
      expect(await run(kv, "redis.pcall('HINCRBY', 'h', 'f', 'x') return redis.call('EXISTS', 'h')")).toBe('0');
      await expect(run(kv, "return redis.call('ZADD', 'z', '', 'm')")).rejects.toThrow(/not a valid float/);
      expect(await run(kv, "redis.call('ZADD', 'z', '+inf', 'hi', '-inf', 'lo', 5, 'mid') return table.concat(redis.call('ZRANGE', 'z', 0, -1), ',')")).toBe('lo,mid,hi');
      // An empty bound reads as 0 on Valkey (the oracle here), unlike an empty score.
      expect(await run(kv, "return table.concat(redis.call('ZRANGEBYSCORE', 'z', '', 5), ',')")).toBe('mid');
    });

    it('answers an empty range when the end comes before the start', async () => {
      const kv = await make();
      const out = await run(
        kv,
        `redis.call('ZADD', 'z', 1, 'a', 2, 'b', 3, 'c') redis.call('RPUSH', 'l', 'a', 'b', 'c')
         return #redis.call('ZRANGE', 'z', 0, -5) .. '|' .. #redis.call('LRANGE', 'l', 0, -5) .. '|' .. #redis.call('LRANGE', 'l', 5, 9)`,
      );
      expect(out).toBe('0|0|0');
    });

    it('orders equal scores by their bytes', async () => {
      const kv = await make();
      expect(await run(kv, "redis.call('ZADD', 'z', 1, ARGV[1], 1, ARGV[2]) return redis.call('ZRANGE', 'z', 0, -1)[1] == ARGV[2] and 'byte' or 'utf16'", [], ['\u{10000}', ''])).toBe('byte');
    });

    it('removes as many as LREM is told, from either end', async () => {
      const kv = await make();
      const out = await run(
        kv,
        `redis.call('RPUSH', 'l', 'a', 'x', 'a', 'a') redis.call('LREM', 'l', 1, 'a') local one = table.concat(redis.call('LRANGE', 'l', 0, -1), '')
         redis.call('LREM', 'l', -1, 'a') return one .. '|' .. table.concat(redis.call('LRANGE', 'l', 0, -1), '')`,
      );
      expect(out).toBe('xaa|xa');
    });

    it('encodes sparse arrays, refuses infinity and boolean keys, as cjson does', async () => {
      const kv = await make();
      expect(await run(kv, "return cjson.encode({ [1] = 'a', [3] = 'b' })")).toBe('["a",null,"b"]');
      expect(await run(kv, 'return tostring(pcall(cjson.encode, 1 / 0))')).toBe('false');
      expect(await run(kv, 'return tostring(pcall(cjson.encode, { [true] = 1 }))')).toBe('false');
    });

    it('refuses undeclared global variables, read or written', async () => {
      const kv = await make();
      await expect(run(kv, "missing = 'ok' return missing")).rejects.toThrow(/global|readonly|read-only/i);
      await expect(run(kv, 'return tostring(nothere)')).rejects.toThrow(/global/i);
    });

    it('combines every flags= token of the shebang, and refuses other options', async () => {
      const kv = await make();
      await expect(kv.script({ name: 'ro2', lua: "#!lua flags=allow-oom flags=no-writes\nredis.call('SET', 'k', 'v') return 'ok'" }, [], [])).rejects.toThrow(/not allowed/);
      await expect(kv.script({ name: 'opt', lua: "#!lua bogus=1\nreturn 'ok'" }, [], [])).rejects.toThrow(/shebang/i);
      await expect(kv.script({ name: 'empty', lua: "#!lua flags=no-writes,,allow-oom\nreturn 'ok'" }, [], [])).rejects.toThrow(/flag/i);
      expect(await run(kv, "return tostring(redis.call('GET', 'k'))")).toBe('false');
    });

    it('converts nested, empty and nil-ended tables as the client reads them', async () => {
      const kv = await make();
      expect(await run(kv, 'return {}')).toBe('');
      expect(await run(kv, 'return {1, nil, 3}')).toBe('1');
      expect(await run(kv, 'return {{1.9, true, false}}')).toBe('1,1,');
      expect(await run(kv, "return redis.call('LRANGE', 'missing', 0, -1)")).toBe('');
      expect(await run(kv, 'return string.char(239, 191, 189)')).toBe('�');
    });

    it('keeps the globals and the libraries read-only', async () => {
      const kv = await make();
      await expect(run(kv, "redis = {} return 'ok'")).rejects.toThrow(/readonly|read-only|global/i);
      await expect(run(kv, "redis.call = function() return 'x' end return redis.call('SET', 'x', 'v')")).rejects.toThrow(/readonly|read-only|global/i);
    });

    it('refuses options outside the commands\' syntax before changing anything', async () => {
      const kv = await make();
      await run(kv, "redis.call('ZADD', 'z', 1, 'a', 2, 'b', 3, 'c') return 'ok'");
      await expect(run(kv, "return redis.call('ZRANGEBYSCORE', 'z', 0, 3, 'BOGUS')")).rejects.toThrow(/syntax/i);
      await expect(run(kv, "return redis.call('FLUSHDB', 'BOGUS')")).rejects.toThrow(/syntax/i);
      expect(await run(kv, "return redis.call('ZCARD', 'z')")).toBe('3');
      await expect(run(kv, "return redis.call('ZADD', 'z', '0b10', 'm')")).rejects.toThrow(/not a valid float/);
      expect(await run(kv, "return #redis.call('ZRANGEBYSCORE', 'z', 0, 3, 'LIMIT', -1, -1)")).toBe('0');
      await expect(run(kv, "return redis.call('FLUSHDB', '')")).rejects.toThrow(/syntax/i);
      expect(await run(kv, "return redis.call('ZCARD', 'z')")).toBe('3');
      await expect(run(kv, "return redis.call('ZADD', 'z', '1e999', 'm')")).rejects.toThrow(/not a valid float/);
      await run(kv, "redis.call('SET', 's', 'v') return 'ok'");
      await expect(run(kv, "return redis.call('ZRANGEBYSCORE', 's', 0, 3, 'LIMIT', -1, -1)")).rejects.toThrow(/WRONGTYPE/);
    });

    it('formats large integers exactly with %.0f', async () => {
      const kv = await make();
      expect(await run(kv, "return string.format('%.0f', 1791261968326 + tonumber(ARGV[1]))", [], ['1'])).toBe('1791261968327');
    });
  });
}

describe('MemoryKv and Lua', () => {
  it('refuses a script that may write when memory is full, before it starts, and runs allow-oom ones', async () => {
    const kv = new MemoryKv();
    kv.oom = true;
    await expect(kv.script(lua('grow', "redis.call('SET', 'a', '1') return 'ok'"), [], [])).rejects.toThrow(/OOM/);
    expect(kv.keys()).toEqual([]);
    expect(await kv.script({ name: 'free', lua: "#!lua flags=allow-oom\nredis.call('DEL', 'a') return 'ok'" }, [], [])).toBe('ok');
  });

  it('holds time still while a Lua script runs', async () => {
    let ms = 0;
    const kv = new MemoryKv(() => (ms += 1));
    await kv.set('k', 'v', { ttlSeconds: 0.005 });
    const out = await kv.script(lua('slow', "for i = 1, 50 do redis.call('EXISTS', 'k') end return tostring(redis.call('GET', 'k'))"), [], []);
    expect(out).toBe('v');
  });

  it('runs a script without a Lua engine only if it has a memory twin', async () => {
    const saved = MemoryKv.lua;
    MemoryKv.lua = null;
    try {
      await expect(new MemoryKv().script(lua('x', "return 'x'"), [], [])).rejects.toThrow(/no Lua engine/);
    } finally {
      MemoryKv.lua = saved;
    }
  });

  it('refuses bytes its engine cannot carry exactly, rather than corrupting them', async () => {
    const kv = new MemoryKv();
    await expect(kv.script(lua('nul', 'return ARGV[1]'), [], ['a\u0000b'])).rejects.toThrow(/NUL/);
    await expect(kv.script(lua('half', "return string.sub(ARGV[1], 1, 1)"), [], ['é'])).rejects.toThrow(/UTF-8/);
    await expect(kv.script(lua('nested', 'return {{string.char(97, 0, 98)}}'), [], [])).rejects.toThrow(/NUL|UTF-8/);
  });

  it('reports the memory it was told, for the admission guard', async () => {
    const t = clock();
    const kv = new MemoryKv(t.now);
    kv.memoryUse = { used: 50, max: 100 };
    expect(await kv.memory()).toEqual({ used: 50, max: 100 });
  });
});

describe('the Lua 5.1 subset', () => {
  it('accepts plain 5.1 code, whatever its strings and comments hold', () => {
    expect(lintLua51("#!lua\nlocal s = 'a|b//c' -- x // y\nreturn unpack({ s })")).toEqual([]);
  });

  it('names every construct Valkey (Lua 5.1) does not have', () => {
    const found = lintLua51('#!lua\nlocal a = 7 // 2\ngoto x\n::x::\nlocal b = 1 & 2\nlocal c = table.unpack({})\nlocal d = utf8.char(1)\nlocal e = math.pow(2, 3)\nlocal f <const> = 1');
    expect(found).toEqual(['//', 'goto', '::label::', 'bitwise operator', 'table.unpack', 'utf8', 'math.pow', 'attribute']);
  });

  it('finds string escapes Lua 5.1 does not have', () => {
    expect(lintLua51("#!lua\nreturn '\\x41'")).toEqual(['escape']);
    expect(lintLua51('#!lua\nreturn "a\\z  b"')).toEqual(['escape']);
    expect(lintLua51("#!lua\nreturn '\\u{41}'")).toEqual(['escape']);
    expect(lintLua51("#!lua\nreturn '\\n\\065'")).toEqual([]);
  });

  it('refuses raw table access and metatables in scripts (the engine does not sandbox them as Valkey does)', () => {
    expect(lintLua51("#!lua\nrawset(_G, 'x', 1) return getmetatable('')")).toEqual(['raw access/metatable']);
  });

  it('requires the flagged script form', () => {
    expect(lintLua51("return 'x'")).toEqual(['no #!lua shebang']);
  });
});
