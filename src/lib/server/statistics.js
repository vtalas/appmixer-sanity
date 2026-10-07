/**
 * Statistics of the release repo (appmixer-components `master` — what the
 * production marketplace is built from): how many connectors, components and
 * E2E test flows it holds, plus the connector versions.
 *
 * Counted the way appmixer-component-preview counts a local checkout — files
 * named bundle.json, component.json and test-flow*.json anywhere under
 * src/appmixer/ — so the numbers match its Statistics panel when it is
 * pointed at a checkout of the same branch. Everything comes from the one
 * recursive git tree the release page already uses (cached by tree sha) and
 * the bundle.json blobs (cached in the DB by blob sha).
 */

import { getGitHubConfig } from '$lib/api/github.js';
import {
  CONNECTORS_ROOT,
  connectorRoots,
  fetchSnapshot,
  getReleaseConfig,
  ownerOf,
  readBundles,
  snapshotInfo
} from './release/compare.js';

const COMPONENT_FILE = 'component.json';
const TEST_FLOW_FILE = /^test-flow.*\.json$/;

/**
 * @typedef {{
 *   name: string,
 *   directory: string,
 *   version: string | null,
 *   valid: boolean,
 *   components: number,
 *   e2eFlows: number,
 *   url: string
 * }} ConnectorStats
 *
 * @typedef {{
 *   repo: ReturnType<typeof snapshotInfo>,
 *   counts: {connectors: number, components: number, e2eFlows: number},
 *   connectors: ConnectorStats[],
 *   e2eFlows: {connector: string, fileName: string, path: string, url: string}[]
 * }} Statistics
 */

/**
 * @param {string | null | undefined} content - bundle.json content, null when unknown
 * @returns {{name: string | null, version: string | null} | null} null when it does not parse
 */
function parseBundle(content) {
  if (content == null) return null;
  try {
    const bundle = JSON.parse(content);
    return {
      name: typeof bundle.name === 'string' ? bundle.name : null,
      version: typeof bundle.version === 'string' ? bundle.version : null
    };
  } catch {
    return null;
  }
}

/**
 * Statistics of the release branch for the /statistics page.
 * @param {string} userId - User ID (email); their GitHub token overrides the env token
 * @returns {Promise<Statistics>}
 */
export async function loadStatistics(userId) {
  const { token } = await getGitHubConfig(userId);
  const { target } = getReleaseConfig();
  const snapshot = await fetchSnapshot(token, target);
  const roots = connectorRoots(snapshot.files);
  const bundles = await readBundles(token, [snapshot], roots);
  /** @param {string} path */
  const blobUrl = (path) => `https://github.com/${target.fullName}/blob/${target.branch}/${path}`;

  /** @type {Map<string, {components: number, e2eFlows: number}>} */
  const perConnector = new Map([...roots].map((root) => [root, { components: 0, e2eFlows: 0 }]));
  let components = 0;
  const e2eFlows = [];

  for (const path of snapshot.files.keys()) {
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    const isComponent = fileName === COMPONENT_FILE;
    const isFlow = !isComponent && TEST_FLOW_FILE.test(fileName);
    if (!isComponent && !isFlow) continue;

    const owner = ownerOf(path, roots);
    const stats = owner ? perConnector.get(owner) : null;
    if (isComponent) {
      components++;
      if (stats) stats.components++;
    } else {
      if (stats) stats.e2eFlows++;
      e2eFlows.push({
        // Nested connectors keep their full directory (microsoft/calendar)
        connector: owner || path.slice(CONNECTORS_ROOT.length).split('/')[0],
        fileName,
        path,
        url: blobUrl(path)
      });
    }
  }

  const connectors = [...roots]
    .map((directory) => {
      const path = `${CONNECTORS_ROOT}${directory}/bundle.json`;
      const file = snapshot.files.get(path);
      const bundle = parseBundle(file ? bundles.get(file.sha) : null);
      const stats = perConnector.get(directory) || { components: 0, e2eFlows: 0 };
      return {
        name: bundle?.name || `appmixer.${directory.replace(/\//g, '.')}`,
        directory,
        version: bundle?.version ?? null,
        valid: bundle !== null,
        components: stats.components,
        e2eFlows: stats.e2eFlows,
        url: blobUrl(path)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  e2eFlows.sort((a, b) => a.path.localeCompare(b.path));

  return {
    repo: snapshotInfo(snapshot),
    counts: { connectors: connectors.length, components, e2eFlows: e2eFlows.length },
    connectors,
    e2eFlows
  };
}
