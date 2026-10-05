import { parse as legacyParse } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keyedHash, seal, unseal } from '../src/crypto.ts';
import { line } from '../src/log.ts';
import { checkPushSubscription, endpointHmac, subscriptionHmac } from '../src/push/endpoint.ts';
import { classifyPushError } from '../src/push/errors.ts';
import { keys, PUSH_KEYS } from './helpers.ts';

const sub = (endpoint: string, p256dh = PUSH_KEYS.p256dh) => ({ endpoint, keys: { p256dh, auth: PUSH_KEYS.auth } });

describe('push endpoints', () => {
  it('accepts the browsers push services', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://db5p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/QAbc',
    ]) {
      const ok = checkPushSubscription(sub(e));
      expect(ok).not.toBeNull();
      // web-push connects to the host its older parser reads: it must be the one checked here.
      expect(legacyParse(ok!.endpoint).hostname).toBe(new URL(e).hostname);
    }
  });

  it('refuses anything that could make the server call somewhere else', () => {
    for (const e of [
      'http://fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://localhost/x',
      'https://notify.windows.com.evil/x',
      'https://push.apple.com/x',
      // Hosts the sender's older URL parser (url.parse, used by web-push) cuts short: it would connect to 127.0.0.1 or localhost.
      "https://127.0.0.1'.notify.windows.com/w/?token=abc",
      'https://localhost;.push.apple.com/QAbc',
      'https://localhost`.push.apple.com/QAbc',
      'https://a_b.notify.windows.com/w/?token=abc',
      // Longer than a DNS name may be: the older parser reads no host at all, and HTTPS falls back to localhost.
      `https://${Array(4).fill('a'.repeat(63)).join('.')}.notify.windows.com/w/?token=abc`,
    ]) expect(checkPushSubscription(sub(e))).toBeNull();
  });

  it('gives equivalent spellings of one endpoint one canonical form, and refuses fragments', () => {
    const a = checkPushSubscription(sub('https://FCM.googleapis.com:443/fcm/send/abc'))!;
    const b = checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc'))!;
    expect(a.endpoint).toBe(b.endpoint);
    expect(endpointHmac(keys.index, a.endpoint)).toBe(endpointHmac(keys.index, b.endpoint));
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc#x'))).toBeNull();
    // An empty fragment or query changes the spelling but not the resource: refused, so it cannot get a second owner.
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc#'))).toBeNull();
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc?'))).toBeNull();
    expect(checkPushSubscription(sub('https://db5p.notify.windows.com/w/?token=abc'))).not.toBeNull();
    // Spellings a push service reads as the same subscription: a query it ignores, an escaped
    // character, base64 padding. Only WNS carries its (escaped) token in the query.
    for (const alias of [
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA?x=1',
      'https://updates.push.services.mozilla.com/wpush/v2/%67AAAA',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA==',
      'https://fcm.googleapis.com/fcm/send/abc?x=1',
      'https://fcm.googleapis.com/fcm/send/%61bc',
      'https://web.push.apple.com/QAbc?x=1',
    ]) expect(checkPushSubscription(sub(alias))).toBeNull();
    expect(checkPushSubscription(sub('https://wns2-db5p.notify.windows.com/w/?token=BQYAAAB%2bx%2fy%3d'))).not.toBeNull();
  });

  it('refuses a key that is not a P-256 point', () => {
    const notUncompressed = Buffer.from(PUSH_KEYS.p256dh, 'base64url');
    notUncompressed[0] = 0x02;
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/x', notUncompressed.toString('base64url')))).toBeNull();
    expect(checkPushSubscription(sub('https://fcm.googleapis.com/x', Buffer.alloc(65, 4).toString('base64url')))).toBeNull();
  });

  it('hashes an endpoint, and a whole subscription differently when only the keys change', () => {
    const a = checkPushSubscription(sub('https://fcm.googleapis.com/fcm/send/abc'))!;
    const b = { ...a, auth: Buffer.alloc(16, 2).toString('base64url') };
    expect(endpointHmac(keys.index, a.endpoint)).toBe(endpointHmac(keys.index, b.endpoint));
    expect(subscriptionHmac(keys.index, a)).not.toBe(subscriptionHmac(keys.index, b));
  });
});

describe('sealing with a label', () => {
  it('opens only with the same label', () => {
    const s = seal('secret', keys.email, 'push:v1');
    expect(s).toMatch(/^v2\.[A-Za-z0-9_-]+$/);
    expect(unseal(s, keys.email, 'push:v1')).toBe('secret');
    expect(() => unseal(s, keys.email, 'email:v1')).toThrow();
    expect(keyedHash(keys.index, 'x', 'y')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('push errors in logs', () => {
  it('keeps only a status and a category', () => {
    const err = Object.assign(new Error('Received unexpected response code'), {
      statusCode: 410,
      endpoint: 'https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT',
      body: '{"reason":"secret body"}',
      headers: { authorization: 'vapid t=SECRET' },
    });
    const summary = classifyPushError(err);
    expect(summary).toEqual({ status: 410, category: 'gone' });
    expect(line('warn', 'push failed', { push: summary })).not.toMatch(/SECRET|secret body/);
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 404 })).category).toBe('gone');
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 413 })).category).toBe('too-big');
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 429 })).category).toBe('refused');
    expect(classifyPushError(Object.assign(new Error('x'), { statusCode: 503 })).category).toBe('refused');
    expect(classifyPushError(new Error('Socket timeout'))).toEqual({ status: null, category: 'uncertain' });
    expect(classifyPushError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).category).toBe('uncertain');
    expect(classifyPushError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).category).toBe('refused');
  });
});
