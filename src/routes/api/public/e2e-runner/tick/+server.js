import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { tickPass, tickLoop } from '$lib/server/e2e/runner.js';
import { scanE2EFlows } from '$lib/server/e2e/scan.js';
import { getE2EFlows, enqueueRuns } from '$lib/db/e2e.js';
import { getInstanceUrl } from '$lib/api/appmixer.js';

// Leave margin below the serverless function limit (300s on Vercel)
const DEFAULT_BUDGET_MS = 250_000;

/**
 * GET /api/public/e2e-runner/tick
 * Cron entrypoint (no session — authenticated via CRON_SECRET, uses env
 * Appmixer/GitHub credentials).
 *
 * Query params:
 * - scan=1      refresh the e2e_flows cache from GitHub + instance first
 * - schedule=1  enqueue all deployed flows that have no result from the last 20h
 * - loop=1      keep ticking until the queue drains or the time budget runs out
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends when the
 * CRON_SECRET env var is set) or `?secret=<CRON_SECRET>`.
 */
export async function GET({ request, url }) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    throw error(503, 'CRON_SECRET is not configured');
  }

  const authHeader = request.headers.get('authorization') || '';
  const provided = authHeader.replace(/^Bearer\s+/i, '') || url.searchParams.get('secret') || '';
  if (provided !== secret) {
    throw error(401, 'Unauthorized');
  }

  // Cron runs without a session — null user means env credentials
  const userId = null;

  try {
    let enqueued = 0;
    let scan = null;

    if (url.searchParams.get('scan') === '1') {
      scan = await scanE2EFlows(userId);
    }

    if (url.searchParams.get('schedule') === '1') {
      const staleBefore = Date.now() - 20 * 60 * 60 * 1000;
      const flows = await getE2EFlows(await getInstanceUrl(userId));
      const due = flows.filter((f) => {
        if (!f.flowId) return false;
        if (!f.lastResultAt) return true;
        const at = new Date(f.lastResultAt).getTime();
        return !Number.isFinite(at) || at < staleBefore;
      });
      const result = await enqueueRuns(
        await getInstanceUrl(userId),
        due.map((f) => f.flowName),
        'cron'
      );
      enqueued = result.enqueued;
    }

    const result =
      url.searchParams.get('loop') === '1'
        ? await tickLoop(userId, DEFAULT_BUDGET_MS)
        : await tickPass(userId);

    return json({ scan, enqueued, ...result });
  } catch (e) {
    console.error('Cron runner tick failed:', e);
    throw error(500, e.message || 'Cron tick failed');
  }
}
