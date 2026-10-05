// "Notifications on this device", for a browser that turned push on: its state
// as the server and the browser see it now, a test, and a way to turn it off.
import type { DeviceState, StatusResponse } from '@penge/contracts';
import { useEffect, useRef, useState } from 'react';
import { type Api, errorText } from '../api.ts';
import { PUSH_CHANGED, pushEnv, postToApi } from '../notify/push.ts';
import { readState, reconcile, turnOff } from '../notify/shared.js';
import { registration } from '../notify/worker.ts';

type Shown = { kind: 'none' } | { kind: 'state'; state: DeviceState; blocked: boolean; ready: boolean } | { kind: 'off'; noChannel: boolean };

/** `hidden`: still checks this device (a renewed subscription is registered on every open), shows nothing. */
export function DeviceRow({ api, status, hidden = false }: { api: Api; status: StatusResponse; hidden?: boolean }) {
  const [shown, setShown] = useState<Shown>({ kind: 'none' });
  const [note, setNote] = useState<string | null>(null);
  // Read by the timer: whether this device is still waiting (a state updater must stay pure).
  const current = useRef<Shown>(shown);
  current.current = shown;
  // Runs whatever the push mode: with push switched off for an emergency, a device
  // that has it on must still be able to see that and turn it off.
  useEffect(() => {
    if (!('Notification' in window)) return;
    let live = true;
    const refresh = async () => {
      const env = pushEnv();
      // Turned off in another tab (the credential is gone): say so, if this row was showing it.
      const gone = () => {
        if (live && current.current.kind === 'state') setShown({ kind: 'state', state: 'missing', blocked: false, ready: false });
      };
      if (!(await readState(env)).credential) return gone();
      const reg = await registration();
      if (!reg || !live) return;
      const answer = await reconcile(env, { registration: reg, post: postToApi, permission: Notification.permission });
      if (!answer) return gone();
      if (live) {
        setShown({ kind: 'state', state: answer.state, blocked: Notification.permission === 'denied', ready: Notification.permission === 'granted' && answer.subscribed });
      }
    };
    const run = () => void refresh().catch(() => undefined);
    run();
    // Again when the sheet or the confirmation page changes this browser's push state. The
    // sheet sends what it just learned, so the row takes it without asking the server again
    // (the sheet and the row together stay at two calls a minute, within the device limit).
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ state: DeviceState; subscribed: boolean } | undefined>).detail;
      if (detail && live) setShown({ kind: 'state', state: detail.state, blocked: Notification.permission === 'denied', ready: Notification.permission === 'granted' && detail.subscribed });
      else run();
    };
    window.addEventListener(PUSH_CHANGED, onChange);
    // Back from the browser's or the phone's settings: look again (permission may have changed).
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', run);
    let permission: PermissionStatus | null = null;
    void navigator.permissions?.query({ name: 'notifications' as PermissionName }).then(
      (p) => {
        // Gone already (StrictMode's first mount, or a quick unmount): nothing to listen for.
        if (!live) return;
        permission = p;
        p.addEventListener('change', run);
      },
      () => undefined,
    );
    const timer = setInterval(() => {
      const now = current.current;
      if (live && now.kind === 'state' && (now.state === 'pending' || now.state === 'awaiting')) run();
    }, 30_000);
    return () => {
      live = false;
      window.removeEventListener(PUSH_CHANGED, onChange);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', run);
      permission?.removeEventListener('change', run);
      clearInterval(timer);
    };
  }, []);

  async function off() {
    setNote(null);
    try {
      const reg = await registration();
      if (!reg) return;
      const answer = await turnOff(pushEnv(), { registration: reg, post: postToApi });
      setShown({ kind: 'off', noChannel: !!answer?.noChannel });
    } catch (err) {
      // Still on: say why, and leave the button to try again.
      setNote(errorText(err));
    }
  }
  async function test() {
    setNote(null);
    try {
      const { credential } = await readState(pushEnv());
      if (!credential) {
        setNote('Notifications are off for this device.');
        return;
      }
      await api.pushTest(credential);
      setNote('Sent. It should arrive in a few seconds.');
    } catch (err) {
      setNote(errorText(err));
    }
  }

  if (shown.kind === 'none' || hidden) return null;
  if (shown.kind === 'off') {
    return (
      <p className="device-row" role="status">
        Notifications are off for this device.{shown.noChannel && ' You will get no alerts now: fill in the alert form to choose email or notifications again.'}
      </p>
    );
  }
  if (shown.state === 'missing') {
    return <p className="device-row">Notifications are off for this device. Fill in the alert form to turn them on again.</p>;
  }
  if (shown.blocked) {
    return (
      <div className="device-row">
        <span>Notifications are blocked on this device.</span>
        <button type="button" className="link-button" onClick={off}>
          Turn off
        </button>
        {note && <p className="hint">{note}</p>}
      </div>
    );
  }
  // Confirmed, but this browser cannot subscribe until notifications are allowed again: waiting will not do it.
  if (shown.state === 'awaiting' && !shown.ready && 'Notification' in window && Notification.permission === 'default') {
    return (
      <div className="device-row">
        <span>Notifications are not allowed on this device yet. Allow them in your browser or phone settings.</span>
        <button type="button" className="link-button" onClick={off}>
          Turn off
        </button>
        {note && <p className="hint">{note}</p>}
      </div>
    );
  }
  if (shown.state === 'pending' || shown.state === 'awaiting') {
    return (
      <div className="device-row">
        <span>Waiting for you to confirm by email.</span>
        <button type="button" className="link-button" onClick={off}>
          Cancel
        </button>
        {note && <p className="hint">{note}</p>}
      </div>
    );
  }
  if (shown.state === 'registered' && !shown.ready) {
    return (
      <div className="device-row">
        <span>Notifications are not allowed on this device yet. Allow them in your browser or phone settings.</span>
        <button type="button" className="link-button" onClick={off}>
          Turn off
        </button>
        {note && <p className="hint">{note}</p>}
      </div>
    );
  }
  if (shown.state === 'stale' || shown.state === 'endpoint-taken') {
    return (
      <div className="device-row">
        <span>Notifications need setting up again on this device.</span>
        <button type="button" className="link-button" onClick={off}>
          Turn off
        </button>
        {note && <p className="hint">{note}</p>}
      </div>
    );
  }
  return (
    <div className="device-row">
      <span>Notifications on this device: On</span>
      <button type="button" className="link-button" onClick={test}>
        Send a test
      </button>
      <button type="button" className="link-button" onClick={off}>
        Turn off
      </button>
      {note && <p className="hint">{note}</p>}
    </div>
  );
}
