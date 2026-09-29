// Scans are stored in R2 as changes. A run writes a record only when what it saw
// differs from the last record stored: the offices whose observation changed,
// and the run's own fields (its health, problems and group lookups). A run that
// saw nothing new writes nothing. The first record of each UTC day holds
// everything, so a day can be rebuilt from its own folder (rebuild()).
//
// Two streams: `scans`, every office in the Philippines each run, where an
// office missing from the list has been removed; and `scans-abroad`, a dozen
// posts a run, where a post not checked this run is simply unchanged.
//
// What was last recorded is kept in Redis (recordHead, recordSites). Redis moves
// on before the record is stored, with the record's key in recordLost until it is
// in R2 or the spool. A record that could not be kept, or whose run stopped before
// saying so, leaves its key there: the next record then holds everything, which
// Redis has (including what the missing one saw), and names it. So a record only
// ever follows one that was kept, and nothing a run saw goes missing unnamed.
// A run is said missing from its start (beginRecord), so one that stops before
// making its record (after its alerts, say) is named too.
import { gzipSync } from 'node:zlib';
import { K } from './keys.ts';
import type { Kv, WriteOp } from './kv.ts';
import type { Logger } from './log.ts';
import type { Scan } from './snapshot.ts';

export const RECORD_SCHEMA = 2;

export type Stream = 'scans' | 'scans-abroad';

/** What a stream stores per site: an id, and the moment it was fetched, which is not a change. */
export interface Observed {
  id: number;
  fetchedAt: string | null;
}

export interface ScanRecord<S extends Observed = Observed> {
  schema: typeof RECORD_SCHEMA;
  /** "full": every site; "changes": only what differs from the record named in `after`. */
  kind: 'full' | 'changes';
  /** The record this one follows (a key in the same stream); null for a full record. */
  after: string | null;
  runId: string;
  startedAt: string;
  finishedAt: string;
  source: Scan['source'];
  healthy: boolean;
  problems: string[];
  groups: Scan['groups'];
  sites: S[];
  /**
   * The sites this run saw itself. A full record can carry others over as last
   * recorded: the posts abroad a run did not check, or offices after a list that
   * failed to load.
   */
  observed: number[];
  /** Sites gone from the list since `after`. Only the offices at home are ever removed. */
  removed: number[];
  /**
   * Keys of records since the last one stored that may have been kept nowhere (not
   * in R2, not in the spool), and of runs that stopped before making theirs (named
   * `…_<run>.run`). What they alone saw is not in the history if so; a rebuild
   * lists those it cannot find.
   */
  lost?: string[];
}

/**
 * Where a record goes: `scans/v2/date=2026-10-01/2026-10-01T02-05-00-000Z_<run>.changes.json.gz`.
 * A run that stopped before making its record is named `…_<run>.run`, which is never stored.
 */
export function recordKey(stream: Stream, record: Pick<ScanRecord, 'startedAt' | 'runId' | 'kind'>): string {
  const day = record.startedAt.slice(0, 10);
  const stamp = record.startedAt.replace(/[:.]/g, '-');
  return `${stream}/v${RECORD_SCHEMA}/date=${day}/${stamp}_${record.runId}.${record.kind}.json.gz`;
}

/** Says a run's record is missing until it is made: returns the name to pass to recordRun or skipRecord. */
export async function beginRecord(kv: Kv, stream: Stream, runId: string, startedAt: string): Promise<string> {
  const key = `${stream}/v${RECORD_SCHEMA}/date=${startedAt.slice(0, 10)}/${startedAt.replace(/[:.]/g, '-')}_${runId}.run`;
  await kv.write([{ op: 'sAdd', key: K.recordLost(stream), members: [key] }]);
  return key;
}

/** A run that has nothing to record (no post abroad was due): it is not missing. */
export async function skipRecord(kv: Kv, stream: Stream, begun: string): Promise<void> {
  await kv.write([{ op: 'sRem', key: K.recordLost(stream), members: [begun] }]);
}

/** What a sink does with a record: stores it now, spools it for a later run, or can't keep it. */
export type Stored = 'uploaded' | 'spooled' | 'lost';

