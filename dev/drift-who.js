#!/usr/bin/env node
'use strict';
// ── кто именно расходится ───────────────────────────────────────────────────
//
//   node dev/drift-who.js
//
// Тревога items.drift печатает первые десять пар и число. Этого хватает,
// чтобы узнать О ФАКТЕ, и не хватает, чтобы решить, что делать: пара
// «игрок 6761 · sw1» одинаково выглядит и у боевого аккаунта, у которого
// предметы пропали, и у фикстуры, которую детектор набил и снёс.
//
// Разница между этими двумя случаями — вся разница между «чинить код» и
// «вычистить мусор», поэтому она должна быть видна, а не угадываться.
//
// Классификация — та же, что у dev/purge-test-accounts.js, буква в букву:
// две проверки, которые расходятся в том, кого считают тестовым, хуже одной.
const { pool, close } = require('../server/db');
const items = require('../server/db/repos/items');

// `tag-12345_role`, плюс несколько ручных проб с самого начала.
const TEST_USERNAME = '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)';
const NEVER = ['1199957588', '8868342638'];

async function main() {
  const drift = await items.reconcile(null);
  if (drift === null) {
    console.log('\n  сверка не запускалась: миграции 012 нет\n');
    process.exitCode = 2;
    return;
  }
  if (!drift.length) { console.log('\n  расхождений нет\n'); return; }

  const ids = [...new Set(drift.map(d => Number(d.playerId)))];
  console.log(`\nрасхождений: ${drift.length} пар у ${ids.length} аккаунтов\n`);

  const { rows } = await pool().query(
    `SELECT p.id, p.username, p.telegram_id, p.created_at,
            (p.username ~ $2 OR p.telegram_id !~ '^[0-9]+$') AS is_test,
            (p.telegram_id = ANY($3))                        AS is_live
       FROM players p WHERE p.id = ANY($1) ORDER BY p.id`,
    [ids, TEST_USERNAME, NEVER]);

  const test = rows.filter(r => r.is_test);
  const real = rows.filter(r => !r.is_test);
  const live = rows.filter(r => r.is_live);

  console.log(`  тестовых:  ${test.length}`);
  console.log(`  НЕ тестовых: ${real.length}`);
  console.log(`  из них заведомо живых: ${live.length}`);

  // Единственная строка, ради которой всё это написано.
  if (real.length === 0) {
    console.log('\n  ✓ ни одного боевого аккаунта среди расходящихся —');
    console.log('    это мусор фикстур, а не потеря предметов у игроков.');
  } else {
    console.log('\n  ✗ БОЕВЫЕ АККАУНТЫ В СПИСКЕ — это баг, а не мусор:');
    for (const r of real.slice(0, 20)) {
      const mine = drift.filter(d => Number(d.playerId) === Number(r.id));
      console.log(`    ${r.id}  ${r.username}  tg ${r.telegram_id}`
        + `  пар ${mine.length}  ${mine.slice(0, 3).map(m => m.itemId + ':' + m.drift).join(' ')}`);
    }
    if (real.length > 20) console.log(`    … и ещё ${real.length - 20}`);
  }

  // Какие предметы и на какие величины — по этому видно, один это источник
  // или несколько разных.
  const byItem = new Map();
  for (const d of drift) {
    const r = byItem.get(d.itemId) || { n: 0, drifts: new Set() };
    r.n++; r.drifts.add(Number(d.drift));
    byItem.set(d.itemId, r);
  }
  console.log('\n  по предметам:');
  for (const [id, r] of [...byItem].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
    const vals = [...r.drifts].sort((a, b) => a - b);
    console.log(`    ${id.padEnd(12)} пар ${String(r.n).padStart(4)}`
      + `  величины: ${vals.slice(0, 6).join(', ')}${vals.length > 6 ? ' …' : ''}`);
  }

  // Когда эти аккаунты завелись — отвечает на «это старый мусор или свежий».
  const days = new Map();
  for (const r of rows) {
    const d = new Date(r.created_at).toISOString().slice(0, 10);
    days.set(d, (days.get(d) || 0) + 1);
  }
  console.log('\n  когда заведены:');
  for (const [d, n] of [...days].sort()) console.log(`    ${d}  ${n}`);

  console.log('');
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(close);
