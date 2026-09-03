#!/usr/bin/env node
'use strict';
// ── The client bundle has to PARSE ──────────────────────────────────────────
//
//   node dev/bundle-check.js
//
// The client is 24 files concatenated into ONE <script> (server/assets.js), so
// they share a single script scope. That is what makes a name declared in
// player.js usable from game.js — and it is also what makes two files
// declaring the same `let` a fatal error:
//
//   Uncaught SyntaxError: Identifier '_lastRenderTs' has already been declared
//
// A duplicate lexical declaration is an EARLY error. The browser rejects the
// whole script before executing a single line, so the entire client is dead:
// no game, no HUD, no login — a blank page. One name in one file.
//
// Nothing caught it. eslint lints each file separately with the others' names
// supplied as globals, and redeclaring a global is not an error. boot-check
// starts the server, which concatenates and minifies the bundle without ever
// asking a JavaScript engine to parse it. So the first thing to find out was
// the browser, in production.
//
// vm.Script compiles exactly the way the browser does and raises exactly the
// same early errors, without running anything. It costs about a second.
//
// It checks the minified output too: terser rewrites the whole file, and a
// minifier that produces something unparseable is the same blank page.

const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── A language the picker offers has to be a language the strings exist in ──
//
// I18N_LANGS offers six languages. A row in I18N_UI that stops at ru+en is not
// a missing nicety: t() falls through `e[currentLang] || e.ru`, so a Ukrainian
// player who opens that screen gets Russian — with no error, no console
// warning and nothing on the server to notice it. That is exactly how the
// co-op tab and the elite farm zone shipped: 50 rows, 33 of them one feature,
// visibly Russian to the four languages nobody re-read after the feature
// landed.
//
// The placeholder half is louder when it breaks. tVars() substitutes by literal
// name — `s.split('{' + k + '}')` — so a {n} that a translator turned into {н}
// or dropped is not substituted at all: the player reads a raw brace where a
// number belongs.
//
// Rows with NO ru key are deliberately skipped. Russian for the data arrays
// (ITEM_DEF, ENEMY_DEF, CHAR_DEF …) is baked into the data itself and
// applyLocale() mutates it in place, so those rows correctly carry only the
// other five — see the header of js/i18n.js.
function i18nCoverage(fs, file, espree) {
  console.log('\n  ── языки и подстановки в i18n ──');
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true });
  } catch (err) {
    ok(false, 'i18n.js разбирается', err.message);
    return;
  }

  // The list comes from I18N_LANGS rather than a constant here on purpose: it
  // is the actual language picker. Add a seventh language to the picker and
  // every untranslated row starts failing on the next run, which is the whole
  // point — the gap opens the moment the picker offers more than the strings do.
  const langs = [];
  for (const node of ast.body) {
    if (node.type !== 'VariableDeclaration') continue;
    for (const d of node.declarations) {
      if (!d.id || d.id.name !== 'I18N_LANGS' || !d.init || d.init.type !== 'ArrayExpression') continue;
      for (const el of d.init.elements) {
        if (!el || el.type !== 'ObjectExpression') continue;
        const c = el.properties.find(p => p.type === 'Property' && (p.key.name || p.key.value) === 'code');
        if (c && c.value.type === 'Literal') langs.push(String(c.value.value));
      }
    }
  }

  // A row is an object literal whose every key is a language code. Anything
  // else in the file (I18N_LANGS entries, the quest templates, plain config)
  // has other keys and is not one.
  const rows = [];
  (function walk(node, keyName) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, keyName)); return; }
    if (node.type === 'ObjectExpression') {
      const props = node.properties.filter(p => p.type === 'Property');
      const keys = props.map(p => p.key.name || String(p.key.value));
      if (keys.length && keys.includes('ru') && keys.every(k => langs.includes(k))) {
        const vals = {};
        for (const p of props) {
          if (p.value.type === 'Literal' && typeof p.value.value === 'string') vals[p.key.name || p.key.value] = p.value.value;
        }
        rows.push({ line: node.loc.start.line, key: keyName, keys, vals });
        return;                                   // a row is a leaf, do not descend
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue;
      const child = node[k];
      if (!child || typeof child !== 'object') continue;
      walk(child, node.type === 'Property' ? (node.key.name || String(node.key.value)) : keyName);
    }
  })(ast, null);

  const PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_]*\}/g;
  const uniq = s => [...new Set(s.match(PLACEHOLDER) || [])];

  const untranslated = [];
  const badVars = [];
  let withVars = 0;
  for (const r of rows) {
    for (const l of langs) {
      if (!r.keys.includes(l)) untranslated.push(`${r.key || '?'}:${r.line} нет ${l}`);
    }
    const ruVars = uniq(r.vals.ru || '');
    if (ruVars.length) withVars++;
    for (const l of langs) {
      if (l === 'ru' || r.vals[l] === undefined) continue;
      const tVarsHere = uniq(r.vals[l]);
      // Both directions matter. A placeholder the translation dropped prints
      // nothing where a number belongs; one it invented prints a literal brace.
      for (const v of ruVars) if (!tVarsHere.includes(v)) badVars.push(`${r.key || '?'}:${r.line} ${l} потерял ${v}`);
      for (const v of tVarsHere) if (!ruVars.includes(v)) badVars.push(`${r.key || '?'}:${r.line} ${l} добавил лишний ${v}`);
    }
  }

  // A CHECK THAT FOUND NOTHING TO CHECK MUST NOT REPORT SUCCESS. If the walk
  // above ever stops matching rows — reformatted file, another parser, the
  // dictionaries moved to JSON — both lists stay empty and the two ok() calls
  // below would cheerfully report that all six languages are present in a file
  // they never read. Thresholds are roughly a third of the real counts (6
  // languages, 877 ru rows, 142 of them with placeholders), so ordinary edits
  // never reach them; only a broken scan does.
  ok(langs.length >= 5 && rows.length > 300 && withVars > 45,
    `есть что проверять — ${langs.length} языков, ${rows.length} строк с ru, из них ${withVars} с подстановками`,
    `сканирование ничего не нашло (${langs.length} языков, ${rows.length} строк, ${withVars} с подстановками) — сломана сама проверка`);

  ok(untranslated.length === 0,
    `каждая строка с ru переведена на все ${langs.length}: ${langs.join(', ')}`,
    `${untranslated.length} пропусков — ${untranslated.slice(0, 12).join('; ')}${untranslated.length > 12 ? `; … ещё ${untranslated.length - 12}` : ''}`);

  ok(badVars.length === 0,
    `подстановки {…} совпадают с ru во всех переводах (${withVars} строк)`,
    `${badVars.length} расхождений — ${badVars.slice(0, 12).join('; ')}${badVars.length > 12 ? `; … ещё ${badVars.length - 12}` : ''}`);
}

