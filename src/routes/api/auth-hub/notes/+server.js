import { json } from '@sveltejs/kit';
import { setAuthHubNotes } from '$lib/db/authhub.js';
import { DEFAULT_AUTH_HUB_ENV, isAuthHubEnv } from '$lib/server/authhub/hub.js';

/**
 * POST — save a connector's notes for the `?env=` Auth Hub.
 */
export async function POST({ request, url, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const env = url.searchParams.get('env') || DEFAULT_AUTH_HUB_ENV;
    if (!isAuthHubEnv(env)) {
        return json({ error: `Unknown Auth Hub environment "${env}"` }, { status: 400 });
    }

    const { serviceId, notes } = await request.json();
    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }

    await setAuthHubNotes(env, serviceId, notes || '');
    return json({ ok: true });
}
