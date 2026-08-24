'use strict';
// ── Clans ───────────────────────────────────────────────────────────────────
// What this replaces: one Mongo document holding members, applications,
// storage and allocations as embedded arrays, written back with clan.save().
// save() is a read-modify-write of the WHOLE document, so two members acting
// in the same second each wrote a version composed before the other's — one
// change simply disappeared (M8 in AUDIT.md). With thirty members that is not
// a rare race, it is the normal case during a raid.
//
// Each array is its own table now and each operation touches one row, so there
// is no whole-document write left to lose anything.
//
// Three invariants moved out of application code and into the schema:
//   clan_members_one_clan_key   — a player belongs to at most one clan
//   clan_members_leader_key     — a clan has exactly one leader
//   clan_storage PRIMARY KEY    — one stack per item id, so a deposit is an
//                                 upsert rather than "find the entry, or push
//                                 a new one" (the $ne guard in the old code
//                                 was working around exactly that)

const { query } = require('../index');
const items = require('./items');
const money = require('./money');
const {
  CLAN_MAX_MEMBERS, CLAN_CREATE_COST, CLAN_DESC_MAX_CHARS, CLAN_LEVELS,
  CLAN_STORAGE_MIN_DAYS, CLAN_STORAGE_UNLOCK_GOLD, UNIQUE_SHARDS,
} = require('../../../shared/definitions');

class ClanError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new ClanError(code, msg); };

const SHARD_IDS = new Set(UNIQUE_SHARDS.map(s => s.id));

// Level from accumulated xp, using the same CLAN_LEVELS table the client
// renders — derived on read rather than stored, so the two cannot drift apart
// the way a denormalised `level` column silently would.
function levelFor(xp) {
  let lvl = 1;
  for (const def of CLAN_LEVELS) if (xp >= def.xpReq) lvl = def.lvl;
  return lvl;
}

// ── create ──────────────────────────────────────────────────────────────────
// The gold is spent and the clan is created in the caller's transaction, so
// "paid but no clan" and "clan but not paid" are both unreachable. The old
// path charged first and created after, with a manual refund if creation
// failed.
async function create(db, playerId, name, icon) {
  const nm = String(name || '').trim();
  if (nm.length < 1 || nm.length > 10) err('bad_name', 'Назва — від 1 до 10 символів');
  const ic = Math.trunc(Number(icon));
  if (!(ic >= 1 && ic <= 30)) err('bad_icon', 'Оберіть іконку');

  await items.lockPlayer(db, playerId);
  const { rows: already } = await query(db,
    'SELECT clan_id FROM clan_members WHERE player_id = $1', [playerId]);
  if (already.length) err('in_clan', 'Ви вже в клані');

  const paid = await money.spend(db, playerId, 'gold', CLAN_CREATE_COST, {
    reason: 'clan_create', idemKey: `clan_create:${playerId}:${nm.toLowerCase()}`,
  });
  if (!paid) err('no_gold', `Потрібно ${CLAN_CREATE_COST} золота`);

  let clanId;
  try {
    const { rows } = await query(db,
      'INSERT INTO clans (name, icon) VALUES ($1, $2) RETURNING id', [nm, ic]);
    clanId = Number(rows[0].id);
  } catch (e) {
    // 23505 = unique_violation on clans.name (citext, so case-insensitive).
    // Thrown, not handled: the transaction rolls the gold back on its way out,
    // which is the refund the old code had to write by hand.
    if (e.code === '23505') err('name_taken', 'Така назва вже зайнята');
    throw e;
  }
  await query(db,
    `INSERT INTO clan_members (clan_id, player_id, role) VALUES ($1, $2, 'leader')`,
    [clanId, playerId]);

  return { clanId, name: nm, icon: ic, goldLeft: paid.balance };
}

// ── membership ──────────────────────────────────────────────────────────────

