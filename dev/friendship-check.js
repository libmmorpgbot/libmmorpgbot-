#!/usr/bin/env node
'use strict';
// ── Дружба: тиры наград за приглашённых друзей ──────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/friendship-check.js
//
// Три правила, которые молча спутать легче всего:
//
//   уровень    друг считается только начиная с FRIENDSHIP_LEVEL — приглашение,
//              брошенное на выборе класса, не должно закрывать тир;
//   дата       друг считается только если ЗАРЕГИСТРИРОВАН не раньше
//              FRIENDSHIP_LAUNCH_AT — иначе у всех, кто играет давно, тиры
//              закрылись бы в момент выката одним запросом, за друзей,
//              приглашённых до того, как эта награда вообще была придумана;
//   раз на тир один и тот же тир нельзя забрать дважды, и число, по которому
//              сервер решает «хватит ли друзей», перепроверяется внутри
//              claimFriendshipTier заново — а не доверяется тому, что панель
//              показала минуту назад.
process.env.NODE_ENV = 'test';
const { tx, query, close } = require('../server/db');
const players = require('../server/db/repos/players');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const shop = require('../server/db/repos/shop');
const D = require('../shared/definitions');
const { _VIP_BP } = require('../server/shop');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'friendship-' + String(process.pid).slice(-5);
const made = [];
let tgSeq = 0;
const nextTg = () => `9990${Date.now()}${tgSeq++}`;

async function mk(nick) {
  const telegramId = nextTg();
  const { id } = await tx(t => players.ensure(t, telegramId, `${TAG}_${nick}`));
  made.push(id);
  return { id, telegramId };
}

const setLevel = (pid, lvl) => query(null,
  'UPDATE player_progress SET lvl = $2 WHERE player_id = $1', [pid, lvl]);
const setCreatedAt = (pid, iso) => query(null,
  'UPDATE players SET created_at = $2::timestamptz WHERE id = $1', [pid, iso]);
const invite = (friendId, referrerTg) => players.registerReferral(null, friendId, referrerTg);

const invOf = async (pid) => {
  const { rows } = await query(null,
    `SELECT item_id, sum(qty)::int q FROM player_items
      WHERE player_id = $1 AND container = 'inventory' GROUP BY item_id`, [pid]);
  return Object.fromEntries(rows.map(r => [r.item_id, r.q]));
};
const claim = async (pid, tier) => {
  try { return { ok: true, res: await tx(t => shop.claimFriendshipTier(t, pid, tier)) }; }
  catch (e) { return { ok: false, code: e.code, msg: e.message }; }
};

