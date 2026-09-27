import { describe, expect, it } from 'vitest';
import { hourRange, matches, shortDate, sortOffices, splitName, toOffices } from '../src/office.ts';
import { areaOf } from '../src/areas.ts';

describe('office names', () => {
  it.each([
    ['Antipolo (SM Center, Antipolo City, Rizal)', 'Antipolo', 'SM Center, Antipolo City, Rizal'],
    ['DFA NCR Central - (Robinsons Galleria Ortigas, Quezon City)', 'DFA NCR Central', 'Robinsons Galleria Ortigas, Quezon City'],
    ['Cebu (ROBINSONS GALLERIA , CEBU CITY )', 'Cebu', 'Robinsons Galleria, Cebu City'],
    ['Clarin (Town Center,,Clarin, Misamis OCC)', 'Clarin', 'Town Center, Clarin, Misamis OCC'],
    ['Paniqui,  Tarlac (WalterMart)', 'Paniqui, Tarlac', 'WalterMart'],
    ['Dasmariñas ( SM City Dasmariñas)', 'Dasmariñas', 'SM City Dasmariñas'],
    ['Kidapawan ( Kidapawan City )', 'Kidapawan', 'Kidapawan City'],
    ['San Pablo ( Sm City San Pablo)', 'San Pablo', 'SM City San Pablo'],
    ['Plain Name', 'Plain Name', ''],
    ['(odd)', '(odd)', ''],
  ])('%s', (name, place, detail) => {
    expect(splitName(name)).toEqual({ place, detail });
  });
});

describe('sorting and search', () => {
  const offices = toOffices([
    { id: 1, name: 'Baguio (SM)', ok: true, openDates: ['2026-10-09'], publishedDays: 3 },
    { id: 2, name: 'Antipolo (SM)', ok: true, openDates: [], publishedDays: 3 },
    { id: 3, name: 'Cebu (Robinsons)', ok: true, openDates: ['2026-10-02', '2026-10-01'], publishedDays: 3 },
    { id: 4, name: 'Dasmariñas (SM City Dasmariñas)', ok: false, openDates: [], publishedDays: 0 },
  ]);

  it('puts the soonest open dates first, then the rest by name', () => {
    expect(sortOffices(offices, 'soonest').map((o) => o.id)).toEqual([3, 1, 2, 4]);
    expect(sortOffices(offices, 'name').map((o) => o.id)).toEqual([2, 1, 3, 4]);
    expect(offices.find((o) => o.id === 3)!.earliest).toBe('2026-10-01');
  });

  it('finds offices by place or mall, without needing accents', () => {
    expect(offices.filter((o) => matches(o, 'dasmarinas')).map((o) => o.id)).toEqual([4]);
    expect(offices.filter((o) => matches(o, 'robinsons')).map((o) => o.id)).toEqual([3]);
    expect(offices.filter((o) => matches(o, '  ')).length).toBe(4);
  });
});

describe('dates', () => {
  it('writes dates and hours the way people say them', () => {
    expect(shortDate('2026-10-01')).toBe('Thu 1 Oct');
    expect(hourRange('08:00', '09:00')).toBe('8:00 to 9:00 AM');
    expect(hourRange('11:00', '12:00')).toBe('11:00 AM to 12:00 PM');
    expect(hourRange('12:00', '13:00')).toBe('12:00 to 1:00 PM');
    expect(hourRange('15:00', '16:00')).toBe('3:00 to 4:00 PM');
  });

  it('knows which area each office is in', () => {
    expect(areaOf('DFA NCR East')).toBe('NCR');
    expect(areaOf('Dasmariñas')).toBe('Luzon');
    expect(areaOf('Cebu')).toBe('Visayas');
    expect(areaOf('Cagayan De Oro')).toBe('Mindanao');
    expect(areaOf('Somewhere New')).toBe('Other');
  });
});

describe('office facts', () => {
  it('keeps real phone numbers and Google Maps links, and drops the rest', () => {
    const [real, odd] = toOffices([
      { id: 1, name: 'A', telephone: ' (02) 8651-9400 ', mapUrl: 'https://maps.app.goo.gl/J4tPkGDgNSjURhQn7', ok: true, openDates: [], publishedDays: 0 },
      { id: 2, name: 'B', telephone: '0000', mapUrl: 'Level 1, Candon City Arena, Bypass Road', ok: true, openDates: [], publishedDays: 0 },
    ]);
    expect([real!.telephone, real!.mapUrl]).toEqual(['(02) 8651-9400', 'https://maps.app.goo.gl/J4tPkGDgNSjURhQn7']);
    expect([odd!.telephone, odd!.mapUrl]).toEqual([null, null]);
  });
});
