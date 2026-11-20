import { json } from '@sveltejs/kit';
import { loadInstanceState } from '$lib/server/marketplace.js';

/** GET — the configured instance: account, upload rights and installed bundle versions. */
export async function GET({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }
  return json(await loadInstanceState(userId));
}
