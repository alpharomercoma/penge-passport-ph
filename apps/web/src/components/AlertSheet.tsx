import { type DeviceState, type Field, LIMITS, PACE_LABELS, PACES, type Pace, type StatusResponse, validateSubscribe } from '@penge/contracts';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Api, ApiFailure, errorText } from '../api.ts';
import { AREAS } from '../areas.ts';
import { type Context, detectContext, deviceLabel, ownerOverride, pushCapability } from '../notify/context.ts';
import { enablePush, postToApi, PUSH_CHANGED, pushEnv } from '../notify/push.ts';
import { markRequested, reconcile } from '../notify/shared.js';
import { registration } from '../notify/worker.ts';
import { matches, type Office, PARTY_SIZES, partyLabel } from '../office.ts';
import { CheckIcon, CloseIcon, SearchIcon } from './Icons.tsx';

interface Props {
  api: Api;
  /** What the server allows: whether push can be offered, and its key. */
  status: StatusResponse;
  offices: Office[];
  selected: number[];
  initialApplicants?: number;
  onSelectedChange: (ids: number[]) => void;
  onClose: () => void;
}

/** The picker's chips: the four areas at home, and every post abroad. */
const PICK_AREAS = [...AREAS, 'Abroad'] as const;
const pickArea = (o: Office) => (o.country ? 'Abroad' : o.area);

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select, [tabindex="0"]';

