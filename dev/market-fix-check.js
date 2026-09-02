#!/usr/bin/env node
'use strict';
// ── Скарги з ринку, і чому кожна з них більше не відтворюється ──────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/market-fix-check.js
//
// Перша партія, дослівно:
//
//   1. «коли виставляєш на маркет айтеми то вони без нормальної аватарки, а
//      стрілка якась замість неї стоїть вправо вверх направлена»
//   2. «редкий ключ 296 штук выставляю за 1.8, нажимаю подтвердить —
//      выставляется 46 штук за эту цену»
//   3. «на маркеті не все відображається, максимум 100 штук»
//   4. «треба щоб можна було вибрати скільки штук предмета ти продаєш, по
//      дефолту 1»
//
// Друга — про те, що ринок РОЗПОВІДАЄ про вже закриту угоду:
//
//   5. «при продажі пише куплено, хоча продано»
//   6. «і пише -(вартість товару) замість +»
//   7. «показує не куплену кількість, а загальну в інвентарі»
//   8. «ім'я користувача, у якого куплено, не показує»
//
// Перші дві й остання — одна причина: сервер ніколи не надсилав role /
// counterpart / soldAt, хоч клієнт читає саме їх. Третя — інша: рядок
// проданого лоту зливається зі стаком покупця, тож після доставки він тримає
// вже весь стак. Перевіряються нижче окремими блоками, бо й ламались окремо.
//
// Перевіряється ПОВЕДІНКА, а не текст виправлення. Це принципово: перевірка,
// яка стежить за формулюванням рядка, зеленіє від будь-якого рефакторингу і
// червоніє від переставленого пробілу — тобто не знає нічого про те, працює
// код чи ні. Тому нижче ніде не написано «у файлі має бути такий рядок»;
// натомість запускається справжня клієнтська функція і питається, що вона
// намалювала, або справжня market.list() і питається, що вона поклала в лот.
//
// Дві половини:
//
//   КЛІЄНТ  js/ui.js виконується у vm — тим самим способом, яким
//           dev/prodfix-check.js перевіряє кольори цифр. Бандл у браузері
//           живе однією областю видимості (server/bundle-files.js), тож
//           файли просто зчіплюються в один контекст, а `document` та мережа
//           заміщені заглушками. Це дозволяє покликати onMarketListed() і
//           подивитись на HTML, який після цього малює рядок ринку.
//
//   БАЗА    market.list()/browse() ганяються по справжній базі, як у
//           dev/market-check.js, і прибирають за собою тим самим способом.
//
// Контроль «а чи може ця перевірка почервоніти» вбудований у кожен блок, де
// це можна зробити чесно: поруч із виправленим шляхом виконується СТАРИЙ і
// перевіряється, що він дає рівно ту поламану відповідь, на яку скаржились.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const market = require('../server/db/repos/market');
const { wipeItemsAll } = require('./fixtures');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);
const head = s => console.log(`\n  ── ${s} ──`);

// ════════════════════════════════════════════════════════════════════════════
//  КЛІЄНТ
// ════════════════════════════════════════════════════════════════════════════

// Мінімальний DOM. Кожен getElementById повертає той самий об'єкт для того
// самого id, тому перевірка може прочитати, що код у нього записав — це і є
// спосіб побачити поведінку, а не форму коду.
function stubEl(id) {
  return {
    id, style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', max: '', min: '',
    disabled: false, selectionStart: 0,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, remove() {}, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, getAttribute() { return null; },
    focus() {}, setSelectionRange() {}, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    scrollLeft: 0, scrollWidth: 0, clientWidth: 0,
  };
}

