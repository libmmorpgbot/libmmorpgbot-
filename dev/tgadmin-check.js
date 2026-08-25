#!/usr/bin/env node
'use strict';
// ── The admin panel: every screen drawn, every button pressed ───────────────
//
//   node dev/tgadmin-check.js
//
// A panel that hands out levels and currency is reachable by anyone who can
// send the bot a message, so the tests that matter are the refusals.
//
// Nothing here talks to Telegram. The four API calls the panel makes are
// replaced with recorders, which is also the point: a screen IS its text and
// its buttons, so that is what gets asserted. A button whose callback_data
// names a screen that does not exist would quietly draw the home page and look
// fine to a human clicking through — here it fails.
process.env.TG_ADMIN_IDS = process.env.TG_ADMIN_IDS || '1199957588,8868342638';

const { pool, tx, close } = require('../server/db');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const ops = require('../server/tg-ops');

// Replaced BEFORE tg-admin loads, so it captures these references.
const sent = [], edits = [], asks = [], toasts = [];
ops.dm = async (chatId, html, o = {}) => {
  sent.push({ chatId: String(chatId), html, buttons: o.buttons || [] });
  return { message_id: 1 };
};
ops.editIn = async (chatId, msgId, html, o = {}) => {
  edits.push({ chatId: String(chatId), html, buttons: o.buttons || [] });
  return {};
};
ops.ask = async (chatId, html) => { asks.push({ chatId: String(chatId), html }); return {}; };
ops.answerCallback = async (id, text = '') => { toasts.push(String(text || '')); return {}; };
const admin = require('../server/tg-admin');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'adm-' + String(process.pid).slice(-5);
const ADMIN = '1199957588';
const STRANGER = '55500011122';
const FIND_PROMPT = 'x ⟨find:⟩';
const made = [];

const msg = (text, from = ADMIN, reply = null) =>
  ({ text, from: { id: from }, chat: { id: from }, reply_to_message: reply });
const press = (data, from = ADMIN) => admin.handleCallback({
  id: 'cb', data, from: { id: from }, message: { message_id: 7, chat: { id: from } },
});
const clear = () => { sent.length = 0; edits.length = 0; asks.length = 0; toasts.length = 0; };
const lastScreen = () =>
  (edits.length ? edits[edits.length - 1] : (sent.length ? sent[sent.length - 1] : null));
const allData = (s) => (s ? s.buttons.flat().map(b => b.callback_data).filter(Boolean) : []);

