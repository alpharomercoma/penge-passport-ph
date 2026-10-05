// Every Redis key the server uses, in one place. All keys share a prefix so
// the database can hold other things without collisions.
const P = 'pp:';

export const K = {
  pending: (tokenHash: string) => `${P}pending:${tokenHash}`,
  /** The confirmation links still waiting for an address (token hashes), so unsubscribing can cancel them. */
  pendingFor: (index: string) => `${P}pending-idx:${index}`,
  deletion: (tokenHash: string) => `${P}deletion:${tokenHash}`,
  deletionsFor: (index: string) => `${P}deletion-idx:${index}`,
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
  /** The last scan record stored in R2 for a stream (record.ts): its day, key and run fields. */
  recordHead: (stream: string) => `${P}record:${stream}:head`,
  /** Hash: site id → that site's observation as last recorded in R2 (record.ts). */
  recordSites: (stream: string) => `${P}record:${stream}:sites`,
  /** Set: keys of records that could be kept nowhere, named in the next record stored (record.ts). */
  recordLost: (stream: string) => `${P}record:${stream}:lost`,
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
  /** The site-wide daily limit the day's runs enforced, for the day's report. */
  mailLimit: (day: string) => `${P}mail:limit:${day}`,
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
  /** Hash: device id → sealed device (endpoint and keys, label, created, last success, last failure). */
  pushDevices: (subscriberId: string) => `${P}push:${subscriberId}`,
  /** Hash: device id → "state|revision|credential hash|endpoint hmac|subscription hmac"; what the scripts compare. */
  pushMeta: (subscriberId: string) => `${P}push:meta:${subscriberId}`,
  /** "<subscriber id>/<device id>": one owner per endpoint. */
  pushEndpoint: (endpointHmac: string) => `${P}push:endpoint:${endpointHmac}`,
  /** "<subscriber id>/<device id>": one owner per credential. */
  pushCred: (credentialHash: string) => `${P}push:cred:${credentialHash}`,
  /** Set of pending-token hashes asking push for this credential; 48 h. */
  pushPending: (credentialHash: string) => `${P}push:pending:${credentialHash}`,
  /** A credential turned off; 72 h, longer than any confirmation link. */
  pushRevoked: (credentialHash: string) => `${P}push:revoked:${credentialHash}`,
  /** Set of "<token hash>|<address index>" for pending requests that change channels (push-downgrade reads it). */
  pendingChannels: `${P}pending:channels`,
  /** The subscriber id an address will get while it has none. */
  reserved: (index: string) => `${P}reserved:${index}`,
  /** The operator's emergency stop for push alone. */
  pushPaused: `${P}push:paused`,
  /** The address index a provisional subscriber id belongs to; written with its first device, gone when the subscriber exists. */
  pushAddress: (subscriberId: string) => `${P}push:address:${subscriberId}`,
  /** Present only in a throwaway local Valkey: tests that wipe data refuse any other. */
  pushTestMark: `${P}test:disposable`,
};

/** `YYYY-MM-DD` in Manila, where the day boundaries of the daily caps fall. */
export function manilaDay(now: number): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