// `mutate` дозволяє завантажити той самий клієнт із підміненим рядком — так
// перевіряється, що присуд нижче справді вміє почервоніти на старому коді.
function loadClient(mutate) {
  const els = {};
  const sent = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Date, Number, String, Boolean, Array, Object, Map, Set, RegExp,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    performance: { now: () => 0 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'ru', userAgent: 'node' },
    document: {
      getElementById: id => (els[id] || null),
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => stubEl('created'), body: stubEl('body'),
      documentElement: stubEl('html'), addEventListener() {}, activeElement: null,
    },
    // Живуть у js/network.js, якого тут немає. Екранування — не предмет цієї
    // перевірки, тож заглушки навмисно тривіальні.
    _escHtml: s => String(s == null ? '' : s),
    _escAttr: s => String(s == null ? '' : s),
    netSaveProgressNow() {},
    netIsLive: () => true,
    netMarketList: (item, price) => { sent.push({ item, price }); },
    netMarketBrowse() {}, netMarketMyListings() {}, netMarketHistory() {},
    player: null,
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  // Ті самі файли й у тому самому порядку, що й у бандлі — інакше верхнього
  // рівня `const` з одного файлу не видно з іншого.
  const FILES = ['shared/definitions.js', 'js/constants.js', 'js/icons.js',
    'js/definitions.js', 'js/i18n.js', 'js/player.js', 'js/ui.js'];
  for (const f of FILES) {
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (mutate) src = mutate(f, src);
    vm.runInContext(src, ctx, { filename: f });
  }
  // Верхнього рівня let/const лексичні: властивостями глобального об'єкта
  // вони не стають, зате видимі наступним скриптам того самого контексту.
  const evalIn = code => vm.runInContext(code, ctx);
  return { ctx, els, sent, evalIn };
}

// Лот рівно в тій формі, в якій його надсилає сервер: тотожність предмета і
// нічого більше. Ні `img`, ні `icon` тут немає й ніколи не було — картинку
// клієнт бере з власного каталогу.
const serverLot = (id, itemId, qty) => ({
  id, price: 1.8, sellerId: 1, sellerUsername: 'tester',
  createdAt: new Date().toISOString(), status: 'active',
  item: { id: itemId, enhance: 0, qty, name: 'Редкий ключ', rarity: 'rare', slot: 'material' },
});

