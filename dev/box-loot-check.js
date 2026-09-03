#!/usr/bin/env node
'use strict';
// ── Из ящиков не падает то, чего они не обещают ─────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/box-loot-check.js
//
// Владелец: «сделай чтоб с необычных и редких ящиков не падали артефакты,
// плащи, питомцы, крылья».
//
// Оказалось, панель это УЖЕ обещала. openBoxModal (js/ui.js) перечисляла семь
// слотов снаряжения, а openBox (server/db/repos/craft.js) брал «всё, у чего
// есть слот, кроме use и box». На редком ящике панель показывала 10 предметов,
// а выдать могло 24: пять артефактов, пять плащей, три питомца, крылья — и
// уникальное оружие с noDrop, флаг которого ровно об этом. На необычном сверх
// того шесть баф-зелий.
//
// Ошибка была беззвучной с обеих сторон: сервер выдавал ЗАКОННЫЙ предмет,
// игрок получал подарок, и жаловаться было не на что — просто ящик работал не
// так, как написано на нём же.
//
// Поэтому проверка не читает код, а ОТКРЫВАЕТ ящики и смотрит, что выпало.
// Список слотов один на обе стороны (boxLootPool), но общая функция — это ещё
// не гарантия: завтра кто-то добавит рядом второй бросок «а ещё с шансом 5%
// питомец», и он тоже будет законным кодом.
const { tx, close } = require('../server/db');
const players = require('../server/db/repos/players');
const items = require('../server/db/repos/items');
const craft = require('../server/db/repos/craft');
const { ITEM_DEF, BOX_DEF, BOX_LOOT_SLOTS, boxLootPool } = require('../shared/definitions');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

const TAG = 'box-' + String(process.pid).slice(-5);
const made = [];
// Столько открытий на ящик. Достаточно, чтобы редкая ветка (10% у редкого
// ящика) выпала десятки раз: проверка на десяти открытиях зелёная и тогда,
// когда лишнее просто не успело выпасть.
const OPENS = 400;
// Чего в ящике быть не должно — то, что просил убрать владелец.
const BANNED = ['artifact', 'cloak', 'pet', 'wings'];

(async () => {
  console.log(`\nbox-loot-check  (${TAG})\n`);

  await tx(t => items.syncCatalog(t));

  // ── 1. сам список ─────────────────────────────────────────────────────────
  for (const slot of BANNED) {
    ok(!BOX_LOOT_SLOTS.includes(slot), `${slot} не в списке слотов ящика`);
  }
  const uniques = ITEM_DEF.filter(d => d.noDrop);
  ok(uniques.length > 0, `в каталоге есть предметы с noDrop (${uniques.length})`,
    'ни одного — тогда следующая проверка ничего не значит');
  ok(boxLootPool('rare').every(d => !d.noDrop), 'и ни один из них не в пуле ящика');

  // ── 2. и что на самом деле выпадает ───────────────────────────────────────
  const { id } = await tx(t => players.ensure(t, `${TAG}-a`, `${TAG}_игрок`));
  made.push(id);

  for (const box of BOX_DEF) {
    const seen = new Map();
    const bad = new Set();
    for (let i = 0; i < OPENS; i++) {
      // Ящик и ключ — на каждое открытие: openBox их тратит.
      await tx(async (t) => {
        await items.lockPlayer(t, id);
        await items.add(t, id, box.id, { source: 'test' });
        if (box.keyId) await items.add(t, id, box.keyId, { source: 'test' });
      });
      const res = await tx(t => craft.openBox(t, id, box.id));
      const def = ITEM_DEF.find(d => d.id === res.itemId);
      const slot = def ? def.slot : '?';
      seen.set(slot, (seen.get(slot) || 0) + 1);
      if (BANNED.includes(slot) || !def || def.noDrop) bad.add(`${slot}:${res.itemId}`);
      // Выпавшее сразу убираем — иначе инвентарь кончится на сороковом
      // открытии и проверка упрётся в «Инвентарь полон» вместо своего вопроса.
      await tx(t => items.removeRow(t, res.rowId, id, { reason: 'test_cleanup' }));
    }
    const slots = [...seen.entries()].sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}×${n}`).join(', ');
    console.log(`  ── ${box.name}: ${OPENS} открытий ──`);
    console.log(`      выпало по слотам: ${slots}`);
    ok(bad.size === 0,
      `${box.name}: ни артефактов, ни плащей, ни питомцев, ни крыльев`,
      [...bad].join(', '));
    ok([...seen.keys()].every(s => BOX_LOOT_SLOTS.includes(s)),
      `${box.name}: всё выпавшее — из объявленного списка слотов`,
      [...seen.keys()].filter(s => !BOX_LOOT_SLOTS.includes(s)).join(', '));
  }

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await close(); } catch { /* уже закрыт */ }
  process.exit(1);
});
