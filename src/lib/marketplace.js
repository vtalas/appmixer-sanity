/**
 * Marketplace page helpers shared by the server and the browser.
 */

/** `vendor.service` or `vendor.service.module` — also a path segment and a file name */
const MODULE_NAME = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){1,2}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** @param {unknown} name */
export function isModuleName(name) {
  return typeof name === 'string' && MODULE_NAME.test(name);
}

/** @param {unknown} version */
export function isVersion(version) {
  return typeof version === 'string' && VERSION.test(version);
}

/**
 * Semver order of two versions: -1 | 0 | 1 (a prerelease sorts before its release).
 * Anything that is not a version sorts first.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = VERSION.exec(a || '');
  const pb = VERSION.exec(b || '');
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (const i of [1, 2, 3]) {
    if (+pa[i] !== +pb[i]) return +pa[i] > +pb[i] ? 1 : -1;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return Math.sign(pa[4].localeCompare(pb[4], undefined, { numeric: true }));
}

/**
 * What publishing `offered` does to an instance that has `installed`.
 * @param {string|null|undefined} installed
 * @param {string} offered
 * @returns {'new' | 'upgrade' | 'same' | 'downgrade'}
 */
export function publishVerdict(installed, offered) {
  if (!installed) return 'new';
  const order = compareVersions(offered, installed);
  return order > 0 ? 'upgrade' : order < 0 ? 'downgrade' : 'same';
}

/**
 * Same instance? API URLs compared the way the E2E cache scopes them.
 * @param {string|null|undefined} url
 */
export function normalizeInstanceUrl(url) {
  return (url || '').toLowerCase().replace(/\/+$/, '');
}
