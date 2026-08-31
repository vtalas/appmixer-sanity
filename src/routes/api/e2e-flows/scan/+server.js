import { error } from '@sveltejs/kit';
import { scanE2EFlows } from '$lib/server/e2e/scan.js';

/**
 * POST /api/e2e-flows/scan
 * Full refresh of the e2e_flows cache: GitHub test-flow files (dev branch)
 * merged with instance deployment state and latest run results.
 *
 * Streams NDJSON progress events so the client can render a progress bar:
 *   {"type":"progress","phase":"github","done":12,"total":292}
 *   ...
 *   {"type":"done","summary":{...}}  |  {"type":"error","message":"..."}
 */
export async function POST({ locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  const userId = session.user.email;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      /** @param {any} obj */
      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch {
          // client disconnected — the scan keeps running to completion
        }
      };

      // Throttle progress events: at most one per (phase, ~2% step)
      let lastKey = '';
      /** @param {{phase: string, done?: number, total?: number}} p */
      const onProgress = (p) => {
        const step = p.total ? Math.max(1, Math.floor(p.total / 50)) : 1;
        const key = `${p.phase}:${p.done != null ? Math.floor(p.done / step) : ''}`;
        if (key === lastKey && p.done !== p.total) return;
        lastKey = key;
        send({ type: 'progress', ...p });
      };

      try {
        const summary = await scanE2EFlows(userId, onProgress);
        send({ type: 'done', summary });
      } catch (e) {
        console.error('E2E scan failed:', e);
        send({ type: 'error', message: /** @type {any} */ (e)?.message || 'Scan failed' });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    }
  });
}
