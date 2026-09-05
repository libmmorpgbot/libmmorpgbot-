'use strict';
// ── The GRAM shop, the starter kit, referrals ───────────────────────────────
// Three places where a package of items is handed over for something the
// player paid, and all three had the same shape in the build this replaces:
// clone the session's inventory array, mutate the clone, check whether the
// result still fits, spend the balance, then commit the clone — with a
// cross-session branch and a manual refund for the case where the account had
// reconnected somewhere else in between.
//
// The change here is not that the transaction removes the refund path, though
// it does. It is that the GRANT IS BUILT AS DATA FIRST.
//
// `_packageContents` returns a plain list of { itemId, qty, enhance } and
// touches nothing. The room check then asks a precise question — do these
// exact rows fit — rather than the old `_shopNewSlots`, which re-derived the
// slot count from the package definition a second time, in a second function,
// using its own copy of the stacking rules. Two derivations of the same number
// is two things to keep in agreement, and they disagreed: `random` skill books
// were counted as if they might touch every book in the class, so a package
// that needed three slots was refused unless twenty were free.
//
// Random books are also rolled ONCE, in the list, rather than counted one way
// and granted another.

const crypto = require('crypto');
const { query } = require('../index');
const items = require('./items');
const money = require('./money');
const players = require('./players');
const progression = require('./progression');
const { refLink } = require('../../security');
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, STARTER_BONUS, MAIL_BONUS,
  FRIENDSHIP_LEVEL, FRIENDSHIP_LAUNCH_AT, FRIENDSHIP_TIERS,
  seasonActive, seasonShopPoints,
} = require('../../../shared/definitions');
const {
  _VIP_BP, pkgPrice, _GRAM_SHOP_PKGS, _SHOP_CLASS_WEAPONS, _SHOP_ARMOR_SETS, _STONE_DEFS,
} = require('../../shop');

class ShopError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new ShopError(code, msg); };
const pick = list => list[crypto.randomInt(list.length)];

// ── what a package actually contains ────────────────────────────────────────
// One list, rolled once. Everything downstream — the room check, the grant,
// the answer to the client — reads this and only this.
function _packageContents(pkg, charClass, chosenPet) {
  const out = [];
  const add = (itemId, qty = 1, enhance = 0) => { if (itemId) out.push({ itemId, qty, enhance }); };
  const enh = pkg.enhance || 0;

  if (pkg.potions > 0) for (const bp of _VIP_BP) add(bp.id, pkg.potions);

  if (pkg.armor) for (const id of (_SHOP_ARMOR_SETS[pkg.armor] || [])) add(id, 1, enh);

  if (pkg.weapon) {
    const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
    add(wepMap[pkg.weapon], 1, enh);
  }

  if (pkg.classArtifact) {
    const d = ITEM_DEF.find(x => x.slot === 'artifact' && x.rarity === pkg.classArtifact
      && x.forClass && x.forClass.includes(charClass));
    if (d) add(d.id, 1, enh);
  }
  if (pkg.classCloak) {
    const d = ITEM_DEF.find(x => x.slot === 'cloak' && x.rarity === pkg.classCloak
      && x.forClass && x.forClass.includes(charClass));
    if (d) add(d.id, 1, enh);
  }
  if (chosenPet) add(chosenPet.id, 1, enh);

  if (pkg.skillBooks) {
    const classBooks = CRAFT_MATS.filter(m => m.forClass === charClass && m.skillKey);
    if (pkg.skillBooks.each) for (const b of classBooks) add(b.id, pkg.skillBooks.each);
    else if (pkg.skillBooks.random && classBooks.length) {
      // Rolled here, once. crypto rather than Math.random: which book a player
      // gets decides whether the package was worth its price.
      for (let i = 0; i < pkg.skillBooks.random; i++) add(pick(classBooks).id, 1);
    }
  }

  if (pkg.boxes) {
    for (const [boxId, qty] of Object.entries(pkg.boxes)) {
      if (BOX_DEF.find(b => b.id === boxId)) add(boxId, qty);
    }
  }
  if (pkg.stones) {
    for (const [sid, qty] of Object.entries(pkg.stones)) {
      if (_STONE_DEFS[sid] || CRAFT_MATS.find(m => m.id === sid)) add(sid, qty);
    }
  }
  return out;
}

