#!/usr/bin/env node
'use strict';
// ── Кого показывают людям ───────────────────────────────────────────────────
//
//   DATABASE_URL=... node dev/visibility-check.js
//
// «Наших ботів видали, їхнє створення видали.»
//
// Фикстуры проверок убраны, но жалоба осталась верной там, куда оператор
// смотрит первым делом: пятёрка «топ по уровню» в админке состояла из восьми
// adm-*_victim 77-го уровня и ни одного живого человека. Рейтинг фильтровал
// бан, а эти пятёрки — ничего.
//
// Проверка держит два разных обещания:
//
//   ПРАВИЛО   все три места, где людей показывают людям, спрашивают ОДНУ
//             функцию (players.realPlayerSql), а не пишут условие каждый своё;
//   ФАКТ      и в боевой базе прямо сейчас в этих списках нет ни забаненных,
//             ни аккаунтов с нетелеграмным id.
//
// Ничего не создаёт: у проекта нет отдельной базы, и проверка, которая заводит
// себе игрока, — это ровно то, что здесь ловится.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { query, close } = require('../server/db');
const players = require('../server/db/repos/players');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

(async () => {
  // ── 1. правило одно на всех ──────────────────────────────────────────────
  console.log('\n  ── одно правило, а не три ──');
  {
    ok(typeof players.realPlayerSql === 'function', 'правило существует и вывешено наружу');
    const sql = players.realPlayerSql('p');
    ok(/NOT p\.banned/.test(sql), 'оно отсекает забаненных', sql);
    ok(/p\.telegram_id ~ '\^\[0-9\]\+\$'/.test(sql), 'и нетелеграмные id', sql);
    // Алиас подставляется, а не игнорируется: рейтинг зовёт его и для `q`.
    ok(players.realPlayerSql('q').includes('q.banned'), 'алиас подставляется');
    // Диапазон 93-99 млн сюда попасть не должен: в боевой живёт настоящий
    // figrt с id 982997755, и такое правило вычеркнуло бы его из рейтинга.
    ok(!/930000000|990000000/.test(sql),
      'диапазон тестовых id сюда не просочился (под него подходит живой игрок)', sql);

    const USERS = [
      ['server/handlers2/progression.js', 'рейтинг игроков и кланов'],
      ['server/routes/admin2.js', 'пятёрки лидеров в админке'],
      ['server/presence.js', 'лидер рейтинга в ауре'],
    ];
    for (const [f, what] of USERS) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      ok(/realPlayerSql\(/.test(src), `${what} спрашивает общее правило`);
    }
    // И никто из них не носит своё собственное условие рядом.
    const adm = fs.readFileSync(path.join(ROOT, 'server/routes/admin2.js'), 'utf8');
    const tops = adm.slice(adm.indexOf('const tops = {'), adm.indexOf('const tops = {') + 1200);
    ok(tops.includes('${REAL}'), 'все четыре пятёрки в админке — под фильтром');
    ok((tops.match(/\$\{REAL\}/g) || []).length >= 4,
      `их четыре: БМ, уровень, золото, нексум (нашлось ${(tops.match(/\$\{REAL\}/g) || []).length})`);
  }

  // ── 2. и в живой базе этого действительно нет ────────────────────────────
  console.log('\n  ── боевая база ──');
  {
    const R = players.realPlayerSql('p');
    // Рейтинг игроков.
    const rating = await query(null, `
      SELECT p.username, p.banned, p.telegram_id FROM players p
        JOIN player_progress pr ON pr.player_id = p.id
       WHERE ${R} AND p.bm > 0 ORDER BY p.bm DESC, p.id LIMIT 50`);
    ok(rating.rows.length > 0, `рейтинг не пустой (${rating.rows.length} строк)`);
    const bad = rating.rows.filter(r => r.banned || !/^[0-9]+$/.test(String(r.telegram_id)));
    ok(bad.length === 0, 'в рейтинге нет фикстур',
      bad.map(r => r.username).join(', '));

    // Топ по уровню в админке — тот самый, что состоял из adm-*_victim.
    const lvl = await query(null, `
      SELECT p.username, p.banned, p.telegram_id, pr.lvl FROM player_progress pr
        JOIN players p ON p.id = pr.player_id
       WHERE ${R} ORDER BY pr.lvl DESC LIMIT 5`);
    const badL = lvl.rows.filter(r => r.banned || !/^[0-9]+$/.test(String(r.telegram_id)));
    ok(badL.length === 0,
      `топ по уровню — живые люди (${lvl.rows.map(r => r.username + ' ур.' + r.lvl).join(', ')})`,
      badL.map(r => r.username).join(', '));

    // Лидер в ауре — его имя уходит каждому клиенту.
    const aura = await query(null,
      `SELECT p.username, p.banned FROM players p WHERE ${R} ORDER BY p.bm DESC NULLS LAST LIMIT 1`);
    ok(aura.rows.length === 1 && !aura.rows[0].banned,
      `лидер в ауре — живой аккаунт (${aura.rows[0] && aura.rows[0].username})`);

    // ── и сколько их всего, чтобы число было видно ──────────────────────────
    const n = await query(null, `
      SELECT count(*) FILTER (WHERE telegram_id !~ '^[0-9]+$')::int AS notg,
             count(*) FILTER (WHERE banned)::int AS banned,
             count(*)::int AS total FROM players`);
    const s = n.rows[0];
    console.log(`      всего аккаунтов ${s.total} · с нетелеграмным id ${s.notg} · забанено ${s.banned}`);
    // Живой не должен быть спрятан ни одним из двух условий: если живых в
    // рейтинге стало меньше полусотни, а аккаунтов тысячи — правило слишком
    // широкое.
    ok(rating.rows.length >= Math.min(50, s.total - s.notg - s.banned),
      'правило не прячет живых: рейтинг заполнен');
  }

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await close(); } catch {} process.exit(1); });
