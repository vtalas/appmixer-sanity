import { json } from '@sveltejs/kit';
import { setAuthHubNotes } from '$lib/db/authhub.js';

export async function POST({ request, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { serviceId, notes } = await request.json();
    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }

    await setAuthHubNotes(serviceId, notes || '');
    return json({ ok: true });
}
