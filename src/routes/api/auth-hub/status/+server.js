import { json } from '@sveltejs/kit';
import { setAuthHubStatus } from '$lib/db/authhub.js';

export async function POST({ request }) {
    const { serviceId, status } = await request.json();

    if (!serviceId || !['verified', 'not_verified', 'in_progress'].includes(status)) {
        return json({ error: 'serviceId and status (verified|not_verified|in_progress) are required' }, { status: 400 });
    }

    try {
        await setAuthHubStatus(serviceId, status);
        return json({ ok: true });
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
