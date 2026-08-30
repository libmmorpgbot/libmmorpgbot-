#!/usr/bin/env node
'use strict';
// ── Смерть, удары и дроп: что обещано против того, что происходит ───────────
//
//   node dev/death-drop-check.js
//
// Три жалобы, и они разного рода — поэтому и ответы разные.
//
// 1. «Пишется, что возродиться с 10%, но по факту стоишь со 100%»
// 2. «Опыт при смерти не уменьшался на 5 мин»
//
//    Обе надписи стояли в игре с самого начала и не значили ничего: и здесь, и
//    в ПРЕЖНЕЙ сборке воскрешение лечило полностью, а штрафа за опыт не было
//    нигде — только всплывающая строка о нём.
//
//    Владелец решил: «штраф за смерть опыта на 5 мин должен работать, и
//    спавниться только с 10% хп». Теперь оба обещания настоящие, и здесь
//    проверяется, что текст и поведение берут ОДНИ И ТЕ ЖЕ числа — разошлись
//    они в прошлый раз именно потому, что жили в разных файлах.
//
//    Живое доказательство отдельно, в dev/play-check.js: настоящая смерть
//    через сокет, 10% в базе, срок штрафа и половина опыта на выходе.
//
// 3. «Бью, отхожу, снова бью — не каждый удар регает»
//
//    А это настоящая поломка. Удар отправляется на восьмом кадре анимации, а
//    ключ анимации содержит НАПРАВЛЕНИЕ ('frontright-attack' — у Рыцаря Смерти
//    их восемь). Повернулся посреди замаха — ключ сменился, счётчик кадров
//    сбросился в ноль, до восьмого кадра дело не дошло. Замах был, звук был,
//    урона не было.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');

