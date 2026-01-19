import { error } from '@sveltejs/kit';
import { getTestRunById, getTestRunDailyReport } from '$lib/db/test-runs.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ params }) {
  const testRun = await getTestRunById(params.runId);

  if (!testRun) {
    throw error(404, 'Test run not found');
  }

  const report = await getTestRunDailyReport(params.runId);

  return {
    testRun,
    report
  };
}
