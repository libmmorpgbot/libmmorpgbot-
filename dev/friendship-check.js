#!/usr/bin/env node
'use strict';
// ── «Дружба» и «Комбо дня» выдают ровно обещанное и один раз ────────────────
//
//   DATABASE_URL=... node dev/friendship-check.js
//
// Что проверяется (server/db/repos/friendship.js):
//   • друг засчитывается только созданный во время события, не забаненный и
//     с уровнем ≥ FRIEND_EVENT_LEVEL; приглашённые раньше — не считаются;
//   • тир нельзя забрать без нужного числа друзей и нельзя забрать дважды;
//   • старые записи первой «Дружбы» (tier = 1, 5, …) новый тир не блокируют;
//   • комбо дня: подсказки hit/near/miss, лимит попыток, награда один раз.
// Проверяется то, что легло в инвентарь и на баланс, а не текст ответа.
const { tx, query, close } = require('../server/db');
const players = require('../server/db/repos/players');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const fr = require('../server/db/repos/friendship');
const D = require('../shared/definitions');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'fr-' + String(process.pid).slice(-5);
const made = [];

const invOf = async (pid) => {
  const { rows } = await query(null,
    `SELECT item_id, sum(qty)::int q FROM player_items
      WHERE player_id = $1 AND container = 'inventory' GROUP BY item_id`, [pid]);
  return Object.fromEntries(rows.map(r => [r.item_id, r.q]));
};
const nexumOf = async (pid) => Number((await money.balancesOf(null, pid)).nexum || 0);
const tryTx = async (fn) => {
  try { return { ok: true, res: await tx(fn) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; }
};

async function friend(refTg, n, { lvl = D.FRIEND_EVENT_LEVEL, banned = false, old = false } = {}) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-f${n}`, `${TAG}_f${n}`));
  made.push(id);
  await query(null, `UPDATE players SET referred_by = $2, banned = $3,
                       created_at = CASE WHEN $4 THEN $5::timestamptz ELSE now() END WHERE id = $1`,
  [id, refTg, banned, old, new Date(D.FRIEND_EVENT_START_AT - 86400000).toISOString()]);
  await query(null, 'UPDATE player_progress SET lvl = $2 WHERE player_id = $1', [id, lvl]);
  return id;
}

(async () => {
  console.log(`\nfriendship-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  const refTg = `${TAG}-ref`;
  const { id: me } = await tx(t => players.ensure(t, refTg, `${TAG}_ref`));
  made.push(me);

  console.log('  ── кто считается ──');
  await friend(refTg, 'old', { old: true });
  await friend(refTg, 'ban', { banned: true });
  await friend(refTg, 'low', { lvl: 5 });
  let c = await fr.friendCounts(null, me);
  eq(c.done, 0, 'старый, забаненный и низкоуровневый друг не засчитаны');
  eq(c.invited, 1, 'низкоуровневый виден как приглашённый');

  // Старая запись первой «Дружбы» (tier = 1) не должна мешать новому тиру 1.
  await query(null, 'INSERT INTO player_friendship_claims (player_id, tier) VALUES ($1, 1)', [me]);

  const t1 = await tryTx(t => fr.claimFriendTier(t, me, 1));
  eq(t1.code, 'not_enough', 'без друзей тир 1 не выдаётся');

  for (let i = 0; i < 4; i++) await friend(refTg, i);
  c = await fr.friendCounts(null, me);
  eq(c.done, 4, 'четыре новых друга с нужным уровнем');

  console.log('  ── тиры ──');
  const n0 = await nexumOf(me);
  const a = await tryTx(t => fr.claimFriendTier(t, me, 1));
  ok(a.ok, 'тир 1 выдан', a.msg);
  eq(await nexumOf(me) - n0, 100, '+100 Liberty');
  const a2 = await tryTx(t => fr.claimFriendTier(t, me, 1));
  eq(a2.code, 'already', 'второй раз тир 1 не выдаётся');
  eq(await nexumOf(me) - n0, 100, 'и баланс не изменился');

  eq((await tryTx(t => fr.claimFriendTier(t, me, 5))).code, 'not_enough', 'тир 5 при 4 друзьях — отказ');
  eq((await tryTx(t => fr.claimFriendTier(t, me, 7))).code, 'bad_tier', 'несуществующий тир — отказ');

  for (let i = 4; i < 10; i++) await friend(refTg, i);
  ok((await tryTx(t => fr.claimFriendTier(t, me, 5))).ok, 'тир 5 выдан');
  const b = await tryTx(t => fr.claimFriendTier(t, me, 10));
  ok(b.ok, 'тир 10 выдан', b.msg);
  eq((await invOf(me)).wing_u, 1, 'зелёные крылья в инвентаре');
  eq(await nexumOf(me) - n0, 2100, 'всего +2100 Liberty за тиры 1, 5, 10');
  const st = await fr.friendStatus(null, me);
  eq(JSON.stringify(st.claimed.sort((x, y) => x - y)), '[1,5,10]', 'статус: забраны 1, 5, 10');

  console.log('  ── старшие тиры ──');
  await query(null, "UPDATE player_progress SET char_class = 'mage' WHERE player_id = $1", [me]);
  for (let i = 10; i < 300; i++) await friend(refTg, i);
  ok((await tryTx(t => fr.claimFriendTier(t, me, 30))).ok, 'тир 30 выдан');
  eq((await tryTx(t => fr.claimFriendTier(t, me, 50, 'pet_groot'))).code, 'bad_pet',
    'тир 50: эпический питомец вместо синего — отказ');
  eq((await tryTx(t => fr.claimFriendTier(t, me, 50))).code, 'bad_pet', 'тир 50 без выбора — отказ');
  ok((await tryTx(t => fr.claimFriendTier(t, me, 50, 'pet_yeti'))).ok, 'тир 50 с выбранным питомцем');
  const g0 = Number((await money.balancesOf(null, me)).gram || 0);
  ok((await tryTx(t => fr.claimFriendTier(t, me, 100, 'pet_nerb'))).ok, 'тир 100 выдан');
  eq(Number((await money.balancesOf(null, me)).gram || 0) - g0, 10, '+10 GRAM');
  const top = await tryTx(t => fr.claimFriendTier(t, me, 300, 'pet_vilord'));
  ok(top.ok, 'тир 300 выдан', top.msg);
  eq(top.res && top.res.ton, 30, 'тир 300 сообщает о 30 TON к ручной выплате');
  const invT = await invOf(me);
  eq(invT.wing_r, 2, 'синие крылья ×2 (тиры 30 и 50)');
  ok(invT.wing_e === 1 && invT.wing_l === 1, 'фиолетовые и легендарные крылья');
  ok(invT.pet_yeti === 1 && invT.pet_nerb === 1 && invT.pet_vilord === 1, 'выбранные питомцы');
  ok(invT.artifact_r_mage === 1 && invT.cloak_r_mage === 1, 'редкие артефакт и плащ на класс мага',
    JSON.stringify(invT));

  console.log('  ── комбо дня ──');
  const today = (await query(null, 'SELECT CURRENT_DATE::text d')).rows[0].d;
  const combo = fr.comboFor(today);
  eq(new Set(combo).size, D.DAILY_COMBO.len, 'в комбо три разных питомца');
  const pool = D.dailyComboPets();
  const others = pool.filter(p => !combo.includes(p));
  const guess = [combo[1], others[0], others[1]];
  const g = await tryTx(t => fr.comboGuess(t, me, guess));
  ok(g.ok, 'попытка принята', g.msg);
  eq(JSON.stringify(g.res && g.res.result), '["near","miss","miss"]', 'подсказка: near / miss / miss');
  eq(g.res && g.res.left, D.DAILY_COMBO.attempts - 1, 'попытка списана');
  eq((await tryTx(t => fr.comboGuess(t, me, [combo[0], combo[0], combo[1]]))).code, 'bad_pick',
    'повтор питомца — отказ');

  const nb = await nexumOf(me);
  const w = await tryTx(t => fr.comboGuess(t, me, combo));
  ok(w.ok && w.res.won, 'верная комбинация — выигрыш', w.msg);
  eq(await nexumOf(me) - nb, D.DAILY_COMBO.nexum, `+${D.DAILY_COMBO.nexum} Liberty`);
  const inv = await invOf(me);
  const bps = D.ITEM_DEF.filter(d => d.slot === 'buff_potion').map(d => d.id);
  ok(bps.every(id => inv[id] === D.DAILY_COMBO.buffPotions), 'по одной банке каждого бафа',
    bps.map(id => `${id}=${inv[id]}`).join(', '));
  eq((await tryTx(t => fr.comboGuess(t, me, combo))).code, 'already', 'второй выигрыш за сутки — отказ');
  eq(await nexumOf(me) - nb, D.DAILY_COMBO.nexum, 'и Liberty не начислено второй раз');

  const { id: p2 } = await tx(t => players.ensure(t, `${TAG}-p2`, `${TAG}_p2`));
  made.push(p2);
  for (let i = 0; i < D.DAILY_COMBO.attempts; i++) await tryTx(t => fr.comboGuess(t, p2, guess));
  eq((await tryTx(t => fr.comboGuess(t, p2, combo))).code, 'no_attempts', 'после 5 попыток — отказ');
  eq((await fr.comboStatus(null, p2)).left, 0, 'статус: попыток 0');

  await wipeItemsAll(made);
  await query(null, 'DELETE FROM players WHERE id = ANY($1::bigint[])', [made]).catch(() => {});
  console.log(`\n  ${pass} пройшло, ${fail} впало\n`);
  await close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await close(); } catch { /* */ }
  process.exit(1);
});
