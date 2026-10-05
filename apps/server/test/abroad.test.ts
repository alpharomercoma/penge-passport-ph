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
import { rebuild } from '../src/record.ts';
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
    // The fake clock, not this machine's uptime (Linux has one, macOS does not): the same on every machine.
    uptime: () => null,
    now: t.now,
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
    // 2 regions + 51 countries = 53 steps. The first reading takes each run's whole
    // allowance (and checks no posts meanwhile); the posts follow once it is done.
    const whole = Math.floor(53 / ABROAD_REQUESTS_PER_RUN);
    for (let i = 0; i < whole; i++) expect((await w.run()).abroad).toMatchObject({ catalogSteps: ABROAD_REQUESTS_PER_RUN, checked: 0 });
    const last = (await w.run()).abroad!;
    expect(last.catalogSteps).toBe(53 - whole * ABROAD_REQUESTS_PER_RUN);
    // What is left of that run's allowance checks posts: here Japan's two (the new
    // countries list none), as many of them as it has room for.
    expect(last.checked).toBe(Math.min(2, ABROAD_REQUESTS_PER_RUN - last.catalogSteps));
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

  it('checks the posts and sends their alerts before storing either record, so a slow R2 holds up neither', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [497]);
    await w.run();
    w.abroad.open.set('497', ['2026-10-06']);
    w.upstream.open.set('486', ['2026-10-07']);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    const store = w.sink.store.bind(w.sink);
    const atStore: { key: string; sent: number; calls: number }[] = [];
    w.sink.store = async (key, body) => {
      atStore.push({ key, sent: w.mailer.sent.length, calls: w.abroad.calls.length });
      return store(key, body);
    };
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    expect(atStore.map((s) => s.key.split('/')[0])).toEqual(['scans', 'scans-abroad']);
    for (const s of atStore) expect(s).toMatchObject({ sent: 1, calls: w.abroad.calls.length });
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

  it('still checks its dozen posts after the slowest scan at home', async () => {
    const w = await world();
    w.abroad.posts.set(62, Array.from({ length: 2 * ABROAD_POSTS_PER_RUN }, (_, i) => post(500 + i, `PE Post ${i}`)));
    await w.run(); // reads the list, checks the first posts
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000); // every post due again
    // The home scan takes 3.7 minutes, the slowest seen; each post abroad 3 seconds, the limiter's pace.
    const home = w.upstream.availability.bind(w.upstream);
    w.upstream.availability = async (q) => {
      w.t.advance((3.7 * 60_000) / SITES.length);
      return home(q);
    };
    const abroad = w.abroad.availability.bind(w.abroad);
    w.abroad.availability = async (q) => {
      w.t.advance(3_000);
      return abroad(q);
    };
    expect((await w.run()).abroad!.checked).toBe(ABROAD_POSTS_PER_RUN);
  });

  it('sends the spool after the posts abroad, with only the time left before the next run', async () => {
    const w = await world();
    const home = w.upstream.availability.bind(w.upstream);
    w.upstream.availability = async (q) => {
      w.t.advance((3.7 * 60_000) / SITES.length);
      return home(q);
    };
    const abroad = w.abroad.availability.bind(w.abroad);
    const order: string[] = [];
    w.abroad.availability = async (q) => {
      order.push('post');
      w.t.advance(3_000);
      return abroad(q);
    };
    const flush = w.sink.flush.bind(w.sink);
    w.sink.flush = async (budgetMs?: number) => {
      order.push('flush');
      return flush(budgetMs);
    };
    await w.run();
    expect(order.at(-1)).toBe('flush');
    expect(w.sink.flushBudgets[0]).toBeLessThanOrEqual(30_000);
    expect(w.sink.flushBudgets[0]).toBeLessThan(60_000);
  });

  it('records no post as removed while the list of posts is being read again', async () => {
    const w = await world();
    await w.run();
    // A weekly reading in progress, more steps planned than a run takes, with some
    // countries not read again yet (as a post moving countries would look for a while).
    const countries = Object.keys(await w.kv.hGetAll(K.abroadCountries));
    await w.kv.write([
      { op: 'rPush', key: K.abroadPlan, values: Array.from({ length: 3 * CATALOG_STEPS_PER_RUN }, () => JSON.stringify({ regionId: 99 })) },
      { op: 'hDel', key: K.abroadCountries, fields: countries.slice(1) },
    ]);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    await w.run();
    for (const { record } of w.sink.recordsOf('scans-abroad')) expect(record.removed).toEqual([]);
  });

  it('notes the run as lost when its record abroad could not be made, so the gap shows', async () => {
    const w = await world();
    const hGetAll = w.kv.hGetAll.bind(w.kv);
    w.kv.hGetAll = async (key) => {
      if (key === K.recordSites('scans-abroad')) throw new Error('redis blinked');
      return hGetAll(key);
    };
    const report = await w.run();
    expect(report.abroad!.checked).toBeGreaterThan(0);
    const lost = await w.kv.sMembers(K.recordLost('scans-abroad'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^scans-abroad\/v2\/date=2026-09-27\/.+_run1\.run$/);
  });

  it('notes no gap when the record abroad was stored and only saying so failed', async () => {
    const w = await world();
    const write = w.kv.write.bind(w.kv);
    w.kv.write = async (ops) => {
      // The write after the store, which clears the record's own key.
      if (ops.some((op) => op.op === 'sRem' && op.key === K.recordLost('scans-abroad') && op.members.some((m) => m.endsWith('.json.gz')))) throw new Error('redis blinked');
      return write(ops);
    };
    await w.run();
    w.kv.write = write;
    const [stored] = w.sink.recordsOf('scans-abroad');
    // Still said lost: the next record holds everything and names it, and it is there, so no gap.
    expect(await w.kv.sMembers(K.recordLost('scans-abroad'))).toEqual([stored!.key]);
    w.t.advance((QUIET_EVERY_MINUTES + 1) * 60_000);
    await w.run();
    const records = w.sink.recordsOf('scans-abroad');
    expect(records.at(-1)!.record).toMatchObject({ kind: 'full', lost: [stored!.key] });
    expect(rebuild(records).gaps).toEqual([]);
    expect(await w.kv.sMembers(K.recordLost('scans-abroad'))).toEqual([]);
  });

  it('notes a record abroad as lost when Redis failed before it was stored', async () => {
    const w = await world();
    const write = w.kv.write.bind(w.kv);
    w.kv.write = async (ops) => {
      if (ops.some((op) => op.key === K.recordHead('scans-abroad'))) throw new Error('redis blinked');
      return write(ops);
    };
    await w.run();
    w.kv.write = write;
    expect(w.sink.recordsOf('scans-abroad')).toEqual([]);
    const lost = await w.kv.sMembers(K.recordLost('scans-abroad'));
    expect(lost).toEqual([expect.stringMatching(/^scans-abroad\/v2\/date=.+_run1\.run$/)]);
    w.t.advance((QUIET_EVERY_MINUTES + 1) * 60_000);
    await w.run();
    const records = w.sink.recordsOf('scans-abroad');
    expect(rebuild(records).gaps).toEqual([`${records[0]!.key} says ${lost[0]} could not be stored`]);
  });

  it('says no run is missing after one with no post due', async () => {
    const w = await world();
    let report = await w.run();
    for (let i = 0; i < 6 && report.abroad!.checked > 0; i++) report = await w.run();
    expect(report.abroad!.checked).toBe(0);
    expect(await w.kv.sMembers(K.recordLost('scans-abroad'))).toEqual([]);
  });

  it('checks no group sizes abroad once the run has run out of time', async () => {
    const w = await world();
    await w.subscribe('ana@example.com', [497], 3);
    w.abroad.open.set('497', ['2026-10-06']);
    w.abroad.open.set('497:3', ['2026-10-06']);
    const abroad = w.abroad.availability.bind(w.abroad);
    w.abroad.availability = async (q) => {
      if (q.siteId === 497 && q.applicants === 1) w.t.advance(ABROAD_DEADLINE_MS);
      return abroad(q);
    };
    await w.run();
    expect(w.abroad.calls).toContain('497:1');
    expect(w.abroad.calls).not.toContain('497:3');
  });

  it('gives a sweep by hand the time to reach every post', async () => {
    const w = await world();
    w.abroad.posts.set(62, Array.from({ length: 2 * ABROAD_POSTS_PER_RUN + 6 }, (_, i) => post(500 + i, `PE Post ${i}`)));
    await w.run();
    // Longer than a scheduled run allows the posts, in all.
    const abroad = w.abroad.availability.bind(w.abroad);
    w.abroad.availability = async (q) => {
      w.t.advance(ABROAD_DEADLINE_MS / (ABROAD_POSTS_PER_RUN + 6));
      return abroad(q);
    };
    const report = await runCheck({ ...w.deps, abroadSweep: true, runId: 'sweep' });
    expect(report.abroad!.checked).toBe((await catalogPosts(w.kv)).length);
    expect(report.abroad!.checked).toBeGreaterThan(ABROAD_POSTS_PER_RUN + 6);
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
    const [first] = w.sink.recordsOf<{ id: number; fetchedAt: string | null; name: string; post: { country: string } }>('scans-abroad');
    expect(first!.key).toMatch(/^scans-abroad\/v2\/date=2026-09-27\/.+_run1\.full\.json\.gz$/);
    expect(first!.record.sites.map((s) => s.name)).toContain('PE Copenhagen');
    expect(first!.record.sites.find((s) => s.name === 'PE Copenhagen')!.post.country).toBe('Denmark');
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
    const app = createApi({ kv: w.kv, keys, mailer: w.mailer, log: silentLog, publicBaseUrl: 'https://penge.example', clientIp: () => '203.0.113.7', lookups, now: w.t.now, push: { mode: 'off', vapid: null, ownerEmails: [] } });
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

describe('fresh verification for posts abroad', () => {
  it('keeps a waiting post until its next successful lookup, even with no newly queued date', async () => {
    const w = await world();
    await w.subscribe('juan@example.com', [497]);
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.abroad.open.set('497', ['2026-10-07']);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    await w.run();
    await w.kv.write([{ op: 'del', key: K.mailPaused }]);
    const notDue = await w.run();
    expect(notDue.abroad?.checked).toBe(0);
    expect(notDue.delivery).toMatchObject({ sent: 0, held: 1 });
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    w.abroad.failing.add(497);
    expect((await w.run()).delivery).toMatchObject({ sent: 0, held: 1 });
    w.abroad.failing.clear();
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    const recovered = await w.run();
    expect(recovered.abroad?.queued).toBe(0); // announcement already queued during pause
    expect(recovered.delivery).toMatchObject({ sent: 1, held: 0 });
    expect(w.mailer.sent[0]!.text).toContain('Office calendar checked:');
    expect(w.mailer.sent[0]!.text).not.toContain('check time unavailable');
  });

  it('cannot release an unhealthy home scan through the later healthy abroad pass', async () => {
    const w = await world();
    await w.subscribe('juan@example.com', [486, 497]);
    await w.run();
    await w.kv.set(K.mailPaused, '1');
    w.upstream.open.set('486', ['2026-10-07']);
    await w.run();
    await w.kv.write([{ op: 'del', key: K.mailPaused }]);
    w.upstream.failing.add(486);
    w.upstream.failing.add(693);
    w.abroad.open.set('497', ['2026-10-08']);
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    const report = await w.run();
    expect(report.healthy).toBe(false);
    expect(report.abroad?.trusted).toBe(true);
    expect(report.delivery).toMatchObject({ sent: 1, held: 1 });
    expect(w.mailer.sent[0]!.text).toContain('Thu 8 Oct 2026');
    expect(w.mailer.sent[0]!.text).not.toContain('Wed 7 Oct 2026');
  });
});

describe('delivery stop across passes', () => {
  it('keeps the three-refusal stop in effect for the whole run', async () => {
    const w = await world();
    for (const n of [1, 2, 3, 4]) await w.subscribe(`juan${n}@example.com`, [486]);
    await w.run();
    w.t.advance(ACTIVE_EVERY_MINUTES * 60_000);
    w.upstream.open.set('486', ['2026-10-07']);
    w.mailer.failNext = 6;
    const report = await w.run();
    expect(report.abroad?.trusted).toBe(true);
    expect(report.abroad?.queued).toBe(0);
    expect(report.delivery).toMatchObject({ failed: 3, stoppedBy: 'mail errors', remaining: 1, held: 3 });
    expect(w.mailer.failNext).toBe(3);
  });
});
