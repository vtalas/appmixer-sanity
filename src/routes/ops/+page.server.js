import { buildOpsOverview } from '$lib/server/ops.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
  const session = await locals.auth();
  return buildOpsOverview(session?.user?.email ?? '');
}
