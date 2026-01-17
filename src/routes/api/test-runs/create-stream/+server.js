import { nanoid } from 'nanoid';
import { createTestRun } from '$lib/db/test-runs.js';
import { addConnectorToRun } from '$lib/db/connectors.js';
import { batchInsertComponents } from '$lib/db/components.js';
import { fetchAllConnectors, fetchComponentsForConnector } from '$lib/api/modules.js';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  const { name } = await request.json();

  if (!name || typeof name !== 'string') {
    return new Response(JSON.stringify({ error: 'Name is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Step 1: Create test run
        const runId = nanoid();
        send({ step: 'init', message: 'Creating test run...' });
        await createTestRun({ id: runId, name: name.trim() });

        // Step 2: Fetch connectors list
        send({ step: 'fetching', message: 'Fetching connectors from API...' });
        const connectors = await fetchAllConnectors();
        const total = connectors.length;
        send({ step: 'fetched', message: `Found ${total} connectors`, total });

        // Step 3: Process each connector
        let completed = 0;
        let totalComponents = 0;
        const BATCH_SIZE = 5;

        for (let i = 0; i < connectors.length; i += BATCH_SIZE) {
          const batch = connectors.slice(i, i + BATCH_SIZE);

          await Promise.all(
            batch.map(async (connector) => {
              const connectorId = nanoid();

              // Fetch components for this connector
              let components = [];
              try {
                components = await fetchComponentsForConnector(connector.name, connector.version);
              } catch (error) {
                console.error(`Error fetching components for ${connector.name}:`, error);
              }

              // Insert connector
              await addConnectorToRun({
                id: connectorId,
                testRunId: runId,
                connectorName: connector.name,
                version: connector.version,
                label: connector.label,
                description: connector.description,
                icon: connector.icon
              });

              // Insert components
              if (components.length > 0) {
                const componentsToInsert = components.map((component) => ({
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
                totalComponents += components.length;
              }

              completed++;
              send({
                step: 'progress',
                completed,
                total,
                current: connector.label || connector.name,
                componentCount: components.length
              });
            })
          );
        }

        // Done
        send({
          step: 'done',
          id: runId,
          connectorCount: total,
          componentCount: totalComponents
        });
      } catch (error) {
        console.error('Error creating test run:', error);
        send({ step: 'error', message: error.message || 'Failed to create test run' });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  });
}
