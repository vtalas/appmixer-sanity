//
// Upload (import) a GitHub test-flow to the Appmixer instance.
// Ports the essential semantics of `appmixer e2e import`: stamp the E2E identity
// (customFields), bind the ProcessE2EResults stores, enforce fail-fast error
// handling, create-or-update by identity, then bind accounts so the flow can run.
//
import { fetchTestFlowJson } from '$lib/api/github.js';
import { flowComparisonHash } from './scan.js';
import {
  fetchFlowById,
  updateFlow,
  createFlow,
  stopFlow,
  listStores,
  createStore,
  listAccounts,
  assignComponentAccount,
  getInstanceUrl,
  E2E_STORE_NAMES
} from '$lib/api/appmixer.js';
import { getDb } from '$lib/db/index.js';

const E2E_CATEGORY = 'E2E_test_flow';

// Same list the CLI strips in prepareFlowForUpload
const SERVER_FIELDS = [
  'err',
  'flowId',
  'userId',
  'stage',
  'createdAt',
  'modifiedAt',
  'btime',
  'mtime',
  'runtimeErrors',
  'thumbnail'
];

/**
 * Cache connector path → canonical ref: "microsoft/calendar" → "appmixer:microsoft:calendar"
 * (our GitHub filter only matches src/appmixer/, so the vendor is always appmixer)
 * @param {string} connector
 */
function connectorToRef(connector) {
  return ['appmixer', ...connector.split('/')].join(':');
}

/**
 * Component-type prefix of a ref: "appmixer:microsoft:calendar" → "appmixer.microsoft.calendar."
 * @param {string} ref
 */
function refToTypePrefix(ref) {
  return ref.replace(/:/g, '.') + '.';
}

/**
 * Account service names to try for a ref, most specific first. Instance service
 * names use the same colon format as the ref ("appmixer:ai:requesty", verified
 * against live /accounts data); nested connectors often authenticate at the top
 * level, so the vendor:top-segment fallback is tried last.
 * @param {string} ref
 */
function refToServices(ref) {
  const [vendor, ...segments] = ref.split(':');
  const services = [ref];
  if (segments.length > 1) services.push(`${vendor}:${segments[0]}`);
  return services;
}

/**
 * Derive connector refs from a flow's component types (utils excluded):
 * type "appmixer.box.ListFolder" → "appmixer:box"
 * @param {any} flowJson
 * @returns {Array<string>}
 */
function refsFromFlow(flowJson) {
  const refs = new Set();
  for (const comp of Object.values(flowJson.flow || {})) {
    const parts = String(comp.type || '').split('.');
    if (parts.length < 3) continue;
    if (parts[1] === 'utils') continue;
    refs.add([parts[0], ...parts.slice(1, -1)].join(':'));
  }
  return [...refs];
}

/**
 * Ensure the two global E2E result stores exist; create missing ones.
 * @param {any} userId
 * @returns {Promise<{failed: string, succeeded: string}>}
 */
export async function ensureE2EStores(userId) {
  const stores = await listStores(userId);
  /** @type {Record<string, string>} */
  const byName = {};
  for (const s of stores) byName[s.name] = s.storeId;

  for (const name of Object.values(E2E_STORE_NAMES)) {
    if (!byName[name]) {
      const created = await createStore(userId, name);
      byName[name] = created.storeId;
    }
  }

  return { failed: byName[E2E_STORE_NAMES.failed], succeeded: byName[E2E_STORE_NAMES.succeeded] };
}

/**
 * Prepare a GitHub flow JSON for upload — CLI `prepareFlowForUpload` semantics:
 * strip server fields, stamp identity customFields, bind result stores,
 * enforce fail-fast error handling.
 * @param {any} flowJson
 * @param {string} ref
 * @param {{failed: string, succeeded: string}} storeIds
 */
