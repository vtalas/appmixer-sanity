import { json, error } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import { compareReleases } from '$lib/server/release/compare.js';
import { releaseConnectors, ReleaseError } from '$lib/server/release/publish.js';

/**
 * GET /api/releases
 * Release branch (appmixer-components master) vs dev (appmixer-connectors):
 * per connector both versions, the release status and the changed files, plus
 * `readiness` — the project status of the PRs each releasable connector ships.
 */
export async function GET({ locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    throw error(401, 'Unauthorized');
  }

  try {
    const comparison = await compareReleases(session.user.email, { readiness: true });
    return json({ ...comparison, readiness: await comparison.readiness });
  } catch (e) {
    console.error('Release comparison failed:', e);
    throw error(500, /** @type {any} */ (e)?.message || 'Release comparison failed');
  }
}

/**
 * POST /api/releases (admin only)
 * Body: { connectors: [{ name, devVersion }], dryRun?: boolean }
 * Commits every connector to the release branch — one commit each, published
 * with a single ref update. `dryRun` returns the planned commits only.
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  const email = session?.user?.email;
  if (!email) {
    throw error(401, 'Unauthorized');
  }
  if (!isAdmin(email)) {
    throw error(403, 'Releasing connectors is limited to admins');
  }

  const body = await request.json().catch(() => null);
  const items = body?.connectors;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.some((item) => typeof item?.name !== 'string' || !item.name)
  ) {
    throw error(400, 'Body must be { connectors: [{ name, devVersion }], dryRun? }');
  }

  try {
    return json(await releaseConnectors(email, items, { dryRun: !!body.dryRun }));
  } catch (e) {
    if (e instanceof ReleaseError) {
      throw error(e.status, e.message);
    }
    console.error('Release failed:', e);
    throw error(500, /** @type {any} */ (e)?.message || 'Release failed');
  }
}
