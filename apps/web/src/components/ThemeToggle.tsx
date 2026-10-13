import { useEffect, useState } from 'react';
import { chooseTheme, storedTheme, systemTheme, type Theme } from '../theme.ts';
import { MoonIcon, SunIcon } from './Icons.tsx';

/** The header's light and dark switch: shows the theme it switches to. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  const [chosen, setChosen] = useState(() => storedTheme() !== null);

  // Until one is chosen, the page follows the system's preference as it changes.
  useEffect(() => {
    if (chosen) return;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const follow = () => setTheme(media.matches ? 'dark' : 'light');
    media.addEventListener?.('change', follow);
    return () => media.removeEventListener?.('change', follow);
  }, [chosen]);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        chooseTheme(next);
        setTheme(next);
        setChosen(true);
      }}
    >
      {next === 'dark' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
