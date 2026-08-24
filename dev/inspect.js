'use strict';
// One-off: dump everything the game knows about the two live testers.
const { query, close } = require('../server/db');

const P = '$1';
(async () => {
  const ids = ['1199957588', '8868342638'];
  for (const tg of ids) {
    const p = (await query(null,
      `SELECT p.id, p.username, g.* FROM players p
         LEFT JOIN player_progress g ON g.player_id = p.id
        WHERE p.telegram_id = ${P}`, [tg])).rows[0];
    if (!p) { console.log(tg, 'NOT FOUND'); continue; }
    console.log('\n======', p.username, 'tg', tg, 'id', p.id, '======');
    console.log('lvl', p.lvl, 'xp', p.xp, 'class', p.char_class, 'floor', p.floor, 'x', p.x, 'y', p.y);
    console.log('questIdx', p.quest_idx, 'questKills', JSON.stringify(p.quest_kills));
    console.log('potionBag', JSON.stringify(p.potion_bag), 'buffs', JSON.stringify(p.buffs));
    console.log('bonusSP', p.bonus_sp, 'keptSP', p.kept_sp, 'upgrades', JSON.stringify(p.upgrades));
    console.log('codex', JSON.stringify(p.codex));
    const sk = (await query(null,
      `SELECT kind, key, level FROM player_skills WHERE player_id = ${P} ORDER BY kind, key`,
      [p.id])).rows;
    console.log('skills:', sk.map(r => `${r.kind}/${r.key}=${r.level}`).join(' ') || '(none)');
    const b = (await query(null,
      `SELECT currency, amount FROM balances WHERE player_id = ${P}`, [p.id])).rows;
    console.log('balances:', b.map(r => `${r.currency}=${r.amount}`).join(' '));
    const vip = (await query(null,
      `SELECT * FROM player_vip WHERE player_id = ${P}`, [p.id])).rows[0];
    console.log('vip row:', vip ? JSON.stringify(vip) : '(none)');
    const inv = (await query(null,
      `SELECT id, qty, enhance, container FROM player_items
        WHERE player_id = ${P} ORDER BY container, id`, [p.id])).rows;
    console.log('items:', inv.length,
      inv.map(r => `${r.container}:${r.id}${r.enhance ? '+' + r.enhance : ''}x${r.qty}`).join(' '));
  }
  await close();
})().catch(e => { console.error(e); process.exit(1); });
