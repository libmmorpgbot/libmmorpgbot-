#!/usr/bin/env node
'use strict';
// ── One-off: чи справді предмет продублювався на маркеті ────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/market-dupe-investigate.js
//
// Скарга: гравець виставив предмет («посох»), його купили, в історії
// «продано», але предмет лишився і в продавця, і з'явився у покупця.
//
// Тільки SELECT. Нічого не пише і не чіпає жодного рядка — саме тому його
// можна запускати на бойовій базі без ризику.
//
// Що робить:
//   1. шукає в каталозі всі предмети, чия назва схожа на «посох»;
//   2. для кожного — недавні угоди market_listings (status='sold'), обидві
//      сторони, коли закрилась;
//   3. для кожної такої угоди — чи тримає ПРОДАВЕЦЬ досі рядок з тим самим
//      item_id/enhance (це і є сигнатура «лишилось в обох»);
//   4. загальний інваріант з dev/market-check.js, але на живих даних: чи є
//      активний лот, чий предмет уже комусь належить (стан, якого схема не
//      мала б допускати);
//   5. historyOfRow-подібний зріз реєстру (item_ledger) навколо знайдених
//      угод — звідки в кожної зі сторін узявся їхній рядок.

const { pool, close } = require('../server/db');

const DAYS = Number(process.argv[2]) || 7;

function line(s = '') { console.log(s); }
function head(s) { line(`\n── ${s} ──`); }

