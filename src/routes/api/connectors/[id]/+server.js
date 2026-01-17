import { json } from '@sveltejs/kit';
import { getConnectorById, updateConnectorStatus } from '$lib/db/connectors.js';

/** @type {import('./$types').RequestHandler} */
export async function PATCH({ params, request }) {
  try {
    const { id } = params;
    const { status, blockedReason } = await request.json();

    if (!status || !['pending', 'ok', 'fail', 'blocked'].includes(status)) {
      return json({ error: 'Invalid status' }, { status: 400 });
    }

    const connector = await getConnectorById(id);
    if (!connector) {
      return json({ error: 'Connector not found' }, { status: 404 });
    }

    // If setting to blocked, require a reason
    if (status === 'blocked' && !blockedReason) {
      return json({ error: 'Blocked reason is required' }, { status: 400 });
    }

    await updateConnectorStatus(id, status, status === 'blocked' ? blockedReason : null);

    return json({ success: true });
  } catch (error) {
    console.error('Error updating connector:', error);
    return json({ error: 'Failed to update connector' }, { status: 500 });
  }
}