// Would this whole list fit? Asked against the database, and asked about the
// list rather than about the package — a stackable the player already has
// costs no slot, and two entries of the same stackable cost one between them.
async function _roomForAll(db, playerId, list) {
  const { rows } = await query(db, `
    SELECT
      (SELECT count(*) FROM player_items WHERE player_id = $1 AND container = 'inventory') AS used,
      COALESCE((SELECT array_agg(DISTINCT item_id) FROM player_items
                 WHERE player_id = $1 AND container = 'inventory'), '{}') AS held`,
    [playerId]);
  const held = new Set(rows[0].held || []);
  const stackable = new Map();
  for (const it of list) {
    if (stackable.has(it.itemId)) continue;
    stackable.set(it.itemId, null);
  }
  const { rows: cat } = await query(db,
    'SELECT item_id, stackable FROM item_catalog WHERE item_id = ANY($1::text[])',
    [[...stackable.keys()]]);
  for (const c of cat) stackable.set(c.item_id, c.stackable);

  let need = 0;
  const willCreate = new Set();
  for (const it of list) {
    const st = stackable.get(it.itemId);
    if (st === null || st === undefined) continue;              // unknown id, dropped below
    if (st) {
      if (held.has(it.itemId) || willCreate.has(it.itemId)) continue;
      willCreate.add(it.itemId);
    }
    need++;
  }
  const { SERVER_INV_MAX } = require('../../anticheat');
  return { fits: Number(rows[0].used) + need <= SERVER_INV_MAX, need, used: Number(rows[0].used) };
}

async function _grantAll(db, playerId, list) {
  const granted = [];
  for (const it of list) {
    const rowId = await items.add(db, playerId, it.itemId,
      { qty: it.qty, enhance: it.enhance, source: 'shop', sourceRef: it.itemId });
    if (rowId === null) err('no_room', 'Инвентарь полон');
    granted.push({ ...it, rowId });
  }
  return granted;
}

// ── GRAM shop ───────────────────────────────────────────────────────────────
async function buyPackage(db, playerId, pkgId, petId) {
  const pkg = _GRAM_SHOP_PKGS.find(p => p.id === pkgId);
  if (!pkg) err('bad_pkg', 'Пакет не найден');

  await items.lockPlayer(db, playerId);
  const prog = await players.progressOf(db, playerId);
  const charClass = prog.charClass || 'lev';

  // A status flag, not a consumable: a second purchase would spend GRAM for
  // nothing. Read from the database rather than from a session field that is
  // loaded at login and hoped to be current.
  const vip = await progression.vipOf(db, playerId);
  if (pkg.seasonTicket && vip.seasonTicket) err('have_ticket', 'Сезонный билет уже куплен');

  let chosenPet = null;
  if (pkg.petChoice) {
    chosenPet = ITEM_DEF.find(d => d.id === petId && d.slot === 'pet' && d.rarity === pkg.petChoice);
    if (!chosenPet) err('no_pet', 'Выберите питомца');
  }

  const list = _packageContents(pkg, charClass, chosenPet);
  const room = await _roomForAll(db, playerId, list);
  if (!room.fits) {
    const { SERVER_INV_MAX } = require('../../anticheat');
    err('no_room', `Нужно ${room.need} свободных мест в инвентаре (занято ${room.used}/${SERVER_INV_MAX})`);
  }

  const price = pkgPrice(pkg);
  const paid = await money.spend(db, playerId, 'gram', price, {
    reason: 'gram_shop', refType: 'package', refId: pkg.id,
    idemKey: `gram_shop:${playerId}:${pkg.id}:${crypto.randomUUID()}`,
  });
  if (!paid) err('no_gram', 'Недостаточно GRAM');

  const granted = await _grantAll(db, playerId, list);

  if (pkg.gold > 0) {
    await money.credit(db, playerId, 'gold', pkg.gold, {
      reason: 'gram_shop', refType: 'package', refId: pkg.id,
      idemKey: `gram_shop_gold:${playerId}:${pkg.id}:${crypto.randomUUID()}`,
    });
  }
  if (pkg.nexum > 0) {
    await money.credit(db, playerId, 'nexum', pkg.nexum, {
      reason: 'gram_shop', refType: 'package', refId: pkg.id,
      idemKey: `gram_shop_nexum:${playerId}:${pkg.id}:${crypto.randomUUID()}`,
    });
  }
  if (pkg.bonusSP > 0) {
    await query(db, 'UPDATE player_progress SET bonus_sp = bonus_sp + $2 WHERE player_id = $1',
      [playerId, pkg.bonusSP]);
  }
  if (pkg.seasonTicket) await progression.grantSeasonTicket(db, playerId);

  // The purchase counts toward VIP, and toward the season, exactly as before —
  // but inside the same transaction, so a package cannot be paid for without
  // its VIP progress or vice versa.
  const vipAfter = await progression.addVipSpend(db, playerId, price);

  let seasonPoints = 0;
  if (seasonActive()) {
    const pts = seasonShopPoints ? seasonShopPoints(price) : 0;
    if (pts > 0) { await progression.addSeasonPoints(db, playerId, pts); seasonPoints = pts; }
  }

  return {
    pkgId: pkg.id, price, granted, gold: pkg.gold || 0, nexum: pkg.nexum || 0,
    bonusSP: pkg.bonusSP || 0, seasonTicket: !!pkg.seasonTicket,
    vip: vipAfter, seasonPoints, gramLeft: paid.balance,
  };
}

