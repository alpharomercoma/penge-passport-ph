import type { Region } from './types.js';

/** Region dropdown on /appointment/individual/site (static in the page HTML). */
export const REGIONS: readonly Region[] = Object.freeze([
  { id: 1, name: 'Asia Pacific' },
  { id: 2, name: 'Europe' },
  { id: 3, name: 'North America' },
  { id: 4, name: 'South America' },
  { id: 5, name: 'Middle East/Africa' },
]);

export const PHILIPPINES = Object.freeze({ regionId: 1, countryId: 1 });
