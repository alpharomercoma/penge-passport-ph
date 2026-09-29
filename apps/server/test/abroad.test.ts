import { gunzipSync } from 'node:zlib';
import type { Site } from 'penge-passport-ph';
import { describe, expect, it } from 'vitest';
import {
  ABROAD_DEADLINE_MS,
  ABROAD_POSTS_PER_RUN,
  ABROAD_REQUESTS_PER_RUN,
  ACTIVE_EVERY_MINUTES,
  CATALOG_MAX_AGE_MS,
  CATALOG_STEPS_PER_RUN,
  catalogPosts,
  QUIET_EVERY_MINUTES,
} from '../src/abroad.ts';
import { createApi } from '../src/api.ts';
import { type CheckDeps, runCheck } from '../src/checker.ts';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { createLookups } from '../src/lookups.ts';
import { confirm, createPending } from '../src/subscribers.ts';
import { clock, FakeMailer, FakeUpstream, keys, MemoryKv, MemorySink, SITES } from './helpers.ts';

const post = (id: number, name: string): Site => ({
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
class FakeAbroad extends FakeUpstream {
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

async function world() {
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
    now: t.now,
  };
  let n = 0;
  const run = async (advance = 5 * 60_000) => {
    const report = await runCheck({ ...deps, runId: `run${++n}` });
    t.advance(advance);
    return report;
  };
  const subscribe = async (email: string, siteIds: number[], applicants = 1) => {
    const token = await createPending(kv, keys, { email, siteIds, applicants }, t.now());
    const result = await confirm(kv, token, t.now());
    if (result.status === 'invalid') throw new Error('confirm failed');
    return result.subscriberId;
  };
  const stored = async () => {
    const all = await kv.hGetAll(K.abroadStatus);
    return new Map(Object.entries(all).map(([id, raw]) => [Number(id), JSON.parse(raw) as { status: { ok: boolean; openDates: string[]; checkedAt: string | null }; dueAt: number }]));
  };
  return { t, kv, upstream, abroad, sink, objects, mailer, deps, run, subscribe, stored };
}

describe('posts abroad', () => {
  it('reads the list of posts, leaving the Philippines to the main scan', async () => {
    const w = await world();
    const report = await w.run();
    expect(report.abroad).toMatchObject({ catalogSteps: 4, problems: [] });
    expect(w.abroad.calls.filter((c) => c.startsWith('countries') || c.startsWith('sites:'))).toEqual([
      'countries:1',
      'countries:2',
      'sites:20',
      'sites:62',
    ]);
    expect((await catalogPosts(w.kv)).map((p) => [p.id, p.country, p.region])).toEqual([
      [200, 'Japan', 'Asia Pacific'],
      [201, 'Japan', 'Asia Pacific'],
      [497, 'Denmark', 'Europe'],
    ]);
    expect(await w.kv.get(K.abroadCatalogAt)).not.toBeNull();
    // Read, then checked in the same run.
    expect(report.abroad?.checked).toBe(3);
  });

  it('reads a long list a few steps per run, and again only after a week', async () => {
    const w = await world();
    w.abroad.countryList.set(
      2,
      Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, name: `Country ${i}` })),
    );
    // 2 regions + 51 countries = 53 steps. The first reading takes a run's whole
    // allowance (and checks no posts meanwhile); the posts follow once it is done.
    const first = (await w.run()).abroad!;
    expect(first).toMatchObject({ catalogSteps: ABROAD_REQUESTS_PER_RUN, checked: 0 });
    const second = (await w.run()).abroad!;
    expect(second.catalogSteps).toBe(53 - ABROAD_REQUESTS_PER_RUN);
    // The rest of the allowance checks posts: here only Japan's two (the new countries list none).
    expect(second.checked).toBe(2);
    expect(await w.kv.get(K.abroadCatalogAt)).not.toBeNull();
    expect((await w.run()).abroad!.catalogSteps).toBe(0);

    // A week on, the list is read again a few steps per run; a country the
    // region no longer lists leaves it.
    w.abroad.countryList.set(2, [{ id: 101, name: 'Country 1' }]);
    w.t.advance(CATALOG_MAX_AGE_MS);
    const again: number[] = [];
    for (let i = 0; i < 3; i++) again.push((await w.run()).abroad!.catalogSteps);
    expect(Math.max(...again)).toBeLessThanOrEqual(CATALOG_STEPS_PER_RUN);
    const countries = new Set((await catalogPosts(w.kv)).map((p) => p.country));
    expect(countries).toEqual(new Set(['Japan']));
  });

  it('checks the most overdue posts, a few dozen per run, and each again about hourly', async () => {
    const w = await world();
    w.abroad.posts.set(62, Array.from({ length: 2 * ABROAD_POSTS_PER_RUN + 6 }, (_, i) => post(500 + i, `PE Post ${i}`)));
    const checked: number[] = [];
    for (let i = 0; i < 4; i++) checked.push((await w.run()).abroad!.checked);
    // 2 x ABROAD_POSTS_PER_RUN + 8 posts: two full runs, 8, then nothing due until the hour is up.
    expect(checked).toEqual([ABROAD_POSTS_PER_RUN, ABROAD_POSTS_PER_RUN, 8, 0]);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    expect((await w.run()).abroad!.checked).toBe(ABROAD_POSTS_PER_RUN);
  });

  it('checks every post in one run when swept by hand, due or not', async () => {
    const w = await world();
    w.abroad.posts.set(62, Array.from({ length: 2 * ABROAD_POSTS_PER_RUN + 6 }, (_, i) => post(500 + i, `PE Post ${i}`)));
    await w.run(); // reads the list and checks the first posts
    const report = await runCheck({ ...w.deps, abroadSweep: true, runId: 'sweep' });
    expect(report.abroad!.checked).toBe(2 * ABROAD_POSTS_PER_RUN + 8);
    // Afterwards the rotation carries on: nothing is due again for an hour.
    expect((await w.run()).abroad!.checked).toBe(0);
  });

  it('asks a post that publishes nothing less often, unless someone follows it', async () => {
    const w = await world();
    w.abroad.published.set(200, []);
    w.abroad.published.set(201, []);
    await w.subscribe('ana@example.com', [201]);
    await w.run();
    const s = await w.stored();
    const minutes = (id: number) => Math.round((s.get(id)!.dueAt - w.t.now() + 5 * 60_000) / 60_000);
    expect(minutes(200)).toBe(QUIET_EVERY_MINUTES);
    expect(minutes(201)).toBe(ACTIVE_EVERY_MINUTES);
    expect(minutes(497)).toBe(ACTIVE_EVERY_MINUTES);
  });

  it('keeps what a post showed when its check fails', async () => {
    const w = await world();
    w.abroad.open.set('497', ['2026-10-06']);
    await w.run();
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    w.abroad.failing.add(497);
    await w.run();
    const s = (await w.stored()).get(497)!.status;
    expect(s.ok).toBe(false);
    expect(s.openDates).toEqual(['2026-10-06']);
  });

  it('emails a follower when dates open at a post, naming it the way people know it', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [497]);
    await w.run(); // the first look is a baseline
    expect(w.mailer.sent).toHaveLength(0);
    w.abroad.open.set('497', ['2026-10-06']);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    const report = await w.run();
    expect(report.abroad).toMatchObject({ trusted: true, queued: 1 });
    expect(w.mailer.sent).toHaveLength(1);
    expect(w.mailer.sent[0]!.text).toContain('Copenhagen (Philippine Embassy, Denmark)');
    expect(w.mailer.sent[0]!.text).toContain('Tue 6 Oct');
  });

  it('checks group sizes that followers asked for, on the posts\' own limiter', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [497], 3);
    w.abroad.open.set('497', ['2026-10-06']);
    w.abroad.open.set('497:3', ['2026-10-06']);
    await w.run();
    expect(w.abroad.calls).toContain('497:3');
    expect(w.upstream.calls).not.toContain('497:3');
  });

  it('sends nothing from a run where most posts failed, and keeps their baselines', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [497]);
    await w.run();
    for (const id of [200, 201, 497]) w.abroad.failing.add(id);
    w.abroad.open.set('497', ['2026-10-06']);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    const report = await w.run();
    expect(report.abroad).toMatchObject({ trusted: false, queued: 0, failed: 3 });
    expect(w.mailer.sent).toHaveLength(0);
    // Once they answer again, the opening is news.
    w.abroad.failing.clear();
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    expect((await w.run()).abroad!.queued).toBe(1);
  });

  it('leaves posts for the next run when the run is getting long', async () => {
    const w = await world();
    // Each post takes 60% of the time a run has for them: the third waits for the next run, due still.
    const slow = w.abroad.availability.bind(w.abroad);
    w.abroad.availability = async (q) => {
      w.t.advance(ABROAD_DEADLINE_MS * 0.6);
      return slow(q);
    };
    const report = await w.run();
    expect(report.abroad!.checked).toBe(2);
    expect((await w.run()).abroad!.checked).toBeGreaterThan(0);
  });

  it('stores what each run saw at the posts in R2, beside the scans', async () => {
    const w = await world();
    await w.run();
    const [key] = [...w.objects.keys()].filter((k) => k.startsWith('scans-abroad/'));
    expect(key).toMatch(/^scans-abroad\/v1\/date=2026-09-27\/.+_run1\.json\.gz$/);
    const stored = JSON.parse(gunzipSync(w.objects.get(key!)!).toString()) as { sites: { name: string; post: { country: string } }[] };
    expect(stored.sites.map((s) => s.name)).toContain('PE Copenhagen');
    expect(stored.sites.find((s) => s.name === 'PE Copenhagen')!.post.country).toBe('Denmark');
  });
});

