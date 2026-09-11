import { getAppmixerSession } from '$lib/api/appmixer.js';

/**
 * The Automation Hub page runs Appmixer's own widget in the browser, so it needs the
 * instance's API URL, its UI URL (where the SDK script is served) and an access token
 * for the caller's Appmixer configuration — per-user Settings, else the env account.
 *
 * The token reaches the browser. That is inherent to embedding the SDK, and the page is
 * behind the app login (hooks.server.js), but it means whoever opens the page acts on
 * the instance as the configured Appmixer user.
 *
 * @type {import('./$types').PageServerLoad}
 */
export async function load({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;

  try {
    const { baseUrl, uiUrl, token } = await getAppmixerSession(userId);
    return { baseUrl, uiUrl, token, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { baseUrl: null, uiUrl: null, token: null, error };
  }
}
