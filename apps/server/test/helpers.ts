import { randomBytes } from 'node:crypto';
import type { Availability, Site } from 'penge-passport-ph';
import { CircuitOpenError } from 'penge-passport-ph';
import type { MailMode } from '../src/config.ts';
import { MemoryKv } from '../src/kv.ts';
import type { Mail, Mailer, SendResult } from '../src/mailer.ts';
import type { SnapshotSink } from '../src/r2.ts';
import type { Scan } from '../src/snapshot.ts';
import type { Keys } from '../src/subscribers.ts';

export const keys: Keys = { email: randomBytes(32), index: randomBytes(32), token: randomBytes(32) };

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
  scans: Scan[] = [];
  putObject?: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  async put(scan: Scan) {
    this.scans.push(scan);
    return true;
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
