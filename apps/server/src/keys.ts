// Every Redis key the server uses, in one place. All keys share a prefix so
// the database can hold other things without collisions.
const P = 'pp:';

export const K = {
  pending: (tokenHash: string) => `${P}pending:${tokenHash}`,
  /** The confirmation links still waiting for an address (token hashes), so unsubscribing can cancel them. */
  pendingFor: (index: string) => `${P}pending-idx:${index}`,
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
  /** One person's alerts waiting for their next email (signed, like the outbox), and who has any. */
  held: (subscriberId: string) => `${P}held:${subscriberId}`,
  heldSubscribers: `${P}held-subs`,
  /** When a person was last sent an alert, for their pace. */
  lastAlert: (subscriberId: string) => `${P}last-alert:${subscriberId}`,
  /** Set by the first run of each boot, which restarts every person's gap (checker.ts). */
  bootSeen: (bootId: string) => `${P}boot-seen:${bootId}`,
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
  /** Hash: country id → JSON of that country's posts abroad, as last read from the DFA. */
  abroadCountries: `${P}abroad:countries`,
  /** List of steps left in the current reading of the posts abroad (JSON each). */
  abroadPlan: `${P}abroad:plan`,
  /** When the list of posts abroad was last read in full. */
  abroadCatalogAt: `${P}abroad:catalog-at`,
  /** Hash: post id → JSON of its latest check and when it is next due. */
  abroadStatus: `${P}abroad:status`,
  /** One of a Manila day's numbers (stats.ts): a counter, or a HyperLogLog of visitors. */
  stat: (day: string, name: string) => `${P}stats:${day}:${name}`,
  /** Hash: office id → how often it was opened that day. */
  statOffices: (day: string) => `${P}stats:${day}:offices`,
  /** Random, and deleted within a day: what that day's visitors are hashed with. */
  statSalt: (day: string) => `${P}stats:salt:${day}`,
  /** When counting began, so a report does not pass off a part of a day as the whole of it. */
  statsSince: `${P}stats:since`,
  /** Set once a day's numbers are in R2, and once they are emailed. */
  statsStored: (day: string) => `${P}stats:stored:${day}`,
  statsEmailed: (day: string) => `${P}stats:emailed:${day}`,
};

/** `YYYY-MM-DD` in Manila, where the day boundaries of the daily caps fall. */
export function manilaDay(now: number): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