function clientChecks() {
  const { ctx, els, sent, evalIn } = loadClient(null);

  // ── 1. картинка щойно виставленого лоту ──────────────────────────────────
  head('щойно виставлений лот має картинку, а не стрілку');

  // Запасний значок _itemIcon — це iconHTML('weapon'), а він у ICON_SVG
  // намальований як діагональ із вістрям угору-праворуч. Саме його гравець і
  // описав. Перевірка питає не «чи є в коді виклик _marketEnrich», а «чи
  // намальована ця стрілка», тобто рівно те, що видно на екрані.
  const ARROW = evalIn('ICON_SVG.weapon');
  const keyImg = ctx.itemCatalogBase('key_rare').img;
  ok(typeof ARROW === 'string' && ARROW.length > 20 && typeof keyImg === 'string' && keyImg.length > 5,
    'є з чим порівнювати: запасний значок і картинка ключа знайдені',
    `arrow=${String(ARROW).slice(0, 20)}… img=${keyImg}`);

  const lot = serverLot(101, 'key_rare', 5);

  // КОНТРОЛЬ: те, що приходить із сервера, БЕЗ збагачення каталогом
  // малюється саме стрілкою. Це і є стара поведінка — тут вона відтворена, а
  // не описана словами.
  const rawHtml = evalIn('_marketRowHtml')(lot, 'mine');
  ok(rawHtml.includes(ARROW) && !rawHtml.includes('<img src='),
    'контроль: незбагачений лот справді малює стрілку замість картинки',
    rawHtml.slice(0, 120));

  // А тепер справжній шлях: подія marketListed від сервера.
  evalIn('_marketMine = []; _marketTab = "mine"; _pendingSellItem = null;');
  ctx.onMarketListed(lot);
  const stored = evalIn('_marketMine[0]');
  const html = evalIn('_marketRowHtml')(stored, 'mine');
  ok(!html.includes(ARROW), 'після marketListed рядок НЕ малює стрілку', html.slice(0, 160));
  ok(html.includes(`<img src="${keyImg}"`), 'а малює справжню картинку предмета з каталогу',
    html.slice(0, 160));

  // Те саме правило для решти списків — щоб виправлення не з'їхало назад на
  // один шлях із чотирьох.
  ctx.onMarketMyListingsData([serverLot(102, 'key_rare', 3)]);
  const viaMine = evalIn('_marketRowHtml')(evalIn('_marketMine[0]'), 'mine');
  ok(!viaMine.includes(ARROW) && viaMine.includes('<img src='),
    'і список «мої лоти» з сервера — теж із картинками');
  ctx.onMarketBrowseData([serverLot(103, 'key_rare', 3)]);
  const viaBrowse = evalIn('_marketRowHtml')(evalIn('_marketLots[0]'), 'buy');
  ok(!viaBrowse.includes(ARROW) && viaBrowse.includes('<img src='),
    'і вітрина ринку — теж');

  // ── 4. кількість: типово одна штука ──────────────────────────────────────
  head('кількість вибирається, типово одна штука');

  for (const id of ['market-pick-grid', 'market-sell-selected', 'market-sell-confirm',
    'market-qty-row', 'market-qty-input', 'market-qty-label', 'market-price-hint',
    'market-price-input', 'market-fee-preview', 'market-confirm-btn', 'market-body']) {
    els[id] = stubEl(id);
  }
  const stack = n => ({ ...ctx.itemCatalogBase('key_rare'), qty: n, rowId: 7 });

  ctx.player = { inventory: [stack(296)] };
  ctx._pickMarketSellItem(0);
  eq(Number(els['market-qty-input'].value), 1, 'стак на 296: поле кількості стоїть на 1');
  eq(Number(els['market-qty-input'].max), 296, 'а максимум поля — увесь стак');
  ok(String(els['market-qty-label'].textContent).includes('296'),
    'підпис поля називає, скільки штук узагалі є', els['market-qty-label'].textContent);

  // ПРАВИЛО, а не значення: типова кількість не залежить від розміру стака.
  // Стара поведінка (`value = have`) дала б тут 7, а не 1, тож цей присуд на
  // ній червоний.
  ctx.player = { inventory: [stack(7)] };
  ctx._pickMarketSellItem(0);
  eq(Number(els['market-qty-input'].value), 1, 'стак на 7: те саме поле знову стоїть на 1');

  // ── і на дріт іде саме те, що вибрано ────────────────────────────────────
  ctx.player = { inventory: [stack(296)] };
  ctx._pickMarketSellItem(0);
  els['market-price-input'].value = '1.8';
  sent.length = 0;
  evalIn('_pendingSellItem = null;');
  ctx._confirmMarketList();
  eq(sent.length, 1, 'натиснули «виставити» — запит пішов');
  eq(sent[0] && sent[0].item.qty, 1, 'і несе кількість 1, а не увесь стак');

  els['market-qty-input'].value = '10';
  ctx._clampMarketQtyInput();
  sent.length = 0;
  evalIn('_pendingSellItem = null;');
  ctx._confirmMarketList();
  eq(sent[0] && sent[0].item.qty, 10, 'вибрали 10 — на сервер їде 10');

  // Підказка ціни називає кількість: «1.8» за 296 ключів і «1.8» за один
  // ключ інакше виглядають однаково.
  ok(String(els['market-price-hint'].textContent).includes('10'),
    'підказка ціни називає кількість, за яку призначається ціна',
    els['market-price-hint'].textContent);

  // Клієнт не дає надіслати більше, ніж є (сервер усе одно перевірить сам).
  els['market-qty-input'].value = '99999';
  ctx._clampMarketQtyInput();
  sent.length = 0;
  evalIn('_pendingSellItem = null;');
  ctx._confirmMarketList();
  eq(sent[0] && sent[0].item.qty, 296, 'більше, ніж є, надіслати не можна — обрізано до 296');

  // ── 3. клієнт каже, коли список обрізаний ────────────────────────────────
  head('обрізаний ринок більше не мовчить');
  const CAP = evalIn('MARKET_BROWSE_MAX');
  ok(CAP > 100, 'клієнтське дзеркало стелі видачі більше за стару сотню', `MARKET_BROWSE_MAX=${CAP}`);
  const body = els['market-body'];

  evalIn('_marketLoaded.lots = true;');
  evalIn(`_marketLots = Array.from({length: ${CAP}}, (_, i) => ({
    id: i + 1, price: 1, sellerUsername: 'x',
    item: { id: 'key_rare', enhance: 0, qty: 1, name: 'k', rarity: 'rare', slot: 'material' } }));`);
  ctx._renderMarketLots(body);
  ok(body.innerHTML.includes('market-truncated'),
    'коли видача впирається в стелю — гравцю про це сказано');

  evalIn('_marketLots = _marketLots.slice(0, 3);');
  ctx._renderMarketLots(body);
  ok(!body.innerHTML.includes('market-truncated'),
    'а коли ринок поміщається — жодного попередження');
}

// ════════════════════════════════════════════════════════════════════════════
//  БАЗА
// ════════════════════════════════════════════════════════════════════════════

