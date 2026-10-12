// "Notifications on this device": this device's alert as the server, the permission and the browser's subscription
// agree it is, reconciled on opening, on returning, and every 30 s while setting up. Change, Send a test and
// Turn off sit together on their own line.
import type { AlertChoices } from '@penge/contracts';
import { useEffect, useState } from 'react';
import { type DeviceController, type RowView, TEXT } from '../devices/controller.ts';
import { formatShortDate } from '../time.ts';

const people = (n: number) => (n === 1 ? 'for 1 person' : `for ${n} people`);

export function rowText(view: RowView, names: (id: number) => string): string {
  switch (view.kind) {
    case 'on': {
      const { choices, endsAt } = view.alert;
      // The local stack's layout audit names offices of any length (VITE_LOCAL_DEBUG builds only).
      const debugNames = import.meta.env.VITE_LOCAL_DEBUG === '1' ? (view.alert as { officeNames?: string[] }).officeNames : undefined;
      const nameOf = (id: number) => debugNames?.[choices.siteIds.indexOf(id)] ?? names(id);
      const offices = choices.siteIds.length > 1 ? `${nameOf(choices.siteIds[0]!)} and ${choices.siteIds.length - 1} more` : nameOf(choices.siteIds[0]!);
      const pace = choices.pace === 'asap' ? 'as soon as possible' : 'at most once an hour';
      return `Notifications on this device: ${offices} · ${people(choices.applicants)} · ${pace} · until ${formatShortDate(endsAt)}`;
    }
    case 'setting-up':
      return view.slow ? TEXT.slow : 'Setting up notifications on this device…';
    case 'blocked':
      return TEXT.blocked;
    case 'ended':
      return `Notifications on this device ended on ${formatShortDate(view.endedAt)}. Turn them on again to keep getting them.`;
    case 'again':
      return TEXT.again;
    case 'off':
      return `${view.unsubscribed ? TEXT.offDone : TEXT.offBrowser}${view.deleted ? '' : ` ${TEXT.offPending}`}`;
    case 'cant-check':
      return view.storage ? TEXT.storageRow : "Can't check notifications on this device right now.";
    case 'legacy':
      return TEXT.legacy;
    case 'updating':
      return TEXT.updating;
    case 'none':
      return '';
  }
}

export function DeviceRow({ controller, onChange, onSetUp, names }: { controller: DeviceController; offices?: unknown; onChange: (choices: AlertChoices) => void; onSetUp: () => void; names: (id: number) => string }) {
  const [view, setView] = useState<RowView>(controller.view);
  const [note, setNote] = useState<string | null>(null);
  // The local stack's layout audit shows every state through this (VITE_LOCAL_DEBUG builds only; never released).
  if (import.meta.env.VITE_LOCAL_DEBUG === '1') (window as unknown as { __pengeRowView?: (v: RowView) => void }).__pengeRowView = setView;
  useEffect(() => {
    const off = controller.subscribe(setView);
    const run = () => void controller.reconcile().then(setView, () => undefined);
    run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', run);
    const timer = setInterval(() => {
      if (controller.view.kind === 'setting-up') run();
    }, 30_000);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', run);
      clearInterval(timer);
    };
  }, [controller]);

  if (view.kind === 'none') return null;
  return (
    <div className="device-row" role="status">
      <span>{rowText(view, names)}</span>
      {view.kind === 'on' && view.renewFailing && <span className="hint">{TEXT.renewFailing}</span>}
      {view.kind === 'on' && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={() => onChange(view.alert.choices)}>
            Change
          </button>
          <button type="button" className="link-button" onClick={() => void controller.test().then(setNote)}>
            Send a test
          </button>
          <button type="button" className="link-button" onClick={() => void controller.turnOff().then(setView, () => undefined)}>
            Turn off
          </button>
        </span>
      )}
      {/* Only Turn off interrupts: it is there whenever this device has something to stop. */}
      {(view.kind === 'setting-up' || view.kind === 'updating' || view.kind === 'cant-check') && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={() => void controller.turnOff().then(setView, () => undefined)}>
            Turn off
          </button>
        </span>
      )}
      {(view.kind === 'ended' || view.kind === 'again' || view.kind === 'blocked') && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={onSetUp}>
            Set up again
          </button>
        </span>
      )}
      {view.kind === 'off' && !(view.unsubscribed && view.deleted) && (
        <span className="device-actions">
          <button type="button" className="link-button" onClick={() => void controller.reconcile().then(setView)}>
            Try again
          </button>
        </span>
      )}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}
