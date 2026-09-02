'use strict';
// ── Market ──────────────────────────────────────────────────────────────────
// The whole reason for the migration, in one file.
//
// What buy() replaces: ~130 lines in handlers/market.js that do the same job
// as a saga — claim the listing, check the buyer's room, take the money,
// deliver the item, pay the seller — with a hand-written unwind after every
// step, because any of them could be the one the process died after. Its own
// comments name the failures that produced each branch: "the GRAM is already
// gone and the seller has NOT been paid yet, so unwind the whole trade", "the
// account may have reconnected on a DIFFERENT socket during the awaits above".
//
// Here those branches do not exist. Every step is in one transaction: if
// anything fails, PostgreSQL undoes all of it, and there is no unwind code to
// get wrong. The five outcomes the old version had to enumerate collapse into
// two — it happened, or it did not.
//
// The rules (fee, price bounds, active-listing cap, cooldown) are taken from
// the existing modules rather than restated, so the rewrite cannot quietly
// change the economy.

const { query, hasColumn } = require('../index');
const items = require('./items');
const money = require('./money');
const { MARKET_FEE_PCT, MARKET_MAX_PRICE, MARKET_MAX_QTY, MARKET_LIST_COOLDOWN_MS, _marketMinPrice } =
  require('../../inventory');
const { _marketMaxActive, MARKET_VIP_PCT } = require('../../market-helpers');
const progression = require('./progression');
const { _catalogBase } = require('../../anticheat');

// Rounded to the same 2 decimals the old _round2 used everywhere a GRAM figure
// is shown, so the number the seller is paid matches the number both sides saw.
const round2 = n => Math.round(n * 100) / 100;

class MarketError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new MarketError(code, msg); };

