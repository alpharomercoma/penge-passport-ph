import { LIMITS, PACES, type StatusResponse, validateSubscribe } from '@penge/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fc from 'fast-check';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, type Api } from '../src/api.ts';
import { AlertSheet } from '../src/components/AlertSheet.tsx';
import type { DeviceController } from '../src/devices/controller.ts';
import { toAbroadOffices, toOffices } from '../src/office.ts';
import { ABROAD, fakeApi, STATUS } from './helpers.tsx';

const workerMock = vi.hoisted(() => ({ registration: vi.fn(async () => ({}) as unknown) }));
vi.mock('../src/notify/worker.ts', () => ({ workerFailed: () => false, registration: workerMock.registration, readyWorker: async () => null, register: () => {} }));

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
const OFFICES = toOffices(STATUS.sites);
const KNOWN = new Set(OFFICES.map((o) => o.id));

afterEach(cleanup);

function Harness({ api, initial = [], onClose = () => {}, controller = null }: { api: Api; initial?: number[]; onClose?: () => void; controller?: DeviceController | null }) {
  const [selected, setSelected] = useState<number[]>(initial);
  return <AlertSheet api={api} status={STATUS} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={onClose} controller={controller} />;
}

function open(api = fakeApi(), initial: number[] = [], onClose = vi.fn()) {
  render(<Harness api={api} initial={initial} onClose={onClose} />);
  const sheet = screen.getByRole('dialog');
  fireEvent.click(within(sheet).getByRole('switch', { name: 'Email' }));
  return {
    api, onClose, sheet,
    email: within(sheet).getByLabelText('Your email') as HTMLInputElement,
    people: within(sheet).getByLabelText('Booking for') as HTMLSelectElement,
    pace: within(sheet).getByLabelText('How often') as HTMLSelectElement,
    honeypot: sheet.querySelector('input[name="website"]') as HTMLInputElement,
    boxes: () => within(sheet).queryAllByRole('checkbox') as HTMLInputElement[],
    submit: within(sheet).getByRole('button', { name: 'Send confirmation email' }),
  };
}

