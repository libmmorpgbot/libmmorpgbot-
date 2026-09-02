'use strict';
// Market listing helpers, moved out of server/index.js verbatim.
//
// Pure functions over a MarketListing document: no models, no sockets, no
// session state — same shape as server/inventory.js.
const {
  MARKET_MAX_ACTIVE, MARKET_MAX_ACTIVE_VIP_LEVEL, MARKET_MAX_ACTIVE_VIP,
} = require('./inventory');

// VIP 3+ trades the flat MARKET_MAX_ACTIVE cap for the higher
// MARKET_MAX_ACTIVE_VIP cap. .limit(0) is Mongo's own "no limit" convention,
// used wherever this feeds a query instead of a comparison — no longer hit
// now that both tiers are finite, but harmless to keep.
function _marketMaxActive(vipLevel) {
  return (vipLevel || 0) >= MARKET_MAX_ACTIVE_VIP_LEVEL ? MARKET_MAX_ACTIVE_VIP : MARKET_MAX_ACTIVE;
}

// 10% of what a market BUYER pays counts toward their VIP bar, same deposit
// mechanic gramShopBuy's own pkg.gram uses — see marketBuy below.
const MARKET_VIP_PCT = 0.10;

// ── тут стояли _marketListingData / _marketHistoryData ─────────────────────
// Два мапери епохи Mongo (`l._id.toString()`), які пережили переїзд на
// Postgres і не пережили підключення: жоден із них ніхто не викликав.
//
// Ціна цього була не «зайвий код». _marketHistoryData — це ЄДИНЕ місце, де
// колись з'являлися role / counterpart / soldAt, а клієнт читає саме їх
// (_renderMarketHistoryTab, js/ui.js). Мапер лишився осторонь — і вся історія
// ринку малювалася як чужі покупки: «Куплено» з мінусом і без ніка другої
// сторони, на власних же продажах.
//
// Тепер розвертання угоди на того, хто питає, робить market.history()
// (server/db/repos/market.js) — один шлях, який справді викликається, і поруч
// із запитом, що єдиний знає обидві сторони. Копію тут не відновлювати.

module.exports = { _marketMaxActive, MARKET_VIP_PCT };
