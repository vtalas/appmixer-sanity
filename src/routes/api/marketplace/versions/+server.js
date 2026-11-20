import { json } from '@sveltejs/kit';
import { listVersions } from '$lib/server/marketplace.js';

/** GET ?name= — every version the marketplace holds of a connector, newest first. */
export async function GET({ url, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return json({ versions: await listVersions(url.searchParams.get('name') || '') });
  } catch (err) {
    const e = /** @type {any} */ (err);
    return json({ error: e.message }, { status: e.status || 500 });
  }
}