async function apply(db, playerId, clanId) {
  const { rows: m } = await query(db, 'SELECT clan_id FROM clan_members WHERE player_id = $1', [playerId]);
  if (m.length) err('in_clan', 'Ви вже в клані');
  await query(db, `
    INSERT INTO clan_applications (clan_id, player_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING`, [clanId, playerId]);
  return true;
}

// Accepting is one statement plus the membership insert, both under a lock on
// the clan row — otherwise two officers accepting the 30th and 31st applicant
// at once both see 29 members and the clan ends up over its cap.
async function accept(db, leaderId, clanId, playerId) {
  await _requireLeader(db, leaderId, clanId, { lock: true });

  const { rows: n } = await query(db,
    'SELECT count(*)::int c FROM clan_members WHERE clan_id = $1', [clanId]);
  if (n[0].c >= CLAN_MAX_MEMBERS) err('full', `У клані максимум ${CLAN_MAX_MEMBERS} учасників`);

  const { rowCount } = await query(db,
    'DELETE FROM clan_applications WHERE clan_id = $1 AND player_id = $2', [clanId, playerId]);
  if (!rowCount) err('no_application', 'Заявки не знайдено');

  try {
    await query(db, `INSERT INTO clan_members (clan_id, player_id) VALUES ($1, $2)`, [clanId, playerId]);
  } catch (e) {
    if (e.code === '23505') err('in_clan', 'Гравець уже в іншому клані');
    throw e;
  }
  return true;
}

async function decline(db, leaderId, clanId, playerId) {
  await _requireLeader(db, leaderId, clanId);
  await query(db, 'DELETE FROM clan_applications WHERE clan_id = $1 AND player_id = $2', [clanId, playerId]);
  return true;
}

async function kick(db, leaderId, clanId, playerId) {
  await _requireLeader(db, leaderId, clanId);
  if (playerId === leaderId) err('cant_kick_self', 'Лідер не може виключити себе');
  await _requireNoHeldShards(db, clanId, playerId);
  const { rowCount } = await query(db,
    `DELETE FROM clan_members WHERE clan_id = $1 AND player_id = $2 AND role <> 'leader'`,
    [clanId, playerId]);
  if (!rowCount) err('not_member', 'Учасника не знайдено');
  return true;
}

// Leaving is refused while the member still holds unclaimed shard allocations:
// those rows reference the clan, and letting them leave would either orphan
// the shards or need a cascade that destroys them. The old code checked the
// same thing by scanning an array.
async function leave(db, playerId) {
  const { rows } = await query(db,
    'SELECT clan_id, role FROM clan_members WHERE player_id = $1', [playerId]);
  if (!rows.length) err('not_in_clan', 'Ви не в клані');
  if (rows[0].role === 'leader') err('leader', 'Лідер не може вийти — розформуйте клан');
  await _requireNoHeldShards(db, rows[0].clan_id, playerId);
  await query(db, 'DELETE FROM clan_members WHERE player_id = $1', [playerId]);
  return true;
}

// Disbanding refuses while the storage still holds anything. Deleting a clan
// with shards in it would destroy goods the members contributed — the FK would
// cascade them away silently, which is precisely the outcome to prevent.
async function disband(db, leaderId, clanId) {
  await _requireLeader(db, leaderId, clanId, { lock: true });
  const { rows: held } = await query(db,
    'SELECT coalesce(sum(qty),0)::int n FROM clan_storage WHERE clan_id = $1', [clanId]);
  if (held[0].n > 0) err('storage_not_empty', `Спочатку роздайте Осколки зі сховища (лишилось ${held[0].n})`);
  const { rows: alloc } = await query(db,
    'SELECT count(*)::int n FROM clan_allocations WHERE clan_id = $1', [clanId]);
  if (alloc[0].n > 0) err('allocations_pending', 'Є нероздані Осколки — дочекайтесь, поки їх заберуть');

  await query(db, 'DELETE FROM clan_applications WHERE clan_id = $1', [clanId]);
  await query(db, 'DELETE FROM clan_members WHERE clan_id = $1', [clanId]);
  await query(db, 'DELETE FROM clans WHERE id = $1', [clanId]);
  return true;
}

