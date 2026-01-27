// src/data/demoSeed.js
const { store } = require("./store");

const DEMO_OFFERS = [
  { id: 1, title: "10% off", active: true },
  { id: 2, title: "Free delivery", active: true },
  { id: 3, title: "BOGO", active: false },
];

async function resetDemoData() {
  await store.resetOffers(DEMO_OFFERS);
}

module.exports = { resetDemoData, DEMO_OFFERS };
