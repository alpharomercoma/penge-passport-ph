// Posts abroad: the embassies and consulates, and their outreach missions,
// that book passport appointments on passport.gov.ph too. There are about 130,
// three times the offices at home, so they are not all asked on every run.
// Each run checks the 36 that are most overdue, on their own rate limiter
// (budget.ts): a post that publishes dates, or that someone follows, about
// once an hour; one that publishes none every few hours. The list of posts is
// itself read again once a week, a few countries per run.
import { type AbroadPost, type AbroadResponse, officeMapUrl, officePhone } from '@penge/contracts';
import { type Availability, CircuitOpenError, type Country, type Site } from 'penge-passport-ph';
import { K } from './keys.ts';
import type { Kv } from './kv.ts';
import type { Logger } from './log.ts';
import type { SiteObservation } from './snapshot.ts';

export interface AbroadUpstream {
  regions(): readonly { id: number; name: string }[];
  countries(regionId: number): Promise<Country[]>;
  sites(opts: { regionId: number; countryId: number }): Promise<Site[]>;
  availability(query: { siteId: number; applicants: number }): Promise<Availability>;
}

/** Posts checked in one run. 4 runs an hour x 36 covers every post about hourly. */
export const ABROAD_POSTS_PER_RUN = 36;
/** Steps of the weekly reading of the list (one region or one country each) in one run. */
export const CATALOG_STEPS_PER_RUN = 6;
/**
 * The posts and the list share this many requests a run. While the list has
 * never been read in full, all of them go to reading it, so a new server shows
 * its posts within half an hour instead of one.
 */
export const ABROAD_REQUESTS_PER_RUN = ABROAD_POSTS_PER_RUN + CATALOG_STEPS_PER_RUN;
/** Extra lookups per run for group sizes at posts abroad. */
export const ABROAD_GROUP_CAP = 4;
export const ACTIVE_EVERY_MINUTES = 60;
export const QUIET_EVERY_MINUTES = 6 * 60;
export const CATALOG_MAX_AGE_MS = 7 * 24 * 3600_000;
/**
 * Posts abroad are left for the next run once a run is this old, so it ends
 * before the next starts (runs are 15 minutes apart; systemd stops one at 15).
 */
export const ABROAD_DEADLINE_MS = 12 * 60_000;
/** The Philippines is region 1, country 1 on passport.gov.ph: its offices are the main scan. */
const HOME = { regionId: 1, countryId: 1 };

interface CountryEntry {
  regionId: number;
  region: string;
  countryId: number;
  country: string;
  readAt: string;
  sites: Pick<Site, 'id' | 'name' | 'address' | 'telephone' | 'mapUrl'>[];
}

type Step = { kind: 'region'; regionId: number } | { kind: 'country'; regionId: number; countryId: number; country: string };

export interface CatalogPost {
  id: number;
  name: string;
  address: string | null;
  telephone: string | null;
  mapUrl: string | null;
  regionId: number;
  region: string;
  countryId: number;
  country: string;
}

interface Stored {
  status: AbroadPost;
  dueAt: number;
}

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

