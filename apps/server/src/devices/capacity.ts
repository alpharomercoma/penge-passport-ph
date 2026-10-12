// How many notification alerts this server takes, from Valkey's maxmemory. The device namespace at its limits must fit
// in a quarter of maxmemory (spec: "Headroom"). Measured on Valkey 8.1 (devices-footprint.test.ts), worst case: with
// no alerts, the limiter's every counter, five full fan-out batches and 40 days of numbers take 8.16 MB; each alert
// with its six units adds up to 31.2 KB (the largest records, every alert on its own endpoint with an operation in
// progress, offices dispersed; it grows a little with size, as Valkey's tables do). With a margin on both: 8.2 MB and
// 31.6 KB. The footprint test fills a real Valkey at the ceilings this gives for 64, 128 and 256 MB.
import type { Kv } from '../kv.ts';

export const FOOTPRINT = { fixedBytes: 8_200_000, perAlertBytes: 31_600 } as const;
/** The share of maxmemory the device namespace may take at its limits. */
export const SHARE = 0.25;
/** An unlimited Valkey (maxmemory 0) is read as this, never as unlimited. */
export const REFERENCE_MAXMEMORY = 64 * 1024 * 1024;
/** Units beyond each alert's six: other operations and end records. */
export const EXTRA_UNITS = 80;
/** Six units an alert: five for it and its end record, one for its last operation. */
export const UNITS_PER_ALERT = 6;

export interface DeviceLimits {
  alertLimit: number;
  recordLimit: number;
}

export function memoryCeiling(maxmemory: number): DeviceLimits {
  const m = maxmemory > 0 ? maxmemory : REFERENCE_MAXMEMORY;
  const alertLimit = Math.max(0, Math.floor((SHARE * m - FOOTPRINT.fixedBytes) / FOOTPRINT.perAlertBytes));
  // A quarter that cannot hold even the fixed part takes no notification records at all.
  return { alertLimit, recordLimit: alertLimit === 0 ? 0 : alertLimit * UNITS_PER_ALERT + EXTRA_UNITS };
}

/**
 * The limits a server runs with: what is set (or, unset, the ceiling), never above what memory holds. Above it, the
 * ceiling is used and `capped` says so (the API and the checker log it); a start is never refused for it.
 */
export function resolveDeviceLimits(set: { alertLimit: number | null; recordLimit: number | null }, maxmemory: number): { limits: DeviceLimits; capped: boolean } {
  const ceiling = memoryCeiling(maxmemory);
  const alerts = set.alertLimit ?? ceiling.alertLimit;
  const records = set.recordLimit ?? alerts * UNITS_PER_ALERT + EXTRA_UNITS;
  const alertLimit = Math.min(alerts, ceiling.alertLimit);
  const recordLimit = Math.min(records, ceiling.recordLimit);
  return { limits: { alertLimit, recordLimit }, capped: alertLimit < alerts || recordLimit < records };
}

/**
 * The limits now, from a live reading of maxmemory (the API reads it at every admission, activation and change; a
 * checker run when it starts): null when Valkey's memory cannot be read, and then nothing that needs them is admitted.
 */
export async function deviceLimitsNow(kv: Kv, set: { alertLimit: number | null; recordLimit: number | null }): Promise<{ limits: DeviceLimits; used: number; max: number; capped: boolean } | null> {
  const mem = await kv.memory().catch(() => null);
  if (!mem || !Number.isFinite(mem.max) || mem.max < 0 || !Number.isFinite(mem.used)) return null;
  return { ...resolveDeviceLimits(set, mem.max), used: mem.used, max: mem.max };
}

/** The smallest maxmemory notifications are supported on: below it the fixed part (rate counters at their worst) can
 * take more than a quarter (deploy/README.md, "Notifications"). */
export const SUPPORTED_MAXMEMORY = 64 * 1024 * 1024;

/** What to log about a reading: the limits capped (set above what memory holds), or a maxmemory below the supported one. */
export function limitsNotice(set: { alertLimit: number | null; recordLimit: number | null }, live: { limits: DeviceLimits; max: number; capped: boolean }): { msg: string; fields: Record<string, unknown> } | null {
  if (live.capped) return { msg: 'notification limits capped to what memory holds', fields: { maxmemory: live.max, setAlertLimit: set.alertLimit, setRecordLimit: set.recordLimit, alertLimit: live.limits.alertLimit, recordLimit: live.limits.recordLimit } };
  if (live.max > 0 && live.max < SUPPORTED_MAXMEMORY) return { msg: 'maxmemory below the 64 MB notifications are supported on', fields: { maxmemory: live.max, alertLimit: live.limits.alertLimit } };
  return null;
}