// ── starter kit ─────────────────────────────────────────────────────────────
// Once per account, and the once-ness is a conditional UPDATE rather than a
// read followed by a write. Two taps, two sockets, a reconnect mid-grant: they
// all race on the same row and exactly one of them matches.
//
// The claim is recorded BEFORE the grant, deliberately and unchanged from the
// old handler: a duplicated kit is worse than a lost one. What is new is that
// it cannot be lost either — a failure below rolls the flag back with it.
async function claimStarterBonus(db, playerId) {
  await items.lockPlayer(db, playerId);
  const prog = await players.progressOf(db, playerId);
  const charClass = prog.charClass || 'lev';

  const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
  const list = [];
  for (const id of (_SHOP_ARMOR_SETS[STARTER_BONUS.gearRarity] || [])) list.push({ itemId: id, qty: 1, enhance: 0 });
  const wep = wepMap[STARTER_BONUS.gearRarity] || wepMap.common;
  if (wep) list.push({ itemId: wep, qty: 1, enhance: 0 });
  for (const bp of _VIP_BP) list.push({ itemId: bp.id, qty: STARTER_BONUS.buffPotions, enhance: 0 });

  const room = await _roomForAll(db, playerId, list);
  if (!room.fits) {
    const { SERVER_INV_MAX } = require('../../anticheat');
    err('no_room', `Нужно ${room.need} свободных мест в инвентаре (занято ${room.used}/${SERVER_INV_MAX})`);
  }

  const { rowCount } = await query(db, `
    UPDATE player_progress SET starter_bonus_claimed = true
     WHERE player_id = $1 AND NOT starter_bonus_claimed`, [playerId]);
  if (!rowCount) err('already', 'Набор новичка уже получен');

  const granted = await _grantAll(db, playerId, list);

  // Healing potions go to the bag, not the inventory — 300 of them would be
  // twice the whole inventory.
  if (STARTER_BONUS.hpPotions > 0) {
    await query(db, `
      UPDATE player_progress
         SET potion_bag = jsonb_set(potion_bag, ARRAY[$2::text],
               to_jsonb(LEAST(999, COALESCE((potion_bag->>$2)::int, 0) + $3::int)))
       WHERE player_id = $1`, [playerId, STARTER_BONUS.hpPotionId, STARTER_BONUS.hpPotions]);
  }
  return { granted, hpPotions: STARTER_BONUS.hpPotions, charClass };
}

// ── письмо ──────────────────────────────────────────────────────────────────
// Одна из двух наград MAIL_BONUS, один раз на аккаунт, и выбор между ними —
// не выбор игрока. Сезонный билет читается ЗДЕСЬ, из player_vip, а не
// принимается от клиента: клиентский `_seasonTicketActive` рисует панель, и
// доверять ему выдачу значило бы отдать более щедрую награду любому, кто
// пришлёт mailBonusClaim с подделанным флагом.
//
// Порядок тот же, что у набора новичка, и по той же причине: флаг ставится
// условным UPDATE до выдачи, потому что задвоенная награда хуже потерянной, —
// а потерянной она быть не может, транзакция откатит флаг вместе с выдачей.
async function claimMailBonus(db, playerId) {
  await items.lockPlayer(db, playerId);
  const vip = await progression.vipOf(db, playerId);
  const hasTicket = !!vip.seasonTicket;
  const tier = hasTicket ? MAIL_BONUS.ticket : MAIL_BONUS.free;

  const list = [];
  for (const bp of _VIP_BP) list.push({ itemId: bp.id, qty: tier.buffPotions, enhance: 0 });
  for (const [id, qty] of Object.entries(tier.mats || {})) list.push({ itemId: id, qty, enhance: 0 });
  for (const [id, qty] of Object.entries(tier.boxes || {})) list.push({ itemId: id, qty, enhance: 0 });

  const room = await _roomForAll(db, playerId, list);
  if (!room.fits) {
    const { SERVER_INV_MAX } = require('../../anticheat');
    err('no_room', `Нужно ${room.need} свободных мест в инвентаре (занято ${room.used}/${SERVER_INV_MAX})`);
  }

  const { rowCount } = await query(db, `
    UPDATE player_progress SET mail_bonus_claimed = true
     WHERE player_id = $1 AND NOT mail_bonus_claimed`, [playerId]);
  if (!rowCount) err('already', 'Письмо уже получено');

  const granted = await _grantAll(db, playerId, list);
  return { granted, seasonTicket: hasTicket };
}

