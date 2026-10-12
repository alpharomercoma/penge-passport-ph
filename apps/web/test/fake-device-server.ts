import { createHash } from 'node:crypto';
import type { DeviceApi } from '../src/devices/api.ts';
import { type Activation, type AlertChoices, canonicalSubscription, type MineAnswer, type OperationView, type SetupAnswer } from '@penge/contracts';

/** The fingerprint as the server computes it (and state.js, as the page does). */
export const fpOf = (s: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
  createHash('sha256').update(canonicalSubscription({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth })).digest('base64url');

type Captured = { incarnation: string; generation: number; revision?: number } | null;
type Op = {
  op: string; seq: number; kind: 'setup' | 'rotate' | 'change'; digest: string; fp: string; choices: AlertChoices | null; captured: Captured;
  nonce: string; expiresAt: number; result: string | null; activation: Activation | null; dispatch: OperationView['dispatch'];
};
type Alert = Activation & { choices: AlertChoices; fingerprint: string; endsAt: number };
/** One credential's server side, as the scripts keep it: its alert (or how it ended), its last operation, its highest seq. */
type Device = { alert: Alert | null; ended: { at: number; reason: 'ended' | 'gone'; fp: string } | null; op: Op | null; maxseq: number };

/**
 * The device routes for the controller's tests, with the server's admission rules (Tasks 6 and 7): a repeat of the last
 * operation with the same body answers its state and one with another body is invalid; a lower seq is invalid; an
 * unfinished operation makes another busy; a setup or rotation whose captured incarnation, generation (and, for a
 * setup, revision) is not the alert's is refused as changed, as is a first setup while an alert exists; a recreated
 * alert has a new incarnation; a turn-off deletes everything under the credential. `alert`, `op` and `ended` are the
 * last-used credential's, for the tests to read and adjust.
 */
export class FakeDeviceServer {
  now = () => 0;
  pushes: { op: string; nonce: string }[] = [];
  /** A retryable dispatch's wait before it may be tried again (a push service's backoff), in ms. */
  retryIn = 0;
  /** What the next dispatches answer: accepted unless told otherwise. */
  dispatch: OperationView['dispatch'][] = [];
  offline = false;
  calls: string[] = [];
  seenAt: number | null = null;
  private devices = new Map<string, Device>();
  private last = '';
  private n = 0;
  private dev(cred: string): Device {
    this.last = cred;
    let d = this.devices.get(cred);
    if (!d) this.devices.set(cred, (d = { alert: null, ended: null, op: null, maxseq: 0 }));
    return d;
  }
  private get cur(): Device {
    return this.devices.get(this.last) ?? { alert: null, ended: null, op: null, maxseq: 0 };
  }
  get alert() {
    return this.cur.alert;
  }
  get op() {
    return this.cur.op;
  }
  get ended() {
    return this.cur.ended;
  }
  private view(o: Op | null): OperationView | null {
    if (!o) return null;
    const retry = o.dispatch === 'retryable';
    return { op: o.op, seq: o.seq, kind: o.kind, expiresAt: new Date(o.expiresAt).toISOString(), dispatch: o.dispatch, retryAt: retry ? new Date(this.now()).toISOString() : null, remainingMs: Math.max(0, o.expiresAt - this.now()), retryInMs: retry ? this.retryIn : null, reason: null, result: (o.result as OperationView['result']) ?? null, activation: o.activation };
  }
  private guard(name: string) {
    this.calls.push(name);
    if (this.offline) throw Object.assign(new Error('offline'), { kind: 'offline' });
  }
  /** An alert past its end becomes an end record before anything reads or changes it; an unfinished operation past its
   * expiry ends as expired (as the server's read and clean-up do). */
  private expire(d: Device) {
    if (d.op && !d.op.result && d.op.expiresAt <= this.now()) d.op.result = 'expired';
    if (d.alert && d.alert.endsAt <= this.now()) {
      d.ended = { at: this.now(), reason: 'ended', fp: d.alert.fingerprint };
      d.alert = null;
    }
  }
  private start(cred: string, kind: 'setup' | 'rotate', body: { op: string; seq: number; subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; choices?: AlertChoices; captured?: Captured }): SetupAnswer {
    const d = this.dev(cred);
    const digest = JSON.stringify(body);
    if (d.op?.op === body.op) {
      if (d.op.digest !== digest) return { outcome: 'invalid', operation: null };
      if (d.op.dispatch === 'retryable' && !d.op.result) this.send(d.op);
      return { outcome: d.op.result ? 'done' : 'pending', operation: this.view(d.op) };
    }
    if (body.seq <= d.maxseq) return { outcome: 'invalid', operation: null };
    if (d.op && !d.op.result && d.op.expiresAt > this.now()) return { outcome: 'busy', operation: null };
    if (d.op && !d.op.result) d.op.result = 'expired';
    this.expire(d);
    const cap = body.captured ?? null;
    const a = d.alert;
    const fits =
      kind === 'setup' && !cap ? !a : !!a && !!cap && a.incarnation === cap.incarnation && a.generation === cap.generation && (kind === 'rotate' || a.revision === cap.revision);
    if (!fits) return { outcome: 'changed', operation: null };
    d.maxseq = body.seq;
    d.op = { op: body.op, seq: body.seq, kind, digest, fp: fpOf(body.subscription), choices: body.choices ?? null, captured: cap, nonce: `nonce-${++this.n}`.padEnd(43, 'x'), expiresAt: this.now() + 300_000, result: null, activation: null, dispatch: 'unsent' };
    this.send(d.op);
    return { outcome: 'pending', operation: this.view(d.op) };
  }
  private send(o: Op) {
    o.dispatch = this.dispatch.shift() ?? 'accepted';
    if (o.dispatch === 'accepted' || o.dispatch === 'uncertain') this.pushes.push({ op: o.op, nonce: o.nonce });
  }
  api: DeviceApi = {
    setup: async (cred, body) => (this.guard('setup'), this.start(cred, 'setup', body)),
    rotate: async (cred, body) => (this.guard('rotate'), this.start(cred, 'rotate', body)),
    ready: async (cred, body) => {
      this.guard('ready');
      const d = this.dev(cred);
      const o = d.op;
      if (!o || o.op !== body.op || o.kind === 'change') return { result: 'unknown', activation: null };
      if (o.result) return { result: o.result as never, activation: o.activation };
      if (body.nonce !== o.nonce) return { result: 'invalid', activation: null };
      if (this.now() >= o.expiresAt) return (o.result = 'expired'), { result: 'expired', activation: null };
      // As the ready script (Task 7): an alert past its end is ended first (and a captured operation then expires); the
      // captured ownership is checked again at activation.
      if (d.alert && d.alert.endsAt <= this.now()) {
        this.expire(d);
        if (o.captured) return (o.result = 'expired'), { result: 'expired', activation: null };
      }
      const a = d.alert;
      const cap = o.captured;
      const fits = o.kind === 'setup' && !cap ? !a : !!a && !!cap && a.incarnation === cap.incarnation && a.generation === cap.generation && (o.kind === 'rotate' || a.revision === cap.revision);
      if (!fits) return (o.result = 'changed'), { result: 'changed', activation: null };
      // A first setup creates an alert (new incarnation, 180 days); a re-setup keeps it with the revision up (its choices
      // replaced) and a rotation keeps it; either way the generation goes up when the subscription changed, and the
      // end does not move (only renewal moves it).
      const next: Alert = a
        ? { ...a, generation: a.generation + (a.fingerprint !== o.fp ? 1 : 0), revision: a.revision + (o.kind === 'setup' ? 1 : 0), choices: o.kind === 'setup' ? o.choices! : a.choices, fingerprint: o.fp }
        : { alertId: `alert-${++this.n}`.padEnd(22, 'a'), incarnation: `inc-${++this.n}`.padEnd(22, 'i'), generation: 1, revision: 1, choices: o.choices!, fingerprint: o.fp, endsAt: this.now() + 180 * 86_400_000 };
      d.alert = next;
      d.ended = null;
      o.result = 'active';
      o.activation = { alertId: next.alertId, incarnation: next.incarnation, generation: next.generation, revision: next.revision };
      return { result: 'active', activation: o.activation };
    },
    mine: async (cred) => {
      this.guard('mine');
      const d = this.dev(cred);
      this.expire(d);
      const operation = this.view(d.op);
      if (d.alert) return { state: 'active', operation, alert: { ...d.alert, endsAt: new Date(d.alert.endsAt).toISOString(), updating: false } } as MineAnswer;
      if (d.ended) return d.ended.reason === 'gone' ? { state: 'gone', endedAt: new Date(d.ended.at).toISOString(), fingerprint: d.ended.fp, operation } : { state: 'ended', endedAt: new Date(d.ended.at).toISOString(), operation };
      return { state: 'none', operation };
    },
    seen: async (cred) => {
      this.guard('seen');
      const d = this.dev(cred);
      this.expire(d);
      if (!d.alert) return { state: 'none' };
      d.alert.endsAt = Math.max(d.alert.endsAt, this.now() + 180 * 86_400_000);
      this.seenAt = this.now();
      return { state: 'active', endsAt: new Date(d.alert.endsAt).toISOString() };
    },
    change: async (cred, body) => {
      this.guard('change');
      const d = this.dev(cred);
      const digest = JSON.stringify(body);
      // A change sent again (its answer lost) gets its own stored answer; another body under its id is invalid.
      if (d.op?.op === body.op) {
        if (d.op.kind !== 'change' || d.op.digest !== digest) return { result: 'invalid' };
        return d.op.result === 'active' ? { result: 'active', revision: d.op.activation!.revision } : { result: d.op.result as 'changed' };
      }
      if (body.seq <= d.maxseq) return { result: 'invalid' };
      if (d.op && !d.op.result && d.op.expiresAt > this.now()) return { result: 'busy' };
      if (d.op && !d.op.result) d.op.result = 'expired';
      this.expire(d);
      d.maxseq = body.seq;
      const a = d.alert;
      const ok = !!a && a.incarnation === body.incarnation && a.revision === body.baseRevision;
      if (ok) {
        a.revision += 1;
        a.choices = body.choices;
      }
      const activation = ok ? { alertId: a.alertId, incarnation: a.incarnation, generation: a.generation, revision: a.revision } : null;
      d.op = { op: body.op, seq: body.seq, kind: 'change', digest, fp: a?.fingerprint ?? '', choices: body.choices, captured: null, nonce: '', expiresAt: this.now(), result: ok ? 'active' : 'changed', activation, dispatch: 'accepted' };
      return ok ? { result: 'active', revision: a.revision } : { result: 'changed' };
    },
    test: async (cred) => {
      this.guard('test');
      const d = this.dev(cred);
      this.expire(d);
      return { test: d.alert ? 'accepted' : 'none' };
    },
    turnOff: async (cred) => {
      this.guard('turnOff');
      this.dev(cred);
      this.devices.delete(cred);
      return { deleted: true };
    },
  };
}
