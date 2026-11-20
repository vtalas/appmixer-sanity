import { getIcon } from '$lib/server/marketplace.js';

/** GET ?name= — a connector's marketplace icon. */
export async function GET({ url, locals }) {
  const session = await locals.auth();
  if (!session?.user?.email) {
    return new Response(null, { status: 401 });
  }
  const icon = await getIcon(url.searchParams.get('name') || '').catch(() => null);
  if (!icon) {
    return new Response(null, { status: 404 });
  }
  return new Response(/** @type {BodyInit} */ (icon.body), {
    headers: {
      'Content-Type': icon.type,
      'Cache-Control': 'private, max-age=86400',
      // Icons are third-party SVG served from the app's origin: opened directly,
      // a script inside one must not run with the app's session
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