function prepareFlowForUpload(flowJson, ref, storeIds) {
  const prepared = JSON.parse(JSON.stringify(flowJson));
  for (const field of SERVER_FIELDS) delete prepared[field];

  prepared.description = prepared.description || `E2E test flow for ${ref}`;
  prepared.customFields = prepared.customFields || {};
  prepared.customFields.category = E2E_CATEGORY;
  prepared.customFields.connector = ref;
  prepared.customFields.name = flowJson.name;

  for (const comp of Object.values(prepared.flow || {})) {
    if (comp.type?.includes('ProcessE2EResults')) {
      comp.config = comp.config || {};
      comp.config.properties = comp.config.properties || {};
      comp.config.properties.failedStoreId = storeIds.failed;
      comp.config.properties.successStoreId = storeIds.succeeded;
    }
    // Fail-fast E2E semantics; flow-authored settings win
    if (!comp.errorHandling) {
      comp.errorHandling = { autoRetry: false, onError: 'stopFlow' };
    }
  }

  return prepared;
}

/**
 * Keep the live flow's ProcessE2EResults store bindings over the freshly ensured
 * ones when updating an existing flow (CLI `preserveStoreIds`).
 * @param {any} localJson
 * @param {any} serverFlow
 */
function preserveStoreIds(localJson, serverFlow) {
  const serverComps = serverFlow.flow || {};
  for (const [id, comp] of Object.entries(localJson.flow || {})) {
    if (comp.type?.includes('ProcessE2EResults') && serverComps[id]?.config?.properties) {
      comp.config = comp.config || {};
      comp.config.properties = comp.config.properties || {};
      comp.config.properties.successStoreId = serverComps[id].config.properties.successStoreId;
      comp.config.properties.failedStoreId = serverComps[id].config.properties.failedStoreId;
    }
  }
  return localJson;
}

/**
 * PUT with a one-shot fallback for older engines that reject errorHandling.
 * @param {any} userId
 * @param {string} flowId
 * @param {any} flowJson
 */
async function uploadWithErrorHandlingFallback(userId, flowId, flowJson) {
  try {
    await updateFlow(userId, flowId, flowJson, { forceUpdate: true });
  } catch (e) {
    if (!/errorHandling/i.test(/** @type {any} */ (e)?.message || '')) throw e;
    const stripped = JSON.parse(JSON.stringify(flowJson));
    for (const comp of Object.values(stripped.flow || {})) delete comp.errorHandling;
    await updateFlow(userId, flowId, stripped, { forceUpdate: true });
  }
}

/**
 * Bind accounts to every connector component of the flow — simplified port of the
 * CLI `reassignAccounts`. Precedence per component: the component's own
 * flow-authored account (if it exists on this instance) > first flow-authored
 * account > first existing account of the connector's service.
 * @param {any} userId
 * @param {string} flowId
 * @param {Array<string>} connectorRefs
 * @returns {Promise<{assigned: number, accountIds: Array<string>, warning?: string}>}
 */
