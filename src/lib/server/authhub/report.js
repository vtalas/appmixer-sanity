/**
 * Customer report: the services of an Auth Hub that are marked verified.
 */

import { getAuthHubConnectorInfo, getAuthHubStatuses } from '$lib/db/authhub.js';
import { cache } from '$lib/cache.js';
import { authHubFetch, resolveAuthHub } from './hub.js';

const REPORT_TTL_MS = 60 * 1000;

/**
 * `appmixer:google:drive` → `Google Drive`, `appmixer:googleAds` → `Google Ads`.
 * Only for connectors whose bundle label isn't stored yet.
 * @param {string} serviceId
 */
export function labelFromServiceId(serviceId) {
  const parts = serviceId.split(':');
  return (parts.length > 1 ? parts.slice(1) : parts)
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Verified services of an Auth Hub: listed there now (it has their service
 * config) and marked verified on /authub.
 *
 * SECURITY: the result is served without authentication. The Auth Hub list
 * carries clientSecret for every connector — only `serviceId` is read from it,
 * never spread or pass the upstream objects through.
 *
 * @param {string} envId - Auth Hub environment id
 * @returns {Promise<Array<{serviceId: string, label: string, icon: string|null}>>}
 */
export async function getVerifiedServices(envId) {
  const { hub, error } = resolveAuthHub(envId);
  if (!hub) {
    throw new Error(error);
  }

  // Anyone can request the report: don't let each hit call the Auth Hub and the DB
  const cacheKey = `authhub-report:${hub.id}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const [res, statuses, info] = await Promise.all([
    authHubFetch(hub, '/service-config'),
    getAuthHubStatuses(hub.id),
    getAuthHubConnectorInfo(hub.id)
  ]);
  if (!res.ok) {
    throw new Error(`Auth Hub API error: ${res.status}`);
  }

  const data = await res.json();
  const list = Array.isArray(data) ? data : Object.values(data || {});

  const services = list
    .map((c) => c?.serviceId)
    .filter((serviceId) => typeof serviceId === 'string' && statuses[serviceId] === 'verified')
    .map((serviceId) => ({
      serviceId,
      label: info[serviceId]?.label || labelFromServiceId(serviceId),
      icon: embeddedImage(info[serviceId]?.icon)
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));

  cache.set(cacheKey, services, REPORT_TTL_MS);
  return services;
}

/**
 * Icons come from bundle manifests. Only embedded images reach the public page —
 * a remote URL there would make every visitor's browser call a third party.
 * @param {string|null|undefined} icon
 */
function embeddedImage(icon) {
  return typeof icon === 'string' && icon.startsWith('data:image/') ? icon : null;
}
