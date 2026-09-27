export const REPO_URL = 'https://github.com/alpharomercoma/penge-passport-ph';
export const BOOKING_URL = 'https://passport.gov.ph/appointment';

/** Where the site lives, with a trailing slash: "/" or e.g. "/pengepassportph/" (Vite's `base`). */
export const BASE: string = import.meta.env.BASE_URL;

/** The page a path points at, relative to BASE: "/", "/confirm", "/unsubscribe" or anything else. */
export function routeOf(pathname: string, base = BASE): string {
  const root = base.replace(/\/+$/, '');
  if (root && pathname !== root && !pathname.startsWith(`${root}/`)) return pathname;
  return pathname.slice(root.length).replace(/\/+$/, '') || '/';
}
