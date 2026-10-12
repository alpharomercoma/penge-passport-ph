import { type AlertChoices, type Field, LIMITS, PACE_LABELS, PACES, type Pace, type StatusResponse, validateChoices, validateSubscribe } from '@penge/contracts';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Api, ApiFailure, errorText } from '../api.ts';
import { AREAS } from '../areas.ts';
import type { DeviceController, SetupResult } from '../devices/controller.ts';
import { ownerToken } from '../devices/owner.ts';
import { type Context, detectContext, pushCapability } from '../notify/context.ts';
import { registration } from '../notify/worker.ts';
import { matches, type Office, PARTY_SIZES, partyLabel } from '../office.ts';
import { CheckIcon, CloseIcon, SearchIcon } from './Icons.tsx';

interface Props {
  api: Api;
  status: StatusResponse;
  offices: Office[];
  selected: number[];
  initialApplicants?: number;
  onSelectedChange: (ids: number[]) => void;
  onClose: () => void;
  /** This page's notification controller; null where notifications cannot be set up. */
  controller: DeviceController | null;
  /** From "Change" on the device row: edit only this device's alert. */
  change?: AlertChoices;
}

const PICK_AREAS = [...AREAS, 'Abroad'] as const;
const pickArea = (o: Office) => (o.country ? 'Abroad' : o.area);
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select, [tabindex="0"]';

type Outcome = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; ok: boolean; text: string; retry: boolean };
const IDLE: Outcome = { kind: 'idle' };

