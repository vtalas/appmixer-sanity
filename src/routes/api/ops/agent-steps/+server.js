import { json, error } from '@sveltejs/kit';
import { pipelineRunSteps } from '$lib/server/ops.js';

const RUN_DIR = /^c?\d+-\d{8}-\d{6}$/;

/**
 * GET /api/ops/agent-steps?dir=<run directory>
 * Every step of the agent turn of one pipeline run, from the OpenClaw host: the code it ran, the
 * calls that code made with their output, its result, whether it failed and how long it took.
 * `{ steps: null }` when the host keeps no detail file for the run.
 */
export async function GET({ locals, url }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const dir = url.searchParams.get('dir') || '';
  if (!RUN_DIR.test(dir)) {
    throw error(400, 'Invalid dir');
  }

  try {
    const detail = await pipelineRunSteps(dir);
    return json({ dir, steps: detail?.steps ?? null });
  } catch (e) {
    console.error(`Agent steps of ${dir} failed:`, e);
    throw error(502, /** @type {any} */ (e)?.message || 'Agent steps failed');
  }
}
