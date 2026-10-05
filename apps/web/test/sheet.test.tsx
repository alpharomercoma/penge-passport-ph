import { LIMITS, PACES, type StatusResponse, validateSubscribe } from '@penge/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fc from 'fast-check';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, type Api } from '../src/api.ts';
import { AlertSheet } from '../src/components/AlertSheet.tsx';
import { toAbroadOffices, toOffices } from '../src/office.ts';
import { ABROAD, fakeApi, STATUS } from './helpers.tsx';

const pushMock = vi.hoisted(() => ({ enable: vi.fn() }));
vi.mock('../src/notify/push.ts', () => ({ enablePush: pushMock.enable, pushEnv: () => ({}), postToApi: vi.fn(), PUSH_CHANGED: 'pengepassportph-push-changed' }));
vi.mock('../src/notify/shared.js', () => ({ reconcile: vi.fn(async () => ({ state: 'pending' })), readState: vi.fn(async () => ({ credential: null })), markRequested: vi.fn(async () => {}) }));
const workerMock = vi.hoisted(() => ({ registration: vi.fn(async () => ({}) as unknown) }));
vi.mock('../src/notify/worker.ts', () => ({ workerFailed: () => false, registration: workerMock.registration, readyWorker: async () => null, register: () => {} }));

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
const OFFICES = toOffices(STATUS.sites);
const KNOWN = new Set(OFFICES.map((o) => o.id));

afterEach(cleanup);

