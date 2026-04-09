import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isAdmin } from '$lib/admin.js';

/**
 * POST — upload a ZIP bundle to Auth Hub.
 * Proxies the raw binary to POST /components and returns { ticket }.
 */
export async function POST({ request, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;
    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    try {
        const buffer = await request.arrayBuffer();
        const res = await fetch(`${baseUrl}/components`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/octet-stream'
            },
            body: buffer
        });

        const data = await res.json();
        if (!res.ok) {
            return json({ error: data.message || `Auth Hub error: ${res.status}` }, { status: res.status });
        }
        return json(data); // { ticket }
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}

/**
 * GET — poll upload status by ticket.
 * Proxies GET /components/uploader/{ticket}.
 */
export async function GET({ url, locals }) {
    const session = await locals.auth();
    if (!isAdmin(session?.user?.email)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;
    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    const ticket = url.searchParams.get('ticket');
    if (!ticket) {
        return json({ error: 'ticket is required' }, { status: 400 });
    }

    try {
        const res = await fetch(`${baseUrl}/components/uploader/${encodeURIComponent(ticket)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await res.json();
        if (!res.ok) {
            return json({ error: data.message || `Auth Hub error: ${res.status}` }, { status: res.status });
        }
        return json(data);
    } catch (err) {
        return json({ error: /** @type {Error} */ (err).message }, { status: 500 });
    }
}
