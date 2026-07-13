import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getAuthHubStatuses } from '$lib/db/authhub.js';

/**
 * GET — public list of Auth Hub connectors.
 *
 * SECURITY: This endpoint is unauthenticated (whitelisted in hooks.server.js).
 * The upstream Auth Hub response contains clientSecret for every connector,
 * so fields are explicitly whitelisted below — never spread or pass the
 * upstream objects through.
 */
export async function GET({ url }) {
    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;

    if (!baseUrl || !token) {
        return json({ error: 'Service not configured' }, { status: 500 });
    }

    try {
        const [res, statuses] = await Promise.all([
            fetch(`${baseUrl}/service-config`, {
                headers: { 'Authorization': `Bearer ${token}` }
            }),
            getAuthHubStatuses()
        ]);

        if (!res.ok) {
            return json({ error: 'Upstream error' }, { status: 502 });
        }

        const data = await res.json();
        const list = Array.isArray(data) ? data : Object.values(data);

        const statusFilter = url.searchParams.get('status');

        const connectors = list
            .map((c) => ({
                connector: c.serviceId ?? null,
                status: statuses[c.serviceId] || 'not_verified',
                clientId: c.clientId ?? null
            }))
            .filter((c) => c.connector)
            .filter((c) => !statusFilter || c.status === statusFilter)
            .sort((a, b) => a.connector.localeCompare(b.connector));

        return json(connectors, {
            headers: { 'Cache-Control': 'public, max-age=60' }
        });
    } catch {
        return json({ error: 'Failed to load connectors' }, { status: 500 });
    }
}
