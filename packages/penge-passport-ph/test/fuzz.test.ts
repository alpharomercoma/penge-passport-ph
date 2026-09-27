// Property-based fuzzing of everything that reads untrusted input or enforces
// the rate limit. Seeds are fixed so every failure reproduces; raise FUZZ_RUNS
// locally for a longer campaign, e.g. FUZZ_RUNS=20000 npx vitest run test/fuzz.test.ts
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '../src/errors.js';
import {
  isIsoDate,
  parseAvailability,
  parseBootstrap,
  parseCountries,
  parseSites,
  parseTimeSlots,
} from '../src/parse.js';
import { HostGate, LIMITS } from '../src/rate-limit.js';
import { CookieJar } from '../src/session.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 400);
/** Long campaigns need longer than Vitest's default 5 s per test. */
const TIMEOUT = Math.max(20_000, RUNS * 40);
const SEED = 20260927;
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** HTML-ish tokens the time-slot parser keys on, plus hostile ones. */
const HTML_TOKENS = [
  '<label class="col-xs-12">', '<label>', '</label>', '<LABEL>', '<span>', '</span>',
  '<span class="hidden">', '<span class="col-xs-5 text-success">', '<span class="col-xs-5 text-danger">',
  '<input id="TimeSlotID" name="TimeSlotID" type="radio" value="1.0" />', '<input disabled="disabled" type="radio">',
  '<input', '08:30', '8:30', '-', '09:30', '99:99', ' ', '\n', '\r\n', '\t', '\u00a0', '\u2028', '\ufeff',
  'Available Slots: ', 'Slots:', '12', '0', 'Fully Booked', '&amp;', '&nbsp;', '&lt;', '&#65;', '&#x41;',
  '&#99999999;', '&#x110000;', '&#0;', '&#xD800;', '&bogus;', '&', '<', '>', '"', "'", '=', '\u00e9', '\u{1d49c}',
];

const htmlish = fc
  .array(fc.constantFrom(...HTML_TOKENS), { maxLength: 60 })
  .map((parts) => parts.join(''));

/** A real fixture with random splices, to stay close to what the site sends. */
const mutatedFixture = (text: string) =>
  fc
    .array(
      fc.tuple(fc.nat(text.length), fc.nat(40), fc.constantFrom('', ...HTML_TOKENS)),
      { maxLength: 8 },
    )
    .map((edits) =>
      edits.reduce((acc, [at, del, ins]) => acc.slice(0, at) + ins + acc.slice(at + del), text),
    );

const anyText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 300 }),
  htmlish,
  mutatedFixture(fixture('timeslot-2026-10-05-site486.html')),
);

function expectOnlyUpstreamErrors(run: () => unknown) {
  try {
    run();
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
  }
}

