import { getDb } from './index.js';

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
 * Get a test run by ID
 */
export async function getTestRunById(id) {
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
  return result.rows[0];
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
  return getDb().execute({
    sql: `UPDATE test_runs SET status = ? WHERE id = ?`,
    args: [status, id]
  });
}

/**
 * Delete a test run (cascades to connectors and components)
 */
export async function deleteTestRun(id) {
  // Delete in order due to foreign keys (Turso may not have cascade enabled by default)
  await getDb().execute({ sql: `DELETE FROM components WHERE connector_id IN (SELECT id FROM connectors WHERE test_run_id = ?)`, args: [id] });
  await getDb().execute({ sql: `DELETE FROM connectors WHERE test_run_id = ?`, args: [id] });
  return getDb().execute({ sql: `DELETE FROM test_runs WHERE id = ?`, args: [id] });
}
