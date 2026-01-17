import { json } from '@sveltejs/kit';
import { getTestRunById, updateTestRunStatus, deleteTestRun } from '$lib/db/test-runs.js';

/** @type {import('./$types').RequestHandler} */
export async function PATCH({ params, request }) {
  try {
    const { runId } = params;
    const { status } = await request.json();

    if (!status || !['in_progress', 'completed'].includes(status)) {
      return json({ error: 'Invalid status' }, { status: 400 });
    }

    const testRun = await getTestRunById(runId);
    if (!testRun) {
      return json({ error: 'Test run not found' }, { status: 404 });
    }

    await updateTestRunStatus(runId, status);

    return json({ success: true });
  } catch (error) {
    console.error('Error updating test run:', error);
    return json({ error: 'Failed to update test run' }, { status: 500 });
  }
}

/** @type {import('./$types').RequestHandler} */
export async function DELETE({ params }) {
  try {
    const { runId } = params;

    const testRun = await getTestRunById(runId);
    if (!testRun) {
      return json({ error: 'Test run not found' }, { status: 404 });
    }

    await deleteTestRun(runId);

    return json({ success: true });
  } catch (error) {
    console.error('Error deleting test run:', error);
    return json({ error: 'Failed to delete test run' }, { status: 500 });
  }
}
