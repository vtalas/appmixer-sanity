import { json, error } from '@sveltejs/kit';
import { fetchFlowById, cleanFlowForComparison } from '$lib/api/appmixer.js';
import { buildFlowNameToGitHubMap } from '$lib/api/github.js';
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
 * Compare server flow with GitHub flow
 * @param {Object} serverFlow - Full flow from Appmixer
 * @param {Object} githubFlow - Flow content from GitHub
 * @returns {'match' | 'modified' | 'server_only'}
 */
function compareFlows(serverFlow, githubFlow) {
    if (!githubFlow) {
        return 'server_only';
    }

    const cleanedServerFlow = cleanFlowForComparison(serverFlow);
    const serverHash = getHash(JSON.stringify(cleanedServerFlow, null, 4));
    const githubHash = getHash(JSON.stringify(githubFlow, null, 4));

    return serverHash === githubHash ? 'match' : 'modified';
}

/**
 * GET /api/e2e-flows/sync-status
 * Compute sync statuses for all E2E flows (deferred loading)
 * Accepts query param: flows = JSON array of {flowId, name}
 */
export async function POST({ request, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return error(401, 'Unauthorized');
    }

    const userId = session.user.email;

    try {
        const { flows } = await request.json();

        if (!flows || !Array.isArray(flows)) {
            return error(400, 'flows array is required');
        }

        // Build GitHub flow map
        const githubFlowMap = await buildFlowNameToGitHubMap(userId).catch(e => {
            console.error('Failed to fetch GitHub flows:', e);
            return new Map();
        });

        // Compare each flow with GitHub
        const statuses = {};

        await Promise.all(
            flows.map(async (flow) => {
                const githubInfo = githubFlowMap.get(flow.name);

                if (!githubInfo) {
                    statuses[flow.flowId] = {
                        syncStatus: 'server_only',
                        githubUrl: null,
                        githubPath: null
                    };
                    return;
                }

                try {
                    const fullFlow = await fetchFlowById(userId, flow.flowId);
                    const syncStatus = compareFlows(fullFlow, githubInfo.content);
                    statuses[flow.flowId] = {
                        syncStatus,
                        githubUrl: githubInfo.url || null,
                        githubPath: githubInfo.path || null
                    };
                } catch (e) {
                    console.error(`Failed to fetch flow ${flow.flowId}:`, e);
                    statuses[flow.flowId] = {
                        syncStatus: 'error',
                        githubUrl: githubInfo.url || null,
                        githubPath: githubInfo.path || null
                    };
                }
            })
        );

        return json({ statuses });
    } catch (e) {
        console.error('Failed to compute sync statuses:', e);
        return error(500, e.message || 'Failed to compute sync statuses');
    }
}
