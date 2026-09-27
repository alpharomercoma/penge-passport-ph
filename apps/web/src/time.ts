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

/** The token in a link like /confirm#token=…, kept out of server logs by living in the fragment. */
export function tokenFromHash(hash: string): string | null {
  const match = /^#token=([A-Za-z0-9._-]{1,200})$/.exec(hash);
  return match?.[1] ?? null;
}
