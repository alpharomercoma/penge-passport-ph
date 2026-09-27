import { randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sleep } from './async.js';
import { CircuitOpenError, RateLimitError } from './errors.js';
import { ENV_PREFIX, NAME } from './meta.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hard limits. Options can make the client slower than these, never faster.
 * They exist so that a caller cannot, by accident or by loop, turn this
 * package into a load generator against a public government service.
 */
export const LIMITS = Object.freeze({
  /** Smallest allowed gap between two requests to the same host. */
  minIntervalFloorMs: 2_000,
  defaultMinIntervalMs: 3_000,
  /**
   * Largest allowed request budget per rolling hour, per host and state
   * directory: one request every 3 s on average, the default spacing.
   */
  maxRequestsPerHourCeiling: 1200,
  defaultMaxRequestsPerHour: 300,
  /** Random extra delay, as a fraction of the interval, so clients don't sync up. */
  jitterRatio: 0.25,
  /** First pause after a failed request; doubles per consecutive failure. */
  backoffBaseMs: 5_000,
  backoffMaxMs: 10 * 60 * 1000,
  /** Longest server `Retry-After` we honour before treating it as a circuit trip. */
  retryAfterMaxMs: HOUR_MS,
  /** Consecutive failures that open the circuit, and how long it stays open. */
  circuitThreshold: 5,
  circuitOpenMs: 15 * 60 * 1000,
});

export interface GateOptions {
  minIntervalMs: number;
  maxRequestsPerHour: number;
  /**
   * Longest a call may wait, counted from when it was queued, before it is
   * refused with RateLimitError instead of being sent.
   */
  maxWaitMs: number;
  signal?: AbortSignal | undefined;
}

export interface Outcome {
  ok: boolean;
  /** Server-supplied `Retry-After`, if any. */
  retryAfterMs?: number | undefined;
}

interface GateState {
  lastDispatchAt: number;
  dispatched: number[];
  pauseUntil: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
}

const freshState = (): GateState => ({
  lastDispatchAt: 0,
  dispatched: [],
  pauseUntil: 0,
  consecutiveFailures: 0,
  circuitOpenUntil: 0,
});

/** Where a gate keeps its state. `update` must apply `fn` atomically. */
export interface StateStore {
  update<T>(fn: (state: GateState) => T): Promise<T>;
}

export class MemoryStore implements StateStore {
  private readonly state = freshState();
  async update<T>(fn: (state: GateState) => T): Promise<T> {
    return fn(this.state);
  }
}

const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 300;
/** A lock whose owner can't be read yet (it is being written) counts as dead only after this. */
const UNREADABLE_LOCK_GRACE_MS = 1_000;

/**
 * Gate state in a JSON file behind a lock file, so every process of the same
 * user on the same machine shares one spacing and one hourly budget.
 *
 * The lock holds its owner's pid and a random token. It is reclaimed only
 * when that process is gone, and waiting for it never blocks the event loop.
 * If the lock stays held by a live process, the request is refused (fail
 * closed). Only when the file system itself refuses (read-only, permissions)
 * does it warn once and fall back to limiting this process alone.
 */
export class FileStore implements StateStore {
  private fallback: MemoryStore | null = null;
  private readonly lock: string;

  constructor(private readonly file: string) {
    this.lock = `${file}.lock`;
  }

  async update<T>(fn: (state: GateState) => T): Promise<T> {
    if (this.fallback) return this.fallback.update(fn);
    let release: (() => void) | null;
    try {
      // Uncontended, this runs synchronously from lock to unlock.
      release = tryLock(this.lock);
      for (let i = 0; !release && i < LOCK_ATTEMPTS; i++) {
        await sleep(LOCK_RETRY_MS);
        release = tryLock(this.lock);
      }
    } catch (err) {
      return this.degrade(err, fn);
    }
    if (!release) {
      throw new RateLimitError(`Another process is holding ${this.lock}; retry shortly`, 1_000);
    }
    try {
      const state = readState(this.file);
      const result = fn(state);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, this.file);
      return result;
    } catch (err) {
      return this.degrade(err, fn);
    } finally {
      release();
    }
  }

  private degrade<T>(err: unknown, fn: (state: GateState) => T): Promise<T> {
    process.emitWarning(
      `cannot share rate-limit state through ${this.file} (${(err as Error).message}); limiting this process only`,
      { code: `${ENV_PREFIX}STATE` },
    );
    this.fallback = new MemoryStore();
    return this.fallback.update(fn);
  }
}

