// Subscriber emails are stored only encrypted (AES-256-GCM, which also detects
// tampering). A keyed hash of the address finds an existing subscriber without
// decrypting anything. Links carry random tokens (stored only as hashes) or,
// for unsubscribing, an id signed with HMAC.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

export function encryptEmail(email: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

export function decryptEmail(sealed: string, key: Buffer): string {
  const [version, payload] = sealed.split('.');
  if (version !== VERSION || !payload) throw new Error('unknown encrypted email format');
  const raw = Buffer.from(payload, 'base64url');
  if (raw.length < 12 + 16 + 1) throw new Error('encrypted email is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}

/** AES-256-GCM with `label` as associated data: a value sealed for one purpose never opens as another. */
export function seal(plain: string, key: Buffer, label: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(label));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v2.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

export function unseal(sealed: string, key: Buffer, label: string): string {
  const [version, payload] = sealed.split('.');
  if (version !== 'v2' || !payload) throw new Error('unknown sealed format');
  const raw = Buffer.from(payload, 'base64url');
  if (raw.length < 12 + 16 + 1) throw new Error('sealed value is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(label));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}

/** A keyed hash for one purpose: without the key it reveals nothing. */
export function keyedHash(key: Buffer, label: string, value: string): string {
  return createHmac('sha256', key).update(`${label}:${value}`).digest('base64url');
}

/** Same address, same index; without the key, the index reveals nothing. */
export function emailIndex(email: string, key: Buffer): string {
  return createHmac('sha256', key).update(`email:${email}`).digest('base64url');
}

/** 32 random bytes, base64url: 43 characters. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as their hash, so a database leak cannot confirm anything. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** 16 random bytes, base64url: 22 characters. */
export function newId(): string {
  return randomBytes(16).toString('base64url');
}

export function signUnsubscribe(subscriberId: string, key: Buffer): string {
  return `${subscriberId}.${createHmac('sha256', key).update(`unsubscribe:${subscriberId}`).digest('base64url')}`;
}

/** The subscriber id, if the signature is genuine. */
export function verifyUnsubscribe(token: string, key: Buffer): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const expected = Buffer.from(signUnsubscribe(id, key));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}
