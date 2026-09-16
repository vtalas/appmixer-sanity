import { json } from '@sveltejs/kit';
import { getAuthHubStatuses } from '$lib/db/authhub.js';
import { authHubFetch, resolveAuthHubFromUrl } from '$lib/server/authhub/hub.js';

/**
 * GET — public list of Auth Hub connectors. `?env=` picks the Auth Hub
 * (default prod), `?status=` filters by verification status.
 *
 * SECURITY: This endpoint is unauthenticated (whitelisted in hooks.server.js).
 * The upstream Auth Hub response contains clientSecret for every connector,
 * so fields are explicitly whitelisted below — never spread or pass the
 * upstream objects through.
 */
export async function GET({ url }) {
    const { hub, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error: status === 400 ? 'Unknown environment' : 'Service not configured' }, { status });
    }

    try {
        const [res, statuses] = await Promise.all([
            authHubFetch(hub, '/service-config'),
            getAuthHubStatuses(hub.id)
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
