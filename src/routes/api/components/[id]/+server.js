import { json } from '@sveltejs/kit';
import { getComponentById, updateComponentStatus } from '$lib/db/components.js';

/** @type {import('./$types').RequestHandler} */
export async function PATCH({ params, request }) {
  try {
    const { id } = params;
    const { status, githubIssue } = await request.json();

    if (!status || !['pending', 'ok', 'fail'].includes(status)) {
      return json({ error: 'Invalid status' }, { status: 400 });
    }

    const component = await getComponentById(id);
    if (!component) {
      return json({ error: 'Component not found' }, { status: 404 });
    }

    // If setting to fail, github issue is optional but validated if provided
    if (githubIssue && typeof githubIssue === 'string') {
      const githubPattern = /^https:\/\/github\.com\/[\w-]+\/[\w-]+\/issues\/\d+$/;
      if (!githubPattern.test(githubIssue)) {
        return json({ error: 'Invalid GitHub issue URL format' }, { status: 400 });
      }
    }

    await updateComponentStatus(id, status, status === 'fail' ? (githubIssue || null) : null);

    return json({ success: true });
  } catch (error) {
    console.error('Error updating component:', error);
    return json({ error: 'Failed to update component' }, { status: 500 });
  }
}
