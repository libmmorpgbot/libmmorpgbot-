#!/usr/bin/env node
'use strict';
// ── Empty the game tables before the real migration ────────────────────────
//
//   node dev/wipe-game-data.js --yes
//
// Every account created while testing is a landmine under the ETL. The
// migration is idempotent by `ON CONFLICT (telegram_id) DO NOTHING`, which is
// what makes it safe to re-run — and it means an account that already exists
// is SKIPPED. So a player who opened the test build once would have their real
// progress silently not migrated: a month of play replaced by whatever the
// test account happened to hold, with no error anywhere.
//
// That is the single worst failure this migration can have, and the fix is to
// start the real run against empty tables. This is that step, written down and
// runnable rather than a line in a checklist someone reads at 3am.
//
// It refuses without --yes, refuses unless WIPE_CONFIRM names the database,
// and prints what it is about to destroy first.

const { close, query } = require('../server/db');

// Order does not matter — one TRUNCATE with CASCADE handles the foreign keys —
// but naming every table explicitly does: a table added later and forgotten
// here would survive the wipe and poison the run, so the list is checked
// against the schema below rather than assumed complete.
const TABLES = [
  'ledger', 'balances', 'gram_tx', 'unmatched_deposits',
  'player_items', 'player_progress', 'player_prefs', 'player_skills',
  'player_vip', 'player_season', 'player_special_quests', 'player_daily',
  'clan_members', 'clan_applications', 'clan_storage', 'clan_allocations', 'clans',
  'market_listings', 'chat_messages', 'clan_chat', 'direct_messages',
  'pvp_history', 'guild_war_state', 'boss_state', 'players',
  // Partitioned. Truncating the parent empties every partition, and the
  // partitions themselves are excluded from the completeness check below —
  // listing them would mean editing this file every month.
  'player_logs',
];

// Deliberately NOT wiped, with the reason:
//   item_catalog    rebuilt from shared/definitions at every boot
//   special_quests  authored by an admin, not player data
//   admin_actions   the audit trail; erasing it is the one thing an audit
//                   trail must not permit
//   kv              holds the deposit scanner's watermark; see below
//   schema_migrations
const KEEP = ['item_catalog', 'special_quests', 'admin_actions', 'schema_migrations'];

async function main() {
  const dbName = (process.env.DATABASE_URL || '').split('/').pop().split('?')[0];
  console.log(`\nwipe-game-data  ·  база: ${dbName}\n`);

  // Partitions are skipped: they are not tables anyone truncates directly, and
  // a new one appears every month. The parent stands for all of them.
  const { rows: all } = await query(null, `
    SELECT t.tablename FROM pg_tables t
     WHERE t.schemaname = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = t.tablename AND n.nspname = 'public')
     ORDER BY t.tablename`);
  const known = new Set([...TABLES, ...KEEP, 'kv']);
  const unknown = all.map(r => r.tablename).filter(t => !known.has(t));
  if (unknown.length) {
    console.error(`  ✗ у схемі є таблиці, яких немає у списку: ${unknown.join(', ')}`);
    console.error('    Додайте їх у TABLES або в KEEP — мовчазно лишити їх не можна.');
    process.exit(1);
  }

  const counts = [];
  for (const t of TABLES) {
    const { rows } = await query(null, `SELECT count(*)::int n FROM ${t}`);
    if (rows[0].n) counts.push(`${t}=${rows[0].n}`);
  }
  console.log(counts.length ? `  буде стерто: ${counts.join(' ')}` : '  таблиці вже порожні');
  console.log(`  лишиться недоторканим: ${KEEP.join(' ')}\n`);

  if (!process.argv.includes('--yes')) {
    console.log('  нічого не зроблено. Додайте --yes, щоб виконати.');
    return;
  }
  if (process.env.WIPE_CONFIRM !== dbName) {
    console.error(`  ✗ WIPE_CONFIRM має дорівнювати "${dbName}". Це друга рука на кнопці.`);
    process.exit(1);
  }

  await query(null, `TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  // The deposit watermark tells the scanner where it stopped reading the
  // chain. Left behind, it would skip every deposit that arrived during
  // testing — including a real one, if anyone had sent it early.
  await query(null, `DELETE FROM kv WHERE key LIKE 'deposit%'`);
  console.log('  готово. Таблиці порожні, лічильники id скинуто.');
}

main()
  .catch(err => { console.error('\n', err); process.exitCode = 1; })
  .finally(() => close().catch(() => {}));
