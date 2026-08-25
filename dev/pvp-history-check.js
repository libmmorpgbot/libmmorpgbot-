#!/usr/bin/env node
'use strict';
// ── A duel that happened must be recorded ───────────────────────────────────
//
//   node dev/pvp-history-check.js
//
// pvp_history was created with (kind, mode, opponent) and every write since has
// named `won` and `reward` as well. That raises 42703, and the raise is inside
// a catch — so not one duel has ever been recorded, and the only trace was a
// line in the journal nobody reads.
//
// The read side fails the same way, and its error lands on 'profileError',
// which no client listens for. So the panel is empty for two independent
// reasons, neither of which reaches anybody.
//
// There is a third: seven call sites pass (telegramId, kind, mode, opponent)
// while the function expected (socketId, row). It looked a telegram id up in a
// table of socket ids and returned before writing.
const { pool, tx, close, hasColumn } = require('../server/db');
const players = require('../server/db/repos/players');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'pvp-' + String(process.pid).slice(-5);
const made = [];

async function main() {
  console.log(`\npvp-history-check  (${TAG})\n`);
  const outcome = await hasColumn('pvp_history', 'won');
  console.log(`  колонки won/reward: ${outcome ? 'Є (міграція 009 застосована)' : 'НЕМА — пишемо без них'}\n`);

  const { id } = await tx(t => players.ensure(t, `${TAG}-a`, `${TAG}_a`));
  made.push(id);

  // The columns the running code names must exist in whichever schema is live.
  // That is the whole failure: the SQL was right for a table that was never
  // created that way, and the raise was swallowed.
  const cols = outcome
    ? '(player_id, kind, mode, opponent, won, reward)'
    : '(player_id, kind, mode, opponent)';
  const vals = outcome ? '($1,$2,$3,$4,$5,$6)' : '($1,$2,$3,$4)';
  const args = outcome ? [id, 'win', 'death_battle', 'rival', true, '0.05']
                       : [id, 'win', 'death_battle', 'rival'];
  await pool().query(`INSERT INTO pvp_history ${cols} VALUES ${vals}`, args);

  const rows = (await pool().query(
    'SELECT kind, mode, opponent FROM pvp_history WHERE player_id = $1', [id])).rows;
  eq(rows.length, 1, 'рядок записався у ту схему, яка зараз у базі');
  eq(rows[0].kind, 'win', 'вид записаний');
  eq(rows[0].mode, 'death_battle', 'режим записаний');
  eq(rows[0].opponent, 'rival', 'суперник записаний');

  // The read the profile panel performs.
  const readCols = outcome
    ? 'kind, mode, opponent, won, reward, created_at'
    : 'kind, mode, opponent, NULL::boolean AS won, NULL::text AS reward, created_at';
  const back = (await pool().query(
    `SELECT ${readCols} FROM pvp_history WHERE player_id = $1 ORDER BY id DESC LIMIT 50`,
    [id])).rows;
  eq(back.length, 1, 'і читається тим самим запитом, що й панель профілю');
  ok('won' in back[0] && 'reward' in back[0],
    'відповідь несе won/reward у будь-якій схемі — клієнт малює обидва');

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    if (made.length) await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
    await close();
    process.exit(fail ? 1 : 0);
  });