async function reassignAccounts(userId, flowId, connectorRefs) {
  const flow = await fetchFlowById(userId, flowId);
  const components = flow.flow || {};
  const typePrefixes = connectorRefs.map(refToTypePrefix);
  /** @param {string} type */
  const isConnectorComp = (type) => typePrefixes.some((p) => type?.startsWith(p));

  const accounts = await listAccounts(userId);
  const liveIds = new Set(accounts.map((a) => a.accountId || a.id).filter(Boolean));

  /** @param {any} comp */
  const flowAccount = (comp) => {
    const id = comp.config?.properties?.account;
    return id && liveIds.has(id) ? id : null;
  };

  let sharedAccountId = null;
  for (const comp of Object.values(components)) {
    if (isConnectorComp(comp.type)) {
      sharedAccountId = flowAccount(comp);
      if (sharedAccountId) break;
    }
  }
  if (!sharedAccountId) {
    const services = new Set(connectorRefs.flatMap(refToServices));
    for (const service of services) {
      const match = accounts.find((a) => a.service === service);
      if (match) {
        sharedAccountId = match.accountId || match.id;
        break;
      }
    }
  }
  if (!sharedAccountId) {
    return {
      assigned: 0,
      accountIds: [],
      warning:
        'No matching service account on the instance — flow will not run until an account is bound.'
    };
  }

  // Resolve per component and rewrite the definition where it differs — the engine
  // reads config.properties.account from the definition at runtime.
  /** @type {Record<string, string>} */
  const resolved = {};
  let definitionChanged = false;
  for (const [compId, comp] of Object.entries(components)) {
    if (!isConnectorComp(comp.type)) continue;
    const accountId = flowAccount(comp) || sharedAccountId;
    resolved[compId] = accountId;
    if (comp.config?.properties?.account !== accountId) {
      comp.config = comp.config || {};
      comp.config.properties = comp.config.properties || {};
      comp.config.properties.account = accountId;
      definitionChanged = true;
    }
  }
  if (definitionChanged) {
    try {
      await updateFlow(userId, flowId, { flow: components }, { forceUpdate: true });
    } catch (e) {
      console.error(
        `Failed to rewrite accounts in flow ${flowId}:`,
        /** @type {any} */ (e)?.message
      );
    }
  }

  let assigned = 0;
  const used = new Set();
  for (const [compId, accountId] of Object.entries(resolved)) {
    try {
      await assignComponentAccount(userId, compId, accountId);
      assigned++;
      used.add(accountId);
    } catch (e) {
      console.error(`Failed to assign account to ${compId}:`, /** @type {any} */ (e)?.message);
    }
  }

  return { assigned, accountIds: [...used] };
}

/**
 * Upload one cached flow (by its GitHub file) to the instance — create or update.
 * @param {any} userId
 * @param {any} cachedFlow - row from the e2e_flows cache (needs githubPath, connector, flowName)
 * @param {{failed: string, succeeded: string}} storeIds - from ensureE2EStores
 * @returns {Promise<{flowId: string, created: boolean, accounts: Array<string>, warning?: string}>}
 */
export async function uploadFlowToInstance(userId, cachedFlow, storeIds) {
  if (!cachedFlow?.githubPath) {
    throw new Error('Flow has no GitHub file');
  }

  const flowJson = await fetchTestFlowJson(userId, cachedFlow.githubPath);
  if (!flowJson?.name) {
    throw new Error(`${cachedFlow.githubPath}: missing "name" field`);
  }

  const ref = connectorToRef(cachedFlow.connector || 'unknown');
  const prepared = prepareFlowForUpload(flowJson, ref, storeIds);
  const connectorRefs = refsFromFlow(flowJson);

  let flowId = cachedFlow.flowId;
  let created = false;

  if (flowId) {
    if (cachedFlow.stage === 'running') {
      await stopFlow(userId, flowId).catch(() => {});
    }
    const serverFlow = await fetchFlowById(userId, flowId);
    await uploadWithErrorHandlingFallback(userId, flowId, preserveStoreIds(prepared, serverFlow));
  } else {
    flowId = await createFlow(userId, prepared);
    created = true;
  }

  const { accountIds, warning } = await reassignAccounts(userId, flowId, connectorRefs);

  // Refresh the cache row so the UI reflects the new state without a full scan.
  // Sync status is recomputed against the GitHub JSON just uploaded — the
  // comparison normalizes instance-specific bindings on both sides.
  const fresh = await fetchFlowById(userId, flowId).catch(() => null);
  let syncStatus = 'match';
  if (fresh) {
    const serverHash = flowComparisonHash(fresh, cachedFlow.flowName);
    const githubHash = flowComparisonHash(flowJson);
    syncStatus = serverHash === githubHash ? 'match' : 'modified';
  }
  const db = getDb();
  await db.execute({
    sql: `UPDATE e2e_flows
      SET flow_id = ?, stage = ?, server_mtime = ?, sync_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE instance_url = ? AND flow_name = ?`,
    args: [
      flowId,
      fresh?.stage || 'stopped',
      fresh?.mtime || null,
      syncStatus,
      await getInstanceUrl(userId),
      cachedFlow.flowName
    ]
  });

  return { flowId, created, accounts: accountIds, warning };
}
