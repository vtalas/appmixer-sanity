import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { isAdmin } from '$lib/admin.js';

export async function DELETE({ request, locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;

    if (!isAdmin(userId)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { serviceId } = await request.json();
    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;

    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    const headers = { 'Authorization': `Bearer ${token}` };
    const selector = serviceId.replaceAll(':', '.');
    const errors = [];

    // Delete service config
    const configRes = await fetch(`${baseUrl}/service-config/${encodeURIComponent(serviceId)}`, {
        method: 'DELETE',
        headers
    });
    if (!configRes.ok && configRes.status !== 404) {
        const text = await configRes.text();
        errors.push(`service-config: ${configRes.status} ${text}`);
    }

    // Delete bundle
    const bundleRes = await fetch(`${baseUrl}/components/${encodeURIComponent(selector)}`, {
        method: 'DELETE',
        headers
    });
    if (!bundleRes.ok && bundleRes.status !== 404) {
        const text = await bundleRes.text();
        errors.push(`components: ${bundleRes.status} ${text}`);
    }

    if (errors.length > 0) {
        return json({ error: errors.join('; ') }, { status: 500 });
    }

    return json({ ok: true, serviceId });
}
