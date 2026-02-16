import { fetchE2EFlows, isAppmixerConfigured, getAppmixerInfo, getAppmixerConfig } from '$lib/api/appmixer.js';
import { getGitHubRepoInfo, getGitHubConfig } from '$lib/api/github.js';
import { GITHUB_TOKEN } from '$env/static/private';

/**
 * Extract connector name from flow name
 * E2E flows typically have names like "E2E box - Upload File" or "appmixer.box E2E test"
 * @param {string} flowName
 * @returns {string|null}
 */
function extractConnectorFromFlowName(flowName) {
    if (!flowName) return null;

    // Common patterns in E2E flow names
    const patterns = [
        /e2e[_\s-]+(\w+)/i,           // "E2E box", "E2E_box", "E2E-box"
        /(\w+)[_\s-]+e2e/i,           // "box E2E", "box_E2E"
        /appmixer\.(\w+)/i,           // "appmixer.box"
    ];

    for (const pattern of patterns) {
        const match = flowName.match(pattern);
        if (match && match[1]) {
            return match[1].toLowerCase();
        }
    }

    return null;
}

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;

    const appmixerInfo = await getAppmixerInfo(userId);
    const githubInfo = await getGitHubRepoInfo(userId);
    const githubConfig = await getGitHubConfig(userId);

    // Add token status info (don't expose actual token)
    githubInfo.hasEnvToken = !!GITHUB_TOKEN;
    githubInfo.hasCustomToken = !!githubConfig.token && githubConfig.token !== GITHUB_TOKEN;

    const appmixerConfigured = await isAppmixerConfigured(userId);
    if (!appmixerConfigured) {
        return {
            flows: [],
            error: 'Appmixer is not configured. Please set APPMIXER_USERNAME, APPMIXER_PASSWORD, and APPMIXER_BASE_URL environment variables or configure them in settings.',
            designerBaseUrl: null,
            appmixerInfo,
            githubInfo
        };
    }

    try {
        const [appmixerFlows, appmixerConfig] = await Promise.all([
            fetchE2EFlows(userId),
            getAppmixerConfig(userId)
        ]);

        const designerBaseUrl = appmixerConfig.baseUrl.replace('api-', '')
            // hard-coded exceptions
            .replace('api.clientio.', 'my.clientio.');

        // Return basic flow data immediately - sync status loaded lazily on client
        const flows = appmixerFlows.map((flow) => ({
            flowId: flow.flowId,
            name: flow.name,
            connector: extractConnectorFromFlowName(flow.name),
            url: `${designerBaseUrl}/designer/${flow.flowId}`,
            stage: flow.stage || 'stopped',
            createdAt: flow.btime,
            updatedAt: flow.mtime,
            running: flow.stage === 'running',
            syncStatus: null,
            githubUrl: null,
            githubPath: null
        }));

        // Sort by connector name, then by flow name
        flows.sort((a, b) => {
            const connectorA = a.connector || 'zzz';
            const connectorB = b.connector || 'zzz';
            if (connectorA !== connectorB) {
                return connectorA.localeCompare(connectorB);
            }
            return (a.name || '').localeCompare(b.name || '');
        });

        return {
            flows,
            error: null,
            designerBaseUrl,
            appmixerInfo,
            githubInfo
        };
    } catch (e) {
        console.error('Failed to fetch E2E flows:', e);
        return {
            flows: [],
            error: `Failed to fetch E2E flows: ${e.message}`,
            designerBaseUrl: null,
            appmixerInfo,
            githubInfo
        };
    }
}