const TAG = 'mfix-' + process.pid;
const made = [];
const KEY = 'key_rare';
const BLESS = 'bless_stone';
const SWORD = 'sw1';

async function mkPlayer(nick, gram = 0) {
  const { rows } = await pool().query(
    'INSERT INTO players (telegram_id, username) VALUES ($1,$2) RETURNING id',
    [`${TAG}-${nick}`, `${TAG}_${nick}`]);
  const id = Number(rows[0].id);
  made.push(id);
  if (gram) await money.credit(null, id, 'gram', gram, { reason: 'seed', idemKey: `${TAG}:seed:${id}` });
  return id;
}
const add = (pid, itemId, qty) => tx(async t => {
  await items.lockPlayer(t, pid);
  return items.add(t, pid, itemId, { qty, source: 'admin', sourceRef: TAG });
});
const invOf = async pid => (await items.inventoryOf(null, pid)).inventory;
const heldOf = async (pid, itemId) =>
  (await invOf(pid)).filter(r => r.id === itemId).reduce((n, r) => n + (r.qty || 0), 0);
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };
const listedRow = async listingId => Number((await pool().query(
  'SELECT item_id FROM market_listings WHERE id = $1', [listingId])).rows[0].item_id);
const listedQty = async listingId => Number((await pool().query(
  `SELECT i.qty FROM market_listings l JOIN player_items i ON i.id = l.item_id WHERE l.id = $1`,
  [listingId])).rows[0].qty);

// Відтворює ту саму форму інвентаря, яку показала жива база: один предмет,
// два рядки, і СТАРШИЙ рядок — менший. Клієнт малює обидва рядки однією
// купкою і бере rowId першого — звідси «296 виставляю, виставляється 46».
//
// Рядки будуються ПРЯМИМ записом. Раніше вони будувались через
// attachFromListing — доставку купленого лоту, — бо саме вона їх і плодила:
// items.add() зливав стак у наявний рядок, а вона просто чіпляла відчеплений
// рядок поруч. Тепер зливають обидві (див. items.mergeStacks), і побудова
// через неї давала б ОДИН рядок — тобто перевірка мовчки перестала б
// перевіряти те, заради чого написана.
//
// А розкол лишається вартим захисту: у живій базі таких купок 108 у 20
// гравців, і виставлення мусить забирати всю купку, хай як вона лежить.
async function splitStack(nick, small, big) {
  const seller = await mkPlayer(nick);
  const rowSmall = await add(seller, KEY, small);       // старший рядок — менший
  const { rows } = await pool().query(
    `INSERT INTO player_items (player_id, container, item_id, enhance, qty)
     VALUES ($1, 'inventory', $2, 0, $3) RETURNING id`, [seller, KEY, big]);
  const rowBig = Number(rows[0].id);
  // Рядок вставлено повз items.add, тож і запис у реєстр треба зробити самому:
  // без нього звірка «на руках проти реєстру» побачила б розбіжність, якої
  // насправді немає, і звинуватила б у ній гру замість фікстури.
  await tx(t => items.ledger(t, seller, KEY, big,
    { rowId: rowBig, reason: 'test_seed', refType: 'row', refId: TAG }));
  return { seller, rowSmall, rowBig };
}

// І окремо — що шлях доставки лоту більше НЕ плодить другий рядок. Це причина,
// з якої розколи взагалі з'являлись; полагоджено її, а не наслідок.
async function deliveryMerges() {
  head('доставка купленого лоту зливається в наявну купку');
  const buyer = await mkPlayer('merge');
  await add(buyer, KEY, 40);
  const holder = await mkPlayer('mergeH');
  const rowBig = await add(holder, KEY, 60);
  await tx(t => items.detachForListing(t, rowBig, holder));
  await tx(t => items.attachFromListing(t, rowBig, buyer,
    { reason: 'market_buy', refType: 'listing', refId: TAG }));
  const inv = await invOf(buyer);
  const mine = inv.filter(r => r.id === KEY);
  eq(mine.length, 1, 'купка лишилась ОДНИМ рядком, а не двома');
  eq(mine.reduce((n, r) => n + Number(r.qty), 0), 100, 'і в ній усе, що було й приїхало');
}

