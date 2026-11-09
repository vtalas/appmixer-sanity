import { getAllTestRuns } from '$lib/db/test-runs.js';
import testingInstructions from '$lib/testing-instructions.md?raw';

/** @type {import('./$types').PageServerLoad} */
export async function load() {
  const testRuns = await getAllTestRuns();

  return {
    testRuns,
    testingInstructions
  };
}
