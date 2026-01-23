import { APPMIXER_USERNAME, APPMIXER_PASSWORD, APPMIXER_BASE_URL } from '$env/static/private';
import { getSettings, SETTING_KEYS } from '$lib/db/settings.js';

let cachedToken = null;
let tokenExpiry = null;
let cachedConfig = null;

/**
 * Get Appmixer configuration (from DB settings or env defaults)
 * @returns {Promise<{baseUrl: string, username: string, password: string}>}
 */
export async function getAppmixerConfig() {
    const settings = await getSettings([
        SETTING_KEYS.APPMIXER_BASE_URL,
        SETTING_KEYS.APPMIXER_USERNAME,
        SETTING_KEYS.APPMIXER_PASSWORD
    ]);

    return {
        baseUrl: settings[SETTING_KEYS.APPMIXER_BASE_URL] || APPMIXER_BASE_URL || '',
        username: settings[SETTING_KEYS.APPMIXER_USERNAME] || APPMIXER_USERNAME || '',
        password: settings[SETTING_KEYS.APPMIXER_PASSWORD] || APPMIXER_PASSWORD || ''
    };
}

/**
 * Clear cached token (call when config changes)
 */
export function clearAppmixerTokenCache() {
    cachedToken = null;
    tokenExpiry = null;
    cachedConfig = null;
}

/**
 * Authenticate with Appmixer and get access token
 * Token is cached for 55 minutes
 * @returns {Promise<string>}
 */
async function getAccessToken() {
    const config = await getAppmixerConfig();
    const configKey = `${config.baseUrl}:${config.username}`;

    // Clear cache if config changed
    if (cachedConfig && cachedConfig !== configKey) {
        cachedToken = null;
        tokenExpiry = null;
    }

    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
        return cachedToken;
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
        throw new Error(`Appmixer auth failed:  ${response.status}`);
    }

    const data = await response.json();
    cachedToken = data.token;
    tokenExpiry = Date.now() + 55 * 60 * 1000; // Cache for 55 minutes
    cachedConfig = configKey;
    return cachedToken;
}

/**
 * Fetch all E2E test flows from Appmixer
 * @returns {Promise<Array<{flowId: string, name: string}>>}
 */
export async function fetchE2EFlows() {
    const config = await getAppmixerConfig();
    const token = await getAccessToken();
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
 * @param {string} connectorName - Full connector name (e.g., "appmixer.box")
 * @returns {Promise<Array<{flowId: string, name: string, url: string}>>}
 */
export async function getE2EFlowsForConnector(connectorName) {
    const config = await getAppmixerConfig();
    // Extract short name (e.g., "appmixer.box" -> "box")
    const shortName = connectorName.split('.').pop().toLowerCase();

    const flows = await fetchE2EFlows();

    // Build designer URL by replacing api. with my.
    const designerUrl = config.baseUrl.replace('api.', 'my.');

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
 * @returns {Promise<boolean>}
 */
export async function isAppmixerConfigured() {
    const config = await getAppmixerConfig();
    return !!(config.baseUrl && config.username && config.password);
}

/**
 * Fetch a single flow by ID with full details
 * @param {string} flowId
 * @returns {Promise<Object>}
 */
export async function fetchFlowById(flowId) {
    const config = await getAppmixerConfig();
    const token = await getAccessToken();
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
 * @returns {Promise<string>}
 */
export async function getDesignerBaseUrl() {
    const config = await getAppmixerConfig();
    return config.baseUrl.replace('api.', 'my.');
}

/**
 * Get Appmixer instance info (safe for client exposure)
 * @returns {Promise<{baseUrl: string, username: string, hasEnvCredentials: boolean, hasCustomCredentials: boolean}>}
 */
export async function getAppmixerInfo() {
    const config = await getAppmixerConfig();
    const settings = await getSettings([
        SETTING_KEYS.APPMIXER_BASE_URL,
        SETTING_KEYS.APPMIXER_USERNAME,
        SETTING_KEYS.APPMIXER_PASSWORD
    ]);

    const hasEnvCredentials = !!(APPMIXER_BASE_URL && APPMIXER_USERNAME && APPMIXER_PASSWORD);
    const hasCustomCredentials = !!(settings[SETTING_KEYS.APPMIXER_BASE_URL] && settings[SETTING_KEYS.APPMIXER_USERNAME] && settings[SETTING_KEYS.APPMIXER_PASSWORD]);

    return {
        baseUrl: config.baseUrl,
        username: config.username,
        hasEnvCredentials,
        hasCustomCredentials
    };
}