/** Take the lock, or return null if someone else holds it. Throws on file-system errors. */
function tryLock(lock: string, reclaimed = false): (() => void) | null {
  const token = `${process.pid}:${randomUUID()}`;
  try {
    writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return !reclaimed && reclaimIfOwnerDied(lock) ? tryLock(lock, true) : null;
  }
  return () => {
    try {
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
    } catch {
      // Gone already.
    }
  };
}

/**
 * Remove a lock whose owning process has exited. It is first moved aside and
 * re-read, so if another process replaced the dead lock with a live one in
 * the meantime, that live lock is put back instead of deleted.
 */
function reclaimIfOwnerDied(lock: string): boolean {
  let holder: string;
  let ageMs: number;
  try {
    holder = readFileSync(lock, 'utf8');
    ageMs = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return true; // released in the meantime
  }
  const pidText = holder.split(':')[0] ?? '';
  if (/^\d+$/.test(pidText)) {
    if (processAlive(Number(pidText))) return false;
  } else if (ageMs < UNREADABLE_LOCK_GRACE_MS) {
    return false; // created but not written yet
  }
  const aside = `${lock}.${randomUUID()}.dead`;
  try {
    renameSync(lock, aside);
  } catch {
    return false;
  }
  let removedDeadLock = true;
  try {
    if (readFileSync(aside, 'utf8') !== holder) {
      removedDeadLock = false;
      linkSync(aside, lock);
    }
  } catch {
    // A newer lock already took the path; leave it.
  }
  rmSync(aside, { force: true });
  return removedDeadLock;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every field present, with the type this package writes. */
function isGateState(v: unknown): v is GateState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    isFiniteNumber(s.lastDispatchAt) &&
    isFiniteNumber(s.pauseUntil) &&
    isFiniteNumber(s.consecutiveFailures) &&
    isFiniteNumber(s.circuitOpenUntil) &&
    Array.isArray(s.dispatched) &&
    s.dispatched.every(isFiniteNumber)
  );
}

function readState(file: string): GateState {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // A missing file is a fresh start; any other read error must not be
    // mistaken for one, or the shared history would be overwritten.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return freshState();
    throw err;
  }
  const now = Date.now();
  let raw: GateState | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isGateState(parsed)) raw = parsed;
  } catch {
    // Handled below.
  }
  if (!raw) {
    // Only this package writes the file, atomically and with every field, so
    // something else damaged it. What was sent in the last hour is unknown:
    // wait until that hour has passed rather than risk sending it all again.
    process.emitWarning(`${file} is unreadable; pausing requests for an hour, since what was sent in the last one is unknown`, {
      code: `${ENV_PREFIX}STATE`,
    });
    return { ...freshState(), pauseUntil: now + HOUR_MS };
  }
  // Clamp anything implausible (clock changes, a hand-edited file) so a bad
  // file can neither lift the limits nor block the client for ever.
  const horizon = now + LIMITS.retryAfterMaxMs + LIMITS.circuitOpenMs;
  return {
    lastDispatchAt: Math.min(raw.lastDispatchAt, now),
    // After the wall clock goes back, records look like the future. They count
    // as "now" rather than vanishing, so a rollback of any size cannot reset
    // the budget; the budget merely stays spent a little longer.
    dispatched: raw.dispatched
      .filter((t) => t > now - HOUR_MS)
      .map((t) => Math.min(t, now))
      .sort((a, b) => a - b)
      .slice(-LIMITS.maxRequestsPerHourCeiling),
    pauseUntil: Math.min(raw.pauseUntil, horizon),
    consecutiveFailures: Math.max(0, Math.floor(raw.consecutiveFailures)),
    circuitOpenUntil: Math.min(raw.circuitOpenUntil, horizon),
  };
}

type Decision =
  | { kind: 'go' }
  | { kind: 'wait'; ms: number }
  | { kind: 'refuse'; error: RateLimitError };

