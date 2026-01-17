import { error } from '@sveltejs/kit';
import { getTestRunById } from '$lib/db/test-runs.js';
import { getConnectorById } from '$lib/db/connectors.js';
import { getComponentsByConnector } from '$lib/db/components.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ params }) {
  const testRun = await getTestRunById(params.runId);
  if (!testRun) {
    throw error(404, 'Test run not found');
  }

  const connector = await getConnectorById(params.connectorId);
  if (!connector) {
    throw error(404, 'Connector not found');
  }

  const components = await getComponentsByConnector(params.connectorId);

  return {
    testRun,
    connector,
    components
  };
}
