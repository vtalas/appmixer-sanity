import { APPMIXER_USERNAME, APPMIXER_PASSWORD, APPMIXER_BASE_URL } from '$env/static/private';
import { getUserSettings, SETTING_KEYS } from '$lib/db/settings.js';

// Token cache keyed by user+config
const tokenCache = new Map();
const TOKEN_TTL = 55 * 60 * 1000; // 55 minutes

/**
 * Get Appmixer configuration (from DB settings or env defaults)
 * @param {string} userId - User ID (email)
 * @returns {Promise<{baseUrl: string, username: string, password: string}>}
 */
export async function getAppmixerConfig(userId) {
  const settings = userId
    ? await getUserSettings(userId, [
        SETTING_KEYS.APPMIXER_BASE_URL,
        SETTING_KEYS.APPMIXER_USERNAME,
        SETTING_KEYS.APPMIXER_PASSWORD
      ])
    : {};

  return {
    baseUrl: settings[SETTING_KEYS.APPMIXER_BASE_URL] || APPMIXER_BASE_URL || '',
    username: settings[SETTING_KEYS.APPMIXER_USERNAME] || APPMIXER_USERNAME || '',
    password: settings[SETTING_KEYS.APPMIXER_PASSWORD] || APPMIXER_PASSWORD || ''
  };
}

/**
 * Normalized Appmixer instance URL of the caller's configuration — used as the
 * scope key for the e2e_flows cache and e2e_runs queue.
 * @param {string} userId - User ID (email), or null for env credentials (cron)
 * @returns {Promise<string>}
 */
export async function getInstanceUrl(userId) {
  const config = await getAppmixerConfig(userId);
  return (config.baseUrl || '').toLowerCase().replace(/\/+$/, '');
}

/**
 * Authenticate with Appmixer and get access token
 * Token is cached for 55 minutes per user
 * @param {string} userId - User ID (email)
 * @returns {Promise<string>}
 */
async function getAccessToken(userId) {
  const config = await getAppmixerConfig(userId);
  const configKey = `${config.baseUrl}:${config.username}`;
  const cacheKey = `${userId}:${configKey}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.token;
  }

  if (!config.baseUrl || !config.username || !config.password) {
    throw new Error('Appmixer credentials not configured');
  }

  const response = await fetch(`${config.baseUrl}/user/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.username,
      password: config.password
    })
  });

  if (!response.ok) {
    throw new Error(`Appmixer auth failed: ${response.status}`);
  }

  const data = await response.json();
  tokenCache.set(cacheKey, {
    token: data.token,
    expiry: Date.now() + TOKEN_TTL
  });

  return data.token;
}

/**
 * Fetch all E2E test flows from Appmixer
 * @param {string} userId - User ID (email)
 * @returns {Promise<Array<{flowId: string, name: string}>>}
 */
