import { isAdmin } from '$lib/admin.js';
import { loadCatalogue, loadInstanceState, marketplaceUrl } from '$lib/server/marketplace.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;

  const [catalogue, instance] = await Promise.all([
    loadCatalogue().then(
      (modules) => ({ modules, error: null }),
      (err) => ({ modules: new Map(), error: /** @type {Error} */ (err).message })
    ),
    loadInstanceState(userId)
  ]);

  // Icons stay on the server (2.4 MB of data: URLs) — the page asks for them one by one
  const modules = [...catalogue.modules.values()]
    .map(({ icon, changelog, ...module }) => ({
      ...module,
      hasIcon: Boolean(icon),
      changes: Array.isArray(changelog?.[module.version])
        ? changelog[module.version].map(String)
        : []
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    modules,
    marketplaceError: catalogue.error,
    marketplaceHost: new URL(marketplaceUrl()).host,
    instance,
    isAdmin: isAdmin(userId)
  };
}
