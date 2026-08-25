#!/usr/bin/env node
'use strict';
// ── Test fixtures do not belong in the live database ────────────────────────
//
//   node dev/purge-test-accounts.js           — show what would go
//   APPLY=1 node dev/purge-test-accounts.js   — remove it
//
// Every suite here runs against the real database, because that is the only
// PostgreSQL this project has and testing against a different one proves less.
// The cost is debris: each run leaves an account behind, and after two days of
// them there were 2362 accounts for 2 players. Six of the ETL fixtures carried
// a battle rating of 500 and sat in the rating table players can open.
//
// It matters more than tidiness right now: the real Mongo data is about to be
// imported into this database, and it should land in a clean one.
//
// ── how a test account is recognised ────────────────────────────────────────
// By USERNAME, against the shape every fixture in dev/ builds: a short tag, a
// slice of the process id, then a role — `pl-60043_player`, `kl-62126_hunter`,
// `gchk-31135_vip2`. A real Telegram display name would have to be built to
// that pattern on purpose to match.
//
// NOT by "telegram_id looks synthetic": the socket suites log in through the
// real Telegram verification path and therefore use numeric ids (910…, 920…,
// 930…), which are indistinguishable from a real account's by shape. Going the
// other way — "keep the two ids I know about, delete the rest" — would delete
// a third real player the moment one arrives.
//
// The two known live accounts are listed anyway, as a second lock: if the
// pattern ever matched one of them the run refuses outright rather than
// deleting and reporting it afterwards.

const { pool, tx, close } = require('../server/db');

const APPLY = process.env.APPLY === '1';

// Belt and braces — these are never deleted whatever the pattern says.
const NEVER = ['1199957588', '8868342638'];

// `tag-12345_role`, plus the handful of hand-made probes from early setup.
const TEST_USERNAME = `^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)`;

