// Everything the server reads from its environment (/etc/penge/server.env on
// the VPS), checked once at start-up so a bad value fails loudly, not later.
import { isPushMode, normalizeEmail, type PushMode } from '@penge/contracts';

export type MailMode = 'live' | 'dry-run' | 'off';

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PushConfig {
  mode: PushMode;
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  /** PUSH_MODE=owner: the token the owner's link carries; new notification setups need it. */
  ownerToken: string | null;
}

export interface Config {
  redisUrl: string;
  /** Only the checker needs R2; the API runs without these credentials. */
  r2: R2Config | null;
  keys: { email: Buffer; index: Buffer; token: Buffer };
  smtp: { host: string; port: number };
  mailFrom: string | null;
  publicBaseUrl: string | null;
  mailMode: MailMode;
  /** Stop sending for the day at this many emails (the domain's reputation is new). */
  mailDailyLimit: number;
  /**
   * Most alert emails one person gets in a day: a safety net that never binds
   * below their pace (one an hour, 24 a day; or one per check, 288 a day).
   */
  alertsPerSubscriberPerDay: number;
  /** Who gets the daily numbers by email (stats.ts); without it they only go to R2. */
  statsEmail: string | null;
  /** Where the rate limiter keeps its shared state. */
  stateDir: string;
  /** Where scans wait when R2 cannot be reached. */
  spoolDir: string;
  api: { host: string; port: number };
  push: PushConfig;
  /** The notification alerts' limits as set (null: unset), resolved against maxmemory at start (devices/capacity.ts). */
  devices: { alertLimit: number | null; recordLimit: number | null };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`${name} is not set`);
    return value;
  };
  const key = (name: string) => {
    const buf = Buffer.from(need(name), 'base64');
    if (buf.length !== 32) throw new ConfigError(`${name} must be 32 bytes, base64-encoded`);
    return buf;
  };
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  /** Origin plus an optional path, without a trailing slash: https://example.org/pengepassportph */
  const optionalUrl = (name: string) => {
    const raw = env[name]?.trim();
    if (!raw) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConfigError(`${name} is not a URL`);
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
      throw new ConfigError(`${name} must be an https:// URL`);
    }
    if (url.search || url.hash || url.username || url.password || !/^[A-Za-z0-9/_-]*$/.test(url.pathname)) {
      throw new ConfigError(`${name} must be a plain origin and path, like https://example.org/app`);
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  };

  const mailMode = (env.MAIL_MODE?.trim() || 'dry-run') as MailMode;
  if (!['live', 'dry-run', 'off'].includes(mailMode)) {
    throw new ConfigError('MAIL_MODE must be live, dry-run or off');
  }
  const mailFrom = env.MAIL_FROM?.trim() || null;
  const statsEmail = env.STATS_EMAIL?.trim() ? normalizeEmail(env.STATS_EMAIL) : null;
  if (env.STATS_EMAIL?.trim() && !statsEmail) throw new ConfigError('STATS_EMAIL is not an email address');
  const publicBaseUrl = optionalUrl('PUBLIC_BASE_URL');
  if (mailMode === 'live' && (!mailFrom || !publicBaseUrl)) {
    throw new ConfigError('MAIL_MODE=live needs MAIL_FROM and PUBLIC_BASE_URL');
  }

  if (env.PUSH_OWNER_EMAILS?.trim()) {
    throw new ConfigError('PUSH_OWNER_EMAILS is no longer used; remove it (owner mode now uses PUSH_OWNER_TOKEN)');
  }
  const pushModeRaw = env.PUSH_MODE?.trim() || 'off';
  if (!isPushMode(pushModeRaw)) throw new ConfigError('PUSH_MODE must be off, owner or live');
  let push: PushConfig = { mode: 'off', vapid: null, ownerToken: null };
  if (pushModeRaw !== 'off') {
    const publicKey = need('VAPID_PUBLIC_KEY');
    const privateKey = need('VAPID_PRIVATE_KEY');
    const subject = need('VAPID_SUBJECT');
    // What web-push checks when it first sends: a 65-byte uncompressed P-256 key and a 32-byte private key.
    const publicBytes = Buffer.from(publicKey, 'base64url');
    if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
      throw new ConfigError('VAPID_PUBLIC_KEY is not a VAPID public key');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new ConfigError('VAPID_PRIVATE_KEY is not a VAPID private key');
    if (!subject.startsWith('mailto:') || !normalizeEmail(subject.slice(7))) throw new ConfigError('VAPID_SUBJECT must be mailto: and an address');
    const ownerToken = env.PUSH_OWNER_TOKEN?.trim() || null;
    if (ownerToken !== null && !/^[A-Za-z0-9_-]{32,256}$/.test(ownerToken)) {
      throw new ConfigError('PUSH_OWNER_TOKEN must be 32 to 256 characters of A-Z, a-z, 0-9, _ and -');
    }
    if (pushModeRaw === 'owner' && !ownerToken) throw new ConfigError('PUSH_MODE=owner needs PUSH_OWNER_TOKEN');
    push = { mode: pushModeRaw, vapid: { publicKey, privateKey, subject }, ownerToken };
  }

  const redisUrl = need('REDIS_URL');
  const redis = (() => {
    try {
      return new URL(redisUrl);
    } catch {
      throw new ConfigError('REDIS_URL is not a URL');
    }
  })();
  // Its password would cross the network readable otherwise.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname);
  if (redis.protocol !== 'rediss:' && !local) {
    throw new ConfigError('REDIS_URL must use TLS (rediss://) unless Redis runs on this server');
  }

  const r2Vars = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const r2Set = r2Vars.filter((name) => env[name]?.trim());
  if (r2Set.length > 0 && r2Set.length < r2Vars.length) {
    throw new ConfigError(`set all of ${r2Vars.join(', ')}, or none`);
  }
  if (r2Set.length > 0 && !need('R2_ENDPOINT').startsWith('https://')) {
    throw new ConfigError('R2_ENDPOINT must be an https:// URL');
  }

  // Unset, the limits follow Valkey's maxmemory when the API or the checker starts (devices/capacity.ts: the measured
  // footprint at a quarter of it); set, they are used up to that ceiling, never above it.
  // Set but empty is a slip in server.env, not a request for the default.
  for (const name of ['DEVICE_ALERT_LIMIT', 'DEVICE_RECORD_LIMIT']) {
    if (env[name] !== undefined && env[name]!.trim() === '') throw new ConfigError(`${name} is set but empty`);
  }
  const alertLimit = env.DEVICE_ALERT_LIMIT === undefined ? null : int('DEVICE_ALERT_LIMIT', 0, 0, 100_000);
  const recordLimit = env.DEVICE_RECORD_LIMIT === undefined ? null : int('DEVICE_RECORD_LIMIT', 0, 0, 600_080);
  // Six units an alert: five for it and the end record it may leave, one for its last operation (kept a day after it ends).
  if (alertLimit !== null && recordLimit !== null && recordLimit < alertLimit * 6) throw new ConfigError('DEVICE_RECORD_LIMIT must hold 6 units for every alert DEVICE_ALERT_LIMIT allows');

  return {
    redisUrl,
    r2:
      r2Set.length === 0
        ? null
        : {
            endpoint: need('R2_ENDPOINT'),
            bucket: need('R2_BUCKET'),
            accessKeyId: need('R2_ACCESS_KEY_ID'),
            secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
          },
    keys: { email: key('EMAIL_ENC_KEY'), index: key('EMAIL_HMAC_KEY'), token: key('TOKEN_SECRET') },
    smtp: { host: env.SMTP_HOST?.trim() || '127.0.0.1', port: int('SMTP_PORT', 25, 1, 65535) },
    mailFrom,
    publicBaseUrl,
    mailMode,
    mailDailyLimit: int('MAIL_DAILY_LIMIT', 2500, 0, 100_000),
    alertsPerSubscriberPerDay: int('ALERTS_PER_SUBSCRIBER_PER_DAY', 288, 1, 1000),
    statsEmail,
    stateDir: env.STATE_DIR?.trim() || '/var/lib/penge/limiter',
    spoolDir: env.SPOOL_DIR?.trim() || '/var/lib/penge/spool',
    api: { host: env.API_HOST?.trim() || '127.0.0.1', port: int('API_PORT', 8787, 1, 65535) },
    push,
    devices: { alertLimit, recordLimit },
  };
}

export function requireR2(config: Config): R2Config {
  if (!config.r2) throw new ConfigError('the checker needs R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
  return config.r2;
}
