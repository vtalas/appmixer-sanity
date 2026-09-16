import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import { authHubFetch, resolveAuthHubFromUrl, uploadToAuthHub } from '$lib/server/authhub/hub.js';

/**
 * POST — upload a ZIP bundle to the `?env=` Auth Hub.
 * Proxies the raw binary to POST /components and returns { ticket }.
 */
export async function POST({ request, url, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    try {
        return json(await uploadToAuthHub(hub, await request.arrayBuffer())); // { ticket }
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: /** @type {any} */ (err).status || 500 });
    }
}

/**
 * GET — poll upload status by ticket.
 * Proxies GET /components/uploader/{ticket}: `{ started }` while running,
 * then `{ finished, installed }` or `{ finished, err, data }`.
 */
export async function GET({ url, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    const ticket = url.searchParams.get('ticket');
    if (!ticket) {
        return json({ error: 'ticket is required' }, { status: 400 });
    }

    try {
        const res = await authHubFetch(hub, `/components/uploader/${encodeURIComponent(ticket)}`);

        const data = await res.json();
        if (!res.ok) {
            return json({ error: data.message || `Auth Hub error: ${res.status}` }, { status: res.status });
        }
        return json(data);
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
