import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import { authHubFetch, resolveAuthHubFromUrl } from '$lib/server/authhub/hub.js';

/**
 * GET — fetch service config for a single connector from the `?env=` Auth Hub;
 * `?whitelist=1` fetches its whitelist instead.
 */
export async function GET({ url, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceId = url.searchParams.get('serviceId');
    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    const whitelist = url.searchParams.get('whitelist');
    const path = whitelist
        ? `/service-config/${encodeURIComponent(serviceId)}/whitelist`
        : `/service-config/${encodeURIComponent(serviceId)}`;

    try {
        const res = await authHubFetch(hub, path);
        const data = await res.json();
        if (!res.ok) {
            return json({ error: data.message || `Auth Hub error: ${res.status}` }, { status: res.status });
        }
        return json(data);
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}

/**
 * PUT — update service config for a connector in the `?env=` Auth Hub.
 */
export async function PUT({ request, url, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    const { serviceId, config } = await request.json();
    if (!serviceId || !config) {
        return json({ error: 'serviceId and config are required' }, { status: 400 });
    }

    try {
        const res = await authHubFetch(hub, `/service-config/${encodeURIComponent(serviceId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        if (!res.ok) {
            return json({ error: data.message || `Auth Hub error: ${res.status}` }, { status: res.status });
        }
        return json(data);
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
