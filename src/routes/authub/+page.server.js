import { env } from '$env/dynamic/private';
import { getAuthHubStatuses, getAuthHubNotes } from '$lib/db/authhub.js';
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
        const [listRes, cacheRes, statuses, notes, githubOAuthRes] = await Promise.all([
            fetch('/api/auth-hub'),
            fetch('/api/auth-hub/bundle?env=prod'),
            getAuthHubStatuses(),
            getAuthHubNotes(),
            fetch('/api/auth-hub/github-oauth').catch(() => null)
        ]);

        if (!listRes.ok) {
            const data = await listRes.json();
            throw new Error(data.error || `HTTP ${listRes.status}`);
        }

        const data = await listRes.json();
        /** @type {Array<{serviceId: string, source: string}>} */
        let authhubConnectors = [];
        if (Array.isArray(data)) {
            authhubConnectors = data;
        } else if (data && typeof data === 'object') {
            authhubConnectors = Object.entries(data).map(([key, value]) => ({
                service: key,
                .../** @type {any} */ (value)
            }));
        }

        // GitHub oauth2 connectors + cached versions
        /** @type {Array<{serviceId: string, path: string}>} */
        let githubOAuth = [];
        /** @type {Record<string, string>} */
        let githubVersions = {};
        if (githubOAuthRes?.ok) {
            const ghData = await githubOAuthRes.json();
            githubOAuth = ghData.oauth2 || [];
            githubVersions = ghData.versions || {};
        }

        // Build merged connector list
        const authhubIds = new Set(authhubConnectors.map(c => c.serviceId));
        const githubIds = new Set(githubOAuth.map(c => c.serviceId));

        // Tag auth hub connectors with source
        const connectorMap = new Map();
        for (const c of authhubConnectors) {
            connectorMap.set(c.serviceId, {
                ...c,
                source: githubIds.has(c.serviceId) ? 'both' : 'authhub'
            });
        }

        // Add GitHub-only oauth2 connectors
        for (const c of githubOAuth) {
            if (!authhubIds.has(c.serviceId)) {
                connectorMap.set(c.serviceId, { serviceId: c.serviceId, source: 'github' });
            }
        }

        const connectors = [...connectorMap.values()]
            .sort((a, b) => (a.serviceId || '').localeCompare(b.serviceId || ''));

        const cachedInfo = cacheRes.ok ? await cacheRes.json() : {};

        return {
            connectors,
            cachedInfo,
            statuses,
            notes,
            githubVersions,
            isAdmin: admin,
            githubInfo,
            error: null
        };
    } catch (err) {
        return {
            connectors: [],
            cachedInfo: {},
            statuses: {},
            notes: {},
            githubVersions: {},
            isAdmin: admin,
            githubInfo,
            error: `Failed to load Auth Hub connectors: ${/** @type {Error} */ (err).message}`
        };
    }
}
