#!/usr/bin/env node
'use strict';
// ── Proof that crafting cannot conjure an item ──────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/craft-check.js
//
// Crafting is where items are CREATED, so it is the last place a player could
// hand themselves a sword. The tests attack it from every direction the client
// has: crafting without materials, enhancing something owned by someone else,
// opening a box with no key, and — the one that matters most — whether a failed
// craft can leave the materials spent AND the item granted.

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const craft = require('../server/db/repos/craft');
const { GEAR_CRAFT_RECIPES, MERCHANT_SHOP, BOX_DEF, ITEM_DEF, ENHANCE_MAX } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'cr-' + String(process.pid).slice(-5);
const made = [];
async function mk(nick) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  await tx(t => players.setClass(t, id, 'deathknight'));
  return id;
}
const give = (pid, itemId, qty = 1, enhance = 0) => tx(async t => {
  await items.lockPlayer(t, pid);
  return items.add(t, pid, itemId, { qty, enhance });
});
const invOf = async pid => (await items.inventoryOf(null, pid)).inventory;
const countOf = async (pid, itemId) => {
  const inv = await invOf(pid);
  return inv.filter(i => i.id === itemId).reduce((n, i) => n + i.qty, 0);
};
const gold = async id => (await money.balancesOf(null, id)).gold;
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

