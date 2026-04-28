import { json } from '@sveltejs/kit';
import { getGitHubConfig } from '$lib/api/github.js';
import { getGithubOAuthConnectors, setGithubOAuthConnectors } from '$lib/db/authhub.js';

const GITHUB_API_BASE = 'https://api.github.com';
const BATCH_SIZE = 15;

/**
 * GET — return cached GitHub connector data from DB.
 * Returns { oauth2: [{serviceId, path}], versions: {serviceId: version} }
 */
export async function GET({ locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }
    return json(await getGithubOAuthConnectors());
}

/**
 * POST — fetch from GitHub, save to DB, return result.
 */
export async function POST({ locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const config = await getGitHubConfig(session.user.email);
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'appmixer-sanity-check',
            ...(config.token ? { 'Authorization': `Bearer ${config.token}` } : {})
        };

        // Fetch full repo tree
        const treeRes = await fetch(
            `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`,
            { headers }
        );
        if (!treeRes.ok) {
            return json({ error: `GitHub tree error: ${treeRes.status}` }, { status: treeRes.status });
        }
        const { tree } = await treeRes.json();

        // Find all auth.js files and all bundle.json files under src/appmixer/
        const authFiles = tree.filter(/** @param {any} i */ i =>
            i.type === 'blob' && i.path.startsWith('src/appmixer/') && i.path.endsWith('/auth.js')
        );
        const bundleFiles = tree.filter(/** @param {any} i */ i =>
            i.type === 'blob' && i.path.startsWith('src/appmixer/') && i.path.endsWith('/bundle.json')
        );

        // Build map: folder -> bundle blob
        /** @type {Record<string, any>} */
        const folderToBundle = {};
        for (const item of bundleFiles) {
            const folder = item.path.slice(0, item.path.lastIndexOf('/'));
            folderToBundle[folder] = item;
        }

        // Batch-fetch auth.js to find oauth2 folders
        /** @type {Set<string>} */
        const oauth2Folders = new Set();
        for (let i = 0; i < authFiles.length; i += BATCH_SIZE) {
            const batch = authFiles.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (/** @type {any} */ file) => {
                try {
                    const res = await fetch(
                        `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${file.path}?ref=${config.branch}`,
                        { headers }
                    );
                    if (!res.ok) return null;
                    const data = await res.json();
                    const content = Buffer.from(data.content, 'base64').toString('utf-8');
                    return /type\s*:\s*['"]oauth2['"]/.test(content)
                        ? file.path.slice(0, file.path.lastIndexOf('/'))
                        : null;
                } catch { return null; }
            }));
            for (const f of results) if (f) oauth2Folders.add(f);
        }

        // Batch-fetch ALL bundle.json files to get serviceId + version
        /** @type {Array<{serviceId: string, path: string, version?: string, isOauth2: boolean}>} */
        const connectors = [];
        for (let i = 0; i < bundleFiles.length; i += BATCH_SIZE) {
            const batch = bundleFiles.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (/** @type {any} */ file) => {
                const folder = file.path.slice(0, file.path.lastIndexOf('/'));
                try {
                    const res = await fetch(
                        `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${file.path}?ref=${config.branch}`,
                        { headers }
                    );
                    if (!res.ok) return null;
                    const data = await res.json();
                    const bundle = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
                    const serviceId = bundle.name ? bundle.name.replace(/\./g, ':') : `appmixer:${folder.split('/').pop()}`;
                    return { serviceId, path: folder, version: bundle.version || null, isOauth2: oauth2Folders.has(folder) };
                } catch { return null; }
            }));
            for (const r of results) if (r) connectors.push(r);
        }

        // Also cover oauth2 folders that had no bundle.json
        for (const folder of oauth2Folders) {
            if (!folderToBundle[folder]) {
                connectors.push({ serviceId: `appmixer:${folder.split('/').pop()}`, path: folder, isOauth2: true });
            }
        }

        connectors.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
        await setGithubOAuthConnectors(connectors);

        // Return same shape as GET
        return json(await getGithubOAuthConnectors());
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
