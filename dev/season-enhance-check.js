#!/usr/bin/env node
'use strict';
// ── Очки сезона за заточку доходят до игрока ────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/season-enhance-check.js
//
// «Сезон не работает, за заточку ниче не дают» — и это было правдой ровно так,
// как сказано: таблица SEASON_ENHANCE_* существовала, экспортировалась и
// ПОКАЗЫВАЛАСЬ игроку в панели сезона, а seasonEnhancePoints() не вызывался ни
// из одного места. Панель обещала «Редкий: +20 очков», заточка проходила, очки
// не начислялись никогда.
//
// Здесь это проверяется НЕ чтением исходника: поднимается настоящий сервер,
// настоящий сокет затачивает настоящий предмет, и очки читаются из базы. Иначе
// проверка подтверждала бы, что вызов написан, — а жалоба была не о том, что он
// не написан, а о том, что игрок ничего не получает.
const path = require('path');
const crypto = require('crypto');
const io = require('socket.io-client');

const PORT = Number(process.env.SEASON_CHECK_PORT || 3177);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';
delete process.env.MOVE_GUARD;

const { pool, close, tx } = require('../server/db');
const items = require('../server/db/repos/items');
const app = require('../server/app');
const { ITEM_DEF, seasonEnhancePoints, seasonActive } = require('../shared/definitions');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'se' + String(process.pid).slice(-5);
const TG = 986000000 + (process.pid % 100000);

function initDataFor(id, username) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA',
    user: JSON.stringify({ id, first_name: username, username }),
  });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const once = (sock, ev, ms = 10000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const pointsOf = async pid => {
  const { rows } = await pool().query('SELECT points FROM player_season WHERE player_id = $1', [pid]);
  return rows.length ? Number(rows[0].points) : 0;
};

(async () => {
  await app.boot();
  const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  sock.emit('loginTelegramWebApp', { initData: initDataFor(TG, TAG) });
  await once(sock, 'authOk');
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(TG)]);
  const pid = Number(rows[0].id);
  sock.emit('selectChar', { type: 'warlock' });
  await once(sock, 'gameStart', 12000).catch(() => null);
  await wait(500);

  // Сезон должен идти — иначе очки не начисляются никому и проверка ничего не
  // проверит. Это не отказ, а условие: сказать об этом честнее, чем показать
  // зелёную строку.
  ok(seasonActive() === true, 'сезон идёт — без него начислять нечего');
  if (!seasonActive()) { console.log('\n  0 пройшло, 1 впало\n'); await close(); process.exit(1); }

  // Редкий пояс: по таблице — 20 очков за обычный камень, 0 за безопасный.
  const GEAR = ITEM_DEF.find(d => d.id === 'nd3');
  eq(GEAR.rarity, 'rare', 'подопытный предмет редкий');
  eq(seasonEnhancePoints(GEAR.slot, GEAR.rarity, 'norm'), 20, 'таблица обещает за него 20');

  const rowId = await tx(async (t) => {
    await items.lockPlayer(t, pid);
    await items.add(t, pid, 'norm_stone', { qty: 60, source: 'test' });
    return items.add(t, pid, GEAR.id, { qty: 1, source: 'test' });
  });
  await wait(300);

  // ── затачиваем, пока не выйдет ───────────────────────────────────────────
  // Бросок вероятностный (80% на +0), поэтому цикл. Считаются УДАЧИ: очки
  // положены только за них.
  let wins = 0;
  const before = await pointsOf(pid);
  let sawEvent = 0;
  sock.on('seasonEventDone', (d) => { if (d && d.task === 'enhance') sawEvent += d.points || 0; });

  for (let i = 0; i < 12 && wins < 3; i++) {
    const done = once(sock, 'enhanceResult', 8000).catch(() => null);
    sock.emit('enhanceItem', { rowId, stoneType: 'norm' });
    const r = await done;
    if (r && r.outcome === 'success') wins++;
    if (r && r.outcome === 'burn') break;      // вещь сгорела — точить нечего
    await wait(250);
  }
  await wait(700);
  const after = await pointsOf(pid);

  ok(wins > 0, `хотя бы одна заточка удалась (${wins})`);
  // ГЛАВНОЕ. До исправления здесь было ровно 0 при любом числе удач.
  eq(after - before, wins * 20, `очки выросли на 20 за каждую удачу (${before} -> ${after}, удач ${wins})`);
  eq(sawEvent, wins * 20, 'и клиенту сказали ту же сумму');

  // Безопасный камень по таблице очков не даёт — иначе «безопасная» заточка
  // была бы способом фармить сезон без риска.
  await tx(async (t) => {
    await items.lockPlayer(t, pid);
    await items.add(t, pid, 'bless_stone', { qty: 10, source: 'test' });
  });
  await wait(300);
  const beforeB = await pointsOf(pid);
  for (let i = 0; i < 4; i++) {
    const done = once(sock, 'enhanceResult', 8000).catch(() => null);
    sock.emit('enhanceItem', { rowId, stoneType: 'bless' });
    await done;
    await wait(250);
  }
  await wait(700);
  eq(await pointsOf(pid) - beforeB, 0, 'за безопасный камень на предмете очков нет');

  sock.disconnect();
  await pool().query('DELETE FROM player_items WHERE player_id = $1', [pid]).catch(() => {});
  await pool().query('DELETE FROM player_season WHERE player_id = $1', [pid]).catch(() => {});
  await pool().query('DELETE FROM player_progress WHERE player_id = $1', [pid]).catch(() => {});
  await pool().query('DELETE FROM players WHERE id = $1', [pid]).catch(() => {});

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await app.shutdown('test', { exit: false }).catch(() => {});
  await close().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('  ОШИБКА: ' + e.message + '\n' + (e.stack || ''));
  await close().catch(() => {});
  process.exit(1);
});
