import { describe, expect, it } from 'vitest';
import {
  canonicalSubscription,
  isChangeRequest,
  isMineAnswer,
  isOperationView,
  isReadyRequest,
  isRotateRequest,
  isSetupRequest,
  validateChoices,
  validateSubscribe,
} from '../src/index.ts';

const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'A'.repeat(22) } };
const op = 'o'.repeat(22);

describe('choices, shared by both kinds of alert', () => {
  it('need no email', () => {
    expect(validateChoices({ siteIds: [693, 486, 486], applicants: 2, pace: 'asap' })).toEqual({ ok: true, value: { siteIds: [486, 693], applicants: 2, pace: 'asap' } });
  });

  it('refuse what the email form refuses', () => {
    const bad = validateChoices({ siteIds: [], applicants: 9, pace: 'daily' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['applicants', 'pace', 'siteIds']);
    expect(validateChoices({ siteIds: Array.from({ length: 11 }, (_, i) => i + 1) }).ok).toBe(false);
    expect(validateChoices({ siteIds: [1] }, new Set([2])).ok).toBe(false);
  });

  it('are what validateSubscribe checks, plus the address', () => {
    const both = validateSubscribe({ email: 'Juan@Example.com', siteIds: [486], applicants: 1, pace: 'hourly' });
    expect(both.ok && both.value).toMatchObject({ email: 'juan@example.com', siteIds: [486], applicants: 1, pace: 'hourly' });
  });
});

describe('the subscription fingerprint\'s input', () => {
  it('is the endpoint and unpadded keys, so page and server agree', () => {
    expect(canonicalSubscription({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })).toBe(
      JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }),
    );
  });
});

describe('device-alert requests', () => {
  const choices = { siteIds: [486], applicants: 1, pace: 'asap' };
  it('a setup carries op, seq, subscription, choices and an optional captured alert', () => {
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices, captured: null })).toBe(true);
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices, captured: { incarnation: 'i'.repeat(22), generation: 1, revision: 2 } })).toBe(true);
    expect(isSetupRequest({ op: 'short', seq: 1, subscription: sub, choices, captured: null })).toBe(false);
    expect(isSetupRequest({ op, seq: 0, subscription: sub, choices, captured: null })).toBe(false);
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices, captured: null, email: 'x@y.z' })).toBe(false);
  });
  it('a rotation captures incarnation and generation only, and carries no choices', () => {
    expect(isRotateRequest({ op, seq: 2, subscription: sub, captured: { incarnation: 'i'.repeat(22), generation: 1 } })).toBe(true);
    expect(isRotateRequest({ op, seq: 2, subscription: sub, captured: { incarnation: 'i'.repeat(22), generation: 1 }, choices })).toBe(false);
  });
  it('a change names the incarnation and the base revision', () => {
    expect(isChangeRequest({ op, seq: 3, incarnation: 'i'.repeat(22), baseRevision: 1, choices })).toBe(true);
    expect(isChangeRequest({ op, seq: 3, incarnation: 'i'.repeat(22), choices })).toBe(false);
  });
  it('a subscription is toJSON\'s shape and nothing more: no extra fields, no array, no control character', () => {
    const setup = (subscription: unknown) => isSetupRequest({ op, seq: 1, subscription, choices, captured: null });
    expect(setup({ ...sub, expirationTime: null })).toBe(true);
    expect(setup({ ...sub, email: 'x@y.z' })).toBe(false);
    expect(setup({ ...sub, keys: { ...sub.keys, extra: 'x' } })).toBe(false);
    expect(setup(Object.assign([], sub))).toBe(false);
    expect(setup({ ...sub, keys: Object.assign([], sub.keys) })).toBe(false);
    expect(setup({ ...sub, endpoint: `${sub.endpoint}\u0000` })).toBe(false);
    expect(setup({ ...sub, endpoint: `${sub.endpoint}\n` })).toBe(false);
    expect(isRotateRequest({ op, seq: 2, subscription: { ...sub, email: 'x@y.z' }, captured: { incarnation: 'i'.repeat(22), generation: 1 } })).toBe(false);
  });
  it('choices name all three: offices, group size and pace (the email form\'s defaults do not apply)', () => {
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices: { siteIds: [486] }, captured: null })).toBe(false);
    expect(isSetupRequest({ op, seq: 1, subscription: sub, choices: { siteIds: [486], applicants: 1 }, captured: null })).toBe(false);
    expect(isChangeRequest({ op, seq: 3, incarnation: 'i'.repeat(22), baseRevision: 1, choices: { siteIds: [486], pace: 'asap' } })).toBe(false);
  });
  it('an acknowledgement is an op and a 43-character nonce', () => {
    expect(isReadyRequest({ op, nonce: 'n'.repeat(43) })).toBe(true);
    expect(isReadyRequest({ op, nonce: 'n'.repeat(42) })).toBe(false);
  });
});