vi.setConfig({ testTimeout: TIMEOUT });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-26T05:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('fuzz: parsers never crash and keep their invariants', () => {
  it('parseTimeSlots', () => {
    fc.assert(
      fc.property(anyText, (html) => {
        for (const s of parseTimeSlots(html)) {
          expect(s.start).toMatch(/^\d\d:\d\d$/);
          expect(s.end).toMatch(/^\d\d:\d\d$/);
          expect(s.remaining === null || (Number.isInteger(s.remaining) && s.remaining >= 0)).toBe(true);
          expect(s.status).toBe(s.status.trim());
          expect(s.note === null || (s.note !== '' && s.note === s.note.trim())).toBe(true);
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('parseBootstrap', () => {
    const page = fixture('bootstrap-appointment.html');
    fc.assert(
      fc.property(fc.oneof(anyText, mutatedFixture(page)), (html) => {
        const parsed = parseBootstrap(html);
        if (parsed) {
          expect(parsed.token).not.toBe('');
          for (const d of [parsed.serverToday, parsed.maxDate]) if (d !== null) expect(isIsoDate(d)).toBe(true);
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  const id = fc.oneof(
    fc.integer(),
    fc.double(),
    fc.constantFrom(0, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER + 2, '10', true, null),
  );
  const loose = fc.oneof(fc.string(), fc.constant(null), fc.integer(), fc.boolean());

  it('parseSites and parseCountries only ever throw UpstreamError', () => {
    const site = fc.record(
      { Id: id, Name: loose, Address: loose, Telephone: loose, Timeslots: loose, Description: loose, Url: loose, Timezone: fc.oneof(id, loose) },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.record({ Sites: fc.array(site), Countries: fc.array(site) })), (body) => {
        expectOnlyUpstreamErrors(() => parseSites(body, '/sites'));
        expectOnlyUpstreamErrors(() => parseCountries(body, '/countries'));
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('parseAvailability only ever throws UpstreamError, and returns sorted ISO dates', () => {
    const entry = fc.record(
      {
        IsAvailable: fc.oneof(fc.boolean(), loose),
        AppointmentDate: fc.oneof(
          fc.integer({ min: -8.64e15, max: 8.64e15 }),
          fc.double(),
          fc.constantFrom(1e20, -1e20, 8.64e15 + 1, Number.MAX_VALUE, 1791158400000.5),
          loose,
        ),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.array(entry)), (body) => {
        try {
          const days = parseAvailability(body, '/x');
          const dates = days.map((d) => d.date);
          expect(dates).toEqual([...dates].sort());
          for (const d of dates) expect(isIsoDate(d)).toBe(true);
        } catch (err) {
          if (!(err instanceof UpstreamError)) throw err;
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it('isIsoDate agrees with a calendar reference', () => {
    const reference = (value: string) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!m) return false;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1]!;
    };
    const digits = (n: number) => fc.array(fc.constantFrom(...'0123456789'), { minLength: n, maxLength: n }).map((a) => a.join(''));
    fc.assert(
      fc.property(
        fc.oneof(fc.tuple(digits(4), digits(2), digits(2)).map(([y, m, d]) => `${y}-${m}-${d}`), fc.string()),
        (value) => {
          expect(isIsoDate(value)).toBe(reference(value));
        },
      ),
      { seed: SEED, numRuns: RUNS * 5 },
    );
  });

  it('parsers stay linear on adversarial input (no ReDoS)', () => {
    vi.useRealTimers();
    const n = 50_000;
    const probes = [
      '<label>'.repeat(n),
      `<label>${'<span>'.repeat(n)}`,
      `<label><span>${' '.repeat(n)}8:30${' '.repeat(n)}-`,
      `<label><input${' a'.repeat(n)}`,
      `<span class="${'col-xs-5 '.repeat(n)}`,
      `<input name="__RequestVerificationToken"${' value'.repeat(n)}`,
      `currentDate = ${"'".repeat(n)}`,
      '&#'.repeat(n),
    ];
    for (const probe of probes) {
      const started = performance.now();
      try {
        parseTimeSlots(probe);
        parseBootstrap(probe);
      } catch {
        // Crashes are the other tests' business; this one only times.
      }
      // Linear takes milliseconds; the quadratic versions this guards against took 9 s+.
      expect(performance.now() - started, probe.slice(0, 40)).toBeLessThan(3_000);
    }
  });
});

describe('fuzz: cookie jar', () => {
  it('never throws and never emits a header that breaks the request', () => {
    const line = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 120 }),
      fc
        .tuple(fc.string({ maxLength: 8 }), fc.string({ maxLength: 12 }), fc.array(fc.constantFrom(
          'Path=/', 'HttpOnly', 'Max-Age=0', 'Max-Age=-1', 'Max-Age=abc', 'Max-Age=1e309', 'Max-Age=60',
          'Expires=Sat, 26-Sep-2026 13:59:32 GMT', 'Expires=nonsense', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        ), { maxLength: 3 }))
        .map(([n, v, attrs]) => [`${n}=${v}`, ...attrs].join('; ')),
      // Control characters a hostile server could put in a cookie.
      fc.constantFrom('0=0\r0', 'a=b\nX-Evil: 1', 'a\u0000=b', 'a=\u007f', 'a=b\r\nSet-Cookie: c=d'),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 6 }), (lines) => {
        const jar = new CookieJar();
        const headers = { getSetCookie: () => lines } as unknown as Headers;
        jar.store(headers);
        const header = jar.header();
        // eslint-disable-next-line no-control-regex
        if (header !== undefined) expect(header).not.toMatch(/[\u0000-\u001f\u007f]/);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

describe('fuzz: rate limiter invariants', () => {
  type Step =
    | { kind: 'call'; ok: boolean; retryAfterMs: number | undefined; durationMs: number }
    | { kind: 'burst'; size: number }
    | { kind: 'wait'; ms: number }
    | { kind: 'jump'; ms: number };

  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({
      kind: fc.constant('call' as const),
      ok: fc.boolean(),
      retryAfterMs: fc.option(fc.oneof(fc.nat(10_000_000), fc.constantFrom(0, 1, Infinity, Number.NaN, -5)), { nil: undefined }),
      durationMs: fc.nat(5_000),
    }),
    fc.record({ kind: fc.constant('burst' as const), size: fc.integer({ min: 2, max: 6 }) }),
    fc.record({ kind: fc.constant('wait' as const), ms: fc.nat(4_000_000) }),
    fc.record({ kind: fc.constant('jump' as const), ms: fc.integer({ min: -3_600_000, max: 3_600_000 }) }),
  );

  it('never dispatches closer than the interval, over budget, or after a deadline', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 2_000, max: 10_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.oneof(fc.integer({ min: 0, max: 120_000 }), fc.constant(Number.POSITIVE_INFINITY)),
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (steps, minIntervalMs, maxRequestsPerHour, maxWaitMs, jitter) => {
          vi.setSystemTime(new Date('2026-09-26T05:00:00Z'));
          const gate = new HostGate(() => jitter);
          const opts = { minIntervalMs, maxRequestsPerHour, maxWaitMs };
          // Elapsed time as the site would see it: monotonic, unaffected by jumps.
          let elapsed = 0;
          let wall = Date.now();
          const tick = () => {
            const now = Date.now();
            elapsed += Math.max(0, now - wall);
            wall = now;
            return elapsed;
          };
          const sent: number[] = [];
          const run = (ok: boolean, retryAfterMs: number | undefined, durationMs: number) => {
            const queuedAt = tick();
            return gate
              .run(opts, async (report) => {
                const at = tick();
                sent.push(at);
                if (Number.isFinite(maxWaitMs)) expect(at - queuedAt).toBeLessThanOrEqual(maxWaitMs + 1);
                await new Promise((r) => setTimeout(r, durationMs));
                report({ ok, retryAfterMs });
              })
              .catch((err: Error) => {
                expect(['RateLimitError', 'CircuitOpenError']).toContain(err.name);
              });
          };
          for (const s of steps) {
            if (s.kind === 'call') {
              const p = run(s.ok, s.retryAfterMs, s.durationMs);
              await vi.advanceTimersByTimeAsync(Math.max(maxWaitMs === Infinity ? 4_000_000 : maxWaitMs, 0) + 10_000);
              await p;
            } else if (s.kind === 'burst') {
              const ps = Array.from({ length: s.size }, () => run(true, undefined, 10));
              await vi.advanceTimersByTimeAsync(Math.max(maxWaitMs === Infinity ? 4_000_000 : maxWaitMs, 0) + 60_000);
              await Promise.all(ps);
            } else if (s.kind === 'wait') {
              await vi.advanceTimersByTimeAsync(s.ms);
              tick();
            } else {
              tick();
              vi.setSystemTime(Date.now() + s.ms); // the wall clock jumps; elapsed time does not
              wall = Date.now();
            }
          }
          for (let i = 1; i < sent.length; i++) {
            expect(sent[i]! - sent[i - 1]!).toBeGreaterThanOrEqual(minIntervalMs - 1);
          }
          for (let i = 0; i < sent.length; i++) {
            const inHour = sent.filter((t) => t > sent[i]! - 3_600_000 && t <= sent[i]!).length;
            expect(inHour).toBeLessThanOrEqual(maxRequestsPerHour);
          }
        },
      ),
      // Each run simulates hours of fake time; a few hundred schedules is plenty.
      { seed: SEED, numRuns: Math.min(400, Math.max(50, Math.floor(RUNS / 4))) },
    );
  });

  it('keeps the circuit and backoff within their documented bounds', () => {
    expect(LIMITS.backoffMaxMs).toBeLessThan(2 ** 31 - 1);
    expect(LIMITS.retryAfterMaxMs + LIMITS.circuitOpenMs).toBeLessThan(2 ** 31 - 1);
  });
});
