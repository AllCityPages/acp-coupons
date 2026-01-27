// src/services/offersService.js
const { env } = require("../config/env");
const { MemoryCache } = require("./cache");
const { store } = require("../data/store");

const offersCache = new MemoryCache();

/**
 * Cache key should include anything that changes the response:
 * - query params, geo, user tier, etc.
 */
function makeOffersCacheKey(params) {
  return JSON.stringify(params || {});
}

/**
 * Basic TTL caching. Optional: stale-while-revalidate pattern.
 */
async function getOffers(params) {
  const key = makeOffersCacheKey(params);
  const cached = offersCache.get(key);
  if (cached) return { data: cached, cache: "HIT" };

  // Simulate expensive work: DB query, aggregation, etc.
  const data = await store.queryOffers(params);

  offersCache.set(key, data, env.OFFERS_CACHE_TTL_MS);
  return { data, cache: "MISS" };
}

function invalidateOffersCache() {
  offersCache.clear();
}

module.exports = { getOffers, invalidateOffersCache };
