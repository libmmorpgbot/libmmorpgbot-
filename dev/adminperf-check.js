#!/usr/bin/env node
'use strict';
// ── Карточка игрока в админке не читает журнал целиком ─────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/adminperf-check.js
//
// «canceling statement due to statement timeout» при открытии игрока в
// админ-панели (client.admin:openPlayer). Та же болезнь, что лечила миграция
// 020 на входе в игру, только на другом экране: три запроса в карточке читали
// журнал денег целиком.
//
// Такую поломку не видит ни линтер, ни чтение кода: запросы корректны, и тест
// «вернули ли они верные числа» зелёный. Она видна только планировщику и
// только на объёме — поэтому здесь EXPLAIN на настоящих данных.
//
// ── и почему проверка смотрит не только «есть ли индекс» ───────────────────
// Частичный индекс планировщик применяет, только если может ДОКАЗАТЬ его
// предикат из текста запроса. Пока список причин ехал в запрос параметром
// ($2, text[]), доказать было нечего: значение приходит после планирования.
// Индекс существовал бы и молча не применялся.
//
// Поэтому условия берутся ИЗ ЖИВОГО КОДА (server/routes/admin2.js), а не
// повторяются здесь: проверка, которая знает своё собственное 'mob_kill',
// подтвердит саму себя и промолчит, когда причину переименуют. И поэтому же
// последний раздел смотрит план, а не наличие индекса.
const fs = require('fs');
const path = require('path');
const { tx, query, close } = require('../server/db');
const players = require('../server/db/repos/players');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const head = s => console.log(`\n  ── ${s} ──`);

const TAG = 'aperf-' + String(process.pid).slice(-5);
const ROWS = 50000;
const flat = s => String(s).replace(/\s+/g, ' ').slice(0, 200);

