/**
 * The production connector marketplace — the public store the Backoffice installs
 * connector packages from, filled by the "Marketplace PRD" workflow of the release
 * repo. Read-only and unauthenticated: a catalogue, the versions of one connector
 * and a download link per package.
 */

import { env } from '$env/dynamic/private';
import {
  appmixerUiUrl,
  getAppmixerConfig,
  getInstanceUser,
  listInstalledBundles
} from '$lib/api/appmixer.js';
import { compareVersions, isModuleName, isVersion } from '$lib/marketplace.js';

const DEFAULT_MARKETPLACE_URL = 'https://hbca2f6qck.execute-api.eu-central-1.amazonaws.com/prod';

/** The catalogue is ~3 MB (every icon is inlined) — keep it for a while */
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

/** A package is unpacked in memory by the instance too; refuse anything absurd */
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;

/**
 * @typedef {{name: string, version: string, label: string|null, description: string|null,
 *   icon: string|null, engine: string|null, changelog: Record<string, string[]>|null}} MarketplaceModule
 */

/** @type {{at: number, modules: Map<string, MarketplaceModule>} | null} */
let catalogueCache = null;
/** @type {Promise<Map<string, MarketplaceModule>> | null} */
let catalogueLoading = null;

export function marketplaceUrl() {
  return (env.MARKETPLACE_URL || DEFAULT_MARKETPLACE_URL).replace(/\/+$/, '');
}

export class MarketplaceError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function marketplaceJson(path) {
  let res;
  try {
    res = await fetch(`${marketplaceUrl()}${path}`);
  } catch (err) {
    throw new MarketplaceError(
      `Marketplace is unreachable: ${/** @type {Error} */ (err).message}`,
      502
    );
  }
  if (!res.ok) {
    throw new MarketplaceError(
      `Marketplace answered ${res.status} for ${path}`,
      res.status === 404 ? 404 : 502
    );
  }
  return res.json();
}

/**
 * @param {string} name
 * @param {string} version
 * @param {any} manifest
 * @returns {MarketplaceModule}
 */
function toModule(name, version, manifest) {
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : null);
  const changelog = manifest?.changelog;
  return {
    name,
    version,
    label: text(manifest?.label),
    description: text(manifest?.description),
    icon: text(manifest?.icon),
    engine: text(manifest?.engine),
    changelog:
      changelog && typeof changelog === 'object' && !Array.isArray(changelog) ? changelog : null
  };
}

/**
 * The latest version of every connector the marketplace offers, by name.
 * @param {{force?: boolean}} [options]
 * @returns {Promise<Map<string, MarketplaceModule>>}
 */
export async function loadCatalogue({ force = false } = {}) {
  if (!force && catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) {
    return catalogueCache.modules;
  }
  if (!catalogueLoading) {
    catalogueLoading = (async () => {
      const data = await marketplaceJson('/modules?latest=1');
      const modules = new Map();
      for (const [name, versions] of Object.entries(data || {})) {
        if (!isModuleName(name)) continue;
        const latest = Object.keys(versions || {})
          .filter(isVersion)
          .sort(compareVersions)
          .pop();
        if (latest) modules.set(name, toModule(name, latest, versions[latest]));
      }
      catalogueCache = { at: Date.now(), modules };
      return modules;
    })().finally(() => {
      catalogueLoading = null;
    });
  }
  return catalogueLoading;
}

/**
 * Every version the marketplace holds of a connector, newest first.
 * @param {string} name
 * @returns {Promise<Array<{version: string, engine: string|null}>>}
 */
export async function listVersions(name) {
  if (!isModuleName(name)) {
    throw new MarketplaceError(`"${name}" is not a connector name`, 400);
  }
  const data = await marketplaceJson(`/modules/${name}`);
  return Object.keys(data || {})
    .filter(isVersion)
    .sort(compareVersions)
    .reverse()
    .map((version) => ({ version, engine: toModule(name, version, data[version]).engine }));
}

/**
 * Download one connector package (the ZIP the instance's uploader installs).
 * @param {string} name
 * @param {string} version
 * @returns {Promise<Uint8Array>}
 */
export async function downloadPackage(name, version) {
  if (!isModuleName(name)) {
    throw new MarketplaceError(`"${name}" is not a connector name`, 400);
  }
  if (!isVersion(version)) {
    throw new MarketplaceError(`"${version}" is not a version`, 400);
  }
  // The marketplace answers a short-lived signed link to the package
  const { url } = await marketplaceJson(`/modules/download/${name}-${version}.zip`);
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new MarketplaceError(`Marketplace gave no download link for ${name} ${version}`, 502);
  }
  const res = await fetch(url);
  if (!res.ok) {
    // A link is signed for any file name — a missing package shows up only here
    throw new MarketplaceError(
      res.status === 404 || res.status === 403
        ? `The marketplace does not hold ${name} ${version}`
        : `Package download failed: ${res.status}`,
      res.status === 404 || res.status === 403 ? 404 : 502
    );
  }
  const zip = new Uint8Array(await res.arrayBuffer());
  if (zip.length > MAX_PACKAGE_BYTES) {
    throw new MarketplaceError(`${name} ${version} is ${zip.length} bytes — too large`, 413);
  }
  // "PK\x03\x04" — anything else is an error page, not a package
  if (zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4b) {
    throw new MarketplaceError(`${name} ${version} is not a ZIP archive`, 502);
  }
  return zip;
}

/**
 * The icon of a connector as bytes — the catalogue inlines it as a data: URL.
 * @param {string} name
 * @returns {Promise<{type: string, body: Uint8Array} | null>}
 */
export async function getIcon(name) {
  const icon = (await loadCatalogue()).get(name)?.icon;
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is.exec(icon || '');
  if (!match) return null;
  const body = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { type: match[1].toLowerCase(), body: new Uint8Array(body) };
}

/**
 * The instance the caller's Settings point to, as the Marketplace page needs it:
 * who the configured account is there, what it may upload and what is installed.
 * Never throws — an unreachable or unconfigured instance comes back with `error`.
 * @param {string} userId - User ID (email)
 */
export async function loadInstanceState(userId) {
  const config = await getAppmixerConfig(userId);
  const baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
  const state = {
    baseUrl,
    uiUrl: baseUrl ? appmixerUiUrl(baseUrl) : '',
    username: config.username || '',
    isInstanceAdmin: false,
    vendors: /** @type {string[]} */ ([]),
    installed: /** @type {Record<string, string>} */ ({}),
    error: /** @type {string|null} */ (null)
  };
  if (!baseUrl || !config.username || !config.password) {
    state.error = 'No Appmixer instance is configured — set one in Settings.';
    return state;
  }
  try {
    const [user, installed] = await Promise.all([
      getInstanceUser(userId),
      listInstalledBundles(userId)
    ]);
    state.isInstanceAdmin = user.isAdmin;
    state.vendors = user.vendors;
    state.installed = installed;
  } catch (err) {
    state.error = /** @type {Error} */ (err).message;
  }
  return state;
}
