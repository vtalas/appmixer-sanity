import { getDb } from './index.js';

/**
 * Get a user setting value by key
 * @param {string} userId
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getUserSetting(userId, key) {
    const result = await getDb().execute({
        sql: 'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
        args: [userId, key]
    });
    return result.rows[0]?.value || null;
}

/**
 * Get multiple user settings by keys
 * @param {string} userId
 * @param {string[]} keys
 * @returns {Promise<Record<string, string>>}
 */
export async function getUserSettings(userId, keys) {
    if (keys.length === 0) return {};

    const placeholders = keys.map(() => '?').join(', ');
    const result = await getDb().execute({
        sql: `SELECT key, value FROM user_settings WHERE user_id = ? AND key IN (${placeholders})`,
        args: [userId, ...keys]
    });

    const settings = {};
    for (const row of result.rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

/**
 * Set a user setting value
 * @param {string} userId
 * @param {string} key
 * @param {string} value
 */
export async function setUserSetting(userId, key, value) {
    await getDb().execute({
        sql: `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        args: [userId, key, value]
    });
}

/**
 * Set multiple user settings at once
 * @param {string} userId
 * @param {Record<string, string>} settings
 */
export async function setUserSettings(userId, settings) {
    const db = getDb();
    for (const [key, value] of Object.entries(settings)) {
        await db.execute({
            sql: `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
            args: [userId, key, value]
        });
    }
}

// Setting keys
export const SETTING_KEYS = {
    GITHUB_REPO_OWNER: 'github_repo_owner',
    GITHUB_REPO_NAME: 'github_repo_name',
    GITHUB_REPO_BRANCH: 'github_repo_branch',
    GITHUB_TOKEN: 'github_token',
    APPMIXER_BASE_URL: 'appmixer_base_url',
    APPMIXER_USERNAME: 'appmixer_username',
    APPMIXER_PASSWORD: 'appmixer_password',
    /** JSON list of the flows /ops shows next to the hub integrations: [{flowId, label, baseUrl, addedAt}] */
    OPS_WATCHED_FLOWS: 'ops_watched_flows'
};
