// Where the server may send a push: only the browsers' push services, over
// HTTPS on the default port, to a key that really is a P-256 point. Anything
// else could make the server call an address a visitor chose (SSRF), or fail
// later when the message is encrypted.
import { createECDH } from 'node:crypto';
import { parsePushSubscription, type PushSubscriptionInput } from '@penge/contracts';
import { keyedHash } from '../crypto.ts';

/** Exact hosts, and suffixes (".notify.windows.com") for services that shard by host. */
export const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'] as const;

const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const allowedHost = (host: string) => PUSH_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));

function isP256Point(b64: string): boolean {
  const point = Buffer.from(b64, 'base64url');
  if (point.length !== 65 || point[0] !== 0x04) return false;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(point); // throws for a point that is not on the curve
    return true;
  } catch {
    return false;
  }
}

export function checkPushSubscription(raw: unknown): PushSubscriptionInput | null {
  const s = parsePushSubscription(raw);
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;
  // No fragment, not even an empty one, and no empty query: either would give one resource a second spelling.
  if (s.endpoint.includes('#') || (url.search === '' && url.href.includes('?'))) return null;
  // Plain DNS labels only: web-push connects with the older url.parse, which cuts a host like
  // "127.0.0.1'.notify.windows.com" short at the quote, after it passed the suffix check here.
  // And no longer than a DNS name may be (253): past that, url.parse reads no host and HTTPS falls back to localhost.
  if (url.hostname.length > 253 || !DNS_NAME.test(url.hostname)) return null;
  if (!allowedHost(url.hostname)) return null;
  // A push service may read other spellings as the same subscription (a query it ignores, an
  // escaped character, base64 padding), which would let one resource have two owners. Only WNS
  // carries its token, escaped, in the query; every other service gets the path alone, unescaped.
  if (!url.hostname.endsWith('.notify.windows.com') && (url.search !== '' || url.pathname.includes('%'))) return null;
  if (url.hostname === 'updates.push.services.mozilla.com' && url.pathname.includes('=')) return null;
  if (!isP256Point(s.p256dh)) return null;
  // One spelling per endpoint (lower-case host, no default port), so the same
  // push resource always hashes the same and has one owner.
  return { ...s, endpoint: url.href };
}

export const endpointHmac = (key: Buffer, endpoint: string) => keyedHash(key, 'push-endpoint', endpoint);
export const subscriptionHmac = (key: Buffer, s: PushSubscriptionInput) => keyedHash(key, 'push-subscription', `${s.endpoint}\n${s.p256dh}\n${s.auth}`);