function parse<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Every post abroad from the last reading of the list, by region, country, then name. */
export async function catalogPosts(kv: Kv): Promise<CatalogPost[]> {
  const posts: CatalogPost[] = [];
  for (const raw of Object.values(await kv.hGetAll(K.abroadCountries))) {
    const c = parse<CountryEntry>(raw);
    if (!c) continue;
    for (const s of c.sites) {
      posts.push({
        id: s.id,
        name: s.name,
        address: s.address ?? null,
        telephone: s.telephone ?? null,
        mapUrl: s.mapUrl ?? null,
        regionId: c.regionId,
        region: c.region,
        countryId: c.countryId,
        country: c.country,
      });
    }
  }
  return posts.sort((a, b) => a.regionId - b.regionId || a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
}

/**
 * One run's share of reading the list: when the last full reading is a week
 * old (or there is none), a plan of steps is made, one per region; each region
 * adds a step per country; each run takes a few steps. A step that fails goes
 * back on the plan and the rest wait for the next run.
 */
export async function stepCatalog(
  kv: Kv,
  upstream: AbroadUpstream,
  now: () => number,
  more: () => boolean,
  log: Logger,
  maxSteps: number = CATALOG_STEPS_PER_RUN,
): Promise<{ steps: number; problems: string[] }> {
  const problems: string[] = [];
  if ((await kv.lLen(K.abroadPlan)) === 0) {
    const at = await kv.get(K.abroadCatalogAt);
    if (at && now() - Date.parse(at) < CATALOG_MAX_AGE_MS) return { steps: 0, problems };
    const regions: Step[] = upstream.regions().map((r) => ({ kind: 'region', regionId: r.id }));
    await kv.write([{ op: 'rPush', key: K.abroadPlan, values: regions.map((s) => JSON.stringify(s)) }]);
    log.info('reading the list of posts abroad', { regions: regions.length });
  }
  const regionName = new Map(upstream.regions().map((r) => [r.id, r.name]));
  let steps = 0;
  while (steps < maxSteps && more()) {
    const raw = await kv.lPop(K.abroadPlan);
    if (raw === null) break;
    const step = parse<Step>(raw);
    if (!step) continue;
    steps++;
    try {
      if (step.kind === 'region') {
        const countries = (await upstream.countries(step.regionId)).filter(
          (c) => !(step.regionId === HOME.regionId && c.id === HOME.countryId),
        );
        const next: Step[] = countries.map((c) => ({ kind: 'country', regionId: step.regionId, countryId: c.id, country: c.name }));
        if (next.length) await kv.write([{ op: 'rPush', key: K.abroadPlan, values: next.map((s) => JSON.stringify(s)) }]);
        // Countries the region no longer lists leave the list.
        const listed = new Set(countries.map((c) => c.id));
        const all = await kv.hGetAll(K.abroadCountries);
        const gone = Object.entries(all).filter(([, v]) => {
          const c = parse<CountryEntry>(v);
          return c?.regionId === step.regionId && !listed.has(c.countryId);
        });
        if (gone.length) {
          const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !gone.some(([g]) => g === k)));
          await kv.write([{ op: 'del', key: K.abroadCountries }, ...(Object.keys(kept).length ? [{ op: 'hSet', key: K.abroadCountries, fields: kept } as const] : [])]);
        }
      } else {
        const sites = await upstream.sites({ regionId: step.regionId, countryId: step.countryId });
        const entry: CountryEntry = {
          regionId: step.regionId,
          region: regionName.get(step.regionId) ?? `Region ${step.regionId}`,
          countryId: step.countryId,
          country: step.country,
          readAt: new Date(now()).toISOString(),
          sites: sites.map((s) => ({ id: s.id, name: s.name, address: s.address, telephone: s.telephone, mapUrl: s.mapUrl })),
        };
        await kv.write([{ op: 'hSet', key: K.abroadCountries, fields: { [String(step.countryId)]: JSON.stringify(entry) } }]);
      }
    } catch (err) {
      problems.push(`${step.kind === 'region' ? `region ${step.regionId}` : step.country}: ${message(err)}`);
      await kv.write([{ op: 'rPush', key: K.abroadPlan, values: [raw] }]);
      break;
    }
    if ((await kv.lLen(K.abroadPlan)) === 0) {
      await kv.set(K.abroadCatalogAt, new Date(now()).toISOString());
      log.info('the list of posts abroad is read', { posts: (await catalogPosts(kv)).length });
      break;
    }
  }
  return { steps, problems };
}

async function storedStatus(kv: Kv): Promise<Map<number, Stored>> {
  const map = new Map<number, Stored>();
  for (const [id, raw] of Object.entries(await kv.hGetAll(K.abroadStatus))) {
    const s = parse<Stored>(raw);
    if (s) map.set(Number(id), s);
  }
  return map;
}

export interface AbroadObservation extends SiteObservation {
  post: CatalogPost;
}

