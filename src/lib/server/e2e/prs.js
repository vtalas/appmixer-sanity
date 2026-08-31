import {
  getGitHubConfig,
  listOpenPullRequests,
  listPullRequestFiles,
  listConnectorRoots,
  fetchJsonAtRef
} from '$lib/api/github.js';
import { getInstanceUrl } from '$lib/api/appmixer.js';
import { getPRs, replacePRs } from '$lib/db/prs.js';
import { getE2EFlows, getAccountServices } from '$lib/db/e2e.js';
import { connectorServices } from '$lib/server/e2e/scan.js';

const PR_BATCH = 5;
const CONTENT_BATCH = 5;

/**
 * Run `fn` over items with limited concurrency
 * @param {Array<any>} items
 * @param {number} limit
 * @param {(item: any, i: number) => Promise<any>} fn
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Test-flow file locations — same convention as findTestFlowFiles / the appmixer CLI:
 *   src/appmixer/<connector...>/artifacts/test-flows/test-flow-*.json  (canonical)
 *   src/appmixer/<connector...>/test-flow*.json                        (legacy)
 * @param {string} path
 */
function isTestFlowPath(path) {
  if (!path.startsWith('src/appmixer/') || !path.endsWith('.json')) return false;
  if (!path.split('/').pop().startsWith('test-flow')) return false;
  if (path.includes('/artifacts/')) {
    return path.includes('/artifacts/test-flows/');
  }
  return true;
}

/**
 * Connector root directory of a manifest file path (bundle/service/package.json
 * directly in a connector directory), or null.
 * @param {string} path
 */
function manifestRoot(path) {
  if (!path.startsWith('src/appmixer/')) return null;
  const parts = path.split('/');
  const fileName = parts[parts.length - 1];
  if (fileName !== 'bundle.json' && fileName !== 'service.json' && fileName !== 'package.json') {
    return null;
  }
  return parts.slice(2, -1).join('/') || null;
}

/**
 * Map a changed file path to its connector using the known connector roots
 * (longest match wins — handles nested connectors like "microsoft/calendar").
 * Falls back to the first path segment under src/appmixer/.
 * @param {string} path
 * @param {Set<string>} connectorRoots
 * @returns {string|null}
 */
function connectorForPath(path, connectorRoots) {
  if (!path.startsWith('src/appmixer/')) return null;
  const segments = path.split('/').slice(2, -1);
  if (segments.length === 0) return null;

  for (let len = segments.length; len > 0; len--) {
    const candidate = segments.slice(0, len).join('/');
    if (connectorRoots.has(candidate)) return candidate;
  }
  return segments[0];
}

/**
 * Scan all open PRs of the connectors repo: which connectors each PR touches
 * and which test-flow files it adds/changes (with the flow identity read from
 * the PR head). Replaces the e2e_prs cache of the configured repo.
 * @param {any} userId - User ID (email) or null for env credentials (cron)
 * @returns {Promise<{total: number, withTestFlows: number, errors: Array<string>}>}
 */
export async function scanPRs(userId) {
  /** @type {Array<string>} */
  const errors = [];

  const config = await getGitHubConfig(userId);
  const repoKey = `${config.owner}/${config.repo}`;

  const [prs, connectorRoots] = await Promise.all([
    listOpenPullRequests(userId),
    listConnectorRoots(userId).catch((e) => {
      errors.push(`Failed to list connector roots: ${e.message}`);
      return new Set();
    })
  ]);

  const rows = await mapLimit(prs, PR_BATCH, async (pr) => {
    try {
      const files = await listPullRequestFiles(userId, pr.number);

      // Connector roots added by the PR itself (a brand-new connector doesn't
      // exist in the dev tree yet — without this it would map to its parent,
      // e.g. "ai/huggingface" to "ai")
      const prRoots = new Set(connectorRoots);
      for (const file of files) {
        if (file.status === 'removed') continue;
        const root = manifestRoot(file.path);
        if (root) prRoots.add(root);
      }

      const connectors = new Set();
      /** @type {Array<{path: string, status: string, flowName: string|null, connector: string|null}>} */
      const testFlows = [];

      for (const file of files) {
        const connector = connectorForPath(file.path, prRoots);
        if (connector) connectors.add(connector);

        if (isTestFlowPath(file.path)) {
          testFlows.push({
            path: file.path,
            status: file.status,
            flowName: null,
            connector
          });
        } else if (file.previousPath && isTestFlowPath(file.previousPath)) {
          // Renamed away from a test-flow location — treat as removed
          testFlows.push({
            path: file.previousPath,
            status: 'removed',
            flowName: null,
            connector: connectorForPath(file.previousPath, prRoots)
          });
        }
      }

      // Read the flow identity (JSON "name") from the PR head for present files
      await mapLimit(
        testFlows.filter((tf) => tf.status !== 'removed'),
        CONTENT_BATCH,
        async (tf) => {
          try {
            const content = await fetchJsonAtRef(userId, tf.path, pr.headSha);
            tf.flowName = content?.name || null;
          } catch (e) {
            errors.push(`PR #${pr.number} ${tf.path}: ${e.message}`);
          }
        }
      );

      return {
        ...pr,
        connectors: [...connectors].sort(),
        testFlows,
        filesCount: files.length
      };
    } catch (e) {
      errors.push(`PR #${pr.number}: ${e.message}`);
      return { ...pr, connectors: [], testFlows: [], filesCount: null };
    }
  });

  await replacePRs(repoKey, rows);

  return {
    total: rows.length,
    withTestFlows: rows.filter((r) => r.testFlows.length > 0).length,
    errors
  };
}

