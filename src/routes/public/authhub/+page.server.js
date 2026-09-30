import { DEFAULT_AUTH_HUB_ENV } from '$lib/server/authhub/hub.js';
import { getVerifiedServices } from '$lib/server/authhub/report.js';

/**
 * Public customer report of the verified production Auth Hub services.
 *
 * SECURITY: unauthenticated (`/public/` is whitelisted in hooks.server.js).
 * Production only, verified services only, and nothing but their name, id and
 * icon — see getVerifiedServices(). Errors are logged, not shown.
 *
 * @type {import('./$types').PageServerLoad}
 */
export async function load() {
  const generatedAt = new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });

  try {
    return {
      services: await getVerifiedServices(DEFAULT_AUTH_HUB_ENV),
      generatedAt,
      failed: false
    };
  } catch (err) {
    console.error(
      '[public/authhub] Failed to build the report:',
      /** @type {Error} */ (err).message
    );
    return { services: [], generatedAt, failed: true };
  }
}
