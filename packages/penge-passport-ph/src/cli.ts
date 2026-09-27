#!/usr/bin/env node
import { assertContact, CONTACT_RULE, MAX_APPLICANTS, PengePassportPH } from './client.js';
import { PengePassportPHError } from './errors.js';
import { isIsoDate } from './parse.js';
import { CLI_ALIAS, DISPLAY_NAME, ENV_PREFIX, HOMEPAGE, NAME, VERSION } from './meta.js';
import type { Site } from './types.js';

const HELP = `${DISPLAY_NAME} ${VERSION}: penge ng slot? Tingnan muna natin.
Read-only, rate-limited DFA passport appointment availability (passport.gov.ph).

Usage
  ${NAME} <command> [options]
  ${CLI_ALIAS} <command> [options]    (short alias)

Commands
  check      Open dates at one site          --site <id|name> [--applicants n] [--from] [--to] [--times]
  watch      Report dates as they open/close --site <id|name> [--site ...] [--interval 5m] [--applicants n]
  sites      List consular sites             [--region <id> --country <id>] [--search <text>]
  countries  List countries in a region      --region <id>
  regions    List regions

Options
  --applicants <n>  People in the booking: 1, or 2 to 5 for a group (default 1)
  --from, --to      Date range, YYYY-MM-DD (default: the site's own booking window)
  --times           With check: also list the time slots on the earliest open date
  --interval <d>    With watch: time between rounds, e.g. 90s, 10m (min 60s, default 5m)
  --json            Machine-readable output
  --contact <s>     Your email or URL, added to the User-Agent
  -h, --help        Show this help
  -v, --version     Show the version

Examples
  ${NAME} sites --search cebu
  ${NAME} check --site antipolo --times
  ${NAME} watch --site 486 --site "Angeles" --interval 10m

Requests are at least 2 s apart and capped per hour, shared by every
${DISPLAY_NAME} process you run. It never selects or reserves a time slot.
Unofficial; not affiliated with the Department of Foreign Affairs.
${HOMEPAGE}`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseCliArgs(argv);
  const [command] = positionals;
  if (values.version) {
    print(VERSION);
    return 0;
  }
  if (values.help) {
    print(HELP);
    return 0;
  }
  if (!command) {
    process.stderr.write(`${HELP}\n`);
    return 2; // no command is a usage error
  }

  // Everything the user typed is checked here, before any request, with the
  // same messages as the Python CLI.
  const json = values.json ?? false;
  const regionId = values.region !== undefined ? toInt(values.region, '--region') : undefined;
  const countryId = values.country !== undefined ? toInt(values.country, '--country') : undefined;
  const applicants = values.applicants !== undefined ? toInt(values.applicants, '--applicants') : undefined;
  if (applicants !== undefined && applicants > MAX_APPLICANTS) throw new UsageError(`--applicants must be 1 to ${MAX_APPLICANTS}`);
  for (const flag of ['from', 'to'] as const) {
    const value = values[flag];
    if (value !== undefined && !isIsoDate(value)) throw new UsageError(`--${flag} must be a YYYY-MM-DD date`);
  }
  if (values.from !== undefined && values.to !== undefined && values.from > values.to) {
    throw new UsageError('--from is after --to');
  }
  if (values.contact !== undefined && !isContact(values.contact)) throw new UsageError(`--${CONTACT_RULE}`);
  const intervalMs = values.interval !== undefined ? parseDuration(values.interval) : undefined;
  if (intervalMs !== undefined && intervalMs < 60_000) throw new UsageError('--interval must be at least 60s');

  const baseUrl = process.env[`${ENV_PREFIX}BASE_URL`];
  const client = new PengePassportPH({
    ...(baseUrl && { baseUrl }),
    ...(values.contact !== undefined && { contact: values.contact }),
  });
  const place = {
    ...(regionId !== undefined && { regionId }),
    ...(countryId !== undefined && { countryId }),
  };

  switch (command) {
    case 'regions': {
      const regions = client.regions();
      if (json) {
        print(JSON.stringify(regions, null, 2));
        return 0;
      }
      for (const r of regions) print(`${String(r.id).padStart(3)}  ${r.name}`);
      return 0;
    }
    case 'countries': {
      if (regionId === undefined) throw new UsageError('countries needs --region');
      const countries = await client.countries(regionId);
      if (json) {
        print(JSON.stringify(countries, null, 2));
        return 0;
      }
      for (const c of countries) print(`${String(c.id).padStart(4)}  ${c.name}`);
      return 0;
    }
    case 'sites': {
      const sites = values.search
        ? await client.findSites(values.search, place)
        : await client.sites(place);
      if (json) {
        print(JSON.stringify(sites, null, 2));
        return 0;
      }
      for (const s of sites) print(`${String(s.id).padStart(5)}  ${s.name}`);
      return 0;
    }
    case 'check': {
      const [site] = await resolveSites(client, values.site, place, 1);
      const availability = await client.availability({
        siteId: site!.id,
        ...(applicants !== undefined && { applicants }),
        ...(values.from !== undefined && { from: values.from }),
        ...(values.to !== undefined && { to: values.to }),
      });
      const times =
        values.times && availability.earliest
          ? await client.timeSlots({
              siteId: site!.id,
              date: availability.earliest,
              ...(applicants !== undefined && { applicants }),
            })
          : undefined;
      if (json) {
        print(JSON.stringify({ site, availability, ...(times && { times }) }, null, 2));
        return 0;
      }
      print(`${site!.name} (site ${site!.id})`);
      print(`Checked ${availability.from} to ${availability.to} for ${availability.applicants} applicant(s)`);
      if (!availability.earliest) {
        print(`No available dates among ${availability.days.length} published day(s).`);
      } else {
        print(`Earliest: ${availability.earliest}`);
        print(`Available (${availability.availableDates.length}): ${availability.availableDates.join(', ')}`);
      }
      if (times) {
        print(`\nTime slots on ${availability.earliest}:`);
        for (const t of times) print(`  ${t.start}-${t.end}  ${t.status}`);
      }
      return 0;
    }
    case 'watch': {
      const sites = await resolveSites(client, values.site, place, Infinity);
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      const names = new Map(sites.map((s) => [s.id, s.name]));
      for await (const event of client.watch({
        siteIds: sites.map((s) => s.id),
        signal: controller.signal,
        ...(intervalMs !== undefined && { intervalMs }),
        ...(applicants !== undefined && { applicants }),
      })) {
        const stamp = new Date().toISOString();
        const name = names.get(event.siteId) ?? event.siteId;
        if (json) {
          print(JSON.stringify({ at: stamp, ...event, ...(event.type === 'error' && { error: event.error.message }) }));
        } else if (event.type === 'error') {
          print(`${stamp}  ${name}: error: ${event.error.message}`);
        } else if (event.initial || event.opened.length || event.closed.length) {
          const a = event.availability;
          const parts = [`earliest ${a.earliest ?? 'none'}`];
          if (!event.initial && event.opened.length) parts.push(`opened ${event.opened.join(', ')}`);
          if (event.closed.length) parts.push(`closed ${event.closed.join(', ')}`);
          print(`${stamp}  ${name}: ${parts.join('; ')}`);
        }
      }
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${command}"; run \`${NAME} --help\``);
  }
}