async function dbChecks() {
  await tx(t => items.syncCatalog(t));

  // ── 2. «296 виставляю — виставляється 46» ────────────────────────────────
  head('стак, розкладений на два рядки, виставляється весь');

  await deliveryMerges();

  head('стак, розкладений на два рядки, виставляється весь');
  const a = await splitStack('old', 46, 250);
  const invA = await invOf(a.seller);
  eq(invA.filter(r => r.id === KEY).length, 2, 'відтворено: предмет лежить двома рядками');
  eq(await heldOf(a.seller, KEY), 296, 'разом у продавця 296 штук — те саме число, що бачив гравець');
  ok(invA.find(r => r.id === KEY).rowId === a.rowSmall,
    'і перший рядок (той, чий rowId бере клієнт) — саме той, де 46');

  // КОНТРОЛЬ: старий шлях (виставити рядок, не називаючи кількість) дає рівно
  // ті 46, на які скаржився гравець. Це не переказ баги словами — це вона.
  const oldLot = await tx(t => market.list(t, a.seller, a.rowSmall, 1.8));
  eq(oldLot.item.qty, 46, 'контроль: лот «по рядку» бере 46 із 296 — саме поламана відповідь');

  const b = await splitStack('new', 46, 250);
  const newLot = await tx(t => market.list(t, b.seller, b.rowSmall, 1.8, { qty: 296 }));
  eq(newLot.item.qty, 296, 'а з названою кількістю на ринок їде всі 296');
  eq(await listedQty(newLot.id), 296, 'і в рядку, який тримає лот, теж 296');
  eq(await heldOf(b.seller, KEY), 0, 'у продавця не лишилось жодного ключа');

  // Розщеплений шматок стака — це НОВИЙ рядок player_items. Рух до нього має
  // бути записаний у реєстрі саме на цей рядок, інакше покупець отримає
  // предмет, про походження якого items.historyOfRow() не знає нічого — рівно
  // ту дірку, яку описує dev/item-ledger-check.js.
  const newRowId = await listedRow(newLot.id);
  const hist = await items.historyOfRow(null, newRowId);
  ok(hist.some(h => h.delta === -296 && h.reason === 'market_list'),
    'і реєстр знає, звідки взявся цей рядок — historyOfRow відповідає на нього',
    JSON.stringify(hist));

  // ── 4. кількість, і що сервер із неї перевіряє ───────────────────────────
  head('сервер поважає кількість і перевіряє її сам');

  const c = await mkPlayer('one');
  const cRow = await add(c, KEY, 296);
  const one = await tx(t => market.list(t, c, cRow, 1.8, { qty: 1 }));
  eq(one.item.qty, 1, 'просили 1 — виставлено 1');
  eq(await listedQty(one.id), 1, 'і лот тримає рівно одну штуку');
  eq(await heldOf(c, KEY), 295, 'решта 295 лишилась у продавця');

  const d = await mkPlayer('greedy');
  const dRow = await add(d, KEY, 10);
  eq(await caught(() => tx(t => market.list(t, d, dRow, 1.8, { qty: 11 }))), 'bad_qty',
    'просити більше, ніж маєш, — відмова (клієнту не вірять)');
  eq(await heldOf(d, KEY), 10, 'і після відмови інвентар недоторканий');

  const e = await mkPlayer('nonstack');
  const eRow = await add(e, SWORD, 1);
  await add(e, SWORD, 1);
  eq(await caught(() => tx(t => market.list(t, e, eRow, 10, { qty: 2 }))), 'bad_qty',
    'нестаковий предмет не можна виставити пачкою');
  eq(await heldOf(e, SWORD), 2, 'обидва мечі лишились у власника');

  const f = await mkPlayer('legacy');
  const fRow = await add(f, KEY, 33);
  const legacy = await tx(t => market.list(t, f, fRow, 1));
  eq(legacy.item.qty, 33, 'без названої кількості лот, як і раніше, забирає рядок цілком');

  // ── і те саме через справжній обробник події ─────────────────────────────
  // Усе вище кличе market.list() напряму, тому не бачить одного: чи доїжджає
  // кількість із запиту клієнта до репозиторія взагалі. Саме там її і не було
  // — обробник читав з payload лише `item` та `price`, а `item.qty` мовчки
  // губився. Тому тут піднімається справжній registerEconomy із заглушками
  // замість сокета, і подія 'marketList' надсилається так, як її шле клієнт.
  head('кількість доїжджає від події клієнта до бази');
  const registerEconomy = require('../server/handlers2/economy');
  const handlers = {};
  const sess = {
    act: (name, errEvent, fn) => tx(t => fn(t, sess._pid)),
    socket: { emit() {} },
    pushItems: async () => {}, pushBalances: async () => {}, pushStats: async () => {},
    _pid: null,
  };
  registerEconomy(sess, (name, fn) => { handlers[name] = fn; }, {});
  ok(typeof handlers.marketList === 'function', 'обробник marketList зареєстровано');

  const w = await mkPlayer('wire');
  const wRow = await add(w, KEY, 50);
  sess._pid = w;
  const wired = await handlers.marketList({
    item: { rowId: wRow, id: KEY, enhance: 0, qty: 7 }, price: 1,
  });
  eq(wired.item.qty, 7, 'клієнт попросив 7 — подія довезла 7 до лоту');
  eq(await heldOf(w, KEY), 43, 'і саме 7 пішло з інвентаря, а не весь стак');

  // Підлога ціни рахується від ВИБРАНОЇ кількості, а не від рядка. Обидва
  // напрямки помилки реальні: від рядка — один камінь коштував би як 500,
  // від штуки — 500 каменів пішли б за ціною одного (це і є мулінг, заради
  // якого підлога існує).
  head('підлога ціни рахується від того, що справді продається');
  const g = await mkPlayer('bless1');
  const gRow = await add(g, BLESS, 500);
  const gLot = await tx(t => market.list(t, g, gRow, 1.5, { qty: 1 }));
  eq(gLot.item.qty, 1, 'один камінь за 1.5 GRAM — прийнято (підлога 1.5 за штуку)');

  const h = await mkPlayer('bless2');
  const hRow = await add(h, BLESS, 500);
  eq(await caught(() => tx(t => market.list(t, h, hRow, 1.5, { qty: 500 }))), 'bad_price',
    'а 500 каменів за ті самі 1.5 GRAM — відмова: підлога 750');
  eq(await heldOf(h, BLESS), 500, 'і стак лишився на місці');

  // ── предмети не народжуються і не зникають від розщеплення ───────────────
  head('розщеплення стака нічого не створює і не втрачає');
  const mine = made.map(Number);
  const drift = ((await items.reconcile(null)) || []).filter(r => mine.includes(r.playerId));
  eq(drift.length, 0, 'реєстр предметів сходиться з тим, що на руках',
    JSON.stringify(drift.slice(0, 3)));
  const mDrift = (await money.reconcile(null)).filter(r => mine.includes(r.playerId));
  eq(mDrift.length, 0, 'і грошова звірка теж чиста');

  // ── 3. «максимум 100 штук» ───────────────────────────────────────────────
  head('ринок віддається цілком, а не першою сотнею');

  // Той самий набір з'єднань, що й у browse(): рахувати треба те саме, що
  // вона віддає, інакше різниця означатиме не стелю, а неспівпадіння join'ів.
  const countActive = async () => Number((await pool().query(`
    SELECT count(*)::int n
      FROM market_listings l
      JOIN players      s ON s.id = l.seller_id
      JOIN player_items i ON i.id = l.item_id
      JOIN item_catalog c ON c.item_id = i.item_id
     WHERE l.status = 'active'`)).rows[0].n);

  // Ринок живий: між двома запитами хтось міг щось виставити. Тому пара
  // «порахувати / прочитати» повторюється, доки не збіжиться, — це прибирає
  // мигтіння, не послаблюючи присуду.
  let N = 0, all = [], capped = [];
  for (let i = 0; i < 4; i++) {
    N = await countActive();
    all = await market.browse(null, {});
    capped = await market.browse(null, { limit: 100 });
    if (N === await countActive()) break;
  }
  const CAP = market.MARKET_BROWSE_MAX;
  ok(CAP >= 500, 'стеля видачі browse піднята', `MARKET_BROWSE_MAX=${CAP}`);
  eq(all.length, Math.min(N, CAP), `browse віддає весь активний ринок (${N} лотів) до стелі`);
  eq(capped.length, Math.min(N, 100), 'контроль: зі старою сотнею віддалося б рівно 100');
  ok(N <= 100 || all.length > capped.length,
    `і різниця — це саме ті лоти, яких гравці не бачили (${all.length} проти ${capped.length})`);
  const huge = await market.browse(null, { limit: 1e9 });
  eq(huge.length, Math.min(N, CAP), 'клієнт не може підняти стелю власним limit — запит лишається обмеженим');
}