// ── list ────────────────────────────────────────────────────────────────────
// Puts one item up for sale. The item LEAVES the seller's inventory in the
// same transaction that creates the listing, so "listed but still held" is not
// a state that can exist between two writes — there is only one write.
//
// ── скільки штук, і чому це рахується тут, а не в рядку ────────────────────
// `qty` — скільки одиниць стака гравець хоче виставити. Опущений означає
// «увесь рядок»: так поводилась ця функція завжди, і так її досі кличуть
// dev/market-check.js, dev/enhance-check.js та dev/exploit-check.js.
//
// До появи цього параметра лот завжди дорівнював ОДНОМУ РЯДКУ player_items, і
// саме на цьому гравці зловили дві різні поломки:
//
//   1. Стакові предмети живуть не в одному рядку. items.add() зливає стак у
//      наявний рядок, а от attachFromListing (купівля та скасування лоту) —
//      ні: вона просто повертає відчеплений рядок власнику. Тому в акаунта
//      з'являється key_rare двома рядками — 46 і 250. Клієнт малює їх однією
//      купкою на 296 (_migrateInventory, js/player.js) і бере rowId ПЕРШОГО
//      рядка, тож «виставляю 296 за 1.8» знімало з полиці рівно 46. Це не
//      здогад: у живій базі це рядки 68394 (46 шт.) і 80117 (250 шт.) одного
//      гравця, тобто рівно ті числа, які він і назвав.
//
//   2. Вибрати кількість було нічим. Лот забирав увесь стак, тож продати 10
//      ключів із 300 було неможливо в принципі.
//
// Тому кількість тепер задається явно, а рахується ПО ВСІХ рядках предмета в
// інвентарі — рядок, на який показав клієнт, лише називає предмет. Клієнту не
// вірять: скільки він реально має, знає тільки база, і `have` нижче — це вона
// і є.
async function list(db, playerId, rowId, price, { vipLevel = 0, qty = null } = {}) {
  await items.lockPlayer(db, playerId);

  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) err('bad_price', 'Некоректна ціна');
  if (p > MARKET_MAX_PRICE) err('bad_price', `Максимальна ціна — ${MARKET_MAX_PRICE} GRAM`);

  // The item must be in the seller's INVENTORY: not equipped, not in storage,
  // not already listed. The WHERE clause is the check — a separate "does he
  // own it" read would be a fact that can change before the update lands.
  const { rows: own } = await query(db, `
    SELECT i.id, i.item_id, i.enhance, i.qty, c.rarity, c.stackable
      FROM player_items i JOIN item_catalog c ON c.item_id = i.item_id
     WHERE i.id = $1 AND i.player_id = $2 AND i.container = 'inventory'
     FOR UPDATE OF i`, [rowId, playerId]);
  if (!own.length) err('not_owned', 'Предмет не знайдено в інвентарі');
  const it = own[0];
  const rowQty = Number(it.qty) || 1;

  // ── скільки саме виставляємо ──────────────────────────────────────────────
  // Опущене/сміттєве значення — увесь рядок, як було до появи параметра.
  const asked = Math.floor(Number(qty));
  const want = Number.isSafeInteger(asked) && asked > 0 ? asked : rowQty;

  // Нестаковий предмет — це один рядок на одну копію, і рядок з qty > 1 гра
  // ніколи не створює (items.add() ставить qty лише стаковим). Якби клієнт
  // попросив 5 однакових мечів, тут би народився рядок «5 мечів в одному
  // слоті» — форма, якої в грі немає і яку покупець отримав би однією
  // коміркою. Тому це відмова, а не мовчазне обрізання до 1.
  if (!it.stackable && want !== 1) {
    err('bad_qty', 'Цей предмет не стакається — за раз продається лише 1 шт.');
  }

  // Скільки одиниць цього предмета гравець ТРИМАЄ насправді — сумою по всіх
  // рядках інвентаря з тим самим id та тією ж заточкою, бо саме так їх бачить
  // і рахує сам гравець. Це та перевірка, якої не було: раніше «власність»
  // означала «рядок належить тобі», а скільки в ньому лежить — не питали.
  const { rows: pool } = await query(db, `
    SELECT COALESCE(sum(qty), 0)::int AS have
      FROM player_items
     WHERE player_id = $1 AND container = 'inventory'
       AND item_id = $2 AND enhance = $3`, [playerId, it.item_id, it.enhance || 0]);
  const have = Number(pool[0].have);
  if (want > have) err('bad_qty', `У вас лише ${have} шт., а виставляєте ${want}`);

  // qty is the point. _marketMinPrice multiplies its floors by item.qty
  // because they are PER UNIT and a listing's price covers the whole stack
  // (see the constants in server/inventory.js) — and _catalogBase returns a
  // catalog definition, which has no qty. So it defaulted to 1 and the
  // scaling was silently dropped: a stack of 9999 bless_stone, floor 1.5 each,
  // could be listed for 1.5 GRAM total instead of 14998. Buy it from an alt
  // and nearly 15k GRAM of goods crosses accounts for a 0.15 fee instead of
  // ~1500 — the market fee is the only tax on muling, and this divided it by
  // the size of the stack.
  if (want > MARKET_MAX_QTY) err('bad_qty', `За раз можна виставити не більше ${MARKET_MAX_QTY} шт.`);
  const min = _marketMinPrice({ ...(_catalogBase(it.item_id) || {}), rarity: it.rarity, qty: want });
  if (min > MARKET_MAX_PRICE) {
    // A stack whose honest floor exceeds the ceiling cannot be listed at any
    // legal price. Saying so is better than the alternative the bug produced,
    // which was letting it through at a hundredth of its worth.
    err('bad_qty', `Стак завеликий — мінімальна ціна за нього ${min.toFixed(2)} GRAM, а стеля ${MARKET_MAX_PRICE}. Розділіть стак.`);
  }
  if (p < min) err('bad_price', `Мінімальна ціна для цього предмета — ${min} GRAM`);

  // Active-listing cap and cooldown, both read from the listings themselves.
  // The old version kept the cooldown in a per-connection variable
  // (_lastMarketListAt), so it reset on every reconnect and a client that
  // dropped and rejoined could list without waiting at all.
  const { rows: st } = await query(db, `
    SELECT count(*)::int                                    AS active,
           max(created_at)                                  AS last_at,
           EXTRACT(EPOCH FROM (now() - max(created_at))) * 1000 AS since_ms
      FROM market_listings
     WHERE seller_id = $1 AND status = 'active'`, [playerId]);
  const maxActive = _marketMaxActive(vipLevel);
  if (st[0].active >= maxActive) err('too_many', `Одночасно можна виставити ${maxActive} лотів`);
  if (st[0].last_at && Number(st[0].since_ms) < MARKET_LIST_COOLDOWN_MS) {
    err('cooldown', 'Занадто часто — зачекайте пару секунд');
  }

  // ── предмет іде з інвентаря ───────────────────────────────────────────────
  // Увесь рядок — старим шляхом: рядок просто відчіплюється від власника і
  // зберігає свою тотожність. Це важливо не для стаків, а для унікальних
  // речей: id рядка — це ключ, за яким items.historyOfRow відповідає «звідки
  // взявся цей меч», і створювати замість нього новий рядок означало б
  // обірвати цю історію на кожному продажу.
  //
  // Частина стака — розщепленням: спершу народжується відчеплений рядок рівно
  // на `want` штук, потім рівно стільки ж списується з інвентаря — по всіх
  // рядках предмета, чим і закривається випадок «46 + 250».
  let listedRowId;
  if (want === rowQty) {
    if (!await items.detachForListing(db, rowId, playerId)) {
      err('not_owned', 'Предмет перемістився — спробуйте ще раз');
    }
    listedRowId = rowId;
  } else {
    listedRowId = await _splitOffForListing(db, playerId, it, want);
  }

  // What is being sold is written INTO the listing, not only referenced from
  // it. A record of a trade has to say what was traded — by the time anyone
  // reads their history the item could be a different enhancement level, in
  // somebody else's bag, or gone.
  //
  // Written only when the columns are there. Migration 010 adds them and needs
  // a credential the application does not hold, so this build has to run
  // correctly on either schema — see hasColumn (server/db/index.js).
  const snap = await hasColumn('market_listings', 'snap_item_id');
  const { rows } = snap
    ? await query(db, `
        INSERT INTO market_listings (seller_id, item_id, price, snap_item_id, snap_enhance, snap_qty)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [playerId, listedRowId, round2(p), it.item_id, it.enhance || 0, want])
    : await query(db, `
        INSERT INTO market_listings (seller_id, item_id, price)
        VALUES ($1, $2, $3) RETURNING id, created_at`,
        [playerId, listedRowId, round2(p)]);

  // Read back through the SAME shape browse() and mine() use. This used to
  // return `{ listingId, price, item: { id, enhance, qty } }` — no `id`, no
  // item name, no rarity, no slot — and the client unshifts it straight into
  // its "my lots" list and draws it. So a lot you had just listed showed with
  // no icon and no name until you left the tab and came back, at which point
  // mine() supplied the real record: "только выставил — нет иконки; если на
  // другую страницу и назад — проявляются".
  //
  // It was worse than a missing icon. The client removes a cancelled lot with
  // `_marketMine.filter(l => l.id !== listingId)`, and this record had no `id`
  // at all — so cancelling a lot listed in the same session left it on screen.
  //
  // One extra read on an action a player performs a few times an hour, in
  // exchange for every path answering with one shape.
  const id = Number(rows[0].id);
  const lot = await byId(db, id);
  // `listingId` kept alongside `id`: callers written against the old return
  // shape (dev/market-check.js among them) name it that way, and breaking them
  // to rename a field would be a change with no benefit to anyone.
  return lot
    ? { ...lot, listingId: id }
    : { id, listingId: id, price: round2(p), item: { id: it.item_id, enhance: it.enhance, qty: want } };
}

// Відрізає `want` штук від того, що гравець тримає, і віддає id відчепленого
// рядка, який тепер належить лоту.
//
// Спершу INSERT, потім списання — і це не стиль, а необхідність: списання
// бере штуки з УСІХ рядків предмета і вихідний рядок може видалити цілком,
// а INSERT ... SELECT читає з нього провенанс. Новий рядок у списання не
// потрапляє: він одразу нічий (player_id/container NULL), а пул нижче
// відбирається по `player_id = $1 AND container = 'inventory'`.
//
// Нічийним він народжується тією самою формою, яку дає detachForListing, і
// саме її вимагає обмеження player_items_owned_ck. Проміжного стану «належить
// і продавцю, і лоту» не існує; будь-яка помилка нижче забирає цей INSERT із
// собою разом із транзакцією.
//
// Провенанс (source/source_ref) копіюється з вихідного рядка, коли міграція
// 011 вже пройшла: відрізаний шматок стака прийшов звідти ж, звідки й стак, і
// вигадувати йому нове походження означало б збрехати в єдиній колонці, яка
// відповідає на питання «звідки це взялося».
//
// ── чому списання зроблене тут, а не через items.removeQty ─────────────────
// removeQty теж уміє забрати `want` по кількох рядках і теж пише в реєстр —
// але БЕЗ row_id, бо для неї це рух по кількох рядках одразу і жодного
// «того самого» рядка немає. Тут він є: усі ці штуки поїхали в один рядок
// лоту, і саме його id робить items.historyOfRow() здатною відповісти
// покупцю «звідки це взялося». Через removeQty новий рядок з'являвся б у
// player_items узагалі без згадки в реєстрі — дірку рівно такої форми і
// ловить dev/item-ledger-check.js.
//
// Запис у реєстрі рівно один, на -want, як і в detachForListing: сума дельт
// гравця має й далі дорівнювати тому, що в нього на руках (items.reconcile).
async function _splitOffForListing(db, playerId, it, want) {
  const hasSrc = await hasColumn('player_items', 'source');
  const { rows } = hasSrc
    ? await query(db, `
        INSERT INTO player_items (player_id, container, slot, item_id, enhance, qty, source, source_ref)
        SELECT NULL, NULL, NULL, item_id, enhance, $2::int, source, source_ref
          FROM player_items WHERE id = $1
        RETURNING id`, [it.id, want])
    : await query(db, `
        INSERT INTO player_items (player_id, container, slot, item_id, enhance, qty)
        SELECT NULL, NULL, NULL, item_id, enhance, $2::int
          FROM player_items WHERE id = $1
        RETURNING id`, [it.id, want]);
  if (!rows.length) err('not_owned', 'Предмет перемістився — спробуйте ще раз');
  const listedRowId = Number(rows[0].id);

  // Рядок, на який показав клієнт, іде першим — інакше гравець, що обрав
  // купку з двох рядків, побачив би списання «звідкись іще». Далі за id, як і
  // всюди в цьому проєкті, де рядки рівноцінні.
  //
  // Рядки, на які ще посилається якийсь лот, виключаються, поки зовнішній
  // ключ забороняє їх видаляти (до міграції 010). Спроба видалити такий
  // рядок підняла б 23503 і відкотила б усю транзакцію — те саме міркування
  // й та сама умова, що в items.removeQty.
  const guard = await items.marketRefBlocksDelete(db);
  const { rows: pool } = await query(db, `
    SELECT id, qty FROM player_items pi
     WHERE player_id = $1 AND container = 'inventory'
       AND item_id = $2 AND enhance = $3
       AND ($5::bool = false OR NOT EXISTS (
             SELECT 1 FROM market_listings m WHERE m.item_id = pi.id))
     ORDER BY (id = $4) DESC, id
     FOR UPDATE`, [playerId, it.item_id, it.enhance || 0, it.id, guard]);

  // Спершу порахувати, і лише потім писати: часткове списання — не успіх, а
  // саме та поломка, через яку крафт з'їдав три матеріали з двох.
  let left = want;
  const plan = [];
  for (const r of pool) {
    if (left <= 0) break;
    const take = Math.min(Number(r.qty), left);
    plan.push({ id: Number(r.id), take, whole: take === Number(r.qty) });
    left -= take;
  }
  if (left > 0) err('bad_qty', `Не вистачає предметів — доступно ${want - left}`);

  for (const step of plan) {
    if (step.whole) await query(db, 'DELETE FROM player_items WHERE id = $1', [step.id]);
    else await query(db, 'UPDATE player_items SET qty = qty - $2 WHERE id = $1', [step.id, step.take]);
  }
  await items.ledger(db, playerId, it.item_id, -want,
    { rowId: listedRowId, reason: 'market_list', refType: 'listing' });
  return listedRowId;
}

// One listing, in the shape every other read answers with.
async function byId(db, listingId) {
  const { rows } = await query(db, `
    SELECT ${await listingCols()}
      FROM market_listings l
      JOIN players      s ON s.id = l.seller_id
      LEFT JOIN player_items i ON i.id = l.item_id
      LEFT JOIN item_catalog c ON c.item_id = ${await catalogJoin()}
     WHERE l.id = $1`, [listingId]);
  return rows.length ? _lot(rows[0]) : null;
}

// ── ЩО САМЕ лежить у лоті ───────────────────────────────────────────────────
// Читається ДО того, як рядок віддадуть гравцеві, і це не оптимізація, а
// єдиний момент, коли відповідь ще правдива.
//
// items.attachFromListing() чіпляє рядок лоту до гравця й одразу зливає його
// зі стаком, який у того вже лежить (mergeStacks з `keep: rowId`) — вижити має
// саме цей рядок, бо на нього ще посилається лот. Тобто після виклику той
// самий id тримає вже ВЕСЬ стак покупця, а не куплену кількість.
//
// Через це обидва тости називали не те число: «Куплено: Камень заточки ×296»
// на купівлю трьох штук — 296 це те, скільки в покупця стало всього. Той самий
// рядок їхав продавцю в marketSold, тож і його «Продано» брехало так само, і
// повернення лоту в marketCancel теж.
//
// Рядок лоту нічий (player_id IS NULL) і тримає рівно кількість лоту, поки не
// віддали, — саме її тут і читаємо.
async function _lotItemRow(db, itemRowId) {
  const { rows } = await query(db,
    'SELECT id, item_id, enhance, qty FROM player_items WHERE id = $1', [itemRowId]);
  return rows.length
    ? { rowId: Number(rows[0].id), id: rows[0].item_id, enhance: rows[0].enhance || 0, qty: rows[0].qty || 1 }
    : null;
}

// ── cancel ──────────────────────────────────────────────────────────────────
// The item comes back in the same transaction that closes the listing. The old
// version cancelled first and discovered afterwards whether there was room —
// at which point the listing was already gone and nothing would ever return
// the item. Here the room check and the close are inseparable.
async function cancel(db, playerId, listingId) {
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT id, item_id AS item_row_id FROM market_listings
     WHERE id = $1 AND seller_id = $2 AND status = 'active'
     FOR UPDATE`, [listingId, playerId]);
  if (!rows.length) err('not_found', 'Лот не знайдено');

  // WHAT the lot holds, read BEFORE it goes back in the bag. See _lotItemRow:
  // attachFromListing merges the returning row into the stack the player
  // already has, so reading it afterwards reports the whole stack.
  const back = await _lotItemRow(db, rows[0].item_row_id);

  // The reason is spelled out because attachFromListing serves both a
  // cancellation and a sale, and its default names the sale. A cancelled lot
  // recorded as a purchase would read, months later, as a trade that never
  // happened.
  if (!await items.attachFromListing(db, rows[0].item_row_id, playerId,
    { reason: 'market_cancel', refType: 'listing', refId: String(listingId) })) {
    err('no_room', 'Інвентар повний — звільніть слот');
  }
  await query(db, `
    UPDATE market_listings SET status = 'cancelled', closed_at = now()
     WHERE id = $1`, [listingId]);

  return {
    listingId: Number(listingId), itemRowId: Number(rows[0].item_row_id),
    // Named as the client reads them: it prints which item came back.
    item: back,
    delivered: back != null,
  };
}

