import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import { mapLimit } from '$lib/server/release/compare.js';
import {
    describeSource,
    getPackSources,
    planPack,
    resolveCommit
} from '$lib/server/authhub/pack.js';

const MAX_ITEMS = 100;
const PLAN_CONCURRENCY = 4;

/**
 * POST — batch preview for "upload from the repository": `{serviceIds, source}`
 * are all planned at one commit (the branch head, resolved once), so a batch
 * uploads a consistent snapshot. Per item: what would be packed, or why it
 * can't be. Upload each item with POST /api/auth-hub/upload-from-repo and the
 * returned `commitSha`.
 */
export async function POST({ request, locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;
    if (!userId || !isAdmin(userId)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const serviceIds = Array.isArray(body.serviceIds)
        ? [...new Set(body.serviceIds.filter((/** @type {unknown} */ id) => typeof id === 'string'))]
        : [];
    if (serviceIds.length === 0) {
        return json({ error: 'serviceIds is required' }, { status: 400 });
    }
    if (serviceIds.length > MAX_ITEMS) {
        return json({ error: `At most ${MAX_ITEMS} connectors at once` }, { status: 400 });
    }

    const { token, sources } = await getPackSources(userId);
    const source = sources.find((s) => s.id === (body.source || 'dev'));
    if (!source) {
        return json({ error: 'Unknown source' }, { status: 400 });
    }

    let commit;
    try {
        commit = await resolveCommit(token, source);
    } catch (err) {
        const e = /** @type {any} */ (err);
        return json({ error: e.message }, { status: e.status && e.status < 600 ? e.status : 500 });
    }

    const items = await mapLimit(serviceIds, PLAN_CONCURRENCY, async (serviceId) => {
        try {
            const { info } = await planPack({ token, source, serviceId, commitSha: commit.sha });
            return {
                ok: true,
                serviceId,
                name: info.name,
                kind: info.kind,
                version: info.version,
                path: info.path,
                pathUrl: info.pathUrl,
                fileCount: info.files.length,
                totalSize: info.totalSize
            };
        } catch (err) {
            return { serviceId, ok: false, error: /** @type {Error} */ (err).message };
        }
    });

    return json({
        source: describeSource(source),
        commitSha: commit.sha,
        committedAt: commit.committedAt,
        commitUrl: `https://github.com/${source.fullName}/commit/${commit.sha}`,
        items
    });
}
