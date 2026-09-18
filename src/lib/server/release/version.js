/**
 * Semver helpers shared by the release comparison and the release readiness.
 */

/**
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, pre: string | null} | null}
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(
    String(value ?? '').trim()
  );
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] || null };
}

/** Semver comparison of two parsed versions: -1 | 0 | 1 (a prerelease sorts before its release) */
export function compareParsed(a, b) {
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] > b[part] ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return Math.sign(a.pre.localeCompare(b.pre, undefined, { numeric: true }));
}
