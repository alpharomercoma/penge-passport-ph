const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "3 minutes ago", "2 hours ago", "yesterday". */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds)) return 'at an unknown time';
  if (Math.abs(seconds) < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

const manilaTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' });
const manilaDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Manila' });
const manilaDate = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Manila' });

/** "2:36 PM PHT", in Manila whatever the device's timezone; with the day ("11:30 PM PHT, 12 Oct") when not today there. */
export function manilaClock(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  // Newer ICU puts a narrow no-break space before AM/PM: one plain space, kept on one line by the page's styles.
  const time = `${manilaTime.format(ms).replace(/\s/g, ' ')} PHT`;
  return manilaDate.format(ms) === manilaDate.format(now) ? time : `${time}, ${manilaDay.format(ms)}`;
}

/** The token in a link like /confirm#token=…, kept out of server logs by living in the fragment. */
export function tokenFromHash(hash: string): string | null {
  const match = /^#token=([A-Za-z0-9._-]{1,200})$/.exec(hash);
  return match?.[1] ?? null;
}

/** A day in Manila, short: "4 Apr 2027". */
export const formatShortDate = (ms: number): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Manila' }).format(ms);
