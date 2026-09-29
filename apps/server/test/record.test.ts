import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { silentLog } from '../src/log.ts';
import { beginRecord, noteLost, type Observed, RecordError, rebuild, recordRun, skipRecord } from '../src/record.ts';
import { MemoryKv, MemorySink } from './helpers.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);

interface Site extends Observed {
  name: string;
  openDates: string[];
}

const site = (id: number, openDates: string[] = [], fetchedAt = '2026-10-01T02:00:00.000Z'): Site => ({ id, name: `Office ${id}`, openDates, fetchedAt });

function setup() {
  const kv = new MemoryKv(() => Date.parse('2026-10-01T02:00:00.000Z'));
  const sink = new MemorySink();
  const deps = { kv, sink, log: silentLog };
  let n = 0;
  /** One run at `at`, seeing these sites. */
  const run = (
    sites: Site[],
    at = '2026-10-01T02:00:00.000Z',
    extra: Partial<{ healthy: boolean; problems: string[]; begun: string }> = {},
    stream: 'scans' | 'scans-abroad' = 'scans',
  ) =>
    recordRun(
      deps,
      stream,
      {
        runId: `run${++n}`,
        startedAt: at,
        finishedAt: at,
        source: { host: 'passport.gov.ph', client: 'test' },
        healthy: extra.healthy ?? true,
        problems: extra.problems ?? [],
        groups: [],
        sites,
      },
      { complete: stream === 'scans' },
      extra.begun,
    );
  const records = (stream: 'scans' | 'scans-abroad' = 'scans') => sink.recordsOf<Site>(stream);
  /** The next record is stored, then its run stops: nothing more reaches Redis until resume(). */
  const stopAfterStore = () => {
    const store = sink.store.bind(sink);
    const write = kv.write.bind(kv);
    sink.store = async (key, body) => {
      const stored = await store(key, body);
      kv.write = async () => {
        throw new Error('the run stopped');
      };
      return stored;
    };
    return () => {
      sink.store = store;
      kv.write = write;
    };
  };
  return { kv, sink, run, records, stopAfterStore };
}

/** A site without the moment it was fetched, which is not a change. */
const bare = ({ fetchedAt: _, ...rest }: Site) => rest;

