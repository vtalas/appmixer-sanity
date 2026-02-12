import { json, error } from '@sveltejs/kit';
import { startFlow, stopFlow } from '$lib/api/appmixer.js';

/**
 * POST /api/e2e-flows/toggle
 * Start or stop a flow
 */
export async function POST({ request, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return error(401, 'Unauthorized');
    }

    const userId = session.user.email;

    try {
        const { flowId, action } = await request.json();

        if (!flowId) {
            return error(400, 'flowId is required');
        }

        if (action !== 'start' && action !== 'stop') {
            return error(400, 'action must be "start" or "stop"');
        }

        if (action === 'start') {
            await startFlow(userId, flowId);
        } else {
            await stopFlow(userId, flowId);
        }

        return json({ success: true, action });
    } catch (e) {
        console.error(`Failed to ${e.action || 'toggle'} flow:`, e);
        return error(500, e.message || 'Failed to toggle flow');
    }
}
