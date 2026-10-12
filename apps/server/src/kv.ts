// The few Redis operations the server uses, behind an interface so tests run
// against an in-memory twin with the same semantics (including expiry).
import { createClient } from '@redis/client';

/** Writes applied together, atomically, in one MULTI. */
export type WriteOp =
  | { op: 'set'; key: string; value: string; ttlSeconds?: number }
  | { op: 'del'; key: string }
  | { op: 'hSet'; key: string; fields: Record<string, string> }
  | { op: 'hDel'; key: string; fields: string[] }
  | { op: 'sAdd'; key: string; members: string[] }
  | { op: 'sRem'; key: string; members: string[] }
  | { op: 'rPush'; key: string; values: string[] }
  | { op: 'expire'; key: string; ttlSeconds: number }
  /** Undo one increment, keeping the counter's expiry. */
  | { op: 'decr'; key: string }
  | { op: 'persist'; key: string };

/** What a script sees: the store, with nothing else running until it returns (a Lua script on Valkey). */
export interface ScriptTx {
  type(key: string): 'none' | 'string' | 'hash' | 'set' | 'list' | 'zset' | 'other';
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
  exists(key: string): boolean;
  /** -2 missing, -1 no expiry, else seconds left (rounded to the nearest second, as Valkey's TTL). */
  ttl(key: string): number;
  /** As ttl, in milliseconds. */
  pttl(key: string): number;
  expire(key: string, seconds: number): void;
  /** The hash methods throw WRONGTYPE on a key of another type, as Valkey does. */
  hGet(key: string, field: string): string | null;
  hSet(key: string, field: string, value: string): void;
  hDel(key: string, field: string): void;
  hLen(key: string): number;
  hGetAll(key: string): Record<string, string>;
}

/** One atomic operation: Lua for Valkey. Device scripts have no twin: MemoryKv runs their Lua (tests install an engine). */
export interface ScriptDef {
  name: string;
  lua: string;
  memory?(tx: ScriptTx, keys: string[], args: string[]): string;
}

/** A Valkey reply as a script sees it: bulk string, integer, nil, status, or a flat array of those. */
export type Reply = string | number | null | { ok: string } | (string | number | null)[];

/** Prepares a script (async), then runs it synchronously: nothing else may touch the store in between. */
export type LuaRunner = (source: string, keys: string[], args: string[], call: (argv: string[]) => Reply) => Promise<() => string>;

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns false when `nx` is set and the key already exists. */
  set(key: string, value: string, opts?: { ttlSeconds?: number; nx?: boolean }): Promise<boolean>;
  /** Increment a counter (by 1 unless `by` says); a new counter expires after `ttlSeconds`. */
  incr(key: string, ttlSeconds: number, by?: number): Promise<number>;
  /** Increment one field of a hash by 1; a new hash expires after `ttlSeconds`. */
  hIncr(key: string, field: string, ttlSeconds: number): Promise<number>;
  /** Add to a HyperLogLog, which estimates how many distinct members it was given; a new one expires after `ttlSeconds`. */
  pfAdd(key: string, member: string, ttlSeconds: number): Promise<void>;
  /** A HyperLogLog's estimate (0.81% standard error in Redis; exact in MemoryKv). */
  pfCount(key: string): Promise<number>;
  /** Undo one increment. */
  decr(key: string): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  sMembers(key: string): Promise<string[]>;
  /** Every key matching a pattern of literal characters, * and ? (SCAN MATCH, COUNT 500), each once; any other glob is refused. */
  scan(pattern: string): Promise<string[]>;
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
  write(ops: WriteOp[]): Promise<void>;
  /** Runs a script atomically and returns its answer. */
  script(def: ScriptDef, keys: string[], args: string[]): Promise<string>;
  /** `used_memory` and `maxmemory` (0 when unlimited), read now, for the device admission guard. */
  memory(): Promise<{ used: number; max: number }>;
  /** INFO persistence: the last successful snapshot (seconds) and its latest status, and the append-only rewrites' count, progress, failures and status. */
  persistence(): Promise<{ rdbLastSave: number | null; rdbStatus: string | null; aofRewrites: number | null; aofInProgress: number | null; aofFailures: number | null; aofRewriteStatus: string | null }>;
  close(): Promise<void>;
}

