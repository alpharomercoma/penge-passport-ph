import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceRow, rowText } from '../src/components/DeviceRow.tsx';
import type { DeviceController, RowView } from '../src/devices/controller.ts';
import { TEXT } from '../src/devices/controller.ts';

afterEach(cleanup);
const NAMES: Record<number, string> = { 486: 'Antipolo', 693: 'Pampanga', 10: 'Aseana' };
const names = (id: number) => NAMES[id] ?? `Office ${id}`;
const on = (o: Partial<{ siteIds: number[]; applicants: number; pace: 'asap' | 'hourly'; renewFailing: boolean }> = {}): RowView => ({
  kind: 'on',
  renewFailing: o.renewFailing ?? false,
  alert: { alertId: 'a', incarnation: 'i', generation: 1, revision: 1, fingerprint: 'f', endsAt: Date.parse('2027-04-04T00:00:00Z'), choices: { siteIds: o.siteIds ?? [486, 693, 10], applicants: o.applicants ?? 2, pace: o.pace ?? 'asap' } },
});

describe('the row for this device', () => {
  it('says what is on, for whom, how often and until when', () => {
    expect(rowText(on(), names)).toBe('Notifications on this device: Antipolo and 2 more · for 2 people · as soon as possible · until 4 Apr 2027');
    expect(rowText(on({ siteIds: [486], applicants: 1, pace: 'hourly' }), names)).toBe('Notifications on this device: Antipolo · for 1 person · at most once an hour · until 4 Apr 2027');
  });

  it.each([
    [{ kind: 'setting-up', slow: false }, 'Setting up notifications on this device…'],
    [{ kind: 'setting-up', slow: true }, TEXT.slow],
    [{ kind: 'blocked' }, TEXT.blocked],
    [{ kind: 'ended', endedAt: Date.parse('2027-04-04T00:00:00Z') }, 'Notifications on this device ended on 4 Apr 2027. Turn them on again to keep getting them.'],
    [{ kind: 'again' }, TEXT.again],
    [{ kind: 'off', unsubscribed: true, deleted: true }, TEXT.offDone],
    [{ kind: 'off', unsubscribed: true, deleted: false }, `${TEXT.offDone} ${TEXT.offPending}`],
    [{ kind: 'off', unsubscribed: false, deleted: false }, `${TEXT.offBrowser} ${TEXT.offPending}`],
    [{ kind: 'cant-check' }, "Can't check notifications on this device right now."],
    [{ kind: 'legacy' }, TEXT.legacy],
    [{ kind: 'updating' }, TEXT.updating],
  ] as [RowView, string][])('says %j as "%s"', (view, text) => {
    expect(rowText(view, names)).toBe(text);
  });

  it('puts Change, Send a test and Turn off together, and says when renewing is failing', async () => {
    let listener: (v: RowView) => void = () => {};
    const controller = {
      view: on({ renewFailing: true }),
      subscribe: (l: (v: RowView) => void) => ((listener = l), () => {}),
      reconcile: vi.fn(async () => on({ renewFailing: true })),
      test: vi.fn(async () => TEXT.testAccepted),
      turnOff: vi.fn(async (): Promise<RowView> => ({ kind: 'none' })),
    } as unknown as DeviceController;
    const onChange = vi.fn();
    render(<DeviceRow controller={controller} offices={[]} onChange={onChange} onSetUp={() => {}} names={names} />);
    await waitFor(() => screen.getByText(TEXT.renewFailing));
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    await waitFor(() => screen.getByText(TEXT.testAccepted));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onChange).toHaveBeenCalledWith({ siteIds: [486, 693, 10], applicants: 2, pace: 'asap' });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(controller.turnOff).toHaveBeenCalled());
    act(() => listener({ kind: 'none' }));
    expect(screen.queryByText(/Notifications on this device/)).toBeNull();
  });

  it('offers Turn off while setting up, and Set up again once ended', async () => {
    const turnOff = vi.fn(async (): Promise<RowView> => ({ kind: 'off', unsubscribed: true, deleted: true }));
    const setUp = vi.fn();
    const controller = { view: { kind: 'setting-up', slow: false }, subscribe: () => () => {}, reconcile: vi.fn(async (): Promise<RowView> => ({ kind: 'setting-up', slow: false })), turnOff } as unknown as DeviceController;
    render(<DeviceRow controller={controller} onChange={() => {}} onSetUp={setUp} names={names} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(turnOff).toHaveBeenCalled());
    cleanup();
    const ended = { view: { kind: 'ended', endedAt: Date.parse('2027-04-04T00:00:00Z') }, subscribe: () => () => {}, reconcile: vi.fn(async (): Promise<RowView> => ({ kind: 'ended', endedAt: Date.parse('2027-04-04T00:00:00Z') })) } as unknown as DeviceController;
    render(<DeviceRow controller={ended} onChange={() => {}} onSetUp={setUp} names={names} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up again' }));
    expect(setUp).toHaveBeenCalled();
  });

  it('reconciles on opening, on returning to the page, and every 30 s while setting up', async () => {
    vi.useFakeTimers();
    const controller = { view: { kind: 'setting-up', slow: false }, subscribe: () => () => {}, reconcile: vi.fn(async (): Promise<RowView> => ({ kind: 'setting-up', slow: false })) } as unknown as DeviceController;
    render(<DeviceRow controller={controller} offices={[]} onChange={() => {}} onSetUp={() => {}} names={names} />);
    expect(controller.reconcile).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(controller.reconcile).toHaveBeenCalledTimes(2);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(controller.reconcile).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