(async () => {
  console.log(`\nadminperf-check  (${TAG})\n`);

  // ── 1. условия, которыми открывается карточка ─────────────────────────────
  head('условия берутся из живого кода');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/routes/admin2.js'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = "([^"]+)"`));
    return m ? m[1] : null;
  };
  const NOISE_OUT = grab('NOISE_OUT');
  const NOISE_IN = grab('NOISE_IN');
  const SEASON_EVENT = grab('SEASON_EVENT');
  ok(!!NOISE_OUT && !!NOISE_IN && !!SEASON_EVENT,
    'три условия карточки найдены в admin2.js',
    'их там нет — либо переписаны, либо переехали, и проверка не о чём');
  if (!NOISE_OUT || !NOISE_IN || !SEASON_EVENT) throw new Error('нет условий в admin2.js');

  // Условие обязано быть КОНСТАНТНЫМ. Стоит вернуть туда $2 — и все индексы
  // ниже останутся на месте, ровно ничего не ускоряя.
  ok(!/\$\d/.test(NOISE_OUT + NOISE_IN + SEASON_EVENT),
    'и ни одно из них не параметр — иначе частичный индекс недоказуем',
    `${NOISE_OUT} · ${NOISE_IN} · ${SEASON_EVENT}`);

  // ── 2. индексы под них ────────────────────────────────────────────────────
  head('индексы на месте, валидны и покрывают те же условия');
  const idxOf = async (name) => {
    const { rows } = await query(null, `
      SELECT i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS pred
        FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = $1`, [name]);
    return rows[0] || null;
  };
  // Причины, названные в коде, обязаны стоять и в предикате индекса. Сверяются
  // по именам причин, а не посимвольно: планировщик нормализует выражение
  // ('mob_kill'::text, скобки), и требовать побайтового совпадения значило бы
  // краснеть на ровном месте.
  const reasons = [...new Set((NOISE_OUT + ' ' + NOISE_IN).match(/'([a-z_]+)'/g) || [])];
  for (const [name, need] of [
    ['ledger_player_events_idx', reasons],
    ['ledger_player_mobgold_idx', reasons.concat("'gold'")],
    ['player_logs_season_idx', ["'season%'"]],
  ]) {
    const idx = await idxOf(name);
    ok(!!idx, `индекс ${name} существует`, 'миграция 021 не накатана');
    if (!idx) continue;
    ok(idx.indisvalid === true, `${name} валиден, а не брошен на середине`,
      'INVALID: построение CONCURRENTLY оборвалось. DROP INDEX CONCURRENTLY и заново');
    const pred = String(idx.pred || '');
    const missing = need.filter(r => !pred.includes(r.replace(/'/g, '')));
    ok(missing.length === 0, `${name} покрывает те же значения, что и код`,
      `в предикате нет ${missing.join(', ')} — условие индекса: ${pred}`);
  }

  // ── 3. план на объёме ─────────────────────────────────────────────────────
  // На пустой таблице планировщик выберет скан и будет прав — на десяти
  // строках он дешевле. Без строк проверка была бы зелёной всегда.
  head(`план на ${ROWS} строк одному игроку`);
  const { id } = await tx(t => players.ensure(t, `${TAG}-a`, `${TAG}_игрок`));
  await query(null, `
    INSERT INTO ledger (player_id, currency, delta, balance_after, reason)
    SELECT $1, 'gold', 1, g, CASE WHEN g % 3 = 0 THEN 'mob_drop' ELSE 'mob_kill' END
      FROM generate_series(1, $2) g`, [id, ROWS]);
  await query(null, `
    INSERT INTO ledger (player_id, currency, delta, balance_after, reason)
    VALUES ($1, 'gold', 100, 1, 'market_sell')`, [id]);
  await query(null, `
    INSERT INTO player_logs (player_id, event, meta, created_at)
    SELECT $1, CASE WHEN g % 500 = 0 THEN 'seasonPoints' ELSE 'skillUse' END, '{}'::jsonb, now()
      FROM generate_series(1, 20000) g`, [id]);
  // VACUUM, а не просто ANALYZE, и это не перестраховка. Index-only scan
  // читает только индекс лишь для страниц, помеченных в карте видимости как
  // «все строки видны всем», а карту заполняет именно VACUUM. Сразу после
  // вставки она пуста: план выбирается тот же, но с Heap Fetches на каждую
  // строку — то есть с обращением к таблице, которого проверка и добивается
  // избежать. Первый прогон на чистой базе из-за этого краснел, второй был
  // зелёным, и разница была бы неотличима от случайной.
  await query(null, 'VACUUM (ANALYZE) ledger');
  await query(null, 'VACUUM (ANALYZE) player_logs');

  const planOf = async (sql) => {
    const { rows } = await query(null, `EXPLAIN (COSTS OFF, FORMAT TEXT) ${sql}`, [id]);
    return rows.map(r => r['QUERY PLAN']).join('\n');
  };
  // Сколько строк план прочитал и выбросил. Это и есть цена запроса, которую
  // ловит проверка: «читает целиком» — это не Seq Scan сам по себе, а вот эта
  // цифра. Для player_logs она единственный годный признак: таблица
  // секционирована, и Seq Scan по ПУСТОЙ секции планировщик выбирает
  // справедливо — там нечего индексировать, и требовать от него индекса значит
  // краснеть на верном плане.
  const removedBy = async (sql) => {
    const { rows } = await query(null, `EXPLAIN (ANALYZE, COSTS OFF, FORMAT TEXT) ${sql}`, [id]);
    const text = rows.map(r => r['QUERY PLAN']).join('\n');
    const n = (text.match(/Rows Removed by Filter: (\d+)/g) || [])
      .reduce((a, m) => a + Number(m.split(': ')[1]), 0);
    return { n, text };
  };

  // Запросы собираются ровно так же, как их собирает карточка: те же условия,
  // подставленные в тот же текст.
  const feed = await planOf(`
    SELECT currency, delta, reason, ref_type, ref_id, created_at
      FROM ledger WHERE player_id = $1 AND ${NOISE_OUT} ORDER BY id DESC LIMIT 80`);
  ok(!/Seq Scan on ledger/i.test(feed), 'лента событий не читает журнал целиком', flat(feed));
  ok(/ledger_player_events_idx/.test(feed), 'и берёт свой частичный индекс', flat(feed));
  // Порядок (player_id, id DESC) отдаёт последние 80 уже отсортированными.
  // Сортировка в плане значит, что индекс взят не тот или порядок в нём другой.
  ok(!/\bSort\b/i.test(feed), 'и не сортирует — индекс уже в нужном порядке', flat(feed));

  const totals = await planOf(`
    SELECT count(*)::int n, COALESCE(sum(delta), 0) AS s
      FROM ledger WHERE player_id = $1 AND currency = 'gold' AND ${NOISE_IN}`);
  ok(!/Seq Scan on ledger/i.test(totals), 'итог по мобам не читает журнал целиком', flat(totals));
  ok(/Index Only Scan/i.test(totals) && /ledger_player_mobgold_idx/.test(totals),
    'и идёт index-only — без единого обращения к таблице', flat(totals));

  const seasonSql = `
    SELECT event, meta, created_at FROM player_logs
     WHERE player_id = $1 AND ${SEASON_EVENT} ORDER BY created_at DESC LIMIT 60`;
  const season = await planOf(seasonSql);
  // Имя в плане — это имя индекса СЕКЦИИ, а не родителя, и оно зависит от того,
  // чем индекс построен: migrate-now.sh называет их <секция>_season_idx, а
  // миграция на пустой базе отдаёт имя PostgreSQL, и тот придумывает
  // player_logs_2026_09_player_id_created_at_idx1. Поэтому имена спрашиваются у
  // базы, а не угадываются по шаблону: проверка, зашившая одно из двух, краснела
  // бы через раз в зависимости от способа накатки.
  const { rows: kids } = await query(null, `
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'player_logs_season_idx'::regclass`);
  ok(kids.length > 0, 'у сезонного индекса есть индексы секций',
    'родитель есть, а на секциях его нет — планировщик им не воспользуется');
  ok(kids.some(k => season.includes(k.relname)),
    'сезонная лента берёт свой частичный индекс',
    `в плане нет ни одного из ${kids.map(k => k.relname).join(', ')}: ${flat(season)}`);
  // До индекса план отбрасывал здесь 20 тысяч строк на 20 тысяч записанных —
  // то есть перечитывал весь журнал игрока ради шестидесяти строк.
  const seasonRead = await removedBy(seasonSql);
  ok(seasonRead.n < 1000, 'и не перебирает весь журнал игрока ради шестидесяти строк',
    `выброшено ${seasonRead.n} строк: ${flat(seasonRead.text)}`);

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  // Строки журнала не удаляются: ledger append-only, DELETE по нему отозван
  // (миграция 013). Тестовый игрок остаётся со своими строками — как и у
  // login-perf-check, это цена честного журнала.
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await close(); } catch { /* уже закрыт */ }
  process.exit(1);
});
