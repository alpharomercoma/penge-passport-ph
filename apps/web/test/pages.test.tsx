import { isStatusResponse, type StatusResponse } from '@penge/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fc from 'fast-check';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, api } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { fakeApi, STATUS } from './helpers.tsx';

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** jsdom does not scroll; this records what the page asked to bring into view. */
const scrolled = () => {
  const spy = vi.fn();
  Element.prototype.scrollIntoView = spy;
  return spy;
};

const SUMMARY = /DFA offices in the Philippines have open dates for one person/;

const visit = (path: string) => window.history.replaceState(null, '', path);

/** The office list pane (the calendar pane has its own buttons with the same names). */
const inList = async () => within((await screen.findAllByRole('region', { name: 'Offices, soonest date first' }))[0]!);

describe('home', () => {
  beforeEach(() => {
    visit('/');
    window.localStorage.clear();
  });

  it('lists every office, soonest date first', async () => {
    render(<App path="/" api={fakeApi()} />);
    expect((await screen.findByText(SUMMARY)).textContent).toMatch(/^2 of 12 DFA offices in the Philippines have open dates for one person\. Updated 5 minutes ago\.$/);
    const places = [...document.querySelectorAll('.pane-offices .row-place')].map((e) => e.textContent);
    expect(places.slice(0, 2)).toEqual(['Antipolo', 'Baguio']);
    expect(screen.getAllByText('Wed 7 Oct')[0]).toBeTruthy();
    expect(screen.getByText('2 open days')).toBeTruthy();
  });

  it('filters by area', async () => {
    render(<App path="/" api={fakeApi()} />);
    await screen.findByText(SUMMARY);
    const visayas = screen.getByRole('button', { name: 'Visayas' });
    fireEvent.click(visayas);
    const places = [...document.querySelectorAll('.pane-offices .row-place')].map((e) => e.textContent);
    expect(places.sort()).toEqual(['Cebu', 'Iloilo']);
    // Tapping the chosen area again shows every office.
    fireEvent.click(visayas);
    expect(visayas.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelectorAll('.pane-offices .row-place')).toHaveLength(12);
  });

  it('opens an office with what the DFA shows for it, a calendar, and the hours of a day', async () => {
    const api = fakeApi();
    const scroll = scrolled();
    render(<App path="/" api={api} />);
    fireEvent.click((await inList()).getByRole('button', { name: /^Antipolo/ }));
    expect(window.location.search).toBe('?office=486');
    expect(screen.getByRole('heading', { level: 1, name: 'Antipolo' })).toBeTruthy();
    expect(document.title).toBe('Antipolo: passport appointment dates | PengePassportPH');
    expect(screen.queryByText(SUMMARY)).toBeNull(); // the page header of all offices is not repeated
    expect(screen.getByText('SM Center Antipolo, Sumulong Highway, Antipolo City')).toBeTruthy();
    expect(screen.getByText('(02) 8651-9400')).toBeTruthy();
    expect(screen.getByRole('link', { name: /View map/ }).getAttribute('href')).toBe('https://maps.app.goo.gl/J4tPkGDgNSjURhQn7');
    // The page shows the last scan at once, then the fresh answer.
    expect(await screen.findByText(/^2 open days, the first on Wed 7 Oct\. Checked just now\.$/)).toBeTruthy();
    expect(api.officeDates).toHaveBeenCalledWith(486, 1);
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Wed 7 Oct 2026: open, show the hours' }));
    expect(await screen.findByText('1 left')).toBeTruthy();
    // The answer to the tap is brought into view, and read out.
    expect(scroll.mock.contexts.at(-1)).toBe(document.querySelector('.times'));
    expect(screen.getByText('Wed 7 Oct 2026: 2 of 3 hours open.')).toBeTruthy();
    expect(screen.getByText('11:00 AM to 12:00 PM').closest('li')!.textContent).toContain('Full');
    expect(api.officeTimes).toHaveBeenCalledWith(486, '2026-10-07', 1);
    expect(screen.getByRole('link', { name: /Book on passport.gov.ph/ }).getAttribute('href')).toBe('https://passport.gov.ph/appointment');
    fireEvent.click(screen.getByRole('button', { name: /All offices/ }));
    expect(window.location.search).toBe('');
  });

  it('shows the last scan, labelled with its age, when a fresh look fails', async () => {
    const api = fakeApi({
      officeDates: vi.fn(async () => {
        throw new ApiFailure('We can’t reach passport.gov.ph for this right now. Try again in a few minutes.', 503);
      }),
    });
    render(<App path="/" api={api} />);
    fireEvent.click((await inList()).getByRole('button', { name: /^Antipolo/ }));
    await waitFor(() => expect(api.officeDates).toHaveBeenCalled());
    expect(await screen.findByText(/^2 open days, the first on Wed 7 Oct\. Checked 5 minutes ago\.$/)).toBeTruthy();
  });

  it('turns a day grey, and says why, when its live hours are all full', async () => {
    const api = fakeApi({
      officeTimes: vi.fn(async (siteId: number, date: string, applicants: number) => ({
        siteId,
        date,
        applicants,
        checkedAt: new Date().toISOString(),
        slots: [
          { start: '08:00', end: '09:00', available: false, remaining: null },
          { start: '09:00', end: '10:00', available: false, remaining: null },
        ],
      })),
    });
    render(<App path="/" api={api} />);
    fireEvent.click((await inList()).getByRole('button', { name: /^Antipolo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Wed 7 Oct 2026: open, show the hours' }));
    expect(await screen.findByText(/^Every hour is full now\. It was open when we checked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wed 7 Oct 2026: open, show the hours' })).toBeNull();
    expect(document.querySelector('.day.is-full.is-selected')!.textContent).toBe('7Full');
    expect(screen.getByText(/^1 open day, the first on Fri 9 Oct\. Checked/)).toBeTruthy();
  });

  it('checks dates for a group separately', async () => {
    const api = fakeApi();
    render(<App path="/" api={api} />);
    fireEvent.click((await inList()).getByRole('button', { name: /^Antipolo/ }));
    const people = screen.getByLabelText('Booking for') as HTMLSelectElement;
    // The DFA books one person, or a group of 2 to 5.
    expect([...people.options].map((o) => o.textContent)).toEqual(['Just me', '2 people', '3 people', '4 people', '5 people']);
    fireEvent.change(people, { target: { value: '4' } });
    expect(await screen.findByText(/^1 open day for 4 people, the first on Fri 9 Oct\. Checked just now\.$/)).toBeTruthy();
    expect(api.officeDates).toHaveBeenCalledWith(486, 4);
    // The group size stays while moving to another office.
    fireEvent.click(screen.getByRole('button', { name: /All offices/ }));
    fireEvent.click((await inList()).getByRole('button', { name: /^Baguio/ }));
    expect((screen.getByLabelText('Booking for') as HTMLSelectElement).value).toBe('4');
    await waitFor(() => expect(api.officeDates).toHaveBeenCalledWith(693, 4));
  });

  it('for a full office, says when dates usually appear and where else is open nearby', async () => {
    render(<App path="/" api={fakeApi()} />);
    fireEvent.click((await inList()).getByRole('button', { name: /^Angeles/ }));
    expect(await screen.findByText(/^No open dates\. Checked (just now|\d+ minutes? ago)\.$/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /View map/ })).toBeNull();
    expect(screen.getByText(/usually released around 12 noon and 9 PM/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open elsewhere in Luzon' })).toBeTruthy();
    // What can be done comes before the full calendar, and the alert is the main action.
    const alert = screen.getByRole('button', { name: /Email me when dates open here/ });
    expect(alert.className).toContain('btn-primary');
    expect(screen.getByRole('link', { name: /Book on passport.gov.ph/ }).className).toContain('btn-secondary');
    expect(alert.compareDocumentPosition(document.querySelector('.calendar')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Antipolo/ })).toBeTruthy();
  });

  it('uses the calendar to narrow the one office list to a day, without repeating it', async () => {
    const scroll = scrolled();
    render(<App path="/" api={fakeApi()} />);
    await screen.findByText(SUMMARY);
    fireEvent.click(screen.getByRole('button', { name: 'By date' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tue 20 Oct 2026: open at 1 office, show them' }));
    expect(screen.getByRole('button', { name: 'By office' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Open on Tue 20 Oct: 1 office');
    expect(scroll.mock.contexts.at(-1)).toBe(document.querySelector('.list-head'));
    const places = [...document.querySelectorAll('.row-place')].map((e) => e.textContent);
    expect(places).toEqual(['Baguio']); // one list only: the calendar pane adds no second list
    fireEvent.click((await inList()).getByRole('button', { name: /^Baguio/ }));
    expect(window.location.search).toBe('?office=693&date=2026-10-20');
  });

  it('shows the chosen day on each office, and visibly shows every office again on "Show all"', async () => {
    render(<App path="/" api={fakeApi()} />);
    await screen.findByText(SUMMARY);
    const head = () => document.querySelector('.list-head')!.textContent;
    expect(head()).toBe('All 12 offices, soonest date first');
    // Antipolo is open on the 7th and the 9th: narrowed to the 9th, its row says the 9th.
    fireEvent.click(screen.getByRole('button', { name: 'Fri 9 Oct 2026: open at 1 office, show them' }));
    expect(document.querySelectorAll('.row-place')).toHaveLength(1);
    expect(document.querySelector('.pane-offices .row-date')!.textContent).toBe('Fri 9 Oct');
    expect(head()).toContain('Open on Fri 9 Oct: 1 office');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(document.querySelectorAll('.row-place')).toHaveLength(12);
    expect(document.querySelector('.pane-offices .row-date')!.textContent).toBe('Wed 7 Oct'); // its soonest again
    expect(head()).toBe('All 12 offices, soonest date first');
    expect(document.querySelector('.pane-dates button.day[aria-pressed="true"]')).toBeNull();
    // Narrowed by area, the header says how many of all.
    fireEvent.click(screen.getByRole('button', { name: 'Visayas' }));
    expect(head()).toBe('2 of 12 offices, soonest date first');
  });

  it('says so when a date from a link is no longer open', async () => {
    visit('/?office=486&date=2026-10-08');
    render(<App path="/" api={fakeApi()} />);
    expect(await screen.findByText(/Thu 8 Oct 2026 is no longer open \(checked just now\)\. The green days still are\./)).toBeTruthy();
  });

  it('opens straight to an office and day from a shared link', async () => {
    visit('/?office=486&date=2026-10-09');
    const api = fakeApi();
    const scroll = scrolled();
    render(<App path="/" api={api} />);
    expect(await screen.findByRole('heading', { name: 'Antipolo' })).toBeTruthy();
    await waitFor(() => expect(api.officeTimes).toHaveBeenCalledWith(486, '2026-10-09', 1));
    // The day picked before the office opened shows its hours without another tap.
    expect(await screen.findByText('1 left')).toBeTruthy();
    expect(scroll.mock.contexts.at(-1)).toBe(document.querySelector('.times'));
  });

  it('offers email alerts for an office, with its group size', async () => {
    render(<App path="/" api={fakeApi()} />);
    fireEvent.click((await inList()).getByRole('button', { name: /^Antipolo/ }));
    fireEvent.change(screen.getByLabelText('Booking for'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Email me when dates open here/ }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Remove Antipolo' })).toBeTruthy();
    expect((within(sheet).getByLabelText('Booking for') as HTMLSelectElement).value).toBe('3');
  });

  it('shows no email controls, and nothing disabled, while email is off', async () => {
    render(<App path="/" api={fakeApi({ status: async () => ({ ...STATUS, mailLive: false }) })} />);
    fireEvent.click((await inList()).getByRole('button', { name: /^Antipolo/ }));
    expect(screen.queryByRole('button', { name: /Email/ })).toBeNull();
    expect(document.querySelectorAll(':disabled')).toHaveLength(0);
  });

  it('shows what was last known about an office whose latest check failed, and when', async () => {
    const earlier = new Date(Date.now() - 32 * 60_000).toISOString();
    const sites = STATUS.sites.map((x) =>
      x.id === 486 ? { ...x, ok: false, checkedAt: earlier } : x.id === 693 ? { ...x, ok: false } : x,
    );
    render(<App path="/" api={fakeApi({ status: async () => ({ ...STATUS, sites }) })} />);
    const list = await inList();
    const antipolo = list.getByRole('button', { name: /^Antipolo/ });
    expect(antipolo.textContent).toContain('Wed 7 Oct');
    expect(antipolo.textContent).toContain('Checked 32 minutes ago');
    expect(antipolo.textContent).not.toContain('Couldn’t check');
    // Nothing known about it with a time: say so rather than guess.
    expect(list.getByRole('button', { name: /^Baguio/ }).textContent).toContain('Couldn’t check');
    // Neither counts as open now, on the summary or the calendar.
    expect(screen.getByText(SUMMARY).textContent).toMatch(/^0 of 12 /);
    expect(screen.queryByRole('button', { name: /Wed 7 Oct 2026: open at/ })).toBeNull();
  });

  it('keeps counting how old the dates are while the server cannot be reached', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      let calls = 0;
      const status = vi.fn(async () => {
        if (calls++ === 0) return { ...STATUS, lastHealthyAt: new Date(Date.now() - 5 * 60_000).toISOString() };
        throw new ApiFailure('We could not reach the server. Check your connection and try again.', 0);
      });
      render(<App path="/" api={fakeApi({ status })} />);
      expect((await screen.findByText(SUMMARY)).textContent).toContain('Updated 5 minutes ago');
      await act(async () => {
        vi.advanceTimersByTime(60_000); // the first refresh fails, and says so
      });
      expect(screen.getByText(SUMMARY).textContent).toContain('Updated 6 minutes ago');
      await act(async () => {
        vi.advanceTimersByTime(2 * 60_000); // more failures: nothing new to show, but time goes on
      });
      expect(screen.getByText(SUMMARY).textContent).toContain('Updated 8 minutes ago');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a link to a day that does not exist', async () => {
    visit('/?office=486&date=2026-02-31');
    const api = fakeApi();
    render(<App path="/" api={api} />);
    expect(await screen.findByRole('heading', { name: 'Antipolo' })).toBeTruthy();
    await waitFor(() => expect(api.officeDates).toHaveBeenCalled());
    expect(api.officeTimes).not.toHaveBeenCalled();
  });

  it('says when the last check failed', async () => {
    render(<App path="/" api={fakeApi({ status: async () => ({ ...STATUS, healthy: false }) })} />);
    expect(await screen.findByText(/latest check ran into problems/)).toBeTruthy();
  });

  it('explains an outage and offers to try again', async () => {
    let fail = true;
    const status = vi.fn(async () => {
      if (fail) throw new ApiFailure('We could not reach the server. Check your connection and try again.', 0);
      return STATUS;
    });
    render(<App path="/" api={fakeApi({ status })} />);
    expect(await screen.findByText(/could not reach the server/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(SUMMARY)).toBeTruthy();
  });

  it('fuzz: renders any valid status and survives any tap, treating office names as text', async () => {
    const date = fc.date({ min: new Date('2026-01-01'), max: new Date('2027-12-31'), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10));
    const site = fc.record({
      id: fc.integer({ min: 1, max: 100_000 }),
      name: fc.oneof(fc.string({ minLength: 1, maxLength: 60 }), fc.constant('<img src=x onerror=boom>'), fc.constant('<img src=x onerror=alert(1)>'), fc.constant('X (<b>y</b>)')),
      address: fc.option(fc.string({ maxLength: 80 }), { nil: null }),
      telephone: fc.option(fc.constantFrom('(02) 8651-9400', '0917 845 7137'), { nil: null }),
      mapUrl: fc.option(fc.constantFrom('https://maps.app.goo.gl/J4tPkGDgNSjURhQn7', 'https://www.google.com/maps/place/x'), { nil: null }),
      ok: fc.boolean(),
      openDates: fc.uniqueArray(date, { maxLength: 6 }),
      fullDates: fc.uniqueArray(date, { maxLength: 6 }),
      windowEnd: fc.option(date, { nil: null }),
      publishedDays: fc.nat({ max: 90 }),
    });
    const iso = fc.date({ min: new Date('2026-01-01'), max: new Date('2027-01-01'), noInvalidDate: true }).map((d) => d.toISOString());
    const status = fc.record({
      checkedAt: fc.option(iso, { nil: null }),
      lastHealthyAt: fc.option(iso, { nil: null }),
      healthy: fc.boolean(),
      mailLive: fc.boolean(),
      sites: fc.uniqueArray(site, { selector: (s) => s.id, maxLength: 12 }),
      push: fc.constant('off' as const),
      vapidPublicKey: fc.constant(null),
    });
    await fc.assert(
      fc.asyncProperty(status, fc.nat({ max: 20 }), fc.nat({ max: 40 }), async (s: StatusResponse, pickRow, pickDay) => {
        cleanup();
        visit('/');
        expect(isStatusResponse(s)).toBe(true);
        const { container } = render(<App path="/" api={fakeApi({ status: async () => s })} />);
        await waitFor(() => expect(screen.queryByText('Loading the dates…')).toBeNull());
        const rows = container.querySelectorAll<HTMLButtonElement>('.pane-offices .row');
        if (rows.length) {
          fireEvent.click(rows[pickRow % rows.length]!);
          const days = container.querySelectorAll<HTMLButtonElement>('button.day');
          if (days.length) fireEvent.click(days[pickDay % days.length]!);
          const next = container.querySelector<HTMLButtonElement>('.month-nav.next');
          if (next) fireEvent.click(next);
        }
        expect(container.querySelector('img[onerror]')).toBeNull();
        expect(container.querySelector('b')).toBeNull();
      }),
      { seed: 20260927, numRuns: RUNS },
    );
  }, 20_000 + RUNS * 400);
});

describe('posts abroad', () => {
  beforeEach(() => {
    visit('/');
    window.localStorage.clear();
  });

  const inAbroadList = async () => within((await screen.findAllByRole('region', { name: 'Posts abroad, by country' }))[0]!);

  it('loads posts abroad only when asked, and lists them by country under the DFA\'s regions', async () => {
    const api = fakeApi();
    render(<App path="/" api={api} />);
    await screen.findByText(SUMMARY);
    expect(api.abroad).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Abroad' }));
    const list = await inAbroadList();
    expect(api.abroad).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('?in=abroad');
    expect(document.querySelector('.summary')!.textContent).toMatch(/^2 of 4 posts abroad have open dates for one person\. Each is checked about every 60 minutes/);
    expect([...document.querySelectorAll('.pane-offices .country-name')].map((e) => e.textContent)).toEqual(['Denmark', 'Japan', 'United Arab Emirates']);
    const copenhagen = within(list.getByRole('button', { name: /^Copenhagen/ }));
    // Under the Denmark heading, the row need not name Denmark again.
    expect(copenhagen.getByText('Philippine Embassy')).toBeTruthy();
    expect(copenhagen.getByText('No dates yet')).toBeTruthy();
    const okinawa = within(list.getByRole('button', { name: /^Okinawa 2026/ }));
    expect(okinawa.getByText('Outreach by the Philippine Embassy in Tokyo')).toBeTruthy();
    expect(okinawa.getByText('Not checked yet')).toBeTruthy();
    expect(list.getByText('All 4 posts, by country')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'By post' })).toBeTruthy();
    // The regions are the DFA's, and only those with posts are offered.
    const chips = within(screen.getByRole('group', { name: 'Region' })).getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(['Asia Pacific', 'Europe', 'Middle East/Africa']);
    fireEvent.click(screen.getByRole('button', { name: 'Europe' }));
    expect([...document.querySelectorAll('.pane-offices .row-place')].map((e) => e.textContent)).toEqual(['Copenhagen']);
    // And back home.
    fireEvent.click(screen.getByRole('button', { name: 'Philippines' }));
    expect(await screen.findByText(SUMMARY)).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('opens a post like an office, and says when posts abroad release dates', async () => {
    const api = fakeApi();
    visit('/?in=abroad');
    render(<App path="/" api={api} />);
    fireEvent.click((await inAbroadList()).getByRole('button', { name: /^Copenhagen/ }));
    expect(await screen.findByRole('heading', { name: 'Copenhagen' })).toBeTruthy();
    expect(screen.getByText('Philippine Embassy, Denmark')).toBeTruthy();
    expect(screen.getByText('Arne Jacobsens Alle 13, 1st Floor, 2300 Copenhagen')).toBeTruthy();
    expect(await screen.findByText(/Each post releases dates on its own schedule/)).toBeTruthy();
    expect(window.location.search).toBe('?in=abroad&office=497');
    fireEvent.click(screen.getByRole('button', { name: 'All posts abroad' }));
    expect(await inAbroadList()).toBeTruthy();
    expect(window.location.search).toBe('?in=abroad');
  });

  it('opens a post straight from a shared link', async () => {
    visit('/?office=36&date=2026-10-07');
    const api = fakeApi();
    render(<App path="/" api={api} />);
    expect(await screen.findByRole('heading', { name: 'Dubai' })).toBeTruthy();
    await waitFor(() => expect(api.officeTimes).toHaveBeenCalledWith(36, '2026-10-07', 1));
  });

  it('offers posts abroad in the alert form, found by country', async () => {
    const api = fakeApi();
    render(<App path="/" api={api} />);
    await screen.findByText(SUMMARY);
    fireEvent.click(screen.getByRole('button', { name: /Email alerts/ }));
    const sheet = screen.getByRole('dialog');
    fireEvent.change(await within(sheet).findByPlaceholderText(/Search a city/), { target: { value: 'emirates' } });
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: /Dubai/ }));
    expect(within(sheet).getByRole('button', { name: 'Remove Dubai' })).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText('Your email'), { target: { value: 'ana@example.com' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send confirmation email' }));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalledWith({ email: 'ana@example.com', siteIds: [36], applicants: 1, pace: 'hourly', channels: { emailOn: true, pushOn: false, pushCredentialHash: null, device: null }, website: '' }));
  });

  it('explains when posts abroad cannot be loaded, and offers to try again', async () => {
    const api = fakeApi({ abroad: vi.fn(async () => Promise.reject(new ApiFailure('The server did not answer.', 503))) as never });
    visit('/?in=abroad');
    render(<App path="/" api={api} />);
    expect(await screen.findByText(/Dates can’t be loaded right now\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.abroad).toHaveBeenCalledTimes(2));
  });
});

describe('confirm and unsubscribe pages', () => {
  const token = 'a'.repeat(43);
  const unsub = `${'s'.repeat(22)}.${'b'.repeat(43)}`;

  it('confirms only on the button press, then clears the token from the address bar', async () => {
    visit(`/confirm#token=${token}`);
    const fake = fakeApi();
    render(<App path="/confirm" api={fake} />);
    expect(window.location.hash).toBe('');
    expect(fake.confirm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText('We will email you when a date opens at 1 office, for one person, at most once an hour.')).toBeTruthy();
    expect(fake.confirm).toHaveBeenCalledWith(token, undefined);
  });

  it('explains an expired link', async () => {
    visit(`/confirm#token=${token}`);
    const fake = fakeApi({
      confirm: async () => {
        throw new ApiFailure('That link has expired or was already used. Subscribe again to get a new one.', 404);
      },
    });
    render(<App path="/confirm" api={fake} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
  });

  it.each(['', '#token=short', '#token=' + 'a'.repeat(44), '#x=1', `#token=${'a'.repeat(42)}!`])('refuses a broken link %j', (hash) => {
    visit(`/confirm${hash}`);
    const fake = fakeApi();
    render(<App path="/confirm" api={fake} />);
    expect(screen.getByText(/This link is incomplete/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('unsubscribes on the button press', async () => {
    visit(`/unsubscribe#token=${unsub}`);
    const fake = fakeApi();
    render(<App path="/unsubscribe" api={fake} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText(/Your address is deleted/)).toBeTruthy();
    expect(fake.unsubscribe).toHaveBeenCalledWith(unsub);
  });

  it('shows a not-found page for anything else', () => {
    render(<App path="/admin" api={fakeApi()} />);
    expect(screen.getByText('This page does not exist')).toBeTruthy();
  });
});

describe('privacy page', () => {
  it('says what is kept, for how long, without calling the API', () => {
    visit('/privacy');
    const fake = fakeApi();
    render(<App path="/privacy" api={fake} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy' })).toBeTruthy();
    const sections = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(sections).toEqual(['If you only look at dates', 'If you sign up for email alerts', 'Notifications', 'Deleting your address', 'Where it is kept', 'Changes and questions']);
    expect(screen.getByText(/not run by or affiliated with the Department of Foreign Affairs\. This page covers the website and the Android app/)).toBeTruthy();
    // The same promise as the sign-up form and the unsubscribe page.
    expect(screen.getByText(/The last copies, in the backups and the mail server's logs, are gone within 14 days\./)).toBeTruthy();
    expect(screen.getByText(/never sell or share them/)).toBeTruthy();
    expect(screen.getByText(/The only counting is done on our server/)).toBeTruthy();
    expect(screen.getByText(/The offices you choose for alerts are remembered in your browser, on your device, and reach us only when you sign up\./)).toBeTruthy();
    expect(document.title).toBe('Privacy | PengePassportPH');
    for (const fn of Object.values(fake)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
  });

  it('explains notifications: what is kept, who carries them, how to stop them, and for how long', async () => {
    visit('/privacy');
    render(<App path="/privacy" api={fakeApi()} />);
    const text = document.body.textContent!;
    expect(text).toMatch(/push subscription/i);
    expect(text).toMatch(/Google/);
    expect(text).toMatch(/Mozilla/);
    expect(text).toMatch(/Apple/);
    expect(text).toMatch(/encrypted/i);
    expect(text).toMatch(/Turn off/);
    expect(text).toMatch(/not (kept )?in (our )?backups/i);
  });

  it.each(['/privacy', '/confirm', '/unsubscribe', '/nope'])('is linked from the footer on %s', (path) => {
    visit(path);
    render(<App path={path} api={fakeApi()} />);
    const footer = within(document.querySelector<HTMLElement>('.site-footer')!);
    expect(footer.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
  });

  it('is linked from the footer on the home page', async () => {
    visit('/');
    render(<App path="/" api={fakeApi()} />);
    await screen.findByText(SUMMARY);
    const footer = within(document.querySelector<HTMLElement>('.site-footer')!);
    expect(footer.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
  });
});

describe('API client', () => {
  it('fuzz: returns checked data or a readable ApiFailure, whatever the server sends', async () => {
    const body = fc.oneof(
      fc.json(),
      fc.string(),
      fc.constant(JSON.stringify(STATUS)),
      fc.anything().map((v) => {
        try {
          return JSON.stringify(v) ?? 'null';
        } catch {
          return 'null';
        }
      }),
      fc.record({ error: fc.anything(), fields: fc.anything() }).map((v) => JSON.stringify(v) ?? '{}'),
    );
    const status = fc.constantFrom(200, 202, 400, 404, 413, 429, 500, 502, 503);
    await fc.assert(
      fc.asyncProperty(body, status, fc.boolean(), async (text, code, offline) => {
        vi.stubGlobal('fetch', async () => {
          if (offline) throw new TypeError('Failed to fetch');
          return new Response(text, { status: code, headers: { 'content-type': 'application/json' } });
        });
        for (const call of [api.status, () => api.subscribe({ email: 'a@b.co', siteIds: [1], applicants: 1, pace: 'hourly', channels: null, website: '' }), () => api.confirm('t'), () => api.unsubscribe('t')]) {
          try {
            await call();
          } catch (err) {
            expect(err).toBeInstanceOf(ApiFailure);
            const failure = err as ApiFailure;
            expect(failure.message.length).toBeGreaterThan(0);
            expect(failure.message.length).toBeLessThanOrEqual(300);
            for (const v of Object.values(failure.fields)) expect(typeof v).toBe('string');
          }
        }
        const s = await api.status().catch(() => null);
        if (s) expect(isStatusResponse(s)).toBe(true);
      }),
      { seed: 20260927, numRuns: RUNS * 2 },
    );
  }, 20_000 + RUNS * 50);
});

describe('base path', () => {
  it.each([
    ['/pengepassportph/', '/pengepassportph/', '/'],
    ['/pengepassportph', '/pengepassportph/', '/'],
    ['/pengepassportph/confirm', '/pengepassportph/', '/confirm'],
    ['/pengepassportph/unsubscribe/', '/pengepassportph/', '/unsubscribe'],
    ['/pengepassportph/privacy', '/pengepassportph/', '/privacy'],
    ['/pengepassportphx/confirm', '/pengepassportph/', '/pengepassportphx/confirm'],
    ['/confirm', '/pengepassportph/', '/confirm'],
    ['/confirm', '/', '/confirm'],
    ['/', '/', '/'],
  ])('%s under %s is the %s page', async (path, base, route) => {
    const { routeOf } = await import('../src/links.ts');
    expect(routeOf(path, base)).toBe(route);
  });
});

const sharedMock = vi.hoisted(() => ({ reconcile: vi.fn(), turnOff: vi.fn(), readState: vi.fn(), credentialHash: vi.fn(async () => 'h'.repeat(43)) }));
vi.mock('../src/notify/shared.js', () => sharedMock);
vi.mock('../src/notify/worker.ts', () => ({ registration: async () => ({ pushManager: { getSubscription: async () => null } }), readyWorker: async () => null, register: () => {}, workerFailed: () => false }));
vi.mock('../src/notify/push.ts', () => ({ pushEnv: () => ({}), postToApi: vi.fn(), enablePush: vi.fn(), PUSH_CHANGED: 'pengepassportph-push-changed' }));

const NO_CREDENTIAL = { credential: null, confirmed: false, askedAt: null, revision: 0, fingerprint: null, applicationServerKey: null };
beforeEach(() => {
  for (const f of Object.values(sharedMock)) f.mockReset();
  sharedMock.credentialHash.mockResolvedValue('h'.repeat(43));
  sharedMock.readState.mockResolvedValue(NO_CREDENTIAL);
});
const CONFIRMED = { credential: 'c'.repeat(43), confirmed: true, askedAt: 0, revision: 1, fingerprint: 'f', applicationServerKey: 'B'.repeat(87) };
const LIVE = { ...STATUS, push: 'live' as const, vapidPublicKey: 'B'.repeat(87) };

describe('confirming with channels', () => {
  const token = 't'.repeat(43);
  const preview = { siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', pushCredentialHash: 'h'.repeat(43), devicesKept: 0 } };
  beforeEach(() => sharedMock.readState.mockResolvedValue(NO_CREDENTIAL));

  it('shows the channels before the confirm button and sends the acknowledgement', async () => {
    visit(`/confirm#token=${token}`);
    const api = fakeApi({ previewConfirm: vi.fn(async () => preview) });
    render(<App path="/confirm" api={api} />);
    expect(await screen.findByText(/Email: off/)).toBeTruthy();
    expect(screen.getByText(/Notifications: on, for the device and browser that asked \(Chrome on Android/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm alert' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith(token, { emailOn: false, pushOn: true }));
  });

  it('keeps the button off until the preview has loaded', async () => {
    visit(`/confirm#token=${token}`);
    render(<App path="/confirm" api={fakeApi({ previewConfirm: vi.fn(() => new Promise<never>(() => {})) })} />);
    expect((await screen.findByRole('button', { name: /Confirm alert|Loading/ })).hasAttribute('disabled')).toBe(true);
  });

  it('shows the out-of-date message on 409 reload', async () => {
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => { throw new ApiFailure('This page is out of date. Reload it, then open the confirmation link from your email again.', 409); }),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/open the confirmation link from your email again/)).toBeTruthy();
  });

  it('registers this device right after confirming in the browser that asked', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'c'.repeat(43), askedAt: Date.now() });
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    vi.stubGlobal('Notification', { permission: 'granted' });
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'bound' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/Notifications are on for this device/)).toBeTruthy();
    expect(sharedMock.reconcile).toHaveBeenCalled();
  });

  it('does not say notifications are on without permission or a browser subscription', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'c'.repeat(43), askedAt: Date.now() });
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: false });
    vi.stubGlobal('Notification', { permission: 'default' });
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'kept' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    // Permission is back to "ask": waiting will not finish it, allowing it will.
    expect(await screen.findByText(/Notifications are not allowed on this device yet/)).toBeTruthy();
    expect(screen.queryByText('Notifications are on for this device.')).toBeNull();
  });

  it('keeps the confirmation when registering this browser fails', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'c'.repeat(43), askedAt: Date.now() });
    sharedMock.reconcile.mockRejectedValue(new Error('network'));
    vi.stubGlobal('Notification', { permission: 'granted' });
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'bound' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText('You are subscribed')).toBeTruthy();
    expect(screen.getByText(/could not be set up on this device yet/)).toBeTruthy();
  });

  it('does not register a different local credential, and says where notifications are on', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'x'.repeat(43), askedAt: Date.now() });
    sharedMock.credentialHash.mockResolvedValueOnce('z'.repeat(43));
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'bound' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/Notifications are on for the device where you asked for them/)).toBeTruthy();
    expect(sharedMock.reconcile).not.toHaveBeenCalled();
  });
});

describe('confirming, when things go wrong', () => {
  const token = 't'.repeat(43);
  const preview = { siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', pushCredentialHash: 'h'.repeat(43), devicesKept: 0 } };

  it('offers to load the preview again after it failed, with the same link', async () => {
    visit(`/confirm#token=${token}`);
    const previewConfirm = vi.fn().mockRejectedValueOnce(new ApiFailure('We could not reach the server. Check your connection and try again.', 0)).mockResolvedValueOnce(preview);
    render(<App path="/confirm" api={fakeApi({ previewConfirm })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Confirm alert' })).toBeTruthy();
    expect(previewConfirm).toHaveBeenLastCalledWith(token);
  });

  it('says to allow notifications when permission went back to "ask"', async () => {
    sharedMock.readState.mockResolvedValue({ ...NO_CREDENTIAL, credential: 'c'.repeat(43), askedAt: Date.now() });
    sharedMock.reconcile.mockResolvedValue({ state: 'awaiting', subscribed: false });
    vi.stubGlobal('Notification', { permission: 'default' });
    visit(`/confirm#token=${token}`);
    const api = fakeApi({
      previewConfirm: vi.fn(async () => preview),
      confirm: vi.fn(async () => ({ status: 'confirmed' as const, siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, push: 'bound' as const } })),
    });
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText(/Notifications are not allowed on this device yet/)).toBeTruthy();
  });
});

describe('an old confirmation page left open across the deploy', () => {
  it('shows the server message on its token-only confirm, then the new page confirms the reopened link', async () => {
    const token = 't'.repeat(43);
    const preview = { siteIds: [486], applicants: 1, pace: 'asap' as const, channels: { emailOn: false, pushOn: true, device: 'Chrome on Android', requestedAt: '2026-10-05T02:02:00.000Z', pushCredentialHash: 'h'.repeat(43), devicesKept: 0 } };
    // A stand-in for the server: the old page posts { token } only and gets 409 reload, as Task 6 tests on the real server.
    const server = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { acknowledge?: unknown };
      if (url.endsWith('/api/confirm/preview')) return new Response(JSON.stringify(preview), { status: 200 });
      if (!body.acknowledge) return new Response(JSON.stringify({ error: 'This page is out of date. Reload it, then open the confirmation link from your email again.', code: 'reload' }), { status: 409 });
      return new Response(JSON.stringify({ status: 'confirmed', siteIds: [486], applicants: 1, pace: 'asap', channels: { emailOn: false, pushOn: true, push: 'bound' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', server);
    visit(`/confirm#token=${token}`);
    const { Confirm: OldConfirm } = await import('./fixtures/v0.2/Confirm.tsx');
    const old = render(<OldConfirm api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm email alert' }));
    expect(await screen.findByText(/open the confirmation link from your email again/)).toBeTruthy();
    old.unmount();
    // The person reopens the link from the email: the new page.
    visit(`/confirm#token=${token}`);
    render(<App path="/confirm" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm alert' }));
    expect(await screen.findByText('You are subscribed')).toBeTruthy();
  });
});

describe('the notifications row', () => {
  beforeEach(() => visit('/'));

  it.each([
    [{ state: 'registered' }, 'granted', /Notifications on this device: On/],
    [{ state: 'pending' }, 'granted', /Waiting for you to confirm by email/],
    [{ state: 'registered' }, 'denied', /Notifications are blocked on this device/],
    [{ state: 'missing' }, 'granted', /Notifications are off for this device/],
  ])('shows %o with permission %s', async (answer, permission, text) => {
    vi.stubGlobal('Notification', { permission });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ ...answer, subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('turns the device off from the row, and warns when nothing is left', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    sharedMock.turnOff.mockResolvedValue({ ok: true, noChannel: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText(/You will get no alerts now/)).toBeTruthy();
    expect(screen.queryByText(/Notifications on this device: On/)).toBeNull();
  });

  it('still offers Turn off while push is switched off on the server', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => ({ ...LIVE, push: 'off' as const, vapidPublicKey: null }) })} />);
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('shows blocked, with Turn off, for an awaiting device whose permission was revoked', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'awaiting', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/Notifications are blocked on this device/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('shows blocked after permission is revoked in settings and the page comes back', async () => {
    const perm = { permission: 'granted' as NotificationPermission };
    vi.stubGlobal('Notification', perm);
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/Notifications on this device: On/)).toBeTruthy();
    perm.permission = 'denied'; // turned off in Android settings, away from the page
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByText(/Notifications are blocked on this device/)).toBeTruthy();
  });

  it('takes the sheet\'s answer without asking the server again', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'pending', subscribed: false });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/Waiting for you to confirm by email/)).toBeTruthy();
    const calls = sharedMock.reconcile.mock.calls.length;
    act(() => void window.dispatchEvent(new CustomEvent('pengepassportph-push-changed', { detail: { state: 'registered', subscribed: true } })));
    expect(await screen.findByText(/Notifications on this device: On/)).toBeTruthy();
    expect(sharedMock.reconcile.mock.calls.length).toBe(calls);
  });

  it('appears when push is turned on later, without reloading the page', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(NO_CREDENTIAL);
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    await screen.findByText(/DFA offices in the Philippines/);
    expect(screen.queryByText(/Waiting for you to confirm/)).toBeNull();
    sharedMock.readState.mockResolvedValue({ ...CONFIRMED, confirmed: false });
    sharedMock.reconcile.mockResolvedValue({ state: 'pending', subscribed: false });
    act(() => void window.dispatchEvent(new Event('pengepassportph-push-changed')));
    expect(await screen.findByText(/Waiting for you to confirm by email/)).toBeTruthy();
  });

  it('does not say On without permission or a browser subscription', async () => {
    vi.stubGlobal('Notification', { permission: 'default' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: false });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/not allowed on this device yet/)).toBeTruthy();
    expect(screen.queryByText(/: On/)).toBeNull();
  });

  it('does not call an unresolved device On', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'stale', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/need setting up again/)).toBeTruthy();
    expect(screen.queryByText(/: On/)).toBeNull();
  });

  it('still checks this device when the app opens straight on an office', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    visit('/?office=486&date=2026-10-09&people=2');
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByRole('heading', { name: 'Antipolo' })).toBeTruthy();
    await waitFor(() => expect(sharedMock.reconcile).toHaveBeenCalled());
  });

  it('says when turning off failed, and lets it be tried again', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    sharedMock.turnOff.mockRejectedValueOnce(new ApiFailure('We could not reach the server. Check your connection and try again.', 0));
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText(/could not reach the server/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('asks the server once per wait, even in StrictMode', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'pending', subscribed: false });
    render(<StrictMode><App path="/" api={fakeApi({ status: async () => LIVE })} /></StrictMode>);
    expect(await screen.findByText(/Waiting for you to confirm by email/)).toBeTruthy();
    const before = sharedMock.reconcile.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(sharedMock.reconcile.mock.calls.length - before).toBe(1);
    vi.useRealTimers();
  });

  it('leaves no permission listener behind once gone', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    const status = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('navigator', { ...navigator, permissions: { query: () => new Promise((r) => setTimeout(() => r(status), 20)) } });
    const view = render(<StrictMode><App path="/" api={fakeApi({ status: async () => LIVE })} /></StrictMode>);
    expect(await screen.findByText(/Notifications on this device: On/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    view.unmount();
    expect(status.addEventListener.mock.calls.length).toBe(status.removeEventListener.mock.calls.length);
  });

  it('notices when another tab turned this device off', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'registered', subscribed: true });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/Notifications on this device: On/)).toBeTruthy();
    sharedMock.readState.mockResolvedValue(NO_CREDENTIAL);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByText(/Notifications are off for this device/)).toBeTruthy();
  });

  it('says to allow notifications for a confirmed device whose permission went back to "ask"', async () => {
    vi.stubGlobal('Notification', { permission: 'default' });
    sharedMock.readState.mockResolvedValue(CONFIRMED);
    sharedMock.reconcile.mockResolvedValue({ state: 'awaiting', subscribed: false });
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    expect(await screen.findByText(/not allowed on this device yet/)).toBeTruthy();
    expect(screen.queryByText(/Waiting for you to confirm/)).toBeNull();
  });

  it('shows nothing when this browser never turned push on', async () => {
    sharedMock.readState.mockResolvedValue(NO_CREDENTIAL);
    render(<App path="/" api={fakeApi({ status: async () => LIVE })} />);
    await screen.findByText(/DFA offices in the Philippines/);
    expect(screen.queryByText(/Notifications/)).toBeNull();
  });
});

it('opens an office for a group from ?people=', async () => {
  visit('/?office=486&date=2026-10-09&people=2');
  const api = fakeApi();
  render(<App path="/" api={api} />);
  expect(await screen.findByRole('heading', { name: 'Antipolo' })).toBeTruthy();
  await waitFor(() => expect(api.officeDates).toHaveBeenCalledWith(486, 2));
  expect((screen.getByLabelText('Booking for') as HTMLSelectElement).value).toBe('2');
});
