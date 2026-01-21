import { error } from '@sveltejs/kit';
import { getTestRunById } from '$lib/db/test-runs.js';
import { getConnectorById } from '$lib/db/connectors.js';
import { getComponentsByConnector } from '$lib/db/components.js';
import { getE2EFlowsForConnector, isAppmixerConfigured } from '$lib/api/appmixer.js';

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

  // Fetch E2E flows for this connector
  /** @type {Array<{flowId: string, name: string, url: string}>} */
  let e2eFlows = [];
  if (isAppmixerConfigured()) {
    try {
      e2eFlows = await getE2EFlowsForConnector(connector.connector_name);
    } catch (e) {
      console.error('Failed to fetch E2E flows:', e);
    }
  }

  return {
    testRun,
    connector,
    components,
    e2eFlows
  };
}
