// Subscribers live only in Redis. Once a day the checker copies them, exactly as
// stored (addresses stay encrypted), to R2; `admin.mjs restore` puts a copy back.
// A backup is useless without the EMAIL_ENC_KEY that sealed it. Push devices are
// never in a backup: a restore must not revive a device someone turned off.
import { isPace, LIMITS } from '@penge/contracts';
import { K } from './keys.ts';
import type { Kv, WriteOp } from './kv.ts';
import { removeAllDevices } from './push/devices.ts';
import { load, removeSubscriberByIndex, withAddressLock } from './subscribers.ts';

type Record_ = { id: string; fields: Record<string, string> };
export interface BackupV1 { version: 1; exportedAt: string; subscribers: Record_[] }
export interface Backup { version: 2; exportedAt: string; subscribers: Record_[] }

const ID = /^[A-Za-z0-9_-]{16,32}$/;
const V1_FIELDS = ['email', 'index', 'sites', 'applicants', 'pace', 'createdAt', 'confirmedAt'];
const FIELDS = [...V1_FIELDS, 'emailOn', 'pushOn'];

export async function exportSubscribers(kv: Kv, siteIds: number[], now: number): Promise<Backup> {
  const ids = new Set<string>(await kv.sMembers(K.allSubscribers));
  for (const siteId of siteIds) for (const id of await kv.sMembers(K.siteSubscribers(siteId))) ids.add(id);
  const subscribers: Record_[] = [];
  for (const id of [...ids].sort()) {
    const fields = await kv.hGetAll(K.subscriber(id));
    if (fields.email && fields.index && fields.sites) {
      subscribers.push({ id, fields: Object.fromEntries(FIELDS.filter((f) => typeof fields[f] === 'string').map((f) => [f, fields[f]!])) });
    }
  }
  return { version: 2, exportedAt: new Date(now).toISOString(), subscribers };
}

/** One record, checked and cleaned. Throws before anything is written. */
function validated(r: Record_, version: 1 | 2): Record_ & { sites: number[] } {
  const { id, fields } = r;
  if (!ID.test(id) || typeof fields !== 'object' || fields === null) throw new Error(`bad subscriber ${String(id)}`);
  // A flag that is there must be '0' or '1': anything else (0, false, null) is refused, never taken as absent.
  if (version === 2) {
    for (const f of ['emailOn', 'pushOn']) {
      if (f in fields && fields[f] !== '0' && fields[f] !== '1') throw new Error(`bad subscriber ${id}`);
    }
  }
  const clean = Object.fromEntries(FIELDS.filter((f) => typeof fields[f] === 'string').map((f) => [f, fields[f]!]));
  if (version === 1) {
    delete clean.emailOn;
    delete clean.pushOn;
  }
  // Absent means email on (every subscriber from before channels): say so, so a
  // restore never keeps a newer "email off" by leaving the field alone.
  clean.emailOn ??= '1';
  // Absent in backups from before paces existed; anything else must be a pace.
  if (fields.pace !== undefined && !isPace(fields.pace)) throw new Error(`bad subscriber ${id}`);
  if (clean.emailOn !== undefined && clean.emailOn !== '0' && clean.emailOn !== '1') throw new Error(`bad subscriber ${id}`);
  if (clean.pushOn !== undefined && clean.pushOn !== '0' && clean.pushOn !== '1') throw new Error(`bad subscriber ${id}`);
  const sites = (clean.sites ?? '').split(',').map(Number);
  if (!clean.email || !clean.index || !sites.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error(`bad subscriber ${id}`);
  // A group size the site offers, or the subscriber could not be loaded after the restore.
  const applicants = Number(clean.applicants);
  if (!/^\d+$/.test(clean.applicants ?? '') || applicants < 1 || applicants > LIMITS.maxApplicants) throw new Error(`bad subscriber ${id}`);
  return { id, fields: clean, sites };
}

/**
 * Put subscribers back. A record whose address now belongs to a different live
 * subscriber is skipped (listed), never displacing them. A restored subscriber's
 * devices are removed and push is off: devices are not in backups.
 */
export async function importSubscribers(kv: Kv, backup: BackupV1 | Backup): Promise<{ restored: number; skipped: string[] }> {
  if ((backup?.version !== 1 && backup?.version !== 2) || !Array.isArray(backup.subscribers)) throw new Error('not a PengePassportPH backup');
  const records = backup.subscribers.map((r) => validated(r, backup.version));
  const skipped: string[] = [];
  let restored = 0;
  for (const r of records) {
    await withAddressLock(kv, r.fields.index!, async () => {
      const current = await kv.get(K.emailIndex(r.fields.index!));
      if (current && current !== r.id && (await load(kv, current))) {
        skipped.push(r.id);
        return;
      }
      await removeAllDevices(kv, r.id, { revoke: false });
      // The offices it follows now and the backup does not name: it leaves them.
      const before = (await kv.hGetAll(K.subscriber(r.id))).sites ?? '';
      const dropped = before.split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0 && !r.sites.includes(n));
      await kv.write([
        ...dropped.map((siteId): WriteOp => ({ op: 'sRem', key: K.siteSubscribers(siteId), members: [r.id] })),
        { op: 'hSet', key: K.subscriber(r.id), fields: { ...r.fields, pushOn: '0' } },
        { op: 'set', key: K.emailIndex(r.fields.index!), value: r.id },
        { op: 'sAdd', key: K.allSubscribers, members: [r.id] },
        ...r.sites.map((siteId): WriteOp => ({ op: 'sAdd', key: K.siteSubscribers(siteId), members: [r.id] })),
      ]);
      restored++;
    });
  }
  return { restored, skipped };
}

