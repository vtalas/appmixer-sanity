import { json, error } from '@sveltejs/kit';
import { pipelineRunTrace } from '$lib/server/ops.js';

const RUN_DIR = /^c?\d+-\d{8}-\d{6}$/;

/**
 * GET /api/ops/pipeline-run?dir=<run directory>
 * The trace of one pipeline stage run for /ops: the card move, the dispatcher's run and its
 * hook call, the run on the OpenClaw host, the results it sent back and what the result
 * integration did with them. Loaded when a run is expanded, as it searches the Appmixer log.
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
    return json(await pipelineRunTrace(session.user.email, dir));
  } catch (e) {
    console.error(`Trace of ${dir} failed:`, e);
    throw error(502, /** @type {any} */ (e)?.message || 'Trace failed');
  }
}
