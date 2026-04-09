import { env } from '$env/dynamic/private';

/**
 * Check if a user email is an admin.
 * Reads from ADMIN_EMAILS env var (comma-separated list).
 * @param {string|null|undefined} email
 * @returns {boolean}
 */
export function isAdmin(email) {
    if (!email) return false;
    const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    return adminEmails.includes(email.toLowerCase());
}