async function setDescription(db, leaderId, clanId, text) {
  await _requireLeader(db, leaderId, clanId);
  const t = String(text || '').slice(0, CLAN_DESC_MAX_CHARS);
  await query(db, 'UPDATE clans SET description = $2 WHERE id = $1', [clanId, t]);
  return t;
}

// ── xp ──────────────────────────────────────────────────────────────────────
// A plain atomic increment. The old version accumulated xp in a process-local
// Map and flushed it every 20 seconds (_clanXpPending), which meant a crash or
// a deploy lost whatever had not flushed — and made the value impossible to
// read consistently from anywhere else.
async function addXp(db, clanId, amount) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (!amt) return null;
  const { rows } = await query(db,
    'UPDATE clans SET xp = xp + $2 WHERE id = $1 RETURNING xp', [clanId, amt]);
  if (!rows.length) return null;
  const xp = Number(rows[0].xp);
  const lvl = levelFor(xp);
  await query(db, 'UPDATE clans SET level = $2 WHERE id = $1 AND level <> $2', [clanId, lvl]);
  return { xp, level: lvl };
}

// ── storage ─────────────────────────────────────────────────────────────────
// Only shards go in — the same rule the old handler enforced with a message.
// Deposit is an upsert on (clan_id, item_id), so "find the entry or push a new
// one" is one statement that cannot produce two rows for the same shard.

async function deposit(db, playerId, clanId, itemId, qty) {
  if (!SHARD_IDS.has(itemId)) err('not_shard', 'У сховище можна класти лише Осколки');
  const n = Math.max(1, Math.floor(Number(qty) || 0));

  await items.lockPlayer(db, playerId);
  await _requireMember(db, playerId, clanId);
  // The days-in-clan rule applies to putting in as well as taking out. A mule
  // that can deposit but not withdraw is still a mule with an extra step.
  if (!await canUseStorage(db, clanId, playerId)) {
    err('too_new', `Сховище доступне з ${CLAN_STORAGE_MIN_DAYS} днів у клані`);
  }

  if (!await items.removeQty(db, playerId, itemId, n)) {
    err('not_enough', 'У вас стільки немає');
  }
  await query(db, `
    INSERT INTO clan_storage (clan_id, item_id, qty) VALUES ($1, $2, $3)
    ON CONFLICT (clan_id, item_id) DO UPDATE SET qty = clan_storage.qty + EXCLUDED.qty`,
    [clanId, itemId, n]);
  return true;
}

// The leader earmarks shards for a member. Taken out of the shared pool in the
// same statement that records the allocation, guarded by `qty >= n` so two
// simultaneous grants cannot both draw on the same stack.
async function allocate(db, leaderId, clanId, playerId, itemId, qty) {
  await _requireLeader(db, leaderId, clanId);
  await _requireMember(db, playerId, clanId);
  const n = Math.max(1, Math.floor(Number(qty) || 0));

  const { rowCount } = await query(db, `
    UPDATE clan_storage SET qty = qty - $3
     WHERE clan_id = $1 AND item_id = $2 AND qty >= $3`, [clanId, itemId, n]);
  if (!rowCount) err('not_enough', 'У сховищі стільки немає');
  await query(db, 'DELETE FROM clan_storage WHERE clan_id = $1 AND item_id = $2 AND qty = 0', [clanId, itemId]);

  await query(db, `
    INSERT INTO clan_allocations (clan_id, player_id, item_id, qty, allocated_by)
    VALUES ($1, $2, $3, $4, $5)`, [clanId, playerId, itemId, n, leaderId]);
  return true;
}

