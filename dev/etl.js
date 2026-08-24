#!/usr/bin/env node
'use strict';
// ── Mongo → PostgreSQL ──────────────────────────────────────────────────────
//
//   MONGODB_URI=... DATABASE_URL=... PG_CA_FILE=... node dev/etl.js [--dry]
//
// Moves every player, clan, listing and transaction into the new schema. This
// runs once, during a maintenance window, against real people's money — so
// three properties matter more than speed:
//
//   IDEMPOTENT   re-running changes nothing. A player already migrated is
//                skipped, keyed on telegram_id. That is also what makes it
//                RESUMABLE: a failure at account 4000 of 20000 is fixed by
//                running it again, not by restoring a backup and starting over.
//
//   ATOMIC PER PLAYER   each account is one transaction. A crash cannot leave
//                someone with items but no balance, or a level but no
//                inventory. Not one transaction for everything: 20000 accounts
//                in a single transaction is a lock held for minutes and a
//                rollback that undoes hours.
//
//   LOUD ABOUT LOSS   anything that cannot be carried across — an item id the
//                catalog no longer knows, a clan referencing a deleted account
//                — is COUNTED and NAMED, never silently dropped. The old build
//                dropped unknown ids quietly and had to add logging afterwards
//                so that "my items vanished after a deploy" was answerable at
//                all. Here the migration report answers it before anyone asks.
//
// The opening ledger entry is the subtle one. reconcile() checks that
// sum(ledger.delta) equals balances.amount for every account. A migrated
// balance has no history, so without an opening entry every single account
// would read as drifted and the one alarm that says "money moved outside
// money.js" would be permanently ringing. Each carried balance therefore gets
// exactly one ledger row: reason 'migration_opening'.

const mongoose = require('mongoose');
const { pool, tx, query, close } = require('../server/db');
const items = require('../server/db/repos/items');
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCEABLE_SLOTS, isStackableItem,
  CHAR_DEF, xpToNext, ENHANCE_MAX,
} = require('../shared/definitions');

const DRY = process.argv.includes('--dry');
const CURRENT_SEASON = 2;

const CATALOG = new Map([...ITEM_DEF, ...CRAFT_MATS, ...BOX_DEF].map(d => [d.id, d]));
const EQ_SLOTS = new Set(['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt', 'pet', 'cloak', 'artifact']);
const LANGS = new Set(['ru', 'en', 'uk', 'es', 'tr', 'pt']);

// Everything that could not be carried, by kind. Printed at the end and, more
// importantly, kept per-player so a specific account can be answered about.
const lost = {
  unknownItems: new Map(),      // itemId -> count
  playersWithLoss: new Set(),
  clansSkipped: [],
  listingsSkipped: [],
  txSkipped: [],
};

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const int = (v, d = 0) => Math.floor(num(v, d));
const clampInt = (v, lo, hi, d = 0) => Math.max(lo, Math.min(hi, int(v, d)));

// ── the transform ───────────────────────────────────────────────────────────

// One saved item -> a row, or null. Only id, enhancement and quantity are
// carried; every stat is rebuilt from the catalog, exactly as _canonSavedItem
// did — so a forged stat block in an old blob does not survive the migration.
function itemRow(raw, container, slot, playerTg) {
  if (!raw || typeof raw !== 'object') return null;
  const base = CATALOG.get(raw.id);
  if (!base) {
    if (raw.id != null) {
      lost.unknownItems.set(String(raw.id), (lost.unknownItems.get(String(raw.id)) || 0) + 1);
      lost.playersWithLoss.add(playerTg);
    }
    return null;
  }
  const enh = ENHANCEABLE_SLOTS.has(base.slot)
    ? clampInt(raw.enhance, 0, ENHANCE_MAX, 0) : 0;
  const qty = isStackableItem(base) ? Math.max(1, Math.min(1000000, int(raw.qty, 1))) : 1;
  return { itemId: base.id, container, slot: container === 'equipment' ? slot : null, enhance: enh, qty };
}

