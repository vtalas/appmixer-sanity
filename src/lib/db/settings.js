import { getDb } from './index.js';

/**
 * Get a setting value by key
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function getSetting(key) {
    const result = await getDb().execute({
        sql: 'SELECT value FROM settings WHERE key = ?',
        args: [key]
    });
    return result.rows[0]?.value || null;
}

/**
 * Get multiple settings by keys
 * @param {string[]} keys
 * @returns {Promise<Record<string, string>>}
 */
export async function getSettings(keys) {
    if (keys.length === 0) return {};

    const placeholders = keys.map(() => '?').join(', ');
    const result = await getDb().execute({
        sql: `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
        args: keys
    });

    const settings = {};
    for (const row of result.rows) {
        settings[row.key] = row.value;
    }
    return settings;
}

/**
 * Set a setting value
 * @param {string} key
 * @param {string} value
 */
export async function setSetting(key, value) {
    await getDb().execute({
        sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        args: [key, value]
    });
}

/**
 * Set multiple settings at once
 * @param {Record<string, string>} settings
 */
export async function setSettings(settings) {
    const db = getDb();
    for (const [key, value] of Object.entries(settings)) {
        await db.execute({
            sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
            args: [key, value]
        });
    }
}

// Setting keys
export const SETTING_KEYS = {
    GITHUB_REPO_OWNER: 'github_repo_owner',
    GITHUB_REPO_NAME: 'github_repo_name',
    GITHUB_REPO_BRANCH: 'github_repo_branch',
    GITHUB_TOKEN: 'github_token'
};