// The member collects. The allocation row is deleted and the item added in one
// transaction — the old flow could deliver the item and fail to clear the
// record, or clear it and fail to deliver.
async function claim(db, playerId, allocationId) {
  await items.lockPlayer(db, playerId);
  const m = await clanOf(db, playerId);
  if (m && !await canUseStorage(db, m.clanId, playerId)) {
    err('too_new', `Сховище доступне з ${CLAN_STORAGE_MIN_DAYS} днів у клані`);
  }
  const { rows } = await query(db, `
    SELECT id, item_id, qty FROM clan_allocations
     WHERE id = $1 AND player_id = $2 FOR UPDATE`, [allocationId, playerId]);
  if (!rows.length) err('not_found', 'Видачі не знайдено');

  if (!await items.hasRoomFor(db, playerId, rows[0].item_id)) {
    err('no_room', 'Звільніть місце в інвентарі');
  }
  if (await items.add(db, playerId, rows[0].item_id, { qty: rows[0].qty }) === null) {
    err('no_room', 'Звільніть місце в інвентарі');
  }
  await query(db, 'DELETE FROM clan_allocations WHERE id = $1', [allocationId]);
  return { itemId: rows[0].item_id, qty: rows[0].qty };
}

// Returning an unclaimed allocation to the pool — the leader changing their
// mind, or cleanup before a disband.
// The shipped client has no allocation id — its button says "забрать всё" and
// sends an empty payload. So the whole pending list is claimed at once, and a
// full inventory stops the loop rather than failing it: what fitted is kept,
// what did not stays allocated. Throwing instead would roll back the items
// already granted and leave the player pressing a button that never works.
async function claimAll(db, playerId) {
  await items.lockPlayer(db, playerId);
  const mem = await clanOf(db, playerId);
  if (mem && !await canUseStorage(db, mem.clanId, playerId)) {
    err('too_new', `Сховище доступне з ${CLAN_STORAGE_MIN_DAYS} днів у клані`);
  }
  const { rows } = await query(db, `
    SELECT id, item_id, qty FROM clan_allocations
     WHERE player_id = $1 ORDER BY id FOR UPDATE`, [playerId]);
  if (!rows.length) err('not_found', 'Видач немає');

  const taken = []; let blocked = 0;
  for (const r of rows) {
    if (!await items.hasRoomFor(db, playerId, r.item_id)) { blocked++; continue; }
    if (await items.add(db, playerId, r.item_id, { qty: r.qty }) === null) { blocked++; continue; }
    await query(db, 'DELETE FROM clan_allocations WHERE id = $1', [r.id]);
    taken.push({ itemId: r.item_id, qty: r.qty });
  }
  if (!taken.length) err('no_room', 'Звільніть місце в інвентарі');
  return { taken, blocked };
}

// The client cancels by naming WHO it was for and WHAT it was, because that is
// what its table shows. Oldest first, so cancelling twice takes two different
// allocations rather than the same one twice.
async function allocationIdFor(db, clanId, playerId, itemId) {
  const { rows } = await query(db, `
    SELECT id FROM clan_allocations
     WHERE clan_id = $1 AND player_id = $2 AND item_id = $3
     ORDER BY id LIMIT 1`, [clanId, playerId, itemId]);
  return rows.length ? Number(rows[0].id) : null;
}

async function cancelAllocation(db, leaderId, clanId, allocationId) {
  await _requireLeader(db, leaderId, clanId);
  const { rows } = await query(db, `
    DELETE FROM clan_allocations WHERE id = $1 AND clan_id = $2
    RETURNING item_id, qty`, [allocationId, clanId]);
  if (!rows.length) err('not_found', 'Видачі не знайдено');
  await query(db, `
    INSERT INTO clan_storage (clan_id, item_id, qty) VALUES ($1, $2, $3)
    ON CONFLICT (clan_id, item_id) DO UPDATE SET qty = clan_storage.qty + EXCLUDED.qty`,
    [clanId, rows[0].item_id, rows[0].qty]);
  return true;
}

