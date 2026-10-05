// A pretend passport.gov.ph for the local stack: three offices, four published
// days, and whatever dates the alert script opens. No network.
import type { Availability, Site, TimeSlot } from 'penge-passport-ph';
import type { Upstream } from '../src/checker.ts';
import type { LookupUpstream } from '../src/lookups.ts';

const SITES: Site[] = [
  { id: 486, name: 'Antipolo (SM Center, Antipolo City, Rizal)' },
  { id: 693, name: 'Baguio (SM City Baguio)' },
  { id: 20, name: 'Cebu (ROBINSONS GALLERIA , CEBU CITY )' },
].map((s) => ({ ...s, description: null, address: null, telephone: null, hours: null, mapUrl: null, utcOffsetMinutes: 480 }));

export class FakeDfa implements Upstream, LookupUpstream {
  readonly open = new Map<number, string[]>();
  published(): string[] {
    const today = Date.now();
    return [3, 4, 7, 8].map((d) => new Date(today + d * 86_400_000).toISOString().slice(0, 10));
  }
  async sites() {
    return SITES;
  }
  async availability({ siteId, applicants }: { siteId: number; applicants: number }): Promise<Availability> {
    const published = [...new Set([...this.published(), ...(this.open.get(siteId) ?? [])])].sort();
    const open = this.open.get(siteId) ?? [];
    return {
      siteId, applicants, from: published[0]!, to: published.at(-1)!, earliest: open[0] ?? null, availableDates: open,
      days: published.map((date) => ({ date, available: open.includes(date) })), fetchedAt: new Date().toISOString(), cached: false,
    };
  }
  /** Two hours each open day: the morning with room, the afternoon full. */
  async timeSlots({ siteId, date }: { siteId: number; date: string; applicants: number }): Promise<TimeSlot[]> {
    const open = (this.open.get(siteId) ?? []).includes(date);
    return [
      { start: '08:00', end: '09:00', available: open, remaining: open ? 2 : 0, status: open ? 'Available Slots: 2' : 'Fully Booked', note: null },
      { start: '13:00', end: '14:00', available: false, remaining: 0, status: 'Fully Booked', note: null },
    ];
  }
  async warmSession() {
    return true;
  }
}