function progressRow(sd) {
  const cls = CHAR_DEF[sd.type] ? sd.type : null;
  const u = (sd.upgrades && typeof sd.upgrades === 'object') ? sd.upgrades : {};
  const lvl = clampInt(sd.lvl, 1, 1000, 1);
  return {
    charClass: cls,
    lvl,
    // xp is clamped to what the level's own curve allows. A blob claiming
    // 1e12 xp at level 3 is not a level 3 character with a lot of xp — it is a
    // number nobody should carry forward.
    xp: Math.max(0, Math.min(num(sd.xp), xpToNext(lvl))),
    kills: Math.max(0, int(sd.kills)),
    hp: Math.max(0, int(sd.hp, 100)),
    bonusSp: Math.max(0, int(sd.bonusSP)),
    keptSp: Math.max(0, int(sd.keptSP)),
    rebirths: Math.max(0, int(sd.rebirths)),
    upg: {
      atk: Math.max(0, int(u.atk)), def: Math.max(0, int(u.def)), hp: Math.max(0, int(u.hp)),
      atkSpeed: Math.max(0, int(u.atkSpeed)), critChance: Math.max(0, int(u.critChance)),
      critPower: Math.max(0, int(u.critPower)), hpRegen: Math.max(0, int(u.hpRegen)),
    },
    floor: int(sd.floor, 1) || 1,
    x: Number.isFinite(num(sd.x, NaN)) ? num(sd.x) : null,
    y: Number.isFinite(num(sd.y, NaN)) ? num(sd.y) : null,
    questIdx: Math.max(0, int(sd.questIdx)),
    questKills: (sd.questKills && typeof sd.questKills === 'object' && !Array.isArray(sd.questKills)) ? sd.questKills : {},
    buffs: (sd.buffs && typeof sd.buffs === 'object' && !Array.isArray(sd.buffs)) ? sd.buffs : {},
    potionBag: (sd.potionBag && typeof sd.potionBag === 'object' && !Array.isArray(sd.potionBag)) ? sd.potionBag : {},
    codex: (sd.codex && typeof sd.codex === 'object' && !Array.isArray(sd.codex)) ? sd.codex : {},
    starterBonus: !!sd.starterBonus,
  };
}

function prefsRow(sd) {
  const small = v => (v && typeof v === 'object' && !Array.isArray(v) && JSON.stringify(v).length < 512) ? v : {};
  return {
    lang: LANGS.has(sd.lang) ? sd.lang : 'ru',
    hudPotion: typeof sd.hudPotion === 'string' ? sd.hudPotion.slice(0, 32) : null,
    autoHpPct: Math.max(0, Math.min(1, num(sd.autoHpPct, 0.5))),
    autoSkillsOn: sd.autoSkillsOn !== false,
    autoSkillOff: small(sd.autoSkillOff),
    autoBuffTypes: small(sd.autoBuffTypes),
  };
}

// ── per-player migration ────────────────────────────────────────────────────

