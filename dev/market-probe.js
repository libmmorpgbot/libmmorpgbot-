'use strict';
// One-off: why can nobody buy listing 229?
const { tx, close } = require('../server/db');
const market = require('../server/db/repos/market');

(async () => {
  console.log('\n── що бачить покупець у browse ──');
  const list = await market.browse(null, {});
  console.log(JSON.stringify(list, null, 2).slice(0, 900));

  console.log('\n── що бачить продавець у mine ──');
  const mine = await market.mine(null, 1307);
  console.log(JSON.stringify(mine, null, 2).slice(0, 600));

  console.log('\n── спроба покупки (у транзакції, з відкотом) ──');
  try {
    await tx(async (t) => {
      const res = await market.buy(t, 1309, 229);
      console.log('  УСПІХ:', JSON.stringify(res).slice(0, 300));
      throw Object.assign(new Error('rollback'), { _rollback: true });
    });
  } catch (e) {
    if (e._rollback) console.log('  (відкочено навмисно — покупка би пройшла)');
    else console.log('  ПОМИЛКА:', e.code || '-', '|', e.message, '|', e.userMessage || '');
  }
  await close();
})().catch(e => { console.error(e); process.exit(1); });