// ── размеры экрана объявлены со значением ─────────────────────────────────
// `let canvas, ctx, W, H, DPR = 1;` — значение получал только DPR. А каждое
// присваивание камеры в клиенте это `player.x - W / (2 * ZOOM)`, поэтому всё,
// что ставило камеру до первого resize() — а он ждёт размера #app, и на
// телефоне в WebView это бывает позже первого gameStart — давало NaN при
// совершенно живом игроке. Дальше NaN нёс себя через кадры сам (затухание
// отступа камеры к цели), тайловый проход считал из камеры пустой диапазон, и
// мир не рисовался всю сессию: "камера NaN,NaN · игрок 1770,1588 · чанки 0/0".
//
// Проверяется по ИСХОДНИКУ, а не в браузере, и это не лень: к моменту, когда
// страница может что-то спросить, layout уже прошёл и W конечен при любом
// объявлении. Браузерная проверка этого не поймала бы — она и не поймала.
function screenDims(fs, file) {
  console.log('\n  ── размеры экрана объявлены со значением ──');
  const src = fs.readFileSync(file, 'utf8');
  for (const name of ['W', 'H']) {
    const m = src.match(new RegExp('^let\\s+' + name + '\\s*=([^;]+);', 'm'));
    ok(!!m, `${name} объявлена со значением, а не голым let`,
      'без него камера считается из undefined и получается NaN');
    if (m) {
      ok(!/^\s*(undefined|null)\s*$/.test(m[1]),
        `${name} инициализируется чем-то конечным  ${m[1].trim().slice(0, 44)}`);
    }
  }
  // И безымянного `let W,` в общем списке быть не должно — именно так это и
  // выглядело до 27 августа.
  ok(!/^let\s+[^=;\n]*\bW\s*,/m.test(src),
    'W не объявлена в списке через запятую без значения');
}