/** A version 1 copy for the release before push, without the people who turned email off. */
export function toV1(backup: Backup): { backup: BackupV1; leftOut: number } {
  const kept = backup.subscribers.filter((r) => r.fields.emailOn !== '0');
  return {
    backup: { version: 1, exportedAt: backup.exportedAt, subscribers: kept.map(({ id, fields }) => ({ id, fields: Object.fromEntries(V1_FIELDS.filter((f) => fields[f] !== undefined).map((f) => [f, fields[f]!])) })) },
    leftOut: backup.subscribers.length - kept.length,
  };
}

/**
 * Before running the release from before push: removes every device and push
 * index, cancels pending requests that change channels (that release would
 * confirm them as email), and unsubscribes people who chose push only.
 * Idempotent. Run with the API and the checker stopped (deploy/README.md).
 */
export async function pushDowngrade(kv: Kv): Promise<{ devicesRemoved: number; pendingCancelled: number; unsubscribed: number }> {
  let devicesRemoved = 0;
  let pendingCancelled = 0;
  let unsubscribed = 0;
  for (const member of await kv.sMembers(K.pendingChannels)) {
    const [hash, index] = member.split('|') as [string, string];
    await withAddressLock(kv, index, async () => {
      const raw = await kv.get(K.pending(hash));
      const ch = raw ? (JSON.parse(raw) as { channels?: { pushCredentialHash?: string | null } }).channels : undefined;
      const reserved = await kv.get(K.reserved(index));
      if (reserved && !(await load(kv, reserved))) {
        devicesRemoved += await removeAllDevices(kv, reserved, { revoke: false });
        await kv.write([{ op: 'del', key: K.pushAddress(reserved) }]);
      }
      await kv.write([
        { op: 'del', key: K.pending(hash) },
        { op: 'sRem', key: K.pendingFor(index), members: [hash] },
        { op: 'sRem', key: K.pendingChannels, members: [member] },
        ...(ch?.pushCredentialHash ? [{ op: 'del', key: K.pushPending(ch.pushCredentialHash) } as WriteOp] : []),
        ...(reserved && !(await kv.get(K.emailIndex(index))) ? [{ op: 'del', key: K.reserved(index) } as WriteOp] : []),
      ]);
      if (raw) pendingCancelled++;
    });
  }
  for (const id of await kv.sMembers(K.allSubscribers)) {
    const sub = await load(kv, id);
    if (!sub) continue;
    await withAddressLock(kv, sub.index, async () => {
      devicesRemoved += await removeAllDevices(kv, id, { revoke: false });
      if (!sub.emailOn) {
        await removeSubscriberByIndex(kv, sub.index);
        unsubscribed++;
      } else {
        await kv.write([{ op: 'hDel', key: K.subscriber(id), fields: ['emailOn', 'pushOn'] }]);
      }
    });
  }
  return { devicesRemoved, pendingCancelled, unsubscribed };
}
