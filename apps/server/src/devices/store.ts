// Notification alerts' records, as the TypeScript side sees them: hashes, sealing, digests and the views the API
// answers with. The records themselves are written only by the Lua scripts (scripts-api.ts, scripts-delivery.ts).
import { createHash } from 'node:crypto';
import { type AlertChoices, canonicalSubscription, type DispatchState, type OperationView, type PushSubscriptionInput, SETUP_SECONDS, type TerminalResult, TERMINAL_RESULTS } from '@penge/contracts';
import { seal, unseal } from '../crypto.ts';
import type { Keys } from '../subscribers.ts';

/** Storage units (spec: "Bounds"): an alert with its largest delivery footprint and the end record it may leave. */
export const ALERT_UNITS = 5;
/** An operation record. */
export const OP_UNITS = 1;
export const SETUP_MS = SETUP_SECONDS * 1000;
export const RESULT_KEEP_MS = 24 * 3600_000;
export const ENDED_KEEP_MS = 30 * 86_400_000;
export const ALERT_MS = 180 * 86_400_000;
export const MAX_ACKS = 10;
/** What one admission tidies up in passing (spec: "Lifetime and clean-up"). */
export const RECLAIM_BATCH = 20;
/** A dispatch still `sending` this long after it began was cut short by a crash: it is uncertain. */
export const CRASH_SENDING_MS = 30_000;

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');

export const credentialHash = (credential: string) => sha(credential);
export const fingerprint = (s: PushSubscriptionInput) => sha(canonicalSubscription(s));

export function pushService(endpoint: string): 'fcm' | 'mozilla' | 'wns' | 'apple' {
  const host = new URL(endpoint).hostname;
  if (host === 'fcm.googleapis.com') return 'fcm';
  if (host === 'updates.push.services.mozilla.com') return 'mozilla';
  if (host.endsWith('.notify.windows.com')) return 'wns';
  return 'apple';
}

export type Captured = { incarnation: string; generation: number; revision?: number };

/** What makes two requests "the identical operation": kind, subscription, choices and captured alert. The captured
 * alert is written field by field, so the order a page sent its fields in changes nothing. */
export function digest(kind: 'setup' | 'rotate', s: PushSubscriptionInput, choices: AlertChoices | null, captured: Captured | null): string {
  const cap = captured && [captured.incarnation, captured.generation, captured.revision ?? null];
  return sha(JSON.stringify([kind, canonicalSubscription(s), choices, cap]));
}

export interface SetupSecret {
  subscription: PushSubscriptionInput;
  choices: AlertChoices | null;
  nonce: string;
}

export const sealSetup = (keys: Keys, v: SetupSecret) => seal(JSON.stringify(v), keys.email, 'device-setup:v1');
export const openSetup = (keys: Keys, sealed: string) => JSON.parse(unseal(sealed, keys.email, 'device-setup:v1')) as SetupSecret;
export const sealSubscription = (keys: Keys, s: PushSubscriptionInput) => seal(JSON.stringify(s), keys.email, 'device:v1');
export const openSubscription = (keys: Keys, sealed: string) => JSON.parse(unseal(sealed, keys.email, 'device:v1')) as PushSubscriptionInput;

export type OpRecord = Record<string, string>;

const iso = (ms: string | undefined) => (ms ? new Date(Number(ms)).toISOString() : null);

/** What a credential's operation record looks like from the device. Never includes the sealed fields or the nonce hash. */
export function opView(o: OpRecord | null | undefined, now: number): OperationView | null {
  if (!o?.op) return null;
  const kind = o.kind as OperationView['kind'];
  let dispatch = (o.dsp || null) as DispatchState | null;
  if (dispatch === 'sending' && now - Number(o.dspAt ?? 0) > CRASH_SENDING_MS) dispatch = 'uncertain';
  const result = (TERMINAL_RESULTS as readonly string[]).includes(o.result ?? '') ? (o.result as TerminalResult) : null;
  return {
    op: o.op,
    seq: Number(o.seq),
    kind,
    expiresAt: kind === 'change' ? null : iso(o.exp),
    dispatch: kind === 'change' ? null : dispatch,
    retryAt: !result && (dispatch === 'unsent' || dispatch === 'retryable') ? iso(o.retry) : null,
    remainingMs: kind === 'change' || !o.exp ? null : Math.max(0, Number(o.exp) - now),
    retryInMs: !result && (dispatch === 'unsent' || dispatch === 'retryable') && o.retry ? Math.max(0, Number(o.retry) - now) : null,
    reason: (['paused', 'backoff', 'limited', 'mode'].includes(o.why ?? '') ? o.why : null) as OperationView['reason'],
    result,
    activation: o.act ? (JSON.parse(o.act) as OperationView['activation']) : null,
  };
}
