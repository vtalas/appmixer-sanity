import { getAllTestRuns } from '$lib/db/test-runs.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

/** @type {import('./$types').PageServerLoad} */
export async function load() {
  const testRuns = await getAllTestRuns();

  let testingInstructions = '';
  try {
    testingInstructions = await readFile(join(process.cwd(), 'testing-instructions.md'), 'utf-8');
  } catch (e) {
    testingInstructions = '# Testing Instructions\n\nNo testing instructions file found. Create `testing-instructions.md` in the project root.';
  }

  return {
    testRuns,
    testingInstructions
  };
}
