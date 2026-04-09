import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isAdmin } from '$lib/admin.js';

/**
 * GET — fetch service config for a single connector.
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

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;
    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    const whitelist = url.searchParams.get('whitelist');
    const path = whitelist
        ? `${baseUrl}/service-config/${encodeURIComponent(serviceId)}/whitelist`
        : `${baseUrl}/service-config/${encodeURIComponent(serviceId)}`;

    try {
        const res = await fetch(path, {
            headers: { 'Authorization': `Bearer ${token}` }
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

/**
 * PUT — update service config for a connector.
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

    const { serviceId, config } = await request.json();
    if (!serviceId || !config) {
        return json({ error: 'serviceId and config are required' }, { status: 400 });
    }

    try {
        const res = await fetch(`${baseUrl}/service-config/${encodeURIComponent(serviceId)}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
