import { json } from '@sveltejs/kit';
import { getGitHubConfig } from '$lib/api/github.js';
import { isAdmin } from '$lib/admin.js';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * GET — fetch bundle.json versions for all connectors from GitHub.
 * Returns a map: serviceId (e.g. "appmixer:box") -> { version, path }
 */
export async function GET({ locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;

    if (!isAdmin(userId)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
        const config = await getGitHubConfig(userId);

        // Fetch full repo tree
        const treeRes = await fetch(
            `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/git/trees/${config.branch}?recursive=1`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'appmixer-sanity-check',
                    ...(config.token ? { 'Authorization': `Bearer ${config.token}` } : {})
                }
            }
        );

        if (!treeRes.ok) {
            const errBody = await treeRes.text();
            console.error('[github-versions] Tree fetch failed:', treeRes.status, errBody);
            return json({ error: `GitHub API error: ${treeRes.status} - ${errBody}` }, { status: treeRes.status });
        }

        const treeData = await treeRes.json();

        // Find all bundle.json files under src/appmixer/
        const bundleFiles = treeData.tree.filter(/** @param {any} item */ (item) =>
            item.type === 'blob' &&
            item.path.startsWith('src/appmixer/') &&
            item.path.endsWith('/bundle.json')
        );

        // Fetch each bundle.json content (batch to avoid rate limits)
        /** @type {Record<string, {version: string, path: string}>} */
        const versions = {};
        const BATCH_SIZE = 15;

        for (let i = 0; i < bundleFiles.length; i += BATCH_SIZE) {
            const batch = bundleFiles.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(
                batch.map(async (/** @type {any} */ file) => {
                    try {
                        const res = await fetch(
                            `${GITHUB_API_BASE}/repos/${config.owner}/${config.repo}/contents/${file.path}?ref=${config.branch}`,
                            {
                                headers: {
                                    'Accept': 'application/vnd.github.v3+json',
                                    'User-Agent': 'appmixer-sanity-check',
                                    ...(config.token ? { 'Authorization': `Bearer ${config.token}` } : {})
                                }
                            }
                        );
                        if (!res.ok) return null;
                        const data = await res.json();
                        const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
                        return { path: file.path, name: content.name, version: content.version };
                    } catch {
                        return null;
                    }
                })
            );

            for (const r of results) {
                if (r?.name && r?.version) {
                    // name is like "appmixer.box" -> serviceId "appmixer:box"
                    const serviceId = r.name.replace(/\./g, ':');
                    versions[serviceId] = { version: r.version, path: r.path };
                }
            }
        }

        return json(versions);
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
