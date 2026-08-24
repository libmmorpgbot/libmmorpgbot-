#!/usr/bin/env node
'use strict';
// ── Books in, skills out ────────────────────────────────────────────────────
//
//   node dev/skills-check.js
//   PLAY_AGAINST=https://libertymmorpg.online node dev/skills-check.js
//
// "Пропал навык мультискилл, выпала книга сегодня, активировал, но щас нет и в
// инвентаре тоже нет" — a book was spent and nothing was learned. That report
// describes a state with two halves, and only a test that watches BOTH can
// tell them apart: the book leaving the bag, and the level arriving on the
// skill. A unit test of either half passes while the pair is broken.
//
// It goes over a real socket for the same reason: what was wrong the last four
// times was the wiring, never the function.

const crypto = require('crypto');
const io = require('socket.io-client');

const REMOTE = process.env.PLAY_AGAINST || null;
const PORT = Number(process.env.PLAY_PORT || 3187);
if (!REMOTE) {
  process.env.PORT = String(PORT);
  process.env.OPS_LIVE = '0';
  process.env.NODE_ENV = 'test';
}
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const {
  skillBookId, advSkillBookId, passiveBookId,
  SKILL_STUDY_COST, SKILL_UPGRADE_COST, ADV_SKILL_STUDY_COST,
  passivesForClass,
} = require('../shared/definitions');
const app = REMOTE ? null : require('../server/app');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'sk-' + String(process.pid).slice(-5);
const TG = 940000000 + (process.pid % 1000);
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const CLASS = 'ranger';                       // the class the report came from
let madeId = null, sock = null;

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

// The two halves, read straight from the database rather than from a reply the
// server composed — a handler that says it worked is exactly what needs
// checking.
const bookCount = async (id) => {
  const { rows } = await pool().query(
    `SELECT COALESCE(sum(qty), 0)::int n FROM player_items
      WHERE player_id = $1 AND item_id = $2 AND container = 'inventory'`, [madeId, id]);
  return rows[0].n;
};
const skillLevel = async (kind, key) => {
  const { rows } = await pool().query(
    'SELECT level FROM player_skills WHERE player_id = $1 AND kind = $2 AND key = $3',
    [madeId, kind, key]);
  return rows.length ? rows[0].level : 0;
};
const giveBooks = async (id, n) => {
  await tx(async (t) => { for (let i = 0; i < n; i++) await items.add(t, madeId, id); });
};

