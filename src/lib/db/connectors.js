import { getDb } from './index.js';
import { cache, CACHE_KEYS } from '../cache.js';

/**
 * Get all connectors for a test run (cached)
 */
export async function getConnectorsByTestRun(testRunId) {
  const cacheKey = CACHE_KEYS.connectors(testRunId);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

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

  cache.set(cacheKey, result.rows);
  return result.rows;
}

/**
 * Get a connector by ID (cached)
 */
export async function getConnectorById(id) {
  const cacheKey = CACHE_KEYS.connector(id);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

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

  const connector = result.rows[0];
  if (connector) {
    cache.set(cacheKey, connector);
  }
  return connector;
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
  // Get test_run_id for cache invalidation
  const connector = await getConnectorById(id);
  if (connector) {
    cache.invalidate(CACHE_KEYS.connector(id));
    cache.invalidate(CACHE_KEYS.connectors(connector.test_run_id));
    cache.invalidate(CACHE_KEYS.testRun(connector.test_run_id));
    cache.invalidate(CACHE_KEYS.report(connector.test_run_id));
  }

  return getDb().execute({
    sql: `UPDATE connectors SET status = ?, blocked_reason = ? WHERE id = ?`,
    args: [status, blockedReason, id]
  });
}

/**
 * Update connector notes
 */
export async function updateConnectorNotes(id, notes) {
  cache.invalidate(CACHE_KEYS.connector(id));

  return getDb().execute({
    sql: `UPDATE connectors SET notes = ? WHERE id = ?`,
    args: [notes, id]
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
    sql: 'SELECT status, test_run_id FROM connectors WHERE id = ?',
    args: [connectorId]
  });
  const connector = connectorResult.rows[0];

  if (connector && connector.status !== 'blocked') {
    await getDb().execute({
      sql: 'UPDATE connectors SET status = ? WHERE id = ?',
      args: [newStatus, connectorId]
    });

    // Invalidate caches
    cache.invalidate(CACHE_KEYS.connector(connectorId));
    cache.invalidate(CACHE_KEYS.connectors(connector.test_run_id));
    cache.invalidate(CACHE_KEYS.testRun(connector.test_run_id));
    cache.invalidate(CACHE_KEYS.report(connector.test_run_id));
  }

  return newStatus;
}
