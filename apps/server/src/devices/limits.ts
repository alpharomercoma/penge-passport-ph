// The device routes' limits (spec: "Limits against abuse"). Each request passes a fixed-size ingress gate, is
// classified read-only, then charged to its class: the class's global pool and its per-key counters together, all or
// nothing, in one script, so a refused request creates nothing and per-key counters exist only for admitted requests.
import { keyedHash } from '../crypto.ts';
import { K, manilaDay } from '../keys.ts';
import type { Kv } from '../kv.ts';
import { ipBucket, type Limit } from '../limits.ts';
import { deviceScript } from './lua.ts';

const hour = (bucket: string, max: number): Limit => ({ bucket, max, windowSeconds: 3600 });

export const DEVICE_LIMITS = {
  /** 4,096 buckets by the IP's keyed hash, 3,000 requests an hour each. */
  ingress: hour('dev-in', 3000),
  unknownSetupIp: hour('dev-setup-ip', 30),
  unknownSetupAll: hour('dev-setup-all', 300),
  /** Counted by the admission script, only when a new setup is stored. */
  storedSetupIp: hour('dev-stored-ip', 10),
  storedSetupAll: hour('dev-stored-all', 100),
  /** Counted at dispatch, for setups by credentials that do not own the endpoint's alert. */
  setupPushEndpoint: hour('dev-push-ep', 3),
  /** Setups with a captured alert and rotations, by the alert's own credential: counted at dispatch, per alert. */
  maintenanceAlert: hour('dev-maint', 6),
  maintenanceAll: hour('dev-maint-all', 600),
  ackIp: hour('dev-ack-ip', 60),
  ackAll: hour('dev-ack-all', 7000),
  knownReadCred: hour('dev-read', 600),
  knownReadIp: hour('dev-read-ip', 2400),
  knownReadAll: hour('dev-read-all', 50_000),
  pendingReadCred: hour('dev-pend', 240),
  pendingReadIp: hour('dev-pend-ip', 1200),
  pendingReadAll: hour('dev-pend-all', 15_000),
  changeCred: hour('dev-change', 60),
  changeAll: hour('dev-change-all', 6000),
  offIp: hour('dev-off-ip', 600),
  offAll: hour('dev-off-all', 6000),
  unknownIp: hour('dev-unk-ip', 600),
  unknownAll: hour('dev-unk-all', 6000),
  testAlert: hour('dev-test', 3),
  testIp: hour('dev-test-ip', 20),
  testAll: hour('dev-test-all', 200),
} satisfies Record<string, Limit>;

/** Which of the 4,096 ingress buckets an address falls in (by its /64 for IPv6). */
export function ingressBucket(ip: string, key: Buffer): number {
  return Buffer.from(keyedHash(key, 'ingress', ipBucket(ip)), 'base64url').readUInt16BE(0) % 4096;
}

/** The sliding window's keys and weight, as limits.ts's hit() computes them. */
export function rateKeys(limit: Limit, id: string, now: number) {
  const size = limit.windowSeconds * 1000;
  const window = Math.floor(now / size);
  return {
    cur: K.rate(`${limit.bucket}:${window}`, id),
    prev: K.rate(`${limit.bucket}:${window - 1}`, id),
    overlap: 1 - (now % size) / size,
    max: limit.max,
    /** Milliseconds until the end of the next window: this window's counter is read as "previous" until then. */
    ttl: (window + 2) * size - now,
  };
}

const chargeScript = deviceScript(
  'dev-charge',
  `
local items = A.items
for i = 1, #items do need(items[i].cur, 'string') need(items[i].prev, 'string') end
for i = 1, #items do
  local it = items[i]
  if not rate_room(it.cur, it.prev, it.overlap, it.max) then
    -- Counted in the day's statistics (an existing hash's field), by the pool that refused: requests, not operations.
    count('requests_refused_' .. it.bucket)
    return cjson.encode({ ok = false, refused = it.bucket })
  end
end
for i = 1, #items do rate_take(items[i].cur, items[i].ttl) end
return cjson.encode({ ok = true })
`,
);

/** Charge every limit (global pools first, by convention), or none: a refused request creates no key. */
export async function charge(kv: Kv, items: [Limit, string][], now: number): Promise<{ ok: true } | { ok: false; refused: string }> {
  const list = items.map(([limit, id]) => ({ ...rateKeys(limit, id, now), bucket: limit.bucket }));
  return chargeScript.run(kv, { stats: K.statsV2(manilaDay(now)) }, { now, items: list });
}
