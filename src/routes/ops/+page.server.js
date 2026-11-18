import { buildOpsOverview } from '$lib/server/ops.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals, url }) {
  const session = await locals.auth();
  // ?researchDry=1 shows the batch of a dry test run of the Connector research flow
  return buildOpsOverview(session?.user?.email ?? '', {
    researchDry: url.searchParams.get('researchDry') === '1'
  });
}