// ── 1. поворот не отменяет удар ────────────────────────────────────────────
console.log('\n  ── удар переживает поворот ──');
{
  // Правило воспроизводится ровно тем выражением, что стоит в коде.
  const act = (k) => k.slice(k.indexOf('-') + 1);
  ok(act('frontright-attack') === act('front-attack'),
    'поворот во время замаха — то же действие');
  ok(act('front-attack') !== act('front-run'), 'а замах и бег — разные');
  ok(act('front-run') !== act('front-idle'), 'бег и покой — разные');
  ok(act('die') === 'die', 'смерть остаётся отдельным действием');

  // И что в коде стоит именно оно, а не сравнение целых ключей.
  ok(!/if \(ak !== player\._lastAnimKey\)/.test(game),
    'сброс кадра больше не срабатывает на смену направления');
  ok(/const _act = ak\.slice\(ak\.indexOf\('-'\) \+ 1\)/.test(game),
    'сравнивается действие');
  ok(/if \(_act !== _prevAct\) \{ player\.animFrame = 0/.test(game),
    'и кадр сбрасывается только по нему');
  // Чужие персонажи — то же самое, иначе их замах дёргается при повороте.
  ok(/const _oAct = ak\.slice\(ak\.indexOf\('-'\) \+ 1\)/.test(game),
    'у чужих персонажей правило то же');

  // Кадр, на котором уходит удар, должен существовать в анимации.
  const spr = fs.readFileSync(path.join(ROOT, 'js/sprites.js'), 'utf8');
  const gate = game.match(/player\.animFrame >= (\d+)/);
  ok(!!gate, 'кадр отправки удара найден в коде', gate && gate[1]);
  const frames = [...spr.matchAll(/'[a-z]+-attack':\s*\{[^}]*?n:\s*(\d+)/g)].map(m => Number(m[1]));
  ok(frames.length > 0, `анимации атаки найдены (${frames.length})`);
  const minF = Math.min(...frames);
  ok(minF > Number(gate[1]),
    `самая короткая анимация атаки длиннее кадра отправки (${minF} > ${gate[1]})`,
    `${minF} кадров — удар не дойдёт до ${gate[1]}-го НИКОГДА`);
}

// ── 2. цена смерти: надписи и поведение сходятся ───────────────────────────
// «Штраф за смерть опыта на 5 мин должен работать, и спавниться только с 10% хп.»
//
// До этого обе надписи стояли в игре и не значили ничего: воскрешение лечило
// полностью, а штрафа не существовало ни здесь, ни в прежней сборке. Владелец
// решил, что обещание должно стать правдой.
//
// Проверяется не совпадение двух текстов, а то, что и текст, и поведение
// берут ОДНИ И ТЕ ЖЕ числа: разошлись они в прошлый раз именно потому, что
// надпись жила в i18n, а поведение — отдельно, и сверить их было нечем.
console.log('\n  ── цена смерти ──');
{
  const D = require('../shared/definitions');
  const i18n = fs.readFileSync(path.join(ROOT, 'js/i18n.js'), 'utf8');
  const w = fs.readFileSync(path.join(ROOT, 'server/handlers2/world.js'), 'utf8');

  // ── правило, по которому считается опыт ──────────────────────────────────
  const now = 1000000;
  ok(D.xpAfterDeathPenalty(100, 0, now) === 100, 'без штрафа опыт целый');
  ok(D.xpAfterDeathPenalty(100, now + 1, now) === 50, 'под штрафом — половина');
  ok(D.xpAfterDeathPenalty(100, now, now) === 100, 'ровно в момент истечения штрафа уже нет');
  ok(D.xpAfterDeathPenalty(100, now - 1, now) === 100, 'после истечения — целый');
  ok(D.xpAfterDeathPenalty(1, now + 1, now) === 0, 'один опыт под штрафом округляется вниз');
  ok(D.xpAfterDeathPenalty(0, now + 1, now) === 0, 'ноль остаётся нулём');
  ok(D.DEATH_XP_PENALTY_SEC === 300, `штраф длится 5 минут (${D.DEATH_XP_PENALTY_SEC} с)`);
  ok(D.DEATH_XP_PENALTY_PCT === 50, `и режет половину (${D.DEATH_XP_PENALTY_PCT}%)`);
  ok(D.RESPAWN_HP_PCT === 10, `воскрешение даёт 10% (${D.RESPAWN_HP_PCT}%)`);

  // ── надпись называет ровно те числа, по которым считает код ──────────────
  const btn = i18n.match(/deathRespawn: \{[^}]*\}/);
  ok(!!btn && btn[0].includes(D.RESPAWN_HP_PCT + '% HP'),
    'кнопка называет тот же процент, что и сервер', btn && btn[0].slice(0, 60));
  const line = i18n.match(/deathXpPenaltyLine: \{[^}]*\}/);
  ok(!!line && line[0].includes('−' + D.DEATH_XP_PENALTY_PCT + '% опыта')
     && line[0].includes((D.DEATH_XP_PENALTY_SEC / 60) + ' минут'),
    'экран смерти называет те же проценты и минуты', line && line[0].slice(0, 70));
  ok(/t\('deathXpPenalty'\)/.test(game), 'всплывающая строка о штрафе показывается');

  // ── сервер делает то, что обещано ────────────────────────────────────────
  ok(!/players\.setHp\(t, pid, st\.maxHp\)/.test(w),
    'воскрешение больше НЕ лечит полностью');
  ok(/st\.maxHp \* RESPAWN_HP_PCT \/ 100/.test(w),
    'оно считает процент из общей константы, а не из своего числа');
  ok(/Math\.max\(1, Math\.floor\(st\.maxHp \* RESPAWN_HP_PCT/.test(w),
    'и не может воскресить в мёртвого: минимум единица');
  ok(/DEATH_XP_PENALTY_SEC \* 1000/.test(w) && /DEATH_XP_PENALTY_KEY/.test(w),
    'воскрешение ставит срок штрафа');
  ok(/s\.room\.setPlayerHp\(s\.socket\.id, hp\)/.test(w),
    'в комнате столько же, сколько в базе — иначе разойдутся снова');

  // ── штраф стоит там, где опыт вообще становится опытом ───────────────────
  const pl = fs.readFileSync(path.join(ROOT, 'server/db/repos/players.js'), 'utf8');
  ok(/xpAfterDeathPenalty\(amt, _until, Date\.now\(\)\)/.test(pl),
    'grantXp применяет штраф — одна точка на убийство, долю группы и квесты');
  ok(/SELECT lvl, xp, buffs FROM player_progress WHERE player_id = \$1 FOR UPDATE/.test(pl),
    'срок читается из строки, уже взятой под блокировку — без лишнего запроса');
  ok(/let xp = Number\(cur\[0\]\.xp\) \+ granted;/.test(pl),
    'к уровню прибавляется УРЕЗАННОЕ число, а не исходное');
  ok(/granted, penalty, penaltyUntil/.test(pl),
    'и наружу отдаётся, сколько дошло на самом деле');

  // ── и игроку показывают то же число ──────────────────────────────────────
  // Не по написанию, а по правилу: строка `xp:` в пакете обязана брать число
  // из granted. Первый заход проверял точный отступ и покраснел на скобке.
  const xpLines = w.split('\n').filter(l => /^\s*xp: /.test(l));
  ok(xpLines.length === 2, `строк «xp:» в пакетах убийства две (${xpLines.length})`);
  ok(xpLines.every(l => l.includes('.granted')),
    'обе берут число из granted — то есть то, что дошло',
    xpLines.map(l => l.trim().slice(0, 50)).join(' | '));
  // Отдельного поля «это штраф» в пакете нет намеренно: читать его некому.
  // Значок «−XP N мин» ставит событие respawn, восстанавливает вход, а
  // истечение отсчитывает кадровый цикл — лишнее поле в самом частом пакете
  // игры это байты на каждом убийстве ради ничего.
  ok(!/xpPenalty:/.test(w), 'в пакете убийства нет поля, которое некому читать');

  // ── значок на экране переживает перезаход ────────────────────────────────
  const net = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
  const ply = fs.readFileSync(path.join(ROOT, 'js/player.js'), 'utf8');
  ok(/socket\.on\('deathPenalty'/.test(net), 'клиент слушает срок от сервера');
  ok(/_xpLeft > 0\) player\.buffs\.deathPenalty = _xpLeft/.test(ply),
    'при входе значок восстанавливается из сохранённого срока');
  ok(/delete player\.buffs\.xpPenalty/.test(net) && /delete player\.buffs\.xpPenalty/.test(ply),
    'серверный ключ не остаётся в карте бафов лишним хвостом');
}

// ── 3. дроп: числа те же, что в прежней сборке ─────────────────────────────
// «Дроп поперевіряй, є здогадки що не працює». Проверено сравнением с
// F:\\a Projects\\old_version_liberty_mmorpg: формулы и константы совпадают
// побайтно. Здесь стережётся то, что делает зелёные вещи такими редкими, —
// чтобы в следующий раз об этом спорили с числом.
console.log('\n  ── дроп ──');
{
  const D = require('../shared/definitions');
  const loot = require('../server/game/loot');

  // Зелёный ярус НАМЕРЕННО прижат: множитель 0.1 поверх кривой.
  const SLOTS = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
  for (const lvl of [5, 15, 30]) {
    const r = D.itemRarityForLevel(lvl);
    const n = D.ITEM_DEF.filter(x => x.rarity === r && !x.noDrop && SLOTS.includes(x.slot)).length;
    ok(n > 0, `для уровня ${lvl} (${r}) в каталоге есть что уронить (${n})`);
  }

  // Сколько это на самом деле. Не утверждение о том, что так ПРАВИЛЬНО, а
  // измерение того, что так ЕСТЬ.
  const N = 200000;
  for (const [plvl, mlvl] of [[15, 15], [30, 15], [35, 35]]) {
    let gear = 0;
    for (let i = 0; i < N; i++) {
      for (const it of loot._rollMobLoot([], 'imp', mlvl, plvl) || []) {
        if (D.ITEM_DEF.some(d => d.id === it.id && SLOTS.includes(d.slot))) gear++;
      }
    }
    const per = gear ? Math.round(N / gear) : Infinity;
    console.log(`      игрок ${plvl} лвл на мобе ${mlvl}: снаряжение раз в ` +
      (per === Infinity ? '— (ни разу за ' + N + ')' : per + ' убийств'));
  }
  ok(D.dropLevelGapDivisor(30, 15) > 1,
    `разрыв уровней режет дроп (делитель ${D.dropLevelGapDivisor(30, 15)})`);
  ok(D.FARM2_LIBERTY_CHANCE > 0,
    `Liberty в элитной зоне вообще может выпасть (${D.FARM2_LIBERTY_CHANCE * 100}% за убийство)`);
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
  : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
