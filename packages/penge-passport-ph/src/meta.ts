/**
 * Package identity, used in the User-Agent, the CLI, the canary and the docs.
 * Keep in sync with package.json; test/meta.test.ts fails if they differ.
 */

/** The brand, as written in prose, titles and the logo. */
export const DISPLAY_NAME = 'PengePassportPH';
/** npm package, CLI command, repository, state directory and User-Agent product. */
export const NAME = 'penge-passport-ph';
/** Short CLI command installed alongside `NAME`. */
export const CLI_ALIAS = 'penge';
export const VERSION = '0.1.0';
/** A live page about the project: shown in the CLI help and the User-Agent, so the site's operators can see who is asking. */
export const HOMEPAGE = 'https://alphaexperimental.org/pengepassportph/';
/** Source, issues and changelog. It must exist before a release is published (CONTRIBUTING.md). */
export const REPOSITORY = 'https://github.com/alpharomercoma/penge-passport-ph';

/** Prefix for every environment variable this package and its canary read. */
export const ENV_PREFIX = 'PENGE_PASSPORT_PH_';
