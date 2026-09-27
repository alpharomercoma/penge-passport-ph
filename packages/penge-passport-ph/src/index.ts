/**
 * PengePassportPH (`penge-passport-ph`): read-only, rate-limited checker for
 * DFA Philippine passport appointment availability on passport.gov.ph.
 *
 * @packageDocumentation
 */
export {
  DEFAULT_BASE_URL,
  ENDPOINTS,
  MAX_APPLICANTS,
  PengePassportPH,
  userAgent,
  type PengePassportPHOptions,
  type WatchEvent,
  type WatchOptions,
} from './client.js';
export {
  CircuitOpenError,
  PengePassportPHError,
  RateLimitError,
  SessionError,
  UpstreamError,
} from './errors.js';
export { CLI_ALIAS, DISPLAY_NAME, ENV_PREFIX, HOMEPAGE, NAME, VERSION } from './meta.js';
export { defaultStateDir, LIMITS } from './rate-limit.js';
export { PHILIPPINES, REGIONS } from './regions.js';
export type {
  Availability,
  AvailabilityQuery,
  Country,
  DayAvailability,
  Region,
  Site,
  TimeSlot,
  TimeSlotQuery,
} from './types.js';
