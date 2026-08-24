#!/usr/bin/env node
'use strict';
// ── Proof that a clan cannot lose a change or a shard ───────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/clans-check.js
//
// The races here are the ones clan.save() lost: two officers accepting at
// once, two allocations drawing on the same stack, two kills adding clan xp
// in the same tick. Each ran as a read-modify-write of the whole document, so
// one of the two changes simply vanished.

const { pool, tx, txRetry, close } = require('../server/db');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const clans = require('../server/db/repos/clans');
const {
  CLAN_MAX_MEMBERS, CLAN_CREATE_COST, UNIQUE_SHARDS, CLAN_STORAGE_MIN_DAYS,
} = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'cchk-' + String(process.pid).slice(-5);
const made = [], clanIds = [];
const SHARD = UNIQUE_SHARDS[0].id;

async function mk(nick, gold = 0) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  if (gold) await money.credit(null, id, 'gold', gold, { reason: 'seed', idemKey: `${TAG}:g:${id}` });
  return id;
}
const gold = async id => (await money.balancesOf(null, id)).gold;
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };
const giveShards = (pid, n) => tx(async t => { await items.lockPlayer(t, pid); await items.add(t, pid, SHARD, { qty: n }); });
const shardsOf = async pid => {
  const inv = await items.inventoryOf(null, pid);
  return (inv.inventory.find(i => i.id === SHARD) || { qty: 0 }).qty;
};

// Moves every membership in a clan back in time, so the days-in-clan rule can
// be satisfied without the suite sleeping for a week.
const backdateJoin = (clanId, days) => pool().query(
  `UPDATE clan_members SET joined_at = now() - ($2 || ' days')::interval WHERE clan_id = $1`,
  [clanId, String(days)]);

