import { error } from '@sveltejs/kit';
import { getGitHubConfig } from '$lib/api/github.js';

const TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { at: number, html: string }>} */
const cache = new Map();

/**
 * Serves a self-contained HTML page kept in a repository (a generated diagram page) as it is,
 * read through the GitHub contents API with the user's GitHub token, cached for 5 minutes.
 * `?refresh` in the request URL bypasses the cache.
 * @param {{ locals: App.Locals, url: URL }} event
 * @param {{ repo: string, ref: string, path: string }} source
 */
export async function serveRepoPage({ locals, url }, { repo, ref, path }) {
  const key = `${repo}@${ref}:${path}`;
  let hit = cache.get(key);
  if (url.searchParams.has('refresh') || !hit || Date.now() - hit.at > TTL_MS) {
    const session = await locals.auth();
    const { token } = await getGitHubConfig(session?.user?.email);
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: 'application/vnd.github.raw',
          'User-Agent': 'appmixer-sanity-check',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }
    );
    if (res.ok) {
      hit = { at: Date.now(), html: await res.text() };
      cache.set(key, hit);
    } else if (!hit) {
      // A stale copy beats an error page; without one, say what failed
      error(
        res.status === 404 ? 404 : 502,
        `GitHub answered ${res.status} for ${path} at ${ref} (the token needs read access to ${repo})`
      );
    }
  }
  return new Response(hit.html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, max-age=60' }
  });
}
