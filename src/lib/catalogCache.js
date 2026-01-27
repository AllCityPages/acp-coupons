// src/lib/catalogCache.js

/**
 * Lightweight in-memory cache for catalog-style data:
 * - offers
 * - menus
 * - listings
 * - pricing tables
 *
 * Features:
 *  - TTL-based expiration
 *  - Optional stale-while-revalidate
 *  - Promise de-duplication (prevents cache stampede)
 */

class CatalogCache {
  constructor({ ttlMs = 30_000, allowStale = true } = {}) {
    this.ttlMs = ttlMs;
    this.allowStale = allowStale;

    this.store = new Map();      // key -> { value, expiresAt }
    this.inFlight = new Map();   // key -> Promise
  }

  /**
   * Get a value from cache or load it.
   * @param {string} key
   * @param {Function} loader async function returning fresh data
   */
  async get(key, loader) {
    const now = Date.now();
    const entry = this.store.get(key);

    // Fresh hit
    if (entry && entry.expiresAt > now) {
      return { value: entry.value, cache: "HIT" };
    }

    // Stale hit (serve immediately, refresh in background)
    if (entry && this.allowStale) {
      this._revalidate(key, loader);
      return { value: entry.value, cache: "STALE" };
    }

    // Prevent stampede: reuse in-flight promise
    if (this.inFlight.has(key)) {
      const value = await this.inFlight.get(key);
      return { value, cache: "WAIT" };
    }

    // Cold miss
    const loadPromise = this._load(key, loader);
    this.inFlight.set(key, loadPromise);

    try {
      const value = await loadPromise;
      return { value, cache: "MISS" };
    } finally {
      this.inFlight.delete(key);
    }
  }

  async _load(key, loader) {
    const value = await loader();
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
    return value;
  }

  async _revalidate(key, loader) {
    if (this.inFlight.has(key)) return;

    const promise = this._load(key, loader).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
  }

  invalidate(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
    this.inFlight.clear();
  }

  stats() {
    return {
      entries: this.store.size,
      inFlight: this.inFlight.size,
      ttlMs: this.ttlMs,
      allowStale: this.allowStale,
    };
  }
}

module.exports = { CatalogCache };
