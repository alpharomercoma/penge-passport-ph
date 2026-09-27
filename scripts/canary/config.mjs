// Canary settings. Deliberately independent of the built package so the issue
// step still works when the build itself failed; test/meta.test.ts checks
// that DISPLAY_NAME, NAME and ENV_PREFIX match src/meta.ts.
export const DISPLAY_NAME = 'PengePassportPH';
export const NAME = 'penge-passport-ph';
export const ENV_PREFIX = 'PENGE_PASSPORT_PH_';

const env = (key) => process.env[`${ENV_PREFIX}${key}`] || undefined;

/** Where results, screenshots and diffs are written (uploaded as an artifact in CI). */
export const RESULTS_DIR = env('RESULTS_DIR') ?? 'canary-results';
/** Override the site root (defaults to https://passport.gov.ph). */
export const BASE_URL = env('BASE_URL');
/** Override the site the canary scrapes (defaults to expected.json's canarySiteId). */
export const SITE_ID = env('SITE_ID');
/** `1` prints the gh calls the issue step would make instead of making them. */
export const ISSUE_DRY_RUN = env('ISSUE_DRY_RUN') === '1';

export const ISSUE_LABEL = 'canary';
export const ISSUE_TITLE = `❌ ${DISPLAY_NAME} canary: passport.gov.ph changed`;

/** Added to the User-Agent so the site's operators can tell canary traffic apart. */
export const CONTACT = process.env.GITHUB_REPOSITORY
  ? `canary; ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
  : 'canary';
