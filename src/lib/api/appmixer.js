import {APPMIXER_USERNAME, APPMIXER_PASSWORD, APPMIXER_BASE_URL} from '$env/static/private';

let cachedToken = null;
let tokenExpiry = null;

/**
 * Authenticate with Appmixer and get access token
 * Token is cached for 55 minutes
 * @returns {Promise<string>}
 */
async function getAccessToken() {
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
        return cachedToken;
    }

    if (!APPMIXER_BASE_URL || !APPMIXER_USERNAME || !APPMIXER_PASSWORD) {
        throw new Error('Appmixer credentials not configured');
    }

    const response = await fetch(`${APPMIXER_BASE_URL}/user/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: APPMIXER_USERNAME,
            password: APPMIXER_PASSWORD
        })
    });

    if (!response.ok) {
        throw new Error(`Appmixer auth failed:  ${response.status}`);
    }

    const data = await response.json();
    cachedToken = data.token;
    tokenExpiry = Date.now() + 55 * 60 * 1000; // Cache for 55 minutes
    return cachedToken;
}

/**
 * Fetch all E2E test flows from Appmixer
 * @returns {Promise<Array<{flowId: string, name: string}>>}
 */
export async function fetchE2EFlows() {
    const token = await getAccessToken();
    const response = await fetch(
        `${APPMIXER_BASE_URL}/flows?filter=customFields.category:E2E_test_flow&projection=-thumbnail`,
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
    // Extract short name (e.g., "appmixer.box" -> "box")
    const shortName = connectorName.split('.').pop().toLowerCase();

    const flows = await fetchE2EFlows();

    // Build designer URL by replacing api. with my.
    const designerUrl = APPMIXER_BASE_URL.replace('api.', 'my.');

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
 * @returns {boolean}
 */
export function isAppmixerConfigured() {
    return !!(APPMIXER_BASE_URL && APPMIXER_USERNAME && APPMIXER_PASSWORD);
}

/**
 * Fetch a single flow by ID with full details
 * @param {string} flowId
 * @returns {Promise<Object>}
 */
export async function fetchFlowById(flowId) {
    const token = await getAccessToken();
    const response = await fetch(
        `${APPMIXER_BASE_URL}/flows/${flowId}?projection=-thumbnail,-stageChangeInfo,-started,-stopped`,
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
 * @returns {string}
 */
export function getDesignerBaseUrl() {
    return APPMIXER_BASE_URL.replace('api.', 'my.');
}
