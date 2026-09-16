/**
 * Keys an Auth Hub service config holds besides `serviceId`. A config with none
 * is only a registration (what uploads create) — the connector isn't set up yet.
 * Names only, never values: the result is safe to send to the browser.
 * @param {Record<string, unknown>|null|undefined} config
 * @returns {string[]}
 */
export function configKeysOf(config) {
  return Object.keys(config || {}).filter((k) => k !== 'serviceId');
}
