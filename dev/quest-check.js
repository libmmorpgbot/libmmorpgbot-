#!/usr/bin/env node
'use strict';
// ── Proof that the quest chain moves ────────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/quest-check.js
//
// Two players spent a day in the game — 174,000 gold earned between them —
// with quest 1 of 60 still reading zero of ten. Two independent bugs, either
// of which alone would have been enough:
//
//   1. onKill called bumpQuestKill(t, pid, result.enemyName). No code path has
//      ever set `enemyName` on a kill result, so `if (result.enemyName)` was
//      false on every kill the game has ever resolved.
//
//   2. claimQuest called questComplete(def, { questKills, lvl }) — but the
//      signature is questComplete(q, kills, lvl). `kills` was the WRAPPER, so
//      every kills[name] lookup missed and read zero, and `lvl` was undefined
//      so a level quest compared against 1. No quest of any type could be
//      claimed, whatever the counters held.
//
// Neither is visible in a unit test of either function: both are correct on
// their own. What was wrong was the call. So these tests go through the same
// entry points the handlers use, with the real QUEST_DEF, and assert on the
// two ends — the counter after a kill, and the chain index after a claim.

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const players = require('../server/db/repos/players');
const prog = require('../server/db/repos/progression');
const { QUEST_DEF, questComplete, ENEMY_DEF, armIndexForLevel } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'qchk-' + String(process.pid).slice(-5);
const made = [];
async function mk(nick) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  return id;
}
const state = id => prog.questState(null, id);
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

// The catalog entry a quest names, resolved back to the eid a kill carries.
// The quest lists 'Крыса страж'; the kill result carries 'rat_guard'; the
// decorated name a player sees is a third string again ('Свирепая Крыса
// страж'). Getting the wrong one of the three is what this whole file is
// about, so the test derives it rather than hard-coding it.
function eidForQuestEnemy(name) {
  const def = ENEMY_DEF.find(e => e.name === name);
  return def ? def.eid : null;
}

