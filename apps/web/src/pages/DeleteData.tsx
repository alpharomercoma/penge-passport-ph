import { isToken, LIMITS, normalizeEmail } from '@penge/contracts';
import { type FormEvent, useEffect, useState } from 'react';
import { type Api, errorText } from '../api.ts';
import { TokenAction, useLinkToken } from '../components/TokenAction.tsx';
import { BASE } from '../links.ts';
import { rowText } from '../components/DeviceRow.tsx';
import { browserEnv } from '../devices/browser.ts';
import { TEXT } from '../devices/controller.ts';
import { deviceController } from '../devices/instance.ts';
import { readState } from '../devices/state.js';

/** Available before an alert arrives, and after someone loses their email links. */
export function DeleteData({ api }: { api: Api }) {
  const { token, hasFragment, revision } = useLinkToken();
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    document.title = 'Delete alert data | PengePassportPH';
    if (!isToken(token) && window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [token]);

  if (isToken(token)) {
    return (
      <>
        <TokenAction
          key={revision}
          token={token}
          title="Delete your alert data"
          intro={<p>Press the button to stop every alert, delete your email address and office choices, and cancel unused sign-up links.</p>}
          button="Delete my alert data"
          isValid={isToken}
          act={async (link) => {
            await api.deleteData(link);
            return <><h1>Your alert data is deleted</h1><p>Alerts are stopped and unused sign-up links are cancelled. The last copies in encrypted backups and mail-server logs are gone within 14 days. Anonymous totals and temporary abuse-prevention counters remain as described in our privacy policy.</p></>;
          }}
        />
        <p className="prose"><a href={`${BASE}delete-data`}>Request a new deletion link</a> · <a href={`${BASE}privacy`}>Privacy</a></p>
      </>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const address = normalizeEmail(email);
    if (!address) { setError('Enter a valid email address, like juan@example.com.'); return; }
    setBusy(true);
    setError(null);
    try { setMessage(await api.requestDeletion(address, website)); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <section className="prose">
      <h1>Stop alerts and delete your data</h1>
      {hasFragment && <p className="error" role="alert">This deletion link is incomplete or invalid. Open the whole link from your email, or request a new link below.</p>}
      <h2>Email alerts</h2>
      <p>Enter the address you used for PengePassportPH alerts. You can do this before your first alert arrives or if you lost the unsubscribe link.</p>
      <p>We send a deletion link to the address you enter, whether or not it is subscribed. Nothing is deleted until you open the link and press the button. The link works for 48 hours.</p>
      {message ? <p role="status">{message}</p> : (
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="deletion-email">Your email</label>
            <input id="deletion-email" type="email" inputMode="email" autoComplete="email" maxLength={LIMITS.emailMaxLength} value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? 'deletion-error' : undefined} />
          </div>
          <div className="hp" aria-hidden="true">
            <label>Website<input name="website" value={website} onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} autoComplete="off" /></label>
          </div>
          {error && <p className="error" id="deletion-error" role="alert">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? 'Sending…' : 'Email me a deletion link'}</button>
        </form>
      )}
      <p>Deletion removes your address, alert choices, waiting alerts, and unused sign-up links from our database. The last copies in encrypted backups and mail-server logs are gone within 14 days. Temporary abuse-prevention counters and anonymous totals follow the retention periods in our <a href={`${BASE}privacy`}>privacy policy</a>.</p>
      <h2>This device</h2>
      <DeviceDeletion />
    </section>
  );
}

function DeviceDeletion() {
  // Checking, none, present, or unknown (the storage could not be read): only a browser without storage has none for sure.
  const [state, setState] = useState<'checking' | 'none' | 'has' | 'unknown'>('checking');
  const [result, setResult] = useState<{ text: string; done: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const check = () => {
    setState('checking');
    if (!window.indexedDB) return setState('none');
    void readState(browserEnv()).then(
      (s) => setState(s.credential || s.retired.length > 0 || s.claim ? 'has' : 'none'),
      () => setState('unknown'),
    );
  };
  useEffect(check, []);
  const turnOff = () => {
    if (busy) return;
    setBusy(true);
    void deviceController(() => null)
      .turnOff()
      .then(
        // Done only when the browser stopped the subscription and our server deleted it; else it can be tried again.
        (v) => setResult({ text: rowText(v, (id) => `Office ${id}`) || TEXT.offDone, done: v.kind === 'off' && v.unsubscribed && v.deleted }),
        () => setResult({ text: "Couldn't turn notifications off just now. Try again.", done: false }),
      )
      .finally(() => setBusy(false));
  };
  if (state === 'checking') return <p>Checking this device…</p>;
  if (state === 'unknown')
    return (
      <>
        <p>This device's notifications can't be checked right now.</p>
        <button type="button" className="btn btn-secondary" onClick={check}>Try again</button>
      </>
    );
  if (state === 'none') return <p>This device has no notification alert.</p>;
  return (
    <>
      <p>Turning notifications off on this device stops them here and deletes them from our server. It does not touch email alerts.</p>
      {result && <p role="status">{result.text}</p>}
      {!result?.done && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={turnOff}>
          {result ? 'Try again' : 'Turn off notifications on this device'}
        </button>
      )}
    </>
  );
}
