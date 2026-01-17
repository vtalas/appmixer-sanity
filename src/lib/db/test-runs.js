import { getDb } from './index.js';
import { cache, CACHE_KEYS } from '../cache.js';

/**
 * Get all test runs ordered by creation date (newest first)
 */
export async function getAllTestRuns() {
  const result = await getDb().execute(`
    SELECT
      tr.*,
      (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id) as connector_count,
      (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id AND status = 'ok') as ok_count,
      (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id AND status = 'fail') as fail_count,
      (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id AND status = 'blocked') as blocked_count
    FROM test_runs tr
    ORDER BY tr.created_at DESC
  `);
  return result.rows;
}

/**
 * Get a test run by ID (cached)
 */
export async function getTestRunById(id) {
  const cacheKey = CACHE_KEYS.testRun(id);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const result = await getDb().execute({
    sql: `
      SELECT
        tr.*,
        (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id) as connector_count,
        (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id AND status = 'ok') as ok_count,
        (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id AND status = 'fail') as fail_count,
        (SELECT COUNT(*) FROM connectors WHERE test_run_id = tr.id AND status = 'blocked') as blocked_count
      FROM test_runs tr
      WHERE tr.id = ?
    `,
    args: [id]
  });

  const testRun = result.rows[0];
  if (testRun) {
    cache.set(cacheKey, testRun);
  }
  return testRun;
}

/**
 * Create a new test run
 */
export async function createTestRun({ id, name }) {
  return getDb().execute({
    sql: `INSERT INTO test_runs (id, name) VALUES (?, ?)`,
    args: [id, name]
  });
}

/**
 * Update test run status
 */
export async function updateTestRunStatus(id, status) {
  cache.invalidate(CACHE_KEYS.testRun(id));
  return getDb().execute({
    sql: `UPDATE test_runs SET status = ? WHERE id = ?`,
    args: [status, id]
  });
}

/**
 * Delete a test run (cascades to connectors and components)
 */
export async function deleteTestRun(id) {
  // Invalidate all related caches
  cache.invalidate(CACHE_KEYS.testRun(id));
  cache.invalidate(CACHE_KEYS.connectors(id));
  cache.invalidate(CACHE_KEYS.report(id));
  cache.invalidatePrefix(`connector:`);
  cache.invalidatePrefix(`components:`);

  // Delete in order due to foreign keys (Turso may not have cascade enabled by default)
  await getDb().execute({ sql: `DELETE FROM components WHERE connector_id IN (SELECT id FROM connectors WHERE test_run_id = ?)`, args: [id] });
  await getDb().execute({ sql: `DELETE FROM connectors WHERE test_run_id = ?`, args: [id] });
  return getDb().execute({ sql: `DELETE FROM test_runs WHERE id = ?`, args: [id] });
}

/**
 * Get daily testing report for a test run (cached)
 */
export async function getTestRunDailyReport(testRunId) {
  const cacheKey = CACHE_KEYS.report(testRunId);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Get daily component stats
  const componentStats = await getDb().execute({
    sql: `
      SELECT
        DATE(comp.tested_at) as date,
        COUNT(*) as components_tested,
        SUM(CASE WHEN comp.status = 'ok' THEN 1 ELSE 0 END) as components_ok,
        SUM(CASE WHEN comp.status = 'fail' THEN 1 ELSE 0 END) as components_fail
      FROM components comp
      JOIN connectors conn ON comp.connector_id = conn.id
      WHERE conn.test_run_id = ? AND comp.tested_at IS NOT NULL
      GROUP BY DATE(comp.tested_at)
      ORDER BY date ASC
    `,
    args: [testRunId]
  });

  // Get daily connector completion stats (connector is "tested" when all its components are tested)
  const connectorStats = await getDb().execute({
    sql: `
      SELECT
        DATE(last_tested) as date,
        COUNT(*) as connectors_completed,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as connectors_ok,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as connectors_fail,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as connectors_blocked
      FROM (
        SELECT
          conn.id,
          conn.status,
          MAX(comp.tested_at) as last_tested
        FROM connectors conn
        JOIN components comp ON comp.connector_id = conn.id
        WHERE conn.test_run_id = ?
          AND conn.status != 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM components c2
            WHERE c2.connector_id = conn.id AND c2.status = 'pending'
          )
        GROUP BY conn.id, conn.status
      )
      WHERE last_tested IS NOT NULL
      GROUP BY DATE(last_tested)
      ORDER BY date ASC
    `,
    args: [testRunId]
  });

  // Get overall totals
  const totals = await getDb().execute({
    sql: `
      SELECT
        (SELECT COUNT(*) FROM connectors WHERE test_run_id = ?) as total_connectors,
        (SELECT COUNT(*) FROM connectors WHERE test_run_id = ? AND status != 'pending') as tested_connectors,
        (SELECT COUNT(*) FROM components WHERE connector_id IN (SELECT id FROM connectors WHERE test_run_id = ?)) as total_components,
        (SELECT COUNT(*) FROM components WHERE connector_id IN (SELECT id FROM connectors WHERE test_run_id = ?) AND status != 'pending') as tested_components
    `,
    args: [testRunId, testRunId, testRunId, testRunId]
  });

  const report = {
    dailyComponents: componentStats.rows,
    dailyConnectors: connectorStats.rows,
    totals: totals.rows[0]
  };

  cache.set(cacheKey, report, 2 * 60 * 1000); // Cache for 2 minutes
  return report;
}
