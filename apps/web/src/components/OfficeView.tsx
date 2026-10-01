import { formatDate, type OfficeDates, type OfficeTimes } from '@penge/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Api, errorText } from '../api.ts';
import { BOOKING_URL } from '../links.ts';
import { hourRange, type Office, PARTY_SIZES, partyLabel, plural, shortDate } from '../office.ts';
import { ago } from '../time.ts';
import { Calendar, type DayInfo, Legend, monthOf } from './Calendar.tsx';
import { BellIcon, ChevronIcon, ExternalIcon } from './Icons.tsx';

interface Props {
  api: Api;
  office: Office;
  /** When the dates in `office` were read: the last scan. */
  lastCheck: string | null;
  offices: Office[];
  today: string;
  /** A day chosen before the office was opened (from the calendar of all offices, or a link). */
  initialDate: string | null;
  applicants: number;
  onApplicants: (applicants: number) => void;
  alertsOpen: boolean;
  onBack: () => void;
  onOpen: (officeId: number) => void;
  onAlert: (officeId: number) => void;
}

type Load<T> = { state: 'idle'; data?: undefined } | { state: 'loading'; data?: T | undefined } | { state: 'ready'; data: T } | { state: 'error'; message: string; data?: T | undefined };

// Shared server lookups are fresh for three minutes. Polling at that cadence
// keeps a page left open current without spending the upstream budget faster.
const REFRESH_MS = 180_000;

