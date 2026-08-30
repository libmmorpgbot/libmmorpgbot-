#!/usr/bin/env node
'use strict';
// ── Тёзка не может закрывать вход ───────────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/dupname-check.js
//
//   [socket:loginTelegramWebApp] error: duplicate key value violates unique
//   constraint "players_username_key"
//
// Пять раз за неделю в боевом журнале. Для игрока это «захожу, грузит, и потом
// всё чёрное»: вход падает целиком, транзакция откатывается, сессии нет.
//
// Имя берётся из профиля Телеграма, а имена в Телеграме не уникальны и никогда
// ими не были — в прежней сборке индекс по username стоял БЕЗ unique. Двое
// «Максим» — и второй не входит никогда.
//
// Проверка идёт через ту же транзакцию, что и вход, потому что ловушка именно
// в ней: ошибка в Postgres переводит транзакцию в состояние aborted, и «поймал
// и повторил» без точки сохранения меняет одну ошибку на другую (25P02).
const { tx, query, close } = require('../server/db');
const players = require('../server/db/repos/players');
const chat = require('../server/db/repos/chat');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'dup-' + String(process.pid).slice(-5);
const made = [];

(async () => {
  console.log(`\ndupname-check  (${TAG})\n`);

  // Имя, которое возьмут ОБА. Ровно тот случай из журнала: два разных
  // телеграм-аккаунта с одинаковым отображаемым именем.
  const NAME = `${TAG}_Максим`;
  const TG_A = `${TAG}-a`;
  const TG_B = `${TAG}-b`;

  console.log('  ── двое с одним именем ──');
  const a = await tx(t => players.ensure(t, TG_A, NAME));
  made.push(a.id);
  ok(a.id > 0, 'первый завёлся');

  // Вот эта строка и падала. Целиком, вместе со всей транзакцией входа.
  let bErr = null;
  const b = await tx(t => players.ensure(t, TG_B, NAME)).catch(e => { bErr = e; return null; });
  ok(!!b, 'второй с тем же именем ТОЖЕ вошёл', bErr && `${bErr.code} ${bErr.message}`);
  if (b) made.push(b.id);

  // И вход после ensure продолжается: login делает ещё два запроса в той же
  // транзакции. Если ошибка выше её отравила, они ответят 25P02 — то есть
  // «поймали и пошли дальше» без точки сохранения ничего бы не спасло.
  if (b) {
    let after = null, afterErr = null;
    await tx(async (t) => {
      const e = await players.ensure(t, TG_B, NAME);
      const p = await players.byTelegramId(t, TG_B);
      if (p.username !== NAME) await players.setUsername(t, e.id, NAME);
      after = await players.byTelegramId(t, TG_B);
    }).catch(err => { afterErr = err; });
    ok(!afterErr, 'транзакция входа доходит до конца — не отравлена',
      afterErr && `${afterErr.code} ${afterErr.message}`);
    ok(!!after && !!after.username, 'у второго есть имя', after && after.username);
  }

  // ── переименование в занятое имя ─────────────────────────────────────────
  // Второй капкан той же формы: аккаунт есть, человек сменил имя в Телеграме
  // на уже занятое — и падал setUsername, на КАЖДОМ входе.
  console.log('  ── переименование в занятое ──');
  const TG_C = `${TAG}-c`;
  const c = await tx(t => players.ensure(t, TG_C, `${TAG}_Другой`));
  made.push(c.id);
  let renErr = null;
  await tx(async (t) => { await players.setUsername(t, c.id, NAME); }).catch(e => { renErr = e; });
  ok(!renErr, 'переименование в занятое имя не роняет вход',
    renErr && `${renErr.code} ${renErr.message}`);
  const cAfter = await players.byTelegramId(null, TG_C);
  ok(!!cAfter && !!cAfter.username, 'имя у него осталось непустым', cAfter && cAfter.username);

  // ── кому уходит личное сообщение ─────────────────────────────────────────
  // Уникальность обещала однозначность и не давала её: индекс был
  // регистрозависимым, а поиск — нет. Теперь порядок задан явно.
  console.log('  ── поиск получателя ЛС ──');
  const found = await chat.playerByUsername(null, NAME);
  ok(!!found, 'получатель по имени находится');
  const all = await query(null,
    'SELECT id FROM players WHERE lower(username) = lower($1) ORDER BY id', [NAME]);
  console.log(`      под именем «${NAME}» аккаунтов: ${all.rows.length}`);
  if (found && all.rows.length > 1) {
    eq(Number(found.id), Number(all.rows[0].id),
      'из тёзок выбирается самый старый — а не как придётся');
  }
  // Регистр: тот, у кого имя совпадает буква в букву, идёт вперёд.
  const upper = NAME.toUpperCase();
  const TG_D = `${TAG}-d`;
  const d = await tx(t => players.ensure(t, TG_D, upper));
  made.push(d.id);
  const exact = await chat.playerByUsername(null, upper);
  ok(exact && Number(exact.id) === Number(d.id),
    'точное совпадение регистра выигрывает у неточного',
    exact && `нашли ${exact.username} (${exact.id}), ждали ${upper} (${d.id})`);

  // ── и само ограничение ───────────────────────────────────────────────────
  // Пока миграция 018 не применена, вход держится на точке сохранения выше.
  // После неё уникальности нет вовсе. Печатается, а не утверждается: это
  // состояние базы, а не кода, и оно меняется рукой владельца.
  const uq = await query(null, `
    SELECT 1 FROM pg_indexes WHERE tablename = 'players' AND indexname = 'players_username_key'`);
  console.log(uq.rows.length
    ? '      уникальность ещё стоит — миграция 018 не применена (вход держит SAVEPOINT)'
    : '      уникальность снята миграцией 018');
  const li = await query(null, `
    SELECT 1 FROM pg_indexes WHERE tablename = 'players' AND indexname = 'players_username_lower_idx'`);
  if (!uq.rows.length) {
    ok(li.rows.length === 1, 'индекс по lower(username) на месте — поиск ЛС не читает таблицу целиком');
  }

  // ── аккаунт без строки прогресса ─────────────────────────────────────────
  //   [act:killReward] TypeError: Cannot read properties of null (reading 'lvl')
  // Убитый монстр, «Ошибка сервера» игроку, алерт операторам. progressOf
  // отвечал null, а из шестнадцати вызывающих проверяют его не все.
  console.log('  ── пропавшая строка прогресса ──');
  {
    const TG_E = `${TAG}-e`;
    const e = await tx(t => players.ensure(t, TG_E, `${TAG}_Безпрогресса`));
    made.push(e.id);
    await query(null, 'DELETE FROM player_progress WHERE player_id = $1', [e.id]);
    const gone = await query(null, 'SELECT 1 FROM player_progress WHERE player_id = $1', [e.id]);
    eq(gone.rows.length, 0, 'строка прогресса действительно удалена');

    let prog = null, progErr = null;
    try { prog = await players.progressOf(null, e.id); } catch (err) { progErr = err; }
    ok(!progErr && prog && typeof prog.lvl === 'number',
      'progressOf возвращает годную строку, а не null',
      progErr ? progErr.message : JSON.stringify(prog));
    const back = await query(null, 'SELECT 1 FROM player_progress WHERE player_id = $1', [e.id]);
    eq(back.rows.length, 1, 'и строка восстановлена в базе');
  }

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await wipeItemsAll(made);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await wipeItemsAll(made); await close(); } catch {}
  process.exit(1);
});