async function main() {
  console.log(`\nquest-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  // ── the first quest in the chain, whatever it is ─────────────────────────
  const q0 = QUEST_DEF[0];
  ok(q0 && q0.type === 'kill', `перше завдання — вбивство (${q0 && q0.title})`);
  const targetName = (q0.enemies || [])[0];
  const targetEid = eidForQuestEnemy(targetName);
  ok(!!targetEid, `у «${targetName}» є eid у каталозі (${targetEid})`);

  const p = await mk('a');

  // ── a kill counts ────────────────────────────────────────────────────────
  // Under the SPECIES ID. It used to be filed under the display name, which is
  // the whole reason quests worked in Russian and nowhere else — see the
  // language block near the end of this file.
  await prog.questOnKill(null, p, { eid: targetEid, rlvl: 1 });
  let st = await state(p);
  eq(st.questKills[targetEid], 1, 'вбивство зарахувалось у лічильник квесту');

  // ── a kill of something else does NOT ────────────────────────────────────
  const other = ENEMY_DEF.find(e => e.eid !== targetEid && !(q0.enemies || []).includes(e.name));
  await prog.questOnKill(null, p, { eid: other.eid, rlvl: 1 });
  st = await state(p);
  eq(Object.keys(st.questKills).length, 1, 'чужий моб не створив зайвий лічильник');
  eq(st.questKills[targetEid], 1, 'і не збив свій');

  // ── the claim is refused until the count is reached ──────────────────────
  eq(await caught(() => tx(t => prog.claimQuest(t, p, 0))), 'not_done',
    `${1}/${q0.count} — здати ще не можна`);

  // ── reach the count ──────────────────────────────────────────────────────
  for (let i = 1; i < q0.count; i++) {
    await prog.questOnKill(null, p, { eid: targetEid, rlvl: 1 });
  }
  st = await state(p);
  eq(st.questKills[targetEid], q0.count, `дійшли до ${q0.count}`);
  ok(questComplete(q0, st.questKills, 1), 'questComplete погоджується, що виконано');

  // ── and now it claims ────────────────────────────────────────────────────
  // This is the assertion the arity bug failed: with the wrapper object it
  // threw not_done here forever, no matter how high the counter went.
  const res = await tx(t => prog.claimQuest(t, p, 0));
  eq(res.nextIdx, 1, 'ланцюжок просунувся на друге завдання');
  st = await state(p);
  eq(st.questIdx, 1, 'індекс у базі теж просунувся');
  eq(Object.keys(st.questKills).length, 0, 'лічильники обнулились під нове завдання');

  // ── the same quest cannot be claimed twice ───────────────────────────────
  eq(await caught(() => tx(t => prog.claimQuest(t, p, 0))), 'wrong_quest',
    'здати те саме завдання вдруге не можна');

  // ── only the ACTIVE quest counts ─────────────────────────────────────────
  // Killing quest 1's monster while quest 2 is active must not bank progress
  // for a quest the player has already finished — nor for one they have not
  // reached yet, which is what an unconditional counter would do.
  await prog.questOnKill(null, p, { eid: targetEid, rlvl: 1 });
  st = await state(p);
  eq(st.questKills[targetEid], undefined,
    'моб попереднього завдання не рахується у поточне');

  // ── a non-kill quest: buying potions ─────────────────────────────────────
  const potionIdx = QUEST_DEF.findIndex(q => q.type === 'buy_potion');
  if (potionIdx >= 0) {
    const pq = QUEST_DEF[potionIdx];
    const p2 = await mk('b');
    await pool().query('UPDATE player_progress SET quest_idx = $2 WHERE player_id = $1',
      [p2, potionIdx]);
    // Bought while a DIFFERENT quest is active — must not count.
    await pool().query('UPDATE player_progress SET quest_idx = 0 WHERE player_id = $1', [p2]);
    await prog.questOnEvent(null, p2, 'buy_potion', '_potion', 5);
    let s2 = await state(p2);
    eq(s2.questKills._potion, undefined, 'покупка не рахується, поки квест не активний');

    await pool().query('UPDATE player_progress SET quest_idx = $2 WHERE player_id = $1',
      [p2, potionIdx]);
    await prog.questOnEvent(null, p2, 'buy_potion', '_potion', pq.count);
    s2 = await state(p2);
    eq(s2.questKills._potion, pq.count, `куплено ${pq.count} зілль — зараховано`);
    const r2 = await tx(t => prog.claimQuest(t, p2, potionIdx));
    eq(r2.nextIdx, potionIdx + 1, 'квест на покупку здається');
  }

  // ── a level quest reads the level, not undefined ─────────────────────────
  // questComplete's third argument. With the old two-argument call it was
  // undefined, so `Math.max(1, undefined || 1)` compared 1 against the
  // requirement and a level-20 character was told to keep levelling.
  const lvlIdx = QUEST_DEF.findIndex(q => q.type === 'level');
  if (lvlIdx >= 0) {
    const lq = QUEST_DEF[lvlIdx];
    const p3 = await mk('c');
    await pool().query(
      'UPDATE player_progress SET quest_idx = $2, lvl = $3 WHERE player_id = $1',
      [p3, lvlIdx, lq.level]);
    const r3 = await tx(t => prog.claimQuest(t, p3, lvlIdx));
    eq(r3.nextIdx, lvlIdx + 1, `квест «досягни ${lq.level} рівня» здається на ${lq.level}`);

    const p4 = await mk('d');
    await pool().query(
      'UPDATE player_progress SET quest_idx = $2, lvl = $3 WHERE player_id = $1',
      [p4, lvlIdx, Math.max(1, lq.level - 1)]);
    eq(await caught(() => tx(t => prog.claimQuest(t, p4, lvlIdx))), 'not_done',
      `на ${lq.level - 1} рівні — ще ні`);
  }

  // ── the legacy floor quests ──────────────────────────────────────────────
  // No floor to walk into any more, so reaching the corridor a kill happened
  // in stands in for clearing it. The rule is `armIndexForLevel(rlvl)`, and a
  // kill in a corridor BELOW the target must not count.
  const gotoIdx = QUEST_DEF.findIndex(q => q.type === 'goto_floor');
  if (gotoIdx >= 0) {
    const gq = QUEST_DEF[gotoIdx];
    const p5 = await mk('e');
    await pool().query('UPDATE player_progress SET quest_idx = $2 WHERE player_id = $1',
      [p5, gotoIdx]);
    // A monster level whose corridor is below the target.
    let lowRlvl = 1;
    for (let l = 1; l < 400; l++) { if (armIndexForLevel(l) < gq.targetFloor) lowRlvl = l; else break; }
    await prog.questOnKill(null, p5, { eid: targetEid, rlvl: lowRlvl });
    let s5 = await state(p5);
    eq(s5.questKills[`_floor_${gq.targetFloor}`], undefined,
      `вбивство в коридорі ${armIndexForLevel(lowRlvl)} не зараховує поверх ${gq.targetFloor}`);

    let hiRlvl = null;
    for (let l = 1; l < 400; l++) { if (armIndexForLevel(l) >= gq.targetFloor) { hiRlvl = l; break; } }
    ok(hiRlvl !== null, `знайшовся рівень для коридору ${gq.targetFloor} (${hiRlvl})`);
    await prog.questOnKill(null, p5, { eid: targetEid, rlvl: hiRlvl });
    s5 = await state(p5);
    eq(s5.questKills[`_floor_${gq.targetFloor}`], 1, 'а в потрібному — зараховує');
    const r5 = await tx(t => prog.claimQuest(t, p5, gotoIdx));
    eq(r5.nextIdx, gotoIdx + 1, 'квест на поверх здається');
  }

  // ── two kills in the same instant both count ─────────────────────────────
  // jsonb_set in SQL rather than read-modify-write in JS. A lost update here
  // is invisible: the counter is simply one short, forever.
  const p6 = await mk('f');
  await Promise.all(Array.from({ length: 8 }, () =>
    prog.questOnKill(null, p6, { eid: targetEid, rlvl: 1 })));
  const s6 = await state(p6);
  eq(s6.questKills[targetEid], 8, '8 одночасних вбивств — 8 у лічильнику');

  // ── квести не залежать від мови ────────────────────
  // "На русском работают, на других нет."
  //
  // A kill quest listed its targets as display NAMES and stored the counter
  // under the same string. js/i18n.js's applyLocale rewrites q.enemies to the
  // localised names when the language is not Russian; the counters keep their
  // Russian keys, because the server writes them from its own untranslated
  // table. So the panel asked for questKills['Rat Guard'], got undefined, and
  // showed 0/10 forever — the chain was frozen for everyone not playing in
  // Russian.
  //
  // The binding is the species id now. This proves it by doing what applyLocale
  // does — replacing the names on a copy of the quest — and checking the count
  // still reads.
  console.log('');
  console.log('  ── квест будь-якою мовою ──');
  const killQ = QUEST_DEF.find(q => q.type === 'kill' && (q.eids || []).length === 1);
  ok(!!killQ && !!killQ.eids, 'у квеста є привʼязка до виду, а не лише назва');
  const eid0 = killQ.eids[0];
  ok(eid0 !== killQ.enemies[0],
    `id виду (${eid0}) — не те саме, що назва (${killQ.enemies[0]})`);

  // Exactly what applyLocale produces for English.
  const translated = { ...killQ, enemies: ['Rat Guard'] };
  ok(questComplete(translated, { [eid0]: killQ.count }, 99),
    'квест зараховується, коли назви перекладені');
  ok(!questComplete(translated, { [eid0]: killQ.count - 1 }, 99),
    'і не зараховується, поки не добито');

  // A quest already in flight keeps its progress: those counters are filed
  // under the Russian name and dropping them would zero everyone on deploy.
  ok(questComplete(translated, { [killQ.legacyNames[0]]: killQ.count }, 99),
    'старий лічильник за назвою досі рахується — прогрес не обнулився');
  ok(questComplete(translated, {
    [killQ.legacyNames[0]]: Math.floor(killQ.count / 2),
    [eid0]: killQ.count - Math.floor(killQ.count / 2),
  }, 99), 'і половина старим ключем плюс половина новим дає ціле');

  // The server counts under the species id.
  const lq = await mk('lang');
  await pool().query(
    'UPDATE player_progress SET quest_idx = $2, quest_kills = $3 WHERE player_id = $1',
    [lq, QUEST_DEF.indexOf(killQ), JSON.stringify({})]);
  await tx(t => prog.questOnKill(t, lq, { eid: eid0, rlvl: 1 }));
  const after = await prog.questState(null, lq);
  eq((after.questKills || {})[eid0], 1,
    'сервер пише лічильник під id виду, а не під російською назвою');


  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    if (made.length) {
      await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
    }
    await close();
    process.exit(fail ? 1 : 0);
  });