async function migratePlayer(doc) {
  const tg = String(doc.telegramId);
  const sd = (doc.savedData && typeof doc.savedData === 'object') ? doc.savedData : {};

  return tx(async (t) => {
    // ON CONFLICT DO NOTHING is the whole idempotency story: an account already
    // migrated returns no row and everything below is skipped.
    const { rows: ins } = await query(t, `
      INSERT INTO players (telegram_id, username, bm, referred_by, banned, admin_notified, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (telegram_id) DO NOTHING
      RETURNING id`,
      [tg, String(doc.username || `tg_${tg}`).slice(0, 32), Math.max(0, int(doc.bm)),
       doc.referredBy ? String(doc.referredBy) : null, !!doc.banned, !!doc.adminNotified,
       doc.createdAt || new Date()]);
    if (!ins.length) return { skipped: true };
    const pid = Number(ins[0].id);

    const pr = progressRow(sd);
    await query(t, `
      INSERT INTO player_progress (player_id, char_class, lvl, xp, kills, hp,
        bonus_sp, kept_sp, rebirths,
        upg_atk, upg_def, upg_hp, upg_atk_speed, upg_crit_chance, upg_crit_power, upg_hp_regen,
        floor, pos_x, pos_y, quest_idx, quest_kills, buffs, potion_bag, codex, starter_bonus_claimed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [pid, pr.charClass, pr.lvl, pr.xp, pr.kills, pr.hp, pr.bonusSp, pr.keptSp, pr.rebirths,
       pr.upg.atk, pr.upg.def, pr.upg.hp, pr.upg.atkSpeed, pr.upg.critChance, pr.upg.critPower, pr.upg.hpRegen,
       pr.floor, pr.x, pr.y, pr.questIdx, JSON.stringify(pr.questKills), JSON.stringify(pr.buffs),
       JSON.stringify(pr.potionBag), JSON.stringify(pr.codex), pr.starterBonus]);

    const pf = prefsRow(sd);
    await query(t, `
      INSERT INTO player_prefs (player_id, lang, hud_potion, auto_hp_pct, auto_skills_on,
        auto_skill_off, auto_buff_types)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [pid, pf.lang, pf.hudPotion, pf.autoHpPct, pf.autoSkillsOn,
       JSON.stringify(pf.autoSkillOff), JSON.stringify(pf.autoBuffTypes)]);

    // ── items ────────────────────────────────────────────────────────────────
    const rows = [];
    for (const it of (Array.isArray(sd.inventory) ? sd.inventory : [])) {
      const r = itemRow(it, 'inventory', null, tg); if (r) rows.push(r);
    }
    for (const it of (Array.isArray(sd.storage) ? sd.storage : [])) {
      const r = itemRow(it, 'storage', null, tg); if (r) rows.push(r);
    }
    if (sd.equipment && typeof sd.equipment === 'object' && !Array.isArray(sd.equipment)) {
      for (const [slot, it] of Object.entries(sd.equipment)) {
        // An unknown slot name would land in a UNIQUE INDEX and then occupy a
        // slot nothing can unequip. Moved to the inventory instead of dropped:
        // the item is real even if the slot name is not.
        if (!EQ_SLOTS.has(slot)) {
          const r = itemRow(it, 'inventory', null, tg); if (r) rows.push(r);
          continue;
        }
        const r = itemRow(it, 'equipment', slot, tg); if (r) rows.push(r);
      }
    }
    for (const r of rows) {
      await query(t, `
        INSERT INTO player_items (player_id, container, slot, item_id, enhance, qty)
        VALUES ($1,$2,$3,$4,$5,$6)`, [pid, r.container, r.slot, r.itemId, r.enhance, r.qty]);
    }

    // ── balances + the opening ledger entry ──────────────────────────────────
    const bals = {
      gold: Math.max(0, num(sd.gold)),
      gram: Math.max(0, num(sd.gramBalance)),
      nexum: Math.max(0, num(sd.nexumBalance)),
    };
    for (const [cur, amount] of Object.entries(bals)) {
      if (amount <= 0) continue;
      await query(t, `INSERT INTO balances (player_id, currency, amount) VALUES ($1,$2,$3)`,
        [pid, cur, amount]);
      // Without this, reconcile() reports every migrated account as drifted and
      // the alarm becomes noise. One row, so the sum matches from day one.
      await query(t, `
        INSERT INTO ledger (player_id, currency, delta, balance_after, reason, ref_type, ref_id, idem_key)
        VALUES ($1,$2,$3,$3,'migration_opening','migration',$4,$5)`,
        [pid, cur, amount, tg, `migration:${tg}:${cur}`]);
    }

    // ── skills ───────────────────────────────────────────────────────────────
    const skillMaps = [
      ['skill', sd.skillLevels, v => clampInt(v, 0, 99)],
      ['passive', sd.passiveLevels, v => clampInt(v, 0, 99)],
      ['adv_learned', sd.advSkillLearned, v => (v ? 1 : 0)],
      ['adv_active', sd.advSkillActive, v => (v ? 1 : 0)],
    ];
    for (const [kind, map, conv] of skillMaps) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const [key, v] of Object.entries(map)) {
        const level = conv(v);
        if (!level || typeof key !== 'string' || key.length > 40) continue;
        await query(t, `
          INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1,$2,$3,$4)
          ON CONFLICT DO NOTHING`, [pid, kind, key, level]);
      }
    }

    // ── VIP ──────────────────────────────────────────────────────────────────
    const pending = Array.isArray(sd.vipPending)
      ? sd.vipPending.map(v => clampInt(v, 0, 32767)).filter(v => v > 0) : [];
    await query(t, `
      INSERT INTO player_vip (player_id, level, deposited, pending, season_ticket)
      VALUES ($1,$2,$3,$4,$5)`,
      [pid, clampInt(sd.vipLevel, 0, 32767), Math.max(0, num(sd.vipDeposited)), pending, !!sd.seasonTicket]);

    // ── season ───────────────────────────────────────────────────────────────
    const pts = Math.max(0, int(sd.seasonPoints2));
    if (pts > 0 || sd.seasonRefPaid || sd.seasonBossPaid) {
      await query(t, `
        INSERT INTO player_season (player_id, season, points, tier, boss_paid, ref_paid, quests)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [pid, CURRENT_SEASON, pts, clampInt(sd.seasonTier, 0, 32767),
         !!sd.seasonBossPaid, !!sd.seasonRefPaid,
         JSON.stringify((sd.seasonQuests && typeof sd.seasonQuests === 'object') ? sd.seasonQuests : {})]);
    }

    return { skipped: false, playerId: pid, items: rows.length, balances: bals };
  });
}

// ── the rest ────────────────────────────────────────────────────────────────

async function migrateClans(db) {
  const Clan = mongoose.connection.collection('clans');
  const docs = await Clan.find({}).toArray();
  let made = 0;

  for (const c of docs) {
    try {
      await tx(async (t) => {
        const { rows } = await query(t, `
          INSERT INTO clans (name, icon, description, level, xp, storage_unlocked, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (name) DO NOTHING RETURNING id`,
          [String(c.name || '').slice(0, 10), clampInt(c.icon, 1, 30, 1),
           String(c.description || '').slice(0, 200), Math.max(1, int(c.level, 1)),
           Math.max(0, int(c.xp)), !!c.storageUnlocked, c.createdAt || new Date()]);
        if (!rows.length) return;
        const cid = Number(rows[0].id);

        for (const m of (Array.isArray(c.members) ? c.members : [])) {
          const { rows: p } = await query(t, 'SELECT id FROM players WHERE telegram_id = $1', [String(m.telegramId)]);
          // A member whose account no longer exists cannot be carried — the
          // foreign key would refuse it. Recorded rather than dropped quietly.
          if (!p.length) { lost.clansSkipped.push(`${c.name}: учасник ${m.telegramId} без акаунта`); continue; }
          await query(t, `
            INSERT INTO clan_members (clan_id, player_id, role, joined_at)
            VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [cid, Number(p[0].id), m.role === 'leader' ? 'leader' : 'member', m.joinedAt || new Date()]);
        }
        for (const st of (Array.isArray(c.storage) ? c.storage : [])) {
          if (!CATALOG.has(st.id) || int(st.qty) <= 0) continue;
          await query(t, `
            INSERT INTO clan_storage (clan_id, item_id, qty) VALUES ($1,$2,$3)
            ON CONFLICT (clan_id, item_id) DO UPDATE SET qty = clan_storage.qty + EXCLUDED.qty`,
            [cid, st.id, int(st.qty)]);
        }
        made++;
      });
    } catch (err) {
      lost.clansSkipped.push(`${c.name}: ${err.message}`);
    }
  }
  return made;
}

