import type { AbroadResponse, OfficeTimes, SiteSummary, StatusResponse } from '@penge/contracts';
import { vi } from 'vitest';
import type { Api } from '../src/api.ts';

export const SITES: SiteSummary[] = [
  'Angeles (SM City Clark, Angeles City)',
  'Antipolo (SM Center, Antipolo City, Rizal)',
  'Baguio (SM City Baguio)',
  'Cebu (ROBINSONS GALLERIA , CEBU CITY )',
  'Davao (SM City Davao)',
  'DFA Manila (Aseana)',
  'DFA NCR East (SM Megamall, Mandaluyong City)',
  'Dasmariñas ( SM City Dasmariñas)',
  'Iloilo (Robinsons Iloilo)',
  'Legazpi (Pacific Mall Legazpi)',
  'Lipa (Robinsons Lipa)',
  'Zamboanga (Go-Velayo Bldg. Vet. Ave. Zambo)',
].map((name, i) => ({ id: [10, 486, 693, 20, 30, 40, 50, 60, 70, 80, 90, 100][i]!, name }));

export const STATUS: StatusResponse = {
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastHealthyAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  healthy: true,
  mailLive: true,
  sites: SITES.map((s) => ({
    ...s,
    address: s.id === 486 ? 'SM Center Antipolo, Sumulong Highway, Antipolo City' : null,
    telephone: s.id === 486 ? '(02) 8651-9400' : null,
    mapUrl: s.id === 486 ? 'https://maps.app.goo.gl/J4tPkGDgNSjURhQn7' : null,
    ok: true,
    openDates: s.id === 486 ? ['2026-10-07', '2026-10-09'] : s.id === 693 ? ['2026-10-20'] : [],
    fullDates: ['2026-10-06', '2026-10-08'],
    windowEnd: '2027-03-31',
    publishedDays: 20,
  })),
  push: 'off',
  vapidPublicKey: null,
};

const recent = new Date(Date.now() - 20 * 60_000).toISOString();
const post = (id: number, name: string, regionId: number, region: string, countryId: number, country: string, openDates: string[], publishedDays = 12) => ({
  id,
  name,
  address: id === 497 ? 'Arne Jacobsens Alle 13, 1st Floor, 2300 Copenhagen' : null,
  telephone: id === 497 ? '+45 71415952' : null,
  mapUrl: null,
  checkedAt: recent,
  ok: true,
  openDates,
  fullDates: [],
  windowEnd: '2027-03-31',
  publishedDays,
  regionId,
  region,
  countryId,
  country,
});

export const ABROAD: AbroadResponse = {
  catalogAt: recent,
  checkedEveryMinutes: 60,
  posts: [
    post(200, 'PE Tokyo', 1, 'Asia Pacific', 20, 'Japan', ['2026-10-12']),
    { ...post(201, 'PE Tokyo - Outreach in Okinawa 2026', 1, 'Asia Pacific', 20, 'Japan', [], 0), ok: false, checkedAt: null },
    post(497, 'PE Copenhagen', 2, 'Europe', 62, 'Denmark', [], 0),
    post(36, 'PCG Dubai', 5, 'Middle East/Africa', 4, 'United Arab Emirates', ['2026-10-06', '2026-10-07']),
  ],
};

export const TIMES: OfficeTimes = {
  siteId: 486,
  date: '2026-10-07',
  applicants: 1,
  checkedAt: new Date().toISOString(),
  slots: [
    { start: '08:00', end: '09:00', available: true, remaining: null },
    { start: '11:00', end: '12:00', available: false, remaining: null },
    { start: '12:00', end: '13:00', available: true, remaining: 1 },
  ],
};

export function fakeApi(overrides: Partial<Api> = {}): Api & { [K in keyof Api]: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => STATUS),
    abroad: vi.fn(async () => ABROAD),
    subscribe: vi.fn(async () => 'Check your inbox for a confirmation link.'),
    confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'hourly' as const, channels: { emailOn: true, pushOn: false, push: 'none' as const } })),
    previewConfirm: vi.fn(async () => ({ siteIds: [486], applicants: 1, pace: 'hourly' as const, channels: null })),
    pushDevice: vi.fn(async () => ({ state: 'missing' as const })),
    pushOff: vi.fn(async () => ({ ok: true as const, noChannel: false })),
    pushTest: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    requestDeletion: vi.fn(async () => "Check your inbox for a deletion link."),
    deleteData: vi.fn(async () => {}),
    // Each office's own dates; a group of 4 or more fits only on the office's last open day.
    officeDates: vi.fn(async (siteId: number, applicants: number) => {
      const site = STATUS.sites.find((s) => s.id === siteId) ?? ABROAD.posts.find((s) => s.id === siteId);
      const open = site?.openDates ?? [];
      const fits = applicants > 3 ? open.slice(-1) : open;
      return {
        siteId,
        applicants,
        openDates: fits,
        fullDates: [...(site?.fullDates ?? []), ...open.filter((d) => !fits.includes(d))].sort(),
        windowEnd: site?.windowEnd ?? null,
        checkedAt: new Date().toISOString(),
      };
    }),
    officeTimes: vi.fn(async (siteId: number, date: string, applicants: number) => ({ ...TIMES, siteId, date, applicants })),
    ...overrides,
  } as never;
}
