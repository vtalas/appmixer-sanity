import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export async function GET() {
    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;

    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    try {
        const res = await fetch(`${baseUrl}/service-config`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!res.ok) {
            const text = await res.text();
            return json({ error: `Auth Hub API error: ${res.status} ${text}` }, { status: res.status });
        }

        const data = await res.json();
        return json(data);
    } catch (err) {
        return json({ error: `Failed to connect to Auth Hub: ${err.message}` }, { status: 500 });
    }
}
