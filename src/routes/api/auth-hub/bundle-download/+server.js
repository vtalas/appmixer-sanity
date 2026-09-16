import { json } from '@sveltejs/kit';
import { authHubFetch, resolveAuthHubFromUrl } from '$lib/server/authhub/hub.js';

/**
 * GET — proxy-download a connector bundle ZIP from the `?env=` Auth Hub.
 * The selector is serviceId with ':' replaced by '.'.
 */
export async function GET({ url, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceId = url.searchParams.get('serviceId');
    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    const selector = serviceId.replaceAll(':', '.');

    try {
        const res = await authHubFetch(hub, `/components/${encodeURIComponent(selector)}`);

        if (!res.ok) {
            return json({ error: `Auth Hub error: ${res.status}` }, { status: res.status });
        }

        const buffer = await res.arrayBuffer();
        return new Response(buffer, {
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${selector}.zip"`
            }
        });
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
