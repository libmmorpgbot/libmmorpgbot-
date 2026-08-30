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
//    Обе проверены по ПРЕЖНЕЙ сборке: там ровно то же самое. Воскрешение
//    всегда лечило полностью (её собственный комментарий: «respawnPlayer sets
//    hp = maxHp»), а штрафа за смерть не было НИГДЕ — только всплывающая
//    строка о нём. Это не поломка порта, это надпись, которая врала с самого
//    начала, и убрана именно надпись.
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

// ── 2. надписи не обещают того, чего нет ───────────────────────────────────
console.log('\n  ── надписи о смерти ──');
{
  const i18n = fs.readFileSync(path.join(ROOT, 'js/i18n.js'), 'utf8');
  const line = i18n.match(/deathRespawn: \{[^}]*\}/);
  ok(!!line && !/10% HP/.test(line[0]),
    'кнопка воскрешения не обещает 10% HP', line && line[0].slice(0, 70));

  // Сервер лечит полностью — именно это теперь и написано.
  const w = fs.readFileSync(path.join(ROOT, 'server/handlers2/world.js'), 'utf8');
  ok(/players\.setHp\(t, pid, st\.maxHp\)/.test(w), 'сервер и правда лечит полностью');

  // Штраф за смерть: строки о нём быть не должно, пока нет самого штрафа.
  ok(!/t\('deathXpPenalty'\)/.test(game), 'нет всплывающей строки про −50% XP');
  // И контроль: если штраф КОГДА-НИБУДЬ появится, эта строка напомнит вернуть
  // надпись. Ищется реальное применение, а не упоминание в тексте.
  const srv = ['server/handlers2/world.js', 'server/db/repos/players.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const hasPenalty = /deathPenalty|xpPenaltyUntil|DEATH_XP_PENALTY/.test(srv);
  ok(!hasPenalty, 'штрафа за опыт действительно нет — значит и обещать нечего');
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
