import { formatDate } from '@penge/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { matches, type Office, plural, shortDate, sortOffices } from '../office.ts';
import { ago } from '../time.ts';
import { Calendar, type DayInfo, Legend, monthOf } from './Calendar.tsx';
import { ChevronIcon, SearchIcon } from './Icons.tsx';

interface Props {
  offices: Office[];
  today: string;
  onOpen: (officeId: number, date?: string) => void;
  /** The chips that narrow the list: the four areas at home, or the DFA's five regions abroad. */
  areas: readonly string[];
  /** Posts abroad: listed by country, and called posts. */
  abroad?: boolean;
}

type View = 'office' | 'date';

/**
 * Every office, soonest date first. The calendar does not repeat the list:
 * tapping a date narrows the one list to the offices open that day.
 */
export function AllOffices({ offices, today, onOpen, areas: chips, abroad = false }: Props) {
  const [view, setView] = useState<View>('office');
  const [query, setQuery] = useState('');
  // No area chosen shows every office; tapping the chosen area again clears it.
  const [area, setArea] = useState<string | null>(null);
  const noun = abroad ? 'post' : 'office';
  const [day, setDay] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const sorted = sortOffices(
      offices.filter((o) => (!area || o.area === area) && matches(o, query) && (!day || (o.ok && o.openDates.includes(day)))),
      day ? 'name' : 'soonest',
    );
    // Abroad, people look for their country first: by country, then as at home.
    return abroad ? sorted.sort((a, b) => (a.country ?? '').localeCompare(b.country ?? '')) : sorted;
  }, [offices, area, query, day, abroad]);
  const areas = chips.filter((a) => offices.some((o) => o.area === a));
  const groups = useMemo(() => {
    if (!abroad) return [{ country: null, list: shown }];
    const out: { country: string | null; list: Office[] }[] = [];
    for (const o of shown) {
      const last = out.at(-1);
      if (last && last.country === o.country) last.list.push(o);
      else out.push({ country: o.country, list: [o] });
    }
    return out;
  }, [shown, abroad]);

  const pickDay = (date: string) => {
    setDay(date === day ? null : date);
    setView('office');
    setReveal(true);
  };

  // The narrowed list replaces the calendar on phones, and may sit above the
  // fold on wide screens: either way it is brought into view.
  useEffect(() => {
    if (!reveal) return;
    setReveal(false);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    (bannerRef.current ?? listRef.current)?.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [reveal]);

  return (
    <div className="all">
      <div className="tabs" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === 'office'} onClick={() => setView('office')}>
          {abroad ? 'By post' : 'By office'}
        </button>
        <button type="button" aria-pressed={view === 'date'} onClick={() => setView('date')}>
          By date
        </button>
      </div>

      <div className="all-grid">
        <section
          ref={listRef}
          className={view === 'office' ? 'pane pane-offices is-active' : 'pane pane-offices'}
          aria-label={abroad ? 'Posts abroad, by country' : 'Offices, soonest date first'}
        >
          <div className="filters">
            <label className="search">
              <SearchIcon />
              <span className="sr-only">{abroad ? 'Search posts' : 'Search offices'}</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={abroad ? 'Search a country or city' : 'Search a city or mall'}
                autoComplete="off"
                maxLength={60}
              />
            </label>
            <div className="chips-row" role="group" aria-label={abroad ? 'Region' : 'Area'}>
              {areas.map((a) => (
                <button key={a} type="button" className="filter-chip" aria-pressed={area === a} onClick={() => setArea(area === a ? null : a)}>
                  {a}
                </button>
              ))}
            </div>
          </div>
          {/* Always says what the list is showing, so clearing a filter visibly changes it. */}
          {(day || shown.length > 0) && (
            <div ref={bannerRef} className={day ? 'list-head is-filtered' : 'list-head'} role="status">
              {day ? (
                <>
                  <p>
                    Open on <strong>{shortDate(day)}</strong>: {plural(shown.length, noun)}
                  </p>
                  <button type="button" className="link-button" onClick={() => setDay(null)}>
                    Show all
                  </button>
                </>
              ) : (
                <p>
                  {shown.length === offices.length ? `All ${offices.length} ${noun}s` : `${shown.length} of ${offices.length} ${noun}s`},{' '}
                  {abroad ? 'by country' : 'soonest date first'}
                </p>
              )}
            </div>
          )}
          {shown.length === 0 ? (
            <p className="empty">
              No {noun} matches{query ? ` “${query}”` : ''}
              {area ? ` in ${area}` : ''}
              {day ? ` on ${formatDate(day)}` : ''}.
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.country ?? 'all'} className={g.country ? 'country' : undefined}>
                {g.country && <h3 className="country-name">{g.country}</h3>}
                <ul className="rows">
                  {g.list.map((o) => (
                    <li key={o.id}>
                      <button type="button" className="row" onClick={() => onOpen(o.id, day ?? undefined)}>
                        <span className="row-name">
                          <span className="row-place">{o.place}</span>
                          {o.detail && <span className="row-detail">{underCountry(o)}</span>}
                        </span>
                        <span className="row-when">
                          {!o.ok && !o.checkedAt ? (
                            abroad ? (
                              <span className="row-full">Not checked yet</span>
                            ) : (
                              <span className="row-warn">Couldn’t check</span>
                            )
                          ) : o.earliest ? (
                            <>
                              {/* Narrowed to a day, every office listed is open on it: that day is the one to show. */}
                              <span className="row-date">{shortDate(day ?? o.earliest)}</span>
                              {o.ok && <span className="row-count">{plural(o.openDates.length, 'open day')}</span>}
                            </>
                          ) : (
                            <span className="row-full">{o.publishedDays ? 'Fully booked' : 'No dates yet'}</span>
                          )}
                          {/* The latest check failed: this is what was known, and when. */}
                          {!o.ok && o.checkedAt && <span className="row-stale">Checked {ago(o.checkedAt)}</span>}
                        </span>
                        <ChevronIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>

        <section className={view === 'date' ? 'pane pane-dates is-active' : 'pane pane-dates'} aria-label={`Calendar of open ${noun}s`}>
          <ByDate offices={offices} today={today} day={day} onPick={pickDay} noun={noun} />
        </section>
      </div>
    </div>
  );
}

/** Under its country's heading, a post's detail need not name the country again. */
function underCountry(o: Office): string {
  const tail = o.country ? `, ${o.country}` : '';
  return tail && o.detail.endsWith(tail) ? o.detail.slice(0, -tail.length) : o.detail;
}

function ByDate({
  offices,
  today,
  day,
  onPick,
  noun,
}: {
  offices: Office[];
  today: string;
  day: string | null;
  onPick: (date: string) => void;
  noun: string;
}) {
  // Only what the latest scan saw: an office whose check failed is shown in the list, with its age, not here.
  const checked = useMemo(() => offices.filter((o) => o.ok), [offices]);
  const openBy = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of checked) for (const d of o.openDates) map.set(d, (map.get(d) ?? 0) + 1);
    return map;
  }, [checked]);
  const fullDays = useMemo(() => new Set(checked.flatMap((o) => o.fullDates)), [checked]);
  const soonest = [...openBy.keys()].filter((d) => d >= today).sort()[0] ?? null;
  const lastMonth = useMemo(() => {
    const ends = offices.map((o) => o.windowEnd ?? o.openDates.at(-1) ?? today);
    return monthOf(ends.sort().at(-1) ?? today);
  }, [offices, today]);
  const [month, setMonth] = useState(monthOf(day ?? soonest ?? today));

  const days = useMemo(() => {
    const map = new Map<string, DayInfo>();
    for (const d of fullDays) map.set(d, { state: 'full' });
    for (const [d, count] of openBy) {
      map.set(d, { state: 'open', note: String(count), label: `${formatDate(d)}: open at ${plural(count, noun)}, show them` });
    }
    return map;
  }, [openBy, fullDays, noun]);

  return (
    <>
      <Calendar
        month={month}
        firstMonth={monthOf(today)}
        lastMonth={lastMonth}
        onMonth={setMonth}
        days={days}
        today={today}
        selected={day}
        onPick={onPick}
        emptyNote="The DFA has not released dates for this month yet."
      />
      <Legend open={`Open: the number is how many ${noun}s; tap to list them`} full={fullDays.size > 0 ? `Full: no ${noun} has room` : null} />
    </>
  );
}