function Harness({ api, initial = [], onClose = () => {} }: { api: Api; initial?: number[]; onClose?: () => void }) {
  const [selected, setSelected] = useState<number[]>(initial);
  return <AlertSheet api={api} status={STATUS} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={onClose} />;
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
    pace: within(sheet).getByLabelText('How often') as HTMLSelectElement,
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
      return <AlertSheet api={fakeApi()} status={STATUS} offices={offices} selected={selected} onSelectedChange={setSelected} onClose={() => {}} />;
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
    expect(s.pace.value).toBe('hourly'); // at most once an hour, unless they choose otherwise
    fireEvent.change(s.pace, { target: { value: 'asap' } });
    fireEvent.click(s.submit);
    await screen.findByText('Check your inbox for a confirmation link.');
    expect(s.api.subscribe).toHaveBeenCalledWith({ email: 'juan@example.com', siteIds: [486], applicants: 3, pace: 'asap', channels: { emailOn: true, pushOn: false, pushCredentialHash: null, device: null }, website: '' });
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
        fc.constantFrom(...PACES),
        async (typed, clicks, applicants, website, pace) => {
          cleanup();
          const s = open();
          fireEvent.change(s.email, { target: { value: typed } });
          for (const i of clicks) fireEvent.click(s.boxes()[i]!);
          fireEvent.change(s.people, { target: { value: String(applicants) } });
          fireEvent.change(s.pace, { target: { value: pace } });
          fireEvent.change(s.honeypot, { target: { value: website } });

          const boxes = s.boxes();
          const places = [...OFFICES].sort((a, b) => a.place.localeCompare(b.place));
          const chosen = boxes.flatMap((b, i) => (b.checked ? [places[i]!.id] : []));
          expect(chosen.length).toBeLessThanOrEqual(LIMITS.sitesPerSubscription);
          const expected = validateSubscribe({ email: s.email.value, siteIds: chosen, applicants, pace, website, channels: { emailOn: true, pushOn: false, pushCredentialHash: null, device: null } }, KNOWN);

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

const LIVE = { ...STATUS, push: 'live' as const, vapidPublicKey: 'B'.repeat(87) };
const ANDROID = 'Mozilla/5.0 (Linux; Android 16) Chrome/141.0 Mobile';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605';

function openWith(status: StatusResponse = LIVE, ua = ANDROID, permission: NotificationPermission = 'default') {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  vi.stubGlobal('PushManager', function () {});
  vi.stubGlobal('Notification', { permission });
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
  Object.defineProperty(navigator, 'locks', { value: {}, configurable: true });
  const api = fakeApi();
  function H() {
    const [selected, setSelected] = useState<number[]>([486]);
    return <AlertSheet api={api} status={status} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} />;
  }
  render(<H />);
  const sheet = screen.getByRole('dialog');
  return {
    api,
    sheet,
    email: within(sheet).getByLabelText('Your email') as HTMLInputElement,
    emailSwitch: within(sheet).getByRole('switch', { name: 'Email' }),
    pushSwitch: () => within(sheet).queryByRole('switch', { name: /notifications/i }),
    submit: within(sheet).getByRole('button', { name: /Send confirmation email/ }),
  };
}

describe('channels in the alert form', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    pushMock.enable.mockReset();
  });

  it('sends email only by default, with channels', async () => {
    const s = openWith();
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    await waitFor(() => expect(s.api.subscribe).toHaveBeenCalled());
    expect(s.api.subscribe.mock.calls[0]![0].channels).toEqual({ emailOn: true, pushOn: false, pushCredentialHash: null, device: null });
  });

  it('turns push on with a credential hash and a device label', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    await waitFor(() => expect(s.api.subscribe).toHaveBeenCalled());
    expect(s.api.subscribe.mock.calls[0]![0].channels).toEqual({ emailOn: true, pushOn: true, pushCredentialHash: 'h'.repeat(43), device: 'Chrome on Android' });
  });

  it('calls enablePush inside the click, before anything else awaits', async () => {
    pushMock.enable.mockReturnValueOnce(new Promise(() => {}));
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    expect(pushMock.enable).toHaveBeenCalledTimes(1); // synchronously, in the same task as the click
  });

  it('refuses to send with no channel', async () => {
    const s = openWith();
    fireEvent.click(s.emailSwitch);
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    expect(await within(s.sheet).findByText('Turn on at least one: email or notifications.')).toBeTruthy();
    expect(s.api.subscribe).not.toHaveBeenCalled();
  });

  it('turns email back on when notifications are switched off and email was off', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(s.emailSwitch);
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(s.pushSwitch()!);
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('true');
  });

  it('shows how to allow notifications as soon as the sheet opens when they are already blocked (Review Focus 2)', async () => {
    const s = openWith(LIVE, ANDROID, 'denied');
    expect(await within(s.sheet).findByText(/Notifications are blocked for this site/)).toBeTruthy();
    expect(pushMock.enable).not.toHaveBeenCalled();
  });

  it('hides the switch and says why when the service worker failed to register', async () => {
    workerMock.registration.mockResolvedValueOnce(null);
    const s = openWith();
    expect(await within(s.sheet).findByText(/Reload the page to turn them on; email still works/)).toBeTruthy();
    expect(s.pushSwitch()).toBeNull();
  });

  it('shows the denied hint and leaves the switch off', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: false, reason: 'denied' });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    expect(await within(s.sheet).findByText(/Notifications are blocked for this site/)).toBeTruthy();
    expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('false');
  });

  it('says what the device really is while waiting, and tells the row only when it changes', async () => {
    const shared = await import('../src/notify/shared.js');
    const reconcile = vi.mocked(shared.reconcile);
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seen: unknown[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('pengepassportph-push-changed', listen);
    const s = openWith(LIVE, ANDROID, 'granted');
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    reconcile.mockResolvedValue({ state: 'registered', subscribed: false });
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    expect(await within(s.sheet).findByText('Waiting for you to confirm by email.')).toBeTruthy(); // registered, but no subscription here: not "on"
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toHaveLength(1); // three answers, one change
    reconcile.mockResolvedValue({ state: 'missing', subscribed: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await within(s.sheet).findByText(/were not turned on for this device/)).toBeTruthy();
    expect(seen).toHaveLength(2);
    window.removeEventListener('pengepassportph-push-changed', listen);
    vi.useRealTimers();
  });

  it('turns email back on when push fails to come on and email was off', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: false, reason: 'dismissed' });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.emailSwitch);
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.emailSwitch.getAttribute('aria-checked')).toBe('true'));
  });

  it('shows the subscribe-failed reason and keeps email on', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: false, reason: 'subscribe-failed' });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    expect(await within(s.sheet).findByText(/This browser would not turn notifications on/)).toBeTruthy();
    expect(s.emailSwitch.getAttribute('aria-checked')).toBe('true');
  });

  it('shows no switch in an iPhone tab, with the Home Screen hint', () => {
    const s = openWith(LIVE, IPHONE);
    expect(s.pushSwitch()).toBeNull();
    expect(within(s.sheet).getByText(/add this site to your Home Screen/)).toBeTruthy();
  });

  it('asks for permission once, however often the switch is pressed, and waits for it before sending', async () => {
    let finish!: (r: unknown) => void;
    pushMock.enable.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    fireEvent.click(s.pushSwitch()!);
    expect(pushMock.enable).toHaveBeenCalledTimes(1);
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    expect(s.api.subscribe).not.toHaveBeenCalled(); // not with push half on
    await act(async () => finish({ ok: true, credentialHash: 'h'.repeat(43) }));
    fireEvent.click(s.submit);
    await waitFor(() => expect(s.api.subscribe).toHaveBeenCalled());
    expect(s.api.subscribe.mock.calls[0]![0].channels.pushOn).toBe(true);
  });

  it('waits on the device that was sent, even if the switch moved while sending', async () => {
    const shared = await import('../src/notify/shared.js');
    vi.mocked(shared.reconcile).mockResolvedValue({ state: 'pending', subscribed: false });
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    const s = openWith(LIVE, ANDROID, 'granted');
    let answer!: (m: string) => void;
    s.api.subscribe.mockReturnValueOnce(new Promise((r) => (answer = r)));
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    fireEvent.click(s.pushSwitch()!); // moved while the request is on its way
    await act(async () => answer('Check your inbox for a confirmation link.'));
    expect(await within(s.sheet).findByText('Waiting for you to confirm by email.')).toBeTruthy();
  });

  it('says to allow notifications again when permission went back to "ask" after confirming', async () => {
    const shared = await import('../src/notify/shared.js');
    vi.mocked(shared.reconcile).mockResolvedValue({ state: 'awaiting', subscribed: false });
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    const s = openWith(LIVE, ANDROID, 'default');
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    expect(await within(s.sheet).findByText(/Allow notifications for this site again/)).toBeTruthy();
  });

  it('drops push, and keeps email on, when push stops being available while the sheet is open', async () => {
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    const s = openWith();
    await waitFor(() => expect(s.pushSwitch()).not.toBeNull());
    fireEvent.click(s.pushSwitch()!);
    await waitFor(() => expect(s.pushSwitch()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(s.emailSwitch); // push only
    cleanup();
    // The same sheet, after the status refresh says push is off.
    const api = s.api;
    function H({ status }: { status: StatusResponse }) {
      const [selected, setSelected] = useState<number[]>([486]);
      return <AlertSheet api={api} status={status} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} />;
    }
    const view = render(<H status={LIVE} />);
    const sheet = screen.getByRole('dialog');
    const push = () => within(sheet).queryByRole('switch', { name: /notifications/i });
    await waitFor(() => expect(push()).not.toBeNull());
    pushMock.enable.mockResolvedValueOnce({ ok: true, credentialHash: 'h'.repeat(43) });
    fireEvent.click(push()!);
    await waitFor(() => expect(push()!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Email' }));
    view.rerender(<H status={{ ...STATUS, push: 'off', vapidPublicKey: null }} />);
    expect(push()).toBeNull();
    expect(within(sheet).getByRole('switch', { name: 'Email' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(within(sheet).getByLabelText('Your email'), { target: { value: 'juan@example.com' } });
    fireEvent.click(within(sheet).getByRole('button', { name: /Send confirmation email/ }));
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    expect(api.subscribe.mock.calls[0]![0].channels).toEqual({ emailOn: true, pushOn: false, pushCredentialHash: null, device: null });
  });

  it('shows no switch when the server has push off', () => {
    const s = openWith({ ...STATUS, push: 'off', vapidPublicKey: null });
    expect(s.pushSwitch()).toBeNull();
  });
});
