// Sliding-window counters in Redis. They protect the form from being used to
// flood someone's inbox, the server from floods of requests, and
// passport.gov.ph from our on-demand lookups.
import { K } from './keys.ts';
import type { Kv } from './kv.ts';

export interface Limit {
  bucket: string;
  max: number;
  windowSeconds: number;
}

export const API_LIMITS = {
  /** Form posts from one network address. */
  subscribePerIp: { bucket: 'sub-ip', max: 10, windowSeconds: 3600 },
  /** Confirmation emails to one address. */
  confirmationsPerEmail: { bucket: 'sub-email', max: 3, windowSeconds: 24 * 3600 },
  /** Confirmation emails in total: a ceiling on what the form can make us send. */
  confirmationsPerHour: { bucket: 'sub-all', max: 100, windowSeconds: 3600 },
  /** Confirm and unsubscribe posts from one network address. */
  tokenPerIp: { bucket: 'token-ip', max: 30, windowSeconds: 3600 },
  /** Reads of the status from one network address. */
  readPerIp: { bucket: 'read-ip', max: 600, windowSeconds: 3600 },
  /** Office details (group dates, hours) from one network address. */
  lookupPerIp: { bucket: 'lookup-ip', max: 120, windowSeconds: 3600 },
  /** Push device calls (state, register, turn off) from one network address: a household's few devices, each polling. */
  devicePerIp: { bucket: 'push-ip', max: 600, windowSeconds: 3600 },
  /**
   * The same, for one device credential, from anywhere. Sized for the waiting views: the sheet
   * and the row each ask every 30 s (240 an hour together), with room for retries.
   */
  devicePerCredential: { bucket: 'push-cred', max: 300, windowSeconds: 3600 },
} satisfies Record<string, Limit>;

/**
 * Count one hit; true while it is within the limit. A sliding window: the
 * previous window's count is weighted by how much of it still overlaps, so a
 * burst either side of a window boundary cannot double the limit.
 */
export async function hit(kv: Kv, limit: Limit, id: string, now: number = Date.now()): Promise<boolean> {
  const size = limit.windowSeconds * 1000;
  const window = Math.floor(now / size);
  const key = K.rate(`${limit.bucket}:${window}`, id);
  const count = await kv.incr(key, limit.windowSeconds * 2 + 60);
  const previous = Number((await kv.get(K.rate(`${limit.bucket}:${window - 1}`, id))) ?? 0);
  const overlap = 1 - (now % size) / size;
  if (count + previous * overlap <= limit.max) return true;
  // Refused attempts are not counted, so retrying does not extend the wait.
  await kv.decr(key);
  return false;
}

/** IPv4 as is; IPv6 by its /64, which is what one customer usually gets. */
export function ipBucket(ip: string): string {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4mapped) return v4mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
