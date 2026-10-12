// Notification-alert test fixtures: real subscriptions (allowlisted hosts, real P-256 keys), credentials, and a way
// to put an alert in place without going through setup.
import { randomBytes } from 'node:crypto';
import type { AlertChoices } from '@penge/contracts';
import { checkPushSubscription, endpointHmac } from '../src/push/endpoint.ts';
import { K } from '../src/keys.ts';
import type { Kv } from '../src/kv.ts';
import { ALERT_MS, credentialHash, fingerprint, pushService, sealSubscription } from '../src/devices/store.ts';
import { fcmSubscription, keys } from './helpers.ts';

export const credential = () => randomBytes(32).toString('base64url');
export const opId = () => randomBytes(16).toString('base64url');
export const choices = (o: Partial<AlertChoices> = {}): AlertChoices => ({ siteIds: [486], applicants: 1, pace: 'asap', ...o });
export const subscription = (id?: string) => checkPushSubscription(fcmSubscription(id))!;

/** An active alert, written as activation would write it. */
export async function seedAlert(kv: Kv, o: { id?: string; cred?: string; now: number; choices?: AlertChoices; inc?: string; gen?: number; rev?: number; end?: number; order?: number; sub?: ReturnType<typeof subscription> }) {
  const id = o.id ?? opId();
  const cred = o.cred ?? credential();
  const hash = credentialHash(cred);
  const sub = o.sub ?? subscription();
  const c = o.choices ?? choices();
  const ep = endpointHmac(keys.index, sub.endpoint);
  await kv.write([
    {
      op: 'hSet',
      key: K.devAlert(id),
      fields: {
        sub: sealSubscription(keys, sub), offices: c.siteIds.join(','), group: String(c.applicants), pace: c.pace,
        created: String(o.now), order: String(o.order ?? 1), cred: hash, op: opId(), inc: o.inc ?? opId(), gen: String(o.gen ?? 1),
        rev: String(o.rev ?? 1), fp: fingerprint(sub), ep, svc: pushService(sub.endpoint), end: String(o.end ?? o.now + ALERT_MS),
        renewed: String(o.now), seq: '1',
      },
    },
    { op: 'set', key: K.devCred(hash), value: id },
    { op: 'set', key: K.devEndpoint(ep), value: id },
    ...c.siteIds.map((s) => ({ op: 'sAdd' as const, key: K.devSite(s), members: [`${id}:${c.applicants}`] })),
    { op: 'hSet', key: K.devRecords, fields: { units: String(Number((await kv.hGetAll(K.devRecords)).units ?? 0) + 5), alerts: String(Number((await kv.hGetAll(K.devRecords)).alerts ?? 0) + 1) } },
  ]);
  await kv.script({ name: 'seed-end', lua: `#!lua\nredis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) return 'ok'` }, [K.devEnds], [String(o.end ?? o.now + ALERT_MS), id]);
  return { id, cred, hash, sub, ep, fp: fingerprint(sub), choices: c };
}
