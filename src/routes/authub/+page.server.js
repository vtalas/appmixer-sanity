import { getAuthHubStatuses, getAuthHubNotes } from '$lib/db/authhub.js';
import { isAdmin } from '$lib/admin.js';
import { getGitHubRepoInfo } from '$lib/api/github.js';
import {
    AUTH_HUB_ENV_COOKIE,
    DEFAULT_AUTH_HUB_ENV,
    isAuthHubEnv,
    listAuthHubEnvs,
    resolveAuthHub
} from '$lib/server/authhub/hub.js';
import { describeSource, getPackSources } from '$lib/server/authhub/pack.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ fetch, locals, url, cookies }) {
    const session = await locals.auth();
    const userEmail = session?.user?.email || null;
    const admin = isAdmin(userEmail);
    const githubInfo = admin ? await getGitHubRepoInfo(userEmail) : null;
    // Repositories "Upload Bundle → From repository" can pack from
    const packSources = admin && userEmail
        ? (await getPackSources(userEmail)).sources.map(describeSource)
        : [];

    // ?env= picks the Auth Hub and is remembered; without it the last pick is used
    const requested = url.searchParams.get('env');
    const remembered = cookies.get(AUTH_HUB_ENV_COOKIE);
    const envId = isAuthHubEnv(requested)
        ? requested
        : isAuthHubEnv(remembered)
          ? remembered
          : DEFAULT_AUTH_HUB_ENV;
    if (requested && envId === requested && requested !== remembered) {
        cookies.set(AUTH_HUB_ENV_COOKIE, envId, {
            path: '/authub',
            maxAge: 60 * 60 * 24 * 365,
            httpOnly: true,
            sameSite: 'lax'
        });
    }

    const envs = listAuthHubEnvs();
    const currentEnv = /** @type {(typeof envs)[number]} */ (envs.find((e) => e.id === envId));
    const base = {
        env: currentEnv,
        envs,
        isAdmin: admin,
        githubInfo,
        packSources
    };
    const empty = { connectors: [], cachedInfo: {}, statuses: {}, notes: {}, githubVersions: {} };

    const { hub, error } = resolveAuthHub(envId);
    if (!hub) {
        return { ...base, ...empty, error: `${currentEnv.label} Auth Hub is not configured: ${error}.` };
    }

    const q = `env=${encodeURIComponent(envId)}`;
    try {
        const [listRes, cacheRes, statuses, notes, githubOAuthRes] = await Promise.all([
            fetch(`/api/auth-hub?${q}`),
            fetch(`/api/auth-hub/bundle?${q}`),
            getAuthHubStatuses(envId),
            getAuthHubNotes(envId),
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
                // never ship client secrets to the browser
                serviceId: c.serviceId,
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
            ...base,
            connectors,
            cachedInfo,
            statuses,
            notes,
            githubVersions,
            error: null
        };
    } catch (err) {
        return {
            ...base,
            ...empty,
            error: `Failed to load ${currentEnv.label} Auth Hub connectors: ${/** @type {Error} */ (err).message}`
        };
    }
}
