// Accounts the E2E test flows need — one row per (service, scope set) instead of
// one per component, so a connector whose components all authenticate the same way
// is connected once. Connecting goes through the instance's own auth ticket flow
// (the redirect lands on the instance), never through a flow in the designer.

import {
  fetchComponentManifests,
  getValidAccountsForAuthType,
  getServiceAuthType,
  listAccounts,
  getInstanceUrl
} from '$lib/api/appmixer.js';
import { getE2EFlows, markAccountAvailable } from '$lib/db/e2e.js';
import { bindAccountToFlow } from './upload.js';

const LOOKUP_CONCURRENCY = 12;

/**
 * Cache connector path → module type: "google/drive" → "appmixer.google.drive"
 * @param {string} connector
 */
export function connectorToAuthType(connector) {
  return ['appmixer', ...connector.split('/')].join('.');
}

/** @param {string} connector */
function isUtils(connector) {
  return connector === 'utils' || connector.startsWith('utils/');
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight.
 * @template T, R
 * @param {Array<T>} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<Array<R>>}
 */
async function mapLimit(items, limit, fn) {
  /** @type {Array<R>} */
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Group the connectors of the cached E2E flows by what they authenticate against.
 * Service and scopes come from the component manifests on the instance, aggregated
 * per connector module the same way the engine does when it builds an auth URL for
 * the module — so a row's scopes are exactly what its Connect button asks for.
 * Connectors sharing a service AND an identical scope set collapse into one row;
 * the same service appearing twice means the scope sets differ.
 * @param {Array<string>} connectors - cache connector paths
 * @param {Array<any>} manifests - component manifests of those connectors
 * @returns {Array<{key: string, service: string, scopes: Array<string>, connectors: Array<string>, authType: string}>}
 */
export function groupConnectorsByAuth(connectors, manifests) {
  /** @type {Map<string, {key: string, service: string, scopes: Array<string>, connectors: Array<string>, authType: string}>} */
  const groups = new Map();

  for (const connector of [...connectors].sort()) {
    const prefix = connectorToAuthType(connector) + '.';
    const own = manifests.filter((m) => String(m?.name || '').startsWith(prefix) && m.auth);
    if (own.length === 0) continue; // nothing in this connector authenticates

    const service = own.find((m) => m.auth.service)?.auth.service;
    if (!service) continue;
    const scopes = [...new Set(own.flatMap((m) => m.auth.scope || []))].sort();

    const key = `${service}|${scopes.join(' ')}`;
    const group = groups.get(key);
    if (group) {
      group.connectors.push(connector);
    } else {
      groups.set(key, {
        key,
        service,
        scopes,
        connectors: [connector],
        authType: connectorToAuthType(connector)
      });
    }
  }

  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The rows of the accounts dialog: one per (service, scope set), with the accounts
 * the service has on the instance. Deliberately does NOT validate tokens — that is
 * a live call per row that can take seconds each (see `checkAccountRow`), so the
 * dialog asks for it row by row.
 *
 * Row status here is `missing` (no account of the service at all) or `unchecked`
 * (the service has accounts; whether one is valid for the row's scopes is unknown).
 * @param {string} userId - User ID (email)
 * @returns {Promise<{rows: Array<any>, errors: Array<string>}>}
 */
export async function getAccountsOverview(userId) {
  const instanceUrl = await getInstanceUrl(userId);
  const flows = await getE2EFlows(instanceUrl);

  /** @type {Map<string, {total: number, deployed: number}>} */
  const flowCounts = new Map();
  for (const flow of flows) {
    if (!flow.connector || isUtils(flow.connector)) continue;
    const count = flowCounts.get(flow.connector) || { total: 0, deployed: 0 };
    count.total++;
    if (flow.flowId) count.deployed++;
    flowCounts.set(flow.connector, count);
  }
  const connectors = [...flowCounts.keys()];
  if (connectors.length === 0) return { rows: [], errors: [] };

  /** @type {Array<string>} */
  const errors = [];
  const [manifests, accounts] = await Promise.all([
    fetchComponentManifests(userId, connectors.map(connectorToAuthType)),
    listAccounts(userId).catch((e) => {
      errors.push(`Failed to list accounts: ${e.message}`);
      return [];
    })
  ]);

  const groups = groupConnectorsByAuth(connectors, manifests);

  const services = [...new Set(groups.map((g) => g.service))];
  const authTypes = new Map(
    await mapLimit(services, LOOKUP_CONCURRENCY, async (service) => {
      return /** @type {[string, string|null]} */ ([
        service,
        await getServiceAuthType(userId, service).catch(() => null)
      ]);
    })
  );

  const rows = groups.map((group) => {
    const serviceAccounts = accounts
      .filter((a) => a.service === group.service && !a.revoked)
      .map((a) => ({
        accountId: a.accountId || a.id,
        name: a.displayName || a.name || a.accountId || a.id
      }));

    return {
      ...group,
      authMechanism: authTypes.get(group.service) || null,
      status: serviceAccounts.length > 0 ? 'unchecked' : 'missing',
      error: null,
      validAccounts: [],
      serviceAccounts,
      flowCount: group.connectors.reduce((n, c) => n + (flowCounts.get(c)?.total || 0), 0),
      deployedFlowCount: group.connectors.reduce(
        (n, c) => n + (flowCounts.get(c)?.deployed || 0),
        0
      )
    };
  });

  return { rows, errors };
}

/**
 * Live status of one row: the accounts whose token is valid right now and covers
 * every scope of the module. The engine validates (and refreshes) tokens for this,
 * which is why it is asked per row.
 * - `connected` — at least one such account
 * - `reauth` — none (token revoked/expired, or authorized with fewer scopes)
 * - `error` — the instance could not answer
 * @param {string} userId - User ID (email)
 * @param {string} authType - module type of the row
 * @returns {Promise<{status: string, validAccounts: Array<{accountId: string, name: string}>, error: string|null}>}
 */
export async function checkAccountRow(userId, authType) {
  try {
    const valid = await getValidAccountsForAuthType(userId, authType);
    const validAccounts = valid.map((a) => ({
      accountId: a.accountId,
      name: a.displayName || a.name || a.accountId
    }));
    return {
      status: validAccounts.length > 0 ? 'connected' : 'reauth',
      validAccounts,
      error: null
    };
  } catch (e) {
    return {
      status: 'error',
      validAccounts: [],
      error: /** @type {any} */ (e)?.message || 'Failed to read auth status'
    };
  }
}

/**
 * Bind an account to every deployed E2E flow of the given connectors and mark the
 * connectors as having an account in the cache.
 * @param {string} userId - User ID (email)
 * @param {string} accountId
 * @param {Array<string>} connectors - cache connector paths
 * @returns {Promise<{flows: number, components: number, errors: Array<string>}>}
 */
export async function bindAccountToConnectors(userId, accountId, connectors) {
  const instanceUrl = await getInstanceUrl(userId);
  const wanted = new Set(connectors);
  const flows = (await getE2EFlows(instanceUrl)).filter((f) => f.flowId && wanted.has(f.connector));
  const typePrefixes = connectors.map((c) => connectorToAuthType(c) + '.');

  let boundFlows = 0;
  let components = 0;
  /** @type {Array<string>} */
  const errors = [];
  for (const flow of flows) {
    try {
      const assigned = await bindAccountToFlow(userId, flow.flowId, accountId, typePrefixes);
      if (assigned > 0) boundFlows++;
      components += assigned;
    } catch (e) {
      errors.push(`${flow.flowName}: ${/** @type {any} */ (e)?.message || 'bind failed'}`);
    }
  }

  await markAccountAvailable(instanceUrl, connectors);

  return { flows: boundFlows, components, errors };
}
