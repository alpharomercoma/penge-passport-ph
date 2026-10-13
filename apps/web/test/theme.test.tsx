import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { startTheme, THEME_KEY } from '../src/theme.ts';
import { fakeApi } from './helpers.tsx';

const root = document.documentElement;
const metas = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);

/** The system's preference, as matchMedia reports it. */
const systemDark = (dark: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) => ({ matches: dark && query.includes('dark'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList,
  );

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  root.removeAttribute('data-theme');
  // As index.html has them: one for each system preference.
  document.head.innerHTML = '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" /><meta name="theme-color" content="#101412" media="(prefers-color-scheme: dark)" />';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the light and dark switch', () => {
  it('offers dark mode on a light system, switches to it, and remembers it', () => {
    systemDark(false);
    render(<App path="/" api={fakeApi()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(root.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    // The browser's (and the installed app's) bar follows the page, whatever the system prefers.
    expect(metas()).toEqual(['#101412', '#101412']);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(root.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
    expect(metas()).toEqual(['#ffffff', '#ffffff']);
  });

  it('starts in the theme chosen before, before the page draws', () => {
    systemDark(false);
    window.localStorage.setItem(THEME_KEY, 'dark');
    startTheme();
    expect(root.dataset.theme).toBe('dark');
    expect(metas()).toEqual(['#101412', '#101412']);
    render(<App path="/" api={fakeApi()} />);
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
  });

  it('follows the system while nothing was chosen', () => {
    systemDark(true);
    startTheme();
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(metas()).toEqual(['#ffffff', '#101412']);
    render(<App path="/" api={fakeApi()} />);
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeTruthy();
  });

  it('ignores a stored value it does not know', () => {
    systemDark(false);
    window.localStorage.setItem(THEME_KEY, 'sepia');
    startTheme();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('still switches when the browser refuses storage', () => {
    systemDark(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => startTheme()).not.toThrow();
    render(<App path="/" api={fakeApi()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(root.dataset.theme).toBe('dark');
  });
});

describe('the head script (public/theme-boot.js)', () => {
  const boot = () => new Function(readFileSync(join(__dirname, '../public/theme-boot.js'), 'utf8'))();

  it('applies the theme chosen on an earlier visit, and the bar colour with it', () => {
    window.localStorage.setItem(THEME_KEY, 'dark');
    boot();
    expect(root.dataset.theme).toBe('dark');
    expect(metas()).toEqual(['#101412', '#101412']);
  });

  it('leaves the system preference alone when nothing, or nothing it knows, was chosen', () => {
    boot();
    window.localStorage.setItem(THEME_KEY, 'sepia');
    boot();
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(metas()).toEqual(['#ffffff', '#101412']);
  });

  it('never throws when storage is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(boot).not.toThrow();
  });
});
