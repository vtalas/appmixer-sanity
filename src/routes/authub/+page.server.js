import { env } from '$env/dynamic/private';
import { getAuthHubStatuses } from '$lib/db/authhub.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ fetch }) {
    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;

    if (!baseUrl || !token) {
        return {
            connectors: [],
            cachedInfo: {},
            statuses: {},
            error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured in environment variables.'
        };
    }

    try {
        const [listRes, cacheRes, statuses] = await Promise.all([
            fetch('/api/auth-hub'),
            fetch('/api/auth-hub/bundle?env=prod'),
            getAuthHubStatuses()
        ]);

        if (!listRes.ok) {
            const data = await listRes.json();
            throw new Error(data.error || `HTTP ${listRes.status}`);
        }

        const data = await listRes.json();
        let connectors = [];
        if (Array.isArray(data)) {
            connectors = data;
        } else if (data && typeof data === 'object') {
            connectors = Object.entries(data).map(([key, value]) => ({
                service: key,
                ...value
            }));
        }
        connectors.sort((a, b) => (a.serviceId || '').localeCompare(b.serviceId || ''));

        const cachedInfo = cacheRes.ok ? await cacheRes.json() : {};

        return {
            connectors,
            cachedInfo,
            statuses,
            error: null
        };
    } catch (err) {
        return {
            connectors: [],
            cachedInfo: {},
            statuses: {},
            error: `Failed to load Auth Hub connectors: ${/** @type {Error} */ (err).message}`
        };
    }
}
