import crypto from 'crypto';
import { findTestFlowFiles, fetchTestFlowJson } from '$lib/api/github.js';
import {
  fetchE2EInstanceFlows,
  fetchFlowById,
  cleanFlowForComparison,
  getGlobalE2EResultStores,
  fetchStoreRecords,
  listAccounts,
  getInstanceUrl
} from '$lib/api/appmixer.js';
import { getE2EFlows, replaceE2EFlows, replaceAccountServices } from '$lib/db/e2e.js';

const CONTENT_BATCH = 10;

// Version prefix of stored comparison hashes. Bump when the comparison rules in
// cleanFlowForComparison change — cached hashes with an old prefix are recomputed
// on the next scan instead of being reused.
const HASH_VERSION = 'v3:';

/** @param {string} content */
function md5(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Recursively sort object keys — the server returns flow properties in its own
 * order after a save, so the hash must be key-order-insensitive.
 * @param {any} value
 * @returns {any}
 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Comparison hash of a flow JSON (server or GitHub side) — both sides are
 * normalized through cleanFlowForComparison (instance-specific bindings and
 * server-stamped fields never cause a "modified") and canonicalized by key order.
 * @param {any} flowJson
 * @param {string} [identityName]
 */
export function flowComparisonHash(flowJson, identityName) {
  return (
    HASH_VERSION + md5(JSON.stringify(sortKeysDeep(cleanFlowForComparison(flowJson, identityName))))
  );
}

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
 * E2E identity of an instance flow — same rule as the appmixer CLI:
 * customFields.name written by `e2e import`, legacy fallback to the flow name.
 * @param {any} flow
 */
function instanceFlowIdentity(flow) {
  return flow.customFields?.name || flow.name;
}

/**
 * Account service names to try for a connector path, most specific first.
 * Instance service names are colon-separated ("ai/requesty" → "appmixer:ai:requesty",
 * verified against live /accounts data); nested connectors often authenticate at
 * the top level, so "appmixer:ai" is tried as a fallback.
 * @param {string} connector
 */
export function connectorServices(connector) {
  const segments = connector.split('/');
  const services = [`appmixer:${segments.join(':')}`];
  if (segments.length > 1) services.push(`appmixer:${segments[0]}`);
  return services;
}

/**
 * Build the newest result per test case from the two global result stores.
 * A record in the failed store means failed, succeeded store means passed;
 * when a test case appears in both, the newer record wins (CLI semantics).
 * @param {Array<any>} failedRecords
 * @param {Array<any>} successRecords
 * @returns {Map<string, {result: string, at: string, detail: Array<any>|null}>} keyed by lowercased test case
 */
function buildResultMap(failedRecords, successRecords) {
  const map = new Map();

  /**
   * @param {Array<any>} records
   * @param {string} result
   */
  const ingest = (records, result) => {
    for (const record of records) {
      if (!record?.key) continue;
      const key = record.key.toLowerCase().trim();
      const at = record.updatedAt || record.createdAt || null;
      const existing = map.get(key);
      if (existing && existing.at && at && new Date(existing.at) >= new Date(at)) {
        continue;
      }
      map.set(key, { result, at, detail: parseResultValue(record.value) });
    }
  };

  ingest(successRecords, 'passed');
  ingest(failedRecords, 'failed');

  return map;
}

/** @param {any} value */
function parseResultValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the latest results for all flows from the global E2E result stores.
 * Cheap: two store reads cover every test case.
 * @param {any} userId
 * @returns {Promise<Map<string, {result: string, at: string, detail: Array<any>|null}>>}
 */
export async function fetchLatestResults(userId) {
  const { failedStoreId, successStoreId } = await getGlobalE2EResultStores(userId);
  const [failedRecords, successRecords] = await Promise.all([
    failedStoreId ? fetchStoreRecords(userId, failedStoreId, { limit: 1000 }) : Promise.resolve([]),
    successStoreId
      ? fetchStoreRecords(userId, successStoreId, { limit: 1000 })
      : Promise.resolve([])
  ]);
  return buildResultMap(failedRecords, successRecords);
}

/**
 * Full scan: merge GitHub test-flow files (dev branch) with instance state and
 * latest run results, then replace the e2e_flows cache.
 *
 * Progress phases reported via `onProgress`:
 * `sources` → `github` (done/total) → `compare` (done/total) → `results` → `save`
 * @param {any} userId
 * @param {(progress: {phase: string, done?: number, total?: number}) => void} [onProgress]
 * @returns {Promise<{total: number, deployed: number, github: number, serverOnly: number, errors: Array<string>}>}
 */
export async function scanE2EFlows(userId, onProgress) {
  /** @type {Array<string>} */
  const errors = [];
  const progress = onProgress || (() => {});

  progress({ phase: 'sources' });
  const instanceUrl = await getInstanceUrl(userId);
  const [files, instanceFlows, cached] = await Promise.all([
    findTestFlowFiles(userId),
    fetchE2EInstanceFlows(userId),
    getE2EFlows(instanceUrl)
  ]);

  const cachedByPath = new Map(cached.map((f) => [f.githubPath, f]));
  const cachedByName = new Map(cached.map((f) => [f.flowName, f]));

  // 1. Resolve flow name + content hash for every GitHub file.
  // Content is only fetched when the blob sha changed since the last scan.
  /** @type {Array<any>} */
  const githubFlows = [];
  let githubDone = 0;
  progress({ phase: 'github', done: 0, total: files.length });
  await mapLimit(files, CONTENT_BATCH, async (file) => {
    const prev = cachedByPath.get(file.path);
    if (
      prev &&
      prev.githubSha === file.sha &&
      prev.flowName &&
      prev.githubHash?.startsWith(HASH_VERSION)
    ) {
      githubFlows.push({
        ...file,
        flowName: prev.flowName,
        githubHash: prev.githubHash
      });
      progress({ phase: 'github', done: ++githubDone, total: files.length });
      return;
    }

    try {
      const content = await fetchTestFlowJson(userId, file.path);
      if (!content?.name) {
        errors.push(`${file.path}: missing "name" field`);
        return;
      }
      githubFlows.push({
        ...file,
        flowName: content.name,
        githubHash: flowComparisonHash(content)
      });
    } catch (e) {
      errors.push(`${file.path}: ${e.message}`);
    } finally {
      progress({ phase: 'github', done: ++githubDone, total: files.length });
    }
  });

  // Dedupe by flow name (identity) — keep the first occurrence, report the rest
  const byName = new Map();
  for (const gf of githubFlows) {
    if (byName.has(gf.flowName)) {
      errors.push(
        `Duplicate flow name "${gf.flowName}" (${gf.path} vs ${byName.get(gf.flowName).path})`
      );
      continue;
    }
    byName.set(gf.flowName, gf);
  }

  // 2. Match instance flows by identity
  const instanceByIdentity = new Map();
  for (const flow of instanceFlows) {
    const identity = instanceFlowIdentity(flow);
    if (!identity) continue;
    // Prefer flows with explicit customFields identity over legacy name matches
    const existing = instanceByIdentity.get(identity);
    if (!existing || (!existing.customFields?.name && flow.customFields?.name)) {
      instanceByIdentity.set(identity, flow);
    }
  }

  // 3. Compute sync status for deployed flows.
  // Skip the expensive server-flow fetch when neither side changed since the last scan.
  /** @type {Array<any>} */
  const rows = [];
  const matchedInstanceIds = new Set();
  let compareDone = 0;
  const compareTotal = byName.size;
  progress({ phase: 'compare', done: 0, total: compareTotal });

  await mapLimit([...byName.values()], CONTENT_BATCH, async (gf) => {
    const instanceFlow = instanceByIdentity.get(gf.flowName);
    const prev = cachedByName.get(gf.flowName);

    const row = {
      flowName: gf.flowName,
      connector: gf.connector,
      githubPath: gf.path,
      githubSha: gf.sha,
      githubHash: gf.githubHash,
      githubUrl: gf.url,
      flowId: instanceFlow?.flowId || null,
      stage: instanceFlow?.stage || null,
      serverMtime: instanceFlow?.mtime || null,
      syncStatus: 'not_deployed',
      lastResult: null,
      lastResultAt: null,
      lastResultDetail: null,
      accountAvailable: null
    };

    if (instanceFlow) {
      matchedInstanceIds.add(instanceFlow.flowId);

      const unchanged =
        prev &&
        prev.flowId === instanceFlow.flowId &&
        prev.serverMtime === instanceFlow.mtime &&
        prev.githubSha === gf.sha &&
        prev.githubHash?.startsWith(HASH_VERSION) &&
        (prev.syncStatus === 'match' || prev.syncStatus === 'modified');

      if (unchanged) {
        row.syncStatus = prev.syncStatus;
      } else {
        try {
          const fullFlow = await fetchFlowById(userId, instanceFlow.flowId);
          const serverHash = flowComparisonHash(fullFlow, gf.flowName);
          row.syncStatus = serverHash === gf.githubHash ? 'match' : 'modified';
        } catch (e) {
          row.syncStatus = 'error';
          errors.push(`${gf.flowName}: failed to compare with server flow (${e.message})`);
        }
      }
    }

    rows.push(row);
    progress({ phase: 'compare', done: ++compareDone, total: compareTotal });
  });

  // 4. Instance flows without a GitHub counterpart.
  // Iterate the identity map (not the raw list) — the instance can hold several
  // flows sharing one identity and flow_name must stay unique in the cache.
  let serverOnly = 0;
  for (const [identity, flow] of instanceByIdentity) {
    if (matchedInstanceIds.has(flow.flowId)) continue;
    if (byName.has(identity)) continue;
    serverOnly++;
    rows.push({
      flowName: identity,
      connector: flow.customFields?.connector?.replace(/^appmixer:/, '').replace(/:/g, '/') || null,
      githubPath: null,
      githubSha: null,
      githubHash: null,
      githubUrl: null,
      flowId: flow.flowId,
      stage: flow.stage || null,
      serverMtime: flow.mtime || null,
      syncStatus: 'server_only',
      lastResult: null,
      lastResultAt: null,
      lastResultDetail: null,
      accountAvailable: null
    });
  }

  // 5. Account availability per connector — an account whose service matches the
  // connector (top-level fallback included) means its flows can actually run.
  try {
    const accounts = await listAccounts(userId);
    const services = new Set(accounts.map((a) => a.service).filter(Boolean));
    // Snapshot for views that need availability of connectors without cached
    // flows (PR overview of brand-new connectors)
    await replaceAccountServices(instanceUrl, [...services]);
    const availabilityByConnector = new Map();
    for (const row of rows) {
      if (!row.connector) continue;
      // utils components never authenticate — no badge instead of a misleading "No account"
      if (row.connector === 'utils' || row.connector.startsWith('utils/')) continue;
      let available = availabilityByConnector.get(row.connector);
      if (available === undefined) {
        available = connectorServices(row.connector).some((s) => services.has(s));
        availabilityByConnector.set(row.connector, available);
      }
      row.accountAvailable = available;
    }
  } catch (e) {
    errors.push(`Failed to list accounts: ${e.message}`);
    // Keep previously known availability rather than dropping it
    for (const row of rows) {
      const prev = cachedByName.get(row.flowName);
      if (prev && prev.accountAvailable != null) row.accountAvailable = prev.accountAvailable;
    }
  }

  // 6. Latest run results from the global stores
  progress({ phase: 'results' });
  try {
    const resultMap = await fetchLatestResults(userId);
    for (const row of rows) {
      const result = resultMap.get(row.flowName.toLowerCase().trim());
      if (result) {
        row.lastResult = result.result;
        row.lastResultAt = result.at;
        row.lastResultDetail = result.detail;
      }
    }
  } catch (e) {
    errors.push(`Failed to read result stores: ${e.message}`);
    // Keep previously known results rather than dropping them
    for (const row of rows) {
      const prev = cachedByName.get(row.flowName);
      if (prev?.lastResult) {
        row.lastResult = prev.lastResult;
        row.lastResultAt = prev.lastResultAt;
        row.lastResultDetail = prev.lastResultDetail;
      }
    }
  }

  progress({ phase: 'save' });
  await replaceE2EFlows(instanceUrl, rows);

  return {
    total: rows.length,
    github: byName.size,
    deployed: rows.filter((r) => r.flowId).length,
    serverOnly,
    errors
  };
}
