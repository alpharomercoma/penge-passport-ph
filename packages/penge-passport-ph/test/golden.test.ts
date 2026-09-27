// The TypeScript parsers are the reference: this test pins their output for
// every captured fixture and shared edge case in test/fixtures/golden/, and the
// Python suite (packages/python/tests/test_parse.py) must reproduce the same files.
// Regenerate after an intended change with: UPDATE_GOLDEN=1 npx vitest run test/golden.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isIsoDate,
  parseAvailability,
  parseBootstrap,
  parseCountries,
  parseJson,
  parseSites,
  parseTimeSlots,
} from '../src/parse.js';

const dir = new URL('./fixtures/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

function golden(name: string, actual: unknown) {
  const file = new URL(`golden/${name}.json`, dir);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) writeFileSync(file, text);
  expect(text).toBe(readFileSync(file, 'utf8'));
}

function outcome(run: () => unknown) {
  try {
    return { value: run() };
  } catch (err) {
    return { error: (err as Error).name };
  }
}

const PARSERS: Record<string, (input: string) => unknown> = {
  timeSlots: (input) => parseTimeSlots(input),
  bootstrap: (input) => parseBootstrap(input),
  sites: (input) => parseSites(parseJson(input, '/sites'), '/sites'),
  countries: (input) => parseCountries(parseJson(input, '/countries'), '/countries'),
  availability: (input) => parseAvailability(parseJson(input, '/x'), '/x'),
  isIsoDate: (input) => (JSON.parse(input) as string[]).map(isIsoDate),
};

describe('golden parser output (shared with the Python package)', () => {
  it('captured fixtures', () => {
    golden('bootstrap-appointment', parseBootstrap(read('bootstrap-appointment.html')));
    golden('countries-region1', parseCountries(JSON.parse(read('countries-region1.json')), '/countries'));
    golden('sites-region1-country1', parseSites(JSON.parse(read('sites-region1-country1.json')), '/sites'));
    golden('availability-site486', parseAvailability(JSON.parse(read('availability-site486.json')), '/x'));
    golden('timeslot-2026-10-05-site486', parseTimeSlots(read('timeslot-2026-10-05-site486.html')));
    golden('timeslot-2026-10-07-site486-full', parseTimeSlots(read('timeslot-2026-10-07-site486-full.html')));
  });

  it('shared edge cases', () => {
    const { cases } = JSON.parse(read('parse-cases.json')) as {
      cases: { name: string; parser: string; input: string }[];
    };
    golden(
      'parse-cases',
      cases.map((c) => ({ name: c.name, ...outcome(() => PARSERS[c.parser]!(c.input)) })),
    );
  });
});
