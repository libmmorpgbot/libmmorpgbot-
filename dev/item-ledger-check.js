#!/usr/bin/env node
'use strict';
// ── Proof that an item cannot appear or vanish without a record ─────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/item-ledger-check.js
//
// dev/money-check.js proves the currency ledger cannot lose or invent money.
// This is the same proof for items, and it exists because until migration 012
// there was nothing to prove it against: `player_items` carried a `source`
// column (migration 011) that DIED WITH THE ROW, so a destroyed item left no
// trace and an item created around items.add() left none either.
//
// Two halves, and the first one is the reason this file can fail for a reason
// no database test could catch:
//
//   STATIC   every statement in the live server that inserts, deletes or
//            re-quantifies a player_items row is checked to sit in a function
//            that also writes the ledger. A database test only exercises the
//            paths it thinks to call; this one fails when the ledger write is
//            deleted from ANY path, including one nobody wrote a test for, and
//            when a NEW path is added without one.
//
//   LIVE     the invariant itself, against a real PostgreSQL — including the
//            two shapes a dupe actually takes, and the REVOKE that stops the
//            application rewriting the evidence.
//
// Every test creates its own accounts and removes them at the end.

const fs = require('fs');
const path = require('path');
const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);
// The SQLSTATE of whatever was raised, or null if nothing was. The same helper
// dev/money-check.js and dev/items-check.js use, for the same reason: `try { …
// flag = true } catch {}` passes on ANY error, including a typo in the test
// itself — so what it proves is "something went wrong somewhere".
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

