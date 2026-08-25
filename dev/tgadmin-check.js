#!/usr/bin/env node
'use strict';
// ── /admin grants what it says, to whom it says, and only for admins ────────
//
//   node dev/tgadmin-check.js
//
// A chat command that hands out levels and currency is the single most
// dangerous surface in the game: it is reachable by anyone who can send the
// bot a message. So the tests that matter are the refusals, not the grants.
//
// Nothing here talks to Telegram. ops.dm is replaced with a recorder, which is
// also the point — the command's whole output is what it sends back, and that
// is the thing worth asserting on.
process.env.TG_ADMIN_IDS = process.env.TG_ADMIN_IDS || '1199957588,8868342638';

const { pool, tx, close } = require('../server/db');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const ops = require('../server/tg-ops');

// Replaced BEFORE tg-admin is loaded, so it captures the reference.
const sent = [];
ops.dm = async (tgId, html) => { sent.push({ tgId: String(tgId), html }); return {}; };
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
const made = [];

const msg = (text, from = ADMIN) => ({ text, from: { id: from }, chat: { id: -100 } });
const last = () => (sent.length ? sent[sent.length - 1] : null);
const run = async (text, from) => { sent.length = 0; const r = await admin.handle(msg(text, from)); return r; };

async function main() {
  console.log(`\ntgadmin-check  (${TAG})\n`);

  const { id } = await tx(t => players.ensure(t, `${TAG}-tg`, `${TAG}_victim`));
  made.push(id);
  const name = `${TAG}_victim`;

  // ── who may use it ───────────────────────────────────────────────────────
  console.log('  ── доступ ──');
  await run(`/admin gram ${name} 1000`, STRANGER);
  eq(sent.length, 0, 'сторонньому НЕ відповідають — команда просто не існує для нього');
  const balAfter = await money.balancesOf(null, id);
  eq(Number(balAfter.gram), 0, 'і нічого не нараховано');

  ok(await admin.handle(msg('привіт', ADMIN)) === false,
    'звичайне повідомлення не перехоплюється');
  ok(await admin.handle(msg('/admin', ADMIN)) === true, '/admin перехоплюється');

  // ── finding a player ─────────────────────────────────────────────────────
  console.log('\n  ── пошук ──');
  await run(`/admin who ${name}`);
  ok(last() && /Уровень/.test(last().html), 'who показує стан гравця');
  eq(last().tgId, ADMIN, 'відповідь приходить у приватку тому, хто питав');

  await run('/admin who немаєТакого');
  ok(last() && /Не найден/.test(last().html), 'неіснуючий — сказано прямо');

  await run(`/admin who ${TAG}`);
  ok(last() && /Похожие/.test(last().html), 'часткове імʼя — пропонує схожих');

  // ── level ────────────────────────────────────────────────────────────────
  console.log('\n  ── рівень ──');
  await run(`/admin lvl ${name} 30`);
  const prog = await players.progressOf(null, id);
  eq(prog.lvl, 30, 'рівень виставлено в базі');
  ok(last() && /30/.test(last().html), 'і підтверджено у відповіді');

  await run(`/admin lvl ${name} 99999`);
  const capped = await players.progressOf(null, id);
  ok(capped.lvl <= 1000, `завищений рівень обрізано (${capped.lvl})`);
  await run(`/admin lvl ${name} 30`);

  // ── currency goes through the ledger ─────────────────────────────────────
  console.log('\n  ── валюта ──');
  for (const [cmd, cur] of [['gold', 'gold'], ['gram', 'gram'], ['nexum', 'nexum']]) {
    await run(`/admin ${cmd} ${name} 250`);
    const b = await money.balancesOf(null, id);
    eq(Number(b[cur]), 250, `${cmd}: нараховано 250`);
    const { rows } = await pool().query(
      `SELECT count(*)::int n FROM ledger WHERE player_id = $1 AND currency = $2 AND reason = 'admin_grant'`,
      [id, cur]);
    eq(rows[0].n, 1, `${cmd}: рядок у леджері є — гроші не створені повз money.js`);
  }

  // The check that makes the ledger worth having.
  const { rows: drift } = await pool().query(`
    SELECT count(*)::int n FROM (
      SELECT b.amount, COALESCE((SELECT sum(l.delta) FROM ledger l
        WHERE l.player_id = b.player_id AND l.currency = b.currency), 0) AS led
        FROM balances b WHERE b.player_id = $1) x WHERE x.amount <> x.led`, [id]);
  eq(drift[0].n, 0, 'баланс і леджер сходяться');

  // ── taking away ──────────────────────────────────────────────────────────
  await run(`/admin gram ${name} -100`);
  const afterTake = await money.balancesOf(null, id);
  eq(Number(afterTake.gram), 150, 'відʼємна сума списує');

  await run(`/admin gram ${name} -99999`);
  const afterFail = await money.balancesOf(null, id);
  eq(Number(afterFail.gram), 150, 'списати більше, ніж є, не можна');
  ok(last() && /Недостаточно/.test(last().html), 'і про це сказано');

  // ── every action is on the record ────────────────────────────────────────
  console.log('\n  ── журнал ──');
  const { rows: acts } = await pool().query(
    `SELECT action, admin_tg_id, meta FROM admin_actions
      WHERE ref_type = 'player' AND ref_id = $1 ORDER BY id`, [String(id)]);
  ok(acts.length >= 6, `дії записані (${acts.length})`);
  ok(acts.every(a => a.admin_tg_id === ADMIN), 'у кожному записі — хто це зробив');
  ok(acts.some(a => a.action === 'set_level') && acts.some(a => a.action === 'grant')
     && acts.some(a => a.action === 'take'),
    'записані і рівень, і нарахування, і списання');

  // ── VIP ──────────────────────────────────────────────────────────────────
  await run(`/admin vip ${name} 5`);
  const { rows: vip } = await pool().query('SELECT level FROM player_vip WHERE player_id = $1', [id]);
  eq(vip[0].level, 5, 'VIP виставлено');

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