// ── buy ─────────────────────────────────────────────────────────────────────
// Money, item and listing move together or not at all.
//
// Lock order is fixed and matters: the LISTING first, then the two accounts by
// ascending id. Two players buying each other's lots at the same instant would
// otherwise take the same two locks in opposite orders and deadlock; ordering
// them makes that impossible rather than merely rare. (txRetry would recover
// from a deadlock, but recovering from something preventable is worse than
// preventing it.)
async function buy(db, buyerId, listingId) {
  const { rows: L } = await query(db, `
    SELECT id, seller_id, item_id AS item_row_id, price FROM market_listings
     WHERE id = $1 AND status = 'active'
     FOR UPDATE`, [listingId]);
  if (!L.length) err('gone', 'Лот уже продано або знято');
  const lot = L[0];
  const sellerId = Number(lot.seller_id);
  if (sellerId === buyerId) err('own_lot', 'Не можна купити власний лот');

  for (const id of [buyerId, sellerId].sort((a, b) => a - b)) {
    await items.lockPlayer(db, id);
  }

  // Room BEFORE money. Not an optimisation — if the money moved first and
  // delivery then failed, we would be back to writing a refund by hand, which
  // is the code this file exists to delete.
  if (await items.usedSlots(db, buyerId) >= items.SERVER_INV_MAX) {
    err('no_room', 'Інвентар повний');
  }

  const price = Number(lot.price);
  const idem = `market_buy:${listingId}`;

  const paid = await money.spend(db, buyerId, 'gram', price, {
    reason: 'market_buy', refType: 'market_listing', refId: String(listingId), idemKey: idem,
  });
  if (!paid) err('no_funds', 'Недостатньо GRAM');

  // The seller receives the price minus the house fee.
  //
  // The fee gets NO ledger row of its own, and that is a correctness
  // requirement rather than an omission. reconcile() checks, per account, that
  // sum(ledger.delta) equals balances.amount. A 'market_fee' row of -fee
  // against the seller would subtract from their ledger total without ever
  // having subtracted from their balance — every single sale would then show
  // up as drift, and the one alarm that tells us money moved outside money.js
  // would be permanently ringing and permanently ignored.
  //
  // Nothing is lost by leaving it out. The buyer's ledger says -price, the
  // seller's says +payout, and the fee is exactly the difference — derivable
  // per sale, and in aggregate as
  //   SELECT sum(price) * MARKET_FEE_PCT FROM market_listings WHERE status='sold'.
  // The GRAM simply leaves circulation, which is what a sink is; there is no
  // invariant here that the total must stay constant.
  const fee = round2(price * MARKET_FEE_PCT);
  const payout = round2(price - fee);
  await money.credit(db, sellerId, 'gram', payout, {
    reason: 'market_sale', refType: 'market_listing', refId: String(listingId), idemKey: `${idem}:payout`,
  });

  // WHAT is being handed over, read BEFORE the handover. See _lotItemRow.
  const soldItem = await _lotItemRow(db, lot.item_row_id);

  // lot.item_row_id is a player_items.id, NOT a catalog item id. The column is
  // named item_id in the table and that has already misled once — every
  // variable on this side spells out which of the two it holds.
  if (!await items.attachFromListing(db, lot.item_row_id, buyerId,
    { reason: 'market_buy', refType: 'listing', refId: String(listingId) })) {
    // Unreachable given the room check above, and deliberately a throw rather
    // than a refund: the transaction rolls the money back on its way out.
    err('no_room', 'Інвентар повний — покупку скасовано');
  }

  await query(db, `
    UPDATE market_listings
       SET status = 'sold', buyer_id = $2, closed_at = now()
     WHERE id = $1`, [listingId, buyerId]);

  // Inside the same transaction as the payment, so the credit toward VIP and
  // the GRAM that earned it commit together. Only a share of the price counts
  // — MARKET_VIP_PCT — because a market trade moves GRAM between two players
  // rather than into the game, and counting the whole of it would make VIP
  // farmable by two accounts selling to each other.
  await progression.addVipSpend(db, buyerId, price * MARKET_VIP_PCT);

  return {
    listingId: Number(listingId), sellerId, price, fee, payout,
    buyerBalance: paid.balance, itemRowId: Number(lot.item_row_id),
    // The names the client destructures. `buyerBalance` reached it as
    // `newBalance: undefined`, which is what the GRAM counter was then set to.
    //
    // `item` is what the LOT held — read above, before delivery. Both toasts
    // are built from it: the buyer's "Куплено: X ×n" and, through the
    // marketSold push, the seller's "Продано: X ×n".
    item: soldItem,
    newBalance: paid.balance,
    delivered: true,          // it is in the inventory or this threw
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

// The live row where there is one, the snapshot where there is not. An active
// listing always has both and they agree; a closed one may have only the
// snapshot, because the item it names has since been enhanced away or eaten by
// a craft.
//
// Two forms, because migration 010 may not have run yet — the older one simply
// has no snapshot to fall back to, and a closed lot whose item is gone shows
// blank instead of what it was.
const COLS_SNAP = `
  l.id, l.price, l.created_at, l.status,
  s.username AS seller_username, l.seller_id,
  COALESCE(i.item_id, l.snap_item_id)      AS item_id,
  COALESCE(i.enhance, l.snap_enhance, 0)   AS enhance,
  COALESCE(i.qty,     l.snap_qty, 1)       AS qty,
  c.name AS item_name, c.rarity, c.slot`;
const COLS_PLAIN = `
  l.id, l.price, l.created_at, l.status,
  s.username AS seller_username, l.seller_id,
  i.item_id, i.enhance, i.qty,
  c.name AS item_name, c.rarity, c.slot`;
// ── і та сама пара, але для ІСТОРІЇ: знімок ПЕРШИЙ ─────────────────────────
// COLS_SNAP вище бере живий рядок і падає на знімок — правильно для активного
// лоту, де рядок нічий і тримає рівно те, що виставили.
//
// Для закритого лоту це рівно навпаки. Проданий рядок їде до покупця й одразу
// зливається з його стаком (items.attachFromListing → mergeStacks), тож `i.qty`
// у нього — це вже все, що покупець тримає: «показує не куплену кількість, а
// загальну в інвентарі». Покупець його ще й заточує, і тоді `i.enhance` — теж
// не те, що продали.
//
// Знімок робиться в момент виставлення (list() вище) і після цього не
// змінюється ніколи. Запис про угоду має казати, ЩО ПРОДАЛИ, а не що з тією
// річчю сталося потім.
//
// На старій схемі (міграція 010 ще не пройшла) знімка просто немає — там і
// далі живий рядок, бо іншого джерела не існує.
const COLS_HIST = `
  l.id, l.price, l.created_at, l.status,
  s.username AS seller_username, l.seller_id,
  COALESCE(l.snap_item_id, i.item_id)      AS item_id,
  COALESCE(l.snap_enhance, i.enhance, 0)   AS enhance,
  COALESCE(l.snap_qty,     i.qty, 1)       AS qty,
  c.name AS item_name, c.rarity, c.slot`;
const listingCols = async () =>
  (await hasColumn('market_listings', 'snap_item_id')) ? COLS_SNAP : COLS_PLAIN;
const historyCols = async () =>
  (await hasColumn('market_listings', 'snap_item_id')) ? COLS_HIST : COLS_PLAIN;
const catalogJoin = async () =>
  (await hasColumn('market_listings', 'snap_item_id'))
    ? 'COALESCE(i.item_id, l.snap_item_id)'
    : 'i.item_id';
const historyCatalogJoin = async () =>
  (await hasColumn('market_listings', 'snap_item_id'))
    ? 'COALESCE(l.snap_item_id, i.item_id)'
    : 'i.item_id';

function _lot(r) {
  return {
    id: Number(r.id),
    price: Number(r.price),
    sellerId: Number(r.seller_id),
    sellerUsername: r.seller_username,
    createdAt: r.created_at,
    status: r.status,
    item: { id: r.item_id, enhance: r.enhance, qty: r.qty, name: r.item_name, rarity: r.rarity, slot: r.slot },
  };
}

// ── скільки лотів віддається за один перегляд ───────────────────────────────
// Стеля була 100 — і це та сама «на маркеті максимум 100 штук». На живій базі
// зараз 573 активні лоти, тобто гравцям не показували 82% ринку, мовчки: у
// відповіді немає нічого, що сказало б «є ще».
//
// Обрізання тут особливо шкідливе через те, як влаштований клієнт: пошук,
// фільтр за рідкістю, категорії з лічильниками й сортування він рахує САМ, по
// тому масиву, який отримав. Віддати сторінку означає не «показати менше», а
// збрехати: вкладка «Зброя 3» при трьох сотнях мечів на ринку, і «нічого не
// знайдено» на предмет, який там є.
//
// Тому стеля піднята до цілого ринку, але лишається СТЕЛЕЮ, а не зникає:
// LIMIT нікуди не дівається, і caller не може попросити більше — Math.min
// нижче зрізає будь-яке число до MARKET_BROWSE_MAX. Це безпечно саме тут, бо
// кількість активних лотів обмежена структурно: 5 на продавця, 10 з VIP 3+
// (_marketMaxActive), тож ринок не може розрости в мільйон рядків, скільки б
// не було гравців.
//
// Заміряно на живій базі, а не припущено: EXPLAIN ANALYZE цього запиту з
// LIMIT 1000 — 573 рядки за 2.3 мс (планувальник бере market_listings
// послідовно: у таблиці 696 рядків на 10 сторінках, і індекс market_browse_idx
// йому просто не потрібен на такому обсязі). Відповідь важить ~137 КБ.
//
// `offset` лишається в протоколі й далі працює: коли ринок доросте до стелі,
// клієнт зможе довантажувати сторінками, не змінюючи серверу нічого.
const MARKET_BROWSE_MAX = 1000;

// One join instead of the old "fetch listings, then look each seller up" — the
// N+1 that made browsing the market a per-row round trip.
async function browse(db, { limit = MARKET_BROWSE_MAX, offset = 0, slot = null } = {}) {
  const n = Math.floor(Number(limit));
  const take = Number.isSafeInteger(n) && n > 0 ? Math.min(n, MARKET_BROWSE_MAX) : MARKET_BROWSE_MAX;
  const { rows } = await query(db, `
    SELECT ${await listingCols()}
      FROM market_listings l
      JOIN players      s ON s.id = l.seller_id
      JOIN player_items i ON i.id = l.item_id
      JOIN item_catalog c ON c.item_id = i.item_id
     WHERE l.status = 'active' AND ($3::text IS NULL OR c.slot = $3)
     ORDER BY l.created_at DESC
     LIMIT $1 OFFSET $2`, [take, offset, slot]);
  return rows.map(_lot);
}

async function mine(db, playerId) {
  const { rows } = await query(db, `
    SELECT ${await listingCols()}
      FROM market_listings l
      JOIN players      s ON s.id = l.seller_id
      JOIN player_items i ON i.id = l.item_id
      JOIN item_catalog c ON c.item_id = i.item_id
     WHERE l.seller_id = $1 AND l.status = 'active'
     ORDER BY l.created_at DESC`, [playerId]);
  return rows.map(_lot);
}

// Closed lots this account was on either side of. The item row may since have
// moved on (or been consumed by a craft), so this LEFT JOINs it — history must
// survive the thing it describes.
//
// ── одна й та сама угода читається з ДВОХ боків ────────────────────────────
// Той самий рядок бачить і продавець, і покупець, і виглядати він має
// по-різному. Тому запис віддається вже РОЗВЕРНУТИМ на того, хто питає:
//
//   role        'sell' | 'buy' — своя сторона угоди;
//   counterpart нік другої сторони;
//   soldAt      коли угода закрилась (для знятого лоту — коли зняли).
//
// Ці три поля клієнт читає давно (_renderMarketHistoryTab, js/ui.js) — і не
// отримував жодного з них. Наслідок був рівно такий: `h.role` undefined, тобто
// не 'sell', тобто КОЖЕН рядок історії підписувався «Куплено» і показував суму
// зі знаком мінус — включно з власними продажами; а `h.counterpart` undefined
// прибирав нік другої сторони взагалі.
//
// Розвертання робиться тут, а не в обробнику, бо playerId — це і є те, що
// відрізняє один бік угоди від іншого, і запит уже приймає його параметром.
async function history(db, playerId, limit = 30) {
  const me = Number(playerId);
  const { rows } = await query(db, `
    SELECT ${await historyCols()}, l.buyer_id, l.closed_at,
           b.username AS buyer_username
      FROM market_listings l
      JOIN players       s ON s.id = l.seller_id
 LEFT JOIN players       b ON b.id = l.buyer_id
 LEFT JOIN player_items  i ON i.id = l.item_id
 LEFT JOIN item_catalog  c ON c.item_id = ${await historyCatalogJoin()}
     WHERE (l.seller_id = $1 OR l.buyer_id = $1) AND l.status <> 'active'
     ORDER BY l.closed_at DESC NULLS LAST
     LIMIT $2`, [playerId, Math.min(limit, 100)]);
  return rows.map(r => {
    const lot = _lot(r);
    const asSeller = lot.sellerId === me;
    return {
      ...lot,
      buyerId: r.buyer_id ? Number(r.buyer_id) : null,
      buyerUsername: r.buyer_username || null,
      closedAt: r.closed_at,
      role: asSeller ? 'sell' : 'buy',
      counterpart: asSeller ? (r.buyer_username || null) : (r.seller_username || null),
      soldAt: r.closed_at,
    };
  });
}

module.exports = { list, cancel, buy, browse, mine, history, byId, MarketError, MARKET_BROWSE_MAX };