// Unlocking the storage costs gold and is once per clan. `AND NOT
// storage_unlocked` makes the charge and the unlock a single decision, so two
// members pressing it together cannot both pay.
async function unlockStorage(db, playerId, clanId, cost) {
  await _requireLeader(db, playerId, clanId, { lock: true });
  const { rows: c } = await query(db,
    'SELECT storage_unlocked, created_at FROM clans WHERE id = $1', [clanId]);
  if (!c.length) err('no_clan', 'Клан не знайдено');
  if (c[0].storage_unlocked) err('already', 'Сховище вже відкрито');

  // The CLAN's age, which is a different rule from the member's days above —
  // this one stops a clan founded five minutes ago from having a storage at
  // all, and canUseStorage stops a member who joined five minutes ago from
  // using one that exists.
  const ageDays = (Date.now() - new Date(c[0].created_at).getTime()) / 86400000;
  if (ageDays < CLAN_STORAGE_MIN_DAYS) {
    err('too_young', `Сховище відкривається клану від ${CLAN_STORAGE_MIN_DAYS} днів`);
  }
  const paid = await money.spend(db, playerId, 'gold', cost, {
    reason: 'clan_storage_unlock', refType: 'clan', refId: String(clanId),
    idemKey: `clan_storage_unlock:${clanId}`,
  });
  if (!paid) err('no_gold', 'Недостатньо золота');

  await query(db,
    'UPDATE clans SET storage_unlocked = true WHERE id = $1 AND NOT storage_unlocked', [clanId]);
  return { goldLeft: paid.balance };
}

// ── reads ───────────────────────────────────────────────────────────────────

// ── who may touch the storage ───────────────────────────────────────────────
// CLAN_STORAGE_MIN_DAYS counts a MEMBER'S days in the clan, not the clan's own
// age. The rewrite had it on the clan, which reads almost the same and blocks
// nothing: the rule exists so that joining, emptying the storage and leaving
// takes a week rather than a minute. A clan that is old enough would have let
// a member who joined an hour ago do exactly that.
//
// A member row with no joined_at is treated as "here since the beginning"
// rather than locked out forever — same as the build this replaces, and the
// safer direction for a value that only migrated data can be missing.
async function memberDaysIn(db, clanId, playerId) {
  const { rows } = await query(db,
    'SELECT joined_at FROM clan_members WHERE clan_id = $1 AND player_id = $2', [clanId, playerId]);
  if (!rows.length) return null;
  if (!rows[0].joined_at) return Infinity;
  return (Date.now() - new Date(rows[0].joined_at).getTime()) / 86400000;
}

async function canUseStorage(db, clanId, playerId) {
  const d = await memberDaysIn(db, clanId, playerId);
  return (d == null ? -1 : d) >= CLAN_STORAGE_MIN_DAYS;
}

// ── the two panels, in the shapes the client renders ────────────────────────
// The client keys members, applications and allocations by TELEGRAM id — it
// never sees an internal one — so the views carry both: telegramId for the
// buttons, playerId for anything the server does next with the answer.
const _shard = id => UNIQUE_SHARDS.find(x => x.id === id) || null;

async function dataView(db, clanId, playerId) {
  const view = await fullView(db, clanId);
  if (!view) return null;
  const { rows: tg } = await query(db, `
    SELECT m.player_id, p.telegram_id FROM clan_members m
      JOIN players p ON p.id = m.player_id WHERE m.clan_id = $1`, [clanId]);
  const tgOf = new Map(tg.map(r => [Number(r.player_id), r.telegram_id]));

  const { rows: appTg } = await query(db, `
    SELECT a.player_id, p.telegram_id FROM clan_applications a
      JOIN players p ON p.id = a.player_id WHERE a.clan_id = $1`, [clanId]);
  for (const r of appTg) tgOf.set(Number(r.player_id), r.telegram_id);

  const myRole = (view.members.find(m => m.playerId === playerId) || {}).role || null;
  return {
    _id: view.id, id: view.id,
    name: view.name, icon: view.icon, description: view.description,
    level: view.level, xp: view.xp,
    members: view.members.map(m => ({
      telegramId: tgOf.get(m.playerId), playerId: m.playerId,
      username: m.username, role: m.role, bm: m.bm, joinedAt: m.joinedAt,
    })),
    // Only a leader sees the queue, same as before: it carries the usernames
    // of people who have not joined anything yet.
    applications: myRole === 'leader'
      ? view.applications.map(a => ({
          telegramId: tgOf.get(a.playerId), playerId: a.playerId, username: a.username, bm: a.bm,
        }))
      : [],
    myRole,
  };
}