// ════════════════════════════════════════════════════════════════════════════
//  ЗАКРИТА УГОДА: свій бік, свій знак, своя кількість, своє ім'я
// ════════════════════════════════════════════════════════════════════════════
//
// Тут разом обидві половини — база й клієнт, — бо скарга саме про стик: одна
// угода, два боки, і рядок історії має виглядати по-різному в кожного.
async function historyChecks() {
  head('закрита угода: кількість — куплена, а не вся в інвентарі');

  const seller = await mkPlayer('hsell');
  const buyer  = await mkPlayer('hbuy', 100);
  // Покупець УЖЕ тримає 50 таких самих ключів. Саме цей стак і підмінював
  // число в обох тостах: доставлений рядок вливається в нього, і читання
  // «що ж приїхало» після доставки бачило 53 замість 3.
  await add(buyer, KEY, 50);
  const sellerRow = await add(seller, KEY, 30);
  const lot = await tx(t => market.list(t, seller, sellerRow, 10, { qty: 3 }));
  const sold = await tx(t => market.buy(t, buyer, lot.id));

  eq(sold.item && sold.item.qty, 3, 'buy() каже, що продано 3 — саме стільки, скільки в лоті');
  eq(await heldOf(buyer, KEY), 53, 'контроль: у покупця на руках справді 53 — число, яке бралося раніше');
  eq(await heldOf(seller, KEY), 27, 'а у продавця лишилось 27 із 30');

  // ── і те саме в історії ──────────────────────────────────────────────────
  head('закрита угода читається з обох боків');

  const sellerHist = (await market.history(null, seller)).filter(h => h.id === lot.id);
  const buyerHist  = (await market.history(null, buyer)).filter(h => h.id === lot.id);
  eq(sellerHist.length, 1, 'продавець бачить угоду в історії');
  eq(buyerHist.length, 1, 'і покупець теж');

  const sh = sellerHist[0] || {}, bh = buyerHist[0] || {};
  eq(sh.role, 'sell', 'у продавця це ПРОДАЖ, а не покупка');
  eq(bh.role, 'buy', 'а в покупця — покупка');
  eq(sh.counterpart, `${TAG}_hbuy`, "продавцю названо, ХТО купив");
  eq(bh.counterpart, `${TAG}_hsell`, 'а покупцю — у кого куплено');
  eq(sh.item && sh.item.qty, 3, 'в історії продавця кількість — продані 3');
  eq(bh.item && bh.item.qty, 3, 'і в історії покупця теж 3, а не 53 з його інвентаря');
  ok(sh.soldAt != null, 'угода має час закриття, а не лише час виставлення');
  ok(sh.price === 10 && bh.price === 10, 'і ціну, однакову з обох боків');

  // Знімок лоту не змінюється від того, що покупець зробить із річчю далі:
  // саме тому історія бере його, а не живий рядок.
  await tx(t => items.add(t, buyer, KEY, { qty: 200, source: 'admin', sourceRef: TAG }));
  const afterMore = (await market.history(null, seller)).filter(h => h.id === lot.id)[0] || {};
  eq(afterMore.item && afterMore.item.qty, 3,
    'покупець доклав ще 200 — в історії продажу все одно 3');

  // ── і як це малюється ────────────────────────────────────────────────────
  // Тими самими рядками, які щойно віддала база, через справжній рендерер
  // вкладки «Історія». Перевіряється те, що видно на екрані.
  head('рядок історії малює «Продано», плюс, кількість і ніка');

  const { ctx, els, evalIn } = loadClient(null);
  els['market-body'] = stubEl('market-body');
  const draw = rows => {
    evalIn('_marketLoaded.history = true;');
    ctx.onMarketHistoryData(rows);
    const el = stubEl('hist');
    ctx._renderMarketHistoryTab(el);
    return el.innerHTML;
  };

  const sellHtml = draw([sh]);
  ok(sellHtml.includes(ctx.t('soldLbl')), 'продавець бачить «Продано»', sellHtml.slice(0, 200));
  ok(!sellHtml.includes(ctx.t('boughtLbl')), 'і ніде не «Куплено»');
  ok(sellHtml.includes('>+9.00'), 'сума зі знаком ПЛЮС і за вирахуванням комісії', sellHtml.slice(-200));
  ok(sellHtml.includes(`@${TAG}_hbuy`), 'і ніка покупця в рядку', sellHtml.slice(0, 300));
  ok(sellHtml.includes('\u00d73'), 'і кількість — 3', sellHtml.slice(0, 300));

  const buyHtml = draw([bh]);
  ok(buyHtml.includes(ctx.t('boughtLbl')), 'покупець бачить «Куплено»');
  ok(buyHtml.includes('>-10.00'), 'і мінус повну ціну — він же платив', buyHtml.slice(-200));
  ok(buyHtml.includes(`@${TAG}_hsell`), 'і ніка продавця');

  // КОНТРОЛЬ: рівно та відповідь, на яку скаржились. Стара форма — це запис
  // БЕЗ role і counterpart, тобто те, що сервер надсилав насправді.
  const legacyRow = { ...sh };
  delete legacyRow.role; delete legacyRow.counterpart; delete legacyRow.soldAt;
  const legacyHtml = draw([legacyRow]);
  ok(legacyHtml.includes(ctx.t('boughtLbl')) && legacyHtml.includes('>-10.00')
     && !legacyHtml.includes('@'),
    'контроль: без цих полів власний ПРОДАЖ і справді малювався «Куплено» з мінусом і без ніка',
    legacyHtml.slice(0, 200));

  // ── зняття лоту повертає те, що в ньому лежало ───────────────────────────
  head('знятий лот повертає свою кількість, а не весь стак');
  const back = await mkPlayer('hcancel');
  await add(back, BLESS, 40);
  const backRow = (await invOf(back)).find(r => r.id === BLESS).rowId;
  const backLot = await tx(t => market.list(t, back, backRow, 10, { qty: 5 }));
  const cancelled = await tx(t => market.cancel(t, back, backLot.id));
  eq(cancelled.item && cancelled.item.qty, 5, 'повернулось саме 5 — рівно те, що було в лоті');
  eq(await heldOf(back, BLESS), 40, 'і на руках знову всі 40');
}

