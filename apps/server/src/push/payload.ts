// What a push alert says. One notification per decision, like one email, and
// under 3 KB so every push service takes it (their limit is 4 KB).
import { formatDate, shortName } from '@penge/contracts';
import type { Opening } from '../templates.ts';

const LIMIT = 3000;
/** Office names are short; a longer one is cut (by character, never inside one) to keep the title small. */
const NAME_CHARS = 80;
const day = (d: string) => formatDate(d).replace(/ \d{4}$/, '');

export function buildPayload(a: { openings: Opening[]; applicants: number; decisionId: string }): string {
  const first = a.openings[0]!;
  const name = [...shortName(first.name)].slice(0, NAME_CHARS).join('');
  const title = a.openings.length === 1 ? `Dates open at ${name}` : `Dates open at ${a.openings.length} offices`;
  const dates = [...new Set(a.openings.flatMap((o) => o.dates))].sort();
  const people = a.applicants === 1 ? 'for 1 person' : `for ${a.applicants} people`;
  const url = { office: first.id, date: first.dates[0] ?? null, people: a.applicants };
  const make = (body: string) => JSON.stringify({ v: 1, title, body, tag: `alert-${a.decisionId}`, url });
  for (let shown = Math.min(dates.length, 6); shown >= 1; shown--) {
    const named = dates.slice(0, shown).map(day);
    const rest = dates.length - shown;
    const list = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]!;
    const p = make(`${list} · ${people}`);
    if (Buffer.byteLength(p) <= LIMIT) return p;
  }
  const plain = make(people);
  if (Buffer.byteLength(plain) <= LIMIT) return plain;
  // Inputs no real alert has (a huge id or date): a plain notification that opens the site.
  return JSON.stringify({ v: 1, title: 'Dates open', body: people, tag: `alert-${a.decisionId.slice(0, 64)}`, url: {} });
}