async function main() {
  console.log(`\npurge-test-accounts  (${APPLY ? 'ВИДАЛЕННЯ' : 'тільки показ'})\n`);

  const { rows: keep } = await pool().query(
    `SELECT id, username, telegram_id, bm FROM players
      WHERE telegram_id = ANY($1) ORDER BY id`, [NEVER]);
  console.log('  живі акаунти, які не чіпаємо:');
  for (const k of keep) console.log(`    ${k.username}  tg ${k.telegram_id}  БМ ${k.bm}`);
  if (keep.length !== NEVER.length) {
    console.log('\n  ✗ не всі відомі живі акаунти знайдено — зупиняюсь');
    process.exitCode = 1;
    return;
  }

  // The refusal that matters: if the pattern reaches a live account, the
  // pattern is wrong and nothing should be deleted on the strength of it.
  const { rows: clash } = await pool().query(
    `SELECT username FROM players
      WHERE telegram_id = ANY($1) AND username ~ $2`, [NEVER, TEST_USERNAME]);
  if (clash.length) {
    console.log(`\n  ✗ шаблон зачіпає живий акаунт (${clash.map(c => c.username).join(', ')}) — зупиняюсь`);
    process.exitCode = 1;
    return;
  }

  // Two clauses, and the second is the stronger one: a real Telegram id is
  // always a number, so anything else is a fixture whatever it calls itself.
  // (players-check builds `dup1` with telegram_id `pchk-30443-dup` — the name
  // matches nothing, the id gives it away.)
  const { rows: doomed } = await pool().query(
    `SELECT id FROM players
      WHERE (username ~ $1 OR telegram_id !~ '^[0-9]+$')
        AND NOT (telegram_id = ANY($2))`,
    [TEST_USERNAME, NEVER]);
  const ids = doomed.map(r => Number(r.id));

  const { rows: total } = await pool().query('SELECT count(*)::int n FROM players');
  console.log(`\n  усього акаунтів: ${total[0].n}`);
  console.log(`  збігається з шаблоном: ${ids.length}`);
  console.log(`  лишиться: ${total[0].n - ids.length}`);

  if (!ids.length) { console.log('\n  нічого прибирати\n'); return; }

  const { rows: sample } = await pool().query(
    `SELECT username FROM players WHERE id = ANY($1) ORDER BY id LIMIT 6`, [ids]);
  console.log(`  наприклад: ${sample.map(s => s.username).join(', ')} …`);

  const { rows: led } = await pool().query(
    'SELECT count(*)::int n FROM ledger WHERE player_id = ANY($1)', [ids]);
  console.log(`  їхніх рядків у леджері: ${led[0].n}`);

  if (!APPLY) { console.log('\n  нічого не змінено — запусти з APPLY=1\n'); return; }

  // ── what the application user is allowed to do ───────────────────────────
  // Nothing here, as it turns out — and rightly. liberty_app has no DELETE on
  // `ledger`, because a process that moves real money must not be able to
  // erase the record of having moved it. The ledger then holds these accounts
  // in place through its own foreign key.
  //
  // So the removal needs the admin credential and belongs with the next thing
  // that needs it anyway. What CAN be done from here is the part a player
  // actually sees: battle rating orders the rating table, and six ETL fixtures
  // were sitting in it at 500 — above every real player but two. Zeroed, they
  // sort below everyone and appear in no top-N. The rows stay; nobody sees
  // them.
  //
  // It does not come back: bm is written by stats.refreshBm on a level-up or
  // an equip, and these accounts never log in again.
  const { rowCount: zeroed } = await pool().query(
    'UPDATE players SET bm = 0 WHERE id = ANY($1) AND bm <> 0', [ids]);
  console.log('  прибрано з рейтингу: ' + zeroed + ' акаунтів (БМ → 0)');

  const { rows: topNow } = await pool().query(
    'SELECT username, bm FROM players ORDER BY bm DESC NULLS LAST LIMIT 5');
  console.log('  рейтинг тепер:');
  for (const t of topNow) console.log('    ' + t.username + '  ' + t.bm);

  if (!process.env.ADMIN_URL) {
    console.log('');
    console.log('  Повне видалення рядків потребує doadmin.');
    console.log('  Запусти: bash /srv/liberty/purge-test.sh');
    console.log('');
    return;
  }


  // The ledger has no ON DELETE CASCADE, deliberately: a money history must
  // not disappear because an account did. That rule is about REAL money, and
  // these rows are fixtures — removing both sides together is what keeps
  // reconcile() consistent, since it compares per-account sums.
  //
  // In batches, because a single statement over two thousand accounts and
  // their whole history is one long lock on tables the live game is using.
  const BATCH = 200;
  let removed = 0, ledRemoved = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    await tx(async (t) => {
      const l = await t.query('DELETE FROM ledger WHERE player_id = ANY($1)', [chunk]);
      ledRemoved += l.rowCount;
      // An item held by a listing has player_id NULL, so the cascade from
      // players never reaches it — the listing goes first, then the orphan.
      await t.query(`DELETE FROM player_items WHERE player_id IS NULL AND id IN (
        SELECT item_id FROM market_listings WHERE seller_id = ANY($1) AND item_id IS NOT NULL)`, [chunk]);
      await t.query('DELETE FROM market_listings WHERE seller_id = ANY($1) OR buyer_id = ANY($1)', [chunk]);
      const r = await t.query('DELETE FROM players WHERE id = ANY($1)', [chunk]);
      removed += r.rowCount;
    });
    process.stdout.write(`\r  видалено ${removed}/${ids.length}`);
  }
  console.log(`\n  рядків леджера прибрано: ${ledRemoved}`);

  // What the cleanup must not have broken.
  const { rows: after } = await pool().query('SELECT count(*)::int n FROM players');
  const { rows: orphan } = await pool().query(`
    SELECT count(*)::int n FROM player_items pi
     WHERE pi.player_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM market_listings m WHERE m.item_id = pi.id)`);
  const { rows: drift } = await pool().query(`
    SELECT count(*)::int n FROM (
      SELECT b.player_id, b.currency, b.amount,
             COALESCE((SELECT sum(l.delta) FROM ledger l
                        WHERE l.player_id = b.player_id AND l.currency = b.currency), 0) AS led
        FROM balances b) x
     WHERE x.amount <> x.led`);
  const { rows: top } = await pool().query(
    'SELECT username, bm FROM players ORDER BY bm DESC NULLS LAST LIMIT 5');

  console.log(`\n  лишилось акаунтів: ${after[0].n}`);
  console.log(`  безхазяйних предметів: ${orphan[0].n}`);
  console.log(`  розбіжність баланс↔леджер: ${drift[0].n}`);
  console.log('  рейтинг тепер:');
  for (const t of top) console.log(`    ${t.username}  ${t.bm}`);
  console.log('');
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => close());
