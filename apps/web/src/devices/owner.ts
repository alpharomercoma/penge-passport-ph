// The owner link (spec: "Configuration", owner mode): #owner=<token>, read before the app renders or the worker
// registers, kept in local storage, and removed from the address bar (a fragment never reaches the server or its logs).
export const OWNER_KEY = 'pengepassportph-owner-token';
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export function takeOwnerLink(w: Window = window): { kept: boolean } | null {
  const hash = w.location.hash.replace(/^#/, '');
  const parts = hash.split('&');
  const owners = parts.filter((p) => p.startsWith('owner='));
  if (owners.length === 0) return null;
  // Every owner= part leaves the address bar; more than one is ambiguous, and none is kept.
  const rest = parts.filter((p) => p && !p.startsWith('owner=')).join('&');
  w.history.replaceState(w.history.state, '', `${w.location.pathname}${w.location.search}${rest ? `#${rest}` : ''}`);
  if (owners.length > 1) return { kept: false };
  let token = owners[0]!.slice('owner='.length);
  try {
    token = decodeURIComponent(token);
  } catch {
    token = '';
  }
  token = token.trim();
  if (!TOKEN.test(token)) return { kept: false };
  try {
    w.localStorage.setItem(OWNER_KEY, token);
    return { kept: true };
  } catch {
    return { kept: false };
  }
}

export function ownerToken(w: Window = window): string | null {
  try {
    const t = w.localStorage.getItem(OWNER_KEY);
    return t && TOKEN.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function forgetOwner(w: Window = window): void {
  try {
    w.localStorage.removeItem(OWNER_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