const smooth = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** One office, as on the DFA's own page: where it is, a calendar, then the hours of the day picked. */
export function OfficeView(props: Props) {
  const { api, office, lastCheck, offices, today, initialDate, applicants, onApplicants, alertsOpen, onBack, onOpen, onAlert } = props;
  const [fresh, setFresh] = useState<Load<OfficeDates>>({ state: 'idle' });
  const [picked, setPicked] = useState<string | null>(initialDate);
  const [times, setTimes] = useState<Load<OfficeTimes>>({ state: 'idle' });
  // Days the live hours showed to be full since the dates were read.
  const [takenSince, setTakenSince] = useState<ReadonlySet<string>>(new Set());
  // The hours of a picked day are brought into view, so a tap never needs a scroll to see its answer.
  const [reveal, setReveal] = useState(initialDate !== null);
  const timesRef = useRef<HTMLElement>(null);
  const [retry, setRetry] = useState(0);

  // The dates are asked for when the office opens (and for each group size).
  // For one person the server answers from a recent scan, asking the DFA only
  // when the scans have fallen behind; the last scan shows meanwhile, labelled
  // with its time.
  useEffect(() => {
    let live = true;
    let busy = false;
    const refresh = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      setFresh((prev) => ({ state: 'loading', data: prev.data?.applicants === applicants ? prev.data : undefined }));
      try {
        const data = await api.officeDates(office.id, applicants);
        if (live) setFresh({ state: 'ready', data });
      } catch (err) {
        if (live) setFresh((prev) => ({ state: 'error', message: errorText(err), data: prev.data }));
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, office.id, office.checkedAt, applicants, retry]);

  const snapshotAt = office.checkedAt ?? lastCheck;
  const freshData = fresh.data?.applicants === applicants ? fresh.data : undefined;
  const useSnapshot = applicants === 1 && office.ok && snapshotAt && (!freshData || snapshotAt > freshData.checkedAt);
  const dates =
    freshData && !useSnapshot
      ? { open: freshData.openDates, full: freshData.fullDates, windowEnd: freshData.windowEnd, at: freshData.checkedAt }
      : applicants === 1
        ? { open: office.openDates, full: office.fullDates, windowEnd: office.windowEnd, at: office.checkedAt ?? lastCheck }
        : null;
  const listed = useMemo(() => (dates?.open ?? []).filter((d) => d >= today && (
    applicants === 1 || !office.ok || !snapshotAt || !dates?.at || snapshotAt <= dates.at || office.openDates.includes(d)
  )), [dates, today, applicants, office.ok, office.openDates, snapshotAt]);
  const open = useMemo(() => listed.filter((d) => !takenSince.has(`${applicants}:${d}`)), [listed, takenSince, applicants]);
  const seenAt = dates?.at ?? null;
  const closureAt = picked && office.ok && snapshotAt && (!dates?.at || snapshotAt > dates.at) && !office.openDates.includes(picked) ? snapshotAt : seenAt;
  const warning = fresh.state === 'error' ? fresh.message : !useSnapshot ? freshData?.warning : undefined;

  // A picked date must have been open for the current group size (it stays picked
  // after its live hours show it full, so the explanation stays on screen).
  const date = picked && listed.includes(picked) ? picked : null;

  useEffect(() => {
    if (!date) {
      setTimes({ state: 'idle' });
      return;
    }
    let live = true;
    let busy = false;
    const refresh = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      setTimes({ state: 'loading' });
      try {
        const data = await api.officeTimes(office.id, date, applicants);
        if (!live) return;
        setTimes({ state: 'ready', data });
        setTakenSince((prev) => {
          const next = new Set(prev);
          if (data.slots.some((s) => s.available)) next.delete(`${applicants}:${date}`);
          else next.add(`${applicants}:${date}`);
          return next;
        });
      } catch (err) {
        if (live) setTimes({ state: 'error', message: errorText(err) });
      } finally { busy = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, office.id, date, applicants, retry]);

  // Once when the day is picked (the "asking" line) and again when its hours arrive.
  useEffect(() => {
    if (!reveal || !date || times.state === 'idle') return;
    timesRef.current?.scrollIntoView?.({ block: 'nearest', behavior: smooth() });
    if (times.state !== 'loading') setReveal(false);
  }, [reveal, date, times.state]);

  const pick = (day: string) => {
    setPicked(day);
    setReveal(true);
  };

  // Open on the first month with anything released, so a full office shows its full days.
  const [month, setMonth] = useState(
    monthOf(initialDate ?? office.earliest ?? office.fullDates.find((d) => d >= today) ?? today),
  );
  const lastMonth = monthOf(dates?.windowEnd ?? office.windowEnd ?? open.at(-1) ?? today);
  const days = useMemo(() => {
    const map = new Map<string, DayInfo>();
    for (const d of dates?.full ?? []) map.set(d, { state: 'full' });
    if (office.ok && snapshotAt && dates?.at && snapshotAt > dates.at) {
      for (const d of office.fullDates) map.set(d, { state: 'full' });
    }
    for (const d of listed) {
      map.set(d, open.includes(d) ? { state: 'open', label: `${formatDate(d)}: open, show the hours` } : { state: 'full' });
    }
    return map;
  }, [dates, listed, open, office.ok, office.fullDates, snapshotAt]);

  const nearby = useMemo(
    () =>
      offices
        .filter((o) => o.id !== office.id && o.area === office.area && o.ok && o.earliest)
        .sort((a, b) => a.earliest!.localeCompare(b.earliest!))
        .slice(0, 5),
    [offices, office],
  );
  const forGroup = applicants > 1 ? ` for ${applicants} people` : '';
  const checked = seenAt ? ` Checked ${ago(seenAt)}.` : '';
  const hoursWithRoom = times.state === 'ready' ? times.data.slots.filter((s) => s.available).length : 0;
  // With nothing open, what can be done comes first: an alert is then the main action.
  const noneOpen = dates !== null && open.length === 0;
  const book = (
    <a className={noneOpen && alertsOpen ? 'btn btn-secondary' : 'btn btn-primary'} href={BOOKING_URL} target="_blank" rel="noreferrer">
      Book on passport.gov.ph <ExternalIcon />
    </a>
  );
  const alert = alertsOpen && (
    <button type="button" className={noneOpen ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => onAlert(office.id)}>
      <BellIcon /> Email me when dates open here
    </button>
  );
  const actions = (
    <div className="actions">
      {noneOpen ? alert : book}
      {noneOpen ? book : alert}
    </div>
  );

  return (
    <article className="office" aria-labelledby="office-title">
      <button type="button" className="back" onClick={onBack}>
        <ChevronIcon /> {office.country ? 'All posts abroad' : 'All offices'}
      </button>

      <header className="office-head">
        <h1 id="office-title">{office.place}</h1>
        {office.detail && <p className="office-detail">{office.detail}</p>}
        {(office.address || office.mapUrl || office.telephone) && (
          <dl className="facts">
            {office.address && (
              <div>
                <dt>Address</dt>
                <dd>{office.address}</dd>
              </div>
            )}
            {office.mapUrl && (
              <div>
                <dt className="sr-only">Map</dt>
                <dd className="facts-more">
                  <a href={office.mapUrl} target="_blank" rel="noreferrer">
                    View map <ExternalIcon />
                  </a>
                </dd>
              </div>
            )}
            {office.telephone && (
              <div>
                <dt>Phone</dt>
                <dd>{office.telephone}</dd>
              </div>
            )}
          </dl>
        )}
      </header>

      <div className="office-controls">
        <label className="people">
          <span>Booking for</span>
          <select value={applicants} onChange={(e) => onApplicants(Number(e.target.value))}>
            {PARTY_SIZES.map((n) => (
              <option key={n} value={n}>
                {partyLabel(n)}
              </option>
            ))}
          </select>
        </label>
        <p className="office-status" aria-live="polite">
          {!dates && fresh.state === 'error'
            ? 'Dates could not be checked.'
            : !dates
              ? `Checking the dates${forGroup}…`
              : open.length > 0
                ? `${plural(open.length, 'open day')}${forGroup}, the first on ${shortDate(open[0]!)}.${checked}`
                : `No open dates${forGroup}.${checked}`}
        </p>
      </div>

      {warning && (
        <div className="warning" role="status">
          <p>{warning}{dates ? ' Saved dates are shown with their original check time.' : ''}</p>
          <button type="button" className="btn btn-secondary" onClick={() => setRetry((n) => n + 1)}>Try checking again</button>
        </div>
      )}

      {noneOpen && (
        <div className="fallback">
          <p>
            {office.country
              ? 'Each post releases dates on its own schedule. We check this one about hourly, and email you when a date opens.'
              : 'New dates are usually released around 12 noon and 9 PM.'}
          </p>
          {actions}
          {nearby.length > 0 && (
            <>
              <h2>
                Open elsewhere in {office.area === 'Other' ? 'the Philippines' : office.area}
                {applicants > 1 ? ', for one person' : ''}
              </h2>
              <ul className="rows">
                {nearby.map((o) => (
                  <li key={o.id}>
                    <button type="button" className="row" onClick={() => onOpen(o.id)}>
                      <span className="row-name">
                        <span className="row-place">{o.place}</span>
                        {o.detail && <span className="row-detail">{o.detail}</span>}
                      </span>
                      <span className="row-when">
                        <span className="row-date">{shortDate(o.earliest!)}</span>
                      </span>
                      <ChevronIcon />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {dates && (
        <div>
          <Calendar
            month={month}
            firstMonth={monthOf(today)}
            lastMonth={lastMonth < month ? month : lastMonth}
            onMonth={setMonth}
            days={days}
            today={today}
            selected={date}
            onPick={pick}
            emptyNote="The DFA has not released dates for this month yet."
          />
          <Legend open={open.length > 0 ? 'Open: tap a day for its hours' : null} full={[...days.values()].some((d) => d.state === 'full') ? 'Full' : null} />
        </div>
      )}

      {picked && !date && dates && (
        <p className="note" role="status">
          {formatDate(picked)} is no longer open{forGroup}{closureAt ? ` (checked ${ago(closureAt)})` : ''}.
          {open.length > 0 ? ' The green days still are.' : ''}
        </p>
      )}

      <p className="sr-only" role="status">
        {date && times.state === 'loading'
          ? `Getting the hours of ${formatDate(date)}.`
          : date && times.state === 'ready'
            ? `${formatDate(date)}: ${hoursWithRoom} of ${plural(times.data.slots.length, 'hour')} open.`
            : ''}
      </p>

      {date && (
        <section className="times" ref={timesRef} aria-labelledby="times-title">
          <h2 id="times-title">
            {formatDate(date)}
            {forGroup}
          </h2>
          {times.state === 'loading' && <p className="hint">Getting the hours from passport.gov.ph…</p>}
          {times.state === 'error' && <p className="error">{times.message}</p>}
          {times.state === 'ready' && times.data.warning && <p className="warning" role="status">{times.data.warning}</p>}
          {times.state === 'ready' && hoursWithRoom === 0 && (
            <p className="note">
              {times.state === 'ready' && times.data.warning ? 'Every hour was full at the last successful lookup.' : 'Every hour is full now.'} It was open when we checked{seenAt ? ` ${ago(seenAt)}` : ''}.
              {open.length > 0 ? ' Try another green day.' : ''}
            </p>
          )}
          {times.state === 'ready' && (
            <>
              <ul className="hours">
                {times.data.slots.map((s) => (
                  <li key={s.start} className={s.available ? 'hour is-open' : 'hour is-full'}>
                    <span>{hourRange(s.start, s.end)}</span>
                    <span className="hour-state">
                      {!s.available ? 'Full' : s.remaining !== null ? `${s.remaining} left` : 'Open'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint">
                Checked {ago(times.data.checkedAt)}. The DFA gives a count of places for some hours only, and they can
                go in minutes.
              </p>
            </>
          )}
        </section>
      )}

      {!noneOpen && actions}
    </article>
  );
}
