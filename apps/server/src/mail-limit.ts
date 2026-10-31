// The most alert emails a Manila day may take, as one run reads it: with MAIL_DAILY_LIMIT_PER_SUBSCRIBER,
// it grows with the people subscribed by email, never above MAIL_DAILY_LIMIT (deploy/README.md, "Raising the
// email limit"). The checker enforces it and notes the day's highest for the report (checker.ts noteMailLimit).
import { K } from './keys.ts';
import type { Kv } from './kv.ts';
import type { Logger } from './log.ts';

export interface MailLimitSettings {
  mailDailyLimit: number;
  mailDailyLimitPerSubscriber: number | null;
}

/** So many a subscriber, never above the ceiling; without a rate, the ceiling. */
export function mailLimitFor(set: MailLimitSettings, subscribers: number): number {
  const { mailDailyLimit: ceiling, mailDailyLimitPerSubscriber: rate } = set;
  return rate === null ? ceiling : Math.min(ceiling, rate * subscribers);
}

/**
 * This run's limit and the count it came from. A count that cannot be read gives the ceiling: it is a
 * bound the owner chose, and an alert never waits for a count.
 */
export async function mailLimitNow(kv: Kv, set: MailLimitSettings, log: Logger): Promise<{ limit: number; subscribers: number | null }> {
  if (set.mailDailyLimitPerSubscriber === null) return { limit: set.mailDailyLimit, subscribers: null };
  try {
    const subscribers = await kv.sCard(K.allSubscribers);
    return { limit: mailLimitFor(set, subscribers), subscribers };
  } catch (err) {
    log.warn('subscribers not counted; the email limit is its ceiling this run', { err: err as Error, limit: set.mailDailyLimit });
    return { limit: set.mailDailyLimit, subscribers: null };
  }
}
