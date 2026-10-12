// What the page does for this device's notification alert (spec: "Notification alerts on a device"). Everything
// that changes local state goes through state.js (one record, one lock); network calls and waits happen outside
// the lock, and what they learn is written only if the operation and credential are still current (checked again
// under the lock by state.js). An operation keeps its result in the record until the next one replaces it, so a
// second tab or press that joined it reads the same result.
import type { Activation, AlertChoices, MineAnswer, OperationView, SetupAnswer } from '@penge/contracts';
import * as S from './state.js';
import { type DeviceApi, DeviceApiError } from './api.ts';

export const POLL_FAST_MS = 2000;
export const POLL_FAST_FOR_MS = 30_000;
export const POLL_SLOW_MS = 10_000;
export const ACK_RETRY_MS = 15_000;
export const REPEAT_AFTER_MS = [5000, 15_000, 45_000];
export const RENEW_EVERY_MS = 3_600_000;
export const RENEW_RETRY_MS = [60_000, 300_000, 900_000];
/** An operation whose server never answered is given up 2 minutes after it was made; one with an expiry, 30 s after it. */
export const UNANSWERED_MS = 120_000;
export const AFTER_EXPIRY_MS = 30_000;
/** A `preparing` operation no page carries on is taken over after this. */
export const PREPARING_STALE_MS = 10_000;

export const TEXT = {
  on: 'Notifications are on for this device.',
  cantFinish: "This browser can't finish setting up notifications.",
  slow: 'Still setting up. Check that notifications are allowed for this site.',
  expired: 'Setting up notifications took too long. Open PengePassportPH to try again.',
  full: 'Notifications are full right now. Email alerts still work.',
  didntFinish: "This notification setup didn't finish.",
  again: 'Notifications need setting up again on this device.',
  legacy: 'Close other tabs of this site and reopen it to set up notifications.',
  blocked: 'Notifications are blocked on this device, so we turned them off.',
  offDone: 'Notifications are off on this device.',
  offBrowser: "This browser didn't stop its subscription. Block notifications for this site in its settings to be sure.",
  offPending: "Deleting them from our server when you're back online.",
  finishingOff: 'Finishing turning notifications off on this device. Try again in a moment.',
  deadSubscription: 'This browser kept a subscription that no longer works. Block, then allow, notifications for this site in its settings, and try again.',
  testAccepted: 'Accepted by the push service. Check this device.',
  testUncertain: "Sent, but the push service didn't confirm. Check this device before trying again.",
  testRefused: "The push service didn't take it. Try again later.",
  updating: "Updating this device's notifications…",
  renewFailing: "We couldn't renew it just now; we'll try again.",
  unavailable: 'Notifications are not available right now. Email alerts still work.',
  limited: 'Too many tries from here just now. Try again in a while.',
  ownerOnly: 'Notifications are still being tested and are not open to everyone yet.',
  offline: 'We could not reach the server. Check your connection and try again.',
  changedMeanwhile: 'This alert changed meanwhile. Check it and try again.',
} as const;

export interface BrowserSub {
  json: S.SubscriptionJson;
  unsubscribe(): Promise<boolean>;
}
export interface Browser {
  permission(): NotificationPermission;
  subscription(): Promise<BrowserSub | null>;
  subscribe(vapidKey: string): Promise<BrowserSub>;
  workerReady(): Promise<boolean>;
  workerReads(op: string): Promise<boolean>;
  closeNotifications(): Promise<void>;
  /** Runs `fn` holding the driver lock if no other page holds it; null if one does. */
  drive<T>(fn: () => Promise<T>): Promise<T | null>;
  visible(): boolean;
}
export interface ControllerDeps {
  env: S.Env;
  api: DeviceApi;
  browser: Browser;
  /** Wall clock: stored times (creation, renewal) and server deadlines turned local. */
  now(): number;
  /** Monotonic clock (performance.now()): every wait and deadline within one page. */
  mono(): number;
  sleep(ms: number): Promise<void>;
  ownerToken(): string | null;
  forgetOwner(): void;
  vapidKey(): string | null;
}
export type RowView =
  | { kind: 'none' }
  | { kind: 'on'; alert: S.Known; renewFailing: boolean }
  | { kind: 'setting-up'; slow: boolean }
  | { kind: 'blocked' }
  | { kind: 'ended'; endedAt: number }
  | { kind: 'again' }
  /** Turned off: whether the browser confirmed its subscription gone, and whether the server confirmed the deletion. */
  | { kind: 'off'; unsubscribed: boolean; deleted: boolean }
  | { kind: 'cant-check' }
  | { kind: 'legacy' }
  | { kind: 'updating' };
export type SetupResult = { ok: true; text: string } | { ok: false; text: string; retry: boolean };
type Outcome = { result: string; activation: Activation | null };

const known = (a: Extract<MineAnswer, { state: 'active' }>['alert']): S.Known => ({
  alertId: a.alertId, incarnation: a.incarnation, generation: a.generation, revision: a.revision, fingerprint: a.fingerprint, endsAt: Date.parse(a.endsAt), choices: a.choices,
});
/** Answers to a setup or rotation request that mean the server stored nothing for it: the operation ends here. */
const NOT_ADMITTED = new Set(['off', 'unavailable', 'owner-only', 'full', 'changed']);

export class DeviceController {
  view: RowView = { kind: 'none' };
  private listeners = new Set<(v: RowView) => void>();
  private renewFails = 0;
  private renewTimer: Promise<void> | null = null;
  private rotations = 0;
  private readonly d: ControllerDeps;
  constructor(d: ControllerDeps) {
    this.d = d;
  }