describe('answers', () => {
  it('accept an operation view with its relative times, and refuse a negative or fractional one', () => {
    const view = { op: 'o'.repeat(22), seq: 1, kind: 'setup', expiresAt: '2026-10-06T00:05:00.000Z', dispatch: 'accepted', retryAt: null, remainingMs: 300_000, retryInMs: null, reason: null, result: null, activation: null };
    expect(isOperationView(view)).toBe(true);
    expect(isOperationView({ ...view, remainingMs: -1 })).toBe(false);
    expect(isOperationView({ ...view, retryInMs: 1.5 })).toBe(false);
  });

  it('refuse an operation view whose times disagree, or a setup or rotation without an expiry', () => {
    const view = { op: 'o'.repeat(22), seq: 1, kind: 'setup', expiresAt: '2026-10-06T00:05:00.000Z', dispatch: 'unsent', retryAt: '2026-10-06T00:01:00.000Z', remainingMs: 300_000, retryInMs: 60_000, reason: 'backoff', result: null, activation: null };
    expect(isOperationView(view)).toBe(true);
    expect(isOperationView({ ...view, retryInMs: null })).toBe(false);
    expect(isOperationView({ ...view, retryAt: null })).toBe(false);
    expect(isOperationView({ ...view, remainingMs: null })).toBe(false);
    expect(isOperationView({ ...view, expiresAt: null, remainingMs: null })).toBe(false);
    expect(isOperationView({ ...view, kind: 'rotate', expiresAt: null, remainingMs: null })).toBe(false);
    expect(isOperationView({ ...view, kind: 'change', expiresAt: null, remainingMs: null, dispatch: null, retryAt: null, retryInMs: null })).toBe(true);
    expect(isOperationView({ ...view, kind: 'change', dispatch: null, retryAt: null, retryInMs: null })).toBe(false);
    expect(isOperationView({ ...view, expiresAt: 'soon' })).toBe(false);
  });

  it('accept every state of /mine and refuse others', () => {
    const operation = null;
    expect(isMineAnswer({ state: 'none', operation })).toBe(true);
    expect(isMineAnswer({ state: 'ended', endedAt: '2026-10-06T00:00:00.000Z', operation })).toBe(true);
    expect(isMineAnswer({ state: 'gone', endedAt: '2026-10-06T00:00:00.000Z', fingerprint: 'f'.repeat(43), operation })).toBe(true);
    expect(isMineAnswer({ state: 'active', operation, alert: { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, choices: { siteIds: [486], applicants: 1, pace: 'asap' }, fingerprint: 'f'.repeat(43), endsAt: '2027-04-04T00:00:00.000Z', updating: false } })).toBe(true);
    expect(isMineAnswer({ state: 'maybe', operation })).toBe(false);
  });

  it('refuse a /mine answer with a date that is not one, or a fingerprint that is not 43 base64url characters', () => {
    const operation = null;
    const alert = { alertId: 'a'.repeat(22), incarnation: 'i'.repeat(22), generation: 1, revision: 1, choices: { siteIds: [486], applicants: 1, pace: 'asap' }, fingerprint: 'f'.repeat(43), endsAt: '2027-04-04T00:00:00.000Z', updating: false };
    expect(isMineAnswer({ state: 'active', operation, alert: { ...alert, endsAt: 'not-a-date' } })).toBe(false);
    expect(isMineAnswer({ state: 'active', operation, alert: { ...alert, fingerprint: 'f' } })).toBe(false);
    expect(isMineAnswer({ state: 'active', operation, alert: { ...alert, choices: { siteIds: [486] } } })).toBe(false);
    expect(isMineAnswer({ state: 'ended', endedAt: 'yesterday', operation })).toBe(false);
    expect(isMineAnswer({ state: 'ended', endedAt: '2026-02-30T00:00:00.000Z', operation })).toBe(false);
    expect(isMineAnswer({ state: 'ended', endedAt: '2026-10-06T24:00:00.000Z', operation })).toBe(false);
    expect(isMineAnswer({ state: 'gone', endedAt: 'not-a-date', fingerprint: 'f'.repeat(43), operation })).toBe(false);
    expect(isMineAnswer({ state: 'gone', endedAt: '2026-10-06T00:00:00.000Z', fingerprint: 'f!'.repeat(21) + 'f', operation })).toBe(false);
  });
});
