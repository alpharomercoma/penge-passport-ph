import type { Activation, AlertChoices } from '@penge/contracts';

export const DB_NAME: 'pengepassportph-device-alerts';
export const LOCK_NAME: 'pengepassportph-device-alerts';
export const DRIVER_LOCK: 'pengepassportph-device-alerts-driver';
export const LEGACY_DB: 'pengepassportph-push';
export class Unsupported extends Error {}
export interface Env { indexedDB?: IDBFactory; locks?: Pick<LockManager, 'request' | 'query'>; crypto: Crypto }
export interface SubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }
/** preparing → attached (a subscription, by one caller) → ready (that caller's handshake done) → sent (the server answered). */
export type Phase = 'preparing' | 'attached' | 'ready' | 'sent';
export interface Operation {
  op: string; seq: number; epoch: number; kind: 'setup' | 'change' | 'rotate'; phase: Phase;
  choices: AlertChoices | null; captured: { incarnation: string; generation: number; revision?: number } | null;
  subscription: SubscriptionJson | null; fingerprint: string | null; nonce: string | null;
  expiresAt: number | null; createdAt: number; result: string | null; activation: Activation | null;
  /** Who attached the subscription (the attaching caller's id): only that caller may abandon it once attached. */
  by: string | null;
}
/** A turn-off's claim when the browser's subscription could not be read: whatever subscription is found later is removed. */
export const UNKNOWN_SUBSCRIPTION: '?';
export interface Known { alertId: string; incarnation: string; generation: number; revision: number; fingerprint: string; endsAt: number; choices: AlertChoices }
export interface DeviceState {
  credential: string | null; seq: number; epoch: number; op: Operation | null; needsRotation: boolean;
  claim: { task: string; fingerprint: string } | null;
  retired: { credential: string; fingerprint: string | null; deleted: boolean; unsubscribed: boolean }[];
  vapidKey: string | null; known: Known | null; renewedAt: number | null; gone: string[];
  /** Goes up with every change to `known` (and every turn-off): a read fences its writes by the value it started from. */
  knownVersion: number;
  /** The last choices a setup or change asked for. */
  choices: AlertChoices | null;
}
export function readState(env: Env): Promise<DeviceState>;
export function update<T>(env: Env, fn: (s: DeviceState) => { state?: DeviceState; result: T }): Promise<T>;
export function opDone(op: Operation, now: number): boolean;
/** Blocked while an unsubscribe claim or a retired credential's server deletion is unresolved (checked under the lock). */
export function begin(env: Env, a: { kind: Operation['kind']; choices: AlertChoices | null; captured: Operation['captured']; now: number }):
  Promise<{ started: Operation; credential: string } | { joined: Operation } | { waiting: Operation } | { blocked: 'claim' | 'retired' }>;
export function attach(env: Env, a: { op: string; epoch: number; subscription: SubscriptionJson; fingerprint: string; by: string }): Promise<'ok' | 'already' | 'abandoned'>;
/** The attaching caller's handshake is done: attached → ready (only `by`, only while attached). Only a ready operation is sent. */
export function confirmReady(env: Env, a: { op: string; by: string }): Promise<boolean>;
/** Drops the operation only while preparing, or while attached by `by`; never once ready (it may be sent), never another's. */
export function abandon(env: Env, a: { op: string; fingerprint: string | null; by: string | null }): Promise<{ task: string; fingerprint: string } | null>;
export function markSent(env: Env, a: { op: string; expiresAt: number | null }): Promise<boolean>;
export function storeNonce(env: Env, a: { op: string; credential: string; fingerprint: string; nonce: string }): Promise<boolean>;
export function recordResult(env: Env, a: { op: string; credential: string; result: string; activation: Activation | null }): Promise<boolean>;
export function finish(env: Env, a: { op: string }): Promise<void>;
/**
 * Writes the known alert for this credential. Refused: an older generation or revision of the same incarnation; and,
 * when `version` is given (the `knownVersion` a read started from), any write after `known` changed since, so a late
 * read never clears, replaces or brings back what a newer step wrote.
 */
export function setKnown(env: Env, a: { credential: string; known: Known | null; version?: number }): Promise<boolean>;
/** A renewal's new end, written only onto the same alert (alertId, incarnation, generation) still known: never restores one. */
export function setEndsAt(env: Env, a: { credential: string; alertId: string; incarnation: string; generation: number; endsAt: number }): Promise<Known | null>;
/** Recovery of an attached operation whose caller went away: ownership moves from `from` to `by` (compare-and-set). */
export function adopt(env: Env, a: { op: string; from: string | null; by: string }): Promise<boolean>;
export function turnOff(env: Env, a: { fingerprint: string | null }): Promise<{ claim: { task: string; fingerprint: string } | null; retired: string | null }>;
/** `fingerprint`: null when the browser has no subscription; UNKNOWN_SUBSCRIPTION when it could not be asked (claimed, resolved once it can be). */
/** Clears the claim when `unsubscribed` (confirmed), replaces it with one for `replaceWith`, or keeps it (returned) when the unsubscribe failed. */
export function settleClaim(env: Env, a: { task: string; unsubscribed: boolean; replaceWith?: string | null }): Promise<{ task: string; fingerprint: string } | null>;
export function retiredDeleted(env: Env, a: { credential: string }): Promise<void>;
/** For the credential and epoch that read it; false (nothing changed) for a caller from before a turn-off. */
export function setNeedsRotation(env: Env, a: { on: boolean; credential: string; epoch: number }): Promise<boolean>;
export function setVapid(env: Env, key: string): Promise<void>;
export function setRenewed(env: Env, a: { credential: string; at: number }): Promise<void>;
export function noteGone(env: Env, fingerprint: string): Promise<void>;
export function legacyCredential(env: Env): Promise<'yes' | 'no' | 'empty' | 'unknown'>;
export function deleteLegacy(env: Env): Promise<void>;
export function canonical(json: SubscriptionJson): string;
export function fingerprint(env: Env, json: SubscriptionJson): Promise<string>;
export function newCredential(env: Env): string;
export function newId(env: Env): string;
export function credentialHash(env: Env, credential: string): Promise<string>;
