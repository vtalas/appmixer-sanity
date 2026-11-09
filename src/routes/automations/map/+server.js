import { serveRepoPage } from '$lib/server/repo-page.js';

// The automation map generated in appmixer-components (docs/automations, node check.mjs --write).
// Until https://github.com/Appmixer-ai/appmixer-components/pull/3034 is merged it lives on the PR
// head; then switch the ref to 'dev'.
const SOURCE = {
  repo: 'Appmixer-ai/appmixer-components',
  ref: 'refs/pull/3034/head',
  path: 'docs/automations/index.html'
};

/** @type {import('./$types').RequestHandler} */
export function GET(event) {
  return serveRepoPage(event, SOURCE);
}
