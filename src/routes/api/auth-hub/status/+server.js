import { json } from '@sveltejs/kit';
import { setAuthHubStatus } from '$lib/db/authhub.js';
import { DEFAULT_AUTH_HUB_ENV, isAuthHubEnv } from '$lib/server/authhub/hub.js';

/**
 * POST — save a connector's verification status for the `?env=` Auth Hub.
 */
export async function POST({ request, url }) {
    const env = url.searchParams.get('env') || DEFAULT_AUTH_HUB_ENV;
    if (!isAuthHubEnv(env)) {
        return json({ error: `Unknown Auth Hub environment "${env}"` }, { status: 400 });
    }

    const { serviceId, status } = await request.json();

    if (!serviceId || !['verified', 'not_verified', 'in_progress'].includes(status)) {
        return json({ error: 'serviceId and status (verified|not_verified|in_progress) are required' }, { status: 400 });
    }

    try {
        await setAuthHubStatus(env, serviceId, status);
        return json({ ok: true });
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