// ── referrals ───────────────────────────────────────────────────────────────
// Who this player brought in, and what each of them has earned them. The bonus
// is 5% of every confirmed deposit those friends made — read from gram_tx,
// which is the record of what was actually credited, rather than recomputed

// from a running total nobody reconciles.
async function referralsOf(db, playerId) {
  const { rows: me } = await query(db, 'SELECT telegram_id FROM players WHERE id = $1', [playerId]);
  if (!me.length) return { friends: [], refLink: null };
  const tg = me[0].telegram_id;

  // `t.type`, not `t.kind`, and 'confirmed', not 'credited'. Both were wrong,
  // and the second would have raised even after fixing the first —
  // gram_tx_status_t has no 'credited' member, so the comparison is not a
  // filter that matches nothing, it is an invalid enum literal.
  //
  // The whole referral panel was one 42703 away from ever rendering, and the
  // error went to 'gramError' where the client shows it as a toast: a player
  // opening their invites saw a server error and nothing else.
  const { rows } = await query(db, `
    SELECT p.username,
           COALESCE(ROUND(SUM(t.amount) FILTER (
             WHERE t.type = 'deposit' AND t.status = 'confirmed') * 0.05, 2), 0) AS bonus
      FROM players p
      LEFT JOIN gram_tx t ON t.player_id = p.id
     WHERE p.referred_by = $1
     GROUP BY p.id, p.username
     ORDER BY bonus DESC, p.username`, [tg]);

  // The same builder authOk uses, not a second copy of the string. This reply
  // arrives AFTER authOk and the panel overwrites the link with whatever is in
  // it, so the copy here is the one players actually send to their friends —
  // and it was the one still pointing at ?start=, the form nothing in this
  // build can read. See refLink() in server/security.js.
  return {
    friends: rows.map(r => ({ username: r.username, bonus: Number(r.bonus) })),
    refLink: refLink(tg),
  };
}

// ── Дружба ───────────────────────────────────────────────────────────────
// How many of this player's invited friends count toward a tier: joined
// AFTER the feature shipped (FRIENDSHIP_LAUNCH_AT), not merely invited before
// it — an old friend who was already above FRIENDSHIP_LEVEL the day this
// button appeared should not instantly fill every tier at once — and who has
// reached FRIENDSHIP_LEVEL, read live off player_progress rather than any
// counter this table would otherwise have to keep in step by hand.
async function _friendshipCount(db, telegramId) {
  const { rows } = await query(db, `
    SELECT count(*)::int AS n
      FROM players p
      JOIN player_progress pp ON pp.player_id = p.id
     WHERE p.referred_by = $1
       AND p.created_at >= $2::timestamptz
       AND pp.lvl >= $3`, [telegramId, FRIENDSHIP_LAUNCH_AT, FRIENDSHIP_LEVEL]);
  return rows[0].n;
}

// Friends invited SINCE this reward shipped, only — one from before
// FRIENDSHIP_LAUNCH_AT is excluded outright rather than merely marked as not
// counting: the whole point of the cutoff is that those invites predate the
// reward, and listing them next to the new ones (even greyed out) reads as
// "this broke for my old friends" instead of "this is for friends invited
// from now on". `counts` here therefore only still has to ask about the
// level — every row already passed the date half of _friendshipCount's test.
async function _friendshipFriends(db, telegramId) {
  const { rows } = await query(db, `
    SELECT p.username, pp.lvl, (pp.lvl >= $3) AS counts
      FROM players p
      JOIN player_progress pp ON pp.player_id = p.id
     WHERE p.referred_by = $1
       AND p.created_at >= $2::timestamptz
     ORDER BY pp.lvl DESC, p.username`, [telegramId, FRIENDSHIP_LAUNCH_AT, FRIENDSHIP_LEVEL]);
  return rows.map(r => ({ username: r.username, lvl: r.lvl, counts: r.counts }));
}

