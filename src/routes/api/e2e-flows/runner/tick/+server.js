import { json, error } from '@sveltejs/kit';
import { tickPass } from '$lib/server/e2e/runner.js';
import { getInstanceUrl } from '$lib/api/appmixer.js';
import { getRunnerSnapshot } from '$lib/db/e2e.js';

/**
 * POST /api/e2e-flows/runner/tick
 * One runner pass, driven by the page while it is open. Returns the runner snapshot.
 */
export async function POST({ locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  try {
    const result = await tickPass(session.user.email);
    const snapshot = await getRunnerSnapshot(await getInstanceUrl(session.user.email));
    return json({ ...result, snapshot });
  } catch (e) {
    console.error('Runner tick failed:', e);
    throw error(500, e.message || 'Runner tick failed');
  }
}
