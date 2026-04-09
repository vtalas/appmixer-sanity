import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';

/**
 * GET — proxy-download a connector bundle ZIP from Auth Hub.
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

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;
    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    const selector = serviceId.replaceAll(':', '.');

    try {
        const res = await fetch(`${baseUrl}/components/${encodeURIComponent(selector)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

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
