// Time between two moments, measured so the wall clock cannot fake it. The
// checker's paces (one email an hour, one per check), the 3-hour life of a
// waiting date and the 3-hour announcement window are measured on the kernel's
// uptime clock: an NTP step, a VM restored from a snapshot or a date set by hand
// can neither shorten nor stretch them. Every process on the machine reads the
// same uptime, and the boot id says whether two readings share a boot. Across a
// reboot, or a move of the data to another machine and back, nothing tells how
// long it has been (the wall clock may come back ahead or behind, and boots on
// two machines cannot be put in order), so a moment from another boot is
// unknown and whatever it was timing starts again. The checker restarts every
// person's gap on the first run of a boot (checker.ts), so after a reboot the
// hour counts from then. A reboot or a move can delay an email, never bring it
// forward.
import { readFileSync } from 'node:fs';

export interface Stamp {
  /** Wall clock, ms since the epoch. */
  wall: number;
  /** Uptime in ms, and the boot it counts from; absent where the system does not say. */
  up?: number;
  boot?: string;
}

export type Uptime = () => { up: number; boot: string } | null;

let bootId: string | undefined;

/** Linux: /proc/uptime (CLOCK_BOOTTIME, which no clock setting moves) and the kernel's boot id. Elsewhere, null. */
export const systemUptime: Uptime = () => {
  try {
    bootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const up = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
    return bootId && Number.isFinite(up) ? { up, boot: bootId } : null;
  } catch {
    return null;
  }
};

export function stampAt(wall: number, uptime: Uptime = systemUptime): Stamp {
  const u = uptime();
  return u ? { wall, up: u.up, boot: u.boot } : { wall };
}

/** A stamp as stored: JSON, or a bare wall-clock number from before stamps existed. */
export function parseStamp(raw: unknown): Stamp | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { wall: raw } : null;
  if (typeof raw === 'object' && raw !== null) {
    const s = raw as Record<string, unknown>;
    if (typeof s.wall !== 'number' || !Number.isFinite(s.wall)) return null;
    const same = typeof s.up === 'number' && Number.isFinite(s.up) && typeof s.boot === 'string' && s.boot !== '';
    return same ? { wall: s.wall, up: s.up as number, boot: s.boot as string } : { wall: s.wall };
  }
  if (typeof raw !== 'string' || raw === '') return null;
  if (/^\d+$/.test(raw)) return { wall: Number(raw) };
  try {
    return parseStamp(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/**
 * How long ago `then` was, as of `now`: by uptime within a boot, and where this
 * system keeps no uptime at all (tests, a laptop), by the wall clock. Null when
 * it cannot be known: a stamp from another boot or machine, from before boots
 * were recorded, later than now in this same boot (data restored from
 * elsewhere), with uptime while this reading has none, or put in the future by
 * the wall clock. Callers then start their timing again.
 */
export function elapsed(then: Stamp, now: Stamp): number | null {
  const timed = then.boot !== undefined && then.up !== undefined;
  if (now.boot !== undefined && now.up !== undefined) {
    return timed && then.boot === now.boot && then.up! <= now.up ? now.up - then.up! : null;
  }
  if (timed) return null;
  const wall = now.wall - then.wall;
  return wall >= 0 ? wall : null;
}