export async function connectRedis(url: string, onError: (err: Error) => void): Promise<Kv> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 10_000,
      // Keep retrying with a capped backoff; each command still fails fast below.
      reconnectStrategy: (retries) => Math.min(250 * 2 ** retries, 10_000),
    },
    // Fail commands instead of queueing them forever while disconnected.
    disableOfflineQueue: true,
  });
  client.on('error', onError);
  await client.connect();
  return {
    get: (key) => client.get(key),
    async set(key, value, opts = {}) {
      const reply = await client.set(key, value, {
        ...(opts.ttlSeconds ? { expiration: { type: 'EX' as const, value: opts.ttlSeconds } } : {}),
        ...(opts.nx ? { condition: 'NX' as const } : {}),
      });
      return reply === 'OK';
    },
    async incr(key, ttlSeconds, by = 1) {
      const [count] = await client.multi().incrBy(key, by).expire(key, ttlSeconds, 'NX').exec();
      return Number(count);
    },
    async hIncr(key, field, ttlSeconds) {
      const [count] = await client.multi().hIncrBy(key, field, 1).expire(key, ttlSeconds, 'NX').exec();
      return Number(count);
    },
    async pfAdd(key, member, ttlSeconds) {
      await client.multi().pfAdd(key, member).expire(key, ttlSeconds, 'NX').exec();
    },
    pfCount: (key) => client.pfCount(key),
    decr: (key) => client.decr(key),
    hGetAll: async (key) => ({ ...(await client.hGetAll(key)) }),
    sMembers: (key) => client.sMembers(key),
    async scan(pattern) {
      plainGlob(pattern);
      const out: string[] = [];
      for await (const keys of client.scanIterator({ MATCH: pattern, COUNT: 500 })) out.push(...(Array.isArray(keys) ? keys : [keys]));
      return [...new Set(out)];
    },
    lPop: (key) => client.lPop(key),
    lLen: (key) => client.lLen(key),
    async script(def, keys, args) {
      return String(await client.eval(def.lua, { keys, arguments: args }));
    },
    async persistence() {
      const info = await client.info('persistence');
      const field = (name: string) => new RegExp(`^${name}:(\\S+)`, 'm').exec(info)?.[1] ?? null;
      const num = (name: string) => {
        const v = field(name);
        return v === null ? null : Number(v);
      };
      return {
        rdbLastSave: num('rdb_last_save_time'),
        rdbStatus: field('rdb_last_bgsave_status'),
        aofRewrites: num('aof_rewrites'),
        aofInProgress: num('aof_rewrite_in_progress'),
        aofFailures: num('aof_rewrites_consecutive_failures'),
        aofRewriteStatus: field('aof_last_bgrewrite_status'),
      };
    },
    async memory() {
      return parseMemoryInfo(await client.info('memory'));
    },
    async write(ops) {
      if (ops.length === 0) return;
      const multi = client.multi();
      for (const op of ops) {
        switch (op.op) {
          case 'set':
            multi.set(op.key, op.value, op.ttlSeconds ? { expiration: { type: 'EX', value: op.ttlSeconds } } : {});
            break;
          case 'del':
            multi.del(op.key);
            break;
          case 'hSet':
            if (Object.keys(op.fields).length) multi.hSet(op.key, op.fields);
            break;
          case 'hDel':
            if (op.fields.length) multi.hDel(op.key, op.fields);
            break;
          case 'sAdd':
            if (op.members.length) multi.sAdd(op.key, op.members);
            break;
          case 'sRem':
            if (op.members.length) multi.sRem(op.key, op.members);
            break;
          case 'rPush':
            if (op.values.length) multi.rPush(op.key, op.values);
            break;
          case 'expire':
            multi.expire(op.key, op.ttlSeconds);
            break;
          case 'decr':
            multi.decr(op.key);
            break;
          case 'persist':
            multi.persist(op.key);
            break;
        }
      }
      await multi.exec();
    },
    close: () => client.close(),
  };
}

/** A HyperLogLog in MemoryKv: kept exactly, as a set, but not readable as one. */
class Hll extends Set<string> {}

const MANY = Number.POSITIVE_INFINITY;
/** The arities MemoryKv accepts ([least, most] arguments, the command included): Valkey's, or narrower where device
 * scripts use one form only (ZRANGE without options), so a script outside that subset fails here loudly. */
