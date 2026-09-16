/**
 * Auth Hub environments. Every Auth Hub API route takes `?env=<id>` (default
 * `prod`) and talks to that environment's Auth Hub with its own token.
 */

import { env } from '$env/dynamic/private';

export const DEFAULT_AUTH_HUB_ENV = 'prod';

/** Cookie remembering the environment last picked on /authub */
export const AUTH_HUB_ENV_COOKIE = 'authhub_env';

const ENVIRONMENTS = [
  {
    id: 'prod',
    label: 'Production',
    urlVar: 'AUTH_HUB_URL_PROD',
    tokenVar: 'AUTH_HUB_API_TOKEN_PROD'
  },
  { id: 'qa', label: 'QA', urlVar: 'AUTH_HUB_URL_QA', tokenVar: 'AUTH_HUB_API_TOKEN_QA' }
];

/**
 * @typedef {{id: string, label: string, baseUrl: string, token: string}} AuthHub
 */

/**
 * Environments for the switcher — host and variable names, never the token.
 * @returns {Array<{id: string, label: string, configured: boolean, host: string|null, requires: string[]}>}
 */
export function listAuthHubEnvs() {
  return ENVIRONMENTS.map((e) => ({
    id: e.id,
    label: e.label,
    configured: Boolean(env[e.urlVar] && env[e.tokenVar]),
    host: hostOf(env[e.urlVar]),
    requires: [e.urlVar, e.tokenVar]
  }));
}

/**
 * @param {string|null|undefined} id
 * @returns {id is string}
 */
export function isAuthHubEnv(id) {
  return ENVIRONMENTS.some((e) => e.id === id);
}

/**
 * Resolve an environment id to its Auth Hub.
 * @param {string|null|undefined} id
 * @returns {{hub: AuthHub, error?: undefined, status?: undefined} | {hub?: undefined, error: string, status: number}}
 */
export function resolveAuthHub(id) {
  const e = ENVIRONMENTS.find((x) => x.id === (id || DEFAULT_AUTH_HUB_ENV));
  if (!e) {
    return { error: `Unknown Auth Hub environment "${id}"`, status: 400 };
  }
  const baseUrl = env[e.urlVar];
  const token = env[e.tokenVar];
  if (!baseUrl || !token) {
    return { error: `${e.urlVar} and ${e.tokenVar} must be configured`, status: 500 };
  }
  return { hub: { id: e.id, label: e.label, baseUrl: baseUrl.replace(/\/+$/, ''), token } };
}

/**
 * Auth Hub of a request — `?env=` of its URL.
 * @param {URL} url
 */
export function resolveAuthHubFromUrl(url) {
  return resolveAuthHub(url.searchParams.get('env'));
}

/**
 * fetch() against an Auth Hub with its bearer token.
 * @param {AuthHub} hub
 * @param {string} path - starting with /
 * @param {RequestInit} [init]
 */
export function authHubFetch(hub, path, init = {}) {
  return fetch(`${hub.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${hub.token}`, ...init.headers }
  });
}

/** @param {string|undefined} url */
function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Start a bundle upload (POST /components). Auth Hub unpacks, tests and
 * installs it in the background — poll GET /components/uploader/<ticket>.
 * @param {AuthHub} hub
 * @param {ArrayBuffer|Uint8Array} zip
 * @returns {Promise<{ticket: string}>}
 */
export async function uploadToAuthHub(hub, zip) {
  const res = await authHubFetch(hub, '/components', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: /** @type {BodyInit} */ (zip)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthHubError(data.message || `Auth Hub error: ${res.status}`, res.status);
  }
  return data;
}

export class AuthHubError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
