import { useMemo } from 'react';
import { ChevronIcon } from './Icons.tsx';

export interface DayInfo {
  state: 'open' | 'full';
  /** Small text under the day number, e.g. "15" offices open. */
  note?: string;
  /** What a screen reader says for an open day, which is a button. */
  label?: string;
}

interface Props {
  /** "YYYY-MM" shown now. */
  month: string;
  /** First and last months a person can move between. */
  firstMonth: string;
  lastMonth: string;
  onMonth: (month: string) => void;
  days: ReadonlyMap<string, DayInfo>;
  today: string;
  selected: string | null;
  /** Open days are buttons; everything else is plain text. */
  onPick: (date: string) => void;
  /** Shown when nothing in this month is released yet. */
  emptyNote?: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK = [
  ['Sun', 'Sunday'],
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
] as const;

export const monthOf = (date: string) => date.slice(0, 7);

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

/** A month like the DFA's own date picker: green days are open and can be tapped. Weeks start on Sunday. */
export function Calendar({ month, firstMonth, lastMonth, onMonth, days, today, selected, onPick, emptyNote }: Props) {
  const weeks = useMemo(() => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells: (string | null)[] = [
      ...Array.from({ length: first }, () => null),
      ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
    ];
    while (cells.length % 7) cells.push(null);
    return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  }, [month]);
  const anyReleased = weeks.some((week) => week.some((d) => d !== null && d >= today && days.has(d)));
  const title = monthLabel(month);

  return (
    <div className="calendar">
      <div className="calendar-head">
        {month > firstMonth ? (
          <button type="button" className="month-nav prev" onClick={() => onMonth(shiftMonth(month, -1))} aria-label={`Previous month, ${monthLabel(shiftMonth(month, -1))}`}>
            <ChevronIcon />
          </button>
        ) : (
          <span />
        )}
        <h2 className="calendar-title" aria-live="polite">
          {title}
        </h2>
        {month < lastMonth ? (
          <button type="button" className="month-nav next" onClick={() => onMonth(shiftMonth(month, 1))} aria-label={`Next month, ${monthLabel(shiftMonth(month, 1))}`}>
            <ChevronIcon />
          </button>
        ) : (
          <span />
        )}
      </div>
      <table className="calendar-grid" aria-label={title}>
        <thead>
          <tr>
            {WEEK.map(([short, long]) => (
              <th key={short} scope="col" abbr={long}>
                {short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find(Boolean)}>
              {week.map((date, i) => {
                if (!date) return <td key={`pad${i}`} />;
                const past = date < today;
                const info = past ? undefined : days.get(date);
                const day = Number(date.slice(8));
                const cls = ['day', info ? `is-${info.state}` : '', past ? 'is-past' : '', date === today ? 'is-today' : '', date === selected ? 'is-selected' : '']
                  .filter(Boolean)
                  .join(' ');
                return (
                  <td key={date}>
                    {info?.state === 'open' ? (
                      <button type="button" className={cls} onClick={() => onPick(date)} aria-pressed={date === selected} aria-label={info.label}>
                        <span className="day-num">{day}</span>
                        {info.note && <span className="day-note">{info.note}</span>}
                      </button>
                    ) : (
                      <span className={cls}>
                        <span className="day-num">{day}</span>
                        {info?.state === 'full' && <span className="day-note">Full</span>}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!anyReleased && emptyNote && <p className="calendar-empty">{emptyNote}</p>}
    </div>
  );
}

/** Explains only the colours the calendar is showing. */
export function Legend({ open, full }: { open: string | null; full: string | null }) {
  if (!open && !full) return null;
  return (
    <p className="legend">
      {open && (
        <span>
          <span className="swatch swatch-open" aria-hidden="true" /> {open}
        </span>
      )}
      {full && (
        <span>
          <span className="swatch swatch-full" aria-hidden="true" /> {full}
        </span>
      )}
    </p>
  );
}