const ARITY: Record<string, [number, number]> = {
  GET: [2, 2], SET: [3, 5], DEL: [2, MANY], UNLINK: [2, MANY], EXISTS: [2, MANY], TYPE: [2, 2], PTTL: [2, 2], TTL: [2, 2],
  EXPIRE: [3, 3], PEXPIRE: [3, 3], PERSIST: [2, 2], INCR: [2, 2], DECR: [2, 2], INCRBY: [3, 3], DECRBY: [3, 3],
  HGET: [3, 3], HEXISTS: [3, 3], HMGET: [3, MANY], HSET: [4, MANY], HDEL: [3, MANY], HKEYS: [2, 2], HLEN: [2, 2],
  HGETALL: [2, 2], HINCRBY: [4, 4], SADD: [3, MANY], SREM: [3, MANY], SMEMBERS: [2, 2], SCARD: [2, 2], SISMEMBER: [3, 3],
  ZADD: [4, MANY], ZREM: [3, MANY], ZSCORE: [3, 3], ZCARD: [2, 2], ZRANGE: [4, 4], ZRANGEBYSCORE: [4, 7], ZCOUNT: [4, 4],
  RPUSH: [3, MANY], LPOP: [2, 3], LLEN: [2, 2], LINDEX: [3, 3], LREM: [4, 4], LRANGE: [4, 4], FLUSHDB: [1, 2],
};
/** A float as Valkey's parser reads it (strtod's decimal grammar, or inf/infinity with a sign); null when it is not one. */
function parseFloatValkey(s: string): number | null {
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  // Out of range, as strtod reports it: overflow to infinity, or a non-zero value that underflows to zero.
  if (!Number.isFinite(n) || (n === 0 && /[1-9]/.test(s.replace(/[eE].*$/, '')))) return null;
  return n;
}

/** The flags of a script's shebang: "#!lua" then only flags= options (every one combined), else the script is refused. */
function shebangFlags(lua: string): string[] {
  if (!lua.startsWith('#!')) return [];
  const line = lua.slice(0, lua.indexOf('\n') < 0 ? undefined : lua.indexOf('\n'));
  const [engine, ...options] = line.split(/[ \t]+/).filter(Boolean);
  if (engine !== '#!lua') throw new Error(`ERR Unexpected engine in script shebang: ${engine}`);
  const flags: string[] = [];
  for (const o of options) {
    if (!o.startsWith('flags=')) throw new Error(`ERR Unknown lua shebang option: ${o}`);
    const list = o.slice('flags='.length);
    for (const f of list === '' ? [] : list.split(',')) {
      if (!['allow-oom', 'no-writes', 'allow-stale', 'no-cluster', 'allow-cross-slot-keys'].includes(f)) throw new Error(`ERR Unexpected flag in script shebang: ${f}`);
      flags.push(f);
    }
  }
  return flags;
}

/** Commands a `no-writes` script may not run. */
const WRITES = new Set(['SET', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'INCR', 'DECR', 'INCRBY', 'DECRBY', 'HSET', 'HDEL',
  'HINCRBY', 'SADD', 'SREM', 'ZADD', 'ZREM', 'RPUSH', 'LPOP', 'LREM', 'FLUSHDB']);

