'use strict';
const { query, close } = require('../server/db');
(async () => {
  const a = (await query(null, 'SELECT count(*)::int n FROM player_items WHERE player_id IS NULL')).rows[0].n;
  const b = (await query(null, `SELECT count(*)::int n FROM player_items pi
      WHERE pi.player_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM market_listings m WHERE m.item_id = pi.id AND m.status = 'active')`)).rows[0].n;
  console.log('orphan rows (player_id IS NULL):', a, '— of those held by NO active listing:', b);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
