import { type ReactNode, useEffect, useRef, useState } from 'react';
import { errorText } from '../api.ts';
import { tokenFromHash } from '../time.ts';

interface Props {
  token?: string;
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
export function useLinkToken() {
  const [current, setCurrent] = useState(() => ({ token: tokenFromHash(window.location.hash), hasFragment: !!window.location.hash, revision: 0 }));
  useEffect(() => {
    const read = () => {
      const token = tokenFromHash(window.location.hash);
      const hasFragment = !!window.location.hash;
      setCurrent((previous) => ({ token, hasFragment, revision: previous.revision + 1 }));
    };
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  return current;
}

export function TokenAction(props: Props) {
  const { token: fromHash, revision } = useLinkToken();
  const token = props.token ?? fromHash;
  // A new link starts a fresh action, even when the browser keeps this document.
  return <TokenActionBody key={`${revision}:${token ?? ''}`} {...props} token={token} />;
}

function TokenActionBody({ token, title, intro, button, isValid, act }: Omit<Props, 'token'> & { token: string | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReactNode>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);

  // Keep the token out of the address bar and history once it has been read.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [token]);
  useEffect(() => {
    if (result) panel.current?.focus();
  }, [result]);

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
    if (busy) return;
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
    <section className="panel" aria-live="polite" ref={panel} tabIndex={-1}>
      {result ?? (
        <>
          <h1>{title}</h1>
          {intro}
          {error && <p className="error">{error}</p>}
          <button type="button" className="btn btn-primary" onClick={go} aria-busy={busy} disabled={busy}>
            {busy ? 'Working…' : button}
          </button>
        </>
      )}
    </section>
  );
}