function main() {
  console.log('\nbundle-check\n');

  // assets.js builds and minifies at require time, exactly as the server does
  // at boot — so what is checked here is the bytes that get served.
  const assets = require(path.join(__dirname, '..', 'server', 'assets.js'));

  const raw = assets.jsBundleRaw || assets.jsBundle;
  const min = assets.jsBundle;

  console.log('  ── исходный бандл ──');
  try {
    new vm.Script(raw, { filename: 'bundle.js' });
    ok(true, `бандл разбирается движком (${Math.round(raw.length / 1024)} КБ)`);
  } catch (err) {
    // The message names the offending identifier, which is the whole answer.
    ok(false, 'бандл разбирается движком', err.message);
  }

  console.log('\n  ── минифицированный ──');
  try {
    new vm.Script(min, { filename: 'bundle.min.js' });
    ok(true, `минифицированный тоже (${Math.round(min.length / 1024)} КБ)`);
  } catch (err) {
    ok(false, 'минифицированный тоже', err.message);
  }

  // The specific shape that got through: the same lexical name declared at the
  // top level of two different files. vm.Script above catches it, but naming
  // every collision at once is more useful than stopping at the first — a
  // rename usually comes in pairs.
  console.log('\n  ── повторные объявления между файлами ──');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const files = require(path.join(ROOT, 'server', 'bundle-files'));
  const espree = require('espree');
  const owner = new Map();       // name → first file that declared it
  const clashes = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let ast;
    try {
      ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true });
    } catch (err) {
      ok(false, `${rel} разбирается`, err.message);
      continue;
    }
    for (const node of ast.body) {
      // Only lexical declarations collide. `var` and `function` may legally be
      // redeclared in the same scope, and the client does that on purpose in
      // places.
      if (node.type !== 'VariableDeclaration') continue;
      if (node.kind !== 'let' && node.kind !== 'const') continue;
      for (const d of node.declarations) {
        if (d.id.type !== 'Identifier') continue;
        const prev = owner.get(d.id.name);
        if (prev && prev.file !== rel) {
          clashes.push(`${d.id.name}: ${prev.file}:${prev.line} и ${rel}:${d.loc.start.line}`);
        } else if (!prev) {
          owner.set(d.id.name, { file: rel, line: d.loc.start.line });
        }
      }
    }
  }
  // ПРОВЕРКА, КОТОРАЯ НИЧЕГО НЕ НАШЛА, НЕ ДОЛЖНА ОТЧИТЫВАТЬСЯ ОБ УСПЕХЕ.
  // Оба числа печатались в строке ниже и ни на что не влияли: если бы обход
  // ast.body перестал находить объявления — сменился парсер, поменялся формат
  // bundle-files, файлы поехали в модули — clashes оставался бы пустым, и
  // строка ниже так же уверенно сообщала бы, что дважды не объявлено ничего.
  // Пороги втрое ниже настоящих (24 файла, сотни имён), так что обычные правки
  // до них не доходят — доходит только сломавшийся обход.
  ok(owner.size > 100 && files.length > 5,
    `есть что проверять — ${owner.size} имён в ${files.length} файлах`,
    'сканирование ничего не нашло — сломана сама проверка');

  ok(clashes.length === 0,
    `ни одного имени не объявлено дважды (проверено ${owner.size} в ${files.length} файлах)`,
    clashes.join('; '));

  // I18N_FILE points the checks at another copy of i18n.js. That is how a change
  // to them gets proven still able to go red — `git show HEAD:js/i18n.js >
  // /tmp/old.js` and run against a file that has the gap. A detector nobody has
  // ever watched fail is indistinguishable from one that cannot.
  i18nCoverage(fs, process.env.I18N_FILE || path.join(ROOT, 'js', 'i18n.js'), espree);
  screenDims(fs, path.join(ROOT, 'js', 'state.js'));

  // ── карточка предмета показывает КАЖДЫЙ бонус из каталога ────────────────
  // Список характеристик в карточке собирался руками и знал семь полей из
  // двенадцати. Скорость бега у крыльев, бонус к опыту, бонус к выпадению,
  // сила крита и процент атаки у эпических питомцев не показывались НИГДЕ:
  // предмет их давал (они считаются на сервере), а в карточке их не было —
  // «статов не хватает».
  //
  // Правило: любое числовое поле, встречающееся в каталоге, обязано иметь
  // строку в карточке. Тогда следующий новый бонус вспомнит проверка.
  {
    const fs2 = require('fs');
    const { ITEM_DEF } = require(path.join(ROOT, 'shared', 'definitions'));
    const ui = fs2.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
    const at = ui.indexOf('function _itemStatRows');
    const card = at >= 0 ? ui.slice(at, at + 2200) : '';
    ok(card.length > 100, 'функция строк характеристик найдена');
    const notBonus = new Set(['id', 'name', 'slot', 'img', 'rarity', 'classItem', 'forClass',
      'stackable', 'noDrop', 'qty', 'enhance', 'buffType', 'buffDur', 'buffDesc',
      'price', 'sell', 'desc', 'eid', 'shardOf', 'setId']);
    const seen = new Set();
    for (const d of ITEM_DEF) {
      for (const [k, v] of Object.entries(d)) {
        if (notBonus.has(k) || typeof v !== 'number' || !v) continue;
        seen.add(k);
      }
    }
    const missing = [...seen].filter(k => !card.includes('it.' + k));
    ok(missing.length === 0,
      `карточка показывает все ${seen.size} видов бонусов из каталога`,
      'не показываются: ' + missing.join(', '));
  }

  // ── клиент считает по тем же полям, что и сервер ─────────────────────────
  // Один и тот же неполный список из семи полей жил в ТРЁХ местах: в цикле
  // характеристик сервера, в цикле клиента и в карточке предмета. Крылья
  // считались на сервере и не значили на экране ничего — а бегает клиент,
  // поэтому скорость не менялась вовсе: «так же бегает, не работают эти %».
  //
  // Правило: каждое числовое поле каталога, которое читает серверный цикл,
  // обязан читать и клиентский.
  {
    const fs3 = require('fs');
    const srv = fs3.readFileSync(path.join(ROOT, 'server', 'db', 'repos', 'stats.js'), 'utf8');
    const cli = fs3.readFileSync(path.join(ROOT, 'js', 'player.js'), 'utf8');
    const cut = (src, from, len) => { const at = src.indexOf(from); return at < 0 ? '' : src.slice(at, at + len); };
    const srvLoop = cut(srv, 'for (const it of (row.equipped', 1400);
    const cliLoop = cut(cli, 'Object.values(player.equipment).forEach', 1400);
    ok(srvLoop.length > 100 && cliLoop.length > 100, 'оба цикла по надетому найдены');
    // Два поля клиенту не нужны, и это РЕШЕНИЕ, а не дыра: опыт и шанс дропа
    // — не характеристики персонажа, а добыча. Их применяет путь награды за
    // убийство на сервере, рядом с бонусами VIP и клана; клиент добычу не
    // считает вовсе и посчитать не должен.
    //
    // Список назван здесь поимённо, чтобы следующее новое поле пришлось либо
    // прочитать на клиенте, либо осознанно внести сюда.
    const SERVER_ONLY = new Set(['xpPct', 'dropPct']);
    const fields = [...srvLoop.matchAll(/base\.(\w+)/g)].map(m => m[1]);
    const uniq = [...new Set(fields)].filter(f => !SERVER_ONLY.has(f));
    const missing = uniq.filter(f => !cliLoop.includes('it.' + f));
    ok(missing.length === 0,
      `клиент читает все ${uniq.length} боевых полей, что и сервер`,
      'клиент не читает: ' + missing.join(', '));
  }

  // ── и потолок скорости знает про предметы ────────────────────────────────
  // Он выводился как «самый быстрый класс × максимальная пассивка», с прямой
  // оговоркой «предметы скорость не трогают». Крылья сделали её неправдой:
  // игрок в легендарных бежал бы выше потолка, и защита от читеров нашла бы
  // ЕГО.
  {
    const D2 = require(path.join(ROOT, 'shared', 'definitions'));
    const fs4 = require('fs');
    const room = fs4.readFileSync(path.join(ROOT, 'server', 'game', 'Room.js'), 'utf8');
    const itemMax = Math.max(0, ...D2.ITEM_DEF.map(d => d.speedPct || 0));
    ok(itemMax > 0, `в каталоге есть предмет со скоростью бега (+${itemMax * 100}%)`);
    ok(room.includes('_MOVE_SPEED_ITEM_MAX'),
      'потолок скорости учитывает самый быстрый предмет');
    ok(!/applies exactly these two factors and nothing else/.test(room),
      'и больше не утверждает, что предметы скорость не трогают');
  }

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
  process.exitCode = fail ? 1 : 0;
}

main();
