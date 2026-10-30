'use strict';
// ── Clans ───────────────────────────────────────────────────────────────────
// What this replaces: one Mongo document holding members, applications,
// storage and allocations as embedded arrays, written back with clan.save().
// save() is a read-modify-write of the WHOLE document, so two members acting
// in the same second each wrote a version composed before the other's — one
// change simply disappeared. With thirty members that is not
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

const { query, hasColumn } = require('../index');
const items = require('./items');
const money = require('./money');
const {
  CLAN_MAX_MEMBERS, CLAN_CREATE_COST, CLAN_DESC_MAX_CHARS, CLAN_LEVELS,
  CLAN_STORAGE_MIN_DAYS, CLAN_STORAGE_UNLOCK_GOLD, UNIQUE_SHARDS, clanAtkBonusPct,
  CLAN_DONATIONS, CLAN_DONATE_MIN_HOURS, MSK_OFFSET_H, CRAFT_MATS,
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

  // ── сколько кланов этот игрок уже основал ─────────────────────────────────
  // Читается под локом, который взял items.lockPlayer строкой выше, потому что
  // из этого числа собирается ключ идемпотентности, а он обязан быть одним и
  // тем же у двух попыток одного создания и разным у двух разных.
  //
  // Ключ был `clan_create:<pid>:<имя>`, и это подтверждённая дыра. disband
  // делает DELETE FROM clans и освобождает имя (clans.name — citext UNIQUE), а
  // ledger append-only: старый ключ остаётся. «Alpha» → распустить → «Alpha»
  // снова давало ТОТ ЖЕ ключ, money.spend уходил в ветку replay и возвращал
  // { balance, replayed: true } — ИСТИНУ, так что `if (!paid)` пропускал её,
  // и клан обходился в 0 вместо CLAN_CREATE_COST. Ровно та же форма ошибки,
  // что и бесплатные улучшения в repos/players.js, только дешевле; и так же
  // невидима для money.reconcile(), потому что по ветке replay не пишется
  // ничего и баланс с ledger продолжают сходиться.
  //
  // Считаются ОСНОВАНИЯ, а не роспуски: эпоху тратит каждое успешное
  // создание, поэтому два создания одним игроком не дадут один ключ ни при
  // каком порядке роспусков и выходов — а освободить имя можно не только
  // через disband.
  const { rows: ep } = await query(db,
    'SELECT clan_epoch FROM players WHERE id = $1', [playerId]);
  const epoch = Number(ep[0].clan_epoch) || 0;

  const paid = await money.spend(db, playerId, 'gold', CLAN_CREATE_COST, {
    // `e<эпоха>` стоит ПЕРЕД pid, и это не косметика. Имя клана приходит от
    // игрока и проверяется только по длине (1..10) — двоеточие в нём никто не
    // запрещал. Поставь эпоху рядом с именем, и клан, названный когда-то
    // «0:alpha», дал бы старый ключ `clan_create:<pid>:0:alpha`, в точности
    // равный новому ключу клана «alpha» в эпоху 0, — то есть новая схема
    // унаследовала бы ту самую дыру, которую закрывает. Второй сегмент —
    // единственное место, куда имя дотянуться не может: там всегда стоял
    // десятичный pid.
    //
    // Имя в ключе остаётся: ledger-строка создания не несёт ни ref_type, ни
    // ref_id (clanId на этот момент ещё не существует), так что ключ —
    // единственное место, где видно, за какой именно клан списаны эти 100
    // золота.
    reason: 'clan_create', idemKey: `clan_create:e${epoch}:${playerId}:${nm.toLowerCase()}`,
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
    // Создатель тоже вступил — и его заявки в другие кланы снимаются ниже, по
    // той же причине, что и в accept().
    `INSERT INTO clan_members (clan_id, player_id, role) VALUES ($1, $2, 'leader')`,
    [clanId, playerId]);
  await query(db, 'DELETE FROM clan_applications WHERE player_id = $1', [playerId]);

  // Шаг эпохи — в ТОЙ ЖЕ транзакции, что и списание, и это единственное, что
  // здесь важно: откат забирает его назад вместе со списанием, поэтому повтор
  // после 40001/40P01 прочитает то же число и соберёт тот же ключ, а
  // зафиксированное создание всегда оставляет эпоху потраченной. По той же
  // причине name_taken, «вже в клані» и нехватка золота счётчик не двигают —
  // не из-за порядка строк, а из-за того, что каждая из них выбрасывает и вся
  // транзакция уходит целиком.
  //
  // Место — после вставки, чтобы читалось как есть: одна эпоха на один
  // действительно основанный клан.
  await query(db,
    'UPDATE players SET clan_epoch = clan_epoch + 1, updated_at = now() WHERE id = $1',
    [playerId]);

  return { clanId, name: nm, icon: ic, goldLeft: paid.balance };
}

// ── membership ──────────────────────────────────────────────────────────────

async function apply(db, playerId, clanId) {
  // Первым делом — строка игрока. Порядок «игрок, потом клан» держится во всём
  // файле (create, deposit, unlockStorage) и в killReward; INSERT ниже берёт
  // FOR KEY SHARE и на players, и на clans, и без явного захвата очередь между
  // ними решал планировщик — то есть иногда в обратную сторону. См. разбор
  // цикла над этой функцией.
  await items.lockPlayer(db, playerId);
  const { rows: m } = await query(db, 'SELECT clan_id FROM clan_members WHERE player_id = $1', [playerId]);
  if (m.length) err('in_clan', 'Ви вже в клані');
  // ── клан, которого уже нет ───────────────────────────────────────────────
  //   [act:clanApply] insert or update on table "clan_applications" violates
  //   foreign key constraint "clan_applications_clan_id_fkey"
  //
  // Список кланов у игрока в панели — снимок, снятый когда он её открыл. Клан
  // за это время распустили, игрок жмёт «подать заявку» — и вместо «этого
  // клана больше нет» получает «Ошибка сервера», а операторы получают алерт
  // про нарушение внешнего ключа. Семь раз за неделю.
  //
  // FOR KEY SHARE, а не голый SELECT: без него строку клана можно удалить
  // между этой проверкой и INSERT ниже, и всё вернётся ровно туда, откуда
  // ушли. Порядок «игрок, потом клан» при этом соблюдён — см. выше.
  const { rows: c } = await query(db,
    'SELECT 1 FROM clans WHERE id = $1 FOR KEY SHARE', [clanId]);
  if (!c.length) err('no_clan', 'Цього клану більше немає');
  // Заявка в полный клан исполниться НЕ МОЖЕТ: accept ниже отказывает по
  // CLAN_MAX_MEMBERS. Принять её и оставить в очереди — значит показать лидеру
  // кнопку, которая не сработает; ровно на этом три лидера кланов 30/30
  // нажимали «Принять» по девять раз подряд.
  const { rows: cnt } = await query(db,
    'SELECT count(*)::int c FROM clan_members WHERE clan_id = $1', [clanId]);
  if (cnt[0].c >= CLAN_MAX_MEMBERS) {
    err('full', `У клані вже ${CLAN_MAX_MEMBERS} учасників — місць немає`);
  }
  await query(db, `
    INSERT INTO clan_applications (clan_id, player_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING`, [clanId, playerId]);
  return true;
}

// Accepting is one statement plus the membership insert, both under a lock on
// the clan row — otherwise two officers accepting the 30th and 31st applicant
// at once both see 29 members and the clan ends up over its cap.
async function accept(db, leaderId, clanId, playerId) {
  // ПЕРЕД захватом клана — см. разбор цикла над apply(). Здесь это особенно
  // заметно: _requireLeader{lock} берёт clans FOR UPDATE, а INSERT
  // clan_members двумя строками ниже берёт players FOR KEY SHARE, и ровно эта
  // пара встречалась с killReward, идущим в обратном порядке.
  await items.lockPlayer(db, playerId);
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
  // ── и снимаем ВСЕ остальные его заявки ─────────────────────────────────
  // Строкой выше удалялась заявка только в ЭТОТ клан. Игрок, подавший в
  // двадцать, после вступления оставался в очереди у девятнадцати лидеров, и
  // каждый из них получал «уже в іншому клані» — по одному отказу на нажатие,
  // навсегда. В логе за полсуток: 5 успехов и 99 таких отказов.
  //
  // Одно членство на игрока — правило базы (clan_members_one_clan_key), так
  // что заявка человека, который уже где-то состоит, не может быть исполнена
  // НИКОГДА. Держать её в очереди — значит показывать лидеру кнопку, которая
  // не может сработать.
  await query(db, 'DELETE FROM clan_applications WHERE player_id = $1', [playerId]);
  // Бонус атаки клана входит в БМ (stats.compute → clanAtkBonusPct), а БМ в
  // рейтинге хранится — вступление обязано его переписать.
  await require('./stats').refreshBm(db, playerId);
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
  await require('./stats').refreshBm(db, playerId);   // бонус клана ушёл из БМ
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
  await require('./stats').refreshBm(db, playerId);   // бонус клана ушёл из БМ
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
  if (await nexumReady()) {
    const { rows: nx } = await query(db, 'SELECT nexum FROM clans WHERE id = $1', [clanId]);
    if (nx.length && Number(nx[0].nexum) > 0) {
      err('treasury_not_empty', `Сначала раздайте Liberty из казны клана (осталось ${Number(nx[0].nexum)})`);
    }
  }

  await query(db, 'DELETE FROM clan_applications WHERE clan_id = $1', [clanId]);
  const { rows: gone } = await query(db,
    'DELETE FROM clan_members WHERE clan_id = $1 RETURNING player_id', [clanId]);
  await query(db, 'DELETE FROM clans WHERE id = $1', [clanId]);
  // Бонус клана ушёл из БМ у всех бывших участников.
  for (const g of gone) await require('./stats').refreshBm(db, g.player_id);
  return true;
}

async function setDescription(db, leaderId, clanId, text) {
  await _requireLeader(db, leaderId, clanId);
  const t = String(text || '').slice(0, CLAN_DESC_MAX_CHARS);
  await query(db, 'UPDATE clans SET description = $2 WHERE id = $1', [clanId, t]);
  return t;
}

// Handing the clan to another member. Locked the same way accept/disband are
// — on the clans row — because the two UPDATEs below must not interleave with
// another leader-changing operation on this clan.
//
// The two statements run in this order specifically because of
// clan_members_leader_key: a partial unique index over role='leader' allows
// at most one such row per clan at any instant a constraint is checked. Doing
// "insert the new leader" before "demote the old one" would, for the instant
// between the two statements, try to have two — doing it the other way round
// passes through zero, which the index has no opinion about.
async function transferLeadership(db, leaderId, clanId, newLeaderId) {
  await _requireLeader(db, leaderId, clanId, { lock: true });
  if (newLeaderId === leaderId) err('self', 'Ви вже лідер');
  await _requireMember(db, newLeaderId, clanId);

  await query(db, `UPDATE clan_members SET role = 'member' WHERE clan_id = $1 AND role = 'leader'`, [clanId]);
  await query(db, `UPDATE clan_members SET role = 'leader' WHERE clan_id = $1 AND player_id = $2`, [clanId, newLeaderId]);
  return true;
}

// ── xp ──────────────────────────────────────────────────────────────────────
// Убийства опыта клану больше НЕ дают — решение владельца: прогресс клана
// растёт только от пожертвований участников (donate ниже, CLAN_DONATIONS в
// shared/definitions.js). Вызовы addXp на пути убийства остались, ставка —
// ноль, и addXp на нуле ничего не пишет: ни лишнего UPDATE строки клана на
// каждое убийство, ни объявлений.
//
// Named rather than inlined so the detector asserts against the rate instead
// of against a literal that nobody would notice changing.
const CLAN_XP_PER_KILL = 0;

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

// Опыт клану не за пожертвование: победы в турнире, Владыка Мира. Кто его
// принёс — в clan_bonus_xp (вкладка «Вклад», миграция 047), по источнику.
// Возвращает { xp, level, leveledUp } или null (нет клана / суммы).
async function addBonusXp(db, clanId, playerId, source, amount) {
  const { rows: lv } = await query(db, 'SELECT level FROM clans WHERE id = $1', [clanId]);
  const res = await addXp(db, clanId, amount);
  if (!res) return null;
  if (playerId && await hasColumn('clan_bonus_xp', 'xp')) {
    await query(db, `
      INSERT INTO clan_bonus_xp (clan_id, player_id, source, xp, n) VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (clan_id, player_id, source) DO UPDATE SET
        xp = clan_bonus_xp.xp + EXCLUDED.xp, n = clan_bonus_xp.n + 1, updated_at = now()`,
      [clanId, playerId, source, Math.floor(amount)]);
  }
  return { ...res, leveledUp: lv.length ? res.level > Number(lv[0].level) : false };
}

// Новый уровень клана — новый % атаки в БМ каждого участника. Вне транзакции,
// после коммита.
async function refreshMembersBm(clanId) {
  const { rows } = await query(null, 'SELECT player_id FROM clan_members WHERE clan_id = $1', [clanId]);
  for (const r of rows) await require('./stats').refreshBm(null, r.player_id).catch(() => {});
}

// ── storage ─────────────────────────────────────────────────────────────────
// Only shards go in — the same rule the old handler enforced with a message.
// Deposit is an upsert on (clan_id, item_id), so "find the entry or push a new
// one" is one statement that cannot produce two rows for the same shard.

// Shared tail for deposit()/depositAll() below: takes `n` of one shard kind
// out of the bag and into the pool. Returns 0 (never throws) when the bag
// didn't actually have that many — depositAll relies on that to skip one
// kind and keep going rather than losing the whole batch to one stale row.
async function _depositOne(db, playerId, clanId, itemId, n) {
  if (!await items.removeQty(db, playerId, itemId, n)) return 0;
  await query(db, `
    INSERT INTO clan_storage (clan_id, item_id, qty) VALUES ($1, $2, $3)
    ON CONFLICT (clan_id, item_id) DO UPDATE SET qty = clan_storage.qty + EXCLUDED.qty`,
    [clanId, itemId, n]);
  return n;
}

// Who put it in, kept separately from clan_storage (the shared pool, which
// forgets whose it was the moment it lands). This is the running total the
// Activity tab reads — append-only in effect, since it only ever grows.
async function _recordContribution(db, clanId, playerId, n) {
  await query(db, `
    INSERT INTO clan_contributions (clan_id, player_id, qty, updated_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (clan_id, player_id) DO UPDATE
      SET qty = clan_contributions.qty + EXCLUDED.qty, updated_at = now()`,
    [clanId, playerId, n]);
}

// ── класть в хранилище больше нельзя ────────────────────────────────────────
// Решение владельца: осколки в хранилище клана больше не кладутся — теперь
// туда приходит только Liberty с Войны гильдий (казна, ниже). То, что уже
// лежит, лидер по-прежнему раздаёт (allocate). Обработчики остаются — старый
// клиент ещё может прислать пакет, — но отвечают отказом, ничего не трогая.
const DEPOSITS_CLOSED = true;
const _depositsClosed = () => err('deposits_closed', 'Осколки больше нельзя класть в хранилище клана');

async function deposit(db, playerId, clanId, itemId, qty) {
  if (DEPOSITS_CLOSED) _depositsClosed();
  if (!SHARD_IDS.has(itemId)) err('not_shard', 'У сховище можна класти лише Осколки');
  const n = Math.max(1, Math.floor(Number(qty) || 0));

  await items.lockPlayer(db, playerId);
  await _requireMember(db, playerId, clanId);
  // The days-in-clan rule applies to putting in as well as taking out. A mule
  // that can deposit but not withdraw is still a mule with an extra step.
  if (!await canUseStorage(db, clanId, playerId)) {
    err('too_new', `Сховище доступне з ${CLAN_STORAGE_MIN_DAYS} днів у клані`);
  }

  const took = await _depositOne(db, playerId, clanId, itemId, n);
  if (!took) err('not_enough', 'У вас стільки немає');
  await _recordContribution(db, clanId, playerId, took);
  // The NORMALISED count, not what was asked for — the caller confirms this
  // number to the player, and `qty` from the wire has already been floored and
  // clamped by the time it gets here.
  return { qty: took };
}

// Deposits every shard kind currently in the bag at once — same "no
// payload, take everything" shape as claimAll below, just for the opposite
// direction: putting in five different kinds used to be five prompts and
// five round trips, one per kind, via deposit() above.
//
// Reads the bag through inventoryOf rather than a bespoke sum query so this
// stays in step with whatever inventoryOf already considers "held" (it's
// the same read pushItems/fullState use); _depositOne's own removeQty is
// still what actually decides what can be taken, so a stale count here can
// only skip a kind, never over-take one.
async function depositAll(db, playerId, clanId) {
  if (DEPOSITS_CLOSED) _depositsClosed();
  await items.lockPlayer(db, playerId);
  await _requireMember(db, playerId, clanId);
  if (!await canUseStorage(db, clanId, playerId)) {
    err('too_new', `Сховище доступне з ${CLAN_STORAGE_MIN_DAYS} днів у клані`);
  }

  const inv = await items.inventoryOf(db, playerId);
  const held = new Map(); // itemId -> qty
  for (const row of inv.inventory) {
    if (!SHARD_IDS.has(row.id)) continue;
    held.set(row.id, (held.get(row.id) || 0) + row.qty);
  }
  if (!held.size) err('not_enough', 'У вас немає Осколків');

  const deposited = [];
  for (const [itemId, qty] of held) {
    const took = await _depositOne(db, playerId, clanId, itemId, qty);
    if (took) deposited.push({ itemId, qty: took });
  }
  if (!deposited.length) err('not_enough', 'У вас немає Осколків');
  const total = deposited.reduce((s, d) => s + d.qty, 0);
  await _recordContribution(db, clanId, playerId, total);
  return { items: deposited, total };
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
  return { qty: n };
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
  if (await items.add(db, playerId, rows[0].item_id,
      { qty: rows[0].qty, source: 'clan', sourceRef: 'alloc:' + rows[0].id }) === null) {
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
    if (await items.add(db, playerId, r.item_id,
        { qty: r.qty, source: 'clan', sourceRef: 'alloc:' + r.id }) === null) { blocked++; continue; }
    await query(db, 'DELETE FROM clan_allocations WHERE id = $1', [r.id]);
    taken.push({ itemId: r.item_id, qty: r.qty });
  }
  if (!taken.length) err('no_room', 'Звільніть місце в інвентарі');
  // `items` is the name the client destructures — it sums the quantities to
  // say how many arrived. As `taken` it read undefined and the toast said
  // nothing was collected while the inventory filled up.
  return { items: taken.map(x => ({ id: x.itemId, itemId: x.itemId, qty: x.qty })), taken, blocked };
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
  return { newGold: paid.balance, cost, goldLeft: paid.balance };
}

// ── пожертвования ───────────────────────────────────────────────────────────
// Единственный источник опыта клана. Лимит — perDay каждого вида в московские
// сутки, по игроку (не по клану). Жертвовать можно через
// CLAN_DONATE_MIN_HOURS после вступления. Плата и опыт — одна транзакция:
// не хватило осколков или Liberty — не записано ничего.
async function donationsReady() { return hasColumn('clan_donations', 'kind'); }

function _mskDay(at = Date.now()) {
  return new Date(at + MSK_OFFSET_H * 3600 * 1000).toISOString().slice(0, 10);
}

async function _hoursIn(db, clanId, playerId) {
  const { rows } = await query(db,
    'SELECT joined_at FROM clan_members WHERE clan_id = $1 AND player_id = $2', [clanId, playerId]);
  if (!rows.length) return null;
  if (!rows[0].joined_at) return Infinity;
  return (Date.now() - new Date(rows[0].joined_at).getTime()) / 3600000;
}

// Что видит окно: сколько каждого вида уже сделано сегодня и можно ли вообще.
async function donationState(db, playerId) {
  if (!await donationsReady()) return { ready: false };
  const m = await clanOf(db, playerId);
  const day = _mskDay();
  const { rows } = await query(db, `
    SELECT kind, count(*)::int n FROM clan_donations
     WHERE player_id = $1 AND day = $2 GROUP BY kind`, [playerId, day]);
  const used = { normal: 0, big: 0 };
  for (const r of rows) used[r.kind] = r.n;
  const hours = m ? await _hoursIn(db, m.clanId, playerId) : null;
  const waitH = hours == null || hours === Infinity ? 0 : Math.max(0, CLAN_DONATE_MIN_HOURS - hours);
  return { ready: true, used, minHours: CLAN_DONATE_MIN_HOURS, waitHours: Math.ceil(waitH), day };
}

async function donate(db, playerId, kind) {
  if (!await donationsReady()) err('donations_off', 'Пожертвования ещё не включены на сервере');
  if (typeof kind !== 'string' || !Object.hasOwn(CLAN_DONATIONS, kind)) err('bad_kind', 'Неизвестный вид пожертвования');
  const def = CLAN_DONATIONS[kind];
  // Сперва игрок — тот же порядок блокировок, что у accept и убийства:
  // два нажатия подряд встают в очередь, и лимит на сутки не обходится.
  await items.lockPlayer(db, playerId);
  const m = await clanOf(db, playerId);
  if (!m) err('no_clan', 'Вы не состоите в клане');
  const hours = await _hoursIn(db, m.clanId, playerId);
  if (hours == null) err('no_clan', 'Вы не состоите в клане');
  if (hours < CLAN_DONATE_MIN_HOURS) {
    err('too_new', `Жертвовать можно через ${CLAN_DONATE_MIN_HOURS} ч после вступления в клан (осталось ${Math.ceil(CLAN_DONATE_MIN_HOURS - hours)} ч)`);
  }
  const day = _mskDay();
  const { rows: cnt } = await query(db,
    'SELECT count(*)::int n FROM clan_donations WHERE player_id = $1 AND day = $2 AND kind = $3',
    [playerId, day, kind]);
  if (cnt[0].n >= def.perDay) err('limit', `Сегодня это пожертвование уже сделано ${def.perDay} раза — приходите завтра`);

  const { rows: ins } = await query(db, `
    INSERT INTO clan_donations (clan_id, player_id, kind, day, xp)
    VALUES ($1, $2, $3, $4, $5) RETURNING id`, [m.clanId, playerId, kind, day, def.xp]);
  const donationId = Number(ins[0].id);

  if (kind === 'normal') {
    // Все двадцать видов разом: не хватает хотя бы одного — отказ целиком,
    // и отказ называет, какого.
    const { rows: have } = await query(db, `
      SELECT item_id, COALESCE(sum(qty), 0)::int n FROM player_items
       WHERE player_id = $1 AND container = 'inventory' AND item_id = ANY($2::text[])
       GROUP BY item_id`, [playerId, [...SHARD_IDS]]);
    const n = new Map(have.map(r => [r.item_id, r.n]));
    const short = UNIQUE_SHARDS.find(sh => (n.get(sh.id) || 0) < def.shards);
    if (short) err('no_shards', `Нужно по ${def.shards} осколков каждого вида — не хватает: ${short.name} (${n.get(short.id) || 0})`);
    for (const id of SHARD_IDS) {
      if (!await items.removeQty(db, playerId, id, def.shards,
          { reason: 'clan_donation', refType: 'clan', refId: String(m.clanId) })) {
        err('no_shards', `Не хватает осколков: ${id}`);
      }
    }
  } else {
    const paid = await money.spend(db, playerId, 'nexum', def.liberty, {
      reason: 'clan_donation', refType: 'clan', refId: String(m.clanId),
      idemKey: `clan_donation:${donationId}`,
    });
    if (!paid) err('no_nexum', `Нужно ${def.liberty} Liberty`);
  }

  const before = await query(db, 'SELECT level FROM clans WHERE id = $1', [m.clanId]);
  const res = await addXp(db, m.clanId, def.xp);
  if (!res) err('no_clan', 'Клан не найден');
  return {
    kind, xp: def.xp, clanId: m.clanId, clanXp: res.xp, level: res.level,
    leveledUp: before.rows.length ? res.level > Number(before.rows[0].level) : false,
  };
}

// Пороги уровней поменялись (CLAN_LEVELS) — сохранённый clans.level у кого-то
// теперь не тот, что даёт его опыт. Вызывается на старте сервера; трогает
// только расходящиеся строки и возвращает, у каких кланов уровень сдвинулся.
async function syncLevels(db = null) {
  const { rows } = await query(db, 'SELECT id, xp, level FROM clans');
  const moved = [];
  for (const r of rows) {
    const lvl = levelFor(Number(r.xp));
    if (lvl === Number(r.level)) continue;
    await query(db, 'UPDATE clans SET level = $2 WHERE id = $1', [r.id, lvl]);
    moved.push(Number(r.id));
  }
  return moved;
}

// ── казна: Liberty клана ────────────────────────────────────────────────────
// Приходит с Войны гильдий (server/game/guildwar.js → treasuryCredit), уходит
// только раздачей лидера (giveNexum). Колонки до миграции 041 нет — тогда
// казны просто нет: вид её не показывает, раздача отказывает.
async function nexumReady() { return hasColumn('clans', 'nexum'); }

async function treasuryCredit(db, clanId, amount, reason, ref = null) {
  const n = Math.floor(Number(amount) || 0);
  if (!(n > 0)) return null;
  const { rows } = await query(db,
    'UPDATE clans SET nexum = nexum + $2 WHERE id = $1 RETURNING nexum', [clanId, n]);
  if (!rows.length) return null;             // клана уже нет — платить некому
  await query(db, `
    INSERT INTO clan_nexum_log (clan_id, delta, reason, ref) VALUES ($1, $2, $3, $4)`,
    [clanId, n, reason, ref]);
  return Number(rows[0].nexum);
}

// Лидер отдаёт `amount` Liberty участнику — сразу на баланс, без «забрать».
// Списание с казны — одним UPDATE с `nexum >= $2`: две раздачи в одну
// секунду не потратят одни и те же деньги. Кому можно — то же правило дней в
// клане, что у осколков (canUseStorage): казна не должна стать способом
// вывести деньги через только что принятого.
async function giveNexum(db, leaderId, clanId, playerId, amount) {
  if (!await nexumReady()) err('treasury_off', 'Казна клана ещё не включена');
  const n = Math.floor(Number(amount) || 0);
  if (!(n > 0)) err('bad_amount', 'Неверная сумма');
  await _requireLeader(db, leaderId, clanId, { lock: true });
  await _requireMember(db, playerId, clanId);
  if (!await canUseStorage(db, clanId, playerId)) {
    err('too_new', `Получать из казны можно с ${CLAN_STORAGE_MIN_DAYS} дней в клане`);
  }
  const { rows } = await query(db,
    'UPDATE clans SET nexum = nexum - $2 WHERE id = $1 AND nexum >= $2 RETURNING nexum', [clanId, n]);
  if (!rows.length) err('not_enough', 'В казне столько нет');
  const { rows: lg } = await query(db, `
    INSERT INTO clan_nexum_log (clan_id, delta, reason, player_id, by_id)
    VALUES ($1, $2, 'give', $3, $4) RETURNING id`, [clanId, -n, playerId, leaderId]);
  // Ключ — строка журнала казны: одна раздача — одно зачисление, повтор той
  // же раздачи ledger узнает и не заплатит второй раз.
  const paid = await money.credit(db, playerId, 'nexum', n, {
    reason: 'clan_treasury', refType: 'clan', refId: String(clanId),
    idemKey: `clan_treasury:${lg[0].id}`,
  });
  return { qty: n, left: Number(rows[0].nexum), balance: paid.balance };
}

async function _treasuryView(db, clanId) {
  if (!await nexumReady()) return null;
  const { rows: c } = await query(db, 'SELECT nexum FROM clans WHERE id = $1', [clanId]);
  const { rows: log } = await query(db, `
    SELECT l.delta, l.reason, l.created_at, p.username
      FROM clan_nexum_log l LEFT JOIN players p ON p.id = l.player_id
     WHERE l.clan_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 15`, [clanId]);
  return {
    nexum: c.length ? Number(c[0].nexum) : 0,
    log: log.map(r => ({ delta: Number(r.delta), reason: r.reason, at: r.created_at, username: r.username })),
  };
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
  const donations = await donationState(db, playerId);
  return {
    donations,
    _id: view.id, id: view.id,
    name: view.name, icon: view.icon, description: view.description,
    level: view.level, xp: view.xp,
    members: view.members.map(m => ({
      telegramId: tgOf.get(m.playerId), playerId: m.playerId,
      username: m.username, role: m.role, bm: m.bm, joinedAt: m.joinedAt,
      charClass: m.charClass,
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

  // Не только осколки: дроп гильдийского босса (камни, свитки, книги, руда)
  // лежит в том же хранилище — имя и картинка из общего каталога материалов.
  const named = id => {
    const d = _shard(id) || CRAFT_MATS.find(x => x.id === id);
    return { name: d ? d.name : id, img: d ? d.img : null };
  };

  const treasury = await _treasuryView(db, clanId);
  return {
    // Казна Liberty (null до миграции 041). Вклад в неё — только Война
    // гильдий; кладут в хранилище больше ничего (DEPOSITS_CLOSED выше).
    treasury,
    depositsClosed: DEPOSITS_CLOSED,
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

// Who put how much into the clan's storage, ever — the Activity tab. Reads
// clan_contributions rather than clan_storage (which only holds what is
// still THERE) or item_ledger (which mixes a clan deposit in with every other
// reason an item left someone's bag). Sorted highest-first, which is the
// order a "top contributors" list is for.
//
// A former member who deposited and later left still shows up: the shards
// they put in did not leave with them, so the credit does not either.
async function activityView(db, clanId) {
  // Очки за пожертвования (главное теперь), опыт, принесённый победами в
  // турнире и Владыкой Мира, и осколки, положенные в хранилище раньше, — одним списком по
  // игроку. До миграции 042 очков нет, до 047 — турнирного вклада.
  const donOk = await donationsReady();
  const tourOk = await hasColumn('clan_bonus_xp', 'xp');
  const { rows } = await query(db, `
    WITH pts AS (
      ${donOk ? `SELECT player_id, sum(xp)::bigint AS points, max(created_at) AS at
                   FROM clan_donations WHERE clan_id = $1 GROUP BY player_id`
              : `SELECT NULL::bigint AS player_id, 0::bigint AS points, NULL::timestamptz AS at WHERE false`}
    ), tour AS (
      ${tourOk ? `SELECT player_id,
                         sum(xp) FILTER (WHERE source = 'tournament')::bigint AS tour,
                         sum(n)  FILTER (WHERE source = 'tournament')::int    AS tour_wins,
                         sum(xp) FILTER (WHERE source = 'world_boss')::bigint AS boss,
                         sum(n)  FILTER (WHERE source = 'world_boss')::int    AS boss_kills,
                         max(updated_at) AS at
                    FROM clan_bonus_xp WHERE clan_id = $1 AND xp > 0 GROUP BY player_id`
               : `SELECT NULL::bigint AS player_id, 0::bigint AS tour, 0 AS tour_wins, 0::bigint AS boss, 0 AS boss_kills, NULL::timestamptz AS at WHERE false`}
    ), shards AS (
      SELECT player_id, qty, updated_at FROM clan_contributions WHERE clan_id = $1 AND qty > 0
    ), who AS (
      SELECT player_id FROM pts UNION SELECT player_id FROM tour UNION SELECT player_id FROM shards
    )
    SELECT w.player_id, COALESCE(pt.points, 0) AS points, COALESCE(tr.tour, 0) AS tour,
           COALESCE(tr.tour_wins, 0) AS tour_wins, COALESCE(tr.boss, 0) AS boss,
           COALESCE(tr.boss_kills, 0) AS boss_kills, COALESCE(sh.qty, 0) AS qty,
           COALESCE(pt.at, tr.at, sh.updated_at) AS updated_at, p.username, p.telegram_id,
           (cm.player_id IS NOT NULL) AS in_clan
      FROM who w
      JOIN players p ON p.id = w.player_id
      LEFT JOIN pts pt ON pt.player_id = w.player_id
      LEFT JOIN tour tr ON tr.player_id = w.player_id
      LEFT JOIN shards sh ON sh.player_id = w.player_id
      LEFT JOIN clan_members cm ON cm.clan_id = $1 AND cm.player_id = w.player_id
     ORDER BY COALESCE(pt.points, 0) + COALESCE(tr.tour, 0) + COALESCE(tr.boss, 0) DESC, qty DESC, updated_at ASC`, [clanId]);
  return rows.map(r => ({
    playerId: Number(r.player_id), telegramId: r.telegram_id, username: r.username,
    points: Number(r.points), tour: Number(r.tour), tourWins: Number(r.tour_wins),
    boss: Number(r.boss), bossKills: Number(r.boss_kills),
    qty: Number(r.qty), updatedAt: r.updated_at, inClan: r.in_clan,
  }));
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
      SELECT m.player_id, m.role, m.joined_at, p.username, p.bm, pp.char_class
        FROM clan_members m JOIN players p ON p.id = m.player_id
        LEFT JOIN player_progress pp ON pp.player_id = m.player_id
       WHERE m.clan_id = $1 ORDER BY (m.role = 'leader') DESC, p.bm DESC`, [clanId]);
  // Заявки тех, кто УЖЕ где-то состоит, не показываются. Создать такую строку
  // теперь нельзя (accept снимает все заявки вступившего), но правило стоит
  // здесь тоже — и не ради страховки: база хранит записи, накопленные до
  // этого исправления, а лидер не должен видеть кнопку, которая не может
  // сработать. Одно членство на игрока — правило базы, а не пожелание.
  const apps = await query(db, `
      SELECT a.player_id, a.applied_at, p.username, p.bm
        FROM clan_applications a JOIN players p ON p.id = a.player_id
       WHERE a.clan_id = $1
         AND NOT EXISTS (SELECT 1 FROM clan_members m WHERE m.player_id = a.player_id)
       ORDER BY a.applied_at`, [clanId]);
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
      charClass: m.char_class,
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

// The badge that hangs over a player's head: name, icon, and the attack bonus
// their clan's level grants. One join, read at login and whenever membership
// changes.
//
// clanOf answers `{ clanId, role }` and nothing else, and Room.addPlayer wants
// a name and an icon — so it was handed `progress.clanName`, which does not
// exist: player_progress has no clan columns, because a clan is not a property
// of progress. Every player therefore joined every room with clanName null,
// and no one has ever seen anyone else's clan tag. Two people in two clans
// standing next to each other saw nothing over either head.
async function badgeOf(db, playerId) {
  const { rows } = await query(db, `
    SELECT c.id, c.name, c.icon, c.xp
      FROM clan_members m JOIN clans c ON c.id = m.clan_id
     WHERE m.player_id = $1`, [playerId]);
  if (!rows.length) return null;
  const level = levelFor(Number(rows[0].xp));
  return {
    clanId: Number(rows[0].id),
    name: rows[0].name,
    icon: rows[0].icon,
    level,
    atkBonus: clanAtkBonusPct(level),
  };
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
  dataView, storageView, activityView, memberDaysIn, canUseStorage,
  claimAll, allocationIdFor,
  create, apply, accept, decline, kick, leave, disband, setDescription,
  transferLeadership,
  addXp, addBonusXp, refreshMembersBm, deposit, depositAll, allocate, claim, cancelAllocation, unlockStorage,
  nexumReady, treasuryCredit, giveNexum,
  donationsReady, donationState, donate, syncLevels,
  fullView, clanOf, badgeOf, search, levelFor, ClanError,
  CLAN_XP_PER_KILL,
};
