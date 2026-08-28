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
//
// ── what the retired models knew ────────────────────────────────────────────
// server/models/*.js is deleted the moment this has run, and it is the only
// written record of the shapes below. Reading collections directly means this
// file no longer depends on those models — but it does depend on KNOWING them,
// so the knowledge is copied here rather than left in a file that is going
// away. Every line was checked against server/models/*.js as it stands today.
//
//   COLLECTION NAMES  mongoose lowercases and pluralises the model name, so
//         Player -> players, Clan -> clans, MarketListing -> marketlistings,
//         GramTx -> gramtxes (the -x -> -xes rule), SpecialQuest ->
//         specialquests. Those five literals below are the whole contract; a
//         typo reads as an empty collection and migrates nobody, silently.
//
//   savedData IS `Mixed`  — Player.js declares no shape at all, so the field
//         list this file transforms was recovered from _sanitizeSavedStats
//         (server/anticheat.js), which is the allow-list every save passed
//         through. Anything not named there was never stored.
//
//   USERNAME IS NOT UNIQUE IN MONGO  Player.js indexes `username` for
//         case-insensitive lookup but does NOT declare it unique, and the
//         value is _safeUsername(user.username || user.first_name) — a
//         Telegram DISPLAY NAME when there is no @handle. Two accounts called
//         "Иван" is ordinary. players.username here is `citext NOT NULL
//         UNIQUE`, which is why _uniqueUsername below exists: without it a
//         collision aborts that player's transaction and the account is lost
//         entirely — every item, every coin — over a display name.
//
//   _ITEM_ID_ALIASES IS EMPTY  _catalogBase (server/anticheat.js) resolves an
//         item id through an alias map before looking it up, so a renamed id
//         would still resolve for the live build and NOT for this file's
//         CATALOG. It is `Object.create(null)` with nothing ever added, in
//         both copies (anticheat.js and index.js) — verified, so no item can
//         be lost to a rename. If an alias is ever added before cutover it
//         must be added to CATALOG here too, or every item under the old id is
//         reported as unknown and dropped.
//
//   THE CEILINGS  _SANITIZE_MAX (server/anticheat.js) is what bounded these
//         numbers on the way in: gold 1e12, xp 1e12, lvl 1000, kills 1e9,
//         bonusSP 1e6, rebirths 1e4, maxHp 1e7, qty 1e6, potions 1e5,
//         invLen 500, storageLen 200, buffDur 7200s. They are reproduced in
//         MAX below because the PostgreSQL columns are narrower than a JS
//         number: an unclamped forged value raises 22003 and takes the WHOLE
//         account down with it, which is a far worse trade than clamping the
//         number nobody should have had.
//
//   THE INVENTORY CAP IS NOT THE STORAGE CAP  SERVER_INV_MAX is 150 but
//         _SANITIZE_MAX.invLen is 500, so Mongo can legitimately hold an
//         inventory the new build considers full. Everything is carried
//         anyway — dropping items is never the right answer — and counted, so
//         the operator learns about it here rather than from a player whose
//         drops stopped being picked up.
//
//   A LISTED ITEM IS ALREADY OUT OF THE BLOB  handlers/market.js removes the
//         item from savedData.inventory and persists that removal before the
//         listing goes live (_commitServerItems, 'market_list'). So carrying
//         both the blob and the active listings does NOT duplicate: the item
//         exists in exactly one of the two. See migrateListings.

const mongoose = require('mongoose');
const { tx, query, close } = require('../server/db');
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
// The HP potions, derived from the catalog exactly as anticheat.js derived
// _HP_POTION_IDS — so adding a third potion needs no change here. Used only by
// the legacy `potions` fallback in progressRow.
const HP_POTION_IDS = ITEM_DEF.filter(d => d.slot === 'use').map(d => d.id);
// SERVER_INV_MAX, repeated rather than imported: server/anticheat.js survives
// the deletion, but this file must not start depending on the live build's
// tuning constants for a number it only COUNTS with. See lost.overCap.
const INV_CAP = 150;

