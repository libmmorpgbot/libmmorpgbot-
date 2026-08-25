#!/usr/bin/env node
'use strict';
// ── Loot on the ground, from the pile to the inventory ──────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/drops-check.js
//
// "Вбили боса, але все що з нього випало ми нічого не могли підібрати, бо
//  писало «инвентарь полон» — це бред повний. І далі вийшли в лоббі, і там
//  весь лут з боса валявся, хоча він тільки на локації мав бути."
//
// Two bugs, both in code that reads a field off the wrong object.
//
// A DROP IS NOT AN ITEM. A drop is a pile on the floor — `{ id: 'wd_7', x, y,
// item, expiresAt }`. The thing that goes into an inventory is `drop.item` —
// `{ id: 'key_uncommon', qty, enhance }`. The pickup handler passed `drop.id`
// where the item id belongs, so the catalog was asked about an item called
// "wd_7", found nothing, and hasRoomFor answered false — which pickupDrop
// reports as "Инвентарь полон". Sixty piles, every one of them refused, with
// two things in the bag.
//
// GROUND LOOT BELONGS TO A FLOOR. The gameStart payload carried
// eventBossState().drops, which is always the ARENA's floor — correct for the
// admin panel's "на полу лежит N предметов" and wrong for everyone else. The
// client rebuilds its whole ground-loot map from that field on every floor
// change, so walking into the hub redrew the boss's piles there, at the
// arena's coordinates, unpickable because the hub has never heard of them.
//
// This runs the server IN-PROCESS on purpose. The usual reason not to
// (shared/netcodec.js keeps decoder state, so one process holding both ends
// reads its own fiction) applies to `gameState` only — nothing here decodes
// one. What it needs instead is the actual Room object, to put loot on a floor
// without killing a world boss first.

const crypto = require('crypto');
const io = require('socket.io-client');

const PORT = Number(process.env.DROPS_PORT || 3151);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close } = require('../server/db');
const items = require('../server/db/repos/items');
const world = require('../server/world');
const { FLOOR_IDS } = require('../server/game/floors');
const app = require('../server/app');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'dr-' + String(process.pid).slice(-5);
const TG = 940000000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const made = [];