/**
 * Join the PR cache with the e2e_flows cache of the caller's instance:
 * per PR → per touched connector → that connector's flows (deployment/sync/
 * result/account state) with flows changed by the PR flagged, plus test-flow
 * files that exist only in the PR ("new in PR").
 * @param {any} userId - User ID (email) or null for env credentials
 * @returns {Promise<{repo: string, prs: Array<any>, lastScanAt: string|null}>}
 */
export async function buildPROverview(userId) {
  const config = await getGitHubConfig(userId);
  const repoKey = `${config.owner}/${config.repo}`;
  const instanceUrl = await getInstanceUrl(userId);

  const [prs, flows, accountServiceList] = await Promise.all([
    getPRs(repoKey),
    getE2EFlows(instanceUrl),
    getAccountServices(instanceUrl)
  ]);
  const accountServices = new Set(accountServiceList);

  /**
   * Account availability for any connector — from the accounts snapshot taken
   * during the e2e scan (works for connectors with no cached flows, e.g. new
   * connectors added by a PR); falls back to the flow-cache value when no
   * snapshot exists yet. utils never authenticates → null (no badge).
   * @param {string} connector
   * @param {Array<any>} cachedFlows
   */
  const accountAvailability = (connector, cachedFlows) => {
    if (connector === 'utils' || connector.startsWith('utils/')) return null;
    if (accountServices.size > 0) {
      return connectorServices(connector).some((s) => accountServices.has(s));
    }
    return cachedFlows.find((f) => f.accountAvailable != null)?.accountAvailable ?? null;
  };

  /** @type {Map<string, Array<any>>} */
  const flowsByConnector = new Map();
  for (const flow of flows) {
    if (!flow.connector) continue;
    if (!flowsByConnector.has(flow.connector)) flowsByConnector.set(flow.connector, []);
    flowsByConnector.get(flow.connector).push(flow);
  }

  const overview = prs.map((pr) => {
    const changedNames = new Set(
      pr.testFlows.filter((tf) => tf.flowName && tf.status !== 'removed').map((tf) => tf.flowName)
    );
    const changedPaths = new Set(
      pr.testFlows.filter((tf) => tf.status !== 'removed').map((tf) => tf.path)
    );

    const connectors = pr.connectors.map((name) => {
      const connectorFlows = (flowsByConnector.get(name) || []).map((flow) => ({
        flowName: flow.flowName,
        connector: flow.connector,
        githubPath: flow.githubPath,
        githubUrl: flow.githubUrl,
        flowId: flow.flowId,
        stage: flow.stage,
        syncStatus: flow.syncStatus,
        lastResult: flow.lastResult,
        lastResultAt: flow.lastResultAt,
        changedInPR:
          changedNames.has(flow.flowName) ||
          (flow.githubPath ? changedPaths.has(flow.githubPath) : false),
        newInPR: false
      }));

      const knownNames = new Set(connectorFlows.map((f) => f.flowName));
      const knownPaths = new Set(connectorFlows.map((f) => f.githubPath).filter(Boolean));

      // Test-flow files added by the PR that the dev-branch cache doesn't know yet
      for (const tf of pr.testFlows) {
        if (tf.status === 'removed' || tf.connector !== name) continue;
        if (tf.flowName && knownNames.has(tf.flowName)) continue;
        if (knownPaths.has(tf.path)) continue;
        connectorFlows.push({
          flowName: tf.flowName || tf.path.split('/').pop(),
          connector: name,
          githubPath: tf.path,
          githubUrl: `https://github.com/${repoKey}/blob/${pr.headBranch}/${tf.path}`,
          flowId: null,
          stage: null,
          syncStatus: 'not_deployed',
          lastResult: null,
          lastResultAt: null,
          changedInPR: true,
          newInPR: true
        });
      }

      connectorFlows.sort((a, b) => a.flowName.localeCompare(b.flowName));

      return {
        name,
        accountAvailable: accountAvailability(name, flowsByConnector.get(name) || []),
        flows: connectorFlows
      };
    });

    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      draft: pr.draft,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      filesCount: pr.filesCount,
      testFlowCount: pr.testFlows.filter((tf) => tf.status !== 'removed').length,
      connectors
    };
  });

  const lastScanAt = prs.reduce((max, pr) => {
    return pr.scannedAt && (!max || pr.scannedAt > max) ? pr.scannedAt : max;
  }, /** @type {string|null} */ (null));

  return { repo: repoKey, prs: overview, lastScanAt };
}
