import { getDb } from './index.js';
import { nanoid } from 'nanoid';

// All cache/queue data is scoped by `instanceUrl` — the normalized Appmixer base
// URL of the caller's configuration. Different users (and the env-credential cron)
// may target different instances and must never see or overwrite each other's rows.

/**
 * Get all cached E2E flows of one instance
 * @param {string} instanceUrl
 * @returns {Promise<Array<any>>}
 */
export async function getE2EFlows(instanceUrl) {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM e2e_flows WHERE instance_url = ? ORDER BY connector, flow_name`,
    args: [instanceUrl]
  });
  return result.rows.map(rowToFlow);
}

/** @param {any} row */
function rowToFlow(row) {
  return {
    flowName: row.flow_name,
    connector: row.connector,
    githubPath: row.github_path,
    githubSha: row.github_sha,
    githubHash: row.github_hash,
    githubUrl: row.github_url,
    flowId: row.flow_id,
    stage: row.stage,
    serverMtime: row.server_mtime,
    syncStatus: row.sync_status,
    lastResult: row.last_result,
    lastResultAt: row.last_result_at,
    lastResultDetail: safeParse(row.last_result_detail),
    accountAvailable: row.account_available == null ? null : Boolean(row.account_available),
    updatedAt: row.updated_at
  };
}

/** @param {any} value */
function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Replace the e2e_flows cache of one instance with a fresh scan result.
 * @param {string} instanceUrl
 * @param {Array<any>} flows - Objects in the same shape as rowToFlow output
 */
export async function replaceE2EFlows(instanceUrl, flows) {
  const db = getDb();
  /** @type {Array<{sql: string, args: Array<any>}>} */
  const statements = [{ sql: `DELETE FROM e2e_flows WHERE instance_url = ?`, args: [instanceUrl] }];

  for (const f of flows) {
    statements.push({
      sql: `INSERT OR REPLACE INTO e2e_flows
        (instance_url, flow_name, connector, github_path, github_sha, github_hash, github_url,
         flow_id, stage, server_mtime, sync_status, last_result, last_result_at, last_result_detail,
         account_available, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      args: [
        instanceUrl,
        f.flowName,
        f.connector ?? null,
        f.githubPath ?? null,
        f.githubSha ?? null,
        f.githubHash ?? null,
        f.githubUrl ?? null,
        f.flowId ?? null,
        f.stage ?? null,
        f.serverMtime ?? null,
        f.syncStatus ?? null,
        f.lastResult ?? null,
        f.lastResultAt ?? null,
        f.lastResultDetail ? JSON.stringify(f.lastResultDetail) : null,
        f.accountAvailable == null ? null : f.accountAvailable ? 1 : 0
      ]
    });
  }

  await db.batch(statements, 'write');
}

/**
 * Update the last run result for a flow
 * @param {string} instanceUrl
 * @param {string} flowName
 * @param {{result: string, at: string, detail?: Object}} data
 */
export async function updateFlowResult(instanceUrl, flowName, { result, at, detail }) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE e2e_flows
      SET last_result = ?, last_result_at = ?, last_result_detail = ?, updated_at = CURRENT_TIMESTAMP
      WHERE instance_url = ? AND flow_name = ?`,
    args: [result, at, detail ? JSON.stringify(detail) : null, instanceUrl, flowName]
  });
}

/**
 * Update stage of a flow in the cache
 * @param {string} instanceUrl
 * @param {string} flowName
 * @param {string} stage
 */
export async function updateFlowStage(instanceUrl, flowName, stage) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE e2e_flows SET stage = ? WHERE instance_url = ? AND flow_name = ?`,
    args: [stage, instanceUrl, flowName]
  });
}

/**
 * Update stage of a flow in the cache by its instance flow id
 * @param {string} instanceUrl
 * @param {string} flowId
 * @param {string} stage
 */
