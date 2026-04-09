import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isAdmin } from '$lib/admin.js';

/**
 * PUT — update a single whitelist key for a connector.
 * Proxies PUT /service-config/{serviceId}/whitelist/key/{key}
 */
export async function PUT({ request, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;
    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    const { serviceId, key, value } = await request.json();
    if (!serviceId || !key) {
        return json({ error: 'serviceId and key are required' }, { status: 400 });
    }

    try {
        const res = await fetch(
            `${baseUrl}/service-config/${encodeURIComponent(serviceId)}/whitelist/key/${encodeURIComponent(key)}`,
            {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
 * DELETE — remove a single whitelist key for a connector.
 * Proxies DELETE /service-config/{serviceId}/whitelist/key/{key}
 */
export async function DELETE({ request, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;
    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    const { serviceId, key } = await request.json();
    if (!serviceId || !key) {
        return json({ error: 'serviceId and key are required' }, { status: 400 });
    }

    try {
        const res = await fetch(
            `${baseUrl}/service-config/${encodeURIComponent(serviceId)}/whitelist/key/${encodeURIComponent(key)}`,
            {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            }
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
