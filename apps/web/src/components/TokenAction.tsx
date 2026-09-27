import { type ReactNode, useEffect, useState } from 'react';
import { errorText } from '../api.ts';
import { tokenFromHash } from '../time.ts';

interface Props {
  title: string;
  intro: ReactNode;
  button: string;
  isValid: (token: string) => boolean;
  act: (token: string) => Promise<ReactNode>;
}

/**
 * A page that acts on a link from an email only when the reader presses the
 * button: mail scanners that open every link change nothing.
 */
export function TokenAction({ title, intro, button, isValid, act }: Props) {
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReactNode>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the token out of the address bar and history once it has been read.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  if (!token || !isValid(token)) {
    return (
      <section className="panel">
        <h1>{title}</h1>
        <p className="error">
          This link is incomplete. Open it straight from the email, or copy the whole link into your browser.
        </p>
      </section>
    );
  }

  async function go() {
    setBusy(true);
    setError(null);
    try {
      setResult(await act(token!));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-live="polite">
      {result ?? (
        <>
          <h1>{title}</h1>
          {intro}
          {error && <p className="error">{error}</p>}
          <button type="button" className="btn btn-primary" onClick={go} aria-busy={busy}>
            {busy ? 'Working…' : button}
          </button>
        </>
      )}
    </section>
  );
}