/** The email form, as a modal sheet: from the bottom on phones, centred on wider screens. */
export function AlertSheet({ api, status, offices, selected, initialApplicants = 1, onSelectedChange, onClose }: Props) {
  const id = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [applicants, setApplicants] = useState(initialApplicants);
  const [pace, setPace] = useState<Pace>('hourly');
  const [website, setWebsite] = useState('');
  const [picking, setPicking] = useState(selected.length === 0);
  const [query, setQuery] = useState('');
  // No area chosen shows every office; tapping the chosen area again clears it.
  const [area, setArea] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [emailOn, setEmailOn] = useState(true);
  const [pushOn, setPushOn] = useState(false);
  const [pushHash, setPushHash] = useState<string | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const context = useMemo(() => detectContext(), []);
  // The switch appears only once the service worker has registered: null while unknown.
  const [workerOk, setWorkerOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void registration().then((r) => live && setWorkerOk(!!r));
    return () => {
      live = false;
    };
  }, []);
  const capability = useMemo(() => {
    // What the browser and the server allow does not wait for the worker (so an iPhone tab
    // says so at once); only the switch itself waits until the worker has registered.
    const base = pushCapability(window, status, { owner: ownerOverride(), workerOk: true });
    if (!base.ok) return base;
    if (workerOk === null) return { ok: false, reason: 'off' } as const;
    return workerOk ? base : ({ ok: false, reason: 'no-worker' } as const);
  }, [status, workerOk]);
  // Blocked already: say how to allow it as soon as the switch shows, without asking.
  useEffect(() => {
    if (capability.ok && 'Notification' in window && Notification.permission === 'denied') setPushNote(BLOCKED[context]);
  }, [capability.ok]);

  const BLOCKED: Record<Context, string> = {
    browser: /Firefox\//.test(navigator.userAgent)
      ? 'Notifications are blocked for this site. Allow them from the padlock in the address bar, then try again.'
      : 'Notifications are blocked for this site. Allow them in the site settings (the icon left of the address), then try again.',
    installed: 'Notifications are blocked for this app. Allow them in your browser or phone settings, then try again.',
    play: "Allow notifications for PassportPH in your phone's Settings › Apps, then try again.",
  };

  // Turning push on asks the browser once: a second press while it asks does nothing.
  const enabling = useRef(false);
  const [pushPending, setPushPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on setup: development's StrictMode runs setup, clean-up, setup.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Push no longer offered (switched off on the server while the sheet was open): drop it, keep a channel.
  useEffect(() => {
    if (capability.ok || !pushOn) return;
    setPushOn(false);
    setPushHash(null);
    setEmailOn(true);
  }, [capability.ok, pushOn]);
  // Whether the request that was sent asked for push: the waiting view follows it, not the switch.
  const [sentPush, setSentPush] = useState(false);

  function togglePush() {
    if (enabling.current || busy) return;
    if (pushOn) {
      setPushOn(false);
      setPushHash(null);
      if (!emailOn) setEmailOn(true);
      return;
    }
    setPushNote(null);
    enabling.current = true;
    // No await before this: the browser must see the permission request as part of the click.
    void enablePush({ vapidPublicKey: status.vapidPublicKey! }).then((r) => {
      enabling.current = false;
      if (!mounted.current) return;
      setPushPending(false);
      if (r.ok) {
        setPushOn(true);
        setPushHash(r.credentialHash);
        return;
      }
      // Push did not come on: turn email back on, so a channel is always on.
      setEmailOn(true);
      setPushNote(
        r.reason === 'denied' ? BLOCKED[context]
        : r.reason === 'no-worker' ? 'Notifications need the site to finish loading. Reload the page and try again.'
        : r.reason === 'subscribe-failed' ? 'This browser would not turn notifications on (private windows often refuse). Email still works.'
        : null,
      );
    });
    setPushPending(true);
  }
  const [pushAnswer, setPushAnswer] = useState<{ state: DeviceState; subscribed: boolean } | null>(null);
  useEffect(() => {
    if (!sent || !sentPush) return;
    let live = true;
    let last = '';
    const tick = async () => {
      const reg = await registration();
      if (!reg || !live) return;
      const answer = await reconcile(pushEnv(), { registration: reg, post: postToApi, permission: Notification.permission }).catch(() => null);
      if (!live || !answer) return;
      setPushAnswer(answer);
      // Shared with the row, only when it changed: the row takes it as is, without asking the server again.
      const key = `${answer.state}|${answer.subscribed}`;
      if (key !== last) {
        last = key;
        window.dispatchEvent(new CustomEvent(PUSH_CHANGED, { detail: answer }));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 30_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sent, sentPush]);

  const byId = useMemo(() => new Map(offices.map((o) => [o.id, o])), [offices]);
  // Offices at home first, then posts abroad by country, each by place.
  const shown = useMemo(
    () =>
      offices
        .filter((o) => (!area || pickArea(o) === area) && matches(o, query))
        .sort((a, b) => (a.country ?? '').localeCompare(b.country ?? '') || a.place.localeCompare(b.place)),
    [offices, query, area],
  );
  const areas = PICK_AREAS.filter((a) => offices.some((o) => pickArea(o) === a));

  // Focus moves into the sheet, the page behind stops scrolling, and focus goes back on close.
  useEffect(() => {
    const sheet = sheetRef.current!;
    const opener = document.activeElement as HTMLElement | null;
    const first = sheetRef.current?.querySelector<HTMLElement>(picking ? 'input[type="search"]' : 'input[type="email"]');
    first?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // The sheet lives inside main: disable siblings at each ancestor level,
    // including the header/footer, without disabling the sheet itself.
    const background: { element: HTMLElement; inert: boolean }[] = [];
    for (let branch: HTMLElement | null = sheet.parentElement; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      if (branch.parentElement === document.body) break;
    }
    const items = () => [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]'));
    const keepFocus = (event: FocusEvent) => {
      if (!sheet.contains(event.target as Node)) (items()[0] ?? sheet).focus();
    };
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const focusable = items();
        const first = focusable[0];
        const last = focusable.at(-1);
        const active = document.activeElement;
        if (!sheet.contains(active) || active === sheet || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener('focusin', keepFocus);
    document.addEventListener('keydown', keys, true);
    return () => {
      document.removeEventListener('focusin', keepFocus);
      document.removeEventListener('keydown', keys, true);
      for (const { element, inert } of background) element.inert = inert;
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const selector = sent ? '.sheet-done button' : picking ? 'input[type="search"]' : 'input[type="email"]';
    sheetRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [picking, sent]);

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
    // Not while push is half on: the request would say off, then push would come on unasked.
    if (busy || enabling.current) return;
    const channels = { emailOn, pushOn, pushCredentialHash: pushOn ? pushHash : null, device: pushOn ? deviceLabel(navigator.userAgent) : null };
    const checked = validateSubscribe({ email, siteIds: selected, applicants, pace, website, channels }, new Set(offices.map((o) => o.id)));
    if (!checked.ok) {
      setErrors(checked.errors);
      if (checked.errors.siteIds) setPicking(true);
      else if (checked.errors.email) emailRef.current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const message = await api.subscribe({ ...checked.value, website });
      // The 48 hours a fresh credential is kept for count from this request.
      if (checked.value.channels?.pushOn) await markRequested(pushEnv()).catch(() => undefined);
      setSentPush(checked.value.channels?.pushOn === true);
      setSent(message);
    } catch (err) {
      setErrors({ ...(err instanceof ApiFailure ? err.fields : {}), form: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <div className="sheet-head">
          <h2 id={`${id}-title`}>{sent ? 'Check your email' : 'Tell me when dates open'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {sent ? (
          <div className="sheet-done" aria-live="polite">
            <CheckIcon />
            <p>{sent}</p>
            {sentPush && <p className="hint">{pushLine(pushAnswer)}</p>}
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
                      placeholder="Search a city, mall or country"
                      autoComplete="off"
                      maxLength={60}
                    />
                  </label>
                  {areas.length > 1 && (
                    <div className="chips-row" role="group" aria-label="Area">
                      {areas.map((a) => (
                        <button key={a} type="button" className="filter-chip" aria-pressed={area === a} onClick={() => setArea(area === a ? null : a)}>
                          {a}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="picker-list" role="group" aria-label="Offices">
                    {shown.length === 0 && (
                      <p className="hint">
                        No office matches{query ? ` “${query}”` : ''}
                        {area ? (area === 'Abroad' ? ' abroad' : ` in ${area}`) : ''}.
                      </p>
                    )}
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

            <div className="field">
              <label htmlFor={`${id}-pace`}>How often</label>
              <select id={`${id}-pace`} value={pace} onChange={(e) => setPace(e.target.value as Pace)}>
                {PACES.map((p) => (
                  <option key={p} value={p}>
                    {PACE_LABELS[p]}
                  </option>
                ))}
              </select>
              <p className="hint">
                {pace === 'hourly'
                  ? 'One email with everything new since the last one, at most once an hour.'
                  : 'One email from each check that finds dates; checks run every 5 minutes.'}{' '}
                Dates that closed in the meantime are left out.
              </p>
              {errors.pace && <p className="error">{errors.pace}</p>}
            </div>

                        <fieldset className="field channels">
                          <legend>How should we tell you?</legend>
                          <button type="button" role="switch" className="switch" aria-checked={emailOn} onClick={() => !busy && setEmailOn(!emailOn)}>
                            <span className="switch-track" aria-hidden="true" /> Email
                          </button>
                          {capability.ok ? (
                            <>
                              <button type="button" role="switch" className="switch" aria-checked={pushOn} aria-busy={pushPending || undefined} onClick={togglePush}>
                                <span className="switch-track" aria-hidden="true" /> {context === 'browser' ? 'Browser notifications' : 'Notifications on this device'}
                              </button>
                              {context === 'browser' && <p className="hint">Works best in the app: add it to your home screen or get it on Google Play.</p>}
                            </>
                          ) : capability.reason === 'ios-tab' ? (
                            <p className="hint">To get notifications on iPhone, add this site to your Home Screen, then open it from there.</p>
                          ) : capability.reason === 'unsupported' ? (
                            <p className="hint">This browser can’t show notifications. Email still works.</p>
                          ) : capability.reason === 'no-worker' ? (
                            <p className="hint">Notifications need the site to finish loading. Reload the page to turn them on; email still works.</p>
                          ) : null}
                          {pushNote && <p className="hint hint-strong">{pushNote}</p>}
                          {errors.channels && <p className="error">{errors.channels}</p>}
                        </fieldset>

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
            {pushOn ? (
              <p className="hint sheet-fine">We email you a link first, even for notifications only; nothing starts until you press it.</p>
            ) : (
              <p className="hint sheet-fine">
                We email you a link first; nothing starts until you press it. Every alert has a one-click unsubscribe.
              </p>
            )}
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** What the waiting sheet says about this device: "on" needs the server, the permission and the browser to agree. */
function pushLine(a: { state: DeviceState; subscribed: boolean } | null): string {
  if (!a) return 'Waiting for you to confirm by email.';
  if (Notification.permission === 'denied') return 'Notifications are blocked on this device. Allow them in your browser or phone settings.';
  if (a.state === 'registered' && a.subscribed && Notification.permission === 'granted') return 'Notifications are on for this device.';
  // Confirmed, but this browser lost its subscription and may no longer ask without being told to.
  if ((a.state === 'registered' || a.state === 'awaiting') && !a.subscribed && Notification.permission === 'default') {
    return 'Allow notifications for this site again in your browser or phone settings, then open the app to finish.';
  }
  if (a.state === 'missing') return 'Notifications were not turned on for this device. Fill in the form again to try once more.';
  if (a.state === 'stale' || a.state === 'endpoint-taken') return 'Notifications are still being set up on this device.';
  return 'Waiting for you to confirm by email.';
}
