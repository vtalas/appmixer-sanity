import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/admin.js';
import {
  getConnectorUploadStatus,
  getInstanceUrl,
  uploadConnectorPackage
} from '$lib/api/appmixer.js';
import { normalizeInstanceUrl } from '$lib/marketplace.js';
import { downloadPackage } from '$lib/server/marketplace.js';

/**
 * The instance of the caller's Settings, checked against the one the page showed —
 * Settings changed in another tab must not send a package somewhere unconfirmed.
 * @param {string} userId
 * @param {unknown} expected
 */
async function confirmInstance(userId, expected) {
  const instanceUrl = await getInstanceUrl(userId);
  if (!instanceUrl) {
    return { error: 'No Appmixer instance is configured', status: 400 };
  }
  if (normalizeInstanceUrl(String(expected || '')) !== instanceUrl) {
    return {
      error: `The instance in Settings is now ${instanceUrl} — reload the page and confirm again`,
      status: 409
    };
  }
  return { instanceUrl };
}

/**
 * POST `{name, version, instanceUrl}` — download that package from the marketplace
 * and start installing it on the instance. Returns `{ticket}`; poll it with GET.
 */
export async function POST({ request, locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;
  if (!userId || !isAdmin(userId)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { instanceUrl, error, status } = await confirmInstance(userId, body.instanceUrl);
  if (!instanceUrl) {
    return json({ error }, { status });
  }

  try {
    const zip = await downloadPackage(body.name, body.version);
    const { ticket } = await uploadConnectorPackage(userId, zip);
    console.log(
      `[marketplace/publish] ${userId} published ${body.name}@${body.version}` +
        ` (${zip.length} bytes) to ${instanceUrl}, ticket ${ticket}`
    );
    return json({ ticket, size: zip.length });
  } catch (err) {
    const e = /** @type {any} */ (err);
    return json({ error: e.message }, { status: e.status && e.status < 600 ? e.status : 500 });
  }
}

/**
 * GET ?ticket=&instanceUrl= — state of an upload: `{pending}` until the instance knows
 * the ticket, `{started}` while it runs, then `{finished}` — with `err` when it failed.
 */
export async function GET({ url, locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;
  if (!userId || !isAdmin(userId)) {
    return json({ error: 'Forbidden' }, { status: 403 });
  }

  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    return json({ error: 'ticket is required' }, { status: 400 });
  }
  const { instanceUrl, error, status } = await confirmInstance(
    userId,
    url.searchParams.get('instanceUrl')
  );
  if (!instanceUrl) {
    return json({ error }, { status });
  }

  try {
    return json((await getConnectorUploadStatus(userId, ticket)) ?? { pending: true });
  } catch (err) {
    return json({ error: /** @type {Error} */ (err).message }, { status: 502 });
  }
}
