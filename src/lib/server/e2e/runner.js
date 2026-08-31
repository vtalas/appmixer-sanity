import { env } from '$env/dynamic/private';
import { startFlow, stopFlow, getInstanceUrl } from '$lib/api/appmixer.js';
import { fetchLatestResults } from './scan.js';
import {
  getE2EFlows,
  getRunningRuns,
  claimQueuedRuns,
  markRunStarted,
  finishRun,
  updateFlowResult,
  updateFlowStage,
  getRunnerSnapshot
} from '$lib/db/e2e.js';

// How many flows may run at once. The whole point of the runner is to never
// start everything at the same time — keep this low.
export function getMaxConcurrent() {
  const value = parseInt(env.E2E_MAX_CONCURRENT || '1', 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

// Per-run completion timeout (same default as `appmixer e2e run`)
export function getRunTimeoutMs() {
  const value = parseInt(env.E2E_RUN_TIMEOUT_SECONDS || '480', 10);
  return (Number.isFinite(value) && value > 0 ? value : 480) * 1000;
}

// SQLite CURRENT_TIMESTAMP is UTC without a timezone suffix
/** @param {any} value */
function parseDbTimestamp(value) {
  if (!value) return null;
  const date = new Date(String(value).includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * @param {any} recordAt
 * @param {any} baselineAt
 */
function isNewerResult(recordAt, baselineAt) {
  if (!recordAt) return false;
  if (!baselineAt) return true;
  return new Date(recordAt).getTime() > new Date(baselineAt).getTime();
}

/**
 * @param {any} userId
 * @param {string} instanceUrl
 * @param {string} flowId
 * @param {string} flowName
 */
async function stopFlowQuietly(userId, instanceUrl, flowId, flowName) {
  try {
    await stopFlow(userId, flowId);
  } catch (e) {
    console.error(`Failed to stop flow ${flowId} (${flowName}):`, e.message);
  }
  try {
    await updateFlowStage(instanceUrl, flowName, 'stopped');
  } catch {
    // cache update is best-effort
  }
}

/**
 * One pass of the runner:
 * 1. finalize running runs (completed result record or timeout → stop flow, record result)
 * 2. start queued runs up to the concurrency cap
 *
 * Completion is detected via the global E2E result stores: a run is done when its
 * test case has a record newer than the baseline captured at start time. This is
 * immune to clock skew and survives serverless restarts.
 *
 * @param {any} userId - session user, or null for cron (env credentials)
 * @returns {Promise<{finalized: number, started: number, running: number, queued: number}>}
 */
export async function tickPass(userId) {
  const instanceUrl = await getInstanceUrl(userId);
  const runningRuns = await getRunningRuns(instanceUrl);
  /** @type {Map<string, any>|null} */
  let resultMap = null;
  let finalized = 0;

  // --- 1. finalize ---
  if (runningRuns.length > 0) {
    try {
      resultMap = await fetchLatestResults(userId);
    } catch (e) {
      console.error('Runner: failed to read result stores:', e.message);
    }

    for (const run of runningRuns) {
      const record = resultMap?.get(run.flowName.toLowerCase().trim());

      if (record && isNewerResult(record.at, run.baselineResultAt)) {
        if (run.flowId) {
          await stopFlowQuietly(userId, instanceUrl, run.flowId, run.flowName);
        }
        await finishRun(run.id, record.result, { detail: record.detail });
        await updateFlowResult(instanceUrl, run.flowName, {
          result: record.result,
          at: record.at,
          detail: record.detail
        });
        finalized++;
        continue;
      }

      const startedAt = parseDbTimestamp(run.startedAt);
      if (startedAt && Date.now() - startedAt.getTime() > getRunTimeoutMs()) {
        if (run.flowId) {
          await stopFlowQuietly(userId, instanceUrl, run.flowId, run.flowName);
        }
        await finishRun(run.id, 'timeout', {
          error: `No result within ${Math.round(getRunTimeoutMs() / 1000)}s`
        });
        finalized++;
      }
    }
  }

  // --- 2. start queued runs up to capacity ---
  const stillRunning = runningRuns.length - finalized;
  const capacity = getMaxConcurrent() - stillRunning;
  const claimed = await claimQueuedRuns(instanceUrl, capacity);
  let started = 0;

  if (claimed.length > 0) {
    const flows = await getE2EFlows(instanceUrl);
    const flowByName = new Map(flows.map((f) => [f.flowName, f]));

    if (!resultMap) {
      try {
        resultMap = await fetchLatestResults(userId);
      } catch (e) {
        console.error('Runner: failed to read result stores for baseline:', e.message);
      }
    }

    for (const run of claimed) {
      const flow = flowByName.get(run.flowName);

      if (!flow?.flowId) {
        await finishRun(run.id, 'error', { error: 'Flow is not deployed on the instance' });
        continue;
      }

      const baseline = resultMap?.get(run.flowName.toLowerCase().trim())?.at ?? null;
      await markRunStarted(run.id, { flowId: flow.flowId, baselineResultAt: baseline });

      try {
        await startFlow(userId, flow.flowId);
        await updateFlowStage(instanceUrl, run.flowName, 'running');
        started++;
      } catch (e) {
        await finishRun(run.id, 'error', { error: `Failed to start flow: ${e.message}` });
      }
    }
  }

  const snapshot = await getRunnerSnapshot(instanceUrl);
  return {
    finalized,
    started,
    running: snapshot.counts.running || 0,
    queued: snapshot.counts.queued || 0
  };
}

/**
 * Run tick passes repeatedly until the queue drains or the time budget runs out.
 * Used by the cron endpoint so one serverless invocation makes real progress.
 * @param {any} userId
 * @param {number} budgetMs
 */
export async function tickLoop(userId, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const POLL_INTERVAL = 10_000;
  let last = await tickPass(userId);

  while (last.running + last.queued > 0 && Date.now() + POLL_INTERVAL < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    last = await tickPass(userId);
  }

  return last;
}
