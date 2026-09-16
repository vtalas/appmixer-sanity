import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import { resolveAuthHubFromUrl, uploadToAuthHub } from '$lib/server/authhub/hub.js';
import {
    buildPack,
    describeSource,
    getPackSources,
    packFileName,
    planPack
} from '$lib/server/authhub/pack.js';

/**
 * @param {string} userId
 * @param {string|null|undefined} sourceId
 */
async function pickSource(userId, sourceId) {
    const { token, sources } = await getPackSources(userId);
    const source = sources.find((s) => s.id === (sourceId || 'dev'));
    return { token, sources, source };
}

/** @param {unknown} err */
function errorResponse(err) {
    const e = /** @type {any} */ (err);
    return json({ error: e.message }, { status: e.status && e.status < 600 ? e.status : 500 });
}

/**
 * GET — what `appmixer pack` would build for `?serviceId=` from `?source=`
 * (`dev` | `release`), optionally pinned to `?commit=`. Returns the file list,
 * bundle version and commit; `?download=1` returns the ZIP itself.
 */
export async function GET({ url, locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;
    if (!userId || !isAdmin(userId)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { token, sources, source } = await pickSource(userId, url.searchParams.get('source'));
    if (!source) {
        return json({ error: 'Unknown source' }, { status: 400 });
    }

    try {
        const plan = await planPack({
            token,
            source,
            serviceId: url.searchParams.get('serviceId') || '',
            commitSha: url.searchParams.get('commit') || undefined
        });

        if (url.searchParams.get('download')) {
            const zip = await buildPack(token, plan);
            return new Response(/** @type {BodyInit} */ (zip), {
                headers: {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="${packFileName(plan.info)}"`
                }
            });
        }

        return json({ ...plan.info, sources: sources.map(describeSource) });
    } catch (err) {
        return errorResponse(err);
    }
}

/**
 * POST — pack `{serviceId}` from `{source}` at `{commitSha}` (the commit the
 * preview showed) and upload it to the `?env=` Auth Hub. Returns `{ticket}`
 * plus what was packed; poll the ticket through GET /api/auth-hub/upload.
 */
export async function POST({ request, url, locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;
    if (!userId || !isAdmin(userId)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    const body = await request.json().catch(() => ({}));
    const { token, source } = await pickSource(userId, body.source);
    if (!source) {
        return json({ error: 'Unknown source' }, { status: 400 });
    }
    if (!body.commitSha) {
        return json({ error: 'commitSha is required — upload the commit the preview showed' }, { status: 400 });
    }

    try {
        const plan = await planPack({ token, source, serviceId: body.serviceId, commitSha: body.commitSha });
        const zip = await buildPack(token, plan);
        const { ticket } = await uploadToAuthHub(hub, zip);
        console.log(
            `[auth-hub/upload-from-repo] ${userId} uploaded ${plan.info.name}@${plan.info.version}` +
                ` (${source.fullName}@${plan.info.commitSha.slice(0, 7)}, ${zip.length} bytes) to ${hub.id}, ticket ${ticket}`
        );
        const { files, ...info } = plan.info;
        return json({ ticket, ...info, fileCount: files.length, size: zip.length });
    } catch (err) {
        return errorResponse(err);
    }
}
