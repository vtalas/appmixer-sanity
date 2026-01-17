import { getDb } from './index.js';

/**
 * Get all connectors for a test run
 */
export async function getConnectorsByTestRun(testRunId) {
  const result = await getDb().execute({
    sql: `
      SELECT
        c.*,
        (SELECT COUNT(*) FROM components WHERE connector_id = c.id) as component_count,
        (SELECT COUNT(*) FROM components WHERE connector_id = c.id AND status = 'ok') as ok_count,
        (SELECT COUNT(*) FROM components WHERE connector_id = c.id AND status = 'fail') as fail_count
      FROM connectors c
      WHERE c.test_run_id = ?
      ORDER BY c.connector_name
    `,
    args: [testRunId]
  });
  return result.rows;
}

/**
 * Get a connector by ID
 */
export async function getConnectorById(id) {
  const result = await getDb().execute({
    sql: `
      SELECT
        c.*,
        (SELECT COUNT(*) FROM components WHERE connector_id = c.id) as component_count,
        (SELECT COUNT(*) FROM components WHERE connector_id = c.id AND status = 'ok') as ok_count,
        (SELECT COUNT(*) FROM components WHERE connector_id = c.id AND status = 'fail') as fail_count
      FROM connectors c
      WHERE c.id = ?
    `,
    args: [id]
  });
  return result.rows[0];
}

/**
 * Add a connector to a test run
 */
export async function addConnectorToRun({
  id,
  testRunId,
  connectorName,
  version,
  label,
  description,
  icon
}) {
  return getDb().execute({
    sql: `
      INSERT INTO connectors (id, test_run_id, connector_name, version, label, description, icon)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [id, testRunId, connectorName, version, label, description, icon]
  });
}

/**
 * Update connector status
 */
export async function updateConnectorStatus(id, status, blockedReason = null) {
  return getDb().execute({
    sql: `UPDATE connectors SET status = ?, blocked_reason = ? WHERE id = ?`,
    args: [status, blockedReason, id]
  });
}

/**
 * Recalculate connector status based on component statuses
 */
export async function recalculateConnectorStatus(connectorId) {
  const statsResult = await getDb().execute({
    sql: `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_count,
        SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as fail_count
      FROM components
      WHERE connector_id = ?
    `,
    args: [connectorId]
  });
  const stats = statsResult.rows[0];

  let newStatus = 'pending';
  if (stats.fail_count > 0) {
    newStatus = 'fail';
  } else if (stats.ok_count === stats.total && stats.total > 0) {
    newStatus = 'ok';
  }

  // Only update if not blocked (blocked is manual)
  const connectorResult = await getDb().execute({
    sql: 'SELECT status FROM connectors WHERE id = ?',
    args: [connectorId]
  });
  const connector = connectorResult.rows[0];

  if (connector && connector.status !== 'blocked') {
    await getDb().execute({
      sql: 'UPDATE connectors SET status = ? WHERE id = ?',
      args: [newStatus, connectorId]
    });
  }

  return newStatus;
}
