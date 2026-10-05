import { type ConfirmPreview, formatDate, isToken } from '@penge/contracts';
import type { Api } from '../api.ts';
import { CheckIcon } from '../components/Icons.tsx';
import { TokenAction } from '../components/TokenAction.tsx';
import { BASE } from '../links.ts';
import { postToApi, pushEnv } from '../notify/push.ts';
import { credentialHash, readState, reconcile } from '../notify/shared.js';
import { registration } from '../notify/worker.ts';
import { plural } from '../office.ts';

export function Confirm({ api }: { api: Api }) {
  return (
    <TokenAction
      title="Confirm your alert"
      intro={<p>Loading what this link will do…</p>}
      button="Confirm alert"
      isValid={isToken}
      prepare={async (token) => {
        const p = await api.previewConfirm(token);
        const c = p.channels;
        return {
          data: p,
          intro: (
            <>
              <p>
                This turns on alerts for {plural(p.siteIds.length, 'office')}, for {p.applicants === 1 ? 'one person' : `${p.applicants} people`},{' '}
                {p.pace === 'asap' ? 'as soon as a check finds dates' : 'at most once an hour'}.
              </p>
              {c && (
                <ul className="channels-preview">
                  <li>Email: {c.emailOn ? 'on' : 'off'}</li>
                  <li>
                    Notifications: {c.pushOn ? `on, for the device and browser that asked (${c.device ?? 'a browser'}, ${manilaWhen(c.requestedAt)})` : 'none added by this request'}
                  </li>
                  {c.devicesKept > 0 && <li>{c.devicesKept === 1 ? 'The 1 device that already gets notifications keeps them.' : `The ${c.devicesKept} devices that already get notifications keep them.`}</li>}
                </ul>
              )}
              <p className="hint">If you did not ask for this, close this page: nothing changes.</p>
            </>
          ),
        };
      }}
      act={async (token, data) => {
        const p = data as ConfirmPreview;
        const ack = p.channels ? { emailOn: p.channels.emailOn, pushOn: p.channels.pushOn } : undefined;
        const r = await api.confirm(token, ack);
        // The confirmation has succeeded whatever happens below: registering this
        // browser is a second step, and its trouble is shown, not thrown.
        let here: 'on' | 'waiting' | 'blocked' | 'allow' | 'retry' | 'elsewhere' | null = null;
        if (r.channels.push === 'bound' || r.channels.push === 'kept') {
          try {
            const env = pushEnv();
            const state = await readState(env);
            const mine = state.credential && p.channels?.pushCredentialHash && (await credentialHash(env, state.credential)) === p.channels.pushCredentialHash;
            if (!mine) here = 'elsewhere';
            else if (Notification.permission === 'denied') here = 'blocked';
            // Permission back to "ask": this page cannot ask (no click to ask in), and waiting will not help.
            else if (Notification.permission === 'default') here = 'allow';
            else {
              const reg = await registration();
              const answer = reg ? await reconcile(env, { registration: reg, post: postToApi, permission: Notification.permission }) : null;
              const ready = answer?.state === 'registered' && answer.subscribed && Notification.permission === 'granted';
              here = ready ? 'on' : answer?.state === 'registered' || answer?.state === 'awaiting' || answer?.state === 'pending' ? 'waiting' : 'retry';
            }
          } catch {
            here = 'retry';
          }
        }
        return (
          <>
            <CheckIcon />
            <h1>{r.status === 'updated' ? 'Your alert is updated' : 'You are subscribed'}</h1>
            <p>
              {r.channels.emailOn ? 'We will email you' : 'We will tell you'} when a date opens at {plural(r.siteIds.length, 'office')}, for{' '}
              {r.applicants === 1 ? 'one person' : `${r.applicants} people`}, {r.pace === 'asap' ? 'as soon as a check finds dates' : 'at most once an hour'}.
            </p>
            {here === 'on' && <p>Notifications are on for this device.</p>}
            {here === 'waiting' && <p>Notifications are almost ready on this device. Keep the app open for a moment, or open it again later.</p>}
            {here === 'allow' && <p>Notifications are not allowed on this device yet. Allow them in your browser or phone settings, then open the app again.</p>}
            {here === 'blocked' && <p>Notifications are blocked on this device. Allow them in your browser or phone settings, then open the app again.</p>}
            {here === 'retry' && <p>Notifications could not be set up on this device yet. Open the app again in a moment to finish.</p>}
            {here === 'elsewhere' && <p>Notifications are on for the device where you asked for them. Open the app there once to finish.</p>}
            {r.channels.push.startsWith('skipped') && <p className="hint">Notifications were not turned on: {SKIPPED[r.channels.push]}</p>}
            <p>
              <a className="btn btn-secondary" href={BASE}>See open dates now</a>
            </p>
            <p><a href={`${BASE}delete-data`}>Stop alerts and delete your data</a></p>
          </>
        );
      }}
    />
  );
}

const SKIPPED: Record<string, string> = {
  'skipped-owned': 'that device already gets alerts for another email address.',
  'skipped-revoked': 'they were turned off on that device. Fill in the form again to turn them back on.',
  'skipped-off': 'they are not available right now.',
};

/** The same Manila time as the confirmation email: "Mon 5 Oct, 10:02". */
function manilaWhen(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  return `${formatDate(d.toISOString().slice(0, 10)).replace(/ \d{4}$/, '')}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
