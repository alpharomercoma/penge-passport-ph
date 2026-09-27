import { isStatusResponse, type StatusResponse } from '@penge/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fc from 'fast-check';
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

describe('confirm and unsubscribe pages', () => {
  const token = 'a'.repeat(43);
  const unsub = `${'s'.repeat(22)}.${'b'.repeat(43)}`;

  it('confirms only on the button press, then clears the token from the address bar', async () => {
    visit(`/confirm#token=${token}`);
    const fake = fakeApi();
    render(<App path="/confirm" api={fake} />);
    expect(window.location.hash).toBe('');
    expect(fake.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email alert' }));
    expect(await screen.findByText('We will email you when a date opens at 1 office, for one person.')).toBeTruthy();
    expect(fake.confirm).toHaveBeenCalledWith(token);
  });

  it('explains an expired link', async () => {
    visit(`/confirm#token=${token}`);
    const fake = fakeApi({
      confirm: async () => {
        throw new ApiFailure('That link has expired or was already used. Subscribe again to get a new one.', 404);
      },
    });
    render(<App path="/confirm" api={fake} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email alert' }));
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
        for (const call of [api.status, () => api.subscribe({ email: 'a@b.co', siteIds: [1], applicants: 1, website: '' }), () => api.confirm('t'), () => api.unsubscribe('t')]) {
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
    ['/pengepassportphx/confirm', '/pengepassportph/', '/pengepassportphx/confirm'],
    ['/confirm', '/pengepassportph/', '/confirm'],
    ['/confirm', '/', '/confirm'],
    ['/', '/', '/'],
  ])('%s under %s is the %s page', async (path, base, route) => {
    const { routeOf } = await import('../src/links.ts');
    expect(routeOf(path, base)).toBe(route);
  });
});
