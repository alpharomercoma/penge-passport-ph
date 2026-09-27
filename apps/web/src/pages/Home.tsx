import { type AbroadResponse, isCalendarDate, LIMITS, type StatusResponse } from '@penge/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Api, errorText } from '../api.ts';
import { AREAS, REGIONS } from '../areas.ts';
import { AlertSheet } from '../components/AlertSheet.tsx';
import { AllOffices } from '../components/AllOffices.tsx';
import { BellIcon } from '../components/Icons.tsx';
import { OfficeView } from '../components/OfficeView.tsx';
import { manilaToday, toAbroadOffices, toOffices } from '../office.ts';
import { ago } from '../time.ts';

const REFRESH_MS = 60_000;
/** Posts abroad are checked about hourly: reading them every 5 minutes is plenty. */
const ABROAD_REFRESH_MS = 5 * 60_000;
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

type Scope = 'home' | 'abroad';

/**
 * ?office=486&date=2026-10-07 opens that office (and day), and ?in=abroad the
 * posts abroad; links can be shared and Back works.
 */
function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const office = Number(q.get('office'));
  const date = q.get('date');
  return {
    office: Number.isSafeInteger(office) && office > 0 ? office : null,
    date: isCalendarDate(date) ? date : null,
    scope: (q.get('in') === 'abroad' ? 'abroad' : 'home') as Scope,
  };
}

export function Home({ api }: { api: Api }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState(readUrl);
  const [chosen, setChosen] = useState<number[]>(loadSaved);
  const [sheet, setSheet] = useState(false);
  const [abroad, setAbroad] = useState<AbroadResponse | null>(null);
  const [abroadError, setAbroadError] = useState<string | null>(null);
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

  const go = useCallback((office: number | null, date: string | null = null, scope: Scope = 'home') => {
    const q = new URLSearchParams();
    if (scope === 'abroad') q.set('in', 'abroad');
    if (office) q.set('office', String(office));
    if (office && date) q.set('date', date);
    const url = `${window.location.pathname}${q.size ? `?${q}` : ''}`;
    window.history.pushState(null, '', url);
    setRoute({ office, date, scope });
    window.scrollTo({ top: 0 });
  }, []);

  const home = useMemo(() => (status ? toOffices(status.sites) : []), [status]);
  const posts = useMemo(() => (abroad ? toAbroadOffices(abroad.posts) : []), [abroad]);
  const today = manilaToday();
  const office = home.find((o) => o.id === route.office) ?? posts.find((o) => o.id === route.office) ?? null;
  const scope: Scope = office ? (office.country ? 'abroad' : 'home') : route.scope;
  const offices = scope === 'abroad' ? posts : home;
  const alertsOpen = status?.mailLive === true && home.length > 0;
  const known = new Set([...home, ...posts].map((o) => o.id));
  // Until the posts abroad are loaded, a saved one is not dropped for being unknown.
  const selected = chosen.filter((id) => known.size === 0 || known.has(id) || !abroad);
  // Posts abroad load only when needed: shown, linked to, saved, or offered in the alert form.
  const needAbroad =
    route.scope === 'abroad' ||
    sheet ||
    (status !== null && route.office !== null && !home.some((o) => o.id === route.office)) ||
    (status !== null && chosen.some((id) => !home.some((o) => o.id === id)));

  useEffect(() => {
    if (!needAbroad) return;
    let live = true;
    const refresh = () =>
      api.abroad().then(
        (a) => {
          if (!live) return;
          setAbroad(a);
          setAbroadError(null);
        },
        (err: unknown) => live && setAbroadError(errorText(err)),
      );
    void refresh();
    const timer = window.setInterval(refresh, ABROAD_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api, needAbroad, attempt]);

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
  const loading = scope === 'abroad' ? !abroad && !abroadError : !status && !error;
  const failure = scope === 'abroad' ? (!abroad ? abroadError : null) : !status ? error : null;

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
          <div className="scope" role="group" aria-label="Where">
            <button type="button" aria-pressed={scope === 'home'} onClick={() => go(null, null, 'home')}>
              Philippines
            </button>
            <button type="button" aria-pressed={scope === 'abroad'} onClick={() => go(null, null, 'abroad')}>
              Abroad
            </button>
          </div>
          {scope === 'home' && offices.length > 0 && (
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
          {scope === 'abroad' && abroad && offices.length > 0 && abroad.catalogAt && (
            <p className="summary">
              <strong>
                {openCount} of {offices.length}
              </strong>{' '}
              posts abroad have open dates for one person. Each is checked about every {abroad.checkedEveryMinutes} minutes, or every few hours
              while it publishes none.
            </p>
          )}
          {scope === 'abroad' && abroad && !abroad.catalogAt && (
            <p className="summary">
              The list of posts abroad is being read from passport.gov.ph{offices.length > 0 ? `: ${offices.length} so far` : ''}. Their dates follow
              within the hour.
            </p>
          )}
        </div>
      )}
      {scope === 'home' && status && !status.healthy && status.checkedAt && (
        <p className="warning" role="status">
          The latest check ran into problems, so these dates may be out of date. Alerts wait until checks pass again.
        </p>
      )}

      {failure && !office ? (
        <div className="down">
          <p>
            <strong>Dates can’t be loaded right now.</strong> {failure}
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : loading && !office ? (
        <p className="hint loading">Loading the dates…</p>
      ) : office ? (
        <OfficeView
          key={office.id}
          api={api}
          office={office}
          lastCheck={office.country ? office.checkedAt : (status?.lastHealthyAt ?? null)}
          offices={offices}
          today={today}
          initialDate={route.date}
          applicants={applicants}
          onApplicants={setApplicants}
          alertsOpen={alertsOpen}
          onBack={() => go(null, null, scope)}
          onOpen={(id) => go(id, null, scope)}
          onAlert={openAlert}
        />
      ) : (
        <AllOffices
          key={scope}
          offices={offices}
          today={today}
          areas={scope === 'abroad' ? REGIONS : AREAS}
          abroad={scope === 'abroad'}
          onOpen={(id, date) => go(id, date ?? null, scope)}
        />
      )}

      {sheet && status && (
        <AlertSheet
          api={api}
          offices={[...home, ...posts]}
          selected={selected}
          initialApplicants={applicants}
          onSelectedChange={setChosen}
          onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}