// What the panel shows: the friend list, how many of them qualify, and which
// tiers are already claimed/claimable — the qualifying count is the SAME
// number the claim below checks, so the button a player taps promises
// exactly what the server will grant it for.
async function friendshipStatus(db, playerId) {
  const { rows: me } = await query(db, 'SELECT telegram_id FROM players WHERE id = $1', [playerId]);
  if (!me.length) return { count: 0, tiers: [], friends: [] };
  const friends = await _friendshipFriends(db, me[0].telegram_id);
  const count = friends.reduce((n, f) => n + (f.counts ? 1 : 0), 0);

  const { rows: claimedRows } = await query(db,
    'SELECT tier FROM player_friendship_claims WHERE player_id = $1', [playerId]);
  const claimed = new Set(claimedRows.map(r => Number(r.tier)));

  return {
    count,
    friends,
    tiers: FRIENDSHIP_TIERS.map(td => ({
      count: td.count,
      claimed: claimed.has(td.count),
      claimable: !claimed.has(td.count) && count >= td.count,
    })),
  };
}

// Grants one tier's reward, once. The claim is recorded with an
// ON CONFLICT DO NOTHING INSERT rather than a read-then-write — two taps
// racing on the same tier both attempt it, and only one INSERT can win —
// and, exactly like the starter kit and the mail bonus above, it is recorded
// BEFORE the grant so the transaction rolls the row back with the grant on
// any failure instead of leaving a claim that paid out nothing.
async function claimFriendshipTier(db, playerId, tierCount) {
  const tier = FRIENDSHIP_TIERS.find(td => td.count === Number(tierCount));
  if (!tier) err('bad_tier', 'Награда не найдена');

  await items.lockPlayer(db, playerId);

  const { rows: me } = await query(db, 'SELECT telegram_id FROM players WHERE id = $1', [playerId]);
  if (!me.length) err('no_player', 'Игрок не найден');
  const count = await _friendshipCount(db, me[0].telegram_id);
  if (count < tier.count) {
    err('not_enough', `Нужно друзей ${FRIENDSHIP_LEVEL}+ уровня: ${tier.count} (сейчас ${count})`);
  }

  const list = [];
  if (tier.buffPotions) for (const bp of _VIP_BP) list.push({ itemId: bp.id, qty: tier.buffPotions, enhance: 0 });
  for (const [id, qty] of Object.entries(tier.mats || {})) list.push({ itemId: id, qty, enhance: 0 });
  if (tier.wing) list.push({ itemId: tier.wing, qty: 1, enhance: 0 });

  const room = await _roomForAll(db, playerId, list);
  if (!room.fits) {
    const { SERVER_INV_MAX } = require('../../anticheat');
    err('no_room', `Нужно ${room.need} свободных мест в инвентаре (занято ${room.used}/${SERVER_INV_MAX})`);
  }

  const { rowCount } = await query(db, `
    INSERT INTO player_friendship_claims (player_id, tier) VALUES ($1, $2)
    ON CONFLICT DO NOTHING`, [playerId, tier.count]);
  if (!rowCount) err('already', 'Награда уже получена');

  const granted = await _grantAll(db, playerId, list);

  // Deterministic idem keys, not crypto.randomUUID like the GRAM shop's —
  // there is exactly one legitimate credit per (player, tier) ever, so the
  // same key doubling as its own replay guard is a feature: a transaction
  // retried after a serialization conflict must credit this exactly once,
  // not once per attempt.
  if (tier.nexum > 0) {
    await money.credit(db, playerId, 'nexum', tier.nexum, {
      reason: 'friendship', refType: 'tier', refId: String(tier.count),
      idemKey: `friendship_nexum:${playerId}:${tier.count}`,
    });
  }
  if (tier.gram > 0) {
    await money.credit(db, playerId, 'gram', tier.gram, {
      reason: 'friendship', refType: 'tier', refId: String(tier.count),
      idemKey: `friendship_gram:${playerId}:${tier.count}`,
    });
  }

  return { tier: tier.count, granted, nexum: tier.nexum || 0, gram: tier.gram || 0 };
}

module.exports = {
  buyPackage, claimStarterBonus, claimMailBonus, referralsOf,
  friendshipStatus, claimFriendshipTier,
  _packageContents, _roomForAll, ShopError,
};