/**
 * This process's own record of its requests, on the monotonic clock. The
 * shared state uses the wall clock (so processes can compare notes), and the
 * wall clock can jump: NTP corrections, manual changes, a laptop waking up.
 * Checking both means a jump can never shorten a wait or reset the budget
 * within a process.
 */
interface LocalState {
  lastDispatchAt: number;
  dispatched: number[];
  pauseUntil: number;
  circuitOpenUntil: number;
}

/** Monotonic milliseconds (never jumps; faked along with timers in tests). */
const monotonic = () => performance.now();

/**
 * Serialises every request to one host and spaces them out. There is one
 * gate per host and state directory per process (see `gateFor`), and with a
 * FileStore the spacing and budget are shared with other processes too.
 */
export class HostGate {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly local: LocalState = {
    lastDispatchAt: Number.NEGATIVE_INFINITY,
    dispatched: [],
    pauseUntil: Number.NEGATIVE_INFINITY,
    circuitOpenUntil: Number.NEGATIVE_INFINITY,
  };

  constructor(
    private readonly random: () => number = Math.random,
    private readonly store: StateStore = new MemoryStore(),
  ) {}

  /**
   * Run `task` when this host's limits allow it. Tasks run one at a time, in
   * call order. `task` receives `report` and must call it with the result of
   * its network exchange so failures feed the backoff and circuit breaker.
   */
  run<T>(opts: GateOptions, task: (report: (o: Outcome) => void) => Promise<T>): Promise<T> {
    const queuedAt = monotonic();
    const result = this.tail.then(() => this.dispatch(opts, queuedAt, task));
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Count a failure that was detected outside a task (e.g. a rejected session). */
  async penalize(): Promise<void> {
    const now = Date.now();
    const mono = monotonic();
    await this.store.update((s) => this.recordFailure(s, now, mono));
  }

  /** Snapshot for diagnostics and tests. */
  stats() {
    const now = Date.now();
    const mono = monotonic();
    return this.store.update((s) => ({
      requestsLastHour: Math.max(
        s.dispatched.filter((t) => t > now - HOUR_MS && t <= now).length,
        this.local.dispatched.filter((t) => t > mono - HOUR_MS).length,
      ),
      consecutiveFailures: s.consecutiveFailures,
      pausedForMs: Math.max(0, s.pauseUntil - now, this.local.pauseUntil - mono),
      circuitOpenForMs: Math.max(0, s.circuitOpenUntil - now, this.local.circuitOpenUntil - mono),
    }));
  }

  private async dispatch<T>(
    opts: GateOptions,
    queuedAt: number,
    task: (report: (o: Outcome) => void) => Promise<T>,
  ): Promise<T> {
    // NaN or negative maxWaitMs means "don't wait at all".
    const maxWaitMs = opts.maxWaitMs >= 0 ? opts.maxWaitMs : 0;
    const deadline = queuedAt + maxWaitMs;
    const jitter = this.random() * LIMITS.jitterRatio * opts.minIntervalMs;
    for (;;) {
      opts.signal?.throwIfAborted();
      const mono = monotonic();
      if (mono > deadline) {
        throw new RateLimitError(
          `Waited ${Math.ceil((mono - queuedAt) / 1000)}s in the queue, over maxWaitMs (${Math.ceil(maxWaitMs / 1000)}s)`,
          0,
        );
      }
      const local = this.decideLocal(mono, opts, jitter);
      const decision =
        local.kind === 'go'
          ? await this.store.update((s) => this.decide(s, opts, jitter, deadline))
          : local;
      if (decision.kind === 'go') {
        this.local.lastDispatchAt = mono;
        this.local.dispatched.push(mono);
        break;
      }
      if (decision.kind === 'refuse') throw decision.error;
      if (mono + decision.ms > deadline) {
        throw new RateLimitError(
          `Next request slot is ${Math.ceil(decision.ms / 1000)}s away; this call has waited ` +
            `${Math.ceil((mono - queuedAt) / 1000)}s of its ${Math.ceil(maxWaitMs / 1000)}s maxWaitMs`,
          decision.ms,
        );
      }
      await sleep(decision.ms, opts.signal);
    }

    let recorded: Promise<void> | null = null;
    const report = (o: Outcome) => {
      if (recorded) return;
      const now = Date.now();
      const mono = monotonic();
      recorded = this.store
        .update((s) => {
          if (o.ok) s.consecutiveFailures = 0;
          else this.recordFailure(s, now, mono, o.retryAfterMs);
        })
        // Losing one outcome to a busy lock only weakens backoff slightly.
        .catch(() => undefined);
    };
    try {
      return await task(report);
    } catch (err) {
      // A task that throws without reporting was a transport failure.
      if (!isAbort(err)) report({ ok: false });
      throw err;
    } finally {
      // Let the outcome land before the next queued request decides.
      await recorded;
    }
  }

  /** The same rules as `decide`, against this process's monotonic record. */
  private decideLocal(mono: number, opts: GateOptions, jitter: number): Decision {
    const l = this.local;
    if (l.circuitOpenUntil > mono) {
      const wait = l.circuitOpenUntil - mono;
      return { kind: 'refuse', error: new CircuitOpenError(`Paused after repeated failures; retry in ${Math.ceil(wait / 1000)}s`, wait) };
    }
    l.dispatched = l.dispatched.filter((t) => t > mono - HOUR_MS);
    if (l.dispatched.length >= opts.maxRequestsPerHour) {
      const wait = l.dispatched[0]! + HOUR_MS - mono;
      return {
        kind: 'refuse',
        error: new RateLimitError(
          `Hourly budget of ${opts.maxRequestsPerHour} requests used; retry in ${Math.ceil(wait / 1000)}s`,
          wait,
        ),
      };
    }
    const readyAt = Math.max(l.lastDispatchAt + opts.minIntervalMs + jitter, l.pauseUntil);
    return readyAt > mono ? { kind: 'wait', ms: readyAt - mono } : { kind: 'go' };
  }

  /**
   * The shared decision. The clocks are read here, while holding the lock:
   * waiting for another process's lock can take seconds, and a stale reading
   * would back-date this dispatch or send it after its deadline.
   */
  private decide(s: GateState, opts: GateOptions, jitter: number, deadline: number): Decision {
    const now = Date.now();
    if (monotonic() > deadline) {
      return {
        kind: 'refuse',
        error: new RateLimitError('Waited past maxWaitMs for the shared rate-limit state', 0),
      };
    }
    if (s.circuitOpenUntil > now) {
      const wait = s.circuitOpenUntil - now;
      return {
        kind: 'refuse',
        error: new CircuitOpenError(
          `Paused after ${s.consecutiveFailures} consecutive failures; retry in ${Math.ceil(wait / 1000)}s`,
          wait,
        ),
      };
    }
    // Entries after `now` mean the wall clock went back; they still count, as now.
    s.dispatched = s.dispatched.map((t) => Math.min(t, now)).filter((t) => t > now - HOUR_MS);
    if (s.dispatched.length >= opts.maxRequestsPerHour) {
      const wait = Math.max(0, Math.min(...s.dispatched) + HOUR_MS - now);
      return {
        kind: 'refuse',
        error: new RateLimitError(
          `Hourly budget of ${opts.maxRequestsPerHour} requests used; retry in ${Math.ceil(wait / 1000)}s`,
          wait,
        ),
      };
    }
    const readyAt = Math.max(Math.min(s.lastDispatchAt, now) + opts.minIntervalMs + jitter, s.pauseUntil);
    if (readyAt > now) return { kind: 'wait', ms: readyAt - now };
    s.lastDispatchAt = now;
    s.dispatched.push(now);
    return { kind: 'go' };
  }

  private recordFailure(s: GateState, now: number, mono: number, retryAfterMs?: number) {
    // Only a finite, non-negative Retry-After means anything.
    const retryAfter = retryAfterMs !== undefined && retryAfterMs >= 0 && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
    s.consecutiveFailures += 1;
    const backoff = Math.min(
      LIMITS.backoffBaseMs * 2 ** (s.consecutiveFailures - 1),
      LIMITS.backoffMaxMs,
    );
    const honoured = Math.min(retryAfter, LIMITS.retryAfterMaxMs);
    const pause = Math.max(backoff, honoured);
    s.pauseUntil = Math.max(s.pauseUntil, now + pause);
    this.local.pauseUntil = Math.max(this.local.pauseUntil, mono + pause);
    if (s.consecutiveFailures >= LIMITS.circuitThreshold || retryAfter > LIMITS.retryAfterMaxMs) {
      const open = Math.max(LIMITS.circuitOpenMs, honoured);
      s.circuitOpenUntil = now + open;
      this.local.circuitOpenUntil = mono + open;
    }
  }
}

/**
 * Per-user directory for shared limiter state: `PENGE_PASSPORT_PH_STATE_DIR`,
 * else `$XDG_STATE_HOME/penge-passport-ph`, else `%LOCALAPPDATA%` on Windows,
 * else `~/.local/state/penge-passport-ph`.
 */
export function defaultStateDir(): string {
  const explicit = process.env[`${ENV_PREFIX}STATE_DIR`];
  if (explicit) return explicit;
  const base =
    process.env.XDG_STATE_HOME ??
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : join(homedir(), '.local', 'state'));
  return join(base, NAME);
}