(async () => {
  console.log(`\nfriendship-check  (${TAG})\n`);

  // Каталог наполняется на старте сервера, а не миграцией (syncCatalog,
  // server/db/repos/items.js). Без него items.add откажет на первом же
  // bp_hp — «unknown or retired item id» — и провалится вся проверка, ничего
  // не сказав о самой награде.
  await tx(t => items.syncCatalog(t));

  const ref = await mk('ref');

  // ── кого считать ─────────────────────────────────────────────────────────
  console.log('  ── кого считать другом ──');
  const before = await shop.friendshipStatus(null, ref.id);
  eq(before.count, 0, 'без друзей — ноль');
  ok(before.tiers.length === D.FRIENDSHIP_TIERS.length, 'все тиры перечислены',
    before.tiers.length);
  ok(before.tiers.every(x => !x.claimed && !x.claimable), 'ни один ещё не готов');

  const low = await mk('low');
  ok((await invite(low.id, ref.telegramId)).ok, 'friend приглашён');
  await setLevel(low.id, D.FRIENDSHIP_LEVEL - 1);
  eq((await shop.friendshipStatus(null, ref.id)).count, 0,
    'друг ниже требуемого уровня не считается');

  await setLevel(low.id, D.FRIENDSHIP_LEVEL);
  eq((await shop.friendshipStatus(null, ref.id)).count, 1,
    'тот же друг на пороговом уровне — считается');

  const stale = await mk('stale');
  ok((await invite(stale.id, ref.telegramId)).ok, 'второй friend приглашён');
  await setLevel(stale.id, D.FRIENDSHIP_LEVEL + 10);
  await setCreatedAt(stale.id, '2000-01-01T00:00:00Z');
  eq((await shop.friendshipStatus(null, ref.id)).count, 1,
    'друг, зарегистрированный до FRIENDSHIP_LAUNCH_AT, не считается даже прокачанным');

  // ── первый тир ───────────────────────────────────────────────────────────
  console.log('  ── тир 1 ──');
  const t1 = D.FRIENDSHIP_TIERS.find(x => x.count === 1);
  const statusReady = await shop.friendshipStatus(null, ref.id);
  ok(statusReady.tiers.find(x => x.count === 1).claimable, 'тир на 1 друга готов к получению');

  const tooEarly = await claim(ref.id, 5);
  eq(tooEarly.ok, false, 'тир на 5 друзей пока недоступен');
  eq(tooEarly.code, 'not_enough', 'причина — не хватает друзей');

  const c1 = await claim(ref.id, 1);
  ok(c1.ok, 'тир на 1 друга получен', c1.msg);
  const inv1 = await invOf(ref.id);
  const miss1 = _VIP_BP.filter(bp => inv1[bp.id] !== t1.buffPotions);
  ok(miss1.length === 0, `по ${t1.buffPotions} банки каждого из ${_VIP_BP.length} бафов`,
    miss1.map(bp => `${bp.id}=${inv1[bp.id]}`).join(', '));

  const c1again = await claim(ref.id, 1);
  eq(c1again.ok, false, 'повторно тот же тир не выдаётся');
  eq(c1again.code, 'already', 'причина названа');
  const inv1After = await invOf(ref.id);
  eq(JSON.stringify(inv1After), JSON.stringify(inv1), 'и ничего не добавилось повторно');

  // ── пятый тир: бафы + камни ─────────────────────────────────────────────
  console.log('  ── тир 5 ──');
  const extras = [];
  for (let i = 0; i < 4; i++) {
    const f = await mk(`f${i}`);
    ok((await invite(f.id, ref.telegramId)).ok, `друг ${i} приглашён`);
    await setLevel(f.id, D.FRIENDSHIP_LEVEL);
    extras.push(f);
  }
  eq((await shop.friendshipStatus(null, ref.id)).count, 5, 'теперь пять считающихся друзей');

  const t5 = D.FRIENDSHIP_TIERS.find(x => x.count === 5);
  const c5 = await claim(ref.id, 5);
  ok(c5.ok, 'тир на 5 друзей получен', c5.msg);
  const inv5 = await invOf(ref.id);
  eq(inv5.bp_hp, t1.buffPotions + t5.buffPotions,
    `банки зелья здоровья накопились (тир 1 + тир 5 = ${t1.buffPotions + t5.buffPotions})`);
  eq(inv5.bless_stone, t5.mats.bless_stone,
    `${t5.mats.bless_stone} камня безопасной заточки — их не было ни в одном другом тире`);

  // ── десятый тир: крылья и Liberty ────────────────────────────────────────
  console.log('  ── тир 10 ──');
  for (let i = 4; i < 9; i++) {
    const f = await mk(`f${i}`);
    ok((await invite(f.id, ref.telegramId)).ok, `друг ${i} приглашён`);
    await setLevel(f.id, D.FRIENDSHIP_LEVEL);
    extras.push(f);
  }
  eq((await shop.friendshipStatus(null, ref.id)).count, 10, 'теперь десять считающихся друзей');

  const t10 = D.FRIENDSHIP_TIERS.find(x => x.count === 10);
  const nexumBefore = (await money.balancesOf(null, ref.id)).nexum;
  const c10 = await claim(ref.id, 10);
  ok(c10.ok, 'тир на 10 друзей получен', c10.msg);
  const inv10 = await invOf(ref.id);
  eq(inv10[t10.wing], 1, `${t10.wing} выдан`);
  const nexumAfter = (await money.balancesOf(null, ref.id)).nexum;
  eq(Number(nexumAfter) - Number(nexumBefore), t10.nexum,
    `+${t10.nexum} Liberty начислено`);

  // ── дальше пока рано ─────────────────────────────────────────────────────
  console.log('  ── тир 25 пока недоступен ──');
  const c25 = await claim(ref.id, 25);
  eq(c25.ok, false, 'десяти друзей на тир 25 не хватает');
  eq(c25.code, 'not_enough', 'причина — не хватает друзей');

  // ── журнал предметов ─────────────────────────────────────────────────────
  console.log('  ── журнал ──');
  const { rows: led } = await query(null,
    'SELECT sum(delta)::int total FROM item_ledger WHERE player_id = $1', [ref.id]);
  const held = Object.values(inv10).reduce((n, q) => n + q, 0);
  eq(Number(led[0].total), held, `журнал сходится с руками (${held})`);

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await wipeItemsAll(made);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await wipeItemsAll(made); await close(); } catch {}
  process.exit(1);
});
