import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import { authHubFetch, resolveAuthHubFromUrl } from '$lib/server/authhub/hub.js';

/**
 * DELETE — remove a connector's service config and bundle from the `?env=` Auth Hub.
 */
export async function DELETE({ request, url, locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;

    if (!isAdmin(userId)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    const { serviceId } = await request.json();
    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }

    const selector = serviceId.replaceAll(':', '.');
    const errors = [];

    // Delete service config
    const configRes = await authHubFetch(hub, `/service-config/${encodeURIComponent(serviceId)}`, {
        method: 'DELETE'
    });
    if (!configRes.ok && configRes.status !== 404) {
        const text = await configRes.text();
        errors.push(`service-config: ${configRes.status} ${text}`);
    }

    // Delete bundle
    const bundleRes = await authHubFetch(hub, `/components/${encodeURIComponent(selector)}`, {
        method: 'DELETE'
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
