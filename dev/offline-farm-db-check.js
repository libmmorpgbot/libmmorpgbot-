#!/usr/bin/env node
'use strict';
// ── Оффлайн-фарм на настоящей базе ──────────────────────────────────────────
//
//   DATABASE_URL=... node dev/offline-farm-db-check.js
//
// Запуск, выдача и всё, что между ними может пойти не так: двойной запуск,
// двойная выдача, фарм короче минуты, фарм длиннее потолка, закрытая по
// уровню локация. Выдача сверяется с тем, что ЛЕГЛО: балансы, журнал денег и
// журнал предметов, а не с тем, что вернула функция.

const { tx, query, close } = require('../server/db');
const items = require('../server/db/repos/items');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const of = require('../server/offline-farm');
const D = require('../shared/definitions');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

const TAG = 'ofarm-' + String(process.pid).slice(-5);
const made = [];
const HOUR = 3600 * 1000;

async function mkPlayer(suffix, lvl, vip = D.OFFLINE_FARM_VIP_MIN) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${suffix}`, `${TAG}_${suffix}`));
  made.push(id);
  await tx(t => players.setClass(t, id, 'lev'));
  await query(null, 'UPDATE player_progress SET lvl = $2 WHERE player_id = $1', [id, lvl]);
  await query(null, `INSERT INTO player_vip (player_id, level) VALUES ($1, $2)
    ON CONFLICT (player_id) DO UPDATE SET level = EXCLUDED.level`, [id, vip]);
  return id;
}
const farmOf = async (pid) => {
  const { rows } = await query(null, 'SELECT offline_farm FROM player_progress WHERE player_id = $1', [pid]);
  return rows[0].offline_farm;
};
// «Прошло N часов» — сдвигом момента запуска назад, а не ожиданием.
const rewind = (pid, ms) => query(null, `
  UPDATE player_progress SET offline_farm = jsonb_set(offline_farm, '{at}', to_jsonb($2::bigint))
   WHERE player_id = $1`, [pid, Date.now() - ms]);
const start = async (pid, loc) => {
  try { return { ok: true, res: await tx(t => of.start(t, pid, loc)) }; }
  catch (e) { return { ok: false, code: e.code, msg: e.message }; }
};
const claim = (pid, s = {}) => tx(t => of.claim(t, pid, s));

(async () => {
  console.log(`\noffline-farm-db-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));
  ok(await of.available(), 'колонка offline_farm есть (миграция 033)');

  console.log('  ── запуск ──');
  const pid = await mkPlayer('a', 25);
  const info = await of.info(null, pid);
  // Голый персонаж 25 уровня фарм-зону не тянет — модель это и должна
  // говорить. Поэтому берётся та локация, которую он тянет: самая выгодная.
  const fz = info.locations.filter(l => l.open && l.ok).sort((a, b) => b.xpPerHour - a.xpPerHour)[0];
  ok(fz && fz.killsPerHour > 0, `есть локация по силам (${fz && fz.id})`);
  ok(info.locations.find(l => l.id === 'farmHigh').open === false, 'Фарм зона 2 закрыта до 40 уровня');
  ok(info.active === null, 'фарма ещё нет');
  const tooHard = info.locations.find(l => l.open && l.ok === false);
  if (tooHard) {
    const sx = await start(pid, tooHard.id);
    ok(!sx.ok && sx.code === 'too_strong', `непосильная локация (${tooHard.id}) отклонена`, sx.code);
  }

  const s1 = await start(pid, fz.id);
  ok(s1.ok && s1.res.loc === fz.id, 'запуск принят', s1.msg);
  const f = await farmOf(pid);
  ok(f && f.loc === fz.id && f.st && f.st.atk > 0, 'в базе локация и снимок характеристик');
  const s2 = await start(pid, 'c:left:1');
  ok(!s2.ok && s2.code === 'already', 'второй запуск поверх первого отклонён', s2.code);
  ok((await of.info(null, pid)).active.loc === fz.id, 'окно видит запущенный фарм');

  console.log('  ── выдача ──');
  await rewind(pid, 3 * HOUR);
  const before = await money.balancesOf(null, pid);
  const res = await claim(pid, { vipLevel: 0 });
  ok(res && res.kills > 0 && res.xp > 0, 'убийства и опыт посчитаны', JSON.stringify(res && { k: res.kills, xp: res.xp }));
  ok(Math.abs(res.seconds - 3 * 3600) <= 2, 'засчитано три часа', res.seconds);
  const exp = fz.killsPerHour * 3;
  ok(Math.abs(res.kills - exp) <= Math.max(2, exp * 0.02), 'убийств — темп × время', `${res.kills} против ${exp}`);
  const after = await money.balancesOf(null, pid);
  ok(Number(after.gold) - Number(before.gold) === res.gold, 'золото легло на баланс ровно на сумму сводки',
    `${after.gold} - ${before.gold} vs ${res.gold}`);
  ok(Number(after.nexum) - Number(before.nexum) === res.nexum, 'Liberty — тоже');
  const { rows: led } = await query(null,
    `SELECT currency, sum(delta)::numeric s FROM ledger WHERE player_id = $1 AND reason = 'offline_farm' GROUP BY 1`, [pid]);
  const ledGold = Number((led.find(r => r.currency === 'gold') || {}).s || 0);
  ok(ledGold === res.gold, 'в журнале денег — отдельной строкой offline_farm', ledGold);
  const { rows: il } = await query(null,
    `SELECT coalesce(sum(delta), 0)::int n FROM item_ledger WHERE player_id = $1 AND reason = 'offline_farm'`, [pid]);
  const got = res.items.reduce((n, d) => n + (d.qty || 1), 0);
  ok(il[0].n === got, `каждый выданный предмет — в журнале предметов (${got})`, il[0].n);
  const { rows: pr } = await query(null, 'SELECT lvl, xp FROM player_progress WHERE player_id = $1', [pid]);
  ok(pr[0].lvl > 25 || Number(pr[0].xp) > 0, 'опыт дошёл до персонажа');
  ok(await farmOf(pid) === null, 'запись о фарме снята');
  ok(await claim(pid) === null, 'второй вход ничего не получает');

  console.log('  ── края ──');
  const s3 = await start(pid, fz.id);
  ok(s3.ok, 'после выдачи можно запустить снова');
  const short = await claim(pid);
  ok(short && short.tooShort && short.kills === 0, 'меньше минуты — без награды');
  ok(await farmOf(pid) === null, 'и запись всё равно снята');

  await start(pid, fz.id);
  await rewind(pid, 20 * HOUR);
  const capped = await claim(pid);
  ok(capped.capped && capped.seconds === D.OFFLINE_FARM_MAX_HOURS * 3600,
    `двадцать часов засчитаны как ${D.OFFLINE_FARM_MAX_HOURS}`, capped.seconds);

  const novip = await mkPlayer('c', 25, D.OFFLINE_FARM_VIP_MIN - 1);
  const s6 = await start(novip, 'farmZone');
  ok(!s6.ok && s6.code === 'vip_required', `без VIP ${D.OFFLINE_FARM_VIP_MIN} запуск отклонён`, s6.code);
  ok(await farmOf(novip) === null, 'и ничего не записано');
  const niv = await of.info(null, novip);
  ok(niv.vipMin === D.OFFLINE_FARM_VIP_MIN && niv.vipLevel === D.OFFLINE_FARM_VIP_MIN - 1, 'окно знает порог и уровень VIP');

  const low = await mkPlayer('b', 5);
  const s4 = await start(low, 'farmZone');
  ok(!s4.ok && s4.code === 'low_level', 'закрытая по уровню локация отклонена', s4.code);
  const s5 = await start(low, 'constructor');
  ok(!s5.ok && s5.code === 'bad_loc', 'чужой ключ отклонён', s5.code);
  ok(await farmOf(low) === null, 'и ничего не записано');

  // Откат транзакции возвращает запись на место: сбой на выдаче не должен
  // съедать фарм.
  await start(low, 'c:left:1');
  await rewind(low, HOUR);
  try { await tx(async t => { await of.claim(t, low, {}); throw new Error('boom'); }); } catch (_) { /* ожидаемо */ }
  ok((await farmOf(low)) !== null, 'сбой на выдаче — фарм остаётся, заберётся следующим входом');

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await wipeItemsAll(made);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await wipeItemsAll(made); await close(); } catch { /* уже закрыто */ }
  process.exit(1);
});