async function main() {
  console.log(`\nclans-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  // ── create ───────────────────────────────────────────────────────────────
  const leader = await mk('lead', 500);
  const c = await tx(t => clans.create(t, leader, `${TAG.slice(-4)}A`, 3));
  clanIds.push(c.clanId);
  eq(await gold(leader), 500 - CLAN_CREATE_COST, 'створення клану списало золото');
  const view = await clans.fullView(null, c.clanId);
  eq(view.members.length, 1, 'засновник — єдиний учасник');
  eq(view.members[0].role, 'leader', 'він лідер');

  eq(await caught(() => tx(t => clans.create(t, leader, `${TAG.slice(-4)}B`, 3))), 'in_clan',
    'створити другий клан, будучи в клані, неможливо');

  // Name collision must leave the gold untouched — the transaction rolls it
  // back, which is the manual refund the old path had to write.
  const rich = await mk('rich', 500);
  eq(await caught(() => tx(t => clans.create(t, rich, `${TAG.slice(-4)}a`, 5))), 'name_taken',
    'зайнята назва (без огляду на регістр) відхилена');
  eq(await gold(rich), 500, 'за невдале створення золото НЕ списалось');

  // ── applications ─────────────────────────────────────────────────────────
  const m1 = await mk('m1'), m2 = await mk('m2');
  await tx(t => clans.apply(t, m1, c.clanId));
  await tx(t => clans.apply(t, m2, c.clanId));
  eq((await clans.fullView(null, c.clanId)).applications.length, 2, 'дві заявки видно лідеру');

  eq(await caught(() => tx(t => clans.accept(t, m1, c.clanId, m2))), 'not_leader',
    'приймати може лише лідер');

  await tx(t => clans.accept(t, leader, c.clanId, m1));
  eq((await clans.fullView(null, c.clanId)).members.length, 2, 'учасника прийнято');
  await tx(t => clans.decline(t, leader, c.clanId, m2));
  eq((await clans.fullView(null, c.clanId)).applications.length, 0, 'другу заявку відхилено');

  eq((await clans.clanOf(null, m1)).clanId, c.clanId, 'clanOf знаходить клан учасника');

  // ── THE RACE: the member cap ─────────────────────────────────────────────
  // clan.save() lost one of two concurrent accepts, so the clan went over its
  // cap. Fill to CLAN_MAX_MEMBERS - 1, then accept two applicants at once.
  const fillers = [];
  for (let i = (await clans.fullView(null, c.clanId)).members.length; i < CLAN_MAX_MEMBERS - 1; i++) {
    const f = await mk('f' + i);
    fillers.push(f);
    await tx(t => clans.apply(t, f, c.clanId));
    await tx(t => clans.accept(t, leader, c.clanId, f));
  }
  eq((await clans.fullView(null, c.clanId)).members.length, CLAN_MAX_MEMBERS - 1, 'клан заповнено до передостаннього місця');

  const a1 = await mk('a1'), a2 = await mk('a2');
  await tx(t => clans.apply(t, a1, c.clanId));
  await tx(t => clans.apply(t, a2, c.clanId));
  const both = await Promise.all([
    txRetry(t => clans.accept(t, leader, c.clanId, a1)).catch(() => null),
    txRetry(t => clans.accept(t, leader, c.clanId, a2)).catch(() => null),
  ]);
  eq(both.filter(Boolean).length, 1, 'два одночасні прийоми на останнє місце — проходить РІВНО один');
  eq((await clans.fullView(null, c.clanId)).members.length, CLAN_MAX_MEMBERS,
    `учасників рівно ${CLAN_MAX_MEMBERS}, не ${CLAN_MAX_MEMBERS + 1}`);

  // ── storage: the days-in-clan rule ───────────────────────────────────────
  // CLAN_STORAGE_MIN_DAYS counts a MEMBER'S days in the clan, not the clan's
  // own age. The rule exists so that joining, emptying the storage and leaving
  // takes a week rather than a minute — a version that gated on the clan's age
  // reads almost the same and stops nothing.
  await giveShards(m1, 100);
  eq(await caught(() => tx(t => clans.deposit(t, m1, c.clanId, SHARD, 10))), 'too_new',
    `учасник, який щойно вступив, до сховища не допущений (треба ${CLAN_STORAGE_MIN_DAYS} днів)`);
  eq(await shardsOf(m1), 100, 'відмова нічого не забрала');
  eq((await clans.storageView(null, c.clanId, m1)).canUse, false,
    'панель показує, що складом ще не можна користуватись');

  // Backdated so the rest of the storage tests can run. Everything below is
  // about conservation, which is a different property from access.
  await backdateJoin(c.clanId, CLAN_STORAGE_MIN_DAYS + 1);
  eq((await clans.storageView(null, c.clanId, m1)).canUse, true,
    'через потрібну кількість днів доступ відкривається');

  // ── storage: shards are conserved ────────────────────────────────────────
  eq(await caught(() => tx(t => clans.deposit(t, m1, c.clanId, 'sw1', 1))), 'not_shard',
    'у сховище приймаються лише Осколки');
  eq(await caught(() => tx(t => clans.deposit(t, m1, c.clanId, SHARD, 999))), 'not_enough',
    'покласти більше, ніж є, — відмова');
  eq(await shardsOf(m1), 100, 'невдалий внесок нічого не забрав');

  await tx(t => clans.deposit(t, m1, c.clanId, SHARD, 60));
  eq(await shardsOf(m1), 40, 'внесок списав рівно 60');
  eq((await clans.fullView(null, c.clanId)).storage[0].qty, 60, 'у сховищі 60');

  // Two allocations drawing on the same stack, at once: 40 + 40 out of 60.
  const race = await Promise.all([
    txRetry(t => clans.allocate(t, leader, c.clanId, m1, SHARD, 40)).catch(() => null),
    txRetry(t => clans.allocate(t, leader, c.clanId, a1, SHARD, 40)).catch(() => null),
  ]);
  eq(race.filter(Boolean).length, 1, 'дві одночасні видачі з одного стеку — проходить РІВНО одна');
  const afterAlloc = await clans.fullView(null, c.clanId);
  const inStore = afterAlloc.storage.reduce((n, s) => n + s.qty, 0);
  const inAlloc = afterAlloc.allocations.reduce((n, a) => n + a.qty, 0);
  eq(inStore + inAlloc, 60, 'у сховищі + у видачах = рівно 60, нічого не зникло і не додалось');

  // Claiming moves it to the member and clears the record, atomically.
  const alloc = afterAlloc.allocations[0];
  const holder = alloc.playerId;
  const before = await shardsOf(holder);
  await tx(t => clans.claim(t, holder, alloc.id));
  eq(await shardsOf(holder), before + alloc.qty, 'отримувач забрав Осколки');
  eq((await clans.fullView(null, c.clanId)).allocations.length, 0, 'запис про видачу зник');
  eq(await caught(() => tx(t => clans.claim(t, holder, alloc.id))), 'not_found',
    'забрати ту саму видачу вдруге неможливо');

  // ── leaving and disbanding are blocked while goods are outstanding ───────
  await tx(t => clans.allocate(t, leader, c.clanId, m1, SHARD, 5));
  eq(await caught(() => tx(t => clans.leave(t, m1))), 'holds_shards',
    'вийти з клану з невибраними Осколками неможливо');
  eq(await caught(() => tx(t => clans.kick(t, leader, c.clanId, m1))), 'holds_shards',
    'виключити такого учасника теж неможливо');

  const pending = (await clans.fullView(null, c.clanId)).allocations[0];
  await tx(t => clans.cancelAllocation(t, leader, c.clanId, pending.id));
  eq((await clans.fullView(null, c.clanId)).storage.reduce((n, s) => n + s.qty, 0), 20,
    'скасована видача повернулась у сховище');

  await tx(t => clans.leave(t, m1));
  ok(!(await clans.clanOf(null, m1)), 'учасник вийшов, коли нічого не винен');

  eq(await caught(() => tx(t => clans.disband(t, leader, c.clanId))), 'storage_not_empty',
    'розформувати клан із непорожнім сховищем неможливо');

  // ── xp: two kills in the same tick must both count ───────────────────────
  const xpBefore = (await clans.fullView(null, c.clanId)).xp;
  await Promise.all([
    tx(t => clans.addXp(t, c.clanId, 300)),
    tx(t => clans.addXp(t, c.clanId, 300)),
  ]);
  const after = await clans.fullView(null, c.clanId);
  eq(after.xp, xpBefore + 600, 'два одночасні нарахування досвіду клану не загубились');
  eq(after.level, clans.levelFor(after.xp), 'рівень клану порахований за таблицею');

  // ── one player, one clan — enforced by the schema ────────────────────────
  // fillers[0], not a1/a2: those two raced for the last slot and only the
  // winner is in the clan, so which of them is a member is not deterministic.
  // An earlier version of this test used a1 and failed on a correct refusal.
  const inClan = fillers[0];
  const other = await mk('other', 500);
  const c2 = await tx(t => clans.create(t, other, `${TAG.slice(-4)}C`, 7));
  clanIds.push(c2.clanId);

  eq(await caught(() => tx(t => clans.apply(t, inClan, c2.clanId))), 'in_clan',
    'подати заявку в другий клан, будучи в клані, неможливо');

  // And the schema refuses it even bypassing the application entirely — the
  // guard above is convenience, this is the guarantee.
  let rawDouble = false;
  try {
    await pool().query('INSERT INTO clan_members (clan_id, player_id) VALUES ($1,$2)', [c2.clanId, inClan]);
    rawDouble = true;
  } catch { /* clan_members_one_clan_key */ }
  ok(!rawDouble, 'другий клан неможливий навіть прямим записом повз застосунок');

  eq((await clans.search(null, TAG.slice(-4))).length, 2, 'пошук знаходить обидва клани');
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (clanIds.length) {
    await q('DELETE FROM clan_allocations WHERE clan_id = ANY($1)', [clanIds]);
    await q('DELETE FROM clan_storage     WHERE clan_id = ANY($1)', [clanIds]);
    await q('DELETE FROM clan_applications WHERE clan_id = ANY($1)', [clanIds]);
    await q('DELETE FROM clan_members     WHERE clan_id = ANY($1)', [clanIds]);
    await q('DELETE FROM clans            WHERE id = ANY($1)', [clanIds]);
  }
  if (!made.length) return;
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