async function resolveSites(
  client: PengePassportPH,
  inputs: string[] | undefined,
  place: { regionId?: number; countryId?: number },
  max: number,
): Promise<Site[]> {
  if (!inputs?.length) throw new UsageError('--site is required');
  if (inputs.length > max) throw new UsageError(`pass at most ${max} --site`);
  const all = await client.sites(place);
  return inputs.map((input) => {
    if (/^[0-9]+$/.test(input)) {
      const site = all.find((s) => s.id === Number(input));
      if (!site) throw new UsageError(`no site with id ${input}; list them with \`${NAME} sites\``);
      return site;
    }
    const needle = input.toLowerCase();
    const matches = all.filter((s) => s.name.toLowerCase().includes(needle));
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new UsageError(`no site matches "${input}"; list them with \`${NAME} sites\``);
    throw new UsageError(
      `"${input}" matches ${matches.length} sites:\n${matches.map((s) => `  ${s.id}  ${s.name}`).join('\n')}`,
    );
  });
}

function parseDuration(value: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
  if (!m) throw new UsageError(`bad duration "${value}"; use e.g. 90s, 5m, 1h`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Number(m[1]) * unit;
}

function toInt(value: string, flag: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function print(line: string) {
  process.stdout.write(`${line}\n`);
}

class UsageError extends Error {}

function isContact(value: string): boolean {
  try {
    assertContact(value);
    return true;
  } catch {
    return false;
  }
}

const VALUE_OPTIONS = new Set([
  'region', 'country', 'search', 'site', 'applicants', 'from', 'to', 'interval', 'contact',
]);
const BOOL_OPTIONS = new Set(['times', 'json', 'help', 'version']);
const SHORT: Record<string, string> = { h: 'help', v: 'version' };

interface CliValues {
  region?: string;
  country?: string;
  search?: string;
  site?: string[];
  applicants?: string;
  from?: string;
  to?: string;
  interval?: string;
  contact?: string;
  times?: boolean;
  json?: boolean;
  help?: boolean;
  version?: boolean;
}

/**
 * Flags anywhere, `--flag value` or `--flag=value`, `--site` repeatable, `--`
 * ends the flags. The Python CLI uses the same rules, so both accept and
 * reject exactly the same command lines with the same messages.
 */
function parseCliArgs(argv: string[]): { values: CliValues; positionals: string[] } {
  const values: Record<string, string | string[] | boolean> = {};
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i++]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i));
      break;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else if (arg.length === 2 && arg[0] === '-' && SHORT[arg[1]!]) {
      name = SHORT[arg[1]!]!;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`unknown option '${arg}'`);
    } else {
      positionals.push(arg);
      continue;
    }
    if (BOOL_OPTIONS.has(name)) {
      if (inline !== undefined) throw new UsageError(`option '--${name}' does not take a value`);
      values[name] = true;
    } else if (VALUE_OPTIONS.has(name)) {
      let value: string;
      if (inline !== undefined) value = inline;
      else if (i < argv.length && !argv[i]!.startsWith('-')) value = argv[i++]!;
      else throw new UsageError(`option '--${name} <value>' needs a value`);
      if (name === 'site') ((values.site ??= []) as string[]).push(value);
      else values[name] = value;
    } else {
      throw new UsageError(`unknown option '--${name}'`);
    }
  }
  return { values: values as CliValues, positionals };
}

/** Exit codes: 0 ok, 1 unexpected, 2 usage, 3 site/rate-limit/session error. */
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError || err instanceof RangeError) {
      process.stderr.write(`${NAME}: ${err.message}\n`);
      process.exitCode = 2;
    } else if (err instanceof PengePassportPHError) {
      process.stderr.write(`${NAME}: ${err.name}: ${err.message}\n`);
      process.exitCode = 3;
    } else {
      process.stderr.write(`${NAME}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 1;
    }
  },
);
