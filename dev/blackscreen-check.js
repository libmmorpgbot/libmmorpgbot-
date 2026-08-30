#!/usr/bin/env node
'use strict';
// ── Чёрный экран: отчёт о нём обязан доходить ───────────────────────────────
//
//   DATABASE_URL=... node dev/blackscreen-check.js
//
// «Захожу, грузит, и потом всё чёрное. Просто кнопка портала в зал стоит и всё.»
//
// У клиента для этого есть сторож (_worldWatchdog, js/game.js): он определяет
// причину, собирает числа и присылает отчёт. За сутки в боевом журнале:
//
//   world-blank:no-renderer — экран #x# @#.# · canvas #x# · pixi мёртв · кар ×1
//
// «×1» — это счётчик ЗАГЛУШЁННЫХ. Отчёт пришёл и был выброшен фильтром шума,
// который я же и написал под «вирубай логування». Правило «кадр 8358мс назад»
// задумывалось про свёрнутую вкладку, но у МЁРТВОГО рендерера кадр старый
// всегда — рисовать некому, — и оно поймало ровно тот случай, ради которого
// сторож существует.
//
// Проверка гоняет фильтр на НАСТОЯЩИХ строках из журнала: и на тех, что должны
// глушиться, и на тех, что не имеют права.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.OPS_LIVE = '0';
process.env.PORT = process.env.PORT || '3187';

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

// require() регистрирует маршруты, boot() не зовётся — ни воркеров, ни сокета.
const { _isClientNoise } = require('../server/app');

// ── строки взяты из журнала как есть ────────────────────────────────────────
// Числа настоящие, порядок полей — тот, что собирает _worldFacts.
const FACTS = (alive, frameMs) =>
  `экран 412x915 @2.00 · canvas 412x915 · pixi ${alive ? 'жив' : 'мёртв'}`
  + ` · карта 218x58 эт.12 · сетка 58x218 · чанки 0/0 · кадр ${frameMs}мс назад`;

const CASES = [
  // ── это ДОЛЖНО доходить ──────────────────────────────────────────────────
  ['world-blank', 'no-renderer — ' + FACTS(false, 8358), false,
    'мёртвый рендерер — это и есть чёрный экран'],
  ['world-blank', 'no-canvas — ' + FACTS(false, 12000), false,
    'холста нет вовсе'],
  ['pixi-init', 'контекст терял 3, вернул 0 · ' + FACTS(false, 9000), false,
    'контекст потерян и НЕ вернулся'],
  ['world-blank', 'no-tiles — ' + FACTS(true, 40), false,
    'карта есть, тайлы не построились'],
  ['world-blank', 'nothing-drawn — ' + FACTS(true, 30), false,
    'всё на месте, а GPU ничего не дали'],
  ['js', 'TypeError: Cannot read properties of undefined (reading \'grid\')', false,
    'обычная ошибка клиента'],

  // ── а это шум, и глушится по-прежнему ────────────────────────────────────
  ['world-blank', 'not-rendering — ' + FACTS(true, 9100), true,
    'живой рендерер и старый кадр — вкладку заморозили'],
  ['pixi-init', 'контекст терял 1, вернул 1 · ' + FACTS(true, 5000), true,
    'контекст потерян и возвращён'],
  ['connect', 'timeout', true, 'обрыв связи у игрока'],
  ['connect', 'websocket error', true, 'то же самое'],
  ['admin:api', 'GET /admin/stats: Failed to fetch', true, 'у телефона админа пропала сеть'],
  ['js', 'Uncaught SyntaxError: Unexpected end of input', true, 'бандл доехал не целиком'],
  ['frame', "Failed to execute 'arc' on 'CanvasRenderingContext2D': The radius provided (-1.5) is negative.", true,
    'нулевой экран у свёрнутого приложения'],
  ['world-blank', 'zero-viewport — экран 0x0 @2.00 · canvas 0x0 · pixi жив', true,
    'экран нулевого размера'],
];

console.log('\n  ── что доходит до операторов, а что нет ──');
for (const [where, msg, wantNoise, why] of CASES) {
  const got = _isClientNoise(where, msg);
  ok(got === wantNoise,
    (wantNoise ? 'глушится: ' : 'ДОХОДИТ:  ') + why,
    `${where}: ${msg.slice(0, 60)} → ${got ? 'заглушено' : 'дошло'}`);
}

// ── и то, из чего сторож собирает отчёт, никуда не делось ──────────────────
// Правила выше опознают чёрный экран по словам «pixi мёртв» и по названию
// причины. Если клиент когда-нибудь переименует их, фильтр снова начнёт
// глушить то, что глушить нельзя, — и молча.
console.log('\n  ── слова, по которым это узнаётся ──');
{
  const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
  ok(/'pixi ' \+ \(pixiAlive\(\) \? 'жив' : 'мёртв'\)/.test(game),
    'клиент по-прежнему пишет «pixi жив/мёртв»');
  ok(/return 'no-renderer'/.test(game), 'причина no-renderer на месте');
  ok(/return 'no-canvas'/.test(game), 'причина no-canvas на месте');
  ok(/__reportClientError\('world-blank', why \+ ' — ' \+ facts\)/.test(game),
    'отчёт по-прежнему начинается с причины');
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
  : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
