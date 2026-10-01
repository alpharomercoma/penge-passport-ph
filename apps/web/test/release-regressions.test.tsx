import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { ApiFailure } from '../src/api.ts';
import { OfficeView } from '../src/components/OfficeView.tsx';
import { toOffices } from '../src/office.ts';
import { fakeApi, STATUS, TIMES } from './helpers.tsx';

const office = toOffices(STATUS.sites).find((o) => o.id === 486)!;
const at = '2026-10-01T00:00:00.000Z';
const props = (api = fakeApi()) => ({ api, office: { ...office, checkedAt: at }, lastCheck: at, offices: [office], today: '2026-10-01', initialDate: null, applicants: 1, onApplicants: vi.fn(), alertsOpen: true, onBack: vi.fn(), onOpen: vi.fn(), onAlert: vi.fn() });

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); window.localStorage.clear(); });

describe('release readiness regressions', () => {
  it('replaces green days with a newer closed scan even before its lookup finishes', async () => {
    const api = fakeApi({ officeDates: vi.fn().mockResolvedValueOnce({ siteId: 486, applicants: 1, openDates: ['2026-10-07'], fullDates: [], windowEnd: '2027-03-31', checkedAt: at }).mockImplementation(() => new Promise(() => {})) });
    const p = props(api);
    const view = render(<OfficeView {...p} />);
    await screen.findByRole('button', { name: /Wed 7 Oct 2026: open/ });
    view.rerender(<OfficeView {...p} office={{ ...p.office, openDates: [], fullDates: ['2026-10-07'], checkedAt: '2026-10-01T00:05:00.000Z' }} />);
    expect(screen.queryByRole('button', { name: /Wed 7 Oct 2026: open/ })).toBeNull();
    expect(screen.getByText(/^No open dates/)).toBeTruthy();
  });

  it('attributes a group closure to the newer single-person scan while its group lookup waits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:10:00Z'));
    const api = fakeApi({ officeDates: vi.fn().mockResolvedValueOnce({ siteId: 486, applicants: 3, openDates: ['2026-10-07'], fullDates: [], windowEnd: '2027-03-31', checkedAt: at }).mockImplementation(() => new Promise(() => {})) });
    const p = { ...props(api), applicants: 3, initialDate: '2026-10-07' };
    const view = render(<OfficeView {...p} />);
    await act(async () => {});
    view.rerender(<OfficeView {...p} office={{ ...p.office, openDates: [], fullDates: ['2026-10-07'], checkedAt: '2026-10-01T00:09:00.000Z' }} />);
    expect(screen.queryByRole('button', { name: /Wed 7 Oct 2026: open/ })).toBeNull();
    expect(screen.getByText('Wed 7 Oct 2026 is no longer open for 3 people (checked 1 minute ago).')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Wed 7 Oct 2026 for 3 people' })).toBeNull();
  });

  it('refreshes a group and chosen hours at the bounded cadence without overlapping requests', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    render(<OfficeView {...props(api)} applicants={2} initialDate="2026-10-07" />);
    await act(async () => {});
    expect(api.officeDates).toHaveBeenCalledTimes(1);
    expect(api.officeTimes).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(api.officeDates).toHaveBeenCalledTimes(2);
    expect(api.officeTimes.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.officeTimes.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('shows a failed refresh warning alongside saved dates and retries', async () => {
    const api = fakeApi({ officeDates: vi.fn().mockRejectedValueOnce(new ApiFailure('QA upstream unavailable', 503)).mockResolvedValue({ siteId: 486, applicants: 1, openDates: [], fullDates: ['2026-10-07'], windowEnd: '2027-03-31', checkedAt: at }) });
    render(<OfficeView {...props(api)} />);
    await screen.findByText(/QA upstream unavailable/);
    expect(screen.getByRole('button', { name: /Wed 7 Oct 2026: open/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try checking again' }));
    await waitFor(() => expect(screen.queryByText(/QA upstream unavailable/)).toBeNull());
    expect(api.officeDates).toHaveBeenCalledTimes(2);
  });

  it('discloses a server-side cached fallback warning and keeps its observation time', async () => {
    const api = fakeApi({ officeDates: vi.fn(async () => ({ siteId: 486, applicants: 1, openDates: ['2026-10-07'], fullDates: [], windowEnd: '2027-03-31', checkedAt: at, warning: 'Saved answer after failed refresh' })) });
    render(<OfficeView {...props(api)} />);
    await screen.findByText(/Saved answer after failed refresh/);
  });

  it('lets a full hour reopen on a subsequent lookup', async () => {
    vi.useFakeTimers();
    const api = fakeApi({ officeTimes: vi.fn().mockResolvedValueOnce({ ...TIMES, slots: TIMES.slots.map((slot) => ({ ...slot, available: false })) }).mockResolvedValue(TIMES) });
    render(<OfficeView {...props(api)} initialDate="2026-10-07" />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Wed 7 Oct 2026: open/ })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(screen.getByRole('button', { name: /Wed 7 Oct 2026: open/ })).toBeTruthy();
  });

  it('offers deletion without a token and validates before asking for a link', async () => {
    const api = fakeApi();
    window.history.replaceState(null, '', '/delete-data');
    render(<App path="/delete-data" api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Email me a deletion link' }));
    expect(api.requestDeletion).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: ' Juan@Example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a deletion link' }));
    await screen.findByText('Check your inbox for a deletion link.');
    expect(api.requestDeletion).toHaveBeenCalledWith('juan@example.com', '');
    expect(api.deleteData).not.toHaveBeenCalled();
  });

  it('a deletion link does nothing until pressed and offers recovery after expiry', async () => {
    const token = 'a'.repeat(43);
    window.history.replaceState(null, '', `/delete-data#token=${token}`);
    const api = fakeApi({ deleteData: vi.fn().mockRejectedValue(new ApiFailure('Link expired', 404)) });
    render(<App path="/delete-data" api={api} />);
    expect(api.deleteData).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Delete my alert data' }));
    await screen.findByText('Link expired');
    expect(screen.getByRole('link', { name: 'Request a new deletion link' })).toBeTruthy();
  });

  it('explains a malformed deletion link and preserves query parameters when hiding its fragment', () => {
    window.history.replaceState(null, '', '/delete-data?source=email#token=abc');
    const api = fakeApi();
    render(<App path="/delete-data" api={api} />);
    expect(screen.getByRole('alert').textContent).toContain('incomplete or invalid');
    expect(screen.getByRole('button', { name: 'Email me a deletion link' })).toBeTruthy();
    expect(window.location.search).toBe('?source=email');
    expect(window.location.hash).toBe('');
    expect(api.deleteData).not.toHaveBeenCalled();
  });

  it('opens a deletion email link in an existing tab without a reload and resets for another link', async () => {
    window.history.replaceState(null, '', '/delete-data');
    const api = fakeApi();
    render(<App path="/delete-data" api={api} />);
    const openLink = async (token: string) => {
      await act(async () => {
        window.history.replaceState(null, '', `/delete-data#token=${token}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    };
    await openLink('a'.repeat(43));
    expect(api.deleteData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete my alert data' }));
    await screen.findByRole('heading', { name: 'Your alert data is deleted' });
    expect(document.activeElement?.contains(screen.getByRole('heading', { name: 'Your alert data is deleted' }))).toBe(true);
    await openLink('a'.repeat(43));
    expect(screen.queryByRole('heading', { name: 'Your alert data is deleted' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete my alert data' }));
    await screen.findByRole('heading', { name: 'Your alert data is deleted' });
    expect(api.deleteData).toHaveBeenCalledTimes(2);
    await openLink('b'.repeat(43));
    expect(screen.queryByRole('heading', { name: 'Your alert data is deleted' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete my alert data' }));
    await waitFor(() => expect(api.deleteData).toHaveBeenLastCalledWith('b'.repeat(43)));
  });

  it('makes background inert, contains focus and restores it after closing', async () => {
    const api = fakeApi();
    render(<App path="/" api={api} />);
    const opener = await screen.findByRole('button', { name: 'Email alerts' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    const ancestors: HTMLElement[] = [];
    for (let element: HTMLElement | null = opener; element; element = element.parentElement) ancestors.push(element);
    expect(ancestors.some((element) => element.inert)).toBe(true);
    opener.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const close = within(dialog).getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Send confirmation email' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
