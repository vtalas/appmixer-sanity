import { getDb } from './index.js';
import { recalculateConnectorStatus } from './connectors.js';

/**
 * Get all components for a connector
 */
export async function getComponentsByConnector(connectorId) {
  const result = await getDb().execute({
    sql: `
      SELECT * FROM components
      WHERE connector_id = ?
      ORDER BY component_name
    `,
    args: [connectorId]
  });
  return result.rows;
}

/**
 * Get a component by ID
 */
export async function getComponentById(id) {
  const result = await getDb().execute({
    sql: `SELECT * FROM components WHERE id = ?`,
    args: [id]
  });
  return result.rows[0];
}

/**
 * Add a component to a connector
 */
export async function addComponentToConnector({
  id,
  connectorId,
  componentName,
  label,
  description,
  icon,
  version,
  isPrivate
}) {
  return getDb().execute({
    sql: `
      INSERT INTO components (id, connector_id, component_name, label, description, icon, version, is_private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [id, connectorId, componentName, label, description, icon, version, isPrivate ? 1 : 0]
  });
}

/**
 * Update component status
 */
export async function updateComponentStatus(id, status, githubIssue = null) {
  const now = new Date().toISOString();
  await getDb().execute({
    sql: `UPDATE components SET status = ?, github_issue = ?, tested_at = ? WHERE id = ?`,
    args: [status, githubIssue, now, id]
  });

  // Get the connector ID and recalculate its status
  const result = await getDb().execute({
    sql: 'SELECT connector_id FROM components WHERE id = ?',
    args: [id]
  });
  const component = result.rows[0];
  if (component) {
    await recalculateConnectorStatus(component.connector_id);
  }
}

/**
 * Batch insert components (for test run creation)
 */
export async function batchInsertComponents(components) {
  for (const c of components) {
    await getDb().execute({
      sql: `
        INSERT INTO components (id, connector_id, component_name, label, description, icon, version, is_private)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [c.id, c.connectorId, c.componentName, c.label, c.description, c.icon, c.version, c.isPrivate ? 1 : 0]
    });
  }
}