export async function updateFlowStageByFlowId(instanceUrl, flowId, stage) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE e2e_flows SET stage = ? WHERE instance_url = ? AND flow_id = ?`,
    args: [stage, instanceUrl, flowId]
  });
}

/**
 * Mark a flow as no longer deployed (after deleting it from the instance).
 * Rows that only existed on the server are removed entirely.
 * @param {string} instanceUrl
 * @param {string} flowId
 */
export async function markFlowUndeployed(instanceUrl, flowId) {
  const db = getDb();
  await db.execute({
    sql: `DELETE FROM e2e_flows WHERE instance_url = ? AND flow_id = ? AND github_path IS NULL`,
    args: [instanceUrl, flowId]
  });
  await db.execute({
    sql: `UPDATE e2e_flows
      SET flow_id = NULL, stage = NULL, server_mtime = NULL, sync_status = 'not_deployed'
      WHERE instance_url = ? AND flow_id = ?`,
    args: [instanceUrl, flowId]
  });
}

/**
 * Enqueue runs for flows. Flows that already have a queued or running run are skipped.
 * @param {string} instanceUrl
 * @param {Array<string>} flowNames
 * @param {string} triggeredBy
 * @returns {Promise<{enqueued: number, skipped: number}>}
 */
export async function enqueueRuns(instanceUrl, flowNames, triggeredBy) {
  const db = getDb();

  const active = await db.execute({
    sql: `SELECT flow_name FROM e2e_runs WHERE instance_url = ? AND state IN ('queued', 'running')`,
    args: [instanceUrl]
  });
  const activeNames = new Set(active.rows.map((/** @type {any} */ r) => r.flow_name));

  const statements = [];
  let enqueued = 0;
  let skipped = 0;

  for (const name of flowNames) {
    if (activeNames.has(name)) {
      skipped++;
      continue;
    }
    activeNames.add(name);
    enqueued++;
    statements.push({
      sql: `INSERT INTO e2e_runs (id, instance_url, flow_name, state, triggered_by) VALUES (?, ?, ?, 'queued', ?)`,
      args: [nanoid(), instanceUrl, name, triggeredBy || null]
    });
  }

  if (statements.length > 0) {
    await db.batch(statements, 'write');
  }

  return { enqueued, skipped };
}

/**
 * Atomically claim up to `limit` queued runs (oldest first) by flipping them to 'running'.
 * @param {string} instanceUrl
 * @param {number} limit
 * @returns {Promise<Array<any>>} claimed run rows
 */
export async function claimQueuedRuns(instanceUrl, limit) {
  if (limit <= 0) return [];
  const db = getDb();
  const result = await db.execute({
    sql: `UPDATE e2e_runs
      SET state = 'running', started_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id FROM e2e_runs WHERE instance_url = ? AND state = 'queued' ORDER BY queued_at LIMIT ?
      )
      RETURNING *`,
    args: [instanceUrl, limit]
  });
  return result.rows.map(rowToRun);
}

/** @param {any} row */
function rowToRun(row) {
  return {
    id: row.id,
    flowName: row.flow_name,
    flowId: row.flow_id,
    state: row.state,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    baselineResultAt: row.baseline_result_at,
    error: row.error,
    detail: safeParse(row.detail),
    triggeredBy: row.triggered_by
  };
}

/**
 * Get all runs currently in 'running' state
 * @param {string} instanceUrl
 */
export async function getRunningRuns(instanceUrl) {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM e2e_runs WHERE instance_url = ? AND state = 'running' ORDER BY started_at`,
    args: [instanceUrl]
  });
  return result.rows.map(rowToRun);
}

/**
 * Update a claimed run with the flow it maps to and the result baseline
 * @param {string} runId
 * @param {{flowId?: string|null, baselineResultAt?: string|null}} data
 */
export async function markRunStarted(runId, { flowId, baselineResultAt }) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE e2e_runs SET flow_id = ?, baseline_result_at = ? WHERE id = ?`,
    args: [flowId ?? null, baselineResultAt ?? null, runId]
  });
}

/**
 * Finish a run
 * @param {string} runId
 * @param {string} state - passed | failed | timeout | error | cancelled
 * @param {{error?: string, detail?: Object}} [data]
 */
export async function finishRun(runId, state, { error, detail } = {}) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE e2e_runs
      SET state = ?, finished_at = CURRENT_TIMESTAMP, error = ?, detail = ?
      WHERE id = ?`,
    args: [state, error ?? null, detail ? JSON.stringify(detail) : null, runId]
  });
}

/**
 * Cancel all queued runs of one instance
 * @param {string} instanceUrl
 * @returns {Promise<number>} number of cancelled runs
 */
export async function cancelQueuedRuns(instanceUrl) {
  const db = getDb();
  const result = await db.execute({
    sql: `UPDATE e2e_runs SET state = 'cancelled', finished_at = CURRENT_TIMESTAMP
      WHERE instance_url = ? AND state = 'queued'`,
    args: [instanceUrl]
  });
  return result.rowsAffected;
}

/**
 * Runner snapshot: queue counts, active runs, and recent history
 * @param {string} instanceUrl
 */
export async function getRunnerSnapshot(instanceUrl) {
  const db = getDb();

  const [counts, running, queued, recent] = await Promise.all([
    db.execute({
      sql: `SELECT state, COUNT(*) as count FROM e2e_runs WHERE instance_url = ? GROUP BY state`,
      args: [instanceUrl]
    }),
    db.execute({
      sql: `SELECT * FROM e2e_runs WHERE instance_url = ? AND state = 'running' ORDER BY started_at`,
      args: [instanceUrl]
    }),
    db.execute({
      sql: `SELECT * FROM e2e_runs WHERE instance_url = ? AND state = 'queued' ORDER BY queued_at LIMIT 500`,
      args: [instanceUrl]
    }),
    db.execute({
      sql: `SELECT * FROM e2e_runs WHERE instance_url = ? AND state IN ('passed', 'failed', 'timeout', 'error')
        ORDER BY finished_at DESC LIMIT 30`,
      args: [instanceUrl]
    })
  ]);

  /** @type {Record<string, number>} */
  const stateCounts = {};
  for (const row of counts.rows) {
    stateCounts[row.state] = Number(row.count);
  }

  return {
    counts: stateCounts,
    running: running.rows.map(rowToRun),
    queued: queued.rows.map(rowToRun),
    recent: recent.rows.map(rowToRun)
  };
}

/**
 * Delete finished run history of one instance (keeps queued/running)
 * @param {string} instanceUrl
 */
export async function clearRunHistory(instanceUrl) {
  const db = getDb();
  const result = await db.execute({
    sql: `DELETE FROM e2e_runs WHERE instance_url = ?
      AND state IN ('passed', 'failed', 'timeout', 'error', 'cancelled')`,
    args: [instanceUrl]
  });
  return result.rowsAffected;
}