describe('scan records', () => {
  it('stores everything first, then nothing while nothing changes', async () => {
    const w = setup();
    expect(await w.run([site(1, ['2026-10-05']), site(2)])).toBe('uploaded');
    // Fetched again later, same dates: not a change.
    expect(await w.run([site(1, ['2026-10-05'], '2026-10-01T02:05:00.000Z'), site(2, [], '2026-10-01T02:05:00.000Z')], '2026-10-01T02:05:00.000Z')).toBe('unchanged');
    const records = w.records();
    expect(records).toHaveLength(1);
    expect(records[0]!.key).toMatch(/^scans\/v2\/date=2026-10-01\/2026-10-01T02-00-00-000Z_run1\.full\.json\.gz$/);
    expect(records[0]!.record).toMatchObject({ schema: 2, kind: 'full', after: null, removed: [] });
    expect(records[0]!.record.sites.map((s) => s.id)).toEqual([1, 2]);
  });

  it('stores only the offices that changed, after the record it follows', async () => {
    const w = setup();
    await w.run([site(1), site(2), site(3)]);
    await w.run([site(1), site(2, ['2026-10-06']), site(3)], '2026-10-01T02:05:00.000Z');
    const [full, changes] = w.records();
    expect(changes!.record).toMatchObject({ kind: 'changes', after: full!.key, removed: [] });
    expect(changes!.record.sites).toEqual([site(2, ['2026-10-06'])]);
  });

  it('lists an office gone from the list as removed', async () => {
    const w = setup();
    await w.run([site(1), site(2)]);
    await w.run([site(1)], '2026-10-01T02:05:00.000Z');
    expect(w.records()[1]!.record).toMatchObject({ kind: 'changes', sites: [], removed: [2] });
  });

  it('stores a run whose own fields changed, even with every office the same', async () => {
    const w = setup();
    await w.run([site(1)]);
    await w.run([site(1)], '2026-10-01T02:05:00.000Z', { healthy: false, problems: ['the site list did not load'] });
    expect(w.records()[1]!.record).toMatchObject({ kind: 'changes', sites: [], healthy: false, problems: ['the site list did not load'] });
  });

  it('starts each UTC day with everything, so a day stands on its own', async () => {
    const w = setup();
    await w.run([site(1), site(2)], '2026-10-01T23:55:00.000Z');
    await w.run([site(1), site(2)], '2026-10-02T00:00:00.000Z');
    const [, second] = w.records();
    expect(second!.key).toMatch(/date=2026-10-02\/.+\.full\.json\.gz$/);
    expect(second!.record).toMatchObject({ kind: 'full', after: null });
    expect(second!.record.sites.map((s) => s.id)).toEqual([1, 2]);
  });

  it('holds everything in the record after one that could be kept nowhere', async () => {
    const w = setup();
    await w.run([site(1), site(2)]);
    w.sink.outcomes.push('lost');
    expect(await w.run([site(1, ['2026-10-05']), site(2)], '2026-10-01T02:05:00.000Z')).toBe('lost');
    // Nothing new since, but the record it would follow is missing: everything again.
    expect(await w.run([site(1, ['2026-10-05']), site(2)], '2026-10-01T02:10:00.000Z')).toBe('uploaded');
    const records = w.records();
    expect(records).toHaveLength(2);
    expect(records[1]!.record).toMatchObject({ kind: 'full', after: null, sites: [site(1, ['2026-10-05'], expect.any(String)), site(2, [], expect.any(String))] });
    expect(await w.run([site(1, ['2026-10-05']), site(2)], '2026-10-01T02:15:00.000Z')).toBe('unchanged');
  });

  it('names a record that could be kept nowhere in the next one stored, even when nothing else changed', async () => {
    const w = setup();
    await w.run([site(1)]);
    w.sink.outcomes.push('lost');
    // A date opens and is gone again before the next scan: only the lost record saw it.
    expect(await w.run([site(1, ['2026-10-05'])], '2026-10-01T02:05:00.000Z')).toBe('lost');
    expect(await w.run([site(1)], '2026-10-01T02:10:00.000Z')).toBe('uploaded');
    const records = w.records();
    expect(records).toHaveLength(2);
    expect(records[1]!.record).toMatchObject({ kind: 'full', after: null, lost: ['scans/v2/date=2026-10-01/2026-10-01T02-05-00-000Z_run2.changes.json.gz'] });
    expect(records[1]!.record.sites.map(bare)).toEqual([bare(site(1))]);
    expect(rebuild(records).gaps).toEqual([`${records[1]!.key} says scans/v2/date=2026-10-01/2026-10-01T02-05-00-000Z_run2.changes.json.gz could not be stored`]);
    // A record said lost that turns up after all is no gap.
    const { lost: _, ...said } = records[1]!.record;
    const found = { key: 'scans/v2/date=2026-10-01/2026-10-01T02-05-00-000Z_run2.changes.json.gz', record: { ...said, after: records[0]!.key } };
    expect(rebuild([...records, found]).gaps).toEqual([]);
    // Said once: the record after that one names nothing.
    expect(await w.run([site(1)], '2026-10-01T02:15:00.000Z')).toBe('unchanged');
  });

  it('names a run that stopped before making its record', async () => {
    const w = setup();
    await w.run([site(1)]);
    // A date opens, the alert goes out, and the run stops before its record.
    const stopped = await beginRecord(w.kv, 'scans', 'run-stopped', '2026-10-01T02:05:00.000Z');
    const begun = await beginRecord(w.kv, 'scans', 'run3', '2026-10-01T02:10:00.000Z');
    expect(await w.run([site(1)], '2026-10-01T02:10:00.000Z', { begun })).toBe('uploaded');
    const records = w.records();
    expect(records[1]!.record).toMatchObject({ kind: 'full', lost: [stopped] });
    expect(rebuild(records).gaps).toEqual([`${records[1]!.key} says ${stopped} could not be stored`]);
    expect(await w.kv.sMembers(K.recordLost('scans'))).toEqual([]);
  });

  it('clears a run\'s own mark when it records nothing new, or has nothing to record', async () => {
    const w = setup();
    await w.run([site(1)]);
    const begun = await beginRecord(w.kv, 'scans', 'run2', '2026-10-01T02:05:00.000Z');
    expect(await w.run([site(1)], '2026-10-01T02:05:00.000Z', { begun })).toBe('unchanged');
    await skipRecord(w.kv, 'scans', await beginRecord(w.kv, 'scans', 'run3', '2026-10-01T02:10:00.000Z'));
    expect(await w.kv.sMembers(K.recordLost('scans'))).toEqual([]);
    expect(await w.run([site(1)], '2026-10-01T02:15:00.000Z')).toBe('unchanged');
  });

  it('names a run whose record failed before Redis took it', async () => {
    const w = setup();
    await w.run([site(1)]);
    const begun = await beginRecord(w.kv, 'scans', 'run2', '2026-10-01T02:05:00.000Z');
    const write = w.kv.write.bind(w.kv);
    w.kv.write = async () => {
      throw new Error('redis blinked');
    };
    const err = await w.run([site(1, ['2026-10-05'])], '2026-10-01T02:05:00.000Z', { begun }).catch((e: unknown) => e);
    w.kv.write = write;
    expect(err).toMatchObject({ stored: false });
    expect(await w.run([site(1)], '2026-10-01T02:10:00.000Z')).toBe('uploaded');
    expect(w.records().at(-1)!.record).toMatchObject({ kind: 'full', lost: [begun] });
  });

  it('abroad, lists a post gone from the catalog as removed, and leaves it out of the next day\'s first record', async () => {
    const w = setup();
    const abroadRun = (sites: Site[], at: string, known: number[]) =>
      recordRun(
        { kv: w.kv, sink: w.sink, log: silentLog },
        'scans-abroad',
        { runId: at, startedAt: at, finishedAt: at, source: { host: 'h', client: 'c' }, healthy: true, problems: [], groups: [], sites },
        { complete: false, known },
      );
    await abroadRun([site(101), site(102)], '2026-10-01T02:00:00.000Z', [101, 102]);
    // The weekly reading of the list no longer has 102.
    await abroadRun([site(101, ['2026-11-02'])], '2026-10-01T02:05:00.000Z', [101]);
    expect(w.records('scans-abroad')[1]!.record).toMatchObject({ kind: 'changes', removed: [102] });
    await abroadRun([site(101, ['2026-11-02'])], '2026-10-02T00:00:00.000Z', [101]);
    expect(w.records('scans-abroad').at(-1)!.record.sites.map((s) => s.id)).toEqual([101]);
  });

  it('names records the full spool dropped in the next record, and ignores an older layout\'s', async () => {
    const w = setup();
    await w.run([site(1)]);
    const dropped = 'scans/v2/date=2026-10-01/2026-10-01T02-01-00-000Z_old.changes.json.gz';
    await noteLost(w.kv, [dropped, 'scans/v1/date=2026-09-28/2026-09-28T02-00-00-000Z_old.json.gz', 'backups/x.json.gz']);
    expect(await w.kv.sMembers(K.recordLost('scans'))).toEqual([dropped]);
    await w.run([site(1)], '2026-10-01T02:05:00.000Z');
    expect(w.records().at(-1)!.record.lost).toEqual([dropped]);
  });

  it('writes one full record for a day that starts with an empty list, then nothing while it stays empty', async () => {
    const w = setup();
    expect(await w.run([], '2026-10-01T02:00:00.000Z', { healthy: false, problems: ['the site list is empty'] })).toBe('uploaded');
    expect(await w.run([], '2026-10-01T02:05:00.000Z', { healthy: false, problems: ['the site list is empty'] })).toBe('unchanged');
  });

  it('reports no gap for a record said lost that is known to be in R2 after all', () => {
    const base = { schema: 2 as const, runId: 'r', finishedAt: '', source: { host: 'h', client: 'c' }, healthy: true, problems: [], groups: [], removed: [], observed: [] };
    const yesterday = 'scans/v2/date=2026-09-30/2026-09-30T23-55-00-000Z_r0.changes.json.gz';
    const full = { key: 'scans/v2/date=2026-10-01/2026-10-01T00-00-00-000Z_r1.full.json.gz', record: { ...base, kind: 'full' as const, after: null, startedAt: '2026-10-01T00:00:00.000Z', sites: [site(1)], lost: [yesterday] } };
    expect(rebuild<Site>([full]).gaps).toHaveLength(1);
    expect(rebuild<Site>([full], { stored: new Set([yesterday]) }).gaps).toEqual([]);
  });

  it('says which sites a run saw itself, and which a full record carries over', async () => {
    const w = setup();
    await w.run([site(101), site(102)], '2026-10-01T23:55:00.000Z', {}, 'scans-abroad');
    await w.run([site(102)], '2026-10-02T00:00:00.000Z', {}, 'scans-abroad');
    const day2 = w.records('scans-abroad').at(-1)!.record;
    expect(day2.kind).toBe('full');
    expect(day2.sites.map((s) => s.id).sort()).toEqual([101, 102]);
    expect(day2.observed).toEqual([102]);
    const { states } = rebuild(w.records('scans-abroad'));
    expect(states.at(-1)!.observed).toEqual([102]);
  });

  it('says a record was stored when its run stopped right after, and the next holds everything and names it', async () => {
    const w = setup();
    await w.run([site(1), site(2)]);
    const resume = w.stopAfterStore();
    const err = await w.run([site(1, ['2026-10-05']), site(2)], '2026-10-01T02:05:00.000Z').catch((e: unknown) => e);
    resume();
    expect(err).toBeInstanceOf(RecordError);
    expect(err).toMatchObject({ stored: true, key: expect.stringMatching(/_run2\.changes\.json\.gz$/) });
    expect(await w.run([site(1, ['2026-10-05']), site(2, ['2026-10-06'])], '2026-10-01T02:10:00.000Z')).toBe('uploaded');
    const records = w.records();
    expect(records[2]!.record).toMatchObject({ kind: 'full', after: null, lost: [records[1]!.key] });
    // It was stored after all: no gap.
    const { states, gaps } = rebuild(records);
    expect(gaps).toEqual([]);
    expect(states.map((s) => s.sites.map(bare))).toEqual([
      [site(1), site(2)].map(bare),
      [site(1, ['2026-10-05']), site(2)].map(bare),
      [site(1, ['2026-10-05']), site(2, ['2026-10-06'])].map(bare),
    ]);
  });

  it('abroad, keeps what a record saw when its run stopped right after storing it', async () => {
    const w = setup();
    await w.run([site(101), site(102)], '2026-10-01T02:00:00.000Z', {}, 'scans-abroad');
    // A date opens at 101; the record reaches R2, and the run stops there.
    const resume = w.stopAfterStore();
    await w.run([site(101, ['2026-11-02'])], '2026-10-01T02:05:00.000Z', {}, 'scans-abroad').catch(() => undefined);
    resume();
    // The next run checks 102 only: 101 still has the date it opened.
    await w.run([site(102, ['2026-11-03'])], '2026-10-01T02:10:00.000Z', {}, 'scans-abroad');
    const { states, gaps } = rebuild(w.records('scans-abroad'));
    expect(gaps).toEqual([]);
    expect(states.at(-1)!.sites.map(bare).sort((a, b) => a.id - b.id)).toEqual([site(101, ['2026-11-02']), site(102, ['2026-11-03'])].map(bare));
  });

  it('abroad, keeps what a run saw when its record failed to store, and names the record', async () => {
    const w = setup();
    await w.run([site(101), site(102)], '2026-10-01T02:00:00.000Z', {}, 'scans-abroad');
    const store = w.sink.store.bind(w.sink);
    let failed = '';
    w.sink.store = async (key) => {
      failed = key;
      throw new Error('the disk is gone');
    };
    const err = await w.run([site(101, ['2026-11-02'])], '2026-10-01T02:05:00.000Z', {}, 'scans-abroad').catch((e: unknown) => e);
    w.sink.store = store;
    expect(err).toMatchObject({ stored: false, key: failed });
    await w.run([site(102)], '2026-10-01T02:10:00.000Z', {}, 'scans-abroad');
    const records = w.records('scans-abroad');
    const { states, gaps } = rebuild(records);
    expect(gaps).toEqual([`${records[1]!.key} says ${failed} could not be stored`]);
    expect(states.at(-1)!.sites.map(bare).sort((a, b) => a.id - b.id)).toEqual([site(101, ['2026-11-02']), site(102)].map(bare));
    expect(states.at(-1)!.observed).toEqual([102]);
  });

  it('moves on once a record is spooled', async () => {
    const w = setup();
    await w.run([site(1)]);
    w.sink.outcomes.push('spooled');
    expect(await w.run([site(1, ['2026-10-05'])], '2026-10-01T02:05:00.000Z')).toBe('spooled');
    expect(await w.run([site(1, ['2026-10-05'])], '2026-10-01T02:10:00.000Z')).toBe('unchanged');
  });

  it('abroad, keeps a post not checked this run as it was, and puts it in the day\'s first record', async () => {
    const w = setup();
    await w.run([site(101), site(102)], '2026-10-01T02:00:00.000Z', {}, 'scans-abroad');
    // Another run checks another post: the first two are unchanged, not gone.
    await w.run([site(103, ['2026-11-02'])], '2026-10-01T02:05:00.000Z', {}, 'scans-abroad');
    expect(w.records('scans-abroad')[1]!.record).toMatchObject({ kind: 'changes', removed: [], sites: [site(103, ['2026-11-02'])] });
    expect(await w.run([site(101)], '2026-10-01T02:10:00.000Z', {}, 'scans-abroad')).toBe('unchanged');
    await w.run([site(102)], '2026-10-02T00:00:00.000Z', {}, 'scans-abroad');
    const next = w.records('scans-abroad').at(-1)!.record;
    expect(next.kind).toBe('full');
    expect(next.sites.map((s) => s.id).sort()).toEqual([101, 102, 103]);
  });

  it('rebuilds exactly what each run that stored a record saw, whatever the runs', async () => {
    const date = fc.constantFrom('2026-10-05', '2026-10-06', '2026-10-07');
    const office = fc.record({ id: fc.integer({ min: 1, max: 6 }), openDates: fc.uniqueArray(date, { maxLength: 3 }) });
    const runs = fc.array(
      fc.record({
        offices: fc.uniqueArray(office, { selector: (o) => o.id, maxLength: 6 }),
        healthy: fc.boolean(),
        nextDay: fc.boolean(),
      }),
      { minLength: 1, maxLength: 12 },
    );
    await fc.assert(
      fc.asyncProperty(runs, async (script) => {
        const w = setup();
        let at = Date.parse('2026-10-01T02:00:00.000Z');
        const seenAt = new Map<string, Site[]>();
        for (const step of script) {
          at += step.nextDay ? 24 * 3600_000 : 5 * 60_000;
          const startedAt = new Date(at).toISOString();
          const sites = step.offices.map((o) => site(o.id, o.openDates, startedAt));
          const recorded = await w.run(sites, startedAt, { healthy: step.healthy });
          if (recorded !== 'unchanged') seenAt.set(startedAt, sites);
        }
        const { states, gaps } = rebuild(w.records());
        expect(gaps).toEqual([]);
        expect(states.map((s) => s.startedAt)).toEqual([...seenAt.keys()]);
        for (const state of states) {
          expect(state.complete).toBe(true);
          const saw = seenAt.get(state.startedAt)!;
          expect(state.sites.map(bare).sort((a, b) => a.id - b.id)).toEqual(saw.map(bare).sort((a, b) => a.id - b.id));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('rebuilds what the run of each stored record knew, and names every record not stored, whatever fails', async () => {
    const date = fc.constantFrom('2026-10-05', '2026-10-06', '2026-10-07');
    const office = fc.record({ id: fc.integer({ min: 1, max: 6 }), openDates: fc.uniqueArray(date, { maxLength: 3 }) });
    type Fault = 'none' | 'lost' | 'storeFails' | 'stopsAfterStore' | 'stopsBeforeRecord';
    const runs = fc.array(
      fc.record({
        offices: fc.uniqueArray(office, { selector: (o) => o.id, maxLength: 6 }),
        nextDay: fc.boolean(),
        fault: fc.constantFrom<Fault>('none', 'none', 'none', 'lost', 'storeFails', 'stopsAfterStore', 'stopsBeforeRecord'),
      }),
      { minLength: 1, maxLength: 14 },
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('scans' as const, 'scans-abroad' as const), runs, async (stream, script) => {
        const w = setup();
        const store = w.sink.store.bind(w.sink);
        const write = w.kv.write.bind(w.kv);
        let fault: Fault = 'none';
        const unstored: string[] = [];
        w.sink.store = async (key, body) => {
          if (fault === 'lost' || fault === 'storeFails') {
            unstored.push(key);
            if (fault === 'lost') return 'lost';
            throw new Error('the disk is gone');
          }
          const stored = await store(key, body);
          if (fault === 'stopsAfterStore')
            w.kv.write = async () => {
              throw new Error('the run stopped');
            };
          return stored;
        };
        let at = Date.parse('2026-10-01T02:00:00.000Z');
        // At home a run sees every office; abroad, a post it did not check is as last seen.
        const latest = new Map<number, Site>();
        const knewAt = new Map<string, Site[]>();
        for (const step of script) {
          at += step.nextDay ? 24 * 3600_000 : 5 * 60_000;
          const startedAt = new Date(at).toISOString();
          const sites = step.offices.map((o) => site(o.id, o.openDates, startedAt));
          const begun = await beginRecord(w.kv, stream, `run-${at}`, startedAt);
          if (step.fault === 'stopsBeforeRecord') {
            unstored.push(begun);
            continue;
          }
          if (stream === 'scans') latest.clear();
          for (const s of sites) latest.set(s.id, s);
          fault = step.fault;
          const before = w.sink.records.size;
          await w.run(sites, startedAt, { begun }, stream).catch((e: unknown) => {
            if (!(e instanceof RecordError)) throw e;
          });
          w.kv.write = write;
          if (w.sink.records.size > before) knewAt.set(startedAt, [...latest.values()]);
        }
        const records = w.records(stream);
        const { states, gaps } = rebuild(records);
        // The only gaps are records that were not stored, and each is named by a later record.
        const named = gaps.map((g) => g.match(/ says (\S+) could not be stored$/)?.[1]);
        expect(named.every((key) => key !== undefined && unstored.includes(key))).toBe(true);
        const last = records.at(-1)?.record.startedAt ?? '';
        for (const key of unstored) if (key.split('/')[3]!.slice(0, 24) < last.replace(/[:.]/g, '-')) expect(named).toContain(key);
        expect(states.map((s) => s.startedAt)).toEqual([...knewAt.keys()]);
        for (const state of states) {
          expect(state.complete).toBe(true);
          const knew = knewAt.get(state.startedAt)!;
          expect(state.sites.map(bare).sort((a, b) => a.id - b.id)).toEqual(knew.map(bare).sort((a, b) => a.id - b.id));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('reports a missing record, and trusts the rebuild again from the next full one', async () => {
    const w = setup();
    await w.run([site(1), site(2)]);
    await w.run([site(1, ['2026-10-05']), site(2)], '2026-10-01T02:05:00.000Z');
    await w.run([site(1, ['2026-10-05']), site(2, ['2026-10-06'])], '2026-10-01T02:10:00.000Z');
    await w.run([site(1), site(2)], '2026-10-02T00:00:00.000Z');
    const all = w.records();
    const missing = all[1]!.key;
    const { states, gaps } = rebuild(all.filter((r) => r.key !== missing));
    expect(gaps).toEqual([`${all[2]!.key} follows ${missing}, which is not among the records`]);
    expect(states.map((s) => s.complete)).toEqual([true, false, true]);
  });

  it('rebuilds each record onto the one it names, not the one before it in time', async () => {
    const w = setup();
    await w.run([site(1), site(2)]);
    const head = await w.kv.get(K.recordHead('scans'));
    const sites = await w.kv.hGetAll(K.recordSites('scans'));
    // Office 1 opens a date; then Redis is set back by hand to before that record.
    await w.run([site(1, ['2026-10-05']), site(2)], '2026-10-01T02:05:00.000Z');
    await w.kv.write([
      { op: 'set', key: K.recordHead('scans'), value: head! },
      { op: 'hSet', key: K.recordSites('scans'), fields: sites },
    ]);
    // Then office 1 closes it again and office 2 opens one: against what Redis
    // remembers, only office 2 changed.
    await w.run([site(1), site(2, ['2026-10-06'])], '2026-10-01T02:10:00.000Z');
    const { states, gaps } = rebuild(w.records());
    expect(gaps).toEqual([]);
    expect(states.at(-1)!.sites.map(bare)).toEqual([site(1), site(2, ['2026-10-06'])].map(bare));
  });

  it('follows a record to the one it names even when a clock step sorts it first', () => {
    const base = { schema: 2 as const, runId: 'r', finishedAt: '', source: { host: 'h', client: 'c' }, healthy: true, problems: [], groups: [], removed: [], observed: [] };
    const full = { key: 'scans/v2/date=2026-10-01/2026-10-01T02-10-00-000Z_r1.full.json.gz', record: { ...base, kind: 'full' as const, after: null, startedAt: '2026-10-01T02:10:00.000Z', sites: [site(1), site(2)] } };
    // The clock was set back: this record sorts before the one it follows.
    const changes = { key: 'scans/v2/date=2026-10-01/2026-10-01T02-05-00-000Z_r2.changes.json.gz', record: { ...base, kind: 'changes' as const, after: full.key, startedAt: '2026-10-01T02:05:00.000Z', sites: [site(2, ['2026-10-06'])] } };
    const { states, gaps } = rebuild<Site>([full, changes]);
    expect(gaps).toEqual([]);
    // The record it follows comes out first: the states read as the runs happened.
    expect(states.map((s) => s.key)).toEqual([full.key, changes.key]);
    expect(states.find((s) => s.key === changes.key)!.sites.map(bare)).toEqual([site(1), site(2, ['2026-10-06'])].map(bare));
    expect(states.every((s) => s.complete)).toBe(true);
  });
});
