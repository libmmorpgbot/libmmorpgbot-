#!/usr/bin/env node
'use strict';
// ── «хранилище клана закрыто», хотя оно открыто ────────────────────────────
//
//   node dev/gwstorage-check.js
//
// Раз в час клан-владелец замка получает осколки (_gwGrantIncome, server/game/
// guildwar.js), и всем его участникам в сети рассылается свежее хранилище.
// Рассылка слала СВОЮ урезанную копию пакета — { storageUnlocked, storage }, —
// а клиент (_clanStorageHTML, js/clans.js) читает `unlocked` и заменяет пакетом
// всё состояние вкладки. Итог: у открытого хранилища вкладка писала «закрыто»,
// пока игрок не переоткрывал клан.
//
// Проверка гоняет настоящий модуль с подменёнными зависимостями и смотрит на
// то, что ушло в сокет. Без базы. Красная на коде до исправления.

const createGuildWar = require('../server/game/guildwar');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  console.log('\ngwstorage-check');
  const sent = [];
  let incomeCb = null;
  // Полный вид — то, что clanStorageSync отдаёт каждому участнику.
  const FULL = pid => ({ unlocked: true, canUse: true, isLeader: pid === 1, unlockCost: 0,
    storage: [{ id: 'shard_gold', qty: 3 }], allocations: [], members: [] });
  const gw = createGuildWar({
    io: { emit() {} }, playerFloorMap: new Map(),
    _socketForTelegramId: tid => ({ emit: (ev, d) => sent.push({ tid, ev, d }) }),
    notifyEventSoon() {}, broadcastLeadMs: 0, notifyEventStarted() {},
    safeTimeout: (name, fn) => { if (name === 'gwIncome') incomeCb = fn; return 0; },
    loadCastle: async () => null, saveCastle: async () => {},
    grantClanStorage: async () => {},
    clanForStorage: async id => ({ _id: id, storageUnlocked: true, storage: [],
      members: [{ telegramId: 't1', playerId: 1 }, { telegramId: 't2', playerId: 2 }] }),
    clanStorageViewFor: async (clanId, pid) => FULL(pid),
  });
  gw._gw.ownerClanId = 7;
  gw._gwIncomeSchedule();
  ok(typeof incomeCb === 'function', 'доход с замка поставлен в расписание');
  if (incomeCb) incomeCb();
  await new Promise(r => setTimeout(r, 100));

  const pushes = sent.filter(s => s.ev === 'clanStorage');
  ok(pushes.length === 2, `хранилище разослано обоим участникам в сети (${pushes.length})`);
  ok(pushes.every(p => p.d && p.d.unlocked === true),
    'в пакете поле `unlocked` — то, что читает клиент; открытое хранилище не показывается закрытым',
    JSON.stringify(pushes[0] && pushes[0].d));
  ok(pushes.every(p => p.d && 'canUse' in p.d && 'isLeader' in p.d && Array.isArray(p.d.allocations)),
    'пакет полный, как у clanStorageSync — вкладка не теряет права и раздачи');
  const t1 = pushes.find(p => p.tid === 't1'), t2 = pushes.find(p => p.tid === 't2');
  ok(!!(t1 && t2 && t1.d.isLeader === true && t2.d.isLeader === false),
    'вид у каждого свой: лидер видит себя лидером, участник — участником');

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  process.exit(fail ? 1 : 0);
})();
