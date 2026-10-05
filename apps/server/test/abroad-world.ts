// The posts-abroad world shared by the abroad and push checker tests: a pretend
// passport.gov.ph that also lists posts abroad, and a checker around it.
import { createHash, randomBytes } from 'node:crypto';
import type { Site } from 'penge-passport-ph';
import { type CheckDeps, runCheck } from '../src/checker.ts';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { deviceCall } from '../src/push/register.ts';
import { confirm, createPending } from '../src/subscribers.ts';
import { clock, FakeMailer, FakeUpstream, fcmSubscription, keys, MemoryKv, MemorySink } from './helpers.ts';

export const post = (id: number, name: string): Site => ({
  id,
  name,
  description: null,
  address: `${name} street 1`,
  telephone: '+45 71415952',
  hours: null,
  mapUrl: null,
  utcOffsetMinutes: null,
});

/** A pretend passport.gov.ph that also lists regions, countries and posts abroad. */
export class FakeAbroad extends FakeUpstream {
  regionList = [
    { id: 1, name: 'Asia Pacific' },
    { id: 2, name: 'Europe' },
  ];
  countryList = new Map<number, { id: number; name: string }[]>([
    [1, [{ id: 1, name: 'Philippines' }, { id: 20, name: 'Japan' }]],
    [2, [{ id: 62, name: 'Denmark' }]],
  ]);
  posts = new Map<number, Site[]>([
    [20, [post(200, 'PE Tokyo'), post(201, 'PE Tokyo - Outreach in Okinawa 2026')]],
    [62, [post(497, 'PE Copenhagen')]],
  ]);

  regions() {
    return this.regionList;
  }
  async countries(regionId: number) {
    this.calls.push(`countries:${regionId}`);
    return this.countryList.get(regionId) ?? [];
  }
  override async sites(opts?: { regionId: number; countryId: number }) {
    if (!opts) return super.sites();
    this.calls.push(`sites:${opts.countryId}`);
    return this.posts.get(opts.countryId) ?? [];
  }
}

export async function abroadWorld(over: Partial<CheckDeps> = {}) {
  const t = clock();
  const kv = new MemoryKv(t.now);
  const upstream = new FakeUpstream();
  const abroad = new FakeAbroad();
  const sink = new MemorySink();
  const objects = new Map<string, Uint8Array>();
  sink.putObject = async (key, body) => void objects.set(key, body);
  const mailer = new FakeMailer();
  const deps: CheckDeps = {
    kv,
    upstream,
    abroad,
    sink,
    mailer,
    keys,
    log: silentLog,
    publicBaseUrl: 'https://penge.example',
    mailDailyLimit: 300,
    alertsPerSubscriberPerDay: 3,
    client: 'penge-passport-ph@test',
    // The fake clock, not this machine's uptime (Linux has one, macOS does not): the same on every machine.
    uptime: () => null,
    now: t.now,
    ...over,
  };
  let n = 0;
  const run = async (advance = 5 * 60_000) => {
    const report = await runCheck({ ...deps, runId: `run${++n}` });
    t.advance(advance);
    return report;
  };
  const subscribe = async (email: string, siteIds: number[], applicants = 1) => {
    const token = await createPending(kv, keys, { email, siteIds, applicants, pace: 'asap', channels: null }, t.now());
    const result = await confirm(kv, keys, token, t.now());
    if (result.status !== 'confirmed' && result.status !== 'updated') throw new Error(`confirm failed: ${result.status}`);
    return result.subscriberId;
  };
  /** Subscribes with channels; a push device is registered at once. */
  const subscribeWith = async (email: string, siteIds: number[], ch: { emailOn: boolean; pushOn: boolean }) => {
    const credential = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(credential).digest('base64url');
    const token = await createPending(kv, keys, {
      email, siteIds, applicants: 1, pace: 'asap',
      channels: { ...ch, pushCredentialHash: ch.pushOn ? hash : null, device: ch.pushOn ? 'Chrome on Android' : null },
    }, t.now());
    const r = await confirm(kv, keys, token, t.now(), ch);
    if (r.status !== 'confirmed' && r.status !== 'updated') throw new Error(`confirm: ${r.status}`);
    if (ch.pushOn) {
      const s = fcmSubscription();
      const state = await deviceCall(kv, keys, { credential, subscription: { endpoint: s.endpoint, ...s.keys }, revision: 1, now: t.now() });
      if (state !== 'registered') throw new Error(`register: ${state}`);
    }
    return r.subscriberId;
  };
  const stored = async () => {
    const all = await kv.hGetAll(K.abroadStatus);
    return new Map(Object.entries(all).map(([id, raw]) => [Number(id), JSON.parse(raw) as { status: { ok: boolean; openDates: string[]; checkedAt: string | null }; dueAt: number }]));
  };
  return { t, kv, upstream, abroad, sink, objects, mailer, deps, run, subscribe, subscribeWith, stored };
}

