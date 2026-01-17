import { json } from '@sveltejs/kit';
import { nanoid } from 'nanoid';
import { createTestRun } from '$lib/db/test-runs.js';
import { addConnectorToRun } from '$lib/db/connectors.js';
import { batchInsertComponents } from '$lib/db/components.js';
import { fetchAllConnectorsWithComponents } from '$lib/api/modules.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  try {
    const { name } = await request.json();

    if (!name || typeof name !== 'string') {
      return json({ error: 'Name is required' }, { status: 400 });
    }

    // Create test run record
    const runId = nanoid();
    await createTestRun({ id: runId, name: name.trim() });

    // Fetch all connectors with components from external API
    const connectors = await fetchAllConnectorsWithComponents();

    // Store snapshot in database
    for (const connector of connectors) {
      const connectorId = nanoid();
      await addConnectorToRun({
        id: connectorId,
        testRunId: runId,
        connectorName: connector.name,
        version: connector.version,
        label: connector.label,
        description: connector.description,
        icon: connector.icon
      });

      // Batch insert components for this connector
      if (connector.components.length > 0) {
        const componentsToInsert = connector.components.map((component) => ({
          id: nanoid(),
          connectorId,
          componentName: component.name,
          label: component.label,
          description: component.description,
          icon: component.icon,
          version: component.version,
          isPrivate: component.private
        }));

        await batchInsertComponents(componentsToInsert);
      }
    }

    return json({
      id: runId,
      success: true,
      connectorCount: connectors.length,
      componentCount: connectors.reduce((sum, c) => sum + c.components.length, 0)
    });
  } catch (error) {
    console.error('Error creating test run:', error);
    return json({ error: 'Failed to create test run' }, { status: 500 });
  }
}