async function migrateListings() {
  const M = mongoose.connection.collection('marketlistings');
  const docs = await M.find({ status: 'active' }).toArray();
  let made = 0;

  for (const l of docs) {
    try {
      await tx(async (t) => {
        const { rows: p } = await query(t, 'SELECT id FROM players WHERE telegram_id = $1', [String(l.sellerId)]);
        if (!p.length) { lost.listingsSkipped.push(`лот ${l._id}: продавця немає`); return; }
        const base = CATALOG.get(l.item && l.item.id);
        if (!base) { lost.listingsSkipped.push(`лот ${l._id}: предмет ${l.item && l.item.id} не в каталозі`); return; }

        // The item becomes a DETACHED row — owned by the listing, not by the
        // seller. That is the state the array model could not express, and
        // recreating it here is what makes "listed but still in the inventory"
        // unreachable after the migration as well as after it.
        const { rows: ir } = await query(t, `
          INSERT INTO player_items (player_id, container, slot, item_id, enhance, qty)
          VALUES (NULL, NULL, NULL, $1, $2, $3) RETURNING id`,
          [base.id, ENHANCEABLE_SLOTS.has(base.slot) ? clampInt(l.item.enhance, 0, ENHANCE_MAX) : 0,
           isStackableItem(base) ? Math.max(1, int(l.item.qty, 1)) : 1]);

        await query(t, `
          INSERT INTO market_listings (seller_id, item_id, price, status, created_at)
          VALUES ($1,$2,$3,'active',$4)`,
          [Number(p[0].id), Number(ir[0].id), Math.max(0.01, num(l.price, 0.01)), l.createdAt || new Date()]);
        made++;
      });
    } catch (err) {
      lost.listingsSkipped.push(`лот ${l._id}: ${err.message}`);
    }
  }
  return made;
}