(async () => {
  head(`каталог: предмети, схожі на «посох» (staff)`);
  const { rows: cat } = await pool().query(`
    SELECT item_id, name, rarity, slot, stackable
      FROM item_catalog
     WHERE name ILIKE '%посох%' OR name ILIKE '%staff%' OR item_id ILIKE '%staff%'
     ORDER BY item_id`);
  if (!cat.length) {
    line('  нічого не знайдено за назвою — можливо, предмет називається інакше.');
    line('  Наступний блок все одно перевіряє інваріант по ВСЬОМУ ринку.');
  } else {
    for (const c of cat) {
      line(`  ${c.item_id.padEnd(24)} "${c.name}"  rarity=${c.rarity}  slot=${c.slot}  stackable=${c.stackable}`);
    }
  }
  const itemIds = cat.map(c => c.item_id);

  if (itemIds.length) {
    head(`останні угоди по цих предметах за ${DAYS} дн. (status='sold')`);
    const { rows: sold } = await pool().query(`
      SELECT l.id, l.seller_id, s.username AS seller, l.buyer_id, b.username AS buyer,
             l.price, l.created_at, l.closed_at, l.item_id AS live_row_id,
             COALESCE(l.snap_item_id, c.item_id) AS item_id,
             COALESCE(l.snap_enhance, 0) AS enhance, COALESCE(l.snap_qty, 1) AS qty
        FROM market_listings l
        JOIN players s ON s.id = l.seller_id
   LEFT JOIN players b ON b.id = l.buyer_id
   LEFT JOIN player_items i ON i.id = l.item_id
   LEFT JOIN item_catalog c ON c.item_id = i.item_id
       WHERE l.status = 'sold'
         AND l.closed_at >= now() - ($1 || ' days')::interval
         AND COALESCE(l.snap_item_id, c.item_id) = ANY($2)
       ORDER BY l.closed_at DESC`, [String(DAYS), itemIds]);
    if (!sold.length) {
      line(`  за останні ${DAYS} дн. продажів цих предметів не знайдено.`);
      line('  Спробуйте збільшити діапазон: node dev/market-dupe-investigate.js 30');
    }
    for (const s of sold) {
      line(`\n  лот #${s.id}  ${s.item_id} +${s.enhance} ×${s.qty}  ціна=${s.price}`);
      line(`    продавець: ${s.seller} (#${s.seller_id})   покупець: ${s.buyer || '—'} (#${s.buyer_id || '—'})`);
      line(`    виставлено: ${s.created_at}   закрито: ${s.closed_at}`);

      // ── чи тримає ПРОДАВЕЦЬ досі такий самий предмет ────────────────────
      const { rows: sellerHolds } = await pool().query(`
        SELECT id, container, qty, created_at FROM player_items
         WHERE player_id = $1 AND item_id = $2 AND enhance = $3
         ORDER BY id`, [s.seller_id, s.item_id, s.enhance]);
      if (sellerHolds.length) {
        line(`    \x1b[31m!! ПРОДАВЕЦЬ ДОСІ ТРИМАЄ ${sellerHolds.length} рядок(ів) цього предмета:\x1b[0m`);
        for (const r of sellerHolds) {
          line(`       рядок #${r.id}  container=${r.container}  qty=${r.qty}  створено=${r.created_at}`);
        }
      } else {
        line('    продавець цей предмет більше не тримає — очікувана поведінка.');
      }

      // ── скільки такого предмета тримає ПОКУПЕЦЬ ЗАРАЗ ──────────────────
      if (s.buyer_id) {
        const { rows: buyerHolds } = await pool().query(`
          SELECT id, container, qty, created_at FROM player_items
           WHERE player_id = $1 AND item_id = $2 AND enhance = $3
           ORDER BY id`, [s.buyer_id, s.item_id, s.enhance]);
        line(`    покупець тримає ${buyerHolds.length} рядок(ів) цього предмета зараз:`);
        for (const r of buyerHolds) {
          line(`       рядок #${r.id}  container=${r.container}  qty=${r.qty}  створено=${r.created_at}`);
        }

        // ── звідки взявся кожен такий рядок покупця (реєстр) ───────────────
        for (const r of buyerHolds) {
          const { rows: hist } = await pool().query(`
            SELECT delta, qty_after, reason, ref_type, ref_id, created_at
              FROM item_ledger WHERE row_id = $1 ORDER BY id`, [r.id]);
          line(`       історія рядка #${r.id}:`);
          for (const h of hist) {
            line(`         ${h.created_at}  ${h.delta > 0 ? '+' : ''}${h.delta}  ${h.reason}  ${h.ref_type || ''}${h.ref_id ? '#' + h.ref_id : ''}`);
          }
        }
      }
    }
  }

  // ── ІНВАРІАНТ: жоден активний лот не тримає предмет, який комусь належить
  head('інваріант по всьому ринку: активний лот з уже чиїмось предметом');
  const { rows: dup } = await pool().query(`
    SELECT l.id AS listing_id, l.seller_id, s.username AS seller, l.created_at,
           i.id AS row_id, i.player_id AS holder_id, h.username AS holder,
           i.item_id, i.enhance, i.qty
      FROM market_listings l
      JOIN players s ON s.id = l.seller_id
      JOIN player_items i ON i.id = l.item_id
 LEFT JOIN players h ON h.id = i.player_id
     WHERE l.status = 'active' AND i.player_id IS NOT NULL`);
  if (dup.length) {
    line(`  \x1b[31m!! ЗНАЙДЕНО ${dup.length}: активний лот, чий предмет уже комусь належить\x1b[0m`);
    for (const d of dup) {
      line(`     лот #${d.listing_id} (продавець ${d.seller}, виставлено ${d.created_at}) — ` +
        `рядок #${d.row_id} (${d.item_id} +${d.enhance} ×${d.qty}) належить ${d.holder} (#${d.holder_id})`);
    }
  } else {
    line('  чисто: жоден активний лот не тримає предмет, яким хтось уже володіє.');
  }

  // ── ІНВАРІАНТ: активний лот БЕЗ предмета (перевірка constraint'а) ──────
  head('інваріант: активні лоти, чий рядок player_items взагалі зник');
  const { rows: ghost } = await pool().query(`
    SELECT l.id, l.seller_id, s.username AS seller, l.created_at
      FROM market_listings l
      JOIN players s ON s.id = l.seller_id
 LEFT JOIN player_items i ON i.id = l.item_id
     WHERE l.status = 'active' AND i.id IS NULL`);
  if (ghost.length) {
    line(`  \x1b[31m!! ЗНАЙДЕНО ${ghost.length}: активний лот без живого рядка предмета\x1b[0m`);
    for (const g of ghost) line(`     лот #${g.id} (продавець ${g.seller}, виставлено ${g.created_at})`);
  } else {
    line('  чисто: у кожного активного лоту є живий рядок предмета.');
  }

  await close();
})().catch(e => { console.error(e); process.exit(1); });
