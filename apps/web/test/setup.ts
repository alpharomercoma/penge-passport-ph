import { beforeEach, vi } from 'vitest';

// The fixtures' dates are early October 2026, and the app hides days that have passed (Manila time): every test runs
// on the morning the fixtures were written, so they hold whatever today's date is. Set before any test module loads
// (helpers read the time when they load), and again before each test (vi.useRealTimers() clears it). Date only:
// timers stay real.
const FIXTURES_DAY = new Date('2026-10-06T08:00:00+08:00');
vi.setSystemTime(FIXTURES_DAY);
beforeEach(() => {
  vi.setSystemTime(FIXTURES_DAY);
});

// jsdom has no layout: scrolling does nothing, and would otherwise log "Not implemented" on every page change.
window.scrollTo = () => undefined;

// jsdom has no matchMedia: the sheet calls it through detectContext.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