const gates = new Map<string, HostGate>();

/** The gate for `host`, shared by every client in this process that uses `stateDir`. */
export function gateFor(host: string, stateDir: string): HostGate {
  const key = `${stateDir}\0${host}`;
  let gate = gates.get(key);
  if (!gate) {
    let store: StateStore;
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      store = new FileStore(join(stateDir, `${host.replace(/[^a-z0-9.-]/gi, '_')}.json`));
    } catch (err) {
      process.emitWarning(
        `cannot create ${stateDir} (${(err as Error).message}); limiting this process only`,
        { code: `${ENV_PREFIX}STATE` },
      );
      store = new MemoryStore();
    }
    gate = new HostGate(Math.random, store);
    gates.set(key, gate);
  }
  return gate;
}

/**
 * Validate caller-supplied limits against the hard floors. Throws rather than
 * silently clamping so a misconfiguration is visible.
 */
export function resolveLimits(opts: { minIntervalMs?: number; maxRequestsPerHour?: number }) {
  const minIntervalMs = opts.minIntervalMs ?? LIMITS.defaultMinIntervalMs;
  const maxRequestsPerHour = opts.maxRequestsPerHour ?? LIMITS.defaultMaxRequestsPerHour;
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < LIMITS.minIntervalFloorMs) {
    throw new RangeError(
      `minIntervalMs must be at least ${LIMITS.minIntervalFloorMs} (got ${minIntervalMs})`,
    );
  }
  if (
    !Number.isInteger(maxRequestsPerHour) ||
    maxRequestsPerHour < 1 ||
    maxRequestsPerHour > LIMITS.maxRequestsPerHourCeiling
  ) {
    throw new RangeError(
      `maxRequestsPerHour must be an integer from 1 to ${LIMITS.maxRequestsPerHourCeiling} (got ${maxRequestsPerHour})`,
    );
  }
  return { minIntervalMs, maxRequestsPerHour };
}