export async function fetchE2EFlows(userId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(
    `${config.baseUrl}/flows?filter=customFields.category:E2E_test_flow&projection=name,flowId&limit=1000`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch E2E flows: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch all E2E test flows from the instance with identity fields
 * (customFields.{category,connector,name} set by `appmixer e2e import`)
 * @param {string} userId - User ID (email)
 * @returns {Promise<Array<{flowId: string, name: string, stage: string, mtime: string, customFields: any}>>}
 */
export async function fetchE2EInstanceFlows(userId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(
    `${config.baseUrl}/flows?filter=customFields.category:E2E_test_flow&projection=name,flowId,stage,mtime,customFields&limit=1000`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch E2E flows: ${response.status}`);
  }

  return response.json();
}

/**
 * List all data stores on the instance
 * @param {string} userId - User ID (email)
 * @returns {Promise<Array<{storeId: string, name: string}>>}
 */
export async function listStores(userId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/stores`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to list stores: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : data?.stores || [];
}

// Store names used by the ProcessE2EResults component (same as appmixer CLI `e2e results`)
export const E2E_STORE_NAMES = {
  failed: 'E2E Failed Tests',
  succeeded: 'E2E Succeeded Tests'
};

/**
 * Find the global E2E result stores by their well-known names
 * @param {string} userId - User ID (email)
 * @returns {Promise<{failedStoreId: string|null, successStoreId: string|null}>}
 */
export async function getGlobalE2EResultStores(userId) {
  const stores = await listStores(userId);
  return {
    failedStoreId: stores.find((s) => s.name === E2E_STORE_NAMES.failed)?.storeId || null,
    successStoreId: stores.find((s) => s.name === E2E_STORE_NAMES.succeeded)?.storeId || null
  };
}

/**
 * Get E2E flows for a specific connector
 * @param {string} userId - User ID (email)
 * @param {string} connectorName - Full connector name (e.g., "appmixer.box")
 * @returns {Promise<Array<{flowId: string, name: string, url: string}>>}
 */
export async function getE2EFlowsForConnector(userId, connectorName) {
  const config = await getAppmixerConfig(userId);
  // Extract short name (e.g., "appmixer.box" -> "box")
  const shortName = connectorName.split('.').pop().toLowerCase();

  const flows = await fetchE2EFlows(userId);

  // Build designer URL by replacing api. with my.
  const designerUrl = config.baseUrl.replace('api', 'my');

  return flows
    .filter((flow) => flow.name?.toLowerCase().includes(shortName))
    .map((flow) => ({
      flowId: flow.flowId,
      name: flow.name,
      stage: flow.stage || 'stopped',
      url: `${designerUrl}/designer/${flow.flowId}`
    }));
}

/**
 * Check if Appmixer is configured
 * @param {string} userId - User ID (email)
 * @returns {Promise<boolean>}
 */
export async function isAppmixerConfigured(userId) {
  const config = await getAppmixerConfig(userId);
  return !!(config.baseUrl && config.username && config.password);
}

/**
 * Fetch a single flow by ID with full details
 * @param {string} userId - User ID (email)
 * @param {string} flowId
 * @returns {Promise<Object>}
 */
export async function fetchFlowById(userId, flowId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(
    `${config.baseUrl}/flows/${flowId}?projection=-thumbnail,-stageChangeInfo,-started,-stopped`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch flow ${flowId}: ${response.status}`);
  }

  return response.json();
}

/**
 * Extract E2E result store IDs from flow definition
 * @param {Object} flow
 * @returns {{failedStoreId: string|null, successStoreId: string|null}}
 */
export function getE2EResultStoreIds(flow) {
  if (!flow?.flow) {
    return { failedStoreId: null, successStoreId: null };
  }

  const processE2EComponent = Object.values(flow.flow).find(
    (item) => item.type === 'appmixer.utils.test.ProcessE2EResults'
  );

  const properties = processE2EComponent?.config?.properties;

  return {
    failedStoreId: properties?.failedStoreId || null,
    successStoreId: properties?.successStoreId || null
  };
}

/**
 * Fetch records from Appmixer data store
 * @param {string} userId - User ID (email)
 * @param {string} storeId
 * @param {{offset?: number, limit?: number, sort?: string}} options
 * @returns {Promise<Array<{key: string, value: string, updatedAt: string}>>}
 */
export async function fetchStoreRecords(userId, storeId, options = {}) {
  if (!storeId) {
    return [];
  }

  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);

  const params = new URLSearchParams({
    storeId,
    offset: String(options.offset ?? 0),
    limit: String(options.limit ?? 200),
    sort: options.sort ?? 'updatedAt:-1'
  });

  const response = await fetch(`${config.baseUrl}/store?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch store records for ${storeId}: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

// Server-only fields stripped before comparing/exporting a flow — same list the
// appmixer CLI uses when saving a flow to disk (`saveFlowToDisk` SERVER_FIELDS).
const SERVER_FIELDS = [
  'err',
  'flowId',
  'userId',
  'stage',
  'createdAt',
  'modifiedAt',
  'btime',
  'mtime',
  'thumbnail',
  'customFields',
  'description',
  'runtimeErrors',
  'stageChangeInfo',
  'started',
  'stopped',
  'sharedWith'
];

/**
 * Clean flow for EXPORT to a repo file — CLI `saveFlowToDisk` semantics: strip
 * server fields and result-store IDs, normalize the name to the E2E identity.
 * Flow-authored errorHandling and account IDs stay in the file (CLI parity);
 * the comparison ignores them anyway.
 * @param {any} flow
 * @param {string} [identityName]
 * @returns {any}
 */
export function cleanFlowForExport(flow, identityName) {
  const cleaned = JSON.parse(JSON.stringify(flow));

  for (const field of SERVER_FIELDS) {
    delete cleaned[field];
  }

  if (identityName) {
    cleaned.name = identityName;
  }

  for (const comp of Object.values(cleaned.flow || {})) {
    if (comp.type?.includes('ProcessE2EResults') && comp.config?.properties) {
      delete comp.config.properties.failedStoreId;
      delete comp.config.properties.successStoreId;
    }
  }

  return cleaned;
}

/**
 * Clean flow for COMPARISON - removes server-specific fields plus
 * everything the `e2e import` process legitimately injects per instance
 * (account IDs, fail-fast errorHandling, result-store IDs), so the comparison
 * reflects the flow LOGIC, not instance-specific bindings. Applied to BOTH the
 * server flow and the GitHub file before hashing/diffing.
 * Local files carry the flow's E2E identity as `name`, so pass `identityName`
 * (customFields.name) to normalize it.
 * @param {any} flow
 * @param {string} [identityName]
 * @returns {any}
 */
export function cleanFlowForComparison(flow, identityName) {
  const cleaned = JSON.parse(JSON.stringify(flow));

  for (const field of SERVER_FIELDS) {
    delete cleaned[field];
  }

  // Engine stamps a default flow type ("automation") on save
  delete cleaned.type;

  if (identityName) {
    cleaned.name = identityName;
  }

  for (const comp of Object.values(cleaned.flow || {})) {
    // Injected by upload/import to enforce fail-fast E2E semantics
    delete comp.errorHandling;
    // Engine stamps the resolved component version on save (changes with upgrades)
    delete comp.version;
    if (comp.config?.properties) {
      // Instance-specific: bound service account
      delete comp.config.properties.account;
      // Instance-specific: E2E result store bindings
      if (comp.type?.includes('ProcessE2EResults')) {
        delete comp.config.properties.failedStoreId;
        delete comp.config.properties.successStoreId;
      }
    }
  }

  return cleaned;
}

/**
 * Update a flow on Appmixer (replace its content)
 * @param {string} userId - User ID (email)
 * @param {string} flowId - Flow ID to update
 * @param {any} flowData - Flow content to set
 * @param {{forceUpdate?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function updateFlow(userId, flowId, flowData, options = {}) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const qs = options.forceUpdate ? '?forceUpdate=true' : '';
  const response = await fetch(`${config.baseUrl}/flows/${flowId}${qs}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(flowData)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to update flow ${flowId}: ${response.status} ${body.slice(0, 300)}`);
  }
}

/**
 * Create a flow on Appmixer
 * @param {string} userId - User ID (email)
 * @param {any} flowData
 * @returns {Promise<string>} - new flowId
 */
export async function createFlow(userId, flowData) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/flows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(flowData)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to create flow: ${response.status} ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const flowId = data?.flowId || data?._id || data?.id;
  if (!flowId) {
    throw new Error('createFlow: no flowId in response');
  }
  return flowId;
}

/**
 * Create a data store
 * @param {string} userId - User ID (email)
 * @param {string} name
 * @returns {Promise<{storeId: string, name: string}>}
 */
export async function createStore(userId, name) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/stores`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    throw new Error(`Failed to create store "${name}": ${response.status}`);
  }

  return response.json();
}

/**
 * List service accounts of the authenticated user
 * @param {string} userId - User ID (email)
 * @returns {Promise<Array<any>>}
 */
export async function listAccounts(userId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/accounts`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to list accounts: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : data?.accounts || [];
}

/**
 * Bind a service account to a flow component (auth grant)
 * @param {string} userId - User ID (email)
 * @param {string} componentId
 * @param {string} accountId
 * @returns {Promise<void>}
 */
export async function assignComponentAccount(userId, componentId, accountId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/auth/component/${componentId}/${accountId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to assign account to component ${componentId}: ${response.status}`);
  }
}

/**
 * Delete a flow from Appmixer
 * @param {string} userId - User ID (email)
 * @param {string} flowId - Flow ID to delete
 * @returns {Promise<void>}
 */
export async function deleteFlow(userId, flowId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/flows/${flowId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to delete flow ${flowId}: ${response.status}`);
  }
}

/**
 * Start a flow
 * @param {string} userId - User ID (email)
 * @param {string} flowId - Flow ID to start
 * @returns {Promise<void>}
 */
export async function startFlow(userId, flowId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/flows/${flowId}/coordinator`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ command: 'start' })
  });

  console.log(
    response.status,
    response.statusText,
    (await response.text()) || '(empty response body)'
  );
  if (!response.ok) {
    throw new Error(`Failed to start flow ${flowId}: ${response.status}`);
  }
}

/**
 * Stop a flow
 * @param {string} userId - User ID (email)
 * @param {string} flowId - Flow ID to stop
 * @returns {Promise<void>}
 */
export async function stopFlow(userId, flowId) {
  const config = await getAppmixerConfig(userId);
  const token = await getAccessToken(userId);
  const response = await fetch(`${config.baseUrl}/flows/${flowId}/coordinator`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ command: 'stop' })
  });

  if (!response.ok) {
    throw new Error(`Failed to stop flow ${flowId}: ${response.status}`);
  }
}

/**
 * Get Appmixer instance info (safe for client exposure)
 * @param {string} userId - User ID (email)
 * @returns {Promise<{baseUrl: string, username: string, hasEnvCredentials: boolean, hasCustomCredentials: boolean}>}
 */
export async function getAppmixerInfo(userId) {
  const config = await getAppmixerConfig(userId);
  const settings = userId
    ? await getUserSettings(userId, [
        SETTING_KEYS.APPMIXER_BASE_URL,
        SETTING_KEYS.APPMIXER_USERNAME,
        SETTING_KEYS.APPMIXER_PASSWORD
      ])
    : {};

  const hasEnvCredentials = !!(APPMIXER_BASE_URL && APPMIXER_USERNAME && APPMIXER_PASSWORD);
  const hasCustomCredentials = !!(
    settings[SETTING_KEYS.APPMIXER_BASE_URL] &&
    settings[SETTING_KEYS.APPMIXER_USERNAME] &&
    settings[SETTING_KEYS.APPMIXER_PASSWORD]
  );

  return {
    baseUrl: config.baseUrl,
    username: config.username,
    hasEnvCredentials,
    hasCustomCredentials
  };
}