async function storageView(db, clanId, playerId) {
  const view = await fullView(db, clanId);
  if (!view) return null;
  const isLeader = (view.members.find(m => m.playerId === playerId) || {}).role === 'leader';
  const days = await memberDaysIn(db, clanId, playerId);

  const { rows: tg } = await query(db, `
    SELECT m.player_id, m.joined_at, p.telegram_id FROM clan_members m
      JOIN players p ON p.id = m.player_id WHERE m.clan_id = $1`, [clanId]);
  const tgOf = new Map(tg.map(r => [Number(r.player_id), r.telegram_id]));
  const daysOf = new Map(tg.map(r => [Number(r.player_id),
    r.joined_at ? (Date.now() - new Date(r.joined_at).getTime()) / 86400000 : Infinity]));

  const named = id => {
    const d = _shard(id);
    return { name: d ? d.name : id, img: d ? d.img : null };
  };

  return {
    minDays: CLAN_STORAGE_MIN_DAYS,
    daysIn: days === Infinity ? null : Math.floor(Math.max(0, days || 0)),
    canUse: (days == null ? -1 : days) >= CLAN_STORAGE_MIN_DAYS,
    unlocked: !!view.storageUnlocked,
    unlockCost: CLAN_STORAGE_UNLOCK_GOLD,
    isLeader,
    storage: view.storage.map(e => ({ id: e.id, qty: e.qty, ...named(e.id) })),
    // A member sees only what is waiting for them; a leader sees everything,
    // because a leader is who cancels an allocation.
    allocations: view.allocations
      .filter(a => isLeader || a.playerId === playerId)
      .map(a => ({
        telegramId: tgOf.get(a.playerId), playerId: a.playerId, username: a.username,
        id: a.id_item, allocationId: a.id, qty: a.qty, at: a.at, ...named(a.id_item),
      })),
    // Who a leader may allocate TO: members who have been here long enough.
    // Offering the others would be offering a button that refuses.
    members: isLeader
      ? view.members
          .filter(m => (daysOf.get(m.playerId) ?? -1) >= CLAN_STORAGE_MIN_DAYS)
          .map(m => ({ telegramId: tgOf.get(m.playerId), playerId: m.playerId, username: m.username }))
      : [],
  };
}