/** The alerts form, as a modal sheet: from the bottom on phones, centred on wider screens. */
export function AlertSheet({ api, status, offices, selected, initialApplicants = 1, onSelectedChange, onClose, controller, change }: Props) {
  const id = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [applicants, setApplicants] = useState(change?.applicants ?? initialApplicants);
  const [pace, setPace] = useState<Pace>(change?.pace ?? 'hourly');
  const [website, setWebsite] = useState('');
  const [picking, setPicking] = useState(selected.length === 0);
  const [query, setQuery] = useState('');
  const [area, setArea] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [emailOn, setEmailOn] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // Each kind of alert's outcome for the last submission; a retry reuses that submission's snapshot.
  const [emailOutcome, setEmailOutcome] = useState<Outcome>(IDLE);
  const [notifyOutcome, setNotifyOutcome] = useState<Outcome>(IDLE);
  const snapshot = useRef<{ choices: AlertChoices; email: string } | null>(null);
  // Set in the same tick as the press, before any await or render: a second press (or a retry) while one runs does nothing.
  /** Each kind of alert's request in flight: a submit waits for both; each retry only for its own kind. */
  const busyRef = useRef({ email: false, notify: false });
  const context = useMemo(() => detectContext(), []);
  const [workerOk, setWorkerOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void registration().then((r) => live && setWorkerOk(!!r));
    return () => {
      live = false;
    };
  }, []);
  const capability = useMemo(() => {
    const base = pushCapability(window, status, { owner: ownerToken() !== null, workerOk: true });
    if (!base.ok) return base;
    if (workerOk === null || !controller) return { ok: false, reason: 'off' } as const;
    return workerOk ? base : ({ ok: false, reason: 'no-worker' } as const);
  }, [status, workerOk, controller]);

  const BLOCKED: Record<Context, string> = {
    browser: /Firefox\//.test(navigator.userAgent)
      ? 'Notifications are blocked for this site. Allow them from the padlock in the address bar, then try again.'
      : 'Notifications are blocked for this site. Allow them in the site settings (the icon left of the address), then try again.',
    installed: 'Notifications are blocked for this app. Allow them in your browser or phone settings, then try again.',
    play: "Allow notifications for PassportPH in your phone's Settings › Apps, then try again.",
  };
  useEffect(() => {
    if (capability.ok && 'Notification' in window && Notification.permission === 'denied') setNotifyNote(BLOCKED[context]);
    // Only when the switch first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capability.ok]);
  // Notifications no longer available here (the server turned them off, say): the hidden switch is off too.
  useEffect(() => {
    if (!capability.ok) setNotifyOn(false);
  }, [capability.ok]);

  // Changing any choice after a submission makes the next press a new submission. While a submission runs the form's
  // controls are disabled (a fieldset), so its outcomes always belong to the choices shown.
  const submission = useRef(0);
  useEffect(() => {
    if (busyRef.current.email || busyRef.current.notify) return;
    submission.current++;
    snapshot.current = null;
    setEmailOutcome(IDLE);
    setNotifyOutcome(IDLE);
  }, [selected, applicants, pace]);
  // The address is email's alone: changing it resets email's outcome, never a notification setup that succeeded.
  useEffect(() => {
    if (busyRef.current.email) return;
    submission.current++;
    setEmailOutcome(IDLE);
  }, [email]);

  function toggleNotify() {
    if (asking) return;
    if (notifyOn) {
      setNotifyOn(false);
      return;
    }
    setNotifyNote(null);
    if (Notification.permission === 'granted') {
      setNotifyOn(true);
      return;
    }
    if (Notification.permission === 'denied') {
      setNotifyNote(BLOCKED[context]);
      return;
    }
    setAsking(true);
    // Inside the tap, before anything else awaits: the browser must see the request as the person's.
    void Notification.requestPermission().then((p) => {
      setAsking(false);
      if (p === 'granted') setNotifyOn(true);
      else if (p === 'denied') setNotifyNote(BLOCKED[context]);
      // Dismissed: back off, nothing said.
    });
  }

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
    // The search while picking, else the first switch; the change form has none: its first control, else the dialog.
    const first = sheet.querySelector<HTMLElement>(picking ? 'input[type="search"]' : 'button[role="switch"]') ?? sheet.querySelector<HTMLElement>('select, input, button:not([aria-label="Close"])') ?? sheet;
    first.focus();
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
    // Not hidden, and not disabled (a disabled fieldset disables what it holds while a request runs).
    const items = () => [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && !el.matches(':disabled'));
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
    sheetRef.current?.querySelector<HTMLElement>(picking ? 'input[type="search"]' : 'button[role="switch"]')?.focus();
  }, [picking]);

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

  const label = change
    ? 'Save'
    : notifyOn && emailOn
      ? 'Turn on notifications and send confirmation email'
      : notifyOn
        ? 'Turn on notifications'
        : 'Send confirmation email';
  const canSend = change ? true : emailOn || notifyOn;

  async function runEmail(s: { choices: AlertChoices; email: string }) {
    const mine = submission.current;
    setEmailOutcome({ kind: 'busy' });
    const checked = validateSubscribe({ email: s.email, ...s.choices, website }, new Set(offices.map((o) => o.id)));
    if (!checked.ok) {
      setErrors(checked.errors);
      setEmailOutcome(IDLE);
      if (checked.errors.email) emailRef.current?.focus();
      return;
    }
    try {
      // Email only: the request carries no channels (the server reads none as email, as before the channel release).
      const { channels: _channels, ...fields } = checked.value;
      await api.subscribe({ ...fields, website });
      if (mine === submission.current) setEmailOutcome({ kind: 'done', ok: true, text: 'Check your inbox for a link to start email alerts.', retry: false });
    } catch (err) {
      if (mine !== submission.current) return;
      setErrors(err instanceof ApiFailure ? err.fields : {});
      setEmailOutcome({ kind: 'done', ok: false, text: errorText(err), retry: true });
    }
  }

  async function runNotify(s: { choices: AlertChoices }) {
    if (!controller) return;
    const mine = submission.current;
    setNotifyOutcome({ kind: 'busy' });
    const r: SetupResult = change ? await controller.change(s.choices) : await controller.setup(s.choices);
    if (mine === submission.current) setNotifyOutcome({ kind: 'done', ...r, retry: !r.ok && r.retry });
  }

  /** Runs one kind's request (a submit's or a retry's) unless that kind's is running; the guard is taken synchronously. */
  async function guarded(kind: 'email' | 'notify', run: () => Promise<unknown>) {
    if (busyRef.current[kind]) return;
    busyRef.current[kind] = true;
    try {
      await run();
    } finally {
      busyRef.current[kind] = false;
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSend || asking || busyRef.current.email || busyRef.current.notify) return;
    const known = new Set(offices.map((o) => o.id));
    const checked = validateChoices({ siteIds: selected, applicants, pace }, known);
    // With Email on, the address is checked in the same pass, so every missing thing is said at once.
    const emailErrors = !change && emailOn ? (() => {
      const e = validateSubscribe({ email, siteIds: selected, applicants, pace, website }, known);
      return e.ok ? {} : e.errors;
    })() : {};
    if (!checked.ok || Object.keys(emailErrors).length > 0) {
      const all = { ...emailErrors, ...(checked.ok ? {} : checked.errors) };
      setErrors(all);
      if (all.siteIds) setPicking(true);
      else if (all.email) emailRef.current?.focus();
      return;
    }
    setErrors({});
    // One snapshot; when both are on, the two requests run independently from it. No address is sent with Email off.
    const s = { choices: checked.value, email };
    snapshot.current = s;
    // A kind that already succeeded for these same choices (nothing changed since: its outcome would have been reset) is
    // not sent again.
    const doneOk = (o: Outcome) => o.kind === 'done' && o.ok;
    if (!change && emailOn && !doneOk(emailOutcome)) void guarded('email', () => runEmail(s));
    if ((change || (notifyOn && capability.ok)) && !doneOk(notifyOutcome)) void guarded('notify', () => runNotify(s));
  }

  const busy = emailOutcome.kind === 'busy' || notifyOutcome.kind === 'busy';
  const ownerUnkept = useMemo(() => {
    try {
      return sessionStorage.getItem('pengepassportph-owner-unkept') === '1';
    } catch {
      return false;
    }
  }, []);
  const paceWho = change ? 'notification' : emailOn && notifyOn ? 'email and one notification' : notifyOn ? 'notification' : 'email';
  const resultLine = (o: Outcome, retryLabel: string, retry: () => void) =>
    o.kind === 'done' && (
      // A failure is announced at once (its text, not the retry button beside it); a success politely.
      <div className={o.ok ? 'sheet-result' : 'sheet-result sheet-result-failed'} role={o.ok ? 'status' : undefined}>
        {o.ok && <CheckIcon />}
        <p role={o.ok ? undefined : 'alert'}>{o.text}</p>
        {o.retry && snapshot.current && (
          <button type="button" className="link-button" onClick={retry}>
            {retryLabel}
          </button>
        )}
      </div>
    );

  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <div className="sheet-head">
          <h2 id={`${id}-title`}>{change ? 'Change notifications on this device' : 'Alerts'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          {ownerUnkept && <p className="hint hint-strong">This browser could not keep the owner link, so notifications are not offered here. Allow this site to store data, then open the owner link again.</p>}
          <fieldset className="form-body" disabled={busy}>
          {!change && (
            <fieldset className="field channels">
              <legend>How should we tell you?</legend>
              <button type="button" role="switch" className="switch" aria-checked={emailOn} onClick={() => !busy && setEmailOn(!emailOn)}>
                <span className="switch-track" aria-hidden="true" /> Email
              </button>
              {capability.ok ? (
                <button type="button" role="switch" className="switch" aria-checked={notifyOn} aria-busy={asking || undefined} onClick={toggleNotify}>
                  <span className="switch-track" aria-hidden="true" /> {context === 'browser' ? 'Browser notifications' : 'Notifications on this device'}
                </button>
              ) : capability.reason === 'ios-tab' ? (
                <p className="hint">To get notifications on iPhone, add this site to your Home Screen, then open it from there.</p>
              ) : capability.reason === 'unsupported' ? (
                <p className="hint">This browser can't show notifications.</p>
              ) : capability.reason === 'no-worker' ? (
                <p className="hint">Notifications need the site to finish loading. Reload the page to turn them on.</p>
              ) : null}
              {notifyNote && <p className="hint hint-strong">{notifyNote}</p>}
              {emailOn && notifyOn && <p className="hint">These choices apply to both now. Afterwards, change notifications on this device and email through its links.</p>}
            </fieldset>
          )}

          {!change && emailOn && (
            <div className="field">
              <label htmlFor={`${id}-email`}>Your email</label>
              <input ref={emailRef} id={`${id}-email`} type="email" inputMode="email" autoComplete="email" spellCheck={false} maxLength={LIMITS.emailMaxLength}
                value={email} onChange={(ev) => setEmail(ev.target.value)} aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? `${id}-email-note ${id}-email-error` : `${id}-email-note`} placeholder="juan@example.com" />
              <p className="hint" id={`${id}-email-note`}>
                Our database and backups keep your address encrypted, and we use it only for these alerts. Unsubscribing deletes it; the last copies, in backups and mail-server logs, are gone within 14 days.
              </p>
              {errors.email && <p className="error" id={`${id}-email-error`}>{errors.email}</p>}
            </div>
          )}

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
            <label htmlFor={`${id}-applicants`}>Booking for</label>
            <select id={`${id}-applicants`} value={applicants} onChange={(ev) => setApplicants(Number(ev.target.value))}>
              {PARTY_SIZES.map((n) => (
                <option key={n} value={n}>{partyLabel(n)}</option>
              ))}
            </select>
            <p className="hint">For a group, you only hear about dates with room for everyone.</p>
            {errors.applicants && <p className="error">{errors.applicants}</p>}
          </div>

          <div className="field">
            <label htmlFor={`${id}-pace`}>How often</label>
            <select id={`${id}-pace`} value={pace} onChange={(ev) => setPace(ev.target.value as Pace)}>
              {PACES.map((p) => (
                <option key={p} value={p}>{PACE_LABELS[p]}</option>
              ))}
            </select>
            <p className="hint">
              {pace === 'hourly'
                ? `One ${paceWho} with everything new since the last one, at most once an hour.`
                : `One ${paceWho} from each check that finds dates; checks run every 5 minutes.`}{' '}
              Dates that closed in the meantime are left out.
            </p>
            {errors.pace && <p className="error">{errors.pace}</p>}
          </div>

          <div className="hp" aria-hidden="true">
            <label htmlFor={`${id}-website`}>Website</label>
            <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(ev) => setWebsite(ev.target.value)} />
          </div>

          </fieldset>
          {(change || (notifyOn && capability.ok)) &&
            resultLine(notifyOutcome, 'Try notifications again', () => {
              const s = snapshot.current;
              if (s && (change || (notifyOn && capability.ok))) void guarded('notify', () => runNotify(s));
            })}
          {!change && emailOn &&
            resultLine(emailOutcome, 'Try email again', () => {
              const s = snapshot.current;
              if (s && emailOn) void guarded('email', () => runEmail(s));
            })}
          {errors.form && <p className="error" role="alert">{errors.form}</p>}
          <button type="submit" className="btn btn-primary btn-block" aria-busy={busy} disabled={!canSend || busy}>
            {busy ? 'Working…' : label}
          </button>
          {!change && emailOn && <p className="hint sheet-fine">We email you a link first; email alerts start when you press it. Every alert has a one-click unsubscribe.</p>}
          {!change && notifyOn && <p className="hint sheet-fine">This device shows a setup notification first; notifications start once it arrives.</p>}
        </form>
      </div>
    </div>,
    document.body,
  );
}
