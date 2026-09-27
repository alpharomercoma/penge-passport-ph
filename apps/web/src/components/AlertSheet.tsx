import { type Field, LIMITS, validateSubscribe } from '@penge/contracts';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type Api, ApiFailure, errorText } from '../api.ts';
import { matches, type Office, PARTY_SIZES, partyLabel } from '../office.ts';
import { CheckIcon, CloseIcon, SearchIcon } from './Icons.tsx';

interface Props {
  api: Api;
  offices: Office[];
  selected: number[];
  initialApplicants?: number;
  onSelectedChange: (ids: number[]) => void;
  onClose: () => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select, [tabindex="0"]';

/** The email form, as a modal sheet: from the bottom on phones, centred on wider screens. */
export function AlertSheet({ api, offices, selected, initialApplicants = 1, onSelectedChange, onClose }: Props) {
  const id = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [applicants, setApplicants] = useState(initialApplicants);
  const [website, setWebsite] = useState('');
  const [picking, setPicking] = useState(selected.length === 0);
  const [query, setQuery] = useState('');
  const [limitHit, setLimitHit] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const byId = useMemo(() => new Map(offices.map((o) => [o.id, o])), [offices]);
  const shown = useMemo(
    () => [...offices].filter((o) => matches(o, query)).sort((a, b) => a.place.localeCompare(b.place)),
    [offices, query],
  );

  // Focus moves into the sheet, the page behind stops scrolling, and focus goes back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = sheetRef.current?.querySelector<HTMLElement>(picking ? 'input[type="search"]' : 'input[type="email"]');
    first?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !sheetRef.current) return;
    const items = [...sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function toggle(officeId: number) {
    if (selected.includes(officeId)) {
      setLimitHit(false);
      onSelectedChange(selected.filter((s) => s !== officeId));
    } else if (selected.length >= LIMITS.sitesPerSubscription) {
      setLimitHit(true);
    } else {
      setLimitHit(false);
      onSelectedChange([...selected, officeId]);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const checked = validateSubscribe({ email, siteIds: selected, applicants, website }, new Set(offices.map((o) => o.id)));
    if (!checked.ok) {
      setErrors(checked.errors);
      if (checked.errors.siteIds) setPicking(true);
      else if (checked.errors.email) emailRef.current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      setSent(await api.subscribe({ ...checked.value, website }));
    } catch (err) {
      setErrors({ ...(err instanceof ApiFailure ? err.fields : {}), form: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
        <div className="sheet-head">
          <h2 id={`${id}-title`}>{sent ? 'Check your email' : 'Email me when dates open'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {sent ? (
          <div className="sheet-done" aria-live="polite">
            <CheckIcon />
            <p>{sent}</p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <fieldset className="field">
              <legend>Offices</legend>
              {selected.length > 0 && (
                <ul className="chips" aria-label="Chosen offices">
                  {selected.map((officeId) => {
                    const place = byId.get(officeId)?.place ?? `Office ${officeId}`;
                    return (
                      <li key={officeId}>
                        <button type="button" className="chip" onClick={() => toggle(officeId)} aria-label={`Remove ${place}`}>
                          {place}
                          <CloseIcon />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!picking ? (
                <button type="button" className="link-button" onClick={() => setPicking(true)}>
                  Add another office
                </button>
              ) : (
                <div className="picker">
                  <label className="search">
                    <SearchIcon />
                    <span className="sr-only">Search offices</span>
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search a city or mall"
                      autoComplete="off"
                      maxLength={60}
                    />
                  </label>
                  <div className="picker-list" role="group" aria-label="Offices">
                    {shown.length === 0 && <p className="hint">No office matches “{query}”.</p>}
                    {shown.map((o) => (
                      <label key={o.id} className="pick">
                        <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                        <span>
                          <span className="pick-place">{o.place}</span>
                          {o.detail && <span className="pick-detail">{o.detail}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <p className={limitHit ? 'hint hint-strong' : 'hint'}>
                {limitHit
                  ? `You can follow up to ${LIMITS.sitesPerSubscription} offices. Remove one to add another.`
                  : `Pick the offices you can get to, up to ${LIMITS.sitesPerSubscription}.`}
              </p>
              {errors.siteIds && <p className="error">{errors.siteIds}</p>}
            </fieldset>

            <div className="field">
              <label htmlFor={`${id}-email`}>Your email</label>
              <input
                ref={emailRef}
                id={`${id}-email`}
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                maxLength={LIMITS.emailMaxLength}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? `${id}-email-note ${id}-email-error` : `${id}-email-note`}
                placeholder="juan@example.com"
              />
              <p className="hint" id={`${id}-email-note`}>
                Our database and backups keep your address encrypted, and we use it only for these alerts. Unsubscribing deletes it; the last copies, in backups and mail-server logs, are gone within 14 days.
              </p>
              {errors.email && (
                <p className="error" id={`${id}-email-error`}>
                  {errors.email}
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor={`${id}-applicants`}>Booking for</label>
              <select id={`${id}-applicants`} value={applicants} onChange={(e) => setApplicants(Number(e.target.value))}>
                {PARTY_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {partyLabel(n)}
                  </option>
                ))}
              </select>
              <p className="hint">For a group, you only hear about dates with room for everyone.</p>
              {errors.applicants && <p className="error">{errors.applicants}</p>}
            </div>

            {/* Hidden from people; bots fill it in, and the server refuses them. */}
            <div className="hp" aria-hidden="true">
              <label htmlFor={`${id}-website`}>Website</label>
              <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>

            {errors.form && (
              <p className="error" role="alert">
                {errors.form}
              </p>
            )}
            <button type="submit" className="btn btn-primary btn-block" aria-busy={busy}>
              {busy ? 'Sending…' : 'Send confirmation email'}
            </button>
            <p className="hint sheet-fine">
              We email you a link first; nothing starts until you press it. At most 3 alerts a day, each with a one-click
              unsubscribe.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
