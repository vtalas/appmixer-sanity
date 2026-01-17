import { error } from '@sveltejs/kit';
import { getTestRunById } from '$lib/db/test-runs.js';
import { getConnectorsByTestRun } from '$lib/db/connectors.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ params }) {
  const testRun = await getTestRunById(params.runId);

  if (!testRun) {
    throw error(404, 'Test run not found');
  }

  const connectors = await getConnectorsByTestRun(params.runId);

  return {
    testRun,
    connectors
  };
}
