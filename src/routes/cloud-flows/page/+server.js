import { serveRepoPage } from '$lib/server/repo-page.js';

// The flow diagrams of appmixer-cloud (docs/flows, rendered from docs/flows/src by npm run flows
// and kept true to the code by tests/unit/flows.test.ts there).
const SOURCE = { repo: 'Appmixer-ai/appmixer-cloud', ref: 'master', path: 'docs/flows/index.html' };

/** @type {import('./$types').RequestHandler} */
export function GET(event) {
  return serveRepoPage(event, SOURCE);
}
