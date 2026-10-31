import { describe, expect, it } from 'vitest';
import { K } from '../src/keys.ts';
import { MemoryKv } from '../src/kv.ts';
import { silentLog, type Logger } from '../src/log.ts';
import { mailLimitFor, mailLimitNow } from '../src/mail-limit.ts';

describe('the daily email limit', () => {
  const set = { mailDailyLimit: 10_000, mailDailyLimitPerSubscriber: 12 };

  it('grows with the subscribers, up to the ceiling', () => {
    expect(mailLimitFor(set, 0)).toBe(0);
    expect(mailLimitFor(set, 395)).toBe(4740);
    expect(mailLimitFor(set, 833)).toBe(9996);
    expect(mailLimitFor(set, 834)).toBe(10_000);
    expect(mailLimitFor(set, 5000)).toBe(10_000);
  });

  it('is the ceiling alone without a rate', async () => {
    const fixed = { mailDailyLimit: 2500, mailDailyLimitPerSubscriber: null };
    expect(mailLimitFor(fixed, 395)).toBe(2500);
    const kv = new MemoryKv();
    kv.sCard = () => Promise.reject(new Error('not read without a rate'));
    expect(await mailLimitNow(kv, fixed, silentLog)).toEqual({ limit: 2500, subscribers: null });
  });

  it('counts the email subscribers each run', async () => {
    const kv = new MemoryKv();
    await kv.write([{ op: 'sAdd', key: K.allSubscribers, members: ['a', 'b', 'c'] }]);
    expect(await mailLimitNow(kv, set, silentLog)).toEqual({ limit: 36, subscribers: 3 });
    await kv.write([{ op: 'sRem', key: K.allSubscribers, members: ['c'] }]);
    expect(await mailLimitNow(kv, set, silentLog)).toEqual({ limit: 24, subscribers: 2 });
  });

  it('falls back to the ceiling when the count cannot be read, and says so', async () => {
    const kv = new MemoryKv();
    kv.sCard = () => Promise.reject(new Error('valkey went away'));
    const warned: string[] = [];
    const log: Logger = { ...silentLog, warn: (msg) => warned.push(msg) };
    expect(await mailLimitNow(kv, set, log)).toEqual({ limit: 10_000, subscribers: null });
    expect(warned).toEqual(['subscribers not counted; the email limit is its ceiling this run']);
  });
});