describe('alert sheet', () => {
  it('narrows the office picker by area, and abroad, as well as by search', async () => {
    const offices = [...OFFICES, ...toAbroadOffices(ABROAD.posts)];
    function Both() {
      const [selected, setSelected] = useState<number[]>([]);
      return <AlertSheet api={fakeApi()} status={STATUS} offices={offices} selected={selected} onSelectedChange={setSelected} onClose={() => {}} controller={null} />;
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
    await screen.findByText('Check your inbox for a link to start email alerts.');
    expect(s.api.subscribe).toHaveBeenCalledWith({ email: 'juan@example.com', siteIds: [486], applicants: 3, pace: 'asap', website: '' });
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
          const expected = validateSubscribe({ email: s.email.value, siteIds: chosen, applicants, pace, website }, KNOWN);

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

const LIVE: StatusResponse = { ...STATUS, push: 'live', vapidPublicKey: 'B'.repeat(87) };
/** The form with notifications available (secure context, push, a worker), once its switch has shown. */
async function withNotifications(o: { permission?: NotificationPermission; request?: NotificationPermission; setup?: unknown; noSwitch?: boolean } = {}) {
  vi.stubGlobal('Notification', Object.assign(function () {}, { permission: o.permission ?? 'default', requestPermission: vi.fn(async () => o.request ?? 'granted') }));
  vi.stubGlobal('PushManager', function () {});
  vi.stubGlobal('isSecureContext', true); // pushCapability() requires it; jsdom leaves it undefined
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
  Object.defineProperty(navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
  const controller = { setup: vi.fn(async () => o.setup ?? { ok: true, text: 'Notifications are on for this device.' }), change: vi.fn() } as unknown as DeviceController;
  function Live() {
    const [selected, setSelected] = useState<number[]>([486]);
    return <AlertSheet api={fakeApi()} status={LIVE} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} controller={controller} />;
  }
  render(<Live />);
  const sheet = screen.getByRole('dialog');
  // The switch shows once the (mocked) worker check resolves: wait for it before any test touches it.
  if (!o.noSwitch) await within(sheet).findByRole('switch', { name: 'Browser notifications' });
  return { sheet, controller, email: () => within(sheet).getByRole('switch', { name: 'Email' }), notify: () => within(sheet).getByRole('switch', { name: 'Browser notifications' }) };
}

describe('one alerts form, two kinds of alert', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts with both switches off, the email field hidden, and nothing to send', async () => {
    const s = await withNotifications();
    expect(s.email().getAttribute('aria-checked')).toBe('false');
    expect(s.notify().getAttribute('aria-checked')).toBe('false');
    expect(within(s.sheet).queryByLabelText('Your email')).toBeNull();
    expect((within(s.sheet).getByRole('button', { name: /Turn on|Send/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for permission inside the tap and never switches email on by itself', async () => {
    const s = await withNotifications({ request: 'denied' });
    fireEvent.click(s.notify());
    await waitFor(() => expect(within(s.sheet).getByText(/blocked for this site/)).toBeTruthy());
    expect(s.notify().getAttribute('aria-checked')).toBe('false');
    expect(s.email().getAttribute('aria-checked')).toBe('false');
  });

  it('names what the button will do', async () => {
    const s = await withNotifications();
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    fireEvent.click(s.email());
    expect(within(s.sheet).getByRole('button', { name: 'Turn on notifications and send confirmation email' })).toBeTruthy();
    expect(within(s.sheet).getByText('These choices apply to both now. Afterwards, change notifications on this device and email through its links.')).toBeTruthy();
    fireEvent.click(s.notify());
    expect(within(s.sheet).getByRole('button', { name: 'Send confirmation email' })).toBeTruthy();
  });

  it('turns on notifications with no email address sent anywhere', async () => {
    const s = await withNotifications();
    fireEvent.click(s.notify());
    const button = await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    fireEvent.click(button);
    await waitFor(() => within(s.sheet).getByText('Notifications are on for this device.'));
    expect(s.controller.setup).toHaveBeenCalledWith({ siteIds: [486], applicants: 1, pace: 'hourly' });
  });

  it('sends one setup for two submits in the same moment (before the button can disable)', async () => {
    const s = await withNotifications({ setup: { ok: false, text: 'Notifications are full right now. Email alerts still work.', retry: true } });
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    // Submit events straight on the form: the guard, not the disabled button, must stop the second.
    const form = s.sheet.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await within(s.sheet).findByRole('button', { name: 'Try notifications again' });
    expect(s.controller.setup).toHaveBeenCalledTimes(1);
  });

  it('runs both from one snapshot, shows each result, and offers a retry for only the one that failed', async () => {
    const s = await withNotifications({ setup: { ok: false, text: 'Notifications are full right now. Email alerts still work.', retry: true } });
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByRole('button', { name: 'Turn on notifications' }));
    fireEvent.click(s.email());
    fireEvent.change(within(s.sheet).getByLabelText('Your email'), { target: { value: 'juan@example.com' } });
    fireEvent.click(within(s.sheet).getByRole('button', { name: 'Turn on notifications and send confirmation email' }));
    await waitFor(() => within(s.sheet).getByText('Check your inbox for a link to start email alerts.'));
    expect(within(s.sheet).getByText('Notifications are full right now. Email alerts still work.')).toBeTruthy();
    const retry = within(s.sheet).getByRole('button', { name: 'Try notifications again' });
    fireEvent.click(retry);
    await waitFor(() => expect(s.controller.setup).toHaveBeenCalledTimes(2));
    expect((s.controller.setup as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toEqual({ siteIds: [486], applicants: 1, pace: 'hourly' });
  });

  it('speaks of the channels on in the pace hint', async () => {
    const s = await withNotifications();
    fireEvent.click(s.notify());
    await waitFor(() => within(s.sheet).getByText(/One notification with everything new/));
    fireEvent.click(s.email());
    expect(within(s.sheet).getByText(/One email and one notification with everything new/)).toBeTruthy();
  });

  it('edits only this device\'s alert from "Change": no switches, no email, a Save button', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    const controller = { change: vi.fn(async () => ({ ok: true, text: 'Saved.' })) } as unknown as DeviceController;
    render(<AlertSheet api={fakeApi()} status={LIVE} offices={OFFICES} selected={[486]} onSelectedChange={() => {}} onClose={() => {}} controller={controller} change={{ siteIds: [486], applicants: 2, pace: 'asap' }} />);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).queryAllByRole('switch')).toEqual([]);
    expect(within(sheet).queryByLabelText('Your email')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(controller.change).toHaveBeenCalledWith({ siteIds: [486], applicants: 2, pace: 'asap' }));
  });

  it('shows the Home Screen hint in an iPhone tab, and no switch', async () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605' });
    await withNotifications({ noSwitch: true });
    expect(await screen.findByText('To get notifications on iPhone, add this site to your Home Screen, then open it from there.')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /notifications/i })).toBeNull();
  });
});

describe('the form after a submission', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never sends a successful email request again for the same choices', async () => {
    const s = open(fakeApi(), [486]);
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    await screen.findByText('Check your inbox for a link to start email alerts.');
    fireEvent.click(s.submit);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.api.subscribe).toHaveBeenCalledTimes(1);
  });

  it('retries email while a notification setup is still running', async () => {
    let calls = 0;
    const api = fakeApi({
      subscribe: async () => {
        calls++;
        if (calls === 1) throw new ApiFailure('The server did not answer.', 503);
        return { message: 'ok' } as never;
      },
    });
    vi.stubGlobal('Notification', Object.assign(function () {}, { permission: 'granted', requestPermission: vi.fn(async () => 'granted') }));
    vi.stubGlobal('PushManager', function () {});
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    Object.defineProperty(navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
    const controller = { setup: vi.fn(() => new Promise(() => {})), change: vi.fn() } as unknown as DeviceController;
    function Both() {
      const [selected, setSelected] = useState<number[]>([486]);
      return <AlertSheet api={api} status={LIVE} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} controller={controller} />;
    }
    render(<Both />);
    const sheet = screen.getByRole('dialog');
    fireEvent.click(await within(sheet).findByRole('switch', { name: 'Browser notifications' }));
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Email' }));
    fireEvent.change(within(sheet).getByLabelText('Your email'), { target: { value: 'juan@example.com' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Turn on notifications and send confirmation email' }));
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Try email again' }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it('keeps focus inside the dialog, on enabled controls, while a request runs', async () => {
    const api = fakeApi({ subscribe: () => new Promise(() => {}) });
    const s = open(api, [486]);
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    within(s.sheet).getByRole('button', { name: 'Close' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    const active = document.activeElement as HTMLElement;
    expect(s.sheet.contains(active)).toBe(true);
    expect(active.matches(':disabled')).toBe(false);
  });

  it('focuses the change form when it opens', () => {
    const controller = { setup: vi.fn(), change: vi.fn() } as unknown as DeviceController;
    render(<AlertSheet api={fakeApi()} status={LIVE} offices={OFFICES} selected={[486]} onSelectedChange={() => {}} onClose={() => {}} controller={controller} change={{ siteIds: [486], applicants: 2, pace: 'asap' }} />);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});

describe('each kind of alert on its own', () => {
  afterEach(() => vi.unstubAllGlobals());
  const live = () => {
    vi.stubGlobal('Notification', Object.assign(function () {}, { permission: 'granted', requestPermission: vi.fn(async () => 'granted') }));
    vi.stubGlobal('PushManager', function () {});
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
    Object.defineProperty(navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
  };

  it('never retries email once Email is switched off', async () => {
    const api = fakeApi({ subscribe: vi.fn(async () => Promise.reject(new ApiFailure('The server did not answer.', 503))) as never });
    const s = open(api, [486]);
    fireEvent.change(s.email, { target: { value: 'juan@example.com' } });
    fireEvent.click(s.submit);
    await within(s.sheet).findByRole('button', { name: 'Try email again' });
    fireEvent.click(within(s.sheet).getByRole('switch', { name: 'Email' }));
    expect(within(s.sheet).queryByRole('button', { name: 'Try email again' })).toBeNull();
    expect(api.subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps a notification setup that succeeded when only the email address changes', async () => {
    live();
    const controller = { setup: vi.fn(async () => ({ ok: true, text: 'Notifications are on for this device.' })), change: vi.fn() } as unknown as DeviceController;
    function Form() {
      const [selected, setSelected] = useState<number[]>([486]);
      return <AlertSheet api={fakeApi()} status={LIVE} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} controller={controller} />;
    }
    render(<Form />);
    const sheet = screen.getByRole('dialog');
    fireEvent.click(await within(sheet).findByRole('switch', { name: 'Browser notifications' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Turn on notifications' }));
    await within(sheet).findByText('Notifications are on for this device.');
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Email' }));
    fireEvent.change(within(sheet).getByLabelText('Your email'), { target: { value: 'juan@example.com' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Turn on notifications and send confirmation email' }));
    await within(sheet).findByText('Check your inbox for a link to start email alerts.');
    expect(controller.setup).toHaveBeenCalledTimes(1);
  });

  it('turns the notification choice off when notifications stop being available', async () => {
    live();
    const controller = { setup: vi.fn(async () => ({ ok: true, text: 'x' })), change: vi.fn() } as unknown as DeviceController;
    function Form({ status }: { status: StatusResponse }) {
      const [selected, setSelected] = useState<number[]>([486]);
      return <AlertSheet api={fakeApi()} status={status} offices={OFFICES} selected={selected} onSelectedChange={setSelected} onClose={() => {}} controller={controller} />;
    }
    const view = render(<Form status={LIVE} />);
    const sheet = screen.getByRole('dialog');
    fireEvent.click(await within(sheet).findByRole('switch', { name: 'Browser notifications' }));
    view.rerender(<Form status={{ ...STATUS, push: 'off', vapidPublicKey: null }} />);
    const button = within(sheet).getByRole('button', { name: /Turn on|Send/ }) as HTMLButtonElement;
    expect(button.textContent).not.toMatch(/notifications/);
    fireEvent.click(button);
    expect(controller.setup).not.toHaveBeenCalled();
  });
});
