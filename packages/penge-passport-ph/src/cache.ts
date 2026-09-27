import { raceAbort } from './async.js';

interface Entry<V> {
  /** Infinity while the load is in flight. */
  expiresAt: number;
  promise: Promise<V>;
  controller: AbortController;
  waiters: number;
}

/**
 * TTL cache with in-flight de-duplication: concurrent calls for the same key
 * share one upstream request. Each caller can abort its own wait; the shared
 * load is cancelled only when every waiting caller has aborted. Failed loads
 * are not cached.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(private readonly maxEntries = 500) {}

  async get(
    key: string,
    ttlMs: number,
    load: (signal: AbortSignal) => Promise<V>,
    signal?: AbortSignal,
  ): Promise<{ value: V; hit: boolean }> {
    signal?.throwIfAborted();
    let entry = this.entries.get(key);
    const hit = entry !== undefined && entry.expiresAt > Date.now();
    if (!entry || !hit) entry = this.start(key, ttlMs, load);
    if (entry.expiresAt !== Number.POSITIVE_INFINITY) return { value: await entry.promise, hit };

    entry.waiters++;
    try {
      return { value: await raceAbort(entry.promise, signal), hit };
    } finally {
      entry.waiters--;
      if (entry.waiters === 0 && entry.expiresAt === Number.POSITIVE_INFINITY) {
        entry.controller.abort(signal?.reason);
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    }
  }

  clear() {
    this.entries.clear();
  }

  private start(key: string, ttlMs: number, load: (signal: AbortSignal) => Promise<V>): Entry<V> {
    const controller = new AbortController();
    const entry: Entry<V> = {
      expiresAt: Number.POSITIVE_INFINITY,
      promise: Promise.resolve(undefined as V),
      controller,
      waiters: 0,
    };
    entry.promise = load(controller.signal).then(
      (value) => {
        entry.expiresAt = Date.now() + ttlMs;
        return value;
      },
      (err: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw err;
      },
    );
    // Every waiter may have left; the rejection is still observed by them or ignored.
    entry.promise.catch(() => undefined);

    this.entries.delete(key);
    this.entries.set(key, entry);
    // The oldest finished entries go first; a load still in flight stays, or a
    // second caller would send the same request again.
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (e.expiresAt !== Number.POSITIVE_INFINITY) this.entries.delete(k);
    }
    return entry;
  }
}