/** The posts most overdue, oldest first, at most ABROAD_POSTS_PER_RUN; each is asked once, for one person. */
export async function scanAbroad(opts: {
  kv: Kv;
  upstream: AbroadUpstream;
  now: () => number;
  more: () => boolean;
  holdLock: () => Promise<void>;
  maxPosts?: number;
  /** Every post, due or not: a sweep started by hand. */
  all?: boolean;
}): Promise<{ observations: AbroadObservation[]; circuitOpen: boolean }> {
  const { kv, upstream, now } = opts;
  const stored = await storedStatus(kv);
  const due = (await catalogPosts(kv))
    .map((post) => ({ post, dueAt: stored.get(post.id)?.dueAt ?? 0 }))
    .filter((p) => opts.all || p.dueAt <= now())
    .sort((a, b) => a.dueAt - b.dueAt || a.post.id - b.post.id)
    .slice(0, opts.all ? undefined : (opts.maxPosts ?? ABROAD_POSTS_PER_RUN));

  const observations: AbroadObservation[] = [];
  let circuitOpen = false;
  for (const { post } of due) {
    if (circuitOpen || !opts.more()) break;
    await opts.holdLock();
    const base = { id: post.id, name: post.name, address: post.address, telephone: post.telephone, mapUrl: post.mapUrl, post };
    try {
      const a = await upstream.availability({ siteId: post.id, applicants: 1 });
      observations.push({
        ...base,
        ok: true,
        error: null,
        from: a.from,
        to: a.to,
        publishedDays: a.days.length,
        openDates: [...a.availableDates].sort(),
        days: a.days,
        fetchedAt: a.fetchedAt,
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) circuitOpen = true;
      observations.push({ ...base, ok: false, error: message(err), from: null, to: null, publishedDays: 0, openDates: [], days: [], fetchedAt: null });
    }
  }
  return { observations, circuitOpen };
}

/** When a post is next asked: hourly if it publishes dates or someone follows it, else every few hours. */
export function nextDue(now: number, o: Pick<SiteObservation, 'ok' | 'publishedDays'>, followed: boolean): number {
  const quiet = o.ok && o.publishedDays === 0 && !followed;
  return now + (quiet ? QUIET_EVERY_MINUTES : ACTIVE_EVERY_MINUTES) * 60_000;
}

/** A post whose check failed keeps what was known, marked as not checked this time. */
export async function writeAbroadStatus(kv: Kv, observations: AbroadObservation[], now: number, followed: (id: number) => boolean) {
  if (observations.length === 0) return;
  const stored = await storedStatus(kv);
  const fields: Record<string, string> = {};
  for (const o of observations) {
    const place = { regionId: o.post.regionId, region: o.post.region, countryId: o.post.countryId, country: o.post.country };
    const old = stored.get(o.id)?.status;
    const status: AbroadPost =
      !o.ok && old
        ? { ...old, ok: false }
        : {
            id: o.id,
            name: o.name,
            address: o.address,
            telephone: officePhone(o.telephone),
            mapUrl: officeMapUrl(o.mapUrl),
            checkedAt: o.fetchedAt,
            ok: o.ok,
            openDates: o.openDates,
            fullDates: o.days.filter((d) => !d.available).map((d) => d.date).sort(),
            windowEnd: o.to,
            publishedDays: o.publishedDays,
            ...place,
          };
    fields[String(o.id)] = JSON.stringify({ status, dueAt: nextDue(now, o, followed(o.id)) } satisfies Stored);
  }
  await kv.write([{ op: 'hSet', key: K.abroadStatus, fields }]);
}

/** What the website shows: every post on the list, with its latest check (or none yet). */
export async function abroadResponse(kv: Kv): Promise<AbroadResponse> {
  const stored = await storedStatus(kv);
  const posts = (await catalogPosts(kv)).map((p): AbroadPost => {
    const place = { regionId: p.regionId, region: p.region, countryId: p.countryId, country: p.country };
    const s = stored.get(p.id)?.status;
    // The list is fresher than a post's last check: its name and contacts come from the list.
    const contact = { name: p.name, address: p.address, telephone: officePhone(p.telephone), mapUrl: officeMapUrl(p.mapUrl) };
    return s
      ? { ...s, ...contact, ...place }
      : { id: p.id, ...contact, checkedAt: null, ok: false, openDates: [], fullDates: [], windowEnd: null, publishedDays: 0, ...place };
  });
  return { catalogAt: await kv.get(K.abroadCatalogAt), checkedEveryMinutes: ACTIVE_EVERY_MINUTES, posts };
}