// The whole clan panel in one round trip. The old version issued a query per
// member to resolve names — an N+1 that ran every time anyone opened the tab.
async function fullView(db, clanId) {
  const { rows: c } = await query(db,
    'SELECT id, name, icon, description, xp, level, storage_unlocked, created_at FROM clans WHERE id = $1',
    [clanId]);
  if (!c.length) return null;

  // Sequential: inside a transaction these share one pg client, which runs one
  // query at a time — Promise.all here would queue them anyway and warn.
  const members = await query(db, `
      SELECT m.player_id, m.role, m.joined_at, p.username, p.bm
        FROM clan_members m JOIN players p ON p.id = m.player_id
       WHERE m.clan_id = $1 ORDER BY (m.role = 'leader') DESC, p.bm DESC`, [clanId]);
  const apps = await query(db, `
      SELECT a.player_id, a.applied_at, p.username, p.bm
        FROM clan_applications a JOIN players p ON p.id = a.player_id
       WHERE a.clan_id = $1 ORDER BY a.applied_at`, [clanId]);
  const storage = await query(db, `
      SELECT s.item_id, s.qty, c.name FROM clan_storage s
        JOIN item_catalog c ON c.item_id = s.item_id
       WHERE s.clan_id = $1 AND s.qty > 0 ORDER BY s.item_id`, [clanId]);
  const allocs = await query(db, `
      SELECT a.id, a.player_id, a.item_id, a.qty, a.created_at, p.username
        FROM clan_allocations a JOIN players p ON p.id = a.player_id
       WHERE a.clan_id = $1 ORDER BY a.created_at`, [clanId]);

  const row = c[0];
  return {
    id: Number(row.id), name: row.name, icon: row.icon, description: row.description,
    xp: Number(row.xp), level: levelFor(Number(row.xp)),
    storageUnlocked: row.storage_unlocked, createdAt: row.created_at,
    members: members.rows.map(m => ({
      playerId: Number(m.player_id), username: m.username, role: m.role, bm: m.bm, joinedAt: m.joined_at,
    })),
    applications: apps.rows.map(a => ({ playerId: Number(a.player_id), username: a.username, bm: a.bm, appliedAt: a.applied_at })),
    storage: storage.rows.map(s => ({ id: s.item_id, qty: s.qty, name: s.name })),
    allocations: allocs.rows.map(a => ({
      id: Number(a.id), playerId: Number(a.player_id), username: a.username,
      id_item: a.item_id, qty: a.qty, at: a.created_at,
    })),
  };
}

async function clanOf(db, playerId) {
  const { rows } = await query(db,
    'SELECT clan_id, role FROM clan_members WHERE player_id = $1', [playerId]);
  return rows.length ? { clanId: Number(rows[0].clan_id), role: rows[0].role } : null;
}

async function search(db, term, limit = 20) {
  const { rows } = await query(db, `
    SELECT c.id, c.name, c.icon, c.xp, c.level,
           (SELECT count(*)::int FROM clan_members m WHERE m.clan_id = c.id) AS members
      FROM clans c
     WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%')
     ORDER BY c.xp DESC LIMIT $2`, [term || null, Math.min(limit, 50)]);
  return rows.map(r => ({
    id: Number(r.id), name: r.name, icon: r.icon,
    xp: Number(r.xp), level: levelFor(Number(r.xp)), members: r.members,
  }));
}

// ── guards ──────────────────────────────────────────────────────────────────

async function _requireLeader(db, playerId, clanId, { lock = false } = {}) {
  // Locking the CLAN row (not the membership) is what serialises accept/kick/
  // disband against each other: they all contend on the same row, in the same
  // order, so there is no cycle to deadlock on.
  if (lock) await query(db, 'SELECT id FROM clans WHERE id = $1 FOR UPDATE', [clanId]);
  const { rows } = await query(db,
    `SELECT role FROM clan_members WHERE clan_id = $1 AND player_id = $2`, [clanId, playerId]);
  if (!rows.length || rows[0].role !== 'leader') err('not_leader', 'Тільки лідер клану');
}

async function _requireMember(db, playerId, clanId) {
  const { rows } = await query(db,
    'SELECT 1 FROM clan_members WHERE clan_id = $1 AND player_id = $2', [clanId, playerId]);
  if (!rows.length) err('not_member', 'Гравець не в цьому клані');
}

async function _requireNoHeldShards(db, clanId, playerId) {
  const { rows } = await query(db,
    'SELECT count(*)::int n FROM clan_allocations WHERE clan_id = $1 AND player_id = $2',
    [clanId, playerId]);
  if (rows[0].n > 0) err('holds_shards', 'Спочатку заберіть видані вам Осколки');
}

module.exports = {
  dataView, storageView, memberDaysIn, canUseStorage,
  claimAll, allocationIdFor,
  create, apply, accept, decline, kick, leave, disband, setDescription,
  addXp, deposit, allocate, claim, cancelAllocation, unlockStorage,
  fullView, clanOf, search, levelFor, ClanError,
};