export interface RecordSink {
  /** `timeoutMs`: how long an upload may take; with none left, the record goes straight to the spool. */
  store(key: string, body: Uint8Array, timeoutMs?: number): Promise<Stored>;
}

export type Recorded = Stored | 'unchanged';

/** A record that failed part-way: `stored` says whether it reached R2 or the spool, under `key`. */
export class RecordError extends Error {
  constructor(
    readonly key: string | null,
    readonly stored: boolean,
    override readonly cause: unknown,
  ) {
    super(`scan record ${key ?? '(not made)'}${stored ? ' stored, but not remembered' : ' not stored'}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

interface Head {
  day: string;
  key: string;
  run: string;
}

/** A site as compared: everything but when it was fetched. */
const content = (site: Observed) => JSON.stringify({ ...site, fetchedAt: null });

/** The run's own fields as compared (not its times or id). */
function runContent(run: Pick<ScanRecord, 'source' | 'healthy' | 'problems' | 'groups'>) {
  const groups = [...run.groups].sort((a, b) => a.siteId - b.siteId || a.applicants - b.applicants);
  return JSON.stringify({ source: run.source, healthy: run.healthy, problems: run.problems, groups });
}

function parseHead(raw: string | null): Head | null {
  if (!raw) return null;
  try {
    const head = JSON.parse(raw) as Partial<Head>;
    return typeof head.day === 'string' && typeof head.key === 'string' && typeof head.run === 'string' ? (head as Head) : null;
  } catch {
    return null;
  }
}

export interface RecordDeps {
  kv: Kv;
  sink: RecordSink;
  log: Logger;
}

/**
 * What a run can say about the sites it did not see. `complete`: it observed
 * every site of the stream, so one it did not see is gone. Otherwise (the posts
 * abroad, a dozen a run) one it did not see is unchanged, unless `known`, the
 * full list of the stream's sites, no longer has it.
 */
export interface Coverage {
  complete: boolean;
  known?: readonly number[];
}

/**
 * Stores what changed in this run since the stream's last record. Throws a
 * RecordError if it fails part-way, saying whether the record was stored.
 * `begun`, from beginRecord, is cleared once the record is made (or found
 * unneeded); until then the run is said missing.
 */
export async function recordRun<S extends Observed>(
  deps: RecordDeps,
  stream: Stream,
  run: Pick<ScanRecord<S>, 'runId' | 'startedAt' | 'finishedAt' | 'source' | 'healthy' | 'problems' | 'groups' | 'sites'>,
  coverage: Coverage,
  begun?: string,
): Promise<Recorded> {
  const progress = { key: null as string | null, stored: false };
  try {
    return await record(deps, stream, run, coverage, begun, progress);
  } catch (err) {
    throw err instanceof RecordError ? err : new RecordError(progress.key, progress.stored, err);
  }
}

async function record<S extends Observed>(
  deps: RecordDeps,
  stream: Stream,
  run: Pick<ScanRecord<S>, 'runId' | 'startedAt' | 'finishedAt' | 'source' | 'healthy' | 'problems' | 'groups' | 'sites'>,
  coverage: Coverage,
  begun: string | undefined,
  progress: { key: string | null; stored: boolean },
): Promise<Recorded> {
  const { kv, sink, log } = deps;
  const head = parseHead(await kv.get(K.recordHead(stream)));
  const stored = await kv.hGetAll(K.recordSites(stream));
  const day = run.startedAt.slice(0, 10);
  const runFields = runContent(run);
  const lost = (await kv.sMembers(K.recordLost(stream))).filter((key) => key !== begun).sort();

  const seen = new Set(run.sites.map((s) => String(s.id)));
  const changed = run.sites.filter((s) => {
    const before = stored[String(s.id)];
    return before === undefined || content(JSON.parse(before) as Observed) !== content(s);
  });
  const { complete, known } = coverage;
  const stillThere = complete ? seen : known ? new Set([...known.map(String), ...seen]) : null;
  const removed = stillThere ? Object.keys(stored).filter((id) => !stillThere.has(id)).map(Number) : [];

  // A new day, nothing (or nothing readable) to follow, or a record that may be
  // missing: everything. A day whose full record held no site (an empty list) has an
  // empty hash, and that is fine. A record that may be missing is named in the next
  // one even if nothing else changed: what it alone saw (a date that opened and
  // closed again, say) would otherwise vanish from the history without a trace.
  const full = head === null || head.day !== day || lost.length > 0;
  if (!full && changed.length === 0 && removed.length === 0 && head.run === runFields) {
    if (begun) await skipRecord(kv, stream, begun);
    return 'unchanged';
  }

  let sites: S[];
  if (!full) sites = changed;
  else if (complete) sites = run.sites;
  else {
    // Posts not checked this run keep what was last recorded of them, unless gone from the list.
    const gone = new Set(removed.map(String));
    const all = new Map<string, S>(Object.entries(stored).filter(([id]) => !gone.has(id)).map(([id, json]) => [id, JSON.parse(json) as S]));
    for (const s of run.sites) all.set(String(s.id), s);
    sites = [...all.values()];
  }
  const record: ScanRecord<S> = {
    schema: RECORD_SCHEMA,
    kind: full ? 'full' : 'changes',
    after: full ? null : head!.key,
    runId: run.runId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    source: run.source,
    healthy: run.healthy,
    problems: run.problems,
    groups: run.groups,
    sites,
    observed: run.sites.map((s) => s.id),
    removed: full ? [] : removed,
    ...(lost.length > 0 ? { lost } : {}),
  };
  const key = recordKey(stream, record);
  progress.key = key;

  // Redis first, with the record (in place of the run) said lost until it is kept (see the top).
  const ops: WriteOp[] = [
    { op: 'set', key: K.recordHead(stream), value: JSON.stringify({ day, key, run: runFields } satisfies Head) },
    { op: 'sAdd', key: K.recordLost(stream), members: [key] },
  ];
  if (begun) ops.push({ op: 'sRem', key: K.recordLost(stream), members: [begun] });
  if (full && complete) ops.push({ op: 'del', key: K.recordSites(stream) });
  ops.push({ op: 'hSet', key: K.recordSites(stream), fields: Object.fromEntries((full ? sites : changed).map((s) => [String(s.id), JSON.stringify(s)])) });
  if (removed.length > 0) ops.push({ op: 'hDel', key: K.recordSites(stream), fields: removed.map(String) });
  await kv.write(ops);

  const outcome = await sink.store(key, gzipSync(JSON.stringify(record)));
  if (outcome === 'lost') {
    log.error('scan record kept nowhere; the next record holds everything and names it', { stream, key });
    return outcome;
  }
  progress.stored = true;
  // Kept, and it named the ones before it that may be missing.
  await kv.write([{ op: 'sRem', key: K.recordLost(stream), members: [key, ...lost] }]);
  return outcome;
}

/**
 * Notes records as lost, each in its stream's set (a full spool dropped them, or
 * one failed before Redis heard of it), so the next record holds everything and
 * names them, and a rebuild reports the gap. Only this layout's records: an
 * older scan left in the spool is not part of any chain.
 */
export async function noteLost(kv: Kv, keys: string[]): Promise<void> {
  const byStream = new Map<Stream, string[]>();
  for (const key of keys) {
    const stream = key.split('/')[0] as Stream;
    if ((stream !== 'scans' && stream !== 'scans-abroad') || !key.startsWith(`${stream}/v${RECORD_SCHEMA}/`)) continue;
    byStream.set(stream, [...(byStream.get(stream) ?? []), key]);
  }
  const ops: WriteOp[] = [...byStream].map(([stream, members]) => ({ op: 'sAdd', key: K.recordLost(stream), members }));
  if (ops.length > 0) await kv.write(ops);
}

/** The whole picture at one record: the run's fields, and every site as last recorded. */
export interface RebuiltState<S extends Observed = Observed> {
  key: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  source: Scan['source'];
  healthy: boolean;
  problems: string[];
  groups: Scan['groups'];
  sites: S[];
  /** The sites this run saw itself; the others are as last recorded. */
  observed: number[];
  /**
   * False when a record this one depends on is missing: the sites may not be what
   * the run saw. It says nothing of coverage: the posts abroad are in the picture
   * once a run has checked them, within 6 hours of the stream starting for the
   * quietest (deploy/README.md, Data in R2).
   * A site's `fetchedAt` is when what it shows was fetched, which can be an earlier
   * run: a fetch that found nothing new is not recorded.
   */
  complete: boolean;
}

/**
 * Replays a stream's records into the full picture at each one. A record's
 * changes apply to the picture at the record it names in `after`, not simply
 * to the one before it in time: should Redis be set back by hand, the next
 * record follows an older one, and replaying in time order would carry the
 * ones in between over by mistake. A record whose `after` is not among the
 * records means one went missing (a spooled record the full spool dropped, say):
 * its picture, and those that build on it until the next full record, are
 * marked incomplete, and the gap is listed in `gaps`. States
 * come out in the order of their keys (the order of their runs, by the clock),
 * except that a record always comes after the one it follows, should the clock
 * have been set back between them. A full record follows none: after the clock
 * is set back, one can come out before records made earlier. Each state still
 * holds what its own run knew, and says when that run started.
 */
export function rebuild<S extends Observed>(
  records: { key: string; record: ScanRecord<S> }[],
  /** Keys known to be in R2 though not among `records` (another day's): not gaps when said lost. */
  opts: { stored?: ReadonlySet<string> } = {},
): { states: RebuiltState<S>[]; gaps: string[] } {
  const byKey = new Map(records.map((r) => [r.key, r.record]));
  const pictures = new Map<string, { sites: Map<number, S>; whole: boolean }>();
  const gaps: string[] = [];

  const pictureAt = (key: string): { sites: Map<number, S>; whole: boolean } => {
    // Walk back to a full record, a gap, or a picture already made; then forwards.
    const chain: string[] = [];
    let base: { sites: Map<number, S>; whole: boolean } | null = null;
    for (let at: string | null = key; at !== null; ) {
      const known = pictures.get(at);
      if (known) {
        base = known;
        break;
      }
      const record: ScanRecord<S> = byKey.get(at)!;
      chain.push(at);
      if (record.kind === 'full') break;
      const after: string | null = record.after;
      if (after === null || !byKey.has(after) || chain.includes(after)) {
        gaps.push(`${at} follows ${after ?? 'nothing'}, which is not among the records`);
        break;
      }
      at = after;
    }
    for (const at of chain.reverse()) {
      const record = byKey.get(at)!;
      let picture: { sites: Map<number, S>; whole: boolean };
      if (record.kind === 'full') picture = { sites: new Map(record.sites.map((site) => [site.id, site])), whole: true };
      else {
        const sites = new Map(base?.sites ?? []);
        for (const site of record.sites) sites.set(site.id, site);
        for (const id of record.removed) sites.delete(id);
        picture = { sites, whole: base?.whole ?? false };
      }
      pictures.set(at, picture);
      base = picture;
    }
    return pictures.get(key)!;
  };

  // Parents before children, otherwise by key.
  const order: string[] = [];
  const placed = new Set<string>();
  const place = (key: string) => {
    const path: string[] = [];
    for (let at: string | null = key; at !== null && byKey.has(at) && !placed.has(at) && !path.includes(at); at = byKey.get(at)!.after) path.push(at);
    for (const at of path.reverse()) {
      placed.add(at);
      order.push(at);
    }
  };
  for (const key of [...byKey.keys()].sort()) place(key);

  const states: RebuiltState<S>[] = [];
  for (const key of order) {
    const record = byKey.get(key)!;
    // A record said lost can be there after all (an upload that timed out on our side but landed).
    for (const missing of record.lost ?? []) if (!byKey.has(missing) && !opts.stored?.has(missing)) gaps.push(`${key} says ${missing} could not be stored`);
    const picture = pictureAt(key);
    states.push({
      key,
      runId: record.runId,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      source: record.source,
      healthy: record.healthy,
      problems: record.problems,
      groups: record.groups,
      sites: [...picture.sites.values()],
      observed: record.observed ?? record.sites.map((s) => s.id),
      complete: picture.whole,
    });
  }
  return { states, gaps };
}
