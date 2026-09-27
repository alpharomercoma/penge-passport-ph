// Every Redis key the server uses, in one place. All keys share a prefix so
// the database can hold other things without collisions.
const P = 'pp:';

export const K = {
  pending: (tokenHash: string) => `${P}pending:${tokenHash}`,
  subscriber: (id: string) => `${P}sub:${id}`,
  emailIndex: (index: string) => `${P}idx:${index}`,
  /** Held while one address's subscription is being changed. */
  addressLock: (index: string) => `${P}lock:idx:${index}`,
  siteSubscribers: (siteId: number) => `${P}site:${siteId}:subs`,
  /** Every subscriber id, whatever offices they follow (the backup reads it). */
  allSubscribers: `${P}subs`,
  /** Hash: applicants → JSON list of open dates at the last good observation. */
  openDates: (siteId: number) => `${P}open:${siteId}`,
  /** Set once a date has been announced, so a date that flickers is announced once. */
  announced: (siteId: number, applicants: number, date: string) => `${P}announced:${siteId}:${applicants}:${date}`,
  sites: `${P}sites`,
  status: `${P}status`,
  outbox: `${P}outbox`,
  checkLock: `${P}lock:check`,
  /** Set after a scan the site struggled with: scans wait until it expires. */
  scanCooldown: `${P}scan:cooldown`,
  mailPaused: `${P}mail:paused`,
  /** Set once the day's subscriber backup is in R2. */
  backupDone: (day: string) => `${P}backup:${day}`,
  mailSentToday: (day: string) => `${P}mail:sent:${day}`,
  alertsToday: (subscriberId: string, day: string) => `${P}alerts:${subscriberId}:${day}`,
  rate: (bucket: string, id: string) => `${P}rate:${bucket}:${id}`,
  /** Cached answers to on-demand lookups (dates for a group, hours of a day). */
  lookup: (what: string) => `${P}lookup:${what}`,
};

/** `YYYY-MM-DD` in Manila, where the day boundaries of the daily caps fall. */
export function manilaDay(now: number): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
