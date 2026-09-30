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
 * Get all auth hub verification statuses of one Auth Hub environment
 * @param {string} env - Auth Hub environment id (prod, qa)
 * @returns {Promise<Record<string, string>>} serviceId -> status
 */
export async function getAuthHubStatuses(env) {
  const result = await getDb().execute({
    sql: 'SELECT service_id, status FROM authhub_env_status WHERE env = ?',
    args: [env]
  });
  /** @type {Record<string, string>} */
  const statuses = {};
  for (const row of result.rows) {
    statuses[/** @type {string} */ (row.service_id)] = /** @type {string} */ (row.status);
  }
  return statuses;
}

/**
 * Get all auth hub notes of one Auth Hub environment
 * @param {string} env - Auth Hub environment id (prod, qa)
 * @returns {Promise<Record<string, string>>} serviceId -> notes
 */
export async function getAuthHubNotes(env) {
  const result = await getDb().execute({
    sql: `SELECT service_id, notes FROM authhub_env_status
          WHERE env = ? AND notes IS NOT NULL AND notes != ''`,
    args: [env]
  });
  /** @type {Record<string, string>} */
  const notes = {};
  for (const row of result.rows) {
    notes[/** @type {string} */ (row.service_id)] = /** @type {string} */ (row.notes);
  }
  return notes;
}

/**
 * Set notes for a connector
 * @param {string} env - Auth Hub environment id (prod, qa)
 * @param {string} serviceId
 * @param {string} notes
 */
export async function setAuthHubNotes(env, serviceId, notes) {
  await getDb().execute({
    sql: `INSERT INTO authhub_env_status (env, service_id, status, notes, updated_at)
          VALUES (?, ?, 'not_verified', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(env, service_id) DO UPDATE SET notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`,
    args: [env, serviceId, notes]
  });
}

/**
 * Set verification status for a connector
 * @param {string} env - Auth Hub environment id (prod, qa)
 * @param {string} serviceId
 * @param {string} status - 'verified', 'in_progress' or 'not_verified'
 */
export async function setAuthHubStatus(env, serviceId, status) {
  await getDb().execute({
    sql: `INSERT INTO authhub_env_status (env, service_id, status, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(env, service_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP`,
    args: [env, serviceId, status]
  });
}

/**
 * Get label, icon and version of every connector bundle of one Auth Hub environment
 * @param {string} env - Auth Hub environment id (prod, qa)
 * @returns {Promise<Record<string, {label: string|null, icon: string|null, version: string|null}>>}
 */
export async function getAuthHubConnectorInfo(env) {
  const result = await getDb().execute({
    sql: 'SELECT service_id, label, icon, version FROM authhub_connector_info WHERE env = ?',
    args: [env]
  });
  /** @type {Record<string, {label: string|null, icon: string|null, version: string|null}>} */
  const info = {};
  for (const row of result.rows) {
    info[/** @type {string} */ (row.service_id)] = {
      label: /** @type {string|null} */ (row.label),
      icon: /** @type {string|null} */ (row.icon),
      version: /** @type {string|null} */ (row.version)
    };
  }
  return info;
}

/**
 * Store label, icon and version of a connector bundle
 * @param {string} env - Auth Hub environment id (prod, qa)
 * @param {string} serviceId
 * @param {{label?: string|null, icon?: string|null, version?: string|null}} info
 */
export async function setAuthHubConnectorInfo(env, serviceId, info) {
  await getDb().execute({
    sql: `INSERT INTO authhub_connector_info (env, service_id, label, icon, version, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(env, service_id) DO UPDATE SET
            label = excluded.label,
            icon = excluded.icon,
            version = excluded.version,
            updated_at = CURRENT_TIMESTAMP`,
    args: [env, serviceId, info.label || null, info.icon || null, info.version || null]
  });
}

/**
 * Remove the stored bundle info of a connector
 * @param {string} env - Auth Hub environment id (prod, qa)
 * @param {string} serviceId
 */
export async function deleteAuthHubConnectorInfo(env, serviceId) {
  await getDb().execute({
    sql: 'DELETE FROM authhub_connector_info WHERE env = ? AND service_id = ?',
    args: [env, serviceId]
  });
}
