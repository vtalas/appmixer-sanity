import { json } from '@sveltejs/kit';
import { startFlow } from '$lib/api/appmixer.js';

/**
 * Start a flow on Appmixer
 * POST /api/e2e-flows/start
 * Body: { flowId: string }
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { flowId } = await request.json();

    if (!flowId) {
      return json({ error: 'flowId is required' }, { status: 400 });
    }

    const result = await startFlow(session.user.email, flowId);
    return json({ success: true, result });
  } catch (error) {
    console.error('Failed to start flow:', error);
    return json({ error: error.message }, { status: 500 });
  }
}
