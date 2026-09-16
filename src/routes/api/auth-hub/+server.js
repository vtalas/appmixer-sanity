import { json } from '@sveltejs/kit';
import { authHubFetch, resolveAuthHubFromUrl } from '$lib/server/authhub/hub.js';

/**
 * GET — list all connectors (service configs) of the `?env=` Auth Hub.
 */
export async function GET({ url }) {
    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    try {
        const res = await authHubFetch(hub, '/service-config');

        if (!res.ok) {
            const text = await res.text();
            return json({ error: `Auth Hub API error: ${res.status} ${text}` }, { status: res.status });
        }

        const data = await res.json();
        return json(data);
    } catch (err) {
        return json({ error: `Failed to connect to Auth Hub: ${err.message}` }, { status: 500 });
    }
}
