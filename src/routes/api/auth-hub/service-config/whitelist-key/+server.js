import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import { authHubFetch, resolveAuthHubFromUrl } from '$lib/server/authhub/hub.js';

/**
 * PUT — update a single whitelist key for a connector in the `?env=` Auth Hub.
 * Proxies PUT /service-config/{serviceId}/whitelist/key/{key}
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

    const { serviceId, key, value } = await request.json();
    if (!serviceId || !key) {
        return json({ error: 'serviceId and key are required' }, { status: 400 });
    }

    try {
        const res = await authHubFetch(
            hub,
            `/service-config/${encodeURIComponent(serviceId)}/whitelist/key/${encodeURIComponent(key)}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(value)
            }
        );
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
 * DELETE — remove a single whitelist key for a connector in the `?env=` Auth Hub.
 * Proxies DELETE /service-config/{serviceId}/whitelist/key/{key}
 */
export async function DELETE({ request, url, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    const { serviceId, key } = await request.json();
    if (!serviceId || !key) {
        return json({ error: 'serviceId and key are required' }, { status: 400 });
    }

    try {
        const res = await authHubFetch(
            hub,
            `/service-config/${encodeURIComponent(serviceId)}/whitelist/key/${encodeURIComponent(key)}`,
            { method: 'DELETE' }
        );
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            return json({ error: data.message || `Auth Hub error: ${res.status}` }, { status: res.status });
        }
        return json({ ok: true });
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