// ═══════════════════════════════════════════════════════════════════════════
//  STATIC — every writer of player_items also writes the ledger
// ═══════════════════════════════════════════════════════════════════════════
//
// The live build only, and the file set is dev/sql-check.js's deliberately:
// server/handlers/ and server/models/ are the retired Mongo build (see
// dev/reachable-check.js) and nothing there runs.
//
// The WHOLE live tree, not just server/db/repos. Every direct writer today
// lives in the repositories, and scanning only those would pass for as long as
// that stays true — which is precisely the assumption a future handler reaching
// for `DELETE FROM player_items` breaks, on the day nobody is looking at this
// file.
const SKIP = /[\\/](handlers|models|migrations|node_modules)[\\/]|[\\/]index\.js$/;
function liveFiles(dir = 'server', out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (SKIP.test(rel.replace(/\//g, path.sep))) continue;
    if (e.isDirectory()) liveFiles(rel, out);
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const LIVE_FILES = liveFiles();

// Statements that CHANGE how many of an item an account holds. A container
// move (`SET container = …`) deliberately does not appear here: it changes
// where an item sits, not how many there are, and the ledger's `delta <> 0`
// means it has no well-formed row to write. See items.moveTo.
const MUTATORS = /INSERT\s+INTO\s+player_items|DELETE\s+FROM\s+player_items|UPDATE\s+player_items\s+SET\s+qty/i;

// `[async ]function NAME(…) { … }`, lifted by brace depth so nested blocks are
// included and the next function is not. Same idea as dev/item-loss-check.js's
// lift(), with one correction that matters here and cost a full run of false
// failures before it was made: the body does NOT start at the first `{` after
// the name. Every function this file cares about takes a destructured options
// object — `add(db, playerId, itemId, { enhance = 0, qty = 1, … } = {})` — and
// the first brace is that destructuring. Matching from there closes on the
// parameter list, so the "body" came out as the signature, contained no
// ledger() call, and six functions that write the ledger were reported as
// holes. The parameter list is skipped by matching PARENTHESES first.
function bodyAt(src, headerStart) {
  const open = src.indexOf('(', headerStart);
  if (open < 0) return null;
  let i = open, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  const brace = src.indexOf('{', i);
  if (brace < 0) return null;
  depth = 0;
  for (i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(headerStart, i + 1);
}

const FN_HEAD = /(?:^|\n)(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;

// Every named function in a file, with its body and the range it spans.
function functionsOf(src) {
  const out = [];
  FN_HEAD.lastIndex = 0;
  let m;
  while ((m = FN_HEAD.exec(src))) {
    const start = m.index + (m[0][0] === '\n' ? 1 : 0);
    const body = bodyAt(src, start);
    if (body) out.push({ name: m[1], start, end: start + body.length, body });
  }
  return out;
}

// Which function contains this offset. Reading the list rather than scanning
// backwards for a keyword means a match inside a template literal or a comment
// cannot be attributed to the wrong function.
function enclosingFn(fns, at) {
  return fns.find(f => at >= f.start && at < f.end) || null;
}

function staticScan() {
  console.log('\nitem-ledger-check · статична частина\n');
  let statements = 0;
  const holes = [];

  for (const rel of LIVE_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const fns = functionsOf(src);
    const re = new RegExp(MUTATORS.source, 'gi');
    let m;
    while ((m = re.exec(src))) {
      // The ledger helper itself must not be required to call itself.
      const fn = enclosingFn(fns, m.index);
      if (!fn || fn.name === 'ledger') continue;
      statements++;
      // The function that changes the quantity must also record it — either by
      // calling the shared helper directly (`ledger(` inside items.js,
      // `items.ledger(` from another repo).
      if (/\bledger\(/.test(fn.body)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      holes.push(`${rel}:${line} ${fn.name}() — ${m[0].replace(/\s+/g, ' ')}`);
    }
  }

  ok(holes.length === 0,
    'кожен запис у player_items супроводжується записом у леджер',
    holes.join(' · '));

  // ── A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS ────────────────────
  // The same hole dev/sql-check.js closed: every way of breaking the scan
  // itself — a rename of server/db/repos, one wrong character in the regex —
  // comes out as a green run against source it never read. The floor is far
  // below the real figure (17 statements today), so ordinary growth and
  // ordinary deletion never trip it; only a scan that has stopped working can.
  ok(statements >= 10,
    'сканування справді знайшло запис-статементи',
    `знайдено лише ${statements}`);

  // Named individually as well as counted, because the scan above passes if a
  // whole file stops being read. These are the six functions in repos/items.js
  // that every other path funnels through, plus the four that write
  // player_items directly and therefore carry their own ledger call.
  //
  // COUNTED, not merely present — and that distinction is the difference
  // between a check that works and one that reads as though it does. add() has
  // TWO write paths, the stack merge and the insert, and "does this function
  // mention ledger()" goes on passing after either one is deleted: the other
  // call satisfies the test while half of every grant stops being recorded.
  // The number is the minimum, so an added path cannot lower it.
  const named = [
    ['server/db/repos/items.js', 'add', 2],               // merge + insert
    ['server/db/repos/items.js', 'removeQty', 1],
    ['server/db/repos/items.js', 'consumeMatching', 1],
    ['server/db/repos/items.js', 'removeRow', 1],
    ['server/db/repos/items.js', 'detachForListing', 1],
    ['server/db/repos/items.js', 'attachFromListing', 1],
    ['server/db/repos/craft.js', 'enhance', 1],
    ['server/db/repos/progression.js', 'burnItem', 1],
    ['server/db/repos/progression.js', 'burnAllOfRarity', 1],
    ['server/db/repos/consumables.js', 'registerCodexItem', 1],
  ];
  for (const [rel, fnName, least] of named) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const fn = functionsOf(src).find(f => f.name === fnName);
    const n = fn ? (fn.body.match(/\bledger\(/g) || []).length : 0;
    ok(!!fn && n >= least,
      `${path.basename(rel)} ${fnName}() пише в леджер${least > 1 ? ` (${least} шляхи)` : ''}`,
      fn ? `викликів ledger(): ${n}, потрібно ${least}` : 'функцію не знайдено');
  }

  // moveTo is the deliberate exception, and it is asserted rather than left to
  // be rediscovered: if somebody later "fixes" it by adding a ledger call, the
  // table fills with rows an equip did not justify and the reason vocabulary
  // stops meaning anything.
  {
    const src = fs.readFileSync(path.join(ROOT, 'server/db/repos/items.js'), 'utf8');
    const fn = functionsOf(src).find(f => f.name === 'moveTo');
    ok(!!fn && !/\bledger\(/.test(fn.body),
      'moveTo() НЕ пише в леджер — зміна контейнера не змінює кількість',
      fn ? 'з\'явився виклик ledger()' : 'функцію не знайдено');
  }

  // The REVOKE that actually holds is the one in migrate.sh, because the GRANT
  // above it re-runs on every invocation and hands UPDATE and DELETE back. A
  // REVOKE that lives only in the migration is undone by the next migration
  // run, which is a silent downgrade of the whole guarantee.
  const mig = fs.readFileSync(path.join(ROOT, 'server/db/migrate.sh'), 'utf8');
  ok(/REVOKE\s+UPDATE,\s*DELETE\s+ON\s+item_ledger\s+FROM\s+liberty_app/i.test(mig),
    'migrate.sh відкликає UPDATE/DELETE на item_ledger',
    'без цього GRANT наприкінці migrate.sh повертає їх на кожному запуску');
}

// ═══════════════════════════════════════════════════════════════════════════
//  LIVE — the invariant, against a real database
// ═══════════════════════════════════════════════════════════════════════════

const TAG = 'ilchk-' + process.pid;
const made = [];
let leftover = false;   // прибирання не впоралось — код виходу має це показати
async function mkPlayer(nick) {
  const { rows } = await pool().query(
    'INSERT INTO players (telegram_id, username) VALUES ($1,$2) RETURNING id',
    [`${TAG}-${nick}`, `${TAG}_${nick}`]);
  made.push(Number(rows[0].id));
  return Number(rows[0].id);
}

const SWORD = 'sw1';

// Every ledger row for one account, oldest first.
async function ledgerOf(playerId) {
  const { rows } = await pool().query(
    `SELECT item_id, delta, qty_after, reason, ref_type, ref_id, row_id
       FROM item_ledger WHERE player_id = $1 ORDER BY id`, [playerId]);
  return rows;
}

async function drifted() {
  const all = await items.reconcile(null);
  return all === null ? null : all.filter(r => made.includes(r.playerId));
}

async function main() {
  console.log(`\nitem-ledger-check · жива частина  (${TAG})\n`);

  await tx(t => items.syncCatalog(t));

  // The whole file is meaningless if the migration has not been applied, and
  // it must SAY so rather than passing quietly — a suite that goes green while
  // checking nothing is worse than one that is switched off.
  const { rows: exists } = await pool().query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'item_ledger'`);
  if (!exists.length) {
    ok(false, 'таблиця item_ledger існує',
      'міграцію 012_item_ledger.sql не застосовано — жива частина не перевіряє нічого');
    return;
  }
  ok(true, 'таблиця item_ledger існує');

  const { rows: matRow } = await pool().query(
    'SELECT item_id FROM item_catalog WHERE stackable AND slot=$1 LIMIT 1', ['material']);
  const STACKABLE = matRow[0].item_id;

  // ── 1. a grant leaves a row that says where it came from ─────────────────
  const a = await mkPlayer('a');
  await tx(async t => {
    await items.lockPlayer(t, a);
    await items.add(t, a, SWORD, { source: 'kill', sourceRef: 'eid42' });
  });
  let led = await ledgerOf(a);
  eq(led.length, 1, 'видача предмета лишає рівно один рядок у леджері');
  eq(Number(led[0].delta), 1, 'дельта видачі +1');
  eq(Number(led[0].qty_after), 1, 'qty_after дорівнює тому, що на руках');
  eq(led[0].reason, 'kill', 'причина — це та сама мітка джерела, що й у міграції 011');
  eq(led[0].ref_id, 'eid42', 'sourceRef доїхав до леджера');
  ok(led[0].row_id !== null, 'рядок леджера називає player_items.id');

  // ── 2. THE CASE A LIFECYCLE LEDGER CANNOT SEE ────────────────────────────
  // A stackable is duplicated by `qty + n`, which creates no row. This is the
  // single reason the ledger counts quantities instead of row lifecycles, so
  // if this test goes, the design argument goes with it.
  await tx(async t => {
    await items.lockPlayer(t, a);
    await items.add(t, a, STACKABLE, { qty: 5, source: 'drop', sourceRef: 'wd1' });
    await items.add(t, a, STACKABLE, { qty: 3, source: 'drop', sourceRef: 'wd2' });
  });
  const stackRows = (await ledgerOf(a)).filter(r => r.item_id === STACKABLE);
  eq(stackRows.length, 2, 'ЗЛИТТЯ В СТЕК теж записане — рядок не створювався, кількість зросла');
  eq(Number(stackRows[1].delta), 3, 'друга видача — це +3, а не новий предмет');
  eq(Number(stackRows[1].qty_after), 8, 'qty_after після злиття — 8');

  // ── 3. destruction is recorded, with the same weight as creation ─────────
  await tx(async t => {
    await items.lockPlayer(t, a);
    await items.removeQty(t, a, STACKABLE, 3, { reason: 'craft_mats', refType: 'recipe', refId: 'gear:1' });
  });
  const afterTake = (await ledgerOf(a)).filter(r => r.item_id === STACKABLE);
  eq(Number(afterTake[afterTake.length - 1].delta), -3, 'списання матеріалів — це -3');
  eq(Number(afterTake[afterTake.length - 1].qty_after), 5, 'qty_after після списання — 5');

  // A take that CANNOT be satisfied writes nothing at all — the inventory was
  // not touched, so a row here would invent a movement that never happened.
  const before = (await ledgerOf(a)).length;
  const tooMany = await tx(async t => {
    await items.lockPlayer(t, a);
    return items.removeQty(t, a, STACKABLE, 999);
  });
  eq(tooMany, false, 'зняти більше, ніж є, — відмова');
  eq((await ledgerOf(a)).length, before, 'невдале зняття НЕ лишило рядка в леджері');

  // ── 4. the invariant holds while everything went through repos/items.js ──
  // Runs BEFORE the raw-write tests below, which deliberately create drift.
  // dev/money-check.js had these the other way round once and the clean check
  // failed on damage the test itself had just done.
  let d = await drifted();
  ok(d !== null && d.length === 0, 'звірка чиста, поки предмети рухались тільки через repos/items.js',
    d === null ? 'леджера немає' : JSON.stringify(d));

  // ── 5. a trade moves the count from one account to the other ─────────────
  // The seller's holding drops when the item is detached and the buyer's rises
  // when it is delivered; in between it belongs to the listing and to nobody.
  const seller = await mkPlayer('s'), buyer = await mkPlayer('b');
  const row = await tx(async t => {
    await items.lockPlayer(t, seller);
    return items.add(t, seller, SWORD, { source: 'craft', sourceRef: 'gear:2' });
  });
  await tx(t => items.detachForListing(t, row, seller, { reason: 'market_list', refType: 'listing', refId: '7' }));
  const sLed = await ledgerOf(seller);
  eq(Number(sLed[sLed.length - 1].delta), -1, 'виставлення на ринок списує з продавця');
  eq(Number(sLed[sLed.length - 1].qty_after), 0, 'у продавця лишається 0');

  // While detached the item is in NOBODY's sum — and neither side drifts,
  // because player_items counts it on neither side either.
  d = await drifted();
  eq(d.length, 0, 'предмет "у лоті" не рахується нікому — і це не розходження');

  await tx(t => items.attachFromListing(t, row, buyer, { reason: 'market_buy', refType: 'listing', refId: '7' }));
  const bLed = await ledgerOf(buyer);
  eq(Number(bLed[bLed.length - 1].delta), 1, 'доставка нараховує покупцеві');
  eq(bLed[bLed.length - 1].reason, 'market_buy', 'причина називає покупку, а не видачу');
  d = await drifted();
  eq(d.length, 0, 'після завершеної угоди обидві сторони сходяться');

  // ── 6. a rolled-back transaction leaves neither the item nor the row ─────
  const c = await mkPlayer('c');
  try {
    await tx(async t => {
      await items.lockPlayer(t, c);
      await items.add(t, c, SWORD, { source: 'admin', sourceRef: 'test' });
      throw new Error('оплата не пройшла');
    });
  } catch { /* expected */ }
  eq((await ledgerOf(c)).length, 0, 'відкочена видача не лишила запису в леджері');
  eq((await items.inventoryOf(null, c)).inventory.length, 0, 'і самого предмета теж');

  // ── 7. THE DUPE, shape one: a row inserted around items.add ──────────────
  // If the reconciler cannot see this, it is decoration.
  const e = await mkPlayer('e');
  await pool().query(
    `INSERT INTO player_items (player_id, container, item_id) VALUES ($1,'inventory',$2)`, [e, SWORD]);
  let found = (await drifted()).find(r => r.playerId === e);
  ok(found && found.drift === 1,
    'звірка ЛОВИТЬ предмет, вставлений в обхід items.add',
    found ? `drift=${found.drift}` : 'не знайшла');

  // ── 8. THE DUPE, shape two: a stack grown by arithmetic ──────────────────
  // The one a row-lifecycle ledger is blind to, and the reason for the whole
  // design. No row is created; a row that has existed honestly for months
  // simply grows.
  const f = await mkPlayer('f');
  await tx(async t => {
    await items.lockPlayer(t, f);
    await items.add(t, f, STACKABLE, { qty: 10, source: 'drop', sourceRef: 'wd9' });
  });
  await pool().query(
    `UPDATE player_items SET qty = qty + 5000 WHERE player_id = $1 AND item_id = $2`, [f, STACKABLE]);
  found = (await drifted()).find(r => r.playerId === f);
  ok(found && found.drift === 5000,
    'звірка ЛОВИТЬ роздутий стек — випадок, якого леджер життєвого циклу не бачить',
    found ? `drift=${found.drift}` : 'не знайшла');

  // ── 9. and the opposite direction: rows removed around repos/items.js ────
  // A LEFT JOIN from player_items would report nothing here, which is why
  // reconcile() uses a FULL JOIN.
  const g = await mkPlayer('g');
  await tx(async t => {
    await items.lockPlayer(t, g);
    await items.add(t, g, SWORD, { source: 'shop', sourceRef: 'pkg1' });
  });
  await pool().query('DELETE FROM player_items WHERE player_id = $1', [g]);
  found = (await drifted()).find(r => r.playerId === g);
  ok(found && found.drift === -1,
    'звірка ЛОВИТЬ предмет, видалений в обхід repos/items.js (потрібен FULL JOIN)',
    found ? `drift=${found.drift}` : 'не знайшла');

  // ── 10. the ledger is append-only to the app role ────────────────────────
  // The guarantee everything above rests on: if the application can rewrite
  // this table, the reconciler compares a number against a number the same
  // process wrote. BY SQLSTATE, not by "it threw" — 42501 insufficient_
  // privilege is the only answer that means the REVOKE in server/db/migrate.sh
  // is actually holding. Write `SET detla = 0` instead and PostgreSQL raises
  // 42703, a bare catch eats it, and a typo proves the guarantee.
  eq(await caught(() => pool().query('UPDATE item_ledger SET delta = 0 WHERE player_id = $1', [a])),
    '42501', 'застосунок не може ПЕРЕПИСАТИ леджер предметів — REVOKE UPDATE тримає');
  eq(await caught(() => pool().query('DELETE FROM item_ledger WHERE player_id = $1', [a])),
    '42501', 'і не може ВИДАЛИТИ рядок — без цього історію можна просто вкоротити');
}

async function cleanup() {
  if (!made.length) return;
  // item_ledger is ON DELETE CASCADE from players — deliberately, unlike the
  // money ledger: an account whose items are gone must not leave rows summing
  // to N against zero held, or every deleted account would drift for ever.
  // So the players delete is enough, and the listings go first because their
  // FK is not.
  // Не в .catch(() => {}). Этот файл — единственный, который создаёт
  // расхождение НАМЕРЕННО: раздутый стек, строка мимо items.add, строка,
  // снесённая мимо репозитория. Если уборка не прошла, всё это остаётся в
  // боевой базе навсегда и попадает в ночную тревогу как настоящая пропажа.
  // Проглоченный отказ здесь — это шум, который потом заглушат вместе с
  // настоящим сигналом.
  const drop = async (sql) => {
    try { await pool().query(sql, [made]); } catch (e) {
      console.error('  ! прибирання не пройшло: ' + e.message);
      leftover = true;
    }
  };
  await drop('DELETE FROM market_listings WHERE seller_id = ANY($1)');
  await drop('DELETE FROM player_items WHERE player_id = ANY($1)');
  await drop('DELETE FROM players WHERE id = ANY($1)');

  // И проверка результата, а не намерения: item_ledger уходит по ON DELETE
  // CASCADE вместе с игроком — но только если игрок ушёл.
  try {
    const rest = (await items.reconcile(null)).filter(r => made.includes(Number(r.playerId)));
    if (rest.length) {
      leftover = true;
      console.error(`  ! ПІСЛЯ ПРИБИРАННЯ ЛИШИЛОСЬ РОЗХОДЖЕННЯ: ${rest.length} пар`);
      for (const r of rest.slice(0, 5)) {
        console.error(`    гравець ${r.playerId} · ${r.itemId}: на руках ${r.held}, журнал ${r.ledgerTotal}`);
      }
      console.error('    це піде в нічну тривогу items.drift як справжня пропажа');
    }
  } catch (e) { console.error('  ! не вдалось перевірити залишки: ' + e.message); }
}

// The static half runs first and needs no database, so a misconfigured
// DATABASE_URL still gets you the structural answer.
staticScan();

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    if (leftover) console.log('  ! прибирання лишило сліди — див. вище');
    process.exit(fail || leftover ? 1 : 0);
  });