async function main() {
  console.log(`\ncraft-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  // ── enhancement ──────────────────────────────────────────────────────────
  console.log('  ── заточка ──');
  const p = await mk('a');
  const row = await give(p, 'sw3');

  eq(await caught(() => tx(t => craft.enhance(t, p, row, 'norm'))), 'no_stone',
    'без каменя заточити неможливо');
  eq((await invOf(p)).length, 1, 'невдала спроба нічого не забрала');

  // Someone else's item, named by row id — the only thing the client sends.
  const other = await mk('other');
  const theirRow = await give(other, 'sw3');
  await give(p, 'norm_stone', 10);
  eq(await caught(() => tx(t => craft.enhance(t, p, theirRow, 'norm'))), 'not_found',
    'заточити ЧУЖИЙ предмет за його id — відмова');
  eq(await countOf(p, 'norm_stone'), 10, 'камінь не витратився на чужий предмет');

  // A real attempt: the stone is always consumed, and the outcome is one of
  // three. Repeated so all three branches are seen.
  let seen = { success: 0, fail: 0, burned: 0 };
  for (let i = 0; i < 8; i++) {
    const r = await give(p, 'sw1');
    await give(p, 'norm_stone', 1);
    const before = await countOf(p, 'norm_stone');
    const res = await tx(t => craft.enhance(t, p, r, 'norm'));
    seen[res.outcome]++;
    eq(await countOf(p, 'norm_stone'), before - 1, `спроба ${i + 1}: камінь витрачено незалежно від результату`);
    if (res.outcome === 'burned') {
      const still = (await invOf(p)).some(x => x.rowId === r);
      ok(!still, `спроба ${i + 1}: при згорянні предмет ЗНИК`);
    }
  }
  ok(seen.success + seen.fail + seen.burned === 8, `8 спроб дали 8 результатів (успіх ${seen.success}, згоріло ${seen.burned})`);

  // A blessed stone never destroys the item.
  const safeRow = await give(p, 'sw1');
  await give(p, 'bless_stone', 6);
  for (let i = 0; i < 6; i++) {
    const res = await tx(t => craft.enhance(t, p, safeRow, 'bless'));
    if (res.outcome === 'burned') { ok(false, 'благословенний камінь знищив предмет'); break; }
  }
  ok((await invOf(p)).some(x => x.rowId === safeRow), 'благословенний камінь: предмет пережив усі невдачі');

  // The rate curve, stated as the live build states it.
  eq(craft.enhanceRate(0), 80, 'шанс на +1 — 80%');
  eq(craft.enhanceRate(7), 10, 'шанс на +8 — 10% (мінімум)');
  eq(craft.enhanceRate(14), 10, 'нижче 10% не падає');

  // Cannot go past the ceiling.
  const maxed = await give(p, 'sw1', 1, ENHANCE_MAX);
  await give(p, 'norm_stone', 1);
  eq(await caught(() => tx(t => craft.enhance(t, p, maxed, 'norm'))), 'maxed',
    `заточка понад +${ENHANCE_MAX} — відмова`);

  // A material is not enhanceable.
  const mat = await give(p, 'norm_stone', 1);
  eq(await caught(() => tx(t => craft.enhance(t, p, mat, 'norm'))), 'not_enhanceable',
    'матеріал заточити неможливо');

  // ── crafting ─────────────────────────────────────────────────────────────
  console.log('  ── крафт ──');
  const c = await mk('crafter');
  const rec = GEAR_CRAFT_RECIPES[0];

  eq(await caught(() => tx(t => craft.craft(t, c, 'gear', 0))), 'no_mats',
    'крафт без матеріалів — відмова');
  eq((await invOf(c)).length, 0, 'нічого не з’явилось');

  eq(await caught(() => tx(t => craft.craft(t, c, 'gear', 99999))), 'bad_recipe',
    'неіснуючий рецепт — відмова');
  eq(await caught(() => tx(t => craft.craft(t, c, 'нема_такої', 0))), 'bad_family',
    'вигаданий тип крафту — відмова');

  // Materials that are present but NOT enhanced enough must not pass.
  for (const m of rec.mats) await give(c, m.id, m.n, 0);
  const needsEnh = rec.mats.find(m => m.minEnhance > 0);
  if (needsEnh) {
    eq(await caught(() => tx(t => craft.craft(t, c, 'gear', 0))), 'no_mats',
      `матеріал без потрібної заточки +${needsEnh.minEnhance} не рахується`);
  }

  // A real craft: materials go, the item arrives, Nexum is charged.
  const c2 = await mk('crafter2');
  for (const m of rec.mats) await give(c2, m.id, m.n, m.minEnhance || 0);
  if (rec.nexumCost) {
    await money.credit(null, c2, 'nexum', rec.nexumCost, { reason: 'seed', idemKey: `${TAG}:nx` });
  }
  const matsBefore = {};
  for (const m of rec.mats) matsBefore[m.id] = await countOf(c2, m.id);

  const res = await tx(t => craft.craft(t, c2, 'gear', 0));
  eq(res.outcome, 'success', `крафт ${rec.itemId} вдався (шанс ${rec.chance})`);
  eq(await countOf(c2, rec.itemId), 1, 'предмет отримано рівно один');
  for (const m of rec.mats) {
    eq(await countOf(c2, m.id), matsBefore[m.id] - m.n, `матеріал ${m.id} списано рівно ${m.n}`);
  }
  eq((await money.balancesOf(null, c2)).nexum, 0, 'Liberty списано за рецептом');

  // ── boxes ────────────────────────────────────────────────────────────────
  console.log('  ── бокси ──');
  const b = await mk('boxer');
  const box = BOX_DEF[0];
  eq(await caught(() => tx(t => craft.openBox(t, b, box.id))), 'no_box',
    'відкрити бокс, якого немає, — відмова');

  await give(b, box.id, 1);
  eq(await caught(() => tx(t => craft.openBox(t, b, box.id))), 'no_key', 'без ключа — відмова');
  eq(await countOf(b, box.id), 1, 'бокс НЕ витратився при відмові через ключ');

  await give(b, box.keyId, 1);
  const opened = await tx(t => craft.openBox(t, b, box.id));
  ok(opened.itemId, `бокс дав предмет (${opened.rarity}: ${opened.itemId})`);
  eq(await countOf(b, box.id), 0, 'бокс витрачено');
  eq(await countOf(b, box.keyId), 0, 'ключ витрачено');
  const validRarities = box.odds.map(o => o.rarity);
  ok(validRarities.includes(opened.rarity), `рідкість із таблиці боксу (${validRarities.join('/')})`);

  // ── merchant ─────────────────────────────────────────────────────────────
  console.log('  ── торговець ──');
  const m2 = await mk('shopper');
  const entry = MERCHANT_SHOP[0];
  eq(await caught(() => tx(t => craft.buyFromMerchant(t, m2, entry.itemId, 1))), 'no_gold',
    'купити без золота — відмова');
  eq(await countOf(m2, entry.itemId), 0, 'предмет не з’явився');

  eq(await caught(() => tx(t => craft.buyFromMerchant(t, m2, 'sw3', 1))), 'not_sold',
    'купити те, чого торговець не продає, — відмова');

  await money.credit(null, m2, 'gold', entry.price * 5, { reason: 'seed', idemKey: `${TAG}:g` });
  const bought = await tx(t => craft.buyFromMerchant(t, m2, entry.itemId, 3));
  eq(await countOf(m2, entry.itemId), 3, 'куплено рівно 3');
  eq(await gold(m2), entry.price * 5 - entry.price * 3, 'списано рівно за 3');

  // ── THE INVARIANT: a failed craft consumes nothing ───────────────────────
  console.log('  ── відкат ──');
  const r2 = await mk('rollback');
  for (const m of rec.mats) await give(r2, m.id, m.n, m.minEnhance || 0);
  const before2 = {};
  for (const m of rec.mats) before2[m.id] = await countOf(r2, m.id);

  // Nexum is missing, so the craft throws AFTER the room check — the materials
  // must come back with the transaction.
  eq(await caught(() => tx(t => craft.craft(t, r2, 'gear', 0))), 'no_nexum', 'без Liberty крафт відхилено');
  for (const m of rec.mats) {
    eq(await countOf(r2, m.id), before2[m.id], `матеріал ${m.id} НЕ витрачено при невдачі`);
  }
  eq(await countOf(r2, rec.itemId), 0, 'предмет не створився');

  // ── the rolls come from crypto, not Math.random ──────────────────────────
  console.log('  ── випадковість ──');
  const vals = Array.from({ length: 4000 }, () => craft.rand());
  ok(vals.every(v => v >= 0 && v < 1), 'усі значення в [0,1)');
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  ok(Math.abs(mean - 0.5) < 0.03, `середнє ${mean.toFixed(3)} — розподіл рівномірний`);
  ok(new Set(vals).size > 3900, 'значення не повторюються (не зациклений генератор)');
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
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
