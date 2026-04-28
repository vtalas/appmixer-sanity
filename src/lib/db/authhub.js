import { getDb } from './index.js';

/**
 * Get cached GitHub connector data (oauth2 list + version map)
 * @returns {Promise<{ oauth2: Array<{serviceId: string, path: string}>, versions: Record<string, string> }>}
 */
export async function getGithubOAuthConnectors() {
  const result = await getDb().execute(
    'SELECT service_id, path, github_version, is_oauth2 FROM github_oauth_connectors ORDER BY service_id'
  );
  /** @type {Array<{serviceId: string, path: string}>} */
  const oauth2 = [];
  /** @type {Record<string, string>} */
  const versions = {};
  for (const row of result.rows) {
    const serviceId = /** @type {string} */ (row.service_id);
    if (row.is_oauth2) oauth2.push({ serviceId, path: /** @type {string} */ (row.path) || '' });
    if (row.github_version) versions[serviceId] = /** @type {string} */ (row.github_version);
  }
  return { oauth2, versions };
}

/**
 * Replace all cached GitHub connector data
 * @param {Array<{serviceId: string, path: string, version?: string, isOauth2?: boolean}>} connectors
 */
export async function setGithubOAuthConnectors(connectors) {
  const db = getDb();
  await db.execute('DELETE FROM github_oauth_connectors');
  for (const c of connectors) {
    await db.execute({
      sql: `INSERT INTO github_oauth_connectors (service_id, path, github_version, is_oauth2, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      args: [c.serviceId, c.path || '', c.version || null, c.isOauth2 ? 1 : 0]
    });
  }
}

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
 * Get all auth hub notes
 * @returns {Promise<Record<string, string>>} serviceId -> notes
 */
export async function getAuthHubNotes() {
  const result = await getDb().execute('SELECT service_id, notes FROM authhub_status WHERE notes IS NOT NULL AND notes != \'\'');
  /** @type {Record<string, string>} */
  const notes = {};
  for (const row of result.rows) {
    notes[/** @type {string} */ (row.service_id)] = /** @type {string} */ (row.notes);
  }
  return notes;
}

/**
 * Set notes for a connector
 * @param {string} serviceId
 * @param {string} notes
 */
export async function setAuthHubNotes(serviceId, notes) {
  await getDb().execute({
    sql: `INSERT INTO authhub_status (service_id, status, notes, updated_at)
          VALUES (?, 'not_verified', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(service_id) DO UPDATE SET notes = ?, updated_at = CURRENT_TIMESTAMP`,
    args: [serviceId, notes, notes]
  });
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
