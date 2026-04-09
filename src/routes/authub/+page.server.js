import { env } from '$env/dynamic/private';
import { getAuthHubStatuses } from '$lib/db/authhub.js';
import { isAdmin } from '$lib/admin.js';
import { getGitHubRepoInfo } from '$lib/api/github.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ fetch, locals }) {
    const session = await locals.auth();
    const userEmail = session?.user?.email || null;
    const admin = isAdmin(userEmail);
    const githubInfo = admin ? await getGitHubRepoInfo(userEmail) : null;

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;

    if (!baseUrl || !token) {
        return {
            connectors: [],
            cachedInfo: {},
            statuses: {},
            isAdmin: admin,
            githubInfo,
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
            isAdmin: admin,
            githubInfo,
            error: null
        };
    } catch (err) {
        return {
            connectors: [],
            cachedInfo: {},
            statuses: {},
            isAdmin: admin,
            githubInfo,
            error: `Failed to load Auth Hub connectors: ${/** @type {Error} */ (err).message}`
        };
    }
}
