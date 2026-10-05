// @ts-nocheck
// From 157bad9 (the release before push), to test what that release would do.
// Subscribers live only in Redis. Once a day the checker copies them, exactly
// as stored (addresses stay encrypted), to R2; `admin.mjs restore` puts a copy
// back. A backup is useless without the EMAIL_ENC_KEY that sealed it.
import { isPace } from '@penge/contracts';
import { K } from '../../../src/keys.ts';
import type { Kv, WriteOp } from '../../../src/kv.ts';

export interface Backup {
  version: 1;
  exportedAt: string;
  subscribers: { id: string; fields: Record<string, string> }[];
}

const ID = /^[A-Za-z0-9_-]{16,32}$/;
const FIELDS = ['email', 'index', 'sites', 'applicants', 'pace', 'createdAt', 'confirmedAt'];

/**
 * Every subscriber: from the set of all of them, and from the site sets too,
 * so one whose only office has left the DFA's list is still kept.
 */
export async function exportSubscribers(kv: Kv, siteIds: number[], now: number): Promise<Backup> {
  const ids = new Set<string>(await kv.sMembers(K.allSubscribers));
  for (const siteId of siteIds) for (const id of await kv.sMembers(K.siteSubscribers(siteId))) ids.add(id);
  const subscribers: Backup['subscribers'] = [];
  for (const id of [...ids].sort()) {
    const fields = await kv.hGetAll(K.subscriber(id));
    if (fields.email && fields.index && fields.sites) subscribers.push({ id, fields });
  }
  return { version: 1, exportedAt: new Date(now).toISOString(), subscribers };
}

/** Put subscribers back. Existing records with the same id are overwritten; nothing is deleted. */
export async function importSubscribers(kv: Kv, backup: Backup): Promise<number> {
  if (backup?.version !== 1 || !Array.isArray(backup.subscribers)) throw new Error('not a PengePassportPH backup');
  const ops: WriteOp[] = [];
  for (const { id, fields } of backup.subscribers) {
    if (!ID.test(id) || typeof fields !== 'object' || fields === null) throw new Error(`bad subscriber ${String(id)}`);
    const clean = Object.fromEntries(FIELDS.filter((f) => typeof fields[f] === 'string').map((f) => [f, fields[f]!]));
    const sites = (clean.sites ?? '').split(',').map(Number);
    // Absent in backups from before paces existed; anything else must be a pace.
    if (fields.pace !== undefined && !isPace(fields.pace)) throw new Error(`bad subscriber ${id}`);
    if (!clean.email || !clean.index || !sites.every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new Error(`bad subscriber ${id}`);
    }
    ops.push(
      { op: 'hSet', key: K.subscriber(id), fields: clean },
      { op: 'set', key: K.emailIndex(clean.index), value: id },
      { op: 'sAdd', key: K.allSubscribers, members: [id] },
      ...sites.map((siteId): WriteOp => ({ op: 'sAdd', key: K.siteSubscribers(siteId), members: [id] })),
    );
  }
  await kv.write(ops);
  return backup.subscribers.length;
}
