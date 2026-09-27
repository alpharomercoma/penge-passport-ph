import { isCalendarDate, LIMITS, type StatusResponse } from '@penge/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Api, errorText } from '../api.ts';
import { AlertSheet } from '../components/AlertSheet.tsx';
import { AllOffices } from '../components/AllOffices.tsx';
import { BellIcon } from '../components/Icons.tsx';
import { OfficeView } from '../components/OfficeView.tsx';
import { manilaToday, toOffices } from '../office.ts';
import { ago } from '../time.ts';

const REFRESH_MS = 60_000;
const SAVED = 'penge:offices';
const TITLE = 'PengePassportPH: find an open passport appointment';

function loadSaved(): number[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SAVED) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((n): n is number => Number.isSafeInteger(n)).slice(0, LIMITS.sitesPerSubscription) : [];
  } catch {
    return [];
  }
}

/** ?office=486&date=2026-10-07 opens that office (and day); links can be shared and Back works. */
function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const office = Number(q.get('office'));
  const date = q.get('date');
  return { office: Number.isSafeInteger(office) && office > 0 ? office : null, date: isCalendarDate(date) ? date : null };
}

export function Home({ api }: { api: Api }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState(readUrl);
  const [chosen, setChosen] = useState<number[]>(loadSaved);
  const [sheet, setSheet] = useState(false);
  // Kept while moving between offices: a group checks every office for the whole group.
  const [applicants, setApplicants] = useState(1);

  useEffect(() => {
    let live = true;
    const refresh = () =>
      api.status().then(
        (s) => {
          if (!live) return;
          setStatus(s);
          setError(null);
        },
        (err: unknown) => live && setError(errorText(err)),
      );
    void refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api, attempt]);

  // "Updated 5 minutes ago" keeps counting even while the server cannot be reached.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(readUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SAVED, JSON.stringify(chosen));
    } catch {
      // Private windows and blocked storage: the choice just is not remembered.
    }
  }, [chosen]);

  const go = useCallback((office: number | null, date: string | null = null) => {
    const q = new URLSearchParams();
    if (office) q.set('office', String(office));
    if (office && date) q.set('date', date);
    const url = `${window.location.pathname}${q.size ? `?${q}` : ''}`;
    window.history.pushState(null, '', url);
    setRoute({ office, date });
    window.scrollTo({ top: 0 });
  }, []);

  const offices = useMemo(() => (status ? toOffices(status.sites) : []), [status]);
  const today = manilaToday();
  const office = offices.find((o) => o.id === route.office) ?? null;
  const alertsOpen = status?.mailLive === true && offices.length > 0;
  const known = new Set(offices.map((o) => o.id));
  const selected = chosen.filter((id) => known.size === 0 || known.has(id));

  const openAlert = (officeId: number | null) => {
    if (officeId && !selected.includes(officeId)) {
      setChosen([...selected, officeId].slice(-LIMITS.sitesPerSubscription));
    }
    setSheet(true);
  };

  useEffect(() => {
    document.title = office ? `${office.place}: passport appointment dates | PengePassportPH` : TITLE;
  }, [office]);

  // An office whose latest check failed shows what was last known, with its age, but is not counted as open now.
  const openCount = offices.filter((o) => o.ok && o.earliest).length;

  return (
    <>
      {!office && (
        <div className="toolbar">
          <div className="title-row">
            <h1>Passport appointment dates</h1>
            {alertsOpen && (
              <button type="button" className="btn btn-secondary btn-small" onClick={() => openAlert(null)}>
                <BellIcon /> Email alerts
              </button>
            )}
          </div>
          {offices.length > 0 && (
            <p className="summary">
              <strong>
                {openCount} of {offices.length}
              </strong>{' '}
              DFA offices in the Philippines have open dates for one person.
              {status?.lastHealthyAt && (
                <>
                  {' '}
                  Updated <time dateTime={status.lastHealthyAt}>{ago(status.lastHealthyAt)}</time>.
                </>
              )}
            </p>
          )}
        </div>
      )}
      {status && !status.healthy && status.checkedAt && (
        <p className="warning" role="status">
          The latest check ran into problems, so these dates may be out of date. Alerts wait until checks pass again.
        </p>
      )}

      {error && !status ? (
        <div className="down">
          <p>
            <strong>Dates can’t be loaded right now.</strong> {error}
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : !status ? (
        <p className="hint loading">Loading the dates…</p>
      ) : office ? (
        <OfficeView
          key={office.id}
          api={api}
          office={office}
          lastCheck={status.lastHealthyAt}
          offices={offices}
          today={today}
          initialDate={route.date}
          applicants={applicants}
          onApplicants={setApplicants}
          alertsOpen={alertsOpen}
          onBack={() => go(null)}
          onOpen={(id) => go(id)}
          onAlert={openAlert}
        />
      ) : (
        <AllOffices offices={offices} today={today} onOpen={(id, date) => go(id, date ?? null)} />
      )}

      {sheet && status && (
        <AlertSheet
          api={api}
          offices={offices}
          selected={selected}
          initialApplicants={applicants}
          onSelectedChange={setChosen}
          onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}