async function main() {
  console.log(`\ntgadmin-check  (${TAG})\n`);
  const { id } = await tx(t => players.ensure(t, `${TAG}-tg`, `${TAG}_victim`));
  made.push(id);
  await pool().query('UPDATE player_progress SET lvl = 5 WHERE player_id = $1', [id]);

  // ── who may open it ──────────────────────────────────────────────────────
  console.log('  ── доступ ──');
  clear();
  await admin.handle(msg('/admin', STRANGER));
  eq(sent.length, 0, 'сторонньому панель не приходить і нічого не відповідається');

  clear();
  await press(`a:give:${id}:gram:1000`, STRANGER);
  eq(Number((await money.balancesOf(null, id)).gram), 0,
    'кнопка, натиснута стороннім, нічого не нараховує');
  ok(toasts.some(t => /доступ/i.test(t)), 'і йому сказано «нет доступа»');

  clear();
  eq(await admin.handle(msg('привіт')), false, 'звичайне повідомлення не перехоплюється');
  eq(await admin.handleCallback({ id: 'x', data: 'wd:approve:1', from: { id: ADMIN } }), false,
    'чужа кнопка (вивід коштів) не перехоплюється');

  // ── the panel opens ──────────────────────────────────────────────────────
  console.log('\n  ── панель ──');
  clear();
  await admin.handle(msg('/admin'));
  eq(sent.length, 1, 'на /admin приходить одне повідомлення');
  eq(sent[0].chatId, ADMIN, 'у приватку тому, хто викликав');
  ok(/Админ-панель/.test(sent[0].html), 'це головний екран');
  ok(allData(sent[0]).includes('a:list:0'), 'на ньому є кнопка списку гравців');

  // ── every button leads somewhere real ────────────────────────────────────
  // Walked breadth-first from the home screen. A callback_data naming a screen
  // that does not exist draws home instead and looks fine to a human clicking
  // through; here the walk notices.
  console.log('\n  ── усі кнопки ведуть на справжній екран ──');
  const seen = new Set(['a:home']);
  const queue = ['a:home'];
  let screens = 0, dead = 0;
  while (queue.length) {
    const data = queue.shift();
    // The actions are exercised on their own below — walking them here would
    // grant currency dozens of times.
    if (/^a:(give|lvlset|vipset|ask|find)/.test(data)) continue;
    clear();
    const took = await press(data);
    if (!took) { dead++; console.log(`    не оброблено: ${data}`); continue; }
    screens++;
    const sc = lastScreen();
    if (!sc || !sc.html) { dead++; console.log(`    порожній екран: ${data}`); continue; }
    for (const d of allData(sc)) if (!seen.has(d)) { seen.add(d); queue.push(d); }
  }
  eq(dead, 0, `жодної кнопки в нікуди (пройдено ${screens} екранів, ${seen.size} кнопок)`);

  // ── the player card ──────────────────────────────────────────────────────
  console.log('\n  ── картка гравця ──');
  clear();
  await press(`a:p:${id}`);
  const card = lastScreen();
  ok(card && new RegExp(`${TAG}_victim`).test(card.html), 'картка називає гравця');
  ok(card && /Уровень/.test(card.html) && /GRAM/.test(card.html),
    'і показує рівень та баланси');
  ok(allData(card).includes(`a:lvl:${id}`), 'веде на екран рівня');
  ok(allData(card).some(d => d.startsWith('a:list')), 'і має кнопку назад');

  clear();
  await press(`a:lvl:${id}`);
  ok(allData(lastScreen()).includes(`a:p:${id}`), 'з екрана рівня ⬅️ повертає на картку');

  // ── the actions ──────────────────────────────────────────────────────────
  console.log('\n  ── дії ──');
  clear();
  await press(`a:lvlset:${id}:30`);
  eq((await players.progressOf(null, id)).lvl, 30, 'кнопка «30» ставить рівень 30');
  ok(toasts.some(t => /30/.test(t)), 'і про це сказано спливашкою');
  ok(lastScreen() && new RegExp(`${TAG}_victim`).test(lastScreen().html),
    'після дії перемальовується картка гравця');

  for (const [cur, amt] of [['gold', 1000], ['gram', 10], ['nexum', 100]]) {
    clear();
    await press(`a:give:${id}:${cur}:${amt}`);
    eq(Number((await money.balancesOf(null, id))[cur]), amt, `${cur}: нараховано ${amt}`);
    const { rows } = await pool().query(
      `SELECT count(*)::int n FROM ledger
        WHERE player_id = $1 AND currency = $2 AND reason = 'admin_grant'`, [id, cur]);
    eq(rows[0].n, 1, `${cur}: рядок у леджері — гроші не створені повз money.js`);
  }

  clear();
  await press(`a:give:${id}:gram:-5`);
  eq(Number((await money.balancesOf(null, id)).gram), 5, 'мінус списує');

  clear();
  await press(`a:give:${id}:gram:-99999`);
  eq(Number((await money.balancesOf(null, id)).gram), 5, 'списати більше, ніж є, не можна');
  ok(toasts.some(t => /Недостаточно/.test(t)), 'і сказано чому');

  clear();
  await press(`a:vipset:${id}:5`);
  const { rows: vip } = await pool().query(
    'SELECT level FROM player_vip WHERE player_id = $1', [id]);
  eq(vip[0].level, 5, 'VIP виставлено кнопкою');

  const { rows: drift } = await pool().query(`
    SELECT count(*)::int n FROM (
      SELECT b.amount, COALESCE((SELECT sum(l.delta) FROM ledger l
        WHERE l.player_id = b.player_id AND l.currency = b.currency), 0) AS led
        FROM balances b WHERE b.player_id = $1) x WHERE x.amount <> x.led`, [id]);
  eq(drift[0].n, 0, 'баланс і леджер сходяться після всіх дій');

  // ── typing a value ───────────────────────────────────────────────────────
  // No state is held between the prompt and the reply: what the prompt was FOR
  // is written into the prompt itself, so one answered an hour later still
  // works and a restart in between changes nothing.
  console.log('\n  ── введення числа ──');
  clear();
  await press(`a:ask:${id}:lvl`);
  eq(asks.length, 1, 'кнопка «Ввести» шле запит на відповідь');
  const prompt = asks[0].html;
  ok(admin.MARK.test(prompt),
    `у запиті є мітка, за якою його впізнають (${(admin.MARK.exec(prompt) || [])[0]})`);

  clear();
  await admin.handle(msg('77', ADMIN, { text: prompt }));
  eq((await players.progressOf(null, id)).lvl, 77, 'відповідь застосована до потрібного гравця');

  clear();
  await admin.handle(msg('не число', ADMIN, { text: prompt }));
  eq((await players.progressOf(null, id)).lvl, 77, 'не число — нічого не змінює');
  ok(sent.some(s => /не число/i.test(s.html)), 'і про це сказано');

  clear();
  await press('a:find');
  eq(asks.length, 1, 'пошук теж просить ввести');

  clear();
  await admin.handle(msg(`${TAG}_victim`, ADMIN, { text: FIND_PROMPT }));
  ok(sent.some(s => new RegExp(`${TAG}_victim`).test(s.html)),
    'пошук знаходить гравця за імʼям');

  clear();
  await admin.handle(msg('немаєТакого', ADMIN, { text: FIND_PROMPT }));
  ok(sent.some(s => /Не найден/.test(s.html)), 'і чесно каже, коли не знайшов');

  // ── every action is on the record ────────────────────────────────────────
  console.log('\n  ── журнал ──');
  const { rows: acts } = await pool().query(
    `SELECT action, admin_tg_id FROM admin_actions WHERE ref_type = 'player' AND ref_id = $1`,
    [String(id)]);
  ok(acts.length >= 6, `дії записані (${acts.length})`);
  ok(acts.every(a => a.admin_tg_id === ADMIN), 'у кожному записі — хто це зробив');
  ok(['set_level', 'grant', 'take', 'set_vip'].every(a => acts.some(x => x.action === a)),
    'записані рівень, нарахування, списання і VIP');

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    if (made.length) {
      await pool().query('DELETE FROM ledger WHERE player_id = ANY($1)', [made]).catch(() => {});
      await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
    }
    await close();
    process.exit(fail ? 1 : 0);
  });
