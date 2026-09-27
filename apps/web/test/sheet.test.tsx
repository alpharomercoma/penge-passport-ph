import { LIMITS, validateSubscribe } from '@penge/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fc from 'fast-check';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, type Api } from '../src/api.ts';
import { AlertSheet } from '../src/components/AlertSheet.tsx';
import { toAbroadOffices, toOffices } from '../src/office.ts';
import { ABROAD, fakeApi, STATUS } from './helpers.tsx';

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
const OFFICES = toOffices(STATUS.sites);
const KNOWN = new Set(OFFICES.map((o) => o.id));

afterEach(cleanup);

function Harness({ api, initial = [], onClose = () => {} }: { api: Api; initial?: number[]; onClose?: () => void }) {
  const [selected, setSelected] = useState<number[]>(initial);
  return <AlertSheet api={api} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={onClose} />;
}

function open(api = fakeApi(), initial: number[] = [], onClose = vi.fn()) {
  render(<Harness api={api} initial={initial} onClose={onClose} />);
  const sheet = screen.getByRole('dialog');
  return {
    api,
    onClose,
    sheet,
    email: within(sheet).getByLabelText('Your email') as HTMLInputElement,
    people: within(sheet).getByLabelText('Booking for') as HTMLSelectElement,
    honeypot: sheet.querySelector('input[name="website"]') as HTMLInputElement,
    boxes: () => within(sheet).queryAllByRole('checkbox') as HTMLInputElement[],
    submit: within(sheet).getByRole('button', { name: /Send confirmation email/ }),
  };
}

