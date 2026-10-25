#!/usr/bin/env node
'use strict';
// ── Достижения: от действия до награды в сумке ─────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/achievements-check.js
//
// Две части.
//
// 1. Каталог (shared/definitions.js, ACHIEVEMENTS). Битый id награды — это
//    достижение, которое нельзя забрать никогда: items.add бросит, выдача
//    откатится, и кнопка будет гореть вечно. Метрика, которую никто не
//    двигает, — достижение, которое нельзя выполнить. Подпись, которой нет
//    в i18n, — строка «achM_runeCommon» на экране у игрока.
//
// 2. Живой путь, через настоящий сокет: ковка руны двигает счётчик своей
//    редкости, заточка — «лучший уровень», «Забрать» кладёт в сумку руну с
//    выпавшими характеристиками, второй раз не кладёт, невыполненное не
//    отдаёт, а при полной сумке награда не теряется — её можно забрать снова.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const io = require('socket.io-client');

const PORT = Number(process.env.ACH_CHECK_PORT || 3179);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';
delete process.env.MOVE_GUARD;

const D = require('../shared/definitions');
const { ACHIEVEMENTS, ACH_METRICS, ACH_CATEGORIES } = D;

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);
const finish = async (close) => {
  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} прошло, 0 упало\x1b[0m\n`
    : `  \x1b[31m${pass} прошло, ${fail} упало\x1b[0m\n`);
  if (close) await close();
  process.exit(fail === 0 ? 0 : 1);
};

// ── 1. каталог ─────────────────────────────────────────────────────────────
console.log('  ── каталог ──');
ok(ACHIEVEMENTS.length >= 50, `достижений не меньше 50 (${ACHIEVEMENTS.length})`);
const ids = ACHIEVEMENTS.map(a => a.id);
eq(new Set(ids).size, ids.length, 'id достижений не повторяются');
const badMetric = ACHIEVEMENTS.filter(a => !Object.hasOwn(ACH_METRICS, a.metric)).map(a => a.id);
eq(badMetric.join(','), '', 'у каждого достижения метрика из ACH_METRICS');
const badCat = Object.entries(ACH_METRICS).filter(([, m]) => !ACH_CATEGORIES.includes(m.cat)).map(([k]) => k);
eq(badCat.join(','), '', 'у каждой метрики категория из ACH_CATEGORIES');
const badTarget = ACHIEVEMENTS.filter(a => !(Number.isSafeInteger(a.target) && a.target > 0)).map(a => a.id);
eq(badTarget.join(','), '', 'цель — целое больше нуля');
const noReward = ACHIEVEMENTS.filter(a => !Array.isArray(a.rewards) || !a.rewards.length).map(a => a.id);
eq(noReward.join(','), '', 'у каждого достижения есть награда');

const badReward = [];
for (const a of ACHIEVEMENTS) {
  for (const r of a.rewards || []) {
    if (r.t === 'rune') {
      if (!D.ITEM_DEF.some(d => d.id === D.runeCatalogId(r.kind, r.rarity))) badReward.push(a.id);
    } else if (r.t === 'item') {
      if (!D.itemCatalogBase(r.id) || !(r.qty > 0)) badReward.push(a.id);
    } else if (r.t === 'gold' || r.t === 'nexum') {
      if (!(r.n > 0)) badReward.push(a.id);
    } else badReward.push(a.id);
  }
}
eq(badReward.join(','), '', 'каждая награда — существующий предмет, руна или валюта');

// Каждую руну по редкости можно заработать ковкой этой же редкости — то, о
// чём просил владелец («скрафти 10 серых — получи серую»).
for (const rar of D.RUNE_RARITIES) {
  const m = 'rune' + rar.charAt(0).toUpperCase() + rar.slice(1);
  const first = ACHIEVEMENTS.filter(a => a.metric === m).sort((x, y) => x.target - y.target)[0];
  ok(first && first.rewards.some(r => r.t === 'rune' && r.rarity === rar),
    `первая цель ковки «${rar}» награждает руной той же редкости`);
}

// Метрику кто-то двигает. Ищется вызов ach.bumpIn/bumpSoon с её именем в
// сервере; руны по редкости собираются из 'rune' + редкость — их видно по
// самой строке сборки.
const SRC = ['server/handlers2', 'server'].flatMap(dir =>
  fs.readdirSync(path.join(__dirname, '..', dir)).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(__dirname, '..', dir, f), 'utf8'))).join('\n');
const unbumped = Object.entries(ACH_METRICS).filter(([k, m]) => {
  if (m.kind === 'lvl') return !/ach\.onLevel\(/.test(SRC);
  if (/^rune(Common|Uncommon|Rare|Epic|Legendary)$/.test(k)) return !/ach\.bumpIn\(t, s, 'rune' \+ rarity/.test(SRC);
  return !new RegExp(`ach\\.bumpIn\\([^)]*'${k}'`).test(SRC);
}).map(([k]) => k);
eq(unbumped.join(','), '', 'каждую метрику двигает сервер');

const I18N = fs.readFileSync(path.join(__dirname, '..', 'js/i18n.js'), 'utf8');
const LANGS = ['ru', 'en', 'uk', 'es', 'tr', 'pt'];
const noText = [...Object.keys(ACH_METRICS).map(k => 'achM_' + k), ...ACH_CATEGORIES.map(c => 'achCat_' + c)]
  .filter(key => {
    const line = I18N.split('\n').find(l => l.trimStart().startsWith(key + ':'));
    return !line || LANGS.some(l => !new RegExp(`\\b${l}: '`).test(line));
  });
eq(noText.join(','), '', 'у каждой метрики и категории есть подпись на всех шести языках');

if (!process.env.DATABASE_URL) {
  console.log('\n  DATABASE_URL не задан — живая часть пропущена');
  finish();
}

// ── 2. живой путь ──────────────────────────────────────────────────────────
const { pool, close, tx } = require('../server/db');
const items = require('../server/db/repos/items');
const { wipeItems } = require('./fixtures');
const app = require('../server/app');
const SERVER_INV_MAX = 150;

const TAG = 'ach-' + String(process.pid).slice(-5) + '_t';
const TG = 951000000 + (process.pid % 100000);

function initDataFor(id, username) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA',
    user: JSON.stringify({ id, first_name: username, username }),
  });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const once = (sock, ev, ms = 10000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
// Ответ на achClaim — либо achClaimed, либо achError; кто первый.
const claimReply = (sock, ms = 8000) => new Promise((res) => {
  const to = setTimeout(() => { sock.off('achClaimed', a); sock.off('achError', b); res({ ev: 'timeout' }); }, ms);
  const a = d => { clearTimeout(to); sock.off('achError', b); res({ ev: 'achClaimed', d }); };
  const b = d => { clearTimeout(to); sock.off('achClaimed', a); res({ ev: 'achError', d }); };
  sock.once('achClaimed', a); sock.once('achError', b);
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const q = (sql, args) => pool().query(sql, args);
const metric = async (pid, m) => {
  const { rows } = await q('SELECT value FROM player_ach_progress WHERE player_id = $1 AND metric = $2', [pid, m]);
  return rows.length ? Number(rows[0].value) : 0;
};
const countItem = async (pid, id) => {
  const { rows } = await q(`SELECT COALESCE(sum(qty), 0)::int n FROM player_items
                             WHERE player_id = $1 AND item_id = $2`, [pid, id]);
  return rows[0].n;
};

(async () => {
  await app.boot();
  const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  sock.emit('loginTelegramWebApp', { initData: initDataFor(TG, TAG) });
  await once(sock, 'authOk');
  const { rows } = await q('SELECT id FROM players WHERE telegram_id = $1', [String(TG)]);
  const pid = Number(rows[0].id);
  sock.emit('selectChar', { type: 'warlock' });
  await once(sock, 'gameStart', 12000).catch(() => null);
  await wait(500);

  console.log('  ── состояние ──');
  sock.emit('achSync');
  const st0 = await once(sock, 'achState');
  eq(st0.ready, true, 'таблицы на месте — окно не говорит «скоро»');
  eq(st0.claimed.length, 0, 'у нового игрока ничего не забрано');
  eq(st0.metrics.lvl, 1, 'уровень читается из персонажа');

  // ── ковка руны двигает счётчик своей редкости ────────────────────────────
  console.log('  ── ковка руны ──');
  const ORE = D.RUNE_ORE_COST.armor.common;
  await tx(async (t) => { await items.lockPlayer(t, pid); await items.add(t, pid, 'ore_common', { qty: ORE * 25, source: 'test' }); });
  let wins = 0, losses = 0, readySeen = [];
  sock.on('achReady', d => { readySeen = readySeen.concat((d && d.ids) || []); });
  for (let i = 0; i < 25 && (wins < 1 || losses < 1); i++) {
    const done = once(sock, 'runeCrafted', 8000).catch(() => null);
    sock.emit('craftRune', { kind: 'armor', rarity: 'common' });
    const r = await done;
    if (r && r.delivered) wins++; else if (r) losses++;
    await wait(150);
  }
  ok(wins > 0 && losses > 0, `за попытки вышли и удача, и неудача (${wins}/${losses})`);
  eq(await metric(pid, 'runeCommon'), wins + losses, 'каждая попытка ковки — в счётчик обычных рун, удачная или нет');
  eq(await metric(pid, 'runeFail'), losses, 'неудачные — в «невезучего кузнеца»');
  eq(await metric(pid, 'runeRare'), 0, 'чужая редкость не тронута');

  // ── невыполненное не отдаётся ────────────────────────────────────────────
  console.log('  ── выдача ──');
  let rep = claimReply(sock);
  sock.emit('achClaim', { id: 'rune_common_10' });
  rep = await rep;
  eq(rep.ev, 'achError', 'невыполненное достижение не выдаётся');
  sock.emit('achClaim', { id: 'constructor' });
  rep = await claimReply(sock);
  eq(rep.ev, 'achError', 'несуществующий id — отказ, а не падение');

  // 10 обычных рун — дорого гонять честно (30% шанс), поэтому счётчик
  // доводится до цели напрямую; сама ковка проверена выше.
  await q(`UPDATE player_ach_progress SET value = 10 WHERE player_id = $1 AND metric = 'runeCommon'`, [pid]);
  const runesBefore = await countItem(pid, 'rune_armor_common');
  rep = claimReply(sock);
  sock.emit('achClaim', { id: 'rune_common_10' });
  rep = await rep;
  eq(rep.ev, 'achClaimed', '«Скуй 10 серых рун» — награда выдана');
  const granted = rep.d && rep.d.granted && rep.d.granted[0];
  eq(await countItem(pid, 'rune_armor_common') - runesBefore, 1, 'в сумке на одну серую руну больше');
  const { rows: rr } = await q('SELECT rune FROM player_items WHERE id = $1', [granted ? granted.rowId : 0]);
  ok(rr.length && rr[0].rune && Array.isArray(rr[0].rune.stats) && rr[0].rune.stats.length === D.RUNE_STAT_COUNT.common,
    'у выданной руны выпали характеристики, как из кузницы', JSON.stringify(rr[0] && rr[0].rune));

  rep = claimReply(sock);
  sock.emit('achClaim', { id: 'rune_common_10' });
  rep = await rep;
  eq(rep.ev, 'achError', 'второй раз та же награда не выдаётся');
  eq(await countItem(pid, 'rune_armor_common') - runesBefore, 1, 'и руна не удвоилась');

  // ── заточка: лучший уровень — максимум, а не сумма ───────────────────────
  console.log('  ── заточка ──');
  let gearRow = await tx(async (t) => {
    await items.lockPlayer(t, pid);
    await items.add(t, pid, 'bless_stone', { qty: 40, source: 'test' });
    return items.add(t, pid, 'nd3', { qty: 1, source: 'test' });
  });
  let best = 0, okCount = 0;
  for (let i = 0; i < 40 && best < 3; i++) {
    const done = once(sock, 'enhanceResult', 8000).catch(() => null);
    sock.emit('enhanceItem', { rowId: gearRow, stoneType: 'bless' });
    const r = await done;
    if (r && r.outcome === 'success') { okCount++; best = Math.max(best, r.to); }
    await wait(120);
  }
  ok(best >= 1, `заточка удалась хотя бы раз (лучший +${best})`);
  eq(await metric(pid, 'enhMax'), best, 'enhMax — лучший достигнутый уровень');
  eq(await metric(pid, 'enhOk'), okCount, 'enhOk — число удачных бросков');
  if (best >= 3) ok(readySeen.includes('enh_max_3'), 'дошёл до +3 — клиенту сказали «выполнено»');

  // ── уровень и золото ─────────────────────────────────────────────────────
  await q('UPDATE player_progress SET lvl = 10 WHERE player_id = $1', [pid]);
  const goldOf = async () => {
    const { rows: g } = await q(`SELECT amount FROM balances WHERE player_id = $1 AND currency = 'gold'`, [pid]);
    return g.length ? Number(g[0].amount) : 0;
  };
  const g0 = await goldOf();
  rep = claimReply(sock);
  sock.emit('achClaim', { id: 'lvl_10' });
  rep = await rep;
  eq(rep.ev, 'achClaimed', 'уровень 10 — награда выдана (уровень засчитан задним числом)');
  eq(await goldOf() - g0, D.achievementById('lvl_10').rewards[0].n, 'золото пришло на баланс');

  // ── полная сумка: награда не теряется ────────────────────────────────────
  console.log('  ── полная сумка ──');
  await tx(async (t) => {
    await items.lockPlayer(t, pid);
    const { rows: u } = await q(`SELECT count(*)::int n FROM player_items
                                  WHERE player_id = $1 AND container = 'inventory'`, [pid]);
    for (let i = u[0].n; i < SERVER_INV_MAX; i++) await items.add(t, pid, 'sw1', { qty: 1, source: 'test' });
  });
  await q(`INSERT INTO player_ach_progress (player_id, metric, value) VALUES ($1, 'runeSocket', 10)
           ON CONFLICT (player_id, metric) DO UPDATE SET value = 10`, [pid]);
  rep = claimReply(sock);
  sock.emit('achClaim', { id: 'rune_socket_10' });
  rep = await rep;
  eq(rep.ev, 'achError', 'сумка полна — отказ');
  const { rows: cl } = await q(`SELECT 1 FROM player_ach_claims WHERE player_id = $1 AND ach_id = 'rune_socket_10'`, [pid]);
  eq(cl.length, 0, 'и награда не записана как забранная — её можно забрать позже');

  sock.disconnect();
  await wipeItems(pid).catch(() => {});
  await q('DELETE FROM player_ach_progress WHERE player_id = $1', [pid]).catch(() => {});
  await q('DELETE FROM player_ach_claims WHERE player_id = $1', [pid]).catch(() => {});
  await app.shutdown('test', { exit: false }).catch(() => {});
  await finish(() => close().catch(() => {}));
})().catch(async (e) => {
  console.error('  ОШИБКА: ' + e.message + '\n' + (e.stack || ''));
  fail++;
  await finish(() => close().catch(() => {}));
});
