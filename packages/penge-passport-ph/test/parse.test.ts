import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isIsoDate,
  parseAvailability,
  parseBootstrap,
  parseCountries,
  parseSites,
  parseTimeSlots,
} from '../src/parse.js';
import { UpstreamError } from '../src/errors.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseBootstrap', () => {
  it('reads the form token, server date and booking horizon from /appointment', () => {
    expect(parseBootstrap(fixture('bootstrap-appointment.html'))).toEqual({
      token: 'FIXTURE-FORM-TOKEN',
      serverToday: '2026-09-26',
      maxDate: '2027-03-31',
    });
  });

  it('accepts attributes in any order', () => {
    const html = `<input value="abc" type="hidden" name="__RequestVerificationToken">`;
    expect(parseBootstrap(html)?.token).toBe('abc');
  });

  it('returns null when there is no token', () => {
    expect(parseBootstrap('<html><body>Maintenance</body></html>')).toBeNull();
  });
});

describe('parseCountries / parseSites', () => {
  it('maps countries', () => {
    const countries = parseCountries(JSON.parse(fixture('countries-region1.json')), '/countries');
    expect(countries).toContainEqual({ id: 1, name: 'Philippines' });
    expect(countries).toHaveLength(23);
  });

  it('maps sites and converts .NET ticks to a UTC offset', () => {
    const sites = parseSites(JSON.parse(fixture('sites-region1-country1.json')), '/sites');
    expect(sites).toHaveLength(43);
    const antipolo = sites.find((s) => s.id === 486);
    expect(antipolo).toMatchObject({
      name: 'Antipolo (SM Center, Antipolo City, Rizal)',
      description: 'DFA Regional Consular Office - Antipolo',
      telephone: '(02) 8562 2491',
      hours: null,
      utcOffsetMinutes: 480,
    });
    expect(sites.find((s) => s.id === 10)?.address).toContain('\nBarangay Malabanias');
  });

  it('rejects a changed response shape loudly', () => {
    expect(() => parseSites({ Locations: [] }, '/sites')).toThrow(UpstreamError);
    expect(() => parseSites({ Sites: [{ Id: '10' }] }, '/sites')).toThrow(/integer id/);
  });
});

describe('parseAvailability', () => {
  it('turns epoch-ms UTC midnights into site dates, sorted', () => {
    const days = parseAvailability(JSON.parse(fixture('availability-site486.json')), '/x');
    expect(days[0]).toEqual({ date: '2026-09-30', available: false });
    expect(days.find((d) => d.date === '2026-10-08')).toEqual({ date: '2026-10-08', available: true });
    expect(days.map((d) => d.date)).toEqual([...days.map((d) => d.date)].sort());
    // Only working days are published.
    expect(days.some((d) => ['0', '6'].includes(String(new Date(`${d.date}T00:00:00Z`).getUTCDay())))).toBe(false);
  });

  it('rejects entries with a changed shape', () => {
    expect(() => parseAvailability({}, '/x')).toThrow(/not a JSON array/);
    expect(() => parseAvailability([{ IsAvailable: 'yes', AppointmentDate: 1 }], '/x')).toThrow(
      /unexpected shape/,
    );
  });
});

describe('parseTimeSlots', () => {
  it('parses an open and several booked slots', () => {
    const slots = parseTimeSlots(fixture('timeslot-2026-10-05-site486.html'));
    expect(slots).toHaveLength(8);
    expect(slots[0]).toEqual({
      start: '08:30',
      end: '09:30',
      available: true,
      remaining: 1,
      status: 'Available Slots: 1',
      note: null,
    });
    expect(slots.slice(1).every((s) => !s.available && s.status === 'Fully Booked')).toBe(true);
    expect(slots.at(-1)).toMatchObject({ start: '15:30', end: '16:30', remaining: null });
  });

  it('parses a fully booked day', () => {
    const slots = parseTimeSlots(fixture('timeslot-2026-10-07-site486-full.html'));
    expect(slots).toHaveLength(8);
    expect(slots.every((s) => !s.available)).toBe(true);
  });

  it('never exposes the internal slot ids', () => {
    const slots = parseTimeSlots(fixture('timeslot-2026-10-05-site486.html'));
    expect(JSON.stringify(slots)).not.toMatch(/1531858/);
  });

  it('returns [] for the empty "not published yet" answer', () => {
    expect(parseTimeSlots('\r\n\r\n')).toEqual([]);
  });

  it('reads notes and single-digit hours', () => {
    const html = `<label class="col-xs-12"><span class="col-xs-7">
      <input id="TimeSlotID" name="TimeSlotID" type="radio" value="1.0" />
      <span class="hidden">Senior citizens &amp; PWD only</span><span>7:30-8:30</span></span>
      <span class="col-xs-5 text-success">Available Slots: 12</span></label>`;
    expect(parseTimeSlots(html)).toEqual([
      {
        start: '07:30',
        end: '08:30',
        available: true,
        remaining: 12,
        status: 'Available Slots: 12',
        note: 'Senior citizens & PWD only',
      },
    ]);
  });
});

describe('isIsoDate', () => {
  it('accepts real dates only', () => {
    expect(isIsoDate('2026-10-05')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-1-5')).toBe(false);
  });
});
