import { json, error } from '@sveltejs/kit';
import { fetchFlowById, cleanFlowForComparison } from '$lib/api/appmixer.js';
import {
    getGitHubConfig,
    createBranch,
    createOrUpdateFile,
    createPullRequest,
    generateFlowPath,
    verifyWriteAccess
} from '$lib/api/github.js';

/**
 * POST /api/e2e-flows/sync
 * Create a PR with selected E2E flows synced to GitHub
 */
export async function POST({ request, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return error(401, 'Unauthorized');
    }

    const userId = session.user.email;

    try {
        const { flows, prTitle, prDescription, targetBranch } = await request.json();

        // Validate input
        if (!flows || !Array.isArray(flows) || flows.length === 0) {
            return error(400, 'No flows provided');
        }

        if (!prTitle?.trim()) {
            return error(400, 'PR title is required');
        }

        if (!targetBranch?.trim()) {
            return error(400, 'Target branch is required');
        }

        // Verify write access before proceeding
        const accessCheck = await verifyWriteAccess(userId);
        if (!accessCheck.hasWriteAccess) {
            return error(403, accessCheck.error || 'No write access to repository');
        }

        // Create a unique branch name
        const timestamp = Date.now();
        const branchName = `sync-e2e-flows-${timestamp}`;

        // Create the new branch
        await createBranch(userId, branchName, targetBranch);

        // Process each flow
        const results = [];
        const errors = [];

        for (const flowInfo of flows) {
            const { flowId, name, connector, githubPath } = flowInfo;

            try {
                // Fetch the full flow from Appmixer
                const fullFlow = await fetchFlowById(userId, flowId);

                // Clean the flow for export
                const cleanedFlow = cleanFlowForComparison(fullFlow);

                // Determine the file path
                const filePath = githubPath || generateFlowPath(connector || 'unknown', name);

                // Format the JSON with 4-space indentation (matching GitHub format)
                const content = JSON.stringify(cleanedFlow, null, 4);

                // Create or update the file
                await createOrUpdateFile(
                    userId,
                    filePath,
                    content,
                    `Sync E2E flow: ${name}`,
                    branchName
                );

                results.push({
                    flowId,
                    name,
                    path: filePath,
                    success: true
                });
            } catch (e) {
                console.error(`Failed to sync flow ${flowId}:`, e);
                errors.push({
                    flowId,
                    name,
                    error: e.message
                });
            }
        }

        // If all flows failed, return error
        if (results.length === 0) {
            return error(500, `Failed to sync any flows: ${errors.map(e => e.error).join(', ')}`);
        }

        // Create the pull request
        const config = await getGitHubConfig(userId);
        const prBody = [
            prDescription || '',
            '',
            '## Synced Flows',
            '',
            ...results.map(r => `- \`${r.path}\` - ${r.name}`),
            '',
            errors.length > 0 ? [
                '## Errors',
                '',
                ...errors.map(e => `- ${e.name}: ${e.error}`),
                ''
            ].join('\n') : '',
            '---',
            `*Synced from ${config.owner}/${config.repo} via Appmixer Sanity Check*`
        ].filter(Boolean).join('\n');

        const pr = await createPullRequest(
            userId,
            prTitle.trim(),
            prBody,
            branchName,
            targetBranch
        );

        return json({
            success: true,
            prUrl: pr.html_url,
            prNumber: pr.number,
            branch: branchName,
            synced: results,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (e) {
        console.error('Failed to sync flows:', e);
        return error(500, e.message || 'Failed to sync flows');
    }
}