/** A sorted set in MemoryKv: member → score, read in Valkey's order (score, then member). */
class ZSet {
  readonly scores = new Map<string, number>();
  get size() {
    return this.scores.size;
  }
  ordered(): [string, number][] {
    // Equal scores by the members' bytes (UTF-8), as Valkey compares them.
    return [...this.scores].sort((a, b) => a[1] - b[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  }
}

type Entry = { value: string | Map<string, string> | Set<string> | string[] | ZSet; expiresAt: number | null };

/** In-memory twin of the Redis subset above, for tests and local runs. */
/** used_memory and maxmemory from INFO memory: both must be there, whole numbers, or the reading is refused (never 0). */
export function parseMemoryInfo(info: string): { used: number; max: number } {
  const read = (name: string) => {
    const m = new RegExp(`^${name}:(\\d+)\\r?$`, 'm').exec(info);
    if (!m) throw new Error(`INFO memory has no readable ${name}`);
    return Number(m[1]);
  };
  return { used: read('used_memory'), max: read('maxmemory') };
}

/** Patterns use only * and ?: brackets and escapes, which MemoryKv does not read as Valkey does, are refused on both. */
function plainGlob(pattern: string) {
  if (/[[\]\\]/.test(pattern)) throw new Error(`scan patterns use only * and ?: ${pattern}`);
}

export class MemoryKv implements Kv {
  private readonly data = new Map<string, Entry>();
  /** Not readonly: a script holds it still while it runs. */
  private now: () => number;
  /** Set by tests and the local stack: how scripts without a memory twin run. */
  static lua: LuaRunner | null = null;
  /** Emulates Valkey over `maxmemory`: scripts not flagged `allow-oom` are refused before they start. */
  oom = false;
  /** What `memory()` reports. */
  memoryUse = { used: 0, max: 64 * 1024 * 1024 };

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private entry(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (entry?.expiresAt !== null && entry !== undefined && entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private typed<T extends Entry['value']>(key: string, make: () => T, is: (v: Entry['value']) => boolean): T {
    const entry = this.entry(key);
    if (!entry) {
      const value = make();
      this.data.set(key, { value, expiresAt: null });
      return value;
    }
    if (!is(entry.value)) throw new Error(`WRONGTYPE ${key}`);
    return entry.value as T;
  }

  private string(key: string): string | null {
    const entry = this.entry(key);
    if (!entry) return null;
    if (typeof entry.value !== 'string') throw new Error(`WRONGTYPE ${key}`);
    return entry.value;
  }

  private tidy(key: string) {
    const value = this.data.get(key)?.value;
    if (value !== undefined && typeof value !== 'string' && ('size' in value ? value.size : value.length) === 0) {
      this.data.delete(key);
    }
  }

  async get(key: string) {
    return this.string(key);
  }

  async set(key: string, value: string, opts: { ttlSeconds?: number; nx?: boolean } = {}) {
    if (opts.nx && this.entry(key)) return false;
    this.data.set(key, { value, expiresAt: opts.ttlSeconds ? this.now() + opts.ttlSeconds * 1000 : null });
    return true;
  }

  async incr(key: string, ttlSeconds: number, by = 1) {
    const current = this.string(key);
    const next = (current === null ? 0 : Number(current)) + by;
    const expiresAt = this.entry(key)?.expiresAt ?? this.now() + ttlSeconds * 1000;
    this.data.set(key, { value: String(next), expiresAt });
    return next;
  }

  async decr(key: string) {
    const entry = this.entry(key);
    const next = Number(this.string(key) ?? 0) - 1;
    this.data.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  /** A new key expires after `ttlSeconds`, as EXPIRE NX does right after creating it in Redis. */
  private created<T extends Entry['value']>(key: string, ttlSeconds: number, make: () => T, is: (v: Entry['value']) => boolean): T {
    const isNew = !this.entry(key);
    const value = this.typed(key, make, is);
    if (isNew) this.data.get(key)!.expiresAt = this.now() + ttlSeconds * 1000;
    return value;
  }

  async hIncr(key: string, field: string, ttlSeconds: number) {
    const map = this.created(key, ttlSeconds, () => new Map<string, string>(), (v) => v instanceof Map);
    const next = Number(map.get(field) ?? 0) + 1;
    map.set(field, String(next));
    return next;
  }

  async pfAdd(key: string, member: string, ttlSeconds: number) {
    this.created(key, ttlSeconds, () => new Hll(), (v) => v instanceof Hll).add(member);
  }

  async pfCount(key: string) {
    const entry = this.entry(key);
    if (!entry) return 0;
    if (!(entry.value instanceof Hll)) throw new Error(`WRONGTYPE ${key}`);
    return entry.value.size;
  }

  async hGetAll(key: string) {
    const entry = this.entry(key);
    if (!entry) return {};
    if (!(entry.value instanceof Map)) throw new Error(`WRONGTYPE ${key}`);
    return Object.fromEntries(entry.value);
  }

  async scan(pattern: string) {
    plainGlob(pattern);
    // As Valkey matches: over the UTF-8 bytes (each one char in latin1), with * spanning anything, newlines too.
    const bytes = (t: string) => Buffer.from(t, 'utf8').toString('latin1');
    const re = new RegExp(`^${bytes(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]')}$`);
    return this.keys().filter((k) => re.test(bytes(k)));
  }

  async sMembers(key: string) {
    const entry = this.entry(key);
    if (!entry) return [];
    if (!(entry.value instanceof Set) || entry.value instanceof Hll) throw new Error(`WRONGTYPE ${key}`);
    return [...entry.value];
  }

  async lPop(key: string) {
    const entry = this.entry(key);
    if (!entry) return null;
    if (!Array.isArray(entry.value)) throw new Error(`WRONGTYPE ${key}`);
    const value = entry.value.shift() ?? null;
    this.tidy(key);
    return value;
  }

  async lLen(key: string) {
    const entry = this.entry(key);
    return entry && Array.isArray(entry.value) ? entry.value.length : 0;
  }

  async write(ops: WriteOp[]) {
    for (const op of ops) {
      switch (op.op) {
        case 'set':
          await this.set(op.key, op.value, op.ttlSeconds ? { ttlSeconds: op.ttlSeconds } : {});
          break;
        case 'del':
          this.data.delete(op.key);
          break;
        case 'hSet': {
          if (Object.keys(op.fields).length === 0) break;
          const map = this.typed(op.key, () => new Map<string, string>(), (v) => v instanceof Map);
          for (const [k, v] of Object.entries(op.fields)) map.set(k, v);
          break;
        }
        case 'hDel': {
          const entry = this.entry(op.key);
          if (entry?.value instanceof Map) for (const f of op.fields) entry.value.delete(f);
          this.tidy(op.key);
          break;
        }
        case 'sAdd': {
          const set = this.typed(op.key, () => new Set<string>(), (v) => v instanceof Set && !(v instanceof Hll));
          for (const m of op.members) set.add(m);
          this.tidy(op.key);
          break;
        }
        case 'sRem': {
          const entry = this.entry(op.key);
          if (entry?.value instanceof Set) for (const m of op.members) entry.value.delete(m);
          this.tidy(op.key);
          break;
        }
        case 'rPush': {
          const list = this.typed(op.key, () => [] as string[], Array.isArray);
          list.push(...op.values);
          this.tidy(op.key);
          break;
        }
        case 'expire': {
          const entry = this.entry(op.key);
          if (entry) entry.expiresAt = this.now() + op.ttlSeconds * 1000;
          break;
        }
        case 'decr':
          await this.decr(op.key);
          break;
        case 'persist': {
          const entry = this.entry(op.key);
          if (entry) entry.expiresAt = null;
          break;
        }
      }
    }
  }

  async script(def: ScriptDef, keys: string[], args: string[]): Promise<string> {
    if (def.memory) return this.frozen(() => def.memory!(this.tx(), keys, args));
    const flags = shebangFlags(def.lua);
    if (this.oom && !flags.includes('allow-oom') && !flags.includes('no-writes')) {
      throw new Error("OOM command not allowed when used memory > 'maxmemory'.");
    }
    if (!MemoryKv.lua) throw new Error(`script ${def.name}: MemoryKv has no Lua engine (tests and the local stack install one)`);
    const noWrites = flags.includes('no-writes');
    const run = await MemoryKv.lua(def.lua, keys, args, (argv) => this.command(argv, { noWrites }));
    return this.frozen(run);
  }

  /** Time stands still while a script runs, as on Valkey: nothing expires halfway through it. */
  private frozen<T>(fn: () => T): T {
    const clock = this.now;
    const at = clock();
    this.now = () => at;
    try {
      return fn();
    } finally {
      this.now = clock;
    }
  }

  /** The Valkey commands device scripts use, with Valkey's replies and errors. */
  command(argv: string[], opts: { noWrites?: boolean } = {}): Reply {
    const [name = '', key = '', ...rest] = argv;
    const cmd = name.toUpperCase();
    // Arity first, as Valkey checks it before running anything: [least, most] arguments, the command included.
    const arity = ARITY[cmd];
    if (arity && (argv.length < arity[0] || argv.length > arity[1])) throw new Error('ERR Wrong number of args calling command from script');
    if (opts.noWrites && WRITES.has(cmd)) throw new Error('ERR Write commands are not allowed from read-only scripts.');
    const wrong = () => new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    // Valkey's integers are signed 64-bit; past 2^53 JavaScript would round, so those are refused here too
    // (no device counter comes near either bound).
    // Canonical decimal only, as Valkey's string2ll: no sign but "-", no leading zeros, no "-0".
    const int = (s: string | undefined) => {
      if (s === undefined || !/^-?(0|[1-9]\d*)$/.test(s) || s === '-0' || !Number.isSafeInteger(Number(s))) throw new Error('ERR value is not an integer or out of range');
      return Number(s);
    };
    const checked = (n: number) => {
      if (!Number.isSafeInteger(n)) throw new Error('ERR increment or decrement would overflow');
      return n;
    };
    const hash = (create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof Map)) throw wrong();
      if (!e && create) return this.typed(key, () => new Map<string, string>(), (v) => v instanceof Map);
      return (e?.value as Map<string, string> | undefined) ?? null;
    };
    const set = (create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof Set && !(e.value instanceof Hll))) throw wrong();
      if (!e && create) return this.typed(key, () => new Set<string>(), (v) => v instanceof Set && !(v instanceof Hll));
      return (e?.value as Set<string> | undefined) ?? null;
    };
    const zset = (create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof ZSet)) throw wrong();
      if (!e && create) return this.typed(key, () => new ZSet(), (v) => v instanceof ZSet);
      return (e?.value as ZSet | undefined) ?? null;
    };
    const list = (create: boolean) => {
      const e = this.entry(key);
      if (e && !Array.isArray(e.value)) throw wrong();
      if (!e && create) return this.typed(key, () => [] as string[], Array.isArray);
      return (e?.value as string[] | undefined) ?? null;
    };
    // A score-range bound: "(" for an open end; an empty bound reads as 0, as on Valkey (verified in kv-lua.test.ts).
    const bound = (s: string, low: boolean) => {
      const open = s.startsWith('(');
      const text = open ? s.slice(1) : s;
      const v = text === '' ? 0 : parseFloatValkey(text);
      if (v === null) throw new Error(`ERR min or max is not a float (${low ? 'min' : 'max'})`);
      return { v, open };
    };
    // A score as Valkey reads it: a float, or "inf" with an optional sign; an empty or otherwise bad string is refused.
    const score = (v: string) => {
      const n = parseFloatValkey(v);
      if (n === null) throw new Error('ERR value is not a valid float');
      return n;
    };
    // The indexes a start and stop pick out of n entries, as ZRANGE and LRANGE count them (negatives from the end).
    const span = (n: number, start: number, stop: number): number[] => {
      const a = start < 0 ? Math.max(n + start, 0) : start;
      const b = stop < 0 ? n + stop : Math.min(stop, n - 1);
      if (a > b || a >= n) return [];
      const out: number[] = [];
      for (let i = a; i <= b; i++) out.push(i);
      return out;
    };
    const after = <T>(value: T) => {
      this.tidy(key);
      return value;
    };
    switch (cmd) {
      case 'GET':
        return this.string(key);
      case 'SET': {
        // SET key value [EX seconds | PX ms]: the queueing write sets announcement marks with an expiry.
        const opt = rest[1]?.toUpperCase();
        if (opt !== undefined && rest.length !== 3) throw new Error('ERR syntax error');
        const ms = opt === 'EX' ? int(rest[2]) * 1000 : opt === 'PX' ? int(rest[2]) : null;
        if (opt !== undefined && ms === null) throw new Error('ERR syntax error');
        if (ms !== null && ms <= 0) throw new Error("ERR invalid expire time in 'set' command");
        this.data.set(key, { value: rest[0] ?? '', expiresAt: ms === null ? null : this.now() + ms });
        return { ok: 'OK' };
      }
      case 'DEL':
      case 'UNLINK': {
        let n = 0;
        for (const k of [key, ...rest]) if (this.entry(k) && this.data.delete(k)) n += 1;
        return n;
      }
      case 'EXISTS':
        return [key, ...rest].filter((k) => this.entry(k)).length;
      case 'TYPE':
        return { ok: this.tx().type(key) === 'other' ? 'none' : this.tx().type(key) };
      case 'PTTL':
        return this.tx().pttl(key);
      case 'TTL':
        return this.tx().ttl(key);
      case 'EXPIRE':
      case 'PEXPIRE': {
        const by = int(rest[0]) * (cmd === 'EXPIRE' ? 1000 : 1);
        const e = this.entry(key);
        if (!e) return 0;
        e.expiresAt = this.now() + by;
        return 1;
      }
      case 'PERSIST': {
        const e = this.entry(key);
        if (!e || e.expiresAt === null) return 0;
        e.expiresAt = null;
        return 1;
      }
      case 'INCR':
      case 'INCRBY':
      case 'DECR':
      case 'DECRBY': {
        const by = cmd === 'INCR' ? 1 : cmd === 'DECR' ? -1 : cmd === 'INCRBY' ? int(rest[0]) : -int(rest[0]);
        const current = this.string(key);
        const next = checked((current === null ? 0 : int(current)) + by);
        const expiresAt = this.entry(key)?.expiresAt ?? null;
        this.data.set(key, { value: String(next), expiresAt });
        return next;
      }
      case 'HGET':
        return hash(false)?.get(rest[0] ?? '') ?? null;
      case 'HEXISTS':
        return hash(false)?.has(rest[0] ?? '') ? 1 : 0;
      case 'HMGET': {
        const h = hash(false);
        return rest.map((f) => h?.get(f) ?? null);
      }
      case 'HSET': {
        if (rest.length === 0 || rest.length % 2) throw new Error("ERR wrong number of arguments for 'hset' command");
        const h = hash(true)!;
        let added = 0;
        for (let i = 0; i < rest.length; i += 2) {
          if (!h.has(rest[i]!)) added += 1;
          h.set(rest[i]!, rest[i + 1]!);
        }
        return added;
      }
      case 'HDEL': {
        const h = hash(false);
        let n = 0;
        for (const f of rest) if (h?.delete(f)) n += 1;
        return after(n);
      }
      case 'HKEYS':
        return [...(hash(false)?.keys() ?? [])];
      case 'HLEN':
        return hash(false)?.size ?? 0;
      case 'HGETALL':
        return [...(hash(false) ?? [])].flat();
      case 'HINCRBY': {
        // Everything is read and checked before the hash is created or changed.
        const by = int(rest[1]);
        const next = checked(int(hash(false)?.get(rest[0] ?? '') ?? '0') + by);
        hash(true)!.set(rest[0] ?? '', String(next));
        return next;
      }
      case 'SADD': {
        const s = set(true)!;
        let n = 0;
        for (const m of rest) if (!s.has(m)) (s.add(m), (n += 1));
        return n;
      }
      case 'SREM': {
        const s = set(false);
        let n = 0;
        for (const m of rest) if (s?.delete(m)) n += 1;
        return after(n);
      }
      case 'SMEMBERS':
        return [...(set(false) ?? [])];
      case 'SCARD':
        return set(false)?.size ?? 0;
      case 'SISMEMBER':
        return set(false)?.has(rest[0] ?? '') ? 1 : 0;
      case 'ZADD': {
        if (rest.length === 0 || rest.length % 2) throw new Error('ERR syntax error');
        // Every score is checked before anything is added, as Valkey does.
        const pairs: [number, string][] = [];
        for (let i = 0; i < rest.length; i += 2) pairs.push([score(rest[i]!), rest[i + 1]!]);
        const z = zset(true)!;
        let added = 0;
        for (const [sc, m] of pairs) {
          if (!z.scores.has(m)) added += 1;
          z.scores.set(m, sc);
        }
        return added;
      }
      case 'ZREM': {
        const z = zset(false);
        let n = 0;
        for (const m of rest) if (z?.scores.delete(m)) n += 1;
        return after(n);
      }
      case 'ZSCORE': {
        const v = zset(false)?.scores.get(rest[0] ?? '');
        return v === undefined ? null : String(v);
      }
      case 'ZCARD':
        return zset(false)?.size ?? 0;
      case 'ZCOUNT': {
        const min = bound(rest[0] ?? '', true);
        const max = bound(rest[1] ?? '', false);
        return (zset(false)?.ordered() ?? []).filter(([, s]) => (min.open ? s > min.v : s >= min.v) && (max.open ? s < max.v : s <= max.v)).length;
      }
      case 'ZRANGE': {
        const all = zset(false)?.ordered() ?? [];
        return span(all.length, int(rest[0]), int(rest[1])).map((i) => all[i]![0]);
      }
      case 'ZRANGEBYSCORE': {
        // The subset device scripts use: min max [LIMIT offset count] (no WITHSCORES), every option checked first.
        const opts = rest.slice(2);
        if (opts.length !== 0 && !(opts.length === 3 && opts[0]!.toUpperCase() === 'LIMIT')) throw new Error('ERR syntax error');
        const offset = opts.length ? int(opts[1]) : 0;
        const count = opts.length ? int(opts[2]) : -1;
        const min = bound(rest[0] ?? '', true);
        const max = bound(rest[1] ?? '', false);
        const z = zset(false); // the key's type is checked whatever the offset
        // A negative offset finds nothing, as on Valkey; a negative count means all the rest.
        if (offset < 0) return [];
        const found = (z?.ordered() ?? []).filter(
          ([, s]) => (min.open ? s > min.v : s >= min.v) && (max.open ? s < max.v : s <= max.v),
        );
        return found.slice(offset, count < 0 ? undefined : offset + count).map(([m]) => m);
      }
      case 'RPUSH': {
        const l = list(true)!;
        l.push(...rest);
        return l.length;
      }
      case 'LPOP': {
        const l = list(false);
        if (rest[0] === undefined) return after(l?.shift() ?? null);
        // LPOP key count: an array, or nil for a missing key, as Valkey answers.
        const n = int(rest[0]);
        return l ? after(l.splice(0, n)) : null;
      }
      case 'LLEN':
        return list(false)?.length ?? 0;
      case 'LINDEX': {
        const l = list(false) ?? [];
        const i = int(rest[0]);
        return l[i < 0 ? l.length + i : i] ?? null;
      }
      case 'LREM': {
        // LREM key count value: count > 0 from the head, < 0 from the tail, 0 every occurrence.
        const count = int(rest[0]);
        const l = list(false);
        if (!l) return 0;
        const limit = count === 0 ? Infinity : Math.abs(count);
        let removed = 0;
        const order = count < 0 ? [...l.keys()].reverse() : [...l.keys()];
        const drop = new Set<number>();
        for (const i of order) {
          if (removed >= limit) break;
          if (l[i] === rest[1]) (drop.add(i), (removed += 1));
        }
        const kept = l.filter((_, i) => !drop.has(i));
        l.splice(0, l.length, ...kept);
        return after(removed);
      }
      case 'LRANGE': {
        const l = list(false) ?? [];
        return span(l.length, int(rest[0]), int(rest[1])).map((i) => l[i]!);
      }
      case 'FLUSHDB':
        if (argv.length > 1 && !['SYNC', 'ASYNC'].includes(key.toUpperCase())) throw new Error('ERR syntax error');
        this.data.clear();
        return { ok: 'OK' };
      default:
        throw new Error(`ERR unknown command '${name}' (MemoryKv runs only the commands device scripts use)`);
    }
  }

  /** The store as a twin script sees it. */
  private tx(): ScriptTx {
    const hashOf = (key: string, create: boolean) => {
      const e = this.entry(key);
      if (e && !(e.value instanceof Map)) throw new Error(`WRONGTYPE ${key}`);
      if (!e && create) return this.typed(key, () => new Map<string, string>(), (v) => v instanceof Map);
      return (e?.value as Map<string, string> | undefined) ?? null;
    };
    const tx: ScriptTx = {
      type: (key) => {
        const e = this.entry(key);
        if (!e) return 'none';
        if (typeof e.value === 'string') return 'string';
        if (e.value instanceof ZSet) return 'zset';
        if (e.value instanceof Map) return 'hash';
        if (e.value instanceof Hll) return 'string';
        if (e.value instanceof Set) return 'set';
        return Array.isArray(e.value) ? 'list' : 'other';
      },
      // A HyperLogLog is a string on Valkey, whose bytes a script reads as such.
      get: (key) => (this.entry(key)?.value instanceof Hll ? 'HYLL' : this.string(key)),
      set: (key, value) => void this.data.set(key, { value, expiresAt: null }),
      del: (key) => void this.data.delete(key),
      exists: (key) => this.entry(key) !== undefined,
      ttl: (key) => {
        const ms = tx.pttl(key);
        return ms < 0 ? ms : Math.floor((ms + 500) / 1000);
      },
      pttl: (key) => {
        const e = this.entry(key);
        if (!e) return -2;
        return e.expiresAt === null ? -1 : e.expiresAt - this.now();
      },
      expire: (key, seconds) => {
        const e = this.entry(key);
        if (e) e.expiresAt = this.now() + seconds * 1000;
      },
      hGet: (key, field) => hashOf(key, false)?.get(field) ?? null,
      hSet: (key, field, value) => void hashOf(key, true)!.set(field, value),
      hDel: (key, field) => {
        hashOf(key, false)?.delete(field);
        this.tidy(key);
      },
      hLen: (key) => hashOf(key, false)?.size ?? 0,
      hGetAll: (key) => Object.fromEntries(hashOf(key, false) ?? []),
    };
    return tx;
  }

  async close() {}

  async memory() {
    return { ...this.memoryUse };
  }

  async persistence(): ReturnType<Kv['persistence']> {
    return { rdbLastSave: null, rdbStatus: null, aofRewrites: null, aofInProgress: null, aofFailures: null, aofRewriteStatus: null };
  }

  /** Test helper: everything stored, as text. */
  dump(): string {
    return JSON.stringify(
      this.keys().map((k) => {
        const v = this.data.get(k)!.value;
        return [k, typeof v === 'string' ? v : v instanceof Map ? Object.fromEntries(v) : v instanceof ZSet ? Object.fromEntries(v.scores) : [...v]];
      }),
    );
  }

  /** Test helper: every live key. */
  keys(): string[] {
    return [...this.data.keys()].filter((k) => this.entry(k));
  }
}
