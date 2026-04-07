import { getDb } from './index.js';

/**
 * Get all auth hub verification statuses
 * @returns {Promise<Record<string, string>>} serviceId -> status
 */
export async function getAuthHubStatuses() {
  const result = await getDb().execute('SELECT service_id, status FROM authhub_status');
  /** @type {Record<string, string>} */
  const statuses = {};
  for (const row of result.rows) {
    statuses[/** @type {string} */ (row.service_id)] = /** @type {string} */ (row.status);
  }
  return statuses;
}

/**
 * Set verification status for a connector
 * @param {string} serviceId
 * @param {string} status - 'verified' or 'not_verified'
 */
export async function setAuthHubStatus(serviceId, status) {
  await getDb().execute({
    sql: `INSERT INTO authhub_status (service_id, status, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(service_id) DO UPDATE SET status = ?, updated_at = CURRENT_TIMESTAMP`,
    args: [serviceId, status, status]
  });
}
