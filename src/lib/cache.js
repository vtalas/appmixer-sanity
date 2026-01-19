/**
 * Simple in-memory cache with TTL support
 */
class Cache {
  constructor() {
    /** @type {Map<string, { data: any, expires: number }>} */
    this.store = new Map();
  }

  /**
   * Get a value from cache
   * @param {string} key
   * @returns {any | undefined}
   */
  get(key) {
    const item = this.store.get(key);
    if (!item) return undefined;

    if (Date.now() > item.expires) {
      this.store.delete(key);
      return undefined;
    }

    return item.data;
  }

  /**
   * Set a value in cache
   * @param {string} key
   * @param {any} data
   * @param {number} ttlMs - Time to live in milliseconds (default 5 minutes)
   */
  set(key, data, ttlMs = 5 * 60 * 1000) {
    this.store.set(key, {
      data,
      expires: Date.now() + ttlMs
    });
  }

  /**
   * Invalidate a specific key
   * @param {string} key
   */
  invalidate(key) {
    this.store.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix
   * @param {string} prefix
   */
  invalidatePrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear entire cache
   */
  clear() {
    this.store.clear();
  }
}

export const cache = new Cache();

// Cache keys
export const CACHE_KEYS = {
  testRun: (/** @type {string} */ id) => `test-run:${id}`,
  connectors: (/** @type {string} */ testRunId) => `connectors:${testRunId}`,
  connector: (/** @type {string} */ id) => `connector:${id}`,
  components: (/** @type {string} */ connectorId) => `components:${connectorId}`,
  report: (/** @type {string} */ testRunId) => `report:${testRunId}`
};