async function main() {
  console.log(`\nskills-check  (${TAG})  →  ${BASE}\n`);
  if (app) { await app.boot(); console.log(''); }

  sock = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  const errors = [];
  sock.on('progressError', e => errors.push(e && e.msg));
  const rolled = [];
  sock.on('upgradeRolled', r => rolled.push(r));
  let lastSkills = null;
  sock.on('progressSync', d => { lastSkills = d; });

  sock.emit('loginTelegramWebApp', { initData: initData(TG, `${TAG}_p`) });
  await once(sock, 'authOk', 12000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(TG)]);
  madeId = Number(rows[0].id);
  sock.emit('selectChar', { type: CLASS });
  await once(sock, 'gameStart', 12000);
  await wait(200);

  // ── study: one book, one level ───────────────────────────────────────────
  console.log('  ── вивчення навички ──');
  const qBook = skillBookId(CLASS, 'Q');            // 'Мульти-выстрел' for a ranger
  await giveBooks(qBook, SKILL_STUDY_COST);
  eq(await bookCount(qBook), SKILL_STUDY_COST, `${SKILL_STUDY_COST} книга в сумці`);

  lastSkills = null;
  sock.emit('learnSkill', { key: 'Q' });
  await once(sock, 'progressSync', 8000).catch(() => null);
  await wait(300);
  eq(await skillLevel('skill', 'Q'), 1, 'навичка вивчена — рівень 1 у базі');
  eq(await bookCount(qBook), 0, 'книга витрачена');
  ok(lastSkills && lastSkills.skillLevels && lastSkills.skillLevels.Q === 1,
    'і клієнт про це дізнався (progressSync несе skillLevels.Q)');

  // ── a study with no book changes nothing ─────────────────────────────────
  errors.length = 0;
  sock.emit('learnSkill', { key: 'W' });
  await wait(600);
  eq(await skillLevel('skill', 'W'), 0, 'без книги навичка не вивчається');
  ok(errors.length > 0, `і гравцю сказали чому (${errors[0] || '—'})`);

  // ── upgrade: the price is TWO ────────────────────────────────────────────
  // The client greys the button out below SKILL_UPGRADE_COST and shows the
  // count dropping by that many. The server charged one.
  console.log('  ── підвищення навички ──');
  await giveBooks(qBook, SKILL_UPGRADE_COST - 1);
  errors.length = 0; rolled.length = 0;
  sock.emit('upgradeSkill', { key: 'Q' });
  await wait(700);
  eq(rolled.length, 0, `на ${SKILL_UPGRADE_COST - 1} книгу підвищення не проходить`);
  eq(await bookCount(qBook), SKILL_UPGRADE_COST - 1, 'і книга лишилась у сумці');
  ok(errors.length > 0, `гравцю сказано, скільки треба (${errors[0] || '—'})`);

  await giveBooks(qBook, 1);                        // now exactly SKILL_UPGRADE_COST
  rolled.length = 0;
  const lvlBefore = await skillLevel('skill', 'Q');
  sock.emit('upgradeSkill', { key: 'Q' });
  await once(sock, 'upgradeRolled', 8000).catch(() => null);
  await wait(300);
  eq(rolled.length, 1, 'спроба підвищення відбулась');
  eq(await bookCount(qBook), 0, `списано рівно ${SKILL_UPGRADE_COST}`);
  const lvlAfter = await skillLevel('skill', 'Q');
  // The roll can fail — that is the design, and asserting on the outcome would
  // be asserting on a coin. What must hold is that the ANSWER matches what
  // happened, because "я активировал, а ничего не произошло" is precisely the
  // case where the client was told nothing.
  const r = rolled[0] || {};
  ok(typeof r.ok === 'boolean', `сервер сказав, чи вийшло (ok=${r.ok})`);
  eq(lvlAfter, r.ok ? lvlBefore + 1 : lvlBefore,
    `рівень у базі відповідає відповіді (${lvlBefore} → ${lvlAfter}, ok=${r.ok})`);

  // ── the advanced book: the price is FIVE ─────────────────────────────────
  console.log('  ── продвинута навичка ──');
  const advBook = advSkillBookId(CLASS, 'Q');
  await giveBooks(advBook, ADV_SKILL_STUDY_COST - 1);
  errors.length = 0;
  sock.emit('learnAdvSkill', { key: 'Q' });
  await wait(700);
  eq(await skillLevel('adv_learned', 'Q'), 0,
    `на ${ADV_SKILL_STUDY_COST - 1} книгах продвинута навичка не вивчається`);
  eq(await bookCount(advBook), ADV_SKILL_STUDY_COST - 1,
    'і книги на місці — не з’їдені за ніщо');
  ok(errors.length > 0, `сказано, скільки треба (${errors[0] || '—'})`);

  await giveBooks(advBook, 1);
  lastSkills = null;
  sock.emit('learnAdvSkill', { key: 'Q' });
  await once(sock, 'progressSync', 8000).catch(() => null);
  await wait(300);
  eq(await skillLevel('adv_learned', 'Q'), 1, 'продвинута навичка вивчена');
  eq(await bookCount(advBook), 0, `списано рівно ${ADV_SKILL_STUDY_COST}`);
  ok(lastSkills && lastSkills.advSkillLearned && lastSkills.advSkillLearned.Q === true,
    'клієнт бачить її вивченою (progressSync.advSkillLearned.Q)');

  // ── the toggle ───────────────────────────────────────────────────────────
  lastSkills = null;
  sock.emit('toggleAdvSkill', { key: 'Q' });
  await once(sock, 'progressSync', 8000).catch(() => null);
  await wait(200);
  eq(await skillLevel('adv_active', 'Q'), 1, 'продвинутий варіант увімкнено');
  ok(lastSkills && lastSkills.advSkillActive && lastSkills.advSkillActive.Q === true,
    'і це видно клієнту');
  sock.emit('toggleAdvSkill', { key: 'Q' });
  await once(sock, 'progressSync', 8000).catch(() => null);
  await wait(200);
  eq(await skillLevel('adv_active', 'Q'), 0, 'і вимикається назад');

  // ── passives: one to learn, two to raise ─────────────────────────────────
  console.log('  ── пасивки ──');
  const passives = passivesForClass(CLASS) || [];
  if (!passives.length) {
    ok(false, `у класу ${CLASS} немає пасивок у каталозі`);
  } else {
    const pid0 = passives[0].id;
    const pBook = passiveBookId(pid0);
    await giveBooks(pBook, SKILL_STUDY_COST);
    sock.emit('learnPassive', { id: pid0 });
    await once(sock, 'progressSync', 8000).catch(() => null);
    await wait(300);
    eq(await skillLevel('passive', pid0), 1, `пасивка «${passives[0].name || pid0}» вивчена`);
    eq(await bookCount(pBook), 0, 'книга витрачена');

    // Raising it costs two, and one must not be enough.
    await giveBooks(pBook, SKILL_UPGRADE_COST - 1);
    errors.length = 0;
    sock.emit('upgradePassive', { id: pid0 });
    await wait(700);
    eq(await skillLevel('passive', pid0), 1,
      `на ${SKILL_UPGRADE_COST - 1} книгу пасивка не піднімається`);
    eq(await bookCount(pBook), SKILL_UPGRADE_COST - 1, 'і книга лишилась');

    await giveBooks(pBook, 1);
    sock.emit('upgradePassive', { id: pid0 });
    await once(sock, 'progressSync', 8000).catch(() => null);
    await wait(300);
    eq(await skillLevel('passive', pid0), 2, 'на двох — піднімається');
    eq(await bookCount(pBook), 0, `списано рівно ${SKILL_UPGRADE_COST}`);
  }

  // ── it all survives a reconnect ──────────────────────────────────────────
  // "Щас нет" — the complaint is about what is there on the NEXT login, so
  // that is what the last check looks at: the projection the client rebuilds
  // the character from, not the push it got at the time.
  console.log('  ── перезаход ──');
  sock.disconnect();
  await wait(400);
  const s2 = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(s2, 'connect');
  s2.emit('loginTelegramWebApp', { initData: initData(TG, `${TAG}_p`) });
  const auth = await once(s2, 'authOk', 12000);
  const sd = auth.savedData || {};
  eq((sd.skillLevels || {}).Q, await skillLevel('skill', 'Q'),
    'рівень навички повернувся у savedData');
  eq((sd.advSkillLearned || {}).Q, true, 'продвинута навичка теж на місці');
  s2.disconnect();

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    try { sock && sock.disconnect(); } catch (_) {}
    if (madeId) await pool().query('DELETE FROM players WHERE id = $1', [madeId]).catch(() => {});
    await close();
    process.exit(fail ? 1 : 0);
  });
