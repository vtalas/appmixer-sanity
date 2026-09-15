import {
  getAppmixerSession,
  findCategoryByName,
  listCategoryTemplates
} from '$lib/api/appmixer.js';

// Template category the page opens on: the integrations this app runs on (the GitHub
// responders). The instance is shared, so the unfiltered hub lists every template
// anyone published there.
const HUB_CATEGORY = 'appmixer-sanity-hub';

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
    // No such category (another instance) means the unfiltered hub, not an error.
    const category = await findCategoryByName(userId, HUB_CATEGORY).catch(() => null);
    // Designer links for the category's templates. A failed lookup is shown in place of
    // the list rather than failing the page.
    /** @type {Awaited<ReturnType<typeof listCategoryTemplates>>} */
    let templates = [];
    /** @type {string | null} */
    let templatesError = null;
    if (category) {
      templates = await listCategoryTemplates(userId, category.id).catch((err) => {
        templatesError = err instanceof Error ? err.message : String(err);
        return [];
      });
    }
    return { baseUrl, uiUrl, token, category, templates, templatesError, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      baseUrl: null,
      uiUrl: null,
      token: null,
      category: null,
      templates: [],
      templatesError: null,
      error
    };
  }
}
