import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  describePost,
  formatDate,
  isAbroadResponse,
  isCalendarDate,
  isOfficeDates,
  isOfficeTimes,
  isStatusResponse,
  isToken,
  isUnsubscribeToken,
  LIMITS,
  normalizeEmail,
  officeMapUrl,
  officePhone,
  shortName,
  validateSubscribe,
} from '../src/index.ts';

const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);
const SEED = 20260927;
const SAFE_EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9.-]{4,253}$/;

describe('normalizeEmail', () => {
  it.each([
    ['Juan.Dela-Cruz+alerts@Example.COM ', 'juan.dela-cruz+alerts@example.com'],
    ['a@b.co', 'a@b.co'],
    ['user@sub.domain.ph', 'user@sub.domain.ph'],
    ['x@xn--mnchen-3ya.de', 'x@xn--mnchen-3ya.de'],
  ])('accepts %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  it.each([
    '', 'plain', '@example.com', 'a@', 'a@b', 'a@@b.com', 'a@b@c.com', '.a@b.com', 'a.@b.com', 'a..b@c.com',
    'a b@c.com', '"quoted"@example.com', 'a@[127.0.0.1]', 'a@-b.com', 'a@b-.com', 'a@b..com', 'a@b.c',
    'a@b.123', 'jose@münchen.de', 'a@b.com\r\nBcc: victim@example.com', 'a@b.com, other@c.com',
    'a<b>@c.com', `${'x'.repeat(65)}@example.com`, `a@${'b'.repeat(64)}.com`, `a@${'b.'.repeat(130)}com`,
  ])('rejects %j', (raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });

  it('never throws, and anything accepted is a clean, idempotent address', () => {
    const emailish = fc
      .tuple(
        fc.string({ unit: fc.constantFrom(...'abcXYZ019.+-_@!#\'"() \t\r\n,;<>[]\\é'), maxLength: 30 }),
        fc.constantFrom('@example.com', '@b.co', '', '@', '@xn--p1ai', '@-x.com', '@a.b.c.ph'),
      )
      .map(([a, b]) => a + b);
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.string({ unit: 'binary' }), emailish), (raw) => {
        const email = normalizeEmail(raw);
        if (email === null) return;
        expect(email).toMatch(SAFE_EMAIL);
        expect(email.length).toBeLessThanOrEqual(LIMITS.emailMaxLength);
        expect(email.split('@')).toHaveLength(2);
        expect(normalizeEmail(email)).toBe(email);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('validateSubscribe', () => {
  const known = new Set([10, 486, 693]);

  it('accepts a normal request, de-duplicating and sorting sites', () => {
    expect(
      validateSubscribe({ email: 'A@b.co', siteIds: [693, 10, 693], applicants: 2 }, known),
    ).toEqual({ ok: true, value: { email: 'a@b.co', siteIds: [10, 693], applicants: 2, pace: 'hourly' } });
    expect(validateSubscribe({ email: 'a@b.co', siteIds: [10] })).toMatchObject({ ok: true, value: { applicants: 1, pace: 'hourly' } });
    expect(validateSubscribe({ email: 'a@b.co', siteIds: [10], pace: 'asap' })).toMatchObject({ ok: true, value: { pace: 'asap' } });
  });

  it.each([
    [null, 'form'],
    [[], 'form'],
    ['{"email":"a@b.co"}', 'form'],
    [{ email: 'a@b.co', siteIds: [10], website: 'http://spam' }, 'form'],
    [{ email: 'nope', siteIds: [10] }, 'email'],
    [{ email: 'a@b.co', siteIds: [10], pace: 'daily' }, 'pace'],
    [{ email: 'a@b.co', siteIds: [10], pace: null }, 'pace'],
    [{ email: 'a@b.co', siteIds: [] }, 'siteIds'],
    [{ email: 'a@b.co', siteIds: '10' }, 'siteIds'],
    [{ email: 'a@b.co', siteIds: [10.5] }, 'siteIds'],
    [{ email: 'a@b.co', siteIds: [-1] }, 'siteIds'],
    [{ email: 'a@b.co', siteIds: [999] }, 'siteIds'],
    [{ email: 'a@b.co', siteIds: Array.from({ length: 11 }, (_, i) => i + 1) }, 'siteIds'],
    [{ email: 'a@b.co', siteIds: [10], applicants: 0 }, 'applicants'],
    [{ email: 'a@b.co', siteIds: [10], applicants: '2' }, 'applicants'],
    [{ email: 'a@b.co', siteIds: [10], applicants: 6 }, 'applicants'], // the DFA's group form stops at 5
  ])('rejects %j (%s)', (input, field) => {
    const result = validateSubscribe(input, known);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveProperty(field);
  });

  it('never throws, and anything accepted is within every limit', () => {
    const body = fc.record(
      {
        email: fc.oneof(fc.anything(), fc.constantFrom('a@b.co', 'x@example.com', 'bad', '')),
        siteIds: fc.oneof(fc.anything(), fc.array(fc.oneof(fc.integer(), fc.double(), fc.constantFrom(10, 486, 693)), { maxLength: 50 })),
        applicants: fc.oneof(fc.anything(), fc.integer({ min: -5, max: 15 })),
        website: fc.oneof(fc.constant(undefined), fc.constant(''), fc.string()),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.oneof(fc.anything(), body), fc.boolean(), (input, withKnown) => {
        const result = validateSubscribe(input, withKnown ? known : undefined);
        if (!result.ok) {
          expect(Object.keys(result.errors).length).toBeGreaterThan(0);
          return;
        }
        const { email, siteIds, applicants } = result.value;
        expect(normalizeEmail(email)).toBe(email);
        expect(siteIds.length).toBeGreaterThanOrEqual(1);
        expect(siteIds.length).toBeLessThanOrEqual(LIMITS.sitesPerSubscription);
        expect(new Set(siteIds).size).toBe(siteIds.length);
        expect(siteIds).toEqual([...siteIds].sort((a, b) => a - b));
        for (const id of siteIds) {
          expect(Number.isSafeInteger(id) && id >= 1).toBe(true);
          if (withKnown) expect(known.has(id)).toBe(true);
        }
        expect(applicants >= 1 && applicants <= LIMITS.maxApplicants).toBe(true);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('tokens', () => {
  it('accept only the exact shapes the server issues', () => {
    expect(isToken('a'.repeat(43))).toBe(true);
    expect(isToken('a'.repeat(42))).toBe(false);
    expect(isToken('a'.repeat(42) + '=')).toBe(false);
    expect(isUnsubscribeToken(`${'s'.repeat(22)}.${'a'.repeat(43)}`)).toBe(true);
    expect(isUnsubscribeToken(`${'s'.repeat(22)}.${'a'.repeat(43)}\n`)).toBe(false);
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => isToken(raw)).not.toThrow();
        expect(() => isUnsubscribeToken(raw)).not.toThrow();
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('display helpers', () => {
  it('format dates and names', () => {
    expect(formatDate('2026-10-05')).toBe('Mon 5 Oct 2026');
    expect(formatDate('2026-13-01')).toBe('2026-13-01');
    expect(shortName('Baguio (SM City Baguio)')).toBe('Baguio');
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof formatDate(s)).toBe('string');
        expect(typeof shortName(s)).toBe('string');
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('office facts from the DFA', () => {
  it('keep real contact numbers and drop the placeholders', () => {
    expect(officePhone(' (02) 8651-9400 ')).toBe('(02) 8651-9400');
    expect(officePhone('556-0000 / 651-9400')).toBe('556-0000 / 651-9400');
    for (const placeholder of ['0000', '000000000', '', '  ', null, 42]) expect(officePhone(placeholder)).toBeNull();
  });

  it('link only to Google Maps over https', () => {
    for (const url of [
      'https://www.google.com/maps/place/SM+City+Baguio',
      'https://www.google.com.ph/maps/@14.5,121.0,17z',
      'https://maps.app.goo.gl/J4tPkGDgNSjURhQn7',
      'https://goo.gl/maps/abc',
      'https://www.google.com/search?q=dfa+candon',
    ]) {
      expect(officeMapUrl(url)).toBe(new URL(url).href);
    }
    for (const bad of [
      'Level 1, Candon City Arena, Bypass Road, Candon, Ilocos Sur', // an address in the link field
      'http://www.google.com/maps/x',
      'javascript:alert(1)',
      'https://www.google.com.evil.example/maps',
      'https://user@www.google.com/maps',
      'https://www.google.com:8443/maps',
      'https://www.google.com/url?q=https://evil.example',
      'https://goo.gl/abc',
      null,
    ]) {
      expect(officeMapUrl(bad)).toBeNull();
    }
    fc.assert(
      fc.property(fc.oneof(fc.webUrl(), fc.string()), (s) => {
        const url = officeMapUrl(s);
        if (url !== null) expect(url.startsWith('https://')).toBe(true);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('accept only real calendar days', () => {
    expect(isCalendarDate('2026-10-05')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-09-31', '2026-02-29', '2026-13-01', '2026-9-7', '2026-10-05T00:00', 20261005]) {
      expect(isCalendarDate(bad)).toBe(false);
    }
  });
});

describe('response guards', () => {
  const good = {
    checkedAt: '2026-09-27T02:00:00.000Z',
    lastHealthyAt: null,
    healthy: true,
    mailLive: false,
    sites: [{ id: 486, name: 'Antipolo', ok: true, openDates: ['2026-10-05'], publishedDays: 4 }],
  };

  it('accept real answers', () => {
    expect(isStatusResponse(good)).toBe(true);
    const office = { ...good.sites[0], telephone: '(02) 8651-9400', mapUrl: 'https://maps.app.goo.gl/J4tPkGDgNSjURhQn7' };
    expect(isStatusResponse({ ...good, sites: [office] })).toBe(true);
  });

  it.each([
    { ...good, healthy: 'yes' },
    { ...good, sites: [{ ...good.sites[0], id: -1 }] },
    { ...good, sites: [{ ...good.sites[0], openDates: ['soon'] }] },
    { ...good, checkedAt: 'yesterday' },
    { ...good, mailLive: undefined },
    { ...good, sites: [{ ...good.sites[0], openDates: ['2026-09-31'] }] },
    { ...good, sites: [{ ...good.sites[0], mapUrl: 'javascript:alert(1)' }] },
    { ...good, sites: [{ ...good.sites[0], telephone: '0000' }] },
    { ...good, sites: [{ ...good.sites[0], checkedAt: 'earlier' }] },
  ])('reject %j', (v) => {
    expect(isStatusResponse(v)).toBe(false);
  });

  it('never throw', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(() => isStatusResponse(v)).not.toThrow();
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('posts abroad', () => {
  const post = {
    id: 497,
    name: 'PE Copenhagen',
    ok: true,
    openDates: ['2026-10-05'],
    publishedDays: 3,
    regionId: 2,
    region: 'Europe',
    countryId: 62,
    country: 'Denmark',
  };
  const good = { catalogAt: '2026-09-27T02:00:00.000Z', checkedEveryMinutes: 60, posts: [post] };

  it.each([
    ['PE Copenhagen', 'Denmark', 'Copenhagen', 'Philippine Embassy, Denmark', false],
    ['PCG Los Angeles', 'United States of America', 'Los Angeles', 'Philippine Consulate General, United States of America', false],
    ['MECO Taipei', 'Taiwan', 'Taipei', 'Manila Economic and Cultural Office, Taiwan', false],
    ['PE Tokyo - Outreach in Okinawa 2026', 'Japan', 'Okinawa 2026', 'Outreach by the Philippine Embassy in Tokyo, Japan', true],
    ['PE Brussels  - Outreach in Luxembourg', 'Belgium', 'Luxembourg', 'Outreach by the Philippine Embassy in Brussels, Belgium', true],
    ['PE Oslo - Kristiansand Consular Outreach', 'Norway', 'Kristiansand', 'Outreach by the Philippine Embassy in Oslo, Norway', true],
    ['PE Canberra - Outreach Mission - Darwin', 'Australia', 'Darwin', 'Outreach by the Philippine Embassy in Canberra, Australia', true],
    ['PE Moscow - Consular Mission in Vladivostok', 'Russian Federation', 'Vladivostok', 'Outreach by the Philippine Embassy in Moscow, Russian Federation', true],
    ['PE Nairobi - Outreach Mission 01 (For Dar es Salaam, Tanzania)', 'Kenya', 'Dar es Salaam, Tanzania', 'Outreach by the Philippine Embassy in Nairobi, Kenya', true],
    ['PE Riyadh - Outreach Mission 01 Buraidah', 'Saudi Arabia', 'Buraidah', 'Outreach by the Philippine Embassy in Riyadh, Saudi Arabia', true],
    ['Consulate of Somewhere', 'Nowhere', 'Consulate of Somewhere', 'Nowhere', false],
  ])('describe %s', (name, country, place, detail, outreach) => {
    expect(describePost(name, country)).toEqual({ place, detail, outreach });
  });

  it('describe any name without throwing, always naming a place', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.string({ maxLength: 60 }), (name, country) => {
        const d = describePost(name, country);
        expect(typeof d.place).toBe('string');
        expect(typeof d.detail).toBe('string');
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('accept a real answer and refuse broken ones', () => {
    expect(isAbroadResponse(good)).toBe(true);
    expect(isAbroadResponse({ ...good, catalogAt: null, posts: [] })).toBe(true);
    for (const bad of [
      { ...good, checkedEveryMinutes: 0 },
      { ...good, posts: [{ ...post, country: '' }] },
      { ...good, posts: [{ ...post, regionId: 0 }] },
      { ...good, posts: [{ ...post, openDates: ['2026-02-30'] }] },
      { ...good, catalogAt: 'last week' },
    ]) {
      expect(isAbroadResponse(bad)).toBe(false);
    }
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(() => isAbroadResponse(v)).not.toThrow();
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('office answers', () => {
  const dates = { siteId: 486, applicants: 2, openDates: ['2026-10-05'], fullDates: [], windowEnd: null, checkedAt: '2026-09-27T02:00:00.000Z' };
  const times = { siteId: 486, date: '2026-10-05', applicants: 2, checkedAt: '2026-09-27T02:00:00.000Z', slots: [] };
  it('accept only group sizes the DFA offers', () => {
    expect(isOfficeDates(dates)).toBe(true);
    expect(isOfficeTimes(times)).toBe(true);
    for (const applicants of [0, 6, 2.5, LIMITS.maxApplicants + 1]) {
      expect(isOfficeDates({ ...dates, applicants })).toBe(false);
      expect(isOfficeTimes({ ...times, applicants })).toBe(false);
    }
  });
});