async function cleanup() {
  if (!made.length) return;
  const q = (s, p) => pool().query(s, p).catch(() => {});

  // ── які рядки тримають наші лоти, треба спитати ДО того, як лоти зникнуть ─
  // Виставлений предмет має player_id NULL, тож wipeItems його не бачить —
  // єдине, що на нього посилається, це сам лот. dev/market-check.js робить цей
  // DELETE ПІСЛЯ видалення лотів, коли посилатися вже нема чому, і тому не
  // знаходить нічого: після кожного прогону в player_items лишаються
  // відчеплені рядки. Тут порядок зворотний.
  const { rows: held } = await pool().query(
    'SELECT item_id FROM market_listings WHERE seller_id = ANY($1) AND item_id IS NOT NULL',
    [made]).catch(() => ({ rows: [] }));
  const heldIds = held.map(r => Number(r.item_id));

  await q('DELETE FROM market_listings WHERE seller_id = ANY($1) OR buyer_id = ANY($1)', [made]);
  await wipeItemsAll(made).catch(() => {});

  // player_id IS NULL — не формальність, а запобіжник. Лоти цього прогону
  // висять на ЖИВОМУ ринку кілька секунд, і справжній гравець устигає їх
  // купити. Куплений рядок належить йому, і видалити його означало б забрати
  // в людини куплений предмет.
  if (heldIds.length) {
    await q('DELETE FROM player_items WHERE id = ANY($1) AND player_id IS NULL', [heldIds]);
  }
  // Розщеплений шматок стака народжується вже нічиїм і власного запису в
  // реєстрі не має — знайти його можна тільки по провенансу, скопійованому з
  // вихідного рядка (він несе наш TAG). Той самий запобіжник: тільки нічиї.
  await q('DELETE FROM player_items WHERE player_id IS NULL AND source_ref = $1', [TAG]);

  await q('DELETE FROM ledger   WHERE player_id = ANY($1)', [made]);
  await q('DELETE FROM balances WHERE player_id = ANY($1)', [made]);
  await q('DELETE FROM players  WHERE id = ANY($1)', [made]);
}

(async () => {
  console.log(`\nmarket-fix-check  (${TAG})`);
  clientChecks();
  await dbChecks();
  await historyChecks();
})()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
