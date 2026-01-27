// src/data/store.js
/**
 * Replace with real DB calls.
 * Keep interface stable so routes/services don't change.
 */
const store = {
  _offers: [
    { id: 1, title: "10% off", active: true },
    { id: 2, title: "Free delivery", active: true },
  ],

  async queryOffers(params) {
    // Add param filtering if needed
    return this._offers.filter(o => o.active);
  },

  async resetOffers(newOffers) {
    this._offers = newOffers;
  },

  async cleanupExpired() {
    // placeholder for any cleanup logic
    return { cleaned: 0 };
  },
};

module.exports = { store };