function initData(id, username) {
  const user = JSON.stringify({ id, first_name: username, username });
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user });
  const c = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const s = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', s).update(c).digest('hex'));
  return p.toString();
}
const once = (s, ev, ms = 8000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  s.once(ev, d => { clearTimeout(to); res(d); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`\ndrops-check  (${TAG})  →  ${BASE}\n`);
  await app.boot();
  console.log('');

  const sock = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  const seen = { drops: new Map(), errors: [], picked: [] };
  sock.on('worldDropsSpawned', ({ drops }) => (drops || []).forEach(d => seen.drops.set(d.id, d)));
  sock.on('worldDropTaken', ({ id }) => seen.drops.delete(id));
  sock.on('worldDropError', d => seen.errors.push((d && d.msg) || '?'));
  sock.on('worldDropPicked', d => seen.picked.push(d));
  sock.on('gameStart', g => {
    // The client REPLACES its ground-loot map from this on every floor change.
    seen.startDrops = ((g.eventBoss && g.eventBoss.drops) || []).slice();
  });

  sock.emit('loginTelegramWebApp', { initData: initData(TG, `${TAG}_p`) });
  await once(sock, 'authOk', 12000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(TG)]);
  const pid = Number(rows[0].id);
  made.push(pid);
  await pool().query('UPDATE player_progress SET lvl = 40 WHERE player_id = $1', [pid]);
  sock.emit('selectChar', { type: 'warlock' });
  await once(sock, 'gameStart', 12000);
  await wait(300);

  const room = world.roomOf(FLOOR_IDS.hub);
  const me = room.players.get(sock.id);
  ok(!!me, 'гравець стоїть у кімнаті');

  // ── one pile, picked up ──────────────────────────────────────────────────
  // The exact shape the boss produces: a catalog entry with qty/enhance on it.
  console.log('  ── підбір ──');
  const before = (await items.inventoryOf(null, pid)).inventory.filter(i => i.id === 'norm_stone').length;
  const spawned = room.spawnWorldDrops([{ id: 'norm_stone', qty: 3 }], me.x, me.y);
  eq(spawned.length, 1, 'купа лежить на підлозі');
  await wait(200);
  ok(seen.drops.has(spawned[0].id), 'і клієнту про неї сказано');

  seen.errors.length = 0;
  sock.emit('pickupWorldDrop', { id: spawned[0].id });
  await wait(600);
  eq(seen.errors.length, 0,
    `підбір без помилки${seen.errors.length ? ` — ${seen.errors.join('; ')}` : ''}`);

  const inv = (await items.inventoryOf(null, pid)).inventory;
  const got = inv.filter(i => i.id === 'norm_stone');
  ok(got.length > before || (got[0] && got[0].qty >= 3),
    `предмет у інвентарі (${got.length ? `${got[0].id} ×${got[0].qty}` : 'немає'})`);
  ok(seen.picked.some(p => p.item && p.item.id === 'norm_stone'),
    'і клієнту сказано, ЩО саме він підняв');
  ok(!seen.drops.has(spawned[0].id), 'купа зникла з підлоги');

  // ── the exact wrong answer this file exists for ──────────────────────────
  // "Инвентарь полон" with two items in the bag was the catalog refusing an
  // item id that does not exist — the drop's own id. Asserted by name so the
  // regression is unmistakable if it ever comes back.
  ok(!seen.errors.some(e => /полон/i.test(e)),
    'жодного «инвентарь полон» на порожній інвентар');

  // ── quantity and enhancement survive ─────────────────────────────────────
  console.log('\n  ── кількість і заточка ──');
  const d2 = room.spawnWorldDrops([{ id: 'sw1', qty: 1, enhance: 4 }], me.x, me.y);
  seen.errors.length = 0;
  sock.emit('pickupWorldDrop', { id: d2[0].id });
  await wait(600);
  const sw = (await items.inventoryOf(null, pid)).inventory.find(i => i.id === 'sw1');
  ok(!!sw, 'зброя піднята');
  eq(sw && sw.enhance, 4,
    'із заточкою — читалась із купи, де її ніколи не було, тож завжди виходив +0');

  // ── out of reach ─────────────────────────────────────────────────────────
  console.log('\n  ── задалеко ──');
  const far = room.spawnWorldDrops([{ id: 'norm_stone', qty: 1 }], me.x + 900, me.y + 900);
  const invBefore = (await items.inventoryOf(null, pid)).inventory.length;
  sock.emit('pickupWorldDrop', { id: far[0].id });
  await wait(500);
  eq((await items.inventoryOf(null, pid)).inventory.length, invBefore,
    'купу за 900px підняти не можна');
  ok(room.worldDropSnapshot().some(d => d.id === far[0].id),
    'і вона лишилась лежати, а не зникла');

  // ── a refused pickup puts it BACK ────────────────────────────────────────
  // Claiming removes the pile from the floor before the database write. If the
  // write fails and nothing returns it, the item is destroyed.
  console.log('\n  ── відмова повертає купу ──');
  const { SERVER_INV_MAX } = require('../server/anticheat');
  const used = (await items.inventoryOf(null, pid)).inventory.length;
  // Fill to the cap with an unstackable so the next non-stacking item cannot
  // fit. Written straight to the table: this is setup, not the thing tested.
  for (let i = used; i < SERVER_INV_MAX; i++) {
    await pool().query(`
      INSERT INTO player_items (player_id, item_id, container, qty, enhance)
      VALUES ($1, 'sw1', 'inventory', 1, 0)`, [pid]);
  }
  const full = room.spawnWorldDrops([{ id: 'bo1', qty: 1 }], me.x, me.y);
  seen.errors.length = 0;
  sock.emit('pickupWorldDrop', { id: full[0].id });
  await wait(700);
  ok(seen.errors.some(e => /полон/i.test(e)),
    `на СПРАВДІ повний інвентар сказано «полон» (${seen.errors.join('; ') || 'нічого'})`);
  ok(room.worldDropSnapshot().some(d => d.id === full[0].id),
    'і купа повернулась на підлогу — відмова не знищує предмет');

  // ── ground loot does not follow you between floors ───────────────────────
  console.log('\n  ── лут не ходить за гравцем ──');
  // Loot on the ARENA, where the world boss stands. The player is in the hub.
  const arena = world.roomOf(FLOOR_IDS.arena);
  const arenaDrops = arena.spawnWorldDrops(
    [{ id: 'norm_stone', qty: 1 }, { id: 'bless_stone', qty: 1 }], 400, 400);
  eq(arenaDrops.length, 2, 'на арені лежать дві купи');

  seen.startDrops = null;
  sock.emit('enterLocation', { target: 'hub' });
  await once(sock, 'gameStart', 8000).catch(() => null);
  await wait(300);
  ok(Array.isArray(seen.startDrops), 'gameStart принiс список лута на підлозі');
  const leaked = (seen.startDrops || []).filter(d => arenaDrops.some(a => a.id === d.id));
  eq(leaked.length, 0,
    `у лоббі не видно жодної купи з арени${leaked.length ? ` (${leaked.length} протекло)` : ''}`);

  // And the same list, asked from the arena, DOES have them — otherwise the
  // assertion above would pass just as well on a payload that lost them.
  const arenaSnap = arena.worldDropSnapshot();
  eq(arenaSnap.filter(d => arenaDrops.some(a => a.id === d.id)).length, 2,
    'а на арені вони на місці — перевірка вище не просто «список порожній»');

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
  sock.disconnect();
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    const q = (s, p) => pool().query(s, p).catch(() => {});
    if (made.length) {
      for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs',
                       'player_daily', 'player_season', 'player_progress', 'player_logs',
                       'ledger', 'balances']) {
        await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
      }
      await q('DELETE FROM players WHERE id = ANY($1)', [made]);
    }
    try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
    await close().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