// Everything that could not be carried, by kind. Printed at the end and, more
// importantly, kept per-player so a specific account can be answered about.
const lost = {
  unknownItems: new Map(),      // itemId -> count
  playersWithLoss: new Set(),
  clansSkipped: [],
  listingsSkipped: [],
  txSkipped: [],
  // A display name that collided on players.username (citext UNIQUE, where
  // Mongo had no uniqueness at all). The account is carried under the retired
  // build's own `tg_<id>` fallback rather than lost — but the player is now
  // called something they did not choose, so it is named here.
  renamed: [],
  // Carried inventories already past SERVER_INV_MAX. Nothing is dropped —
  // that is never the right answer — but until the player trims one, drops
  // are not picked up and market cancellations fail, and the operator should
  // learn that here rather than from the complaint.
  overCap: [],
  // A claimed special-quest id with no quest behind it any more. The claim
  // cannot be recorded, so that quest's reward is claimable a second time.
  questClaimsLost: [],
};

// Seconds-remaining -> the moment it ends. A value that is already an expiry
// (a re-run over migrated data) is left alone: thirteen digits is a timestamp,
// four is a countdown.
function _buffsToExpiry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n > 1e11) { if (n > now) out[k] = Math.floor(n); continue; }
    out[k] = now + Math.min(n, 86400) * 1000;
  }
  return out;
}

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const int = (v, d = 0) => Math.floor(num(v, d));
// Counted, not just applied. A ceiling that fires is a value the old database
// held and this one cannot, and the --dry run is where that has to be visible:
// bm is clamped to 2147483647 because the column is `integer`, which is a
// guard against a failed INSERT, not against a nonsense figure. A real account
// arriving at two billion Battle Power would sit at the top of the rating
// until its owner next levelled — and nothing would have said so.
//
// Nothing here changes what is written. It changes whether anyone finds out.
const clamped = new Map();      // field -> { n, worst }
function _noteClamp(field, raw, out) {
  const r = clamped.get(field) || { n: 0, worst: 0 };
  r.n++;
  if (Math.abs(Number(raw)) > Math.abs(r.worst)) r.worst = Number(raw);
  clamped.set(field, r);
  return out;
}
const clampInt = (v, lo, hi, d = 0, field = null) => {
  const out = Math.max(lo, Math.min(hi, int(v, d)));
  return (field && Number.isFinite(Number(v)) && Number(v) !== out) ? _noteClamp(field, v, out) : out;
};
const clampNum = (v, lo, hi, d = 0) => Math.max(lo, Math.min(hi, num(v, d)));

// The ceilings _SANITIZE_MAX (server/anticheat.js) applied on the way in,
// repeated here because the PostgreSQL columns are NARROWER THAN A JS NUMBER
// and this is the last place the difference can be absorbed. `gold` is
// numeric(24,8) — sixteen digits ahead of the point; `kills` is bigint; `bm`
// and `hp` are plain integers at 2^31. An unclamped 1e30 in any one of them
// raises 22003, which aborts THAT PLAYER'S WHOLE TRANSACTION: no items, no
// balance, no level — the entire account lost to one number nobody should
// have had. Clamping costs the holder of a forged figure the forgery; not
// clamping costs a real account everything, and the two are not close.
const MAX = {
  gold: 1e12, gram: 1e12, nexum: 1e12,     // numeric(24,8)
  kills: 1e9, xp: 1e12,                    // bigint
  bm: 2147483647, hp: 1e7, floor: 100000,  // integer
  questIdx: 100000, bonusSp: 1e6, rebirths: 1e4, upg: 1e5,
  qty: 1000000, potions: 1e5,
  vipDeposited: 1e12, seasonPoints: 1e15,
};

