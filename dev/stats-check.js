#!/usr/bin/env node
'use strict';
// ── Proof that a player's power comes only from what they actually own ──────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/stats-check.js
//
// The exploit being closed: write any catalog item into player.equipment in the
// browser console (every id is in bundle.js), let the client's recompute()
// produce a large number, push it with statsUpdate, and keep the clamp's whole
// headroom — ×1.5 ATK — permanently, with no buff running.
//
// The tests below equip real items through the repository and then try to
// improve on that by every route the client has: a forged equipment entry, a
// forged stat push, a fake enhancement. Each must change nothing.

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const stats = require('../server/db/repos/stats');
const { CHAR_DEF, ITEM_DEF, enhanceBonus, upgradeCost } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);
// The SQLSTATE of whatever was raised, or null if nothing was — the helper
// dev/market-check.js uses. `try { … flag = true } catch {}` passes on ANY
// error, so it proves a constraint exists exactly as well as a typo in the
// statement does.
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };
const FK = '23503';          // foreign_key_violation
const CHECK_VIOLATION = '23514';

const TAG = 'st-' + String(process.pid).slice(-5);
const made = [];
async function mk(nick, cls = 'deathknight') {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  await tx(t => players.setClass(t, id, cls));
  return id;
}

async function main() {
  console.log(`\nstats-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  const cd = CHAR_DEF.deathknight;
  const p = await mk('a');

  // ── baseline: a level-1 character with nothing ───────────────────────────
  let st = await stats.of(null, p);
  eq(st.atk, cd.baseAtk, 'голий 1-й рівень: ATK дорівнює базовому класу');
  eq(st.def, cd.baseDef, 'DEF базовий');
  eq(st.maxHp, cd.baseHP, 'HP базовий');

  // ── equipping a real item moves the numbers by exactly its stats ─────────
  const SWORD = ITEM_DEF.find(i => i.id === 'sw3');      // Меч дракона, atk 23
  const row = await tx(async t => { await items.lockPlayer(t, p); return items.add(t, p, SWORD.id); });
  await tx(t => items.moveTo(t, row, p, 'equipment', 'weapon'));
  st = await stats.of(null, p);
  eq(st.atk, cd.baseAtk + SWORD.atk, `вдягнутий меч дав рівно +${SWORD.atk} ATK`);

  // ── THE EXPLOIT: an item the player does not own ─────────────────────────
  // In the old model this is a line in the console. Here there is no field to
  // write it into — equipment is a set of ROWS, and a row is owned or it does
  // not exist.
  console.log('  ── спроби видати собі щось ──');
  const BEST = ITEM_DEF.filter(i => i.slot === 'weapon' && i.atk)
    .sort((a, b) => b.atk - a.atk)[0];
  const before = st.atk;

  // 1. Forge it the way the client used to: a stat block in a payload.
  //    savePrefs is the ONLY place a client value reaches the database, and it
  //    has no equipment field at all.
  await tx(t => players.savePrefs(t, p, {
    equipment: { weapon: { id: BEST.id, atk: 99999, enhance: 15 } },
    atk: 99999, maxHp: 999999, critChance: 1,
  }));
  eq((await stats.of(null, p)).atk, before, 'підроблена екіпіровка в payload не змінила ATK');

  // 2. Ask for a row that belongs to nobody — the equip path takes a row id,
  //    and moveTo scopes every write to (id AND player_id).
  const other = await mk('other');
  const theirs = await tx(async t => { await items.lockPlayer(t, other); return items.add(t, other, BEST.id); });
  const stolen = await tx(t => items.moveTo(t, theirs, p, 'equipment', 'weapon'));
  eq(stolen, false, 'вдягнути ЧУЖИЙ предмет за його id — відмова');
  eq((await stats.of(null, p)).atk, before, 'ATK не змінився після спроби');

  // 3. Invent an item id that is in the catalog but was never granted.
  eq(await caught(() => pool().query(
    `INSERT INTO player_items (player_id, container, slot, item_id) VALUES ($1,'equipment','helmet',$2)`,
    [p, 'no_such_item_id'])),
  FK, 'вигаданий id предмета відхиляє ЗОВНІШНІЙ КЛЮЧ (23503)');

  // 4. Raise the enhancement past the game's ceiling.
  // By SQLSTATE, because the two `try { … flag = true } catch {}` blocks above
  // this one were passing on any error at all: a column renamed, a table
  // renamed, the connection already closed by an earlier failure — every one
  // of them left the flag false and the assertion green, over a constraint
  // that might not exist. 23514 is player_items_enhance_check specifically.
  eq(await caught(() => pool().query('UPDATE player_items SET enhance = 99 WHERE id = $1', [row])),
    CHECK_VIOLATION, 'заточка понад +15 відхиляється CHECK-обмеженням бази (23514)');

  // ── the enhancement that IS owned counts exactly ─────────────────────────
  await pool().query('UPDATE player_items SET enhance = 5 WHERE id = $1', [row]);
  const eb = enhanceBonus(SWORD, 5);
  eq((await stats.of(null, p)).atk, cd.baseAtk + SWORD.atk + (eb.atk || 0),
    `справжня заточка +5 дала рівно +${eb.atk} ATK`);

  // ── upgrades count, and only up to the budget ────────────────────────────
  console.log('  ── очки характеристик ──');
  const withUpg = await mk('upg');
  const base = (await stats.of(null, withUpg)).atk;
  // A stat point COSTS GOLD now — upgradeCost(level), 300 for the first point
  // in a stat, 600 for the second, 900 for the third. It always did in
  // shared/definitions.js; nothing in server/ read it until spendUpgrade
  // started charging it, and these two assertions were written when every
  // point was free. Funded well past the 1800 the three below cost, so that
  // the fourth is refused for the reason this section names — the BUDGET —
  // and not for an empty purse, which would be the same PASS for the wrong
  // reason.
  const threePoints = upgradeCost(0) + upgradeCost(1) + upgradeCost(2);
  await money.credit(null, withUpg, 'gold', threePoints + 10000,
    { reason: 'seed', idemKey: `${TAG}:upg-gold` });
  for (let i = 0; i < 3; i++) await tx(t => players.spendUpgrade(t, withUpg, 'atk'));
  eq((await stats.of(null, withUpg)).atk, base + 3, '3 витрачені очки дали рівно +3 ATK');
  eq(Number((await money.balancesOf(null, withUpg)).gold), 10000,
    `три очки коштували рівно ${threePoints} золота`);
  await tx(t => players.spendUpgrade(t, withUpg, 'atk'));   // over budget, refused
  eq((await stats.of(null, withUpg)).atk, base + 3, 'очко понад бюджет нічого не додало');
  eq(Number((await money.balancesOf(null, withUpg)).gold), 10000,
    'і золота за нього не взяли — відмова по бюджету списань не робить');

  // ── the codex bonus, which the old server computation omitted ────────────
  console.log('  ── кодекс ──');
  const cxPlayer = await mk('codex');
  const cxBase = await stats.of(null, cxPlayer);

  // CODEX_SETS is an ARRAY of 984 sets, and each set's bonus is FRACTIONAL
  // (the first is atk 0.2). An earlier version of this test read it like an
  // object and completed one set, so it measured +0 and proved nothing while
  // reporting PASS. Enough sets are completed here that the total is a whole
  // number and the assertion can actually fail.
  const { CODEX_SETS, codexTotalBonus } = require('../shared/definitions');
  const progress = {};
  for (const set of CODEX_SETS.slice(0, 40)) {
    progress[set.id] = new Array(set.slots.length).fill(true);
  }
  const bonus = codexTotalBonus(progress);
  ok(bonus.atk >= 1, `40 зібраних наборів дають +${bonus.atk.toFixed(1)} ATK — вимірювана величина`);

  await pool().query('UPDATE player_progress SET codex = $2 WHERE player_id = $1',
    [cxPlayer, JSON.stringify(progress)]);
  const cxAfter = await stats.of(null, cxPlayer);
  eq(cxAfter.atk, Math.floor(cxBase.atk + bonus.atk),
    'кодекс врахований у ATK — старий серверний розрахунок його не бачив ЗОВСІМ');
  eq(cxAfter.def, Math.floor(cxBase.def + bonus.def), 'і в DEF теж');

  // An incomplete set must count for nothing — one missing slot, no bonus.
  const partial = { [CODEX_SETS[0].id]: new Array(CODEX_SETS[0].slots.length).fill(true) };
  partial[CODEX_SETS[0].id][0] = false;
  await pool().query('UPDATE player_progress SET codex = $2 WHERE player_id = $1',
    [cxPlayer, JSON.stringify(partial)]);
  eq((await stats.of(null, cxPlayer)).atk, cxBase.atk, 'незібраний набір не дає нічого');

  // ── buffs are the server's too, so nothing is left for a clamp to guess ──
  console.log('  ── бафи ──');
  const bf = await mk('buff');
  const plain = await stats.of(null, bf);
  // Expiries, not countdowns — see migration 008. Writing `300` here used to
  // mean "300 seconds left"; it now means "ended in 1970", and the atk
  // assertion passed anyway because ×1.20 of a small number floors to itself.
  // A test that passes for the wrong reason is the reason to state the units.
  const until = Date.now() + 300000;
  await pool().query(
    `UPDATE player_progress SET buffs = $2::jsonb WHERE player_id = $1`,
    [bf, JSON.stringify({ atk: until, hp: until })]);
  const buffed = await stats.of(null, bf);
  eq(buffed.atk, Math.floor(plain.atk * 1.20), 'баф на атаку рахує СЕРВЕР (×1.20)');
  eq(buffed.maxHp, Math.floor(plain.maxHp * 1.10), 'баф на HP рахує сервер (×1.10)');

  // The half that matters more: a buff whose moment has passed does nothing,
  // and needs nobody to have swept it up.
  await pool().query(
    `UPDATE player_progress SET buffs = $2::jsonb WHERE player_id = $1`,
    [bf, JSON.stringify({ atk: Date.now() - 1000, hp: Date.now() - 1000 })]);
  const expired = await stats.of(null, bf);
  eq(expired.atk, plain.atk, 'прострочений баф на атаку не діє');
  eq(expired.maxHp, plain.maxHp, 'прострочений баф на HP не діє — раніше він діяв вічно');

  // ── clan bonus ───────────────────────────────────────────────────────────
  console.log('  ── бонус клану ──');
  const cl = await mk('clan');
  const solo = await stats.of(null, cl);
  const { rows: c } = await pool().query(
    `INSERT INTO clans (name, icon, level, xp) VALUES ($1, 1, 5, 999999) RETURNING id`, [TAG.slice(-5) + 'X']);
  await pool().query(`INSERT INTO clan_members (clan_id, player_id, role) VALUES ($1,$2,'leader')`, [c[0].id, cl]);
  const inClan = await stats.of(null, cl);
  ok(inClan.clanAtkPct > 0 && inClan.atk === Math.floor(solo.atk * (1 + inClan.clanAtkPct / 100)),
    `бонус клану +${inClan.clanAtkPct}% ATK застосований`);
  await pool().query('DELETE FROM clan_members WHERE clan_id = $1', [c[0].id]);
  await pool().query('DELETE FROM clans WHERE id = $1', [c[0].id]);

  // ── bm is derived from the same numbers ──────────────────────────────────
  const { bm } = await tx(t => stats.refreshBm(t, p));
  const { rows: bmRow } = await pool().query('SELECT bm FROM players WHERE id = $1', [p]);
  eq(bmRow[0].bm, bm, 'БМ порахована з тих самих статів і збережена');
  ok(bm > 0, 'БМ додатна');
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (!made.length) return;
  await q('DELETE FROM clan_members WHERE player_id = ANY($1)', [made]);
  for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs', 'player_progress', 'ledger', 'balances']) {
    await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
  }
  await q('DELETE FROM players WHERE id = ANY($1)', [made]);
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
