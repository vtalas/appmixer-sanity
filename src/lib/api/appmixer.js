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
    const settings = userId ? await getUserSettings(userId, [
        SETTING_KEYS.APPMIXER_BASE_URL,
        SETTING_KEYS.APPMIXER_USERNAME,
        SETTING_KEYS.APPMIXER_PASSWORD
    ]) : {};

    return {
        baseUrl: settings[SETTING_KEYS.APPMIXER_BASE_URL] || APPMIXER_BASE_URL || '',
        username: settings[SETTING_KEYS.APPMIXER_USERNAME] || APPMIXER_USERNAME || '',
        password: settings[SETTING_KEYS.APPMIXER_PASSWORD] || APPMIXER_PASSWORD || ''
    };
}

/**
 * Clear cached token for a user (call when config changes)
 * @param {string} userId - User ID (email)
 */
export function clearAppmixerTokenCache(userId) {
    if (userId) {
        tokenCache.delete(userId);
    } else {
        tokenCache.clear();
    }
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
        `${config.baseUrl}/flows?filter=customFields.category:E2E_test_flow&projection=-thumbnail`,
        {
            headers: { 'Authorization': `Bearer ${token}` }
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch E2E flows: ${response.status}`);
    }

    return response.json();
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
        .filter(flow => flow.name?.toLowerCase().includes(shortName))
        .map(flow => ({
            flowId: flow.flowId,
            name: flow.name,
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
            headers: { 'Authorization': `Bearer ${token}` }
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch flow ${flowId}: ${response.status}`);
    }

    return response.json();
}

/**
 * Clean flow for comparison - removes server-specific fields
 * This matches the logic from download-E2E-flows.js
 * @param {Object} flow
 * @returns {Object}
 */
export function cleanFlowForComparison(flow) {
    const cleaned = { ...flow };

    // Remove server-specific fields
    delete cleaned.flowId;
    delete cleaned.btime;
    delete cleaned.mtime;
    delete cleaned.userId;
    delete cleaned.runtimeErrors;
    delete cleaned.customFields;
    delete cleaned.stage;
    delete cleaned.description;

    // Clean ProcessE2EResults component - remove server-specific store IDs
    if (cleaned.flow) {
        const processE2EComponent = Object.values(cleaned.flow)
            .find(item => item.type === 'appmixer.utils.test.ProcessE2EResults');

        if (processE2EComponent?.config?.properties) {
            delete processE2EComponent.config.properties.failedStoreId;
            delete processE2EComponent.config.properties.successStoreId;
        }
    }

    return cleaned;
}

/**
 * Get the designer base URL
 * @param {string} userId - User ID (email)
 * @returns {Promise<string>}
 */
export async function getDesignerBaseUrl(userId) {
    const config = await getAppmixerConfig(userId);
    return config.baseUrl.replace('api.', 'my.');
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
    const response = await fetch(
        `${config.baseUrl}/flows/${flowId}`,
        {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to delete flow ${flowId}: ${response.status}`);
    }
}

/**
 * Get Appmixer instance info (safe for client exposure)
 * @param {string} userId - User ID (email)
 * @returns {Promise<{baseUrl: string, username: string, hasEnvCredentials: boolean, hasCustomCredentials: boolean}>}
 */
export async function getAppmixerInfo(userId) {
    const config = await getAppmixerConfig(userId);
    const settings = userId ? await getUserSettings(userId, [
        SETTING_KEYS.APPMIXER_BASE_URL,
        SETTING_KEYS.APPMIXER_USERNAME,
        SETTING_KEYS.APPMIXER_PASSWORD
    ]) : {};

    const hasEnvCredentials = !!(APPMIXER_BASE_URL && APPMIXER_USERNAME && APPMIXER_PASSWORD);
    const hasCustomCredentials = !!(settings[SETTING_KEYS.APPMIXER_BASE_URL] && settings[SETTING_KEYS.APPMIXER_USERNAME] && settings[SETTING_KEYS.APPMIXER_PASSWORD]);

    return {
        baseUrl: config.baseUrl,
        username: config.username,
        hasEnvCredentials,
        hasCustomCredentials
    };
}

/**
 * Start a flow on Appmixer
 * @param {string} userId - User ID (email)
 * @param {string} flowId - Flow ID to start
 * @returns {Promise<{flowId: string, ticket?: string}>}
 */
export async function startFlow(userId, flowId) {
    const config = await getAppmixerConfig(userId);
    const token = await getAccessToken(userId);
    const response = await fetch(
        `${config.baseUrl}/flows/${flowId}/coordinator`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ command: 'start' })
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to start flow ${flowId}: ${response.status}`);
    }

    return response.json();
}

/**
 * Stop a flow on Appmixer
 * @param {string} userId - User ID (email)
 * @param {string} flowId - Flow ID to stop
 * @returns {Promise<{flowId: string, ticket?: string}>}
 */
export async function stopFlow(userId, flowId) {
    const config = await getAppmixerConfig(userId);
    const token = await getAccessToken(userId);
    const response = await fetch(
        `${config.baseUrl}/flows/${flowId}/coordinator`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ command: 'stop' })
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to stop flow ${flowId}: ${response.status}`);
    }

    return response.json();
}
