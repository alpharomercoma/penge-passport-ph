import { createECDH, randomBytes } from 'node:crypto';
import type { Availability, Site } from 'penge-passport-ph';
import { CircuitOpenError } from 'penge-passport-ph';
import type { MailMode } from '../src/config.ts';
import { MemoryKv } from '../src/kv.ts';
import type { Logger } from '../src/log.ts';
import type { Mail, Mailer, SendResult } from '../src/mailer.ts';
import { gunzipSync } from 'node:zlib';
import type { SnapshotSink } from '../src/r2.ts';
import { type Observed, rebuild, type ScanRecord, type Stored, type Stream } from '../src/record.ts';
import type { SiteObservation } from '../src/snapshot.ts';
import type { Keys } from '../src/subscribers.ts';

export const keys: Keys = { email: randomBytes(32), index: randomBytes(32), token: randomBytes(32) };

/** A real P-256 public key and auth secret, as a browser would send them. */
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
export const PUSH_KEYS = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
export const fcmSubscription = (id = randomBytes(8).toString('hex')) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: { ...PUSH_KEYS },
});

export class FakeMailer implements Mailer {
  sent: Mail[] = [];
  /** The next sends fail as when the mail server is down: surely not sent. */
  failNext = 0;
  /** The next sends fail part-way through: they may have gone out. */
  uncertainNext = 0;
  mode: MailMode;
  constructor(mode: MailMode = 'live') {
    this.mode = mode;
  }
  async send(mail: Mail): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ESOCKET', syscall: 'connect' });
    }
    if (this.uncertainNext > 0) {
      this.uncertainNext--;
      throw Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' });
    }
    this.sent.push(mail);
    return this.mode === 'live' ? 'sent' : this.mode;
  }
  close() {}
}

export class MemorySink implements SnapshotSink {
  /** Every scan record stored (record.ts), by key. */
  records = new Map<string, Uint8Array>();
  /** How the next stores go, one each; after these, every store is uploaded. */
  outcomes: Stored[] = [];
  putObject?: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  deleteObject?: (key: string) => Promise<void>;
  listObjects?: (prefix: string) => Promise<string[]>;
  /** How many times a run asked for the spool to be sent, and for how long each time. */
  flushes = 0;
  flushBudgets: (number | undefined)[] = [];
  async flush(budgetMs?: number) {
    this.flushes++;
    this.flushBudgets.push(budgetMs);
  }
  /** The time each store was given to upload its record. */
  storeTimeouts: (number | undefined)[] = [];
  async store(key: string, body: Uint8Array, timeoutMs?: number): Promise<Stored> {
    this.storeTimeouts.push(timeoutMs);
    const outcome = this.outcomes.shift() ?? 'uploaded';
    if (outcome !== 'lost') this.records.set(key, body);
    return outcome;
  }
  /** A stream's records, decoded, in the order their keys sort (oldest first). */
  recordsOf<S extends Observed = SiteObservation>(stream: Stream): { key: string; record: ScanRecord<S> }[] {
    return [...this.records.keys()]
      .filter((key) => key.startsWith(`${stream}/`))
      .sort()
      .map((key) => ({ key, record: JSON.parse(gunzipSync(this.records.get(key)!).toString()) as ScanRecord<S> }));
  }
  /** What each run that stored a record saw at home, rebuilt in full from the records. */
  get scans() {
    return rebuild(this.recordsOf('scans')).states;
  }
}

export const SITES: Site[] = [
  { id: 10, name: 'Angeles (SM City Clark, Angeles City)' },
  { id: 486, name: 'Antipolo (SM Center, Antipolo City, Rizal)' },
  { id: 693, name: 'Baguio (SM City Baguio)' },
  { id: 20, name: 'Cebu (ROBINSONS GALLERIA , CEBU CITY )' },
  { id: 30, name: 'Davao (SM City Davao)' },
].map((s) => ({ ...s, description: null, address: null, telephone: null, hours: null, mapUrl: null, utcOffsetMinutes: 480 }));

export const PUBLISHED = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];

/**
 * A pretend passport.gov.ph. `open` maps "siteId" or "siteId:applicants" to
 * open dates; every site publishes PUBLISHED unless `published` says otherwise.
 */
export class FakeUpstream {
  open = new Map<string, string[]>();
  published = new Map<number, string[]>();
  failing = new Set<number>();
  /** Offices that answer with an error once, then normally. */
  failOnce = new Set<number>();
  circuitAt: number | null = null;
  sitesError: Error | null = null;
  sitesList: Site[] = SITES;
  calls: string[] = [];

  async sites() {
    this.calls.push('sites');
    if (this.sitesError) throw this.sitesError;
    return this.sitesList;
  }

  async availability({ siteId, applicants }: { siteId: number; applicants: number }): Promise<Availability> {
    this.calls.push(`${siteId}:${applicants}`);
    if (this.circuitAt === siteId) throw new CircuitOpenError('circuit open', 60_000);
    if (this.failing.has(siteId)) throw new Error(`site ${siteId} broke`);
    if (this.failOnce.delete(siteId)) throw new Error(`site ${siteId} hiccuped`);
    const published = this.published.get(siteId) ?? PUBLISHED;
    const open1 = this.open.get(String(siteId)) ?? [];
    const open = applicants === 1 ? open1 : (this.open.get(`${siteId}:${applicants}`) ?? []).filter((d) => open1.includes(d));
    return {
      siteId,
      from: published[0] ?? '2026-10-05',
      to: published.at(-1) ?? '2026-10-08',
      applicants,
      earliest: open[0] ?? null,
      availableDates: open,
      days: published.map((date) => ({ date, available: open.includes(date) })),
      fetchedAt: new Date().toISOString(),
      cached: false,
    };
  }
}

export function clock(start = Date.parse('2026-09-27T02:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

export { MemoryKv };

/** A logger that keeps every line, as JSON, for tests to read. */
export function recordingLog() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m, f) => lines.push(JSON.stringify({ m, f })),
    warn: (m, f) => lines.push(JSON.stringify({ m, f })),
    error: (m, f) => lines.push(JSON.stringify({ m, f })),
  };
  return { log, lines };
}