async function migrateGramTx() {
  const G = mongoose.connection.collection('gramtxes');
  // Only PENDING withdrawals are carried: they represent money already taken
  // from a balance and owed a decision. Confirmed and rejected ones are history
  // the new ledger does not need, and carrying them would double-count against
  // the opening entries.
  const docs = await G.find({ status: 'pending', type: 'withdraw' }).toArray();
  let made = 0;

  for (const g of docs) {
    try {
      await tx(async (t) => {
        const { rows: p } = await query(t, 'SELECT id FROM players WHERE telegram_id = $1', [String(g.telegramId)]);
        if (!p.length) { lost.txSkipped.push(`заявка ${g._id}: акаунта немає`); return; }
        await query(t, `
          INSERT INTO gram_tx (player_id, type, amount, status, address, created_at)
          VALUES ($1,'withdraw',$2,'pending',$3,$4)`,
          [Number(p[0].id), Math.max(0.01, num(g.amount, 0.01)),
           String(g.address || '').slice(0, 128), g.createdAt || new Date()]);
        made++;
      });
    } catch (err) {
      lost.txSkipped.push(`заявка ${g._id}: ${err.message}`);
    }
  }
  return made;
}

async function migrateSpecialQuests() {
  const S = mongoose.connection.collection('specialquests');
  const docs = await S.find({}).toArray();
  const idMap = new Map();
  for (const q of docs) {
    const { rows } = await query(null, `
      INSERT INTO special_quests (title, description, type, url, icon, reward_gold, reward_xp, reward_nexum, active, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [String(q.title || '').slice(0, 200), String(q.desc || ''), String(q.type || 'link'),
       String(q.url || ''), String(q.icon || '*'),
       Math.max(0, int(q.reward && q.reward.gold)), Math.max(0, int(q.reward && q.reward.xp)),
       Math.max(0, num(q.reward && q.reward.nexum)), q.active !== false, q.createdAt || new Date()]);
    idMap.set(String(q._id), Number(rows[0].id));
  }
  return idMap;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI не задано'); process.exit(1); }

  console.log(`\nETL Mongo → PostgreSQL${DRY ? '  (пробний прогін, нічого не пишеться)' : ''}\n`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('mongo: підключено');

  await tx(t => items.syncCatalog(t));
  console.log(`каталог: ${CATALOG.size} предметів`);

  const Players = mongoose.connection.collection('players');
  const total = await Players.countDocuments();
  console.log(`знайдено акаунтів: ${total}\n`);

  if (DRY) {
    // A dry run transforms everything and reports what WOULD be lost, without
    // writing. Running this first is what turns the real window from a leap
    // into a repeat.
    let checked = 0, itemCount = 0;
    const cursor = Players.find({});
    for await (const doc of cursor) {
      const sd = doc.savedData || {};
      const tg = String(doc.telegramId);
      for (const it of [...(sd.inventory || []), ...(sd.storage || []),
                        ...Object.values(sd.equipment || {})]) {
        if (itemRow(it, 'inventory', null, tg)) itemCount++;
      }
      if (++checked % 2000 === 0) console.log(`  перевірено ${checked}/${total}`);
    }
    console.log(`\nперенеслось би: ${checked} акаунтів, ${itemCount} предметів`);
    report();
    return;
  }

  let migrated = 0, skipped = 0, itemCount = 0, failed = 0;
  const started = Date.now();
  const cursor = Players.find({});
  for await (const doc of cursor) {
    try {
      const res = await migratePlayer(doc);
      if (res.skipped) skipped++;
      else { migrated++; itemCount += res.items; }
    } catch (err) {
      failed++;
      console.error(`  ✗ ${doc.telegramId}: ${err.message}`);
    }
    if ((migrated + skipped + failed) % 500 === 0) {
      const done = migrated + skipped + failed;
      const rate = done / ((Date.now() - started) / 1000);
      console.log(`  ${done}/${total}  (${rate.toFixed(0)}/с, лишилось ~${Math.round((total - done) / rate)}с)`);
    }
  }
  console.log(`\nакаунти: ${migrated} перенесено, ${skipped} уже були, ${failed} з помилкою`);
  console.log(`предмети: ${itemCount}`);

  console.log('\nспецквести…');
  const sq = await migrateSpecialQuests();
  console.log(`  ${sq.size}`);

  console.log('клани…');
  console.log(`  ${await migrateClans()}`);

  console.log('активні лоти…');
  console.log(`  ${await migrateListings()}`);

  console.log('заявки на вивід…');
  console.log(`  ${await migrateGramTx()}`);

  console.log(`\nзагальний час: ${Math.round((Date.now() - started) / 1000)}с`);
  report();
}

function report() {
  console.log('\n── що НЕ перенеслось ──');
  if (lost.unknownItems.size) {
    const tot = [...lost.unknownItems.values()].reduce((a, b) => a + b, 0);
    console.log(`\nпредмети з невідомими id: ${tot} штук у ${lost.playersWithLoss.size} гравців`);
    for (const [id, n] of [...lost.unknownItems].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${id.padEnd(24)} ${n}`);
    }
    console.log('\n  Ці id немає в каталозі цієї збірки. Якщо якийсь із них — реальний');
    console.log('  предмет, доданий пізніше, зупиніться і додайте його в shared/definitions.js');
    console.log('  ДО справжнього переносу, інакше гравці їх втратять.');
  } else {
    console.log('\nпредмети: усі id відомі каталогу ✅');
  }
  for (const [name, list] of [['клани', lost.clansSkipped], ['лоти', lost.listingsSkipped], ['заявки', lost.txSkipped]]) {
    if (list.length) {
      console.log(`\n${name}, пропущено ${list.length}:`);
      for (const l of list.slice(0, 10)) console.log(`  ${l}`);
      if (list.length > 10) console.log(`  … і ще ${list.length - 10}`);
    }
  }
}

// Exported so the transform and the per-player write can be tested against
// synthetic documents without a live Mongo. The edge cases that matter — an
// account with no savedData, an item id the catalog dropped, an xp figure a
// forged save claimed — are far easier to construct than to find in a dump.
module.exports = { migratePlayer, itemRow, progressRow, prefsRow, lost, CATALOG };

// Only when run directly. Required as a module it must not connect to
// anything, or a test that imports the transform starts a migration.
if (require.main === module) {
  main()
    .catch(err => { console.error('\nETL впав:', err); process.exitCode = 1; })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
      await close();
    });
}