describe('posts abroad through the API', () => {
  async function api(upstreamDown = false) {
    const w = await world();
    await w.kv.set(K.sites, JSON.stringify(SITES.map(({ id, name }) => ({ id, name }))));
    const lookupUpstream = {
      availability: async (q: { siteId: number; applicants: number }) => {
        if (upstreamDown) throw new Error('down');
        return w.abroad.availability(q);
      },
      timeSlots: async () => [],
      warmSession: async () => false,
    };
    const lookups = createLookups({ kv: w.kv, upstream: lookupUpstream, log: silentLog, now: w.t.now });
    const app = createApi({ kv: w.kv, keys, mailer: w.mailer, log: silentLog, publicBaseUrl: 'https://penge.example', clientIp: () => '203.0.113.7', lookups, now: w.t.now });
    return { ...w, app };
  }

  it('lists every post with its latest check, and ones not checked yet', async () => {
    const w = await api();
    w.abroad.open.set('497', ['2026-10-06']);
    // Read the list, but check nothing: every post is still unchecked.
    w.abroad.availability = async () => {
      throw new Error('not yet');
    };
    await w.kv.set(K.abroadCatalogAt, new Date(w.t.now()).toISOString());
    const res = await w.app.request('/api/abroad');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ posts: [], checkedEveryMinutes: ACTIVE_EVERY_MINUTES });
  });

  it('serves the posts, their dates, and subscriptions to them', async () => {
    const w = await api();
    w.abroad.open.set('497', ['2026-10-06']);
    await w.run();
    const body = (await (await w.app.request('/api/abroad')).json()) as { posts: { id: number; country: string; openDates: string[]; ok: boolean }[] };
    expect(body.posts.map((p) => [p.id, p.country, p.ok])).toEqual([
      [200, 'Japan', true],
      [201, 'Japan', true],
      [497, 'Denmark', true],
    ]);
    expect(body.posts.find((p) => p.id === 497)!.openDates).toEqual(['2026-10-06']);

    const dates = await w.app.request('/api/offices/497/dates?applicants=2');
    expect(dates.status).toBe(200);

    const sub = await w.app.request('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', siteIds: [497, 486], applicants: 1 }),
    });
    expect(sub.status).toBe(202);
    const mail = w.mailer.sent.at(-1)!;
    expect(mail.text).toContain('Copenhagen (Philippine Embassy, Denmark)');
    expect(mail.text).toContain('Antipolo');
  });

  it('says the DFA did not answer for a post never checked, rather than showing no dates', async () => {
    const w = await api(true);
    w.abroad.availability = async () => {
      throw new Error('not yet');
    };
    await w.run();
    const res = await w.app.request('/api/offices/497/dates');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/did not answer/);
    expect((await w.app.request('/api/offices/999999/dates')).status).toBe(404);
  });
});
