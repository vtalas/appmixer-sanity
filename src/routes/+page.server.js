import { getAllTestRuns } from '$lib/db/test-runs.js';

/** @type {import('./$types').PageServerLoad} */
export async function load() {
  const testRuns = await getAllTestRuns();

  return {
    testRuns
  };
}