/**
 * Parse an HTTP `Retry-After` into milliseconds: delta-seconds (digits only),
 * or an HTTP date with a four-digit year. Anything else (negative, fractional,
 * "inf", a malformed date) is ignored, exactly as in the Python port.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^[0-9]+$/.test(v)) return Math.min(Number(v), RETRY_AFTER_CAP_S) * 1000;
  const at = parseHttpDate(v);
  return at === undefined ? undefined : Math.max(0, at - Date.now());
}

/** Seconds; anything longer is treated as this (and trips the circuit breaker). */
const RETRY_AFTER_CAP_S = 1_000_000_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * `Sat, 26 Sep 2026 13:59:32 GMT` (IMF-fixdate) or the dashed
 * `Sat, 26-Sep-2026 13:59:32 GMT` cookies use, to epoch milliseconds.
 * Computed arithmetically, not with `Date.parse`, so both languages agree.
 */
export function parseHttpDate(value: string): number | undefined {
  const m = /^[A-Za-z]{3}, ([0-9]{2})[ -]([A-Za-z]{3})[ -]([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(value);
  if (!m) return undefined;
  const [day, month, year, h, min, sec] = [Number(m[1]), MONTHS.indexOf(m[2]!.toLowerCase()), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 0 || year < 1 || day < 1 || day > days[month]! || h > 23 || min > 59 || sec > 60) return undefined;
  const epochDays = daysFromCivil(year, month + 1, day);
  return ((epochDays * 24 + h) * 60 + min) * 60_000 + sec * 1000;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Caller cancellation is not the server's fault; a timeout is. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