// The HP potions the account actually holds. Two shapes reach this, and the
// older one is easy to miss: before potionBag existed the save carried a
// single `potions` integer, and _sanitizeSavedStats migrated it to the first
// potion id on every read — so an account that has not logged in since still
// has only the old field, and reading potionBag alone hands that player an
// empty bag and no way to heal. `{}` is written deliberately when there is
// genuinely nothing: 007's default of 30 is what a NEW character starts with,
// not what someone who spent theirs should be given.
function _potionBag(sd) {
  const raw = sd.potionBag;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const id of HP_POTION_IDS) out[id] = clampInt(raw[id], 0, MAX.potions);
    return out;
  }
  const legacy = clampInt(sd.potions, 0, MAX.potions);
  return legacy > 0 && HP_POTION_IDS.length ? { [HP_POTION_IDS[0]]: legacy } : {};
}

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
  // `level` is the legacy spelling of `lvl` and is still read as a fallback by
  // calcBM (server/anticheat.js). A blob old enough to carry only `level`
  // would otherwise arrive at level 1 with its gear and its xp intact, which
  // reads as a wipe to the person it happened to.
  const lvl = clampInt(sd.lvl != null ? sd.lvl : sd.level, 1, 1000, 1);
  return {
    charClass: cls,
    lvl,
    // xp is clamped to what the level's own curve allows. A blob claiming
    // 1e12 xp at level 3 is not a level 3 character with a lot of xp — it is a
    // number nobody should carry forward.
    xp: clampNum(sd.xp, 0, Math.min(xpToNext(lvl), MAX.xp)),
    kills: clampInt(sd.kills, 0, MAX.kills),
    hp: clampInt(sd.hp, 0, MAX.hp, 100),
    bonusSp: clampInt(sd.bonusSP, 0, MAX.bonusSp),
    keptSp: clampInt(sd.keptSP, 0, MAX.bonusSp),
    rebirths: clampInt(sd.rebirths, 0, MAX.rebirths),
    upg: {
      atk: clampInt(u.atk, 0, MAX.upg), def: clampInt(u.def, 0, MAX.upg), hp: clampInt(u.hp, 0, MAX.upg),
      atkSpeed: clampInt(u.atkSpeed, 0, MAX.upg), critChance: clampInt(u.critChance, 0, MAX.upg),
      critPower: clampInt(u.critPower, 0, MAX.upg), hpRegen: clampInt(u.hpRegen, 0, MAX.upg),
    },
    floor: clampInt(sd.floor, 1, MAX.floor, 1) || 1,
    x: Number.isFinite(num(sd.x, NaN)) ? num(sd.x) : null,
    y: Number.isFinite(num(sd.y, NaN)) ? num(sd.y) : null,
    questIdx: clampInt(sd.questIdx, 0, MAX.questIdx),
    questKills: (sd.questKills && typeof sd.questKills === 'object' && !Array.isArray(sd.questKills)) ? sd.questKills : {},
    // The old save held SECONDS REMAINING; the column now holds the millisecond
    // a buff ends. Carrying the number across verbatim would read as an expiry
    // in January 1970 — every buff dead on arrival — or, if the reader were
    // ever changed back, as a buff that never ends. Converted at the boundary,
    // where the two meanings meet.
    buffs: _buffsToExpiry(sd.buffs),
    potionBag: _potionBag(sd),
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

// players.username is `citext NOT NULL UNIQUE`. Mongo's was neither unique nor
// case-folded, and the value is a Telegram DISPLAY NAME when the account has
// no @handle — so two players called "Иван", or "Alex" and "alex", are both
// ordinary and both collide here. The collision lands on the FIRST statement of
// the player's transaction, so it does not merely drop a name: it aborts the
// whole account, items and balances included, and leaves one ✗ line behind.
//
// Falling back to `tg_<id>` is the retired build's own shape for "no usable
// name" (_safeUsername, server/security.js), and telegram_id being unique makes
// it unique. Checked before the transaction rather than caught inside it,
// because a 23505 poisons the transaction and everything after it would have to
// be replayed on a fresh one — more moving parts than a single indexed lookup
// in a script that runs once.
async function _uniqueUsername(tg, raw) {
  const wanted = String(raw || `tg_${tg}`).slice(0, 32);
  const { rows } = await query(null, 'SELECT telegram_id FROM players WHERE username = $1', [wanted]);
  // A row that is THIS account is a re-run, not a collision: the INSERT below
  // is skipped by ON CONFLICT anyway, and treating it as a clash would rename
  // nobody while filling the report with renames that never happened.
  if (!rows.length || String(rows[0].telegram_id) === tg) return wanted;
  const fallback = `tg_${tg}`.slice(0, 32);
  lost.renamed.push(`${tg}: «${wanted}» зайнято → «${fallback}»`);
  return fallback;
}

async function migratePlayer(doc, questIds = new Map()) {
  const tg = String(doc.telegramId);
  const sd = (doc.savedData && typeof doc.savedData === 'object') ? doc.savedData : {};
  const username = await _uniqueUsername(tg, doc.username);

  return tx(async (t) => {
    // ON CONFLICT DO NOTHING is the whole idempotency story: an account already
    // migrated returns no row and everything below is skipped.
    const { rows: ins } = await query(t, `
      INSERT INTO players (telegram_id, username, bm, referred_by, banned, admin_notified, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (telegram_id) DO NOTHING
      RETURNING id`,
      [tg, username, clampInt(doc.bm, 0, MAX.bm, 0, 'bm'),
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
      // source = 'migration' is the answer migration 011 exists to be able to
      // give. items.add() stamps every other grant path; this is the only
      // INSERT that does not go through it, so without this line the oldest
      // items in the game — everyone's — are the only ones that say nothing
      // about where they came from, which is exactly the question 011 asks.
      await query(t, `
        INSERT INTO player_items (player_id, container, slot, item_id, enhance, qty, source, source_ref)
        VALUES ($1,$2,$3,$4,$5,$6,'migration',$7)`,
        [pid, r.container, r.slot, r.itemId, r.enhance, r.qty, tg]);
    }
    // Mongo allowed 500 inventory entries (_SANITIZE_MAX.invLen); the game
    // considers 150 full. Everything is carried — refusing an item somebody
    // earned is not a trade this migration makes — but past the cap
    // hasRoomFor() is false forever, so drops stop being picked up and a
    // market cancellation has nowhere to return the item to. Counted, so the
    // operator can ask those accounts to trim before they notice.
    const invCount = rows.filter(r => r.container === 'inventory').length;
    if (invCount > INV_CAP) lost.overCap.push(`${tg}: ${invCount} предметів в інвентарі (ліміт ${INV_CAP})`);

    // ── відкриваючий запис у журналі предметів ───────────────────────────────
    // Грошова половина нижче робить рівно це й пояснює навіщо. Предметна
    // не робила НІЧОГО: у цьому файлі не було жодної згадки item_ledger.
    //
    // Ціна пропуску не «одна тривога». repos/items.js reconcile() звіряє суму
    // журналу з тим, що на руках, і без відкриваючого запису кожен
    // перенесений гравець дав би розходження на ВЕСЬ свій інвентар. Тобто
    // сверка, яка існує щоб ловити предмети з нізвідки, з першого ж ранку
    // після переносу кричала б на всіх — її б вимкнули, і наступне справжнє
    // дублювання сховалося б усередині вимкненої тривоги.
    //
    // Читається З БАЗИ, а не підсумовується з масиву `rows`: журнал має
    // збігтися з тим, що реально лежить у player_items, а не з тим, що ми
    // думаємо, ніби туди поклали. Той самий принцип, з якого items.ledger()
    // рахує qty_after запитом, а не бере його від того, хто викликав.
    //
    // Один рядок на пару (гравець, предмет) — саме так групує reconcile();
    // стос із сорока каменів у сумі однаково один доданок.
    const { rows: heldNow } = await query(t, `
      SELECT item_id, sum(qty)::int AS qty FROM player_items
       WHERE player_id = $1 GROUP BY item_id`, [pid]);
    for (const h of heldNow) {
      if (!(Number(h.qty) > 0)) continue;
      // idem_key за тим самим зразком, що й у грошей, і теж UNIQUE: другий
      // прогін переносу на ту саму базу впаде тут, а не подвоїть журнал.
      await query(t, `
        INSERT INTO item_ledger (player_id, item_id, delta, qty_after, reason, ref_type, ref_id, idem_key)
        VALUES ($1,$2,$3,$3,'migration_opening','migration',$4,$5)`,
        [pid, h.item_id, Number(h.qty), tg, `migration:${tg}:${h.item_id}`]);
    }

    // ── balances + the opening ledger entry ──────────────────────────────────
    const bals = {
      gold: clampNum(sd.gold, 0, MAX.gold),
      gram: clampNum(sd.gramBalance, 0, MAX.gram),
      nexum: clampNum(sd.nexumBalance, 0, MAX.nexum),
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
      [pid, clampInt(sd.vipLevel, 0, 32767), clampNum(sd.vipDeposited, 0, MAX.vipDeposited),
       pending, !!sd.seasonTicket]);

    // ── season ───────────────────────────────────────────────────────────────
    const pts = clampInt(sd.seasonPoints2, 0, MAX.seasonPoints);
    if (pts > 0 || sd.seasonRefPaid || sd.seasonBossPaid) {
      await query(t, `
        INSERT INTO player_season (player_id, season, points, tier, boss_paid, ref_paid, quests)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [pid, CURRENT_SEASON, pts, clampInt(sd.seasonTier, 0, 32767),
         !!sd.seasonBossPaid, !!sd.seasonRefPaid,
         JSON.stringify((sd.seasonQuests && typeof sd.seasonQuests === 'object') ? sd.seasonQuests : {})]);
    }

    // ── special quests already claimed ───────────────────────────────────────
    // `specialQuestsDone` is a list of Mongo _id strings, and it is the ONLY
    // record that a one-time reward has been paid. Without it every migrated
    // player can claim every special quest a second time on day one — gold, xp
    // and Liberty, for everyone, out of nothing. `questIds` maps the old _id to
    // the row special_quests got, which is why migrateSpecialQuests has to run
    // BEFORE this loop rather than after it.
    for (const qid of (Array.isArray(sd.specialQuestsDone) ? sd.specialQuestsDone : [])) {
      const newId = questIds.get(String(qid));
      // A claim naming a quest that no longer exists cannot be recorded, and
      // that is a real (if small) hole rather than a tidy no-op: if the quest
      // is ever re-created, this player claims it again. Named, not swallowed.
      if (!newId) { lost.questClaimsLost.push(`${tg}: квест ${qid} більше не існує`); continue; }
      await query(t, `
        INSERT INTO player_special_quests (player_id, quest_id) VALUES ($1,$2)
        ON CONFLICT DO NOTHING`, [pid, newId]);
    }

    return { skipped: false, playerId: pid, items: rows.length, balances: bals };
  });
}

// ── the rest ────────────────────────────────────────────────────────────────

async function migrateClans() {
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
        // No row back means the name was taken. Two ways that happens and both
        // must be visible: a re-run (this clan is already here, correct to
        // skip) or a genuine collision — clans.name is `citext` UNIQUE where
        // Mongo's was case-SENSITIVE, so "Ночь" and "ночь" were two clans and
        // are now one. In the second case a whole clan's members and storage
        // are silently not carried, which is precisely what this file promises
        // never to do. Reported either way; on a first run into an empty
        // database every line here is a real collision.
        if (!rows.length) {
          lost.clansSkipped.push(`${c.name}: назва вже зайнята (повторний прогін або збіг регістру)`);
          return;
        }
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
        const ref = `listing:${l._id}`;
        // Nothing else in this file needs a guard here, because everything else
        // is keyed on telegram_id or a clan name. A listing has no natural key
        // in the new schema, so a second run would INSERT a second detached
        // item and a second lot — MINTING an item and a sale out of a re-run,
        // which is the one thing a migration that calls itself idempotent must
        // not do. player_items.source_ref carries the Mongo _id (exactly what
        // 011 describes it as: "the listing id"), so the second run recognises
        // its own work. The partial unique index on market_listings does not
        // help: the duplicate points at a NEW item row, so it never collides.
        const { rows: seen } = await query(t,
          `SELECT 1 FROM player_items WHERE source = 'migration' AND source_ref = $1`, [ref]);
        if (seen.length) return;

        const { rows: p } = await query(t, 'SELECT id FROM players WHERE telegram_id = $1', [String(l.sellerId)]);
        if (!p.length) { lost.listingsSkipped.push(`лот ${l._id}: продавця немає`); return; }
        const base = CATALOG.get(l.item && l.item.id);
        if (!base) { lost.listingsSkipped.push(`лот ${l._id}: предмет ${l.item && l.item.id} не в каталозі`); return; }

        const enh = ENHANCEABLE_SLOTS.has(base.slot) ? clampInt(l.item.enhance, 0, ENHANCE_MAX) : 0;
        const qty = isStackableItem(base) ? clampInt(l.item.qty, 1, MAX.qty, 1) : 1;

        // The item becomes a DETACHED row — owned by the listing, not by the
        // seller. That is the state the array model could not express, and
        // recreating it here is what makes "listed but still in the inventory"
        // unreachable after the migration as well as after it.
        const { rows: ir } = await query(t, `
          INSERT INTO player_items (player_id, container, slot, item_id, enhance, qty, source, source_ref)
          VALUES (NULL, NULL, NULL, $1, $2, $3, 'migration', $4) RETURNING id`,
          [base.id, enh, qty, ref]);

        // snap_* is what migration 010 added so a CLOSED lot still says what
        // was traded: item_id becomes NULL the moment the buyer enhances or
        // crafts the thing away (ON DELETE SET NULL), and history() then reads
        // the snapshot instead. market.list() writes these on every live
        // listing; a migrated lot without them renders as a blank row in the
        // seller's history the first time the item is destroyed.
        await query(t, `
          INSERT INTO market_listings (seller_id, item_id, price, status, created_at,
            snap_item_id, snap_enhance, snap_qty)
          VALUES ($1,$2,$3,'active',$4,$5,$6,$7)`,
          [Number(p[0].id), Number(ir[0].id), Math.max(0.01, num(l.price, 0.01)),
           l.createdAt || new Date(), base.id, enh, qty]);
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
        const amount = Math.max(0.01, num(g.amount, 0.01));
        const createdAt = g.createdAt || new Date();
        // gram_tx has no unique key a withdrawal can be recognised by, so a
        // second run would create a second payout request for money that was
        // already deducted once — and an admin looking at two identical cards
        // in the ops group has no way to tell which is the duplicate. The
        // account, the amount and the millisecond it was created identify it
        // well enough for a one-shot import; the alternative is paying twice.
        const { rows: seen } = await query(t, `
          SELECT 1 FROM gram_tx
           WHERE player_id = $1 AND type = 'withdraw' AND amount = $2 AND created_at = $3`,
          [Number(p[0].id), amount, createdAt]);
        if (seen.length) return;
        await query(t, `
          INSERT INTO gram_tx (player_id, type, amount, status, address, created_at)
          VALUES ($1,'withdraw',$2,'pending',$3,$4)`,
          [Number(p[0].id), amount, String(g.address || '').slice(0, 128), createdAt]);
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
    const title = String(q.title || '').slice(0, 200);
    const createdAt = q.createdAt || new Date();
    // special_quests has no unique constraint, so an unguarded re-run does not
    // fail — it succeeds twice, and every quest appears in the panel a second
    // time with a reward that is claimable again because the duplicate has its
    // own id. Title plus creation time identifies the row a previous run wrote,
    // and finding it also lets the map be rebuilt on a re-run: without that,
    // resuming after a crash carries no claim histories at all.
    const { rows: seen } = await query(null,
      'SELECT id FROM special_quests WHERE title = $1 AND created_at = $2', [title, createdAt]);
    if (seen.length) { idMap.set(String(q._id), Number(seen[0].id)); continue; }
    const { rows } = await query(null, `
      INSERT INTO special_quests (title, description, type, url, icon, reward_gold, reward_xp, reward_nexum, active, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [title, String(q.desc || ''), String(q.type || 'link'),
       String(q.url || ''), String(q.icon || '*'),
       Math.max(0, int(q.reward && q.reward.gold)), Math.max(0, int(q.reward && q.reward.xp)),
       Math.max(0, num(q.reward && q.reward.nexum)), q.active !== false, createdAt]);
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

  // ── the schema this file writes against ──────────────────────────────────
  // Every player_items INSERT below names `source`, and every listing names
  // snap_item_id. Against a database missing 011 or 010 that is 42703 on every
  // single account — twenty thousand identical ✗ lines and a migration that
  // carried nobody. Asked once, in a sentence that says what to do, rather
  // than discovered per row.
  const { rows: cols } = await query(null, `
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
     WHERE (table_name = 'player_items'     AND column_name IN ('source', 'source_ref'))
        OR (table_name = 'market_listings'  AND column_name = 'snap_item_id')`);
  const have = new Set(cols.map(r => r.c));
  const missing = ['player_items.source', 'player_items.source_ref', 'market_listings.snap_item_id']
    .filter(c => !have.has(c));
  if (missing.length) {
    console.error(`\nсхема застаріла — немає: ${missing.join(', ')}`);
    console.error('Спочатку прогоніть міграції (ADMIN_URL=... bash server/db/migrate.sh),');
    console.error('інакше кожен акаунт впаде на 42703 і не перенесеться жоден.');
    process.exit(1);
  }

  await tx(t => items.syncCatalog(t));
  console.log(`каталог: ${CATALOG.size} предметів`);

  const Players = mongoose.connection.collection('players');
  const total = await Players.countDocuments();
  console.log(`знайдено акаунтів: ${total}\n`);

  // ── the rows that are already there ──────────────────────────────────────
  // A player whose telegram_id already exists is SKIPPED, and that is right for
  // a re-run and catastrophic for a first one: the test suites create accounts
  // with ids shaped exactly like real ones (910000001, 930000631), so a
  // leftover fixture does not merge with the real player — it stands in for
  // them, and that account's items, gold and level never arrive at all. The
  // count says nothing on its own, so it is printed rather than judged: on a
  // FIRST run into a purged database it must be 0, and if it is not, stop.
  const { rows: pre } = await query(null, 'SELECT count(*)::int n FROM players');
  if (pre[0].n > 0) {
    console.log(`⚠ у players уже ${pre[0].n} рядків.`);
    console.log('  Якщо це ПЕРШИЙ прогін — зупиніться: тестові акаунти ще не вичищені,');
    console.log('  і кожен збіг telegram_id мовчки замінить справжнього гравця фікстурою.');
    console.log('  Якщо це повторний прогін після збою — так і має бути.\n');
  }

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

  // BEFORE the players, not after. The per-player transaction writes
  // player_special_quests from savedData.specialQuestsDone, and that needs the
  // old _id -> new id map this returns. Run afterwards, as it used to be, the
  // map is built and thrown away and every player can claim every special
  // quest a second time.
  console.log('спецквести…');
  const questIds = await migrateSpecialQuests();
  console.log(`  ${questIds.size}\n`);

  let migrated = 0, skipped = 0, itemCount = 0, failed = 0;
  const started = Date.now();
  const cursor = Players.find({});
  for await (const doc of cursor) {
    try {
      const res = await migratePlayer(doc, questIds);
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

  console.log('\nклани…');
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
  if (clamped.size) {
    console.log('\nзначення, які довелось обрізати (колонки вужчі за число в Mongo):');
    for (const [field, r] of [...clamped].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${field}: ${r.n} шт., найбільше ${r.worst}`);
    }
    console.log('  це НЕ втрата речей — але, наприклад, обрізаний bm сидітиме');
    console.log('  вгорі рейтингу, доки власник не візьме наступний рівень.');
  }

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
  for (const [name, list] of [
    ['клани', lost.clansSkipped], ['лоти', lost.listingsSkipped], ['заявки', lost.txSkipped],
    ['перейменовані акаунти', lost.renamed],
    ['інвентар понад ліміт', lost.overCap],
    ['втрачені відмітки спецквестів', lost.questClaimsLost],
  ]) {
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
