import { fetchE2EFlows, fetchFlowById, cleanFlowForComparison, isAppmixerConfigured, getAppmixerInfo, getAppmixerConfig } from '$lib/api/appmixer.js';
import { buildFlowNameToGitHubMap, getGitHubRepoInfo, getGitHubConfig } from '$lib/api/github.js';
import { GITHUB_TOKEN } from '$env/static/private';
import crypto from 'crypto';

/**
 * Compute MD5 hash of content
 * @param {string} content
 * @returns {string}
 */
function getHash(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

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

/**
 * Compare server flow with GitHub flow
 * @param {Object} serverFlow - Full flow from Appmixer
 * @param {Object} githubFlow - Flow content from GitHub
 * @returns {'match' | 'modified' | 'server_only'}
 */
function compareFlows(serverFlow, githubFlow) {
    if (!githubFlow) {
        return 'server_only';
    }

    // Clean server flow for comparison
    const cleanedServerFlow = cleanFlowForComparison(serverFlow);
    const serverHash = getHash(JSON.stringify(cleanedServerFlow, null, 4));

    // GitHub flow is already in the "clean" format (no server-specific fields)
    const githubHash = getHash(JSON.stringify(githubFlow, null, 4));

    return serverHash === githubHash ? 'match' : 'modified';
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
        // Fetch flows from Appmixer and GitHub in parallel
        const [appmixerFlows, githubFlowMap] = await Promise.all([
            fetchE2EFlows(userId),
            buildFlowNameToGitHubMap(userId).catch(e => {
                console.error('Failed to fetch GitHub flows:', e);
                return new Map();
            })
        ]);

        const appmixerConfig = await getAppmixerConfig(userId);
        const designerBaseUrl = appmixerConfig.baseUrl.replace('api-', '');

        // Process each flow and compare with GitHub
        const enrichedFlows = await Promise.all(
            appmixerFlows.map(async (flow) => {
                const githubInfo = githubFlowMap.get(flow.name);
                let syncStatus = 'server_only';

                if (githubInfo) {
                    try {
                        // Fetch full flow from Appmixer for comparison
                        const fullFlow = await fetchFlowById(userId, flow.flowId);
                        syncStatus = compareFlows(fullFlow, githubInfo.content);
                    } catch (e) {
                        console.error(`Failed to fetch flow ${flow.flowId}:`, e);
                        syncStatus = 'error';
                    }
                }

                return {
                    flowId: flow.flowId,
                    name: flow.name,
                    connector: extractConnectorFromFlowName(flow.name),
                    url: `${designerBaseUrl}/designer/${flow.flowId}`,
                    createdAt: flow.btime,
                    updatedAt: flow.mtime,
                    running: flow.stage === 'running',
                    syncStatus,
                    githubUrl: githubInfo?.url || null,
                    githubPath: githubInfo?.path || null
                };
            })
        );

        // Sort by connector name, then by flow name
        enrichedFlows.sort((a, b) => {
            const connectorA = a.connector || 'zzz';
            const connectorB = b.connector || 'zzz';
            if (connectorA !== connectorB) {
                return connectorA.localeCompare(connectorB);
            }
            return (a.name || '').localeCompare(b.name || '');
        });

        // Count stats
        const stats = {
            total: enrichedFlows.length,
            running: enrichedFlows.filter(f => f.running).length,
            stopped: enrichedFlows.filter(f => !f.running).length,
            match: enrichedFlows.filter(f => f.syncStatus === 'match').length,
            modified: enrichedFlows.filter(f => f.syncStatus === 'modified').length,
            serverOnly: enrichedFlows.filter(f => f.syncStatus === 'server_only').length,
            error: enrichedFlows.filter(f => f.syncStatus === 'error').length
        };

        return {
            flows: enrichedFlows,
            stats,
            error: null,
            designerBaseUrl,
            appmixerInfo,
            githubInfo
        };
    } catch (e) {
        console.error('Failed to fetch E2E flows:', e);
        return {
            flows: [],
            stats: { total: 0, running: 0, stopped: 0, match: 0, modified: 0, serverOnly: 0, error: 0 },
            error: `Failed to fetch E2E flows: ${e.message}`,
            designerBaseUrl: null,
            appmixerInfo,
            githubInfo
        };
    }
}
