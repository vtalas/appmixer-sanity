import { error } from '@sveltejs/kit';
import { getGitHubConfig } from '$lib/api/github.js';

// The automation map is generated in appmixer-components (docs/automations, node check.mjs --write);
// this route serves that page as it is, so the map here is always the one in the repository.
// Until https://github.com/Appmixer-ai/appmixer-components/pull/3034 is merged it lives on the PR
// head; then switch AUTOMATIONS_REF to 'dev'.
const AUTOMATIONS_REPO = 'Appmixer-ai/appmixer-components';
const AUTOMATIONS_REF = 'refs/pull/3034/head';
const PATH = 'docs/automations/index.html';
const TTL_MS = 5 * 60 * 1000;

let cache = { at: 0, html: '' };

/** @type {import('./$types').RequestHandler} */
export async function GET({ locals, url }) {
  const fresh = url.searchParams.has('refresh');
  if (fresh || !cache.html || Date.now() - cache.at > TTL_MS) {
    const session = await locals.auth();
    const { token } = await getGitHubConfig(session?.user?.email);
    const res = await fetch(
      `https://api.github.com/repos/${AUTOMATIONS_REPO}/contents/${PATH}?ref=${encodeURIComponent(AUTOMATIONS_REF)}`,
      {
        headers: {
          Accept: 'application/vnd.github.raw',
          'User-Agent': 'appmixer-sanity-check',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }
    );
    if (!res.ok) {
      // A stale copy beats an error page; without one, say what failed
      if (!cache.html) {
        error(
          res.status === 404 ? 404 : 502,
          `GitHub answered ${res.status} for ${PATH} at ${AUTOMATIONS_REF} (the token needs read access to ${AUTOMATIONS_REPO})`
        );
      }
    } else {
      cache = { at: Date.now(), html: await res.text() };
    }
  }
  return new Response(cache.html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=60' }
  });
}
