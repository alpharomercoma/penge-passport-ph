// The few Redis operations the server uses, behind an interface so tests run
// against an in-memory twin with the same semantics (including expiry).
import { createClient } from '@redis/client';

/** Writes applied together, atomically, in one MULTI. */
export type WriteOp =
  | { op: 'set'; key: string; value: string; ttlSeconds?: number }
  | { op: 'del'; key: string }
  | { op: 'hSet'; key: string; fields: Record<string, string> }
  | { op: 'sAdd'; key: string; members: string[] }
  | { op: 'sRem'; key: string; members: string[] }
  | { op: 'rPush'; key: string; values: string[] };

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns false when `nx` is set and the key already exists. */
  set(key: string, value: string, opts?: { ttlSeconds?: number; nx?: boolean }): Promise<boolean>;
  /** Increment a counter; a new counter expires after `ttlSeconds`. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Undo one increment. */
  decr(key: string): Promise<number>;
  hGetAll(key: string): Promise<Record<string, string>>;
  sMembers(key: string): Promise<string[]>;
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
  write(ops: WriteOp[]): Promise<void>;
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
    async incr(key, ttlSeconds) {
      const [count] = await client.multi().incr(key).expire(key, ttlSeconds, 'NX').exec();
      return Number(count);
    },
    decr: (key) => client.decr(key),
    hGetAll: async (key) => ({ ...(await client.hGetAll(key)) }),
    sMembers: (key) => client.sMembers(key),
    lPop: (key) => client.lPop(key),
    lLen: (key) => client.lLen(key),
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
            multi.hSet(op.key, op.fields);
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
        }
      }
      await multi.exec();
    },
    close: () => client.close(),
  };
}

type Entry = { value: string | Map<string, string> | Set<string> | string[]; expiresAt: number | null };

/** In-memory twin of the Redis subset above, for tests and local runs. */
export class MemoryKv implements Kv {
  private readonly data = new Map<string, Entry>();
  private readonly now: () => number;

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

  async incr(key: string, ttlSeconds: number) {
    const current = this.string(key);
    const next = (current === null ? 0 : Number(current)) + 1;
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

  async hGetAll(key: string) {
    const entry = this.entry(key);
    if (!entry) return {};
    if (!(entry.value instanceof Map)) throw new Error(`WRONGTYPE ${key}`);
    return Object.fromEntries(entry.value);
  }

  async sMembers(key: string) {
    const entry = this.entry(key);
    if (!entry) return [];
    if (!(entry.value instanceof Set)) throw new Error(`WRONGTYPE ${key}`);
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
          const map = this.typed(op.key, () => new Map<string, string>(), (v) => v instanceof Map);
          for (const [k, v] of Object.entries(op.fields)) map.set(k, v);
          break;
        }
        case 'sAdd': {
          const set = this.typed(op.key, () => new Set<string>(), (v) => v instanceof Set);
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
      }
    }
  }

  async close() {}

  /** Test helper: everything stored, as text. */
  dump(): string {
    return JSON.stringify(
      this.keys().map((k) => {
        const v = this.data.get(k)!.value;
        return [k, typeof v === 'string' ? v : v instanceof Map ? Object.fromEntries(v) : [...v]];
      }),
    );
  }

  /** Test helper: every live key. */
  keys(): string[] {
    return [...this.data.keys()].filter((k) => this.entry(k));
  }
}
