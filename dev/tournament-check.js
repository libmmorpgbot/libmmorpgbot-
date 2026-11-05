#!/usr/bin/env node
'use strict';
// ── турнир на 32: сетка сходится ─────────────────────────────────────────────
//
//   node dev/tournament-check.js
//
// Сетка турнира — не общий алгоритм на N игроков, а расписанная руками по
// раундам (_trBuildRoundGroups / _trApplyRoundResults, server/game/
// tournament.js). Поэтому размер нельзя менять одной константой: у 16 и у 32
// разное число раундов и разные «придержанные» группы проигравших.
//
// Проверка вынимает эти функции из настоящего файла и гоняет 2000 турниров со
// случайными исходами: в каждом раунде все бьются парами (никто не остаётся
// без пары), каждый ровно один раз проигрывает в нижней сетке или доходит до
// финала, чемпион один, вылетели все остальные. Красная на коде с сеткой на 16.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TOURNAMENT_SIZE } = require('../shared/definitions');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('\ntournament-check');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'game', 'tournament.js'), 'utf8');
function fn(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  return null;
}
const total = Number((src.match(/const TOURNAMENT_TOTAL_ROUNDS = (\d+);/) || [])[1]);

ok(TOURNAMENT_SIZE === 32, 'в турнире 32 участника', `TOURNAMENT_SIZE = ${TOURNAMENT_SIZE}`);
ok(total === 10, 'сетка на 32 — это 10 раундов', `TOURNAMENT_TOTAL_ROUNDS = ${total}`);

const names = ['_shuffle', '_pairAll', '_trBuildRoundGroups', '_winnersLosersOf', '_trApplyRoundResults'];
const bodies = names.map(fn);
ok(bodies.every(Boolean), 'функции сетки на месте', names.filter((_, i) => !bodies[i]).join(', '));

let bad = null;
const RUNS = 2000;
for (let run = 0; run < RUNS && !bad && bodies.every(Boolean); run++) {
  const eliminated = [];
  let champion = null, runnerUp = null;
  const ctx = {
    Math,
    _tr: {
      ubPool: Array.from({ length: TOURNAMENT_SIZE }, (_, i) => 'p' + i), lbPool: [],
      dropFromUB3: [], dropFromUB4: [],
      ubChampion: null, ubFinalLoser: null, lbSemiSurvivor: null, lbChampion: null,
      matchTag: new Map(), roundResults: new Map(),
    },
    _trEliminateList: list => eliminated.push(...list),
    _trFinishTournament: (c, r) => { champion = c; runnerUp = r; },
  };
  vm.createContext(ctx);
  vm.runInContext(bodies.join('\n'), ctx);
  const losses = new Map();
  for (let idx = 1; idx <= total; idx++) {
    const groups = ctx._trBuildRoundGroups(idx);
    const tr = ctx._tr;
    tr.matchTag.clear(); tr.roundResults.clear();
    const inRound = new Set();
    // Сколько было в пулах перед раундом — все они должны получить пару.
    const pools = { ub: tr.ubPool.length, lb: tr.lbPool.length };
    for (const g of groups) for (const [a, b] of g.pairs) {
      if (inRound.has(a) || inRound.has(b)) { bad = `раунд ${idx}: игрок в двух парах`; break; }
      inRound.add(a); inRound.add(b);
      tr.matchTag.set(a, g.tag); tr.matchTag.set(b, g.tag);
      const [w, l] = Math.random() < 0.5 ? [a, b] : [b, a];
      tr.roundResults.set(l, w);
      losses.set(l, (losses.get(l) || 0) + 1);
    }
    if (bad) break;
    if (groups.some(g => g.pairs.length === 0)) { bad = `раунд ${idx}: пустая группа`; break; }
    const pooled = groups.some(g => g.tag === 'ub' || g.tag === 'ubFinal') ? pools.ub : 0;
    const lbPooled = groups.some(g => g.tag === 'lb' || g.tag === 'lbSemi') ? pools.lb : 0;
    if (pooled % 2 || lbPooled % 2) { bad = `раунд ${idx}: нечётный пул (ub ${pools.ub}, lb ${pools.lb})`; break; }
    ctx._trApplyRoundResults(idx);
  }
  if (bad) break;
  if (!champion) bad = 'нет чемпиона';
  else if (eliminated.length !== TOURNAMENT_SIZE - 2) bad = `вылетело ${eliminated.length}, а не ${TOURNAMENT_SIZE - 2}`;
  else if (new Set(eliminated).size !== eliminated.length) bad = 'кто-то вылетел дважды';
  else if (eliminated.includes(champion) || eliminated.includes(runnerUp)) bad = 'финалист среди вылетевших';
  else if ([...losses.values()].some(n => n > 2)) bad = 'кто-то проиграл больше двух раз';
  else if (eliminated.some(p => (losses.get(p) || 0) < 2)) {
    // Выбывают только со второго поражения — кроме проигравшего в гранд-финале.
    bad = 'кто-то вылетел после первого же поражения';
  }
}
ok(!bad && bodies.every(Boolean), `${RUNS} случайных турниров на ${TOURNAMENT_SIZE}: все в парах, один чемпион, остальные вылетели после двух поражений`, bad || '');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
process.exit(fail ? 1 : 0);