describe('alert sheet', () => {
  it('narrows the office picker by area, and abroad, as well as by search', async () => {
    const offices = [...OFFICES, ...toAbroadOffices(ABROAD.posts)];
    function Both() {
      const [selected, setSelected] = useState<number[]>([]);
      return <AlertSheet api={fakeApi()} offices={offices} selected={selected} onSelectedChange={setSelected} onClose={() => {}} />;
    }
    render(<Both />);
    const sheet = screen.getByRole('dialog');
    const places = () => [...sheet.querySelectorAll('.pick-place')].map((e) => e.textContent);
    const chips = within(within(sheet).getByRole('group', { name: 'Area' })).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['NCR', 'Luzon', 'Visayas', 'Mindanao', 'Abroad']);
    // Everything, home first, then posts abroad by country.
    expect(places().at(-1)).toBe('Dubai');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Mindanao' }));
    expect(places()).toEqual(['Davao', 'Zamboanga']);

    fireEvent.click(within(sheet).getByRole('button', { name: 'Abroad' }));
    expect(places()).toEqual(['Copenhagen', 'Okinawa 2026', 'Tokyo', 'Dubai']);
    fireEvent.change(within(sheet).getByPlaceholderText(/Search a city/), { target: { value: 'japan' } });
    expect(places()).toEqual(['Okinawa 2026', 'Tokyo']);
    fireEvent.change(within(sheet).getByPlaceholderText(/Search a city/), { target: { value: 'cebu' } });
    expect(within(sheet).getByText('No office matches “cebu” abroad.')).toBeTruthy();

    // Tapping the chosen area again shows every office.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Abroad' }));
    expect(places()).toEqual(['Cebu']);
  });


  it('sends a valid request and shows the server message', async () => {
    const s = open(fakeApi(), [486]);
    fireEvent.change(s.email, { target: { value: ' Juan@Example.com ' } });
    fireEvent.change(s.people, { target: { value: '3' } });
    fireEvent.click(s.submit);
    await screen.findByText('Check your inbox for a confirmation link.');
    expect(s.api.subscribe).toHaveBeenCalledWith({ email: 'juan@example.com', siteIds: [486], applicants: 3, website: '' });
  });

  it('says, at the email field, how the address is kept', () => {
    const s = open(fakeApi(), [486]);
    const describedBy = () => (s.email.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(describedBy()).toEqual(['Our database and backups keep your address encrypted, and we use it only for these alerts. Unsubscribing deletes it; the last copies, in backups and mail-server logs, are gone within 14 days.']);
    fireEvent.click(s.submit); // no address yet: the error is read out along with the notice
    expect(describedBy()[0]).toMatch(/^Our database and backups keep your address encrypted/);
    expect(describedBy()[1]).toMatch(/Enter a valid email address/);
  });

  it('opens the office picker when nothing is chosen yet, and focuses its search', () => {
    const s = open();
    expect(s.boxes()).toHaveLength(OFFICES.length);
    expect(document.activeElement).toBe(within(s.sheet).getByRole('searchbox'));
  });

  it('explains what is missing instead of sending', () => {
    const s = open();
    fireEvent.click(s.submit);
    expect(within(s.sheet).getByText('Choose at least one site.')).toBeTruthy();
    expect(within(s.sheet).getByText(/Enter a valid email address/)).toBeTruthy();
    expect(s.api.subscribe).not.toHaveBeenCalled();
  });

  it('shows what the server says is wrong', async () => {
    const api = fakeApi({
      subscribe: async () => {
        throw new ApiFailure('Please fix the highlighted fields.', 400, { email: 'The server does not like this one.' });
      },
    });
    const s = open(api, [10]);
    fireEvent.change(s.email, { target: { value: 'a@b.co' } });
    fireEvent.click(s.submit);
    await screen.findByText('The server does not like this one.');
    expect(within(s.sheet).getByRole('alert').textContent).toBe('Please fix the highlighted fields.');
  });

  it(`never holds more than ${LIMITS.sitesPerSubscription} offices, and says why`, () => {
    const s = open();
    for (const box of s.boxes()) fireEvent.click(box);
    expect(s.boxes().filter((b) => b.checked)).toHaveLength(LIMITS.sitesPerSubscription);
    expect(within(s.sheet).getByText(/Remove one to add another/)).toBeTruthy();
    // No control is ever disabled: every one of them answers a tap.
    expect(s.sheet.querySelectorAll(':disabled')).toHaveLength(0);
  });

  it('closes on Escape and on the close button', () => {
    const s = open();
    fireEvent.keyDown(s.sheet, { key: 'Escape' });
    expect(s.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(s.sheet).getByRole('button', { name: 'Close' }));
    expect(s.onClose).toHaveBeenCalledTimes(2);
  });

  it('fuzz: sends exactly what the shared rules accept, and nothing otherwise', async () => {
    const email = fc.oneof(
      fc.string({ maxLength: 80 }),
      fc.emailAddress(),
      fc.tuple(fc.string({ unit: fc.constantFrom(...'aZ9.+_-@ \t\n"<>é'), maxLength: 30 }), fc.constantFrom('@example.com', '@b.co', '', '@x')).map(([a, b]) => a + b),
    );
    await fc.assert(
      fc.asyncProperty(
        email,
        fc.array(fc.nat({ max: OFFICES.length - 1 }), { maxLength: 30 }),
        fc.integer({ min: 1, max: LIMITS.maxApplicants }),
        fc.oneof(fc.constant(''), fc.constant(''), fc.string({ minLength: 1, maxLength: 20 })),
        async (typed, clicks, applicants, website) => {
          cleanup();
          const s = open();
          fireEvent.change(s.email, { target: { value: typed } });
          for (const i of clicks) fireEvent.click(s.boxes()[i]!);
          fireEvent.change(s.people, { target: { value: String(applicants) } });
          fireEvent.change(s.honeypot, { target: { value: website } });

          const boxes = s.boxes();
          const places = [...OFFICES].sort((a, b) => a.place.localeCompare(b.place));
          const chosen = boxes.flatMap((b, i) => (b.checked ? [places[i]!.id] : []));
          expect(chosen.length).toBeLessThanOrEqual(LIMITS.sitesPerSubscription);
          const expected = validateSubscribe({ email: s.email.value, siteIds: chosen, applicants, website }, KNOWN);

          fireEvent.click(s.submit);
          if (expected.ok) {
            await waitFor(() => expect(s.api.subscribe).toHaveBeenCalledTimes(1));
            const sent = s.api.subscribe.mock.calls[0]![0];
            expect(sent).toEqual({ ...expected.value, website });
            expect(validateSubscribe(sent, KNOWN).ok).toBe(true);
          } else {
            expect(s.api.subscribe).not.toHaveBeenCalled();
            expect(s.sheet.querySelectorAll('.error').length).toBeGreaterThan(0);
          }
        },
      ),
      { seed: 20260927, numRuns: RUNS },
    );
  }, 20_000 + RUNS * 400);
});
