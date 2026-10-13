// Light or dark: the system's preference until the person picks one with the header's switch, then theirs (kept in
// this browser only). The choice is <html data-theme>, which styles.css reads before the system's preference.
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'pengepassportph-theme';
/** The page's background in each theme (styles.css --bg), for the browser's and the installed app's bar. */
const BAR: Record<Theme, string> = { light: '#ffffff', dark: '#101412' };

export function storedTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // Storage refused: the system's preference.
  }
}

export const systemTheme = (): Theme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** The theme on the page: the one chosen, or (null) the system's, with the bar colours index.html gives each. */
export function applyTheme(theme: Theme | null) {
  if (theme) document.documentElement.dataset.theme = theme;
  else document.documentElement.removeAttribute('data-theme');
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: Theme = (meta.getAttribute('media') ?? '').includes('dark') ? 'dark' : 'light';
    meta.content = BAR[theme ?? own];
  }
}

/** Picks a theme and keeps it, if this browser lets the site store it. */
export function chooseTheme(theme: Theme) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not kept: this visit only.
  }
}

/** Before the first render: the theme chosen on an earlier visit, so the page never draws in the other one first. */
export const startTheme = () => applyTheme(storedTheme());
