import { json, error } from '@sveltejs/kit';
import { getE2EFlows } from '$lib/db/e2e.js';
import { getInstanceUrl } from '$lib/api/appmixer.js';
import { ensureE2EStores, uploadFlowToInstance } from '$lib/server/e2e/upload.js';

/**
 * POST /api/e2e-flows/upload
 * Upload (import) GitHub test-flows to the instance — create or update by identity.
 * Body: { flowNames: string[] }. The client sends flows one at a time for progress.
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const userId = session.user.email;

  try {
    const { flowNames } = await request.json();

    if (!Array.isArray(flowNames) || flowNames.length === 0) {
      throw error(400, 'flowNames array is required');
    }

    const flows = await getE2EFlows(await getInstanceUrl(userId));
    const byName = new Map(flows.map((f) => [f.flowName, f]));
    const storeIds = await ensureE2EStores(userId);

    const results = [];
    for (const name of flowNames) {
      const cached = byName.get(name);
      if (!cached) {
        results.push({ flowName: name, error: 'Flow not found in cache (run a Scan first)' });
        continue;
      }
      if (!cached.githubPath) {
        results.push({ flowName: name, error: 'Flow has no GitHub file' });
        continue;
      }

      try {
        const result = await uploadFlowToInstance(userId, cached, storeIds);
        results.push({ flowName: name, ...result });
      } catch (e) {
        console.error(`Failed to upload flow "${name}":`, e);
        results.push({ flowName: name, error: /** @type {any} */ (e)?.message || 'Upload failed' });
      }
    }

    return json({ results });
  } catch (e) {
    if (/** @type {any} */ (e)?.status) throw e;
    console.error('Upload failed:', e);
    throw error(500, /** @type {any} */ (e)?.message || 'Upload failed');
  }
}
