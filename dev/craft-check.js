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
const progression = require('../server/db/repos/progression');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const craft = require('../server/db/repos/craft');
const { wipeItemsAll } = require('./fixtures');
const {
  GEAR_CRAFT_RECIPES, GEAR_TIER_CRAFT_RECIPES, MAT_UPGRADE_RECIPES, craftResultEnhance,
  CLASS_GEAR_SALVAGE_RECIPES, PET_CRAFT_RECIPES, ADV_SKILL_BOOK_CRAFT,
  BOX_DEF, ITEM_DEF, CRAFT_MATS, ENHANCE_MAX, isStackableItem,
  QUEST_DEF, questComplete,
} = require('../shared/definitions');

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

  // ── квести на заточку ────────────────────────────────────────────────────
  // «Заточи предмет до +N» зараховується по РЕЗУЛЬТАТУ вдалого кидка, а не за
  // володіння річчю: куплений на ринку +5 квест не закриває. І кожен із трьох
  // заробляється окремо — дійти до +5 на квесті з +2 не віддає два наступних.
  console.log('  ── квести на заточку ──');
  const eq2 = await mk('eq2');
  const qi2 = QUEST_DEF.findIndex(q => q.id === 'f2q11');
  const qi3 = QUEST_DEF.findIndex(q => q.id === 'f2q14');
  ok(qi2 >= 0 && QUEST_DEF[qi2].type === 'enhance' && QUEST_DEF[qi2].enhance === 2,
    'f2q11 — заточка до +2');
  ok(qi3 >= 0 && QUEST_DEF[qi3].type === 'enhance' && QUEST_DEF[qi3].enhance === 3,
    'f2q14 — заточка до +3');

  await pool().query('UPDATE player_progress SET quest_idx = $2 WHERE player_id = $1', [eq2, qi2]);
  const stOf = async () => (await pool().query(
    'SELECT quest_idx, quest_kills FROM player_progress WHERE player_id = $1', [eq2])).rows[0];

  ok(!questComplete(QUEST_DEF[qi2], (await stOf()).quest_kills, 30),
    'до заточки квест НЕ виконано');

  // Благословенні камені: невдача нічого не змінює, тож цикл дійде до +2.
  const qRow = await give(eq2, 'sw1');
  await give(eq2, 'bless_stone', 40);
  for (let i = 0; i < 40; i++) {
    const res = await tx(t => craft.enhance(t, eq2, qRow, 'bless'));
    if (res.outcome === 'success') {
      await tx(t => progression.questOnEnhance(t, eq2, res.to));
      if (res.to >= 3) break;
    }
  }
  const after = await stOf();
  ok(questComplete(QUEST_DEF[qi2], after.quest_kills, 30),
    'після заточки квест на +2 виконано');
  // Дошли до +3 на квесті з +2 — наступний квест від цього НЕ закривається.
  ok(!questComplete(QUEST_DEF[qi3], after.quest_kills, 30),
    'квест на +3 від цього НЕ закрився — кожен заробляється окремо');

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

  // The merchant moved to repos/consumables.js with the potion bag it fills —
  // it sold nothing but potions, and those are not inventory rows. Its tests
  // moved with it (dev/consumables-check.js), rather than being left here to
  // exercise a function this file no longer owns.

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

  // ── the shape the game actually stores ───────────────────────────────────
  // Everything above granted materials with give(id, qty), which puts qty in
  // ONE row. add() only ever does that for a stackable; two swords are two
  // rows. So the fixture was testing a shape the game cannot produce, and it
  // hid the fact that every gear recipe was unreachable: they all ask for n:2
  // of a non-stackable, and the take looked for one row holding two.
  console.log('  ── реальна форма інвентаря ──');
  const rows = async (pid, itemId) =>
    (await pool().query(
      `SELECT enhance, qty FROM player_items
        WHERE player_id=$1 AND container='inventory' AND item_id=$2
        ORDER BY enhance, id`, [pid, itemId])).rows;
  const giveRows = async (pid, itemId, n, enhance = 0) => {
    for (let i = 0; i < n; i++) await give(pid, itemId, 1, enhance);
  };

  const gearMat = rec.mats.find(m => m.minEnhance > 0);
  const bulkMat = rec.mats.find(m => !m.minEnhance);

  const r3 = await mk('rows');
  await giveRows(r3, gearMat.id, gearMat.n, gearMat.minEnhance);   // separate rows
  await give(r3, bulkMat.id, bulkMat.n);
  await money.credit(null, r3, 'nexum', rec.nexumCost, { reason: 'seed', idemKey: `${TAG}:nx3` });
  eq((await rows(r3, gearMat.id)).length, gearMat.n,
    `${gearMat.n} × ${gearMat.id} лежать окремими рядками, як у грі`);
  eq((await tx(t => craft.craft(t, r3, 'gear', 0))).outcome, 'success',
    'крафт бере матеріал З КІЛЬКОХ РЯДКІВ — саме це було зламано');
  eq((await rows(r3, gearMat.id)).length, 0, 'обидва рядки списано');

  // ── minEnhance means the same thing on both ends ─────────────────────────
  // _haveMats counted copies at or above the requirement; the take applied no
  // filter at all. A player holding two +8 and four +0 passed the check and
  // paid with the +0 — keeping the enhanced pair and crafting at a fraction of
  // the recipe's real price.
  console.log('  ── заточка матеріалу ──');
  const r4 = await mk('minenh');
  await giveRows(r4, gearMat.id, gearMat.n, gearMat.minEnhance);
  await giveRows(r4, gearMat.id, 4, 0);                              // decoys
  await give(r4, bulkMat.id, bulkMat.n);
  await money.credit(null, r4, 'nexum', rec.nexumCost, { reason: 'seed', idemKey: `${TAG}:nx4` });

  eq((await tx(t => craft.craft(t, r4, 'gear', 0))).outcome, 'success', 'крафт пройшов');
  const left4 = await rows(r4, gearMat.id);
  eq(left4.length, 4, 'залишилось рівно 4 рядки');
  ok(left4.every(x => x.enhance === 0),
    'списано ЗАТОЧЕНІ, а не звичайні — оплачено тим, чого вимагає рецепт');

  // Lowest qualifying enhancement goes first: when +8 satisfies the recipe the
  // +12 stays in the bag. The alternative silently eats work already paid for.
  const r5 = await mk('lowest');
  await giveRows(r5, gearMat.id, gearMat.n, gearMat.minEnhance);
  await giveRows(r5, gearMat.id, gearMat.n, Math.min(ENHANCE_MAX, gearMat.minEnhance + 4));
  await give(r5, bulkMat.id, bulkMat.n);
  await money.credit(null, r5, 'nexum', rec.nexumCost, { reason: 'seed', idemKey: `${TAG}:nx5` });
  await tx(t => craft.craft(t, r5, 'gear', 0));
  const left5 = await rows(r5, gearMat.id);
  ok(left5.length === gearMat.n && left5.every(x => x.enhance > gearMat.minEnhance),
    `витрачено +${gearMat.minEnhance}, а +${gearMat.minEnhance + 4} лишився цілим`);

  // All or nothing: one short means nothing is taken, not a partial take.
  const r6 = await mk('partial');
  await giveRows(r6, gearMat.id, gearMat.n - 1, gearMat.minEnhance);
  await give(r6, bulkMat.id, bulkMat.n);
  await money.credit(null, r6, 'nexum', rec.nexumCost, { reason: 'seed', idemKey: `${TAG}:nx6` });
  eq(await caught(() => tx(t => craft.craft(t, r6, 'gear', 0))), 'no_mats', 'одного не вистачає — відмова');
  eq((await rows(r6, gearMat.id)).length, gearMat.n - 1, 'НІЧОГО не списано частково');
  eq(await countOf(r6, bulkMat.id), bulkMat.n, 'другий матеріал теж на місці');

  // ── naming a recipe by its result ────────────────────────────────────────
  // ── ЩО ВИХОДИТЬ ІЗ ЗАТОЧЕНОГО ──────────────────────────────────────────
  // "В крафте тоже: заточенную вещь крафтишь, не заточенную даёт."
  //
  // A tier recipe asks for two copies at +8 and the result carries +6 — two
  // levels below what was consumed. That rule was written twice: js/npc.js
  // computed it to SHOW the player what they would get, and the old server
  // handler computed it again to GRANT it. The PostgreSQL rewrite dropped the
  // server half and put `enhance: rec.enhance || 0` in its place — and no
  // recipe has ever had an `enhance` field, so every craft granted +0 while
  // the crafting window promised +6.
  //
  // Eighty-one assertions in this file and none of them looked at the
  // enhancement of the thing that came out.
  console.log('');
  console.log('  ── заточка результату ──');
  const tierIdx = GEAR_TIER_CRAFT_RECIPES.findIndex(r =>
    (r.mats || []).some(m => m.minEnhance > 0));
  const tier = GEAR_TIER_CRAFT_RECIPES[tierIdx];
  const wantEnh = craftResultEnhance(tier);
  eq(wantEnh, tier.mats.find(m => m.minEnhance != null).minEnhance - 2,
    `правило: на два рівні нижче за з'їдене (+${wantEnh})`);
  ok(wantEnh > 0, 'і воно не нуль — інакше перевірка нижче нічого не доводить');

  const te = await mk('tier');
  for (const m of tier.mats) {
    for (let i = 0; i < (m.n || 1); i++) {
      await tx(t => items.add(t, te, m.id, { enhance: m.minEnhance || 0 }));
    }
  }
  if (tier.nexumCost) {
    await money.credit(null, te, 'nexum', tier.nexumCost, { reason: 'seed', idemKey: `${TAG}:nxt` });
  }
  const tRes = await tx(t => craft.craft(t, te, 'gearTier', tierIdx));
  eq(tRes.outcome, 'success', 'тировий крафт пройшов');
  const { rows: got } = await pool().query(
    `SELECT enhance FROM player_items WHERE player_id = $1 AND item_id = $2`, [te, tier.itemId]);
  ok(got.length === 1, 'предмет виданий');
  eq(got[0] && got[0].enhance, wantEnh,
    `і він виходить +${wantEnh}, а не +0 — саме це й було зламано`);


  console.log('  ── рецепт за предметом ──');
  eq(JSON.stringify(craft.gearRecipeByItemId(rec.itemId)), JSON.stringify({ family: 'gear', index: 0 }),
    'епічний рецеп знайдено в GEAR_CRAFT_RECIPES');
  eq(craft.gearRecipeByItemId(GEAR_TIER_CRAFT_RECIPES[0].itemId).family, 'gearTier',
    'тировий рецепт знайдено в GEAR_TIER_CRAFT_RECIPES');
  eq(await caught(async () => craft.gearRecipeByItemId('НЕМАЄ')), 'bad_recipe',
    'вигаданий предмет — відмова, а не мовчазний перший рецепт');

  // ── advanced skill book ──────────────────────────────────────────────────
  // The version this replaces answered "Неизвестная книга" every time, because
  // it read ADV_SKILL_BOOK_CRAFT as if it had {mats, itemId}. It has {count,
  // chance}: ten regular books of ANY class, one random advanced book at 30%.
  console.log('  ── книга просунутого навику ──');
  const srcIds = CRAFT_MATS.filter(m => m.skillKey).map(m => m.id);
  const advIds = new Set(CRAFT_MATS.filter(m => m.advSkillKey).map(m => m.id));
  const ab = await mk('advbook');

  eq(await caught(() => tx(t => craft.craftAdvSkillBook(t, ab))), 'no_mats', 'без книг — відмова');

  // Mixed ids on purpose: the recipe says "any ten", and the old client-side
  // version could only count one id at a time.
  for (let i = 0; i < ADV_SKILL_BOOK_CRAFT.count; i++) {
    await give(ab, srcIds[i % srcIds.length], 1);
  }
  const abRes = await tx(t => craft.craftAdvSkillBook(t, ab));
  ok(abRes.outcome === 'success' || abRes.outcome === 'fail',
    `рецепт відпрацював (${abRes.outcome}, шанс ${abRes.chance})`);
  eq(await items.countMatching(null, ab, { itemIds: srcIds }), 0,
    'усі 10 книг списано — вони витрачаються незалежно від кидка');
  if (abRes.outcome === 'success') {
    ok(advIds.has(abRes.itemId), `видано книгу 2-ї професії (${abRes.itemId})`);
  } else {
    eq(await items.countMatching(null, ab, { itemIds: [...advIds] }), 0, 'при невдачі книги не видано');
  }

  // ── pet ──────────────────────────────────────────────────────────────────
  console.log('  ── питомець ──');
  const petRec = PET_CRAFT_RECIPES[0];
  const pc = await mk('pet');
  eq(await caught(() => tx(t => craft.craftPet(t, pc, petRec.rarity))), 'no_nexum',
    'без Liberty питомця не створити');
  eq((await invOf(pc)).length, 0, 'нічого не з’явилось');

  await money.credit(null, pc, 'nexum', petRec.nexumCost, { reason: 'seed', idemKey: `${TAG}:pet` });
  const petRes = await tx(t => craft.craftPet(t, pc, petRec.rarity));
  eq(petRes.outcome, 'success', 'питомця створено');
  const petDef = ITEM_DEF.find(d => d.id === petRes.itemId);
  ok(petDef && petDef.slot === 'pet' && petDef.rarity === petRec.rarity,
    `це справді питомець потрібної рідкості (${petRes.itemId})`);
  eq((await money.balancesOf(null, pc)).nexum, 0, 'Liberty списано рівно за рецептом');
  eq(await caught(() => tx(t => craft.craftPet(t, pc, 'вигадана'))), 'bad_recipe',
    'вигадана рідкість — відмова');

  // ── material upgrade ─────────────────────────────────────────────────────
  console.log('  ── апгрейд матеріалів ──');
  const mu = MAT_UPGRADE_RECIPES[0];
  const up = await mk('matup');
  eq(await caught(() => tx(t => craft.upgradeMat(t, up, mu.from))), 'no_mats', 'без матеріалів — відмова');
  await give(up, mu.from, mu.count - 1);
  eq(await caught(() => tx(t => craft.upgradeMat(t, up, mu.from))), 'no_mats',
    `${mu.count - 1} з ${mu.count} — відмова`);
  eq(await countOf(up, mu.from), mu.count - 1, 'нічого не списано');

  await give(up, mu.from, 1);
  const muRes = await tx(t => craft.upgradeMat(t, up, mu.from));
  eq(await countOf(up, mu.from), 0, `${mu.count} списано за будь-якого результату`);
  eq(await countOf(up, mu.to), muRes.outcome === 'success' ? 1 : 0,
    `результат збігається з кидком (${muRes.outcome}, шанс ${mu.chance})`);

  // ── class gear salvage ───────────────────────────────────────────────────
  // "Junk gear" is a catalog property here. The old handler asked the client's
  // copy of the inventory whether an item was stackable and what rarity it was
  // — both attacker-controlled, so a stack of potions could be salvaged as
  // thirty legendaries.
  console.log('  ── плащі та артефакти ──');
  // The UNCOMMON recipe, deliberately: 46 stackables in the catalog carry that
  // rarity and most of them are skill books. If "junk gear" were counted as
  // "things I own of this rarity" — which is what the client's copy amounted to
  // — salvaging a cloak would quietly eat the player's book collection. There
  // is no stackable common at all, so the common recipe cannot prove this and
  // the first version of this test skipped the check without saying so.
  const cg = CLASS_GEAR_SALVAGE_RECIPES.find(r => r.costRarity === 'uncommon');
  const junk = ITEM_DEF.filter(d => !isStackableItem(d) && d.rarity === cg.costRarity);
  const stackJunk = [...CRAFT_MATS, ...ITEM_DEF, ...BOX_DEF]
    .find(d => isStackableItem(d) && d.rarity === cg.costRarity);
  ok(junk.length > 0 && !!stackJunk,
    `у каталозі є і брухт (${junk.length}), і стековані (${stackJunk && stackJunk.id}) рідкості ${cg.costRarity}`);

  const sv = await mk('salvage');
  await money.credit(null, sv, 'nexum', cg.nexumCost * 2, { reason: 'seed', idemKey: `${TAG}:sv` });

  eq(await caught(() => tx(t => craft.craftClassGear(t, sv, cg.resultSlot, cg.resultRarity))),
    'no_mats', 'без брухту — відмова');

  await give(sv, stackJunk.id, cg.costCount + 5);
  eq(await caught(() => tx(t => craft.craftClassGear(t, sv, cg.resultSlot, cg.resultRarity))),
    'no_mats', 'стек тієї ж рідкості НЕ зараховується як брухт');

  for (let i = 0; i < cg.costCount; i++) await give(sv, junk[i % junk.length].id, 1);
  const svRes = await tx(t => craft.craftClassGear(t, sv, cg.resultSlot, cg.resultRarity));
  eq(svRes.outcome, 'success', 'предмет класу створено');
  const svDef = ITEM_DEF.find(d => d.id === svRes.itemId);
  ok(svDef && svDef.classItem && svDef.slot === cg.resultSlot && svDef.rarity === cg.resultRarity,
    `це справді ${cg.resultSlot} рідкості ${cg.resultRarity} (${svRes.itemId})`);
  eq(await items.countMatching(null, sv, { rarity: cg.costRarity, stackable: false }), 1,
    'брухт списано, лишився лише щойно створений предмет');
  eq(await countOf(sv, stackJunk.id), cg.costCount + 5,
    'книги НЕ зачеплені — фільтр по колонці каталогу, а не по кількості речей');
  eq((await money.balancesOf(null, sv)).nexum, cg.nexumCost, 'Liberty списано один раз');

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
  // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
  // item_ledger видачу без рядків, і нічна звірка справедливо кричала
  // про розходження — 216 пар 27 серпня, усі до одної тестові.
  await wipeItemsAll(made);
  for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_progress', 'ledger', 'balances']) {
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