  subscribe(listener: (v: RowView) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private show(v: RowView) {
    this.view = v;
    for (const l of this.listeners) l(v);
    return v;
  }
  private fp = (sub: BrowserSub) => S.fingerprint(this.d.env, sub.json);

  // ---- Turn-off left-overs and the channel release's state: resolved before anything else, every time. ----

  /** True when no unsubscribe claim remains: the subscription it names is confirmed gone, or belongs to a newer opt-in. */
  private async resolveClaim(): Promise<boolean> {
    for (let round = 0; round < 2; round++) {
      const s = await S.readState(this.d.env);
      if (!s.claim) return true;
      const current = await this.d.browser.subscription();
      if (!current) {
        await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: true });
        return true;
      }
      const fp = await this.fp(current);
      if (fp !== s.claim.fingerprint) {
        if (s.op?.fingerprint === fp || s.known?.fingerprint === fp) {
          // An opt-in started after the turn-off owns it: the claim is done with.
          await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: true });
          return true;
        }
        // Another subscription, nobody's: a claim for it replaces this one (then a second round unsubscribes it).
        await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: false, replaceWith: fp });
        continue;
      }
      const ok = await current.unsubscribe().catch(() => false);
      const after = await this.d.browser.subscription();
      const gone = ok && (!after || (await this.fp(after)) !== fp);
      await S.settleClaim(this.d.env, { task: s.claim.task, unsubscribed: gone });
      return gone;
    }
    return false;
  }

  /** True when every retired credential's server deletion is confirmed (deleted, then nothing found under it). */
  private async resolveRetired(): Promise<boolean> {
    const s = await S.readState(this.d.env);
    let all = true;
    for (const r of s.retired.filter((x) => !x.deleted)) {
      try {
        await this.d.api.turnOff(r.credential);
        if ((await this.d.api.mine(r.credential)).state === 'none') await S.retiredDeleted(this.d.env, { credential: r.credential });
        else all = false;
      } catch {
        all = false;
      }
    }
    return all;
  }

  /** The channel release's local credential, retired before any setup; false when that cannot be done (or known). */
  private async retireLegacy(): Promise<boolean> {
    const legacy = await S.legacyCredential(this.d.env);
    if (legacy === 'no') return true;
    if (legacy === 'unknown') return false;
    if (legacy === 'empty') {
      try {
        await S.deleteLegacy(this.d.env);
        return true;
      } catch {
        return false; // an old tab holds it open: it could still make a credential there
      }
    }
    const current = await this.d.browser.subscription();
    if (current) {
      const fp = await this.fp(current);
      const wrote = await S.update(this.d.env, (s) =>
        s.claim || s.op?.fingerprint === fp || s.known?.fingerprint === fp ? { result: false } : { state: { ...s, claim: { task: S.newId(this.d.env), fingerprint: fp } }, result: true },
      );
      if (wrote && !(await this.resolveClaim())) return false;
    }
    try {
      await S.deleteLegacy(this.d.env);
      return true;
    } catch {
      return false;
    }
  }

  private async settleRetirement(): Promise<'ok' | 'pending' | 'legacy'> {
    if (!(await this.retireLegacy().catch(() => false))) return 'legacy';
    // The browser's subscription unknown (no worker yet): the claim stays, and setup waits.
    const claimOk = await this.resolveClaim().catch(() => false);
    const retiredOk = await this.resolveRetired();
    return claimOk && retiredOk ? 'ok' : 'pending';
  }

  /** Removes a subscription the server reported gone (through a claim, confirming it went) before any new one. */
  private async removeGone(fp: string, credential: string | null, epoch: number): Promise<boolean> {
    await S.noteGone(this.d.env, fp);
    const current = await this.d.browser.subscription();
    if (!current || (await this.fp(current)) !== fp) return true;
    // Claimed only for the credential and epoch that learnt it was gone, and only if nothing this device knows uses it
    // now (another operation or the known alert may have taken it meanwhile).
    const claimed = await S.update(this.d.env, (s) =>
      s.claim || s.credential !== credential || s.epoch !== epoch || (s.op && !s.op.result && s.op.fingerprint === fp) || s.known?.fingerprint === fp
        ? { result: false }
        : { state: { ...s, claim: { task: S.newId(this.d.env), fingerprint: fp } }, result: true },
    );
    return claimed ? this.resolveClaim() : true;
  }

  // ---- Reconcile on every opening and every return to the page. ----

  /** A failure shown only if nothing changed since `seen` was read (a turn-off, a new credential): else the row stands. */
  private async failedSince(seen: { credential: string | null; epoch: number } | null): Promise<RowView> {
    const now = await S.readState(this.d.env).catch(() => null);
    if (seen && now && (now.credential !== seen.credential || now.epoch !== seen.epoch)) return this.view;
    return this.show({ kind: 'cant-check' });
  }

  async reconcile(): Promise<RowView> {
    this.rotations = 0;
    let seen: { credential: string | null; epoch: number } | null = null;
    try {
      const retirement = await this.settleRetirement();
      if (retirement === 'legacy') return this.show({ kind: 'legacy' });
      await this.settleStale().catch(() => undefined);
      const s = await S.readState(this.d.env);
      seen = { credential: s.credential, epoch: s.epoch };
      if (!s.credential) {
        if (s.retired.length > 0 || s.claim) return this.show({ kind: 'off', unsubscribed: !s.claim, deleted: s.retired.every((r) => r.deleted) });
        return this.show({ kind: 'none' });
      }
      if (this.d.browser.permission() === 'denied') {
        await this.turnOff();
        return this.show({ kind: 'blocked' });
      }
      // An operation that ended "gone" (its subscription no longer exists at the push service): that subscription is
      // removed and remembered before anything else, so no later setup reuses it.
      if (s.op?.result === 'gone' && s.op.fingerprint && !s.gone.includes(s.op.fingerprint)) await this.removeGone(s.op.fingerprint, s.credential, s.epoch);
      const op = s.op;
      if (op && !op.result && !S.opDone(op, this.d.now())) {
        if (op.kind === 'change') return this.replayChange(op, s.credential);
        if (op.phase === 'preparing' || op.phase === 'attached') {
          // Carried on by drive(): it waits while another page makes the operation ready, recovers it once it is stale
          // (again and again while another page holds the driver lock), and then drives it.
          const credential = s.credential;
          this.show({ kind: 'setting-up', slow: false });
          void this.drive(op, credential).then((r) => this.result(op, credential, r));
          return this.view;
        }
        this.show({ kind: 'setting-up', slow: false });
        void this.drive(op, s.credential).then((r) => this.result(op, s.credential!, r));
        return this.view;
      }
      return await this.afterRead(s.credential, await this.d.api.mine(s.credential), s);
    } catch (err) {
      if (err instanceof S.Unsupported) return this.show({ kind: 'none' });
      return this.failedSince(seen);
    }
  }

  private async afterRead(credential: string, mine: MineAnswer, before: S.DeviceState, depth = 0): Promise<RowView> {
    // A read that comes back after a turn-off or a new credential says nothing about this device any more; checked again
    // after every wait below, before anything is written or shown.
    const stale = async () => (await S.readState(this.d.env)).credential !== credential;
    if (await stale()) return this.view;
    // Every write from a read is fenced by the `knownVersion` it started from: if anything changed `known` meanwhile (a
    // setup that just finished, a turn-off, another read), this read writes nothing and the row is unchanged.
    if (mine.state === 'gone') {
      if (!(await S.setKnown(this.d.env, { credential, known: null, version: before.knownVersion }))) return this.view;
      await this.removeGone(mine.fingerprint, credential, before.epoch);
      // The clean-up waited on the browser: shown only if this read still owns the row.
      const after = await S.readState(this.d.env);
      if (after.credential !== credential || after.epoch !== before.epoch || after.knownVersion !== before.knownVersion + 1) return this.view;
      return this.show({ kind: 'again' });
    }
    if (mine.state === 'ended') {
      // Nothing to capture any more: the next setup is a first setup.
      if (!(await S.setKnown(this.d.env, { credential, known: null, version: before.knownVersion }))) return this.view;
      return this.show({ kind: 'ended', endedAt: Date.parse(mine.endedAt) });
    }
    if (mine.state === 'none') {
      const had = before.known !== null;
      if (!(await S.setKnown(this.d.env, { credential, known: null, version: before.knownVersion }))) return this.view;
      // A first setup whose subscription changed before it finished starts again with the saved choices.
      if (before.needsRotation && before.choices) {
        // Fenced: a turn-off (or anything else) since this read means nothing more is done from it.
        if (!(await S.setNeedsRotation(this.d.env, { on: false, credential, epoch: before.epoch }))) return this.view;
        if (this.d.browser.permission() === 'granted') {
          void this.setup(before.choices, 0, { credential, epoch: before.epoch });
          return this.show({ kind: 'setting-up', slow: false });
        }
        return this.show({ kind: 'again' });
      }
      return this.show(had ? { kind: 'again' } : { kind: 'none' });
    }
    const k = known(mine.alert);
    // An older revision than the device knows (a read overtaken by a change) is not written, and not shown.
    if (!(await S.setKnown(this.d.env, { credential, known: k, version: before.knownVersion }))) return this.view;
    // From here, this read owns `known` at version v; any other write since (a turn-off, a setup, another read) means
    // this read shows and does nothing more.
    let v = before.knownVersion + 1;
    const moved = async () => {
      const now = await S.readState(this.d.env);
      return now.credential !== credential || now.knownVersion !== v;
    };
    if (mine.alert.updating) return this.show({ kind: 'updating' });
    // "On" needs the browser's proof too (spec): permission granted and its subscription the alert's. Unknown (no worker
    // reached): can't check, nothing rotated or renewed. Not granted: set up again (blocked was handled before the read).
    const current = await this.d.browser.subscription().catch(() => undefined);
    const fp = current ? await this.fp(current) : null;
    if (await moved()) return this.view;
    if (current === undefined) return this.show({ kind: 'cant-check' });
    if (this.d.browser.permission() !== 'granted') return this.show({ kind: 'again' });
    if (fp !== k.fingerprint) {
      if (!(await S.setNeedsRotation(this.d.env, { on: true, credential, epoch: before.epoch }))) return this.view;
      // One rotation per reconcile: a rotation answered "changed" is tried again at the next opening.
      if (this.rotations++ === 0) return this.rotate(credential, k, 0, { credential, epoch: before.epoch });
      return this.show({ kind: 'updating' });
    }
    if (before.needsRotation) await S.setNeedsRotation(this.d.env, { on: false, credential, epoch: before.epoch });
    const renewal = await this.renew(credential, k);
    if (renewal === 'not-active') {
      // The server no longer has it active (ended or deleted between the read and the renewal): read it again, once.
      if (await moved()) return this.view;
      return depth === 0 ? this.reconcileAfter(credential, 1) : this.show({ kind: 'cant-check' });
    }
    if (renewal === 'wrote') v++;
    const now = await S.readState(this.d.env);
    // Shown only if nothing else changed `known` meanwhile, and from what is stored (never this read's copy) ...
    if (now.credential !== credential || now.knownVersion !== v || !now.known) return this.view;
    // ... and with the browser's proof taken again after the renewal's wait (permission or subscription may have moved).
    const proof = await this.proof(now.known.fingerprint);
    // The proof was a wait too: nothing is shown if `known` or the credential moved during it.
    const last = await S.readState(this.d.env);
    if (last.credential !== credential || last.knownVersion !== v || !last.known) return this.view;
    if (proof === 'unknown') return this.show({ kind: 'cant-check' });
    if (proof === 'not-granted') return this.show({ kind: 'again' });
    if (proof === 'other') return depth === 0 ? this.reconcileAfter(credential, 1) : this.show({ kind: 'updating' });
    return this.show({ kind: 'on', alert: last.known, renewFailing: this.renewFails > 0 });
  }

  /** The browser's side of "on": permission granted and its current subscription the one with this fingerprint. */
  private async proof(fingerprint: string): Promise<'ok' | 'unknown' | 'not-granted' | 'other'> {
    const current = await this.d.browser.subscription().catch(() => undefined);
    if (current === undefined) return 'unknown';
    if (this.d.browser.permission() !== 'granted') return 'not-granted';
    if (!current || (await this.fp(current)) !== fingerprint) return 'other';
    return 'ok';
  }

  /**
   * On opening, unless the last confirmed renewal is under an hour old (a time in the future is discarded). 'wrote':
   * the new end was written onto the same alert still known; 'kept': nothing written (not due, failing, or the alert
   * known changed meanwhile, which a renewal never undoes); 'not-active': the server has no active alert any more.
   */
  private async renew(credential: string, k: S.Known): Promise<'wrote' | 'kept' | 'not-active'> {
    const s = await S.readState(this.d.env);
    const at = s.renewedAt !== null && s.renewedAt <= this.d.now() ? s.renewedAt : null;
    if (at !== null && this.d.now() - at < RENEW_EVERY_MS) return 'kept';
    try {
      const r = await this.d.api.seen(credential);
      if (r.state !== 'active') return 'not-active';
      await S.setRenewed(this.d.env, { credential, at: this.d.now() });
      this.renewFails = 0;
      // Only the new end, onto the same alert if it is still the one known: a renewal never brings back a replaced or
      // cleared alert, nor older choices.
      const next = await S.setEndsAt(this.d.env, { credential, alertId: k.alertId, incarnation: k.incarnation, generation: k.generation, endsAt: Date.parse(r.endsAt) });
      return next ? 'wrote' : 'kept';
    } catch {
      this.renewFails++;
      this.scheduleRenewRetry(credential);
      return 'kept';
    }
  }

  /** Renewal retried while visible: after 1, 5 and 15 minutes, then hourly; one attempt per retry. */
  private scheduleRenewRetry(credential: string) {
    if (this.renewTimer) return;
    const wait = RENEW_RETRY_MS[this.renewFails - 1] ?? RENEW_EVERY_MS;
    this.renewTimer = this.d.sleep(wait).then(async () => {
      this.renewTimer = null;
      if (!this.d.browser.visible()) return;
      // Retried only for the same credential, from what is stored now (never this read's older copy).
      const now = await S.readState(this.d.env);
      if (now.credential !== credential || !now.known) return;
      // One full reconciliation: it renews once (still due), schedules the next retry if that fails, and decides the
      // row from the server's alert, the version fence and the browser's proof.
      const v = await this.reconcileAfter(credential);
      // The read itself failed before the renewal was tried: the schedule goes on (counted as a failed attempt).
      if (v.kind === 'cant-check' && !this.renewTimer && (await S.readState(this.d.env)).credential === credential) {
        this.renewFails++;
        this.scheduleRenewRetry(credential);
      }
    });
  }

  // ---- Setup, rotation and the driving page. ----

  /** `expect`: an automatic setup (not the person's), only for the credential and epoch that decided it. */
  async setup(choices: AlertChoices, depth = 0, expect?: { credential: string; epoch: number }): Promise<SetupResult> {
    try {
      if (!(await this.d.browser.workerReady())) return { ok: false, text: TEXT.cantFinish, retry: false };
      const retirement = await this.settleRetirement();
      if (retirement === 'legacy') return { ok: false, text: TEXT.legacy, retry: false };
      if (retirement === 'pending') return { ok: false, text: TEXT.finishingOff, retry: true };
      if ((await this.settleStale()) === 'unverified') return { ok: false, text: TEXT.offline, retry: true };
      const s0 = await S.readState(this.d.env);
      const captured = s0.credential && s0.known ? { incarnation: s0.known.incarnation, generation: s0.known.generation, revision: s0.known.revision } : null;
      const r = await S.begin(this.d.env, { kind: 'setup', choices, captured, now: this.d.now(), ...(expect ? { expect } : {}) });
      if ('blocked' in r) return r.blocked === 'moved' ? { ok: false, text: TEXT.didntFinish, retry: true } : { ok: false, text: TEXT.finishingOff, retry: true };
      if ('joined' in r) {
        const credential = (await S.readState(this.d.env)).credential!;
        return this.result(r.joined, credential, await this.drive(r.joined, credential));
      }
      if ('waiting' in r) {
        if (depth > 0) return { ok: false, text: TEXT.slow, retry: true };
        const credential = (await S.readState(this.d.env)).credential!;
        await this.drive(r.waiting, credential);
        await this.reconcile();
        return this.setup(choices, depth + 1, expect);
      }
      const { started: op, credential } = r;
      // Prepared under the driver lock, so recovery (which takes it too) never mistakes a slow page for a gone one. If
      // another page holds it, that page carries this operation on: this one drives (waits for) its result.
      const prepared = await this.d.browser.drive(() => this.prepare(op));
      if (prepared === null) return this.result(op, credential, await this.drive(op, credential));
      if (!prepared.ok) return prepared.result;
      return this.result(prepared.ready, credential, await this.drive(prepared.ready, credential));
    } catch (err) {
      if (err instanceof S.Unsupported) return { ok: false, text: TEXT.cantFinish, retry: false };
      if (err instanceof DeviceApiError) return { ok: false, text: TEXT.offline, retry: true };
      return { ok: false, text: TEXT.didntFinish, retry: true };
    }
  }

  /**
   * Preparing an operation, shared by setup and by recovery: a subscription (a gone one removed first), attached by
   * compare-and-set, the worker's proof it reads the same storage, and the VAPID key kept for re-subscribing.
   */
  private async prepare(op: S.Operation): Promise<{ ok: true; ready: S.Operation } | { ok: false; result: SetupResult }> {
    // This caller's attachment id: a failure here drops the operation only while it is still preparing or if this caller
    // attached it, never a request another page (or the worker) attached and sent.
    const by = S.newId(this.d.env);
    let attachedHere = false;
    let attachedFp: string | null = null;
    const fail = async (text: string, retry: boolean) => {
      // The subscription this caller attached goes too, unless something newer uses it (abandon decides, under the lock).
      const claim = await S.abandon(this.d.env, { op: op.op, fingerprint: attachedHere ? attachedFp : null, by: attachedHere ? by : null });
      if (claim) await this.resolveClaim().catch(() => false);
      return { ok: false as const, result: { ok: false as const, text, retry } };
    };
    // Whatever throws on the way (the browser, the worker's message, storage) is cleaned up as a failure is, then passed on.
    try {
      const s0 = await S.readState(this.d.env);
      const vapid = this.d.vapidKey() ?? s0.vapidKey;
      if (!vapid) return fail(TEXT.unavailable, false);
      if (this.d.browser.permission() !== 'granted') return fail(TEXT.again, true);
      let sub = await this.d.browser.subscription();
      if (sub && s0.gone.includes(await this.fp(sub))) {
        if (!(await this.removeGone(await this.fp(sub), s0.credential, s0.epoch))) return fail(TEXT.deadSubscription, false);
        sub = null;
      }
      sub ??= await this.d.browser.subscribe(vapid);
      const fp = await this.fp(sub);
      if (s0.gone.includes(fp)) return fail(TEXT.deadSubscription, false);
      const attached = await S.attach(this.d.env, { op: op.op, epoch: op.epoch, subscription: sub.json, fingerprint: fp, by });
      if (attached === 'abandoned') {
        if (await S.abandon(this.d.env, { op: op.op, fingerprint: fp, by: null })) await this.resolveClaim().catch(() => false);
        return { ok: false, result: { ok: false, text: TEXT.didntFinish, retry: true } };
      }
      attachedHere = attached === 'ok';
      if (attachedHere) attachedFp = fp;
      const current = await S.readState(this.d.env);
      const stored = current.op;
      if (!stored || stored.op !== op.op || !stored.subscription) return { ok: false, result: { ok: false, text: TEXT.didntFinish, retry: true } };
      if (!attachedHere) {
        // 'already': another caller attached first. Its exact stored request stands and this page joins it; the drive
        // waits until that caller's handshake makes it ready. A different fingerprint here is the browser's newer
        // subscription: the alert is rotated to it at the next opening.
        if (stored.fingerprint !== fp) await S.setNeedsRotation(this.d.env, { on: true, credential: current.credential ?? '', epoch: op.epoch });
        return { ok: true, ready: stored };
      }
      // A proof that throws (the worker's message failed) is a proof that failed: the hidden-page check below applies.
      if (!(await this.d.browser.workerReads(op.op).catch(() => false))) {
        // Hidden meanwhile: the proof may have failed only because the page is in the background; nothing is dropped.
        if (!this.d.browser.visible()) return { ok: false, result: { ok: false, text: TEXT.slow, retry: false } };
        return fail(TEXT.cantFinish, false);
      }
      await S.setVapid(this.d.env, vapid);
      if (!(await S.confirmReady(this.d.env, { op: op.op, by }))) {
        // A recovering page adopted it meanwhile (this page was slow): join the operation it made ready, if it did.
        const now = (await S.readState(this.d.env)).op;
        if (now?.op === op.op && (now.phase === 'ready' || now.phase === 'sent')) return { ok: true, ready: now };
        return { ok: false, result: { ok: false, text: TEXT.didntFinish, retry: true } };
      }
      return { ok: true, ready: { ...stored, phase: 'ready' } };
    } catch (err) {
      await fail(TEXT.didntFinish, true).catch(() => undefined);
      throw err;
    }
  }

  /**
   * An operation no page carried on (the page or worker that made it went away), recovered here under the driver lock:
   * still preparing, it is prepared; attached but never made ready, it is adopted from its recorded owner, and the
   * handshake is done here against its stored (immutable) subscription.
   */
  private async recoverPreparing(op: S.Operation, credential: string): Promise<void> {
    // The lock covers preparing and driving only; the outcome is presented (and may rotate, which drives under the same
    // lock) after it is released.
    const got = await this.d.browser.drive(async (): Promise<{ ready: S.Operation; outcome: Outcome } | null> => {
      // A hidden page recovers nothing: the next visible one does (its proofs may fail only because it is in the background).
      if (!this.d.browser.visible()) return null;
      const s = await S.readState(this.d.env);
      if (s.op?.op !== op.op || s.epoch !== op.epoch || s.op.result) return null;
      let ready: S.Operation;
      if (s.op.phase === 'preparing') {
        const prepared = await this.prepare(s.op);
        if (!prepared.ok) return null;
        ready = prepared.ready;
      } else if (s.op.phase === 'attached') {
        const by = S.newId(this.d.env);
        if (!(await S.adopt(this.d.env, { op: s.op.op, from: s.op.by, by }))) return null;
        // A proof that throws (the worker's message failed) is a proof that failed: the same clean-up.
        if (!(await this.d.browser.workerReads(s.op.op).catch(() => false))) {
          if (!this.d.browser.visible()) return null;
          if (await S.abandon(this.d.env, { op: s.op.op, fingerprint: s.op.fingerprint, by })) await this.resolveClaim().catch(() => false);
          return null;
        }
        const vapid = this.d.vapidKey() ?? s.vapidKey;
        if (vapid) await S.setVapid(this.d.env, vapid);
        if (!(await S.confirmReady(this.d.env, { op: s.op.op, by }))) return null;
        ready = { ...s.op, phase: 'ready', by };
      } else return null;
      return { ready, outcome: await this.driveHere(ready, credential) };
    });
    if (got) await this.result(got.ready, credential, got.outcome);
  }

  /** `expect`: the credential and epoch that decided the rotation; nothing starts once they changed (a turn-off). */
  private async rotate(credential: string, k: S.Known, attempt = 0, expect?: { credential: string; epoch: number }): Promise<RowView> {
    const vapid = this.d.vapidKey() ?? (await S.readState(this.d.env)).vapidKey;
    if (!vapid) return this.show({ kind: 'again' });
    if ((await this.settleStale().catch(() => 'ok' as const)) === 'unverified') return this.show({ kind: 'cant-check' });
    const r = await S.begin(this.d.env, { kind: 'rotate', choices: null, captured: { incarnation: k.incarnation, generation: k.generation }, now: this.d.now(), ...(expect ? { expect } : {}) });
    // Fenced out (a turn-off since this rotation was decided): the newer row stands.
    if ('blocked' in r && r.blocked === 'moved') return this.view;
    // Joined (the same rotation in progress): driven from here too, so it never waits for another opening.
    if ('joined' in r) {
      const o = await this.drive(r.joined, credential);
      return o.result === 'hidden' ? this.view : this.reconcileAfter(credential);
    }
    if (!('started' in r)) return this.show({ kind: 'setting-up', slow: false });
    // Prepared under the driver lock (as a setup is), so recovery never mistakes a slow rotation for a gone one; if
    // another page holds it, that page carries the rotation on.
    const prepared = await this.d.browser.drive(async (): Promise<RowView | 'ready'> => {
      const by = S.newId(this.d.env);
      const sub = (await this.d.browser.subscription()) ?? (this.d.browser.permission() === 'granted' ? await this.d.browser.subscribe(vapid) : null);
      if (!sub) {
        await S.abandon(this.d.env, { op: r.started.op, fingerprint: null, by: null });
        return this.show({ kind: 'again' });
      }
      const fp = await this.fp(sub);
      const attached = await S.attach(this.d.env, { op: r.started.op, epoch: r.started.epoch, subscription: sub.json, fingerprint: fp, by });
      if (attached === 'abandoned') {
        if (await S.abandon(this.d.env, { op: r.started.op, fingerprint: fp, by: null })) await this.resolveClaim();
        return this.show({ kind: 'none' });
      }
      // 'ok': no handshake for a rotation (the worker that would read it is the one that started rotations before), so
      // it is ready at once. 'already' (the worker or a recovering page attached first): the stored request is driven,
      // once its attaching caller makes it ready.
      if (attached === 'ok') await S.confirmReady(this.d.env, { op: r.started.op, by });
      return 'ready';
    });
    if (prepared === null) {
      // The lock was taken: driven from here once free (drive() recovers a preparation left stale), never stranded.
      this.show({ kind: 'setting-up', slow: false });
      const o = await this.drive(r.started, credential);
      return o.result === 'hidden' ? this.view : this.reconcileAfter(credential);
    }
    if (prepared !== 'ready') return prepared;
    const ready = (await S.readState(this.d.env)).op;
    if (!ready || ready.op !== r.started.op || !ready.subscription) return this.reconcileAfter(credential);
    const outcome = await this.drive(ready, credential);
    // Hidden: the rotation stays as it is for the next visible opening; nothing more is asked of the server now.
    if (outcome.result === 'hidden') return this.view;
    if (outcome.result === 'changed' && attempt === 0) {
      // The alert changed under the rotation (a re-setup or a change won): read it again and rotate once more,
      // if the credential and the browser's subscription are as they were.
      const now = await S.readState(this.d.env);
      const cur = await this.d.browser.subscription();
      if (now.credential === credential && cur && (await this.fp(cur)) === ready.fingerprint) {
        const mine = await this.d.api.mine(credential).catch(() => null);
        if (mine?.state === 'active') return this.rotate(credential, known(mine.alert), 1, { credential, epoch: now.epoch });
      }
    }
    if (outcome.result === 'active') {
      // Cleared only if the browser still has the subscription that was proven.
      const now = await this.d.browser.subscription();
      if (now && (await this.fp(now)) === ready.fingerprint) await S.setNeedsRotation(this.d.env, { on: false, credential, epoch: r.started.epoch });
    }
    return this.reconcileAfter(credential);
  }

  private async reconcileAfter(credential: string, depth = 0): Promise<RowView> {
    let seen: { credential: string | null; epoch: number } | null = null;
    try {
      // The state before the read is the read's starting point (afterRead's version fence).
      const before = await S.readState(this.d.env);
      seen = { credential: before.credential, epoch: before.epoch };
      return await this.afterRead(credential, await this.d.api.mine(credential), before, depth);
    } catch {
      return this.failedSince(seen);
    }
  }

  /**
   * Drives the operation to a terminal result or its end (spec, step 7). Only the visible page holding the driver lock
   * drives; another waits, reading the result the driver records, and takes over when the driver goes away.
   */
  private async drive(op: S.Operation, credential: string): Promise<Outcome> {
    const driveStart = this.d.mono();
    for (;;) {
      const s = await S.readState(this.d.env);
      if (s.credential !== credential || s.op?.op !== op.op) return { result: 'changed', activation: null };
      if (s.op.result) return { result: s.op.result, activation: s.op.activation };
      // A hidden page neither drives nor asks the server anything: it stops here (the operation stays unfinished) and
      // the next opening or return to the page carries it on (reconcile).
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      // Done by the wall clock: confirmed with the server first (a device clock that jumped ahead is not an expiry).
      if (S.opDone(s.op, this.d.now())) {
        const st = await this.serverOp(op.op, credential);
        if (st.kind === 'terminal') {
          await S.recordResult(this.d.env, { op: op.op, credential, result: st.result, activation: st.activation });
          return { result: st.result, activation: st.activation };
        }
        // Sent, and the server has no record of it: it expired and was reclaimed.
        if (st.kind === 'absent' && s.op.phase === 'sent') return { result: 'expired', activation: null };
        // Unknown (offline) for longer than any operation can last: given up.
        if (st.kind === 'unknown' && this.d.mono() - driveStart > UNANSWERED_MS + 300_000 + AFTER_EXPIRY_MS) return { result: 'expired', activation: null };
        // Open (its deadline refreshed by serverOp), or never sent (absent, ready): driven as usual.
      }
      // Driven here if no other page holds the driver lock; a 'hidden' from driveHere (the page was hidden while it
      // drove) ends this too. Not ready yet, or another page drives: wait and look again.
      const driven = await this.d.browser.drive(() => this.driveHere(s.op!, credential));
      if (driven && driven.result !== 'not-ready') return driven;
      // Not ready, and no page has made it so in time (the one that started it went away): recovered here, under the
      // driver lock, rather than waited on for ever.
      if ((s.op.phase === 'preparing' || s.op.phase === 'attached') && this.d.now() - s.op.createdAt >= PREPARING_STALE_MS) {
        await this.recoverPreparing(s.op, credential);
        // Another page may hold the driver lock (recovery then did nothing): never a loop without a wait.
        await this.d.sleep(POLL_FAST_MS);
        continue;
      }
      await this.d.sleep(POLL_SLOW_MS);
    }
  }

  private async send(op: S.Operation, credential: string): Promise<SetupAnswer> {
    const sub = { endpoint: op.subscription!.endpoint, keys: op.subscription!.keys };
    if (op.kind === 'rotate') return this.d.api.rotate(credential, { op: op.op, seq: op.seq, subscription: sub, captured: { incarnation: op.captured!.incarnation, generation: op.captured!.generation } });
    const owner = op.captured ? undefined : (this.d.ownerToken() ?? undefined);
    return this.d.api.setup(credential, { op: op.op, seq: op.seq, subscription: sub, choices: op.choices!, captured: op.captured as never }, owner);
  }

  /**
   * What the server has of this operation: 'open' (its local deadline refreshed from the server's remaining time),
   * 'terminal' with its result, 'absent' (never stored, or reclaimed), or 'unknown' (the server could not be asked).
   */
  private async serverOp(op: string, credential: string): Promise<{ kind: 'open' | 'absent' | 'unknown' } | { kind: 'terminal'; result: string; activation: Activation | null }> {
    const mine = await this.d.api.mine(credential).catch(() => null);
    if (!mine) return { kind: 'unknown' };
    const o = mine.operation;
    if (!o || o.op !== op) return { kind: 'absent' };
    if (o.result) return { kind: 'terminal', result: o.result, activation: o.activation };
    if (o.remainingMs !== null) await S.markSent(this.d.env, { op, expiresAt: this.d.now() + o.remainingMs });
    return { kind: 'open' };
  }

  /**
   * Before starting anything: an unfinished operation whose wall-clock deadline passed is settled by what the server
   * says (its result kept, or its deadline refreshed), so a device clock that jumped never lets a new operation replace
   * one the server still has open.
   */
  private async settleStale(): Promise<'ok' | 'unverified'> {
    const s = await S.readState(this.d.env);
    const o = s.op;
    if (!s.credential || !o || o.result || !S.opDone(o, this.d.now())) return 'ok';
    const st = await this.serverOp(o.op, s.credential);
    if (st.kind === 'terminal') await S.recordResult(this.d.env, { op: o.op, credential: s.credential, result: st.result, activation: st.activation });
    // A request that may have been sent (sent, or ready with its answer lost) and the server could not be asked about may
    // still be open there: nothing replaces it until it can be.
    if (st.kind === 'unknown' && (o.phase === 'sent' || o.phase === 'ready')) return 'unverified';
    return 'ok';
  }

  /** Every answer's expiry becomes this device's own deadline (now + the server's remaining time); never its absolute time. */
  private async noteView(op: string, view: OperationView) {
    if (view.remainingMs !== null) await S.markSent(this.d.env, { op, expiresAt: this.d.now() + view.remainingMs });
  }

  private async driveHere(op: S.Operation, credential: string): Promise<Outcome> {
    // Not ready yet (preparing, or attached while its caller's handshake runs): the caller that attached it makes it
    // ready; this page keeps waiting for it ('not-ready' is never a result).
    if (op.phase === 'preparing' || op.phase === 'attached' || !op.subscription) return { result: 'not-ready', activation: null };
    if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
    const record = async (result: string, activation: Activation | null): Promise<Outcome> => {
      await S.recordResult(this.d.env, { op: op.op, credential, result, activation });
      const s = await S.readState(this.d.env);
      return s.op?.op === op.op && s.op.result ? { result: s.op.result, activation: s.op.activation } : { result, activation };
    };
    let view: OperationView | null = null;
    /** When (on this page's monotonic clock) the last view arrived: its relative times count from here. */
    let viewAt = 0;
    // Time on this page is measured monotonically (a wall-clock jump never ends or hurries an operation): the operation's
    // age is its wall-clock age when this page took it over, plus the monotonic time since.
    const startMono = this.d.mono();
    const startWall = this.d.now();
    const age = () => Math.max(0, startWall - op.createdAt) + (this.d.mono() - startMono);
    /** Reads an answer to the request; returns a terminal outcome, or null to keep driving. */
    /** The last answer was a limit: if the operation then ends unadmitted, the person is told it was limited. */
    let limited = false;
    const take = async (answer: SetupAnswer | null): Promise<Outcome | null> => {
      if (answer) limited = answer.outcome === 'limited';
      if (!answer || answer.outcome === 'limited' || answer.outcome === 'busy') return null;
      if (answer.outcome === 'pending' || answer.outcome === 'done') {
        if (answer.operation) {
          view = answer.operation;
          viewAt = this.d.mono();
          await this.noteView(op.op, view);
        }
        return null;
      }
      // A follow-up read only while visible; hidden, the loop's next check stops (the operation is kept).
      if (!this.d.browser.visible()) return null;
      if (answer.outcome === 'invalid') {
        // Not this operation (another request with its id, or one too old): read what the server has.
        const mine = await this.d.api.mine(credential).catch(() => null);
        if (mine?.operation?.op === op.op) {
          view = mine.operation;
          viewAt = this.d.mono();
          return null;
        }
        return record('failed', null);
      }
      if (NOT_ADMITTED.has(answer.outcome)) {
        // Refused before storage, unless an earlier request of this operation was stored (its answer lost): ask.
        const mine = await this.d.api.mine(credential).catch(() => null);
        if (mine?.operation?.op === op.op) {
          view = mine.operation;
          viewAt = this.d.mono();
          return null;
        }
        if (!mine) return null; // unknown: keep driving, the next repeat or read decides
        if (answer.outcome === 'owner-only') this.d.forgetOwner();
        return record(answer.outcome === 'off' ? 'unavailable' : answer.outcome, null);
      }
      return null;
    };
    /** An answer's view of the operation is kept (and its deadline noted, the request marked sent) whatever happens next,
     * a hide included: a page taking over then knows it was sent, and the server's retry time. */
    const note = async (answer: SetupAnswer | null) => {
      if (answer && (answer.outcome === 'pending' || answer.outcome === 'done') && answer.operation) {
        view = answer.operation;
        viewAt = this.d.mono();
        await this.noteView(op.op, view);
      }
    };
    // After every wait (a request, a sleep): still visible, still this credential's operation, still unfinished?
    // Otherwise the driver lock goes before another request.
    const stop = async (): Promise<Outcome | null> => {
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      const t = await S.readState(this.d.env);
      if (t.credential !== credential || t.op?.op !== op.op) return { result: 'changed', activation: null };
      if (t.op.result) return { result: t.op.result, activation: t.op.activation };
      return null;
    };
    // Timing counts from the operation's start (kept in state), so a page taking over keeps the schedule.
    let repeats = 0;
    let lastRepeat = 0; // as age()
    if (op.phase === 'sent') {
      // Taking over a request another page (or this one, before it was hidden) already sent: the server is asked first, so
      // its dispatch state and retry time (a push service's backoff) decide when the next repeat may go; the repeats due
      // by the operation's age count as made.
      const mine = await this.d.api.mine(credential).catch(() => null);
      if (mine?.operation?.op === op.op) {
        view = mine.operation;
        viewAt = this.d.mono();
        await this.noteView(op.op, view);
      }
      let due = 0;
      for (const gap of REPEAT_AFTER_MS) if (age() >= (due += gap)) repeats++;
      lastRepeat = age();
      const halt = await stop();
      if (halt) return halt;
    } else {
      const firstAnswer = await this.send(op, credential).catch(() => null);
      lastRepeat = age();
      await note(firstAnswer);
      const firstHalt = await stop();
      if (firstHalt) return firstHalt;
      const first = await take(firstAnswer);
      if (first) return first;
    }
    let lastAck = -Infinity; // as mono()
    let slowShown = false;
    for (;;) {
      if (view?.result) return record(view.result, view.activation);
      const s = await S.readState(this.d.env);
      if (s.credential !== credential || s.op?.op !== op.op) return { result: 'changed', activation: null };
      if (s.op.result) return { result: s.op.result, activation: s.op.activation };
      // Hidden: the driver lock goes now, before any further request (each ends within REQUEST_TIMEOUT_MS); the
      // operation stays as it is, for the next visible page or this one when it shows again.
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      // The server's remaining time, once an answer here gave it, with 30 s for a late result; else the deadline another
      // page stored (as it stood when this page took over); else 2 minutes from the start.
      const deadline =
        view?.remainingMs != null
          ? viewAt + view.remainingMs + AFTER_EXPIRY_MS
          : s.op.expiresAt !== null
            ? startMono + Math.max(0, s.op.expiresAt + AFTER_EXPIRY_MS - startWall)
            : startMono + Math.max(0, UNANSWERED_MS - Math.min(UNANSWERED_MS, Math.max(0, startWall - op.createdAt)));
      // Nothing the server said yet: 2 minutes after creation (spec), its age carried over by the wall clock at takeover.
      // A wall clock that jumped could make that early, so the server is asked before the operation is called expired.
      if (this.d.mono() > deadline) {
        const st = await this.serverOp(op.op, credential);
        if (st.kind === 'terminal') return record(st.result, st.activation);
        // Never admitted because every try was refused for limits: said as such, not as a setup that took too long.
        if (st.kind !== 'open') return record(limited && st.kind === 'absent' ? 'limited' : 'expired', null);
        const fresh = await this.d.api.mine(credential).catch(() => null);
        if (fresh?.operation?.op === op.op) {
          view = fresh.operation;
          viewAt = this.d.mono();
        }
        // Still open on the server past this page's deadline (clocks differ): ask again after a while, never at once.
        await this.d.sleep(POLL_SLOW_MS);
        const halt = await stop();
        if (halt) return halt;
        continue;
      }
      if (!slowShown && age() >= POLL_FAST_FOR_MS) {
        slowShown = true;
        this.show({ kind: 'setting-up', slow: true });
      }
      // The worker stored a nonce but no result came: acknowledge from here, every 15 s.
      if (s.op.nonce && this.d.mono() - lastAck >= ACK_RETRY_MS) {
        lastAck = this.d.mono();
        const r = await this.d.api.ready(credential, { op: op.op, nonce: s.op.nonce }).catch(() => null);
        if (r && r.result !== 'limited' && r.result !== 'invalid' && r.result !== 'unknown') return record(r.result, r.activation);
        const halt = await stop();
        if (halt) return halt;
      }
      // Unsent or retryable, or no answer yet: the identical request again, after 5, 15 and 45 s (or the server's retry time).
      const gap = REPEAT_AFTER_MS[Math.min(repeats, REPEAT_AFTER_MS.length - 1)]!;
      const retryAt = view?.retryInMs != null ? viewAt + view.retryInMs : 0;
      const waiting = view === null || view.dispatch === 'unsent' || view.dispatch === 'retryable';
      if (waiting && age() - lastRepeat >= gap && this.d.mono() >= retryAt) {
        repeats++;
        lastRepeat = age();
        const answer = await this.send(op, credential).catch(() => null);
        await note(answer);
        const halt = await stop();
        if (halt) return halt;
        const done = await take(answer);
        if (done) return done;
        continue;
      }
      if (!this.d.browser.visible()) return { result: 'hidden', activation: null };
      // Polling, but waking exactly when the next repeat is due (5, 15 and 45 s apart, or the server's retry time).
      let wait = age() < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS;
      if (waiting) {
        const dueIn = Math.max(lastRepeat + gap - age(), retryAt - this.d.mono());
        if (dueIn > 0) wait = Math.min(wait, dueIn);
      }
      await this.d.sleep(wait);
      const halt = await stop();
      if (halt) return halt;
      const mine = await this.d.api.mine(credential).catch(() => null);
      if (mine?.operation?.op === op.op) {
        view = mine.operation;
        viewAt = this.d.mono();
        await this.noteView(op.op, view);
      }
    }
  }

  /** What an operation's outcome means for the person, checked against this operation, credential and subscription. */
  private async result(op: S.Operation, credential: string, r: Outcome): Promise<SetupResult> {
    // A hidden page reads nothing: a terminal result the server gave is already recorded locally (its truth), and the
    // next opening or return to the page reconciles and shows it.
    if (r.result === 'hidden' || !this.d.browser.visible()) return { ok: false, text: TEXT.slow, retry: false };
    if (r.result === 'active' && r.activation) {
      const act = r.activation;
      const before = await S.readState(this.d.env);
      // The operation as stored (a caller that joined it before it was attached holds a copy without its subscription).
      const fp = before.op?.op === op.op ? before.op.fingerprint : op.fingerprint;
      const mine = await this.d.api.mine(credential).catch(() => null);
      const a = mine?.state === 'active' ? mine.alert : null;
      // The server's current alert is this activation, with this operation's subscription.
      const serverOk = !!fp && !!a && a.incarnation === act.incarnation && a.generation === act.generation && a.fingerprint === fp;
      // The row follows the read (and may rotate or renew); the success itself is judged on fresh evidence, never on a
      // row another step left: this credential still current, the alert known is this activation's, and the browser's
      // proof taken now.
      if (mine) await this.afterRead(credential, mine, before);
      // This activation, exactly, is what the device knows: its incarnation, generation and subscription.
      const isThis = (s: S.DeviceState) => s.credential === credential && s.known?.incarnation === act.incarnation && s.known.generation === act.generation && s.known.fingerprint === fp;
      const now = await S.readState(this.d.env);
      const proof = fp ? await this.proof(fp) : 'other';
      // And still is after the proof's wait: the same epoch, `known` untouched, and still this activation.
      const last = await S.readState(this.d.env);
      const stable = last.epoch === now.epoch && last.knownVersion === now.knownVersion;
      if (serverOk && isThis(now) && isThis(last) && stable && proof === 'ok') return { ok: true, text: TEXT.on };
      if (proof === 'unknown') return { ok: false, text: TEXT.cantFinish, retry: true };
      return { ok: false, text: TEXT.again, retry: true };
    }
    // The fingerprint from the stored operation: a page that joined it while it was preparing holds a copy without one.
    const stored = r.result === 'gone' ? await S.readState(this.d.env) : null;
    const goneFp = stored?.op?.op === op.op ? stored.op.fingerprint : op.fingerprint;
    if (r.result === 'gone' && goneFp && stored) {
      const removed = await this.removeGone(goneFp, credential, stored.credential === credential ? stored.epoch : -1);
      await this.reconcileAfter(credential);
      return removed ? { ok: false, text: TEXT.didntFinish, retry: true } : { ok: false, text: TEXT.deadSubscription, retry: false };
    }
    await this.reconcileAfter(credential).catch(() => undefined);
    switch (r.result) {
      case 'expired':
        return { ok: false, text: TEXT.expired, retry: true };
      case 'full':
        return { ok: false, text: TEXT.full, retry: true };
      case 'unavailable':
        return { ok: false, text: TEXT.unavailable, retry: true };
      case 'limited':
        return { ok: false, text: TEXT.limited, retry: true };
      case 'owner-only':
        return { ok: false, text: TEXT.ownerOnly, retry: false };
      default:
        return { ok: false, text: TEXT.didntFinish, retry: true };
    }
  }

  // ---- Change, test, turn off. ----

  async change(choices: AlertChoices): Promise<SetupResult> {
    if ((await this.settleStale().catch(() => 'ok' as const)) === 'unverified') return { ok: false, text: TEXT.offline, retry: true };
    const s = await S.readState(this.d.env);
    if (!s.credential || !s.known) return { ok: false, text: TEXT.again, retry: false };
    const r = await S.begin(this.d.env, { kind: 'change', choices, captured: { incarnation: s.known.incarnation, generation: s.known.generation, revision: s.known.revision }, now: this.d.now() });
    if ('blocked' in r) return { ok: false, text: TEXT.finishingOff, retry: true };
    if ('waiting' in r) return { ok: false, text: TEXT.slow, retry: true };
    if ('joined' in r) {
      // The same change pressed twice, or in two tabs: wait for that operation's own result.
      for (let i = 0; i < 12; i++) {
        const now = await S.readState(this.d.env);
        if (now.op?.op !== r.joined.op) break;
        if (now.op.result) return now.op.result === 'active' ? { ok: true, text: 'Saved.' } : { ok: false, text: TEXT.changedMeanwhile, retry: true };
        await this.d.sleep(POLL_FAST_MS);
      }
      return { ok: false, text: TEXT.slow, retry: true };
    }
    const v = await this.replayChange(r.started, s.credential);
    // Saved only on this operation's own result, never because the alert's revision moved (another change may have won).
    const after = (await S.readState(this.d.env)).op;
    if (after?.op === r.started.op && after.result === 'active') return { ok: true, text: 'Saved.' };
    if (after?.op === r.started.op && after.result) return { ok: false, text: TEXT.changedMeanwhile, retry: true };
    if (v.kind === 'cant-check') return { ok: false, text: TEXT.offline, retry: true };
    return { ok: false, text: TEXT.slow, retry: true };
  }

  /** Sends the exact change stored in the operation, until it has its own result (a lost answer is sent again). */
  private async replayChange(op: S.Operation, credential: string): Promise<RowView> {
    const s = await S.readState(this.d.env).catch(() => null);
    const seen = s ? { credential: s.credential, epoch: s.epoch } : null;
    try {
      const a = await this.d.api.change(credential, { op: op.op, seq: op.seq, incarnation: op.captured!.incarnation, baseRevision: op.captured!.revision!, choices: op.choices! });
      if (a.result === 'busy') return this.show({ kind: 'setting-up', slow: false });
      await S.recordResult(this.d.env, { op: op.op, credential, result: a.result, activation: null });
      return await this.reconcileAfter(credential);
    } catch {
      // Kept: the next opening sends it again.
      return this.failedSince(seen);
    }
  }

  async test(): Promise<string> {
    const s = await S.readState(this.d.env);
    if (!s.credential) return TEXT.again;
    try {
      const r = await this.d.api.test(s.credential);
      if (r.test === 'accepted') return TEXT.testAccepted;
      if (r.test === 'uncertain') return TEXT.testUncertain;
      if (r.test === 'gone') {
        await this.reconcileAfter(s.credential);
        return r.updating ? TEXT.updating : TEXT.again;
      }
      if (r.test === 'unavailable') return TEXT.unavailable;
      if (r.test === 'limited') return 'You can send 3 tests an hour. Try again later.';
      if (r.test === 'none') return TEXT.again;
      return TEXT.testRefused;
    } catch {
      return TEXT.offline;
    }
  }

  /** Turn off: one local step (state.js), then unsubscribing and the server deletion, each reported on its own. */
  async turnOff(): Promise<RowView> {
    // The browser's subscription unknown (no worker reached): the turn-off goes on, and says it could not confirm.
    const current = await this.d.browser.subscription().catch(() => undefined);
    const fp = current === undefined ? S.UNKNOWN_SUBSCRIPTION : current ? await this.fp(current) : null;
    await S.turnOff(this.d.env, { fingerprint: fp });
    const after = await S.readState(this.d.env);
    const [claimed, deleted] = await Promise.all([this.resolveClaim().catch(() => false), this.resolveRetired()]);
    const unsubscribed = current !== undefined && claimed;
    await this.d.browser.closeNotifications().catch(() => undefined);
    // Shown only if nothing newer happened meanwhile (a setup started after it): that one's row stands.
    const now = await S.readState(this.d.env);
    if (now.credential !== null || now.epoch !== after.epoch) return this.view;
    return this.show({ kind: 'off', unsubscribed, deleted });
  }
}
