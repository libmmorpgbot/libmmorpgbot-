// ═══════════════════════════════════════════════════════════════════════════
//  skillcd-check — серверная таблица перезарядок совпадает с клиентской
// ═══════════════════════════════════════════════════════════════════════════
//   node dev/skillcd-check.js
//
// SKILL_CD_SEC (shared/definitions.js) — копия cd из SKILL_DEF/ADV_SKILL_DEF
// (js/definitions.js), по которой сервер отказывает касту раньше срока.
// Разойдутся — честный игрок упрётся в отказ или взломанный получит лишнее.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const D = require('../shared/definitions');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } };

const ctx = vm.createContext({ console });
// Как в браузере: общий файл первым, клиентский — поверх его глобалов.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'definitions.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'definitions.js'), 'utf8')
  + '\n;this.SKILL_DEF = SKILL_DEF; this.ADV_SKILL_DEF = ADV_SKILL_DEF;', ctx);

for (const cls of Object.keys(D.CHAR_DEF)) {
  for (const [i, table] of [[0, ctx.SKILL_DEF], [1, ctx.ADV_SKILL_DEF]]) {
    for (const sk of table[cls] || []) {
      const want = D.SKILL_CD_SEC[cls] && D.SKILL_CD_SEC[cls][sk.key] && D.SKILL_CD_SEC[cls][sk.key][i];
      ok(want === sk.cd, `${cls} ${sk.key} ${i ? 'adv' : 'base'}: cd ${sk.cd} = ${want}`);
    }
  }
}
// Нижняя граница всегда меньше самой короткой честной перезарядки.
ok(D.skillCooldownFloorMs('mage', 'Q', true, 10) < 5000 * (1 - 0.2), 'порог ниже перезарядки с максимальным сокращением');
ok(D.skillCooldownFloorMs('runefighter', 'W', false, 10) === Math.floor(6000 * 0.8 * 0.9), 'уровневое сокращение учитывается');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
process.exit(fail ? 1 : 0);
