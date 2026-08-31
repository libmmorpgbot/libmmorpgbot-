'use strict';
// ── Players and progression ─────────────────────────────────────────────────
// This file is where the trust boundary lives, and it is inverted from what it
// replaces.
//
// The old model: the client sent a whole savedData blob, the server copied it
// wholesale (`const s = { ...raw }`), overwrote the fields it cared about, and
// persisted the result. Anything nobody had thought to overwrite went into the
// database exactly as the client wrote it. That is fail-OPEN — every new field
// added to savedData was client-authored by default until someone remembered
// to add a `delete`, which is how vipPending, seasonTicket, specialQuestsDone
// and seasonPoints2 each became an exploit in turn.
//
// Worse, the persist path built Mongo dot-paths from the client's own keys
// (`set['savedData.' + k]`), so a key like "vipPending.0" was a write straight
// into a server-owned array. I verified that on the live code: unknown keys
// survive the sanitizer untouched.
//
// The new model: there is no blob. savePrefs() below names SIX columns, and a
// key that is not one of them cannot be written, because there is no code path
// that would write it. Everything else — level, xp, gold, items, skills, VIP,
// season — is changed only by the server function that owns that rule, and
// each of those takes its inputs as arguments, not as a payload.
//
// Adding a new player-owned field means adding a column and a line here. That
// friction is the point: fail-CLOSED means the default for anything new is
// "the client cannot touch it".

const { query } = require('../index');
// The address normaliser and validator, shared with the chain reader. Its
// client twin is tcFriendlyAddress in js/tonconnect.js — same tag, same
// polynomial, same 48 characters — because what the player is shown is what
// they paste back into the withdrawal form.
const ton = require('../../ton');
const { SERVER_INV_MAX } = require('../../anticheat');
const { xpToNext, skillPointBudget, availableSkillPoints, upgradeCost, CHAR_DEF, ITEM_DEF, UPGRADE_KEYS,
  SKILL_MAX_LEVEL, PASSIVE_MAX_LEVEL,
  DEATH_XP_PENALTY_KEY, xpAfterDeathPenalty, PASSIVE_CLASS_DEF } = require('../../../shared/definitions');

// ── identity ────────────────────────────────────────────────────────────────

// ── кто НЕ является игроком ─────────────────────────────────────────────────
// «Наших ботів видали, їхнє створення видали.»
//
// Отдельной базы у проекта нет: проверки из dev/ ходят по боевой и заводят
// себе аккаунты. Их убирает dev/purge-test-accounts.js, но убрать до конца
// может не всех — у ledger.player_id внешний ключ, а права DELETE на ledger у
// приложения намеренно нет. Оставшиеся банятся и обнуляются по БМ.
//
// Проблема была не в уборке, а в том, что до неё. Уборка идёт в конце прогона,
// а между созданием фикстуры и ним она — обычный аккаунт: ur. 77, 5400 БМ, в
// рейтинге, в админке, в чате. Ровно это и видели.
//
// Поэтому признак нужен такой, который верен С МОМЕНТА СОЗДАНИЯ, и их два:
//
//   telegram_id не число   настоящий вход всегда приносит число (finishLogin
//                          делает String() от payload Телеграма), а проверка
//                          пишет туда свой тег целиком: 'cchk-72449-lead';
// Плюс бан — им уборка помечает тех, кого не смогла удалить (их держит ledger),
// и им же помечены настоящие наказанные.
//
// ── чего здесь НЕТ и почему ────────────────────────────────────────────────
// Первым заходом сюда попал третий признак: «telegram_id в диапазоне 930-990
// миллионов», закреплённом за проверками, которые заходят настоящим
// сокет-логином и потому обязаны иметь ЧИСЛОВОЙ id (dev/adminapi-check.js,
// dev/play-check.js). Он снят, и вот почему: в боевой базе прямо сейчас живёт
// figrt с telegram_id 982997755. Это настоящий человек, четвёртый по БМ, и
// правило вычеркнуло бы его из рейтинга.
//
// Диапазон годится для УБОРКИ, где он один из трёх условий сразу (имя, дата,
// диапазон — и каждое по отдельности отсекает живого), и не годится здесь, где
// он стоял бы один. Фикстуры с числовым id прячет бан, который ставит уборка в
// конце прогона.
//
// Одна строка на всех, кто показывает людей людям: рейтинг, пятёрки лидеров в
// админке, лидер рейтинга в ауре. Разъехаться они не могут по построению.
const REAL_PLAYER_SQL = `NOT %s.banned AND %s.telegram_id ~ '^[0-9]+$'`;
// alias — имя таблицы игроков в запросе, куда это подставляется.
function realPlayerSql(alias) {
  const a = String(alias || 'p').replace(/[^a-z_]/gi, '');
  return REAL_PLAYER_SQL.replace(/%s/g, a);
}


async function byTelegramId(db, telegramId) {
  const { rows } = await query(db,
    `SELECT id, telegram_id, username, bm, banned, referred_by, admin_notified, created_at
       FROM players WHERE telegram_id = $1`, [String(telegramId)]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: Number(r.id), telegramId: r.telegram_id, username: r.username,
    bm: r.bm, banned: r.banned, referredBy: r.referred_by,
    adminNotified: r.admin_notified, createdAt: r.created_at,
  };
}

// Creates the account and its four satellite rows if this telegram id is new.
// One statement per table but ONE transaction from the caller, so a login that
// fails halfway cannot leave a players row with no progress attached — a state
// every reader would then have to defend against.
//
// ON CONFLICT DO NOTHING rather than a "does it exist" read first: two sockets
// from the same account arriving together (a refresh, a double-tap on the
// launch button) both find nothing and both insert, and the second one gets a
// duplicate-key error instead of a session.
// 23505 — нарушение уникальности. Разбирается по ИМЕНИ ограничения, а не по
// тексту: сообщение локализуется настройками базы, имя — нет.
const _isDupUsername = (err) => err && err.code === '23505'
  && String(err.constraint || '').includes('username');

// Выполнить запрос так, чтобы его провал не убил всю транзакцию.
//
// Без этого «поймал 23505 и попробовал иначе» не работает вовсе: Postgres
// после любой ошибки отвечает 25P02 на всё до самого отката, так что повтор
// падал бы уже по другой причине, а вход всё равно не состоялся бы. Точка
// сохранения откатывает ровно один запрос.
//
// db === null — это отдельное соединение вне транзакции (query сам его
// возьмёт), там откатывать нечего: одиночный запрос сам себе транзакция.
// Ошибку ловим и там — иначе защита работала бы только внутри tx(), то есть
// не там, где её однажды позовут.
async function _try(db, sql, params) {
  if (!db) {
    try { return { ok: true, res: await query(db, sql, params) }; }
    catch (err) { if (!_isDupUsername(err)) throw err; return { ok: false, err }; }
  }
  const sp = 'sp_username';
  await query(db, `SAVEPOINT ${sp}`);
  try {
    const res = await query(db, sql, params);
    await query(db, `RELEASE SAVEPOINT ${sp}`);
    return { ok: true, res };
  } catch (err) {
    await query(db, `ROLLBACK TO SAVEPOINT ${sp}`);
    if (!_isDupUsername(err)) throw err;
    return { ok: false, err };
  }
}

async function ensure(db, telegramId, username) {
  const tg = String(telegramId);
  // ── имя не может помешать завести аккаунт ────────────────────────────────
  // ON CONFLICT здесь про telegram_id, а падало другое ограничение —
  // players_username_key. Двое «Максим» в Телеграме: второй получал 23505 на
  // КАЖДОМ входе, транзакция входа откатывалась целиком, и человек видел
  // чёрный экран без единой подсказки. Пять раз за неделю в журнале.
  //
  // Миграция 018 уникальность снимает, и тогда эта ветка не нужна. Но сервер
  // выкатывается раньше миграции, а до неё тёзки всё ещё не входят — поэтому
  // повтор с различителем. Различитель — хвост telegram_id: он у каждого свой
  // и не меняется, так что имя стабильно от входа к входу, а не «Максим_2»,
  // «Максим_3» при каждой попытке.
  const INS = `INSERT INTO players (telegram_id, username) VALUES ($1, $2)
               ON CONFLICT (telegram_id) DO NOTHING
               RETURNING id`;
  let first = await _try(db, INS, [tg, username]);
  if (!first.ok) {
    const alt = String(username).slice(0, 26) + '#' + tg.slice(-4);
    console.warn(`[players] имя «${username}» занято — завожу как «${alt}» (tg ${tg})`);
    first = { ok: true, res: await query(db, INS, [tg, alt]) };
  }
  const { rows } = first.res;

  const isNew = rows.length > 0;
  const id = isNew ? Number(rows[0].id)
                   : Number((await query(db, 'SELECT id FROM players WHERE telegram_id = $1', [tg])).rows[0].id);

  // Idempotent: a legacy account that predates one of these tables gets its
  // row on next login rather than needing a backfill migration.
  await query(db, `INSERT INTO player_progress (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  await query(db, `INSERT INTO player_prefs    (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  await query(db, `INSERT INTO player_vip      (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);

  return { id, isNew };
}

// Display name comes from Telegram and can change between logins. Sanitising
// is the caller's job (security.js _safeUsername) — this only stores it.
async function setUsername(db, playerId, username) {
  // Переименование — украшение. Игрок, сменивший имя в Телеграме на уже
  // занятое, получал 23505 ЗДЕСЬ, и падала вся транзакция входа: аккаунт есть,
  // войти нельзя. Имя того не стоит — остаётся прежнее, и об этом остаётся
  // след, а человек играет.
  const r = await _try(db, 'UPDATE players SET username = $2, updated_at = now() WHERE id = $1',
    [playerId, username]);
  if (!r.ok) {
    console.warn(`[players] имя «${username}» занято — оставляю прежнее (игрок ${playerId})`);
  }
}

// ── may the bot write to this player ────────────────────────────────────────
// See migration 013. Telegram reports the grant ONCE, to the client, in an
// initData field that is frozen at launch — so unless it is written down here
// the player is asked again on every launch until Telegram happens to refresh
// the payload. This is the only record of it that exists.
//
// Asked of the schema rather than assumed, exactly like _hasSourceCols in
// repos/items.js: the migration is applied by hand with a credential the
// deploy does not carry, so the code lands first and the column follows. A
// server that crash-loops on a missing column between those two moments is
// worse than one that forgets a grant for an hour — and this is the LOGIN
// path, so the crash would be every player, not one screen.
let _waCols = null;
async function _hasWriteAccessCols(db) {
  if (_waCols !== null) return _waCols;
  try {
    const { rows } = await query(db, `
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'players' AND column_name = 'can_message' LIMIT 1`);
    _waCols = rows.length > 0;
  } catch {
    _waCols = false;
  }
  return _waCols;
}

// false before the migration, and false is the SAFE answer here: it makes the
// client show the gate to somebody who has already granted, and Telegram
// answers that prompt with an immediate yes rather than a popup. The opposite
// default would let a player who has never been asked straight through, which
// is the whole feature not happening.
async function canMessage(db, playerId) {
  if (!await _hasWriteAccessCols(db)) return false;
  const { rows } = await query(db,
    'SELECT can_message FROM players WHERE id = $1', [Number(playerId)]);
  return !!(rows.length && rows[0].can_message);
}

// MONOTONIC, and migration 013 explains why at length: a grant sticks, a
// refusal writes only the timestamp. The short version is that the client is
// what reports this, and a client-driven path that can CLEAR a permission is a
// packet that revokes its own account's notifications.
//
// Returns whether it was actually stored, so the caller can say "recorded" or
// "the column is not there yet" instead of guessing — a silent no-op here
// would look exactly like a working grant and be discovered a month later,
// when somebody asked why every player is prompted on every launch.
async function setWriteAccess(db, playerId, granted) {
  if (!await _hasWriteAccessCols(db)) return { stored: false };
  await query(db, `
    UPDATE players
       SET can_message     = can_message OR $2,
           write_access_at = now(),
           updated_at      = now()
     WHERE id = $1`, [Number(playerId), !!granted]);
  return { stored: true };
}

// ── which wallet is this ACCOUNT's ──────────────────────────────────────────
// See migration 015. The linked address is a fact about the ACCOUNT; a live
// TON Connect session is a fact about the BROWSER. Only the first can live
// here — and until it did, "на телефоні привязаний гаманець тон а на пк пише
// підключити гаманець" was the correct behaviour of a value that existed
// nowhere but in one browser's localStorage.
//
// Do not confuse this with GRAM_WALLET. That is the PROJECT's deposit address,
// it is configuration, it is the same for every player, and it reaches the
// client as `gramWallet`. This one is the player's own and reaches the client
// as `linkedWallet`. Showing one where the other belongs tells a player to pay
// themselves.
//
// Probed rather than assumed, exactly like _hasWriteAccessCols above and for
// the same reason: the owner applies migrations by hand with a credential the
// deploy does not carry, so this code lands first and the columns follow.
// tonAddressOf is on the LOGIN path, so a server that crash-loops on a missing
// column between those two moments is every player, not one panel.
let _tonCols = null;
async function _hasTonAddressCols(db) {
  if (_tonCols !== null) return _tonCols;
  try {
    const { rows } = await query(db, `
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'players' AND column_name = 'ton_address' LIMIT 1`);
    _tonCols = rows.length > 0;
  } catch {
    _tonCols = false;
  }
  return _tonCols;
}

// The pair, as the client needs to read it. `everLinked` is ton_address_at
// being set at all, and it is not a statistic: it is what tells a device with a
// restored wallet session whether it may publish that session to the account.
//
// Before the migration this answers "never linked, not stored", and that
// default is the safe one in a way worth stating. The client publishes a
// restored session only when the account has never had an address — so a
// pre-migration server gets one wasted packet per launch and forgets it, which
// is exactly the behaviour that shipped before 015. The opposite default
// ("deliberately unlinked") would suppress the backfill entirely, and the bug
// this whole change exists to fix would keep looking unfixed after the deploy.
async function tonAddressOf(db, playerId) {
  if (!await _hasTonAddressCols(db)) return { address: null, everLinked: false, stored: false };
  const { rows } = await query(db,
    'SELECT ton_address, ton_address_at FROM players WHERE id = $1', [Number(playerId)]);
  if (!rows.length) return { address: null, everLinked: false, stored: true };
  return {
    address: rows[0].ton_address || null,
    everLinked: rows[0].ton_address_at != null,
    stored: true,
  };
}

// ── what a lying client could gain, worked out once ─────────────────────────
//
// THE CLIENT IS THE ONLY POSSIBLE SOURCE of this address, the same way it is
// for can_message: TON Connect reports the wallet to the page, and there is no
// server-side callback to ask. So the question is not "can it be forged" — of
// course it can — but "what does forging it buy", and the answer today is
// NOTHING. Written down here so the next person does not have to redo it:
//
//   * WITHDRAWALS. The withdrawal form takes any address the player types, and
//     gram.requestWithdraw validates the FORM of it and nothing else. Asserting
//     a wallet you do not own gets you an auto-filled field you could have
//     filled by hand. There is no gain because there was never a restriction.
//   * DEPOSITS. A transfer is credited on its MEMO (repos/gram.js keys the
//     ledger entry `deposit:memo:<memo>`), never on who sent it. gram_tx.sender
//     is written from the chain and is evidence on an ops card, not an input.
//     Claiming somebody's address credits you with nothing of theirs.
//   * OTHER PLAYERS. The column is not unique (migration 015 says why at
//     length), so claiming an address in use cannot lock its real owner out of
//     linking it. That is the one griefing move a UNIQUE constraint would have
//     handed out for free.
//
// THREE WAYS THAT STOPS BEING TRUE, and each of them is somebody else's future
// change rather than this one:
//
//   1. Restricting withdrawals to the linked address as an anti-fraud measure.
//      It would restrict nothing — the same packet that sets the destination
//      sets the restriction — while reading, in a review, like a control.
//   2. Crediting or attributing a deposit by its sender rather than its memo.
//   3. Showing this address to an operator as though it were verified. It is a
//      CLAIM. Every ops card that prints it must say so, or the first person to
//      launder through it will do so behind a label that vouched for them.
//
// What would make it proof is TON Connect's `tonProof`: the wallet signs a
// server-issued nonce and the server verifies the signature against the account
// state. That is a real change with a real key check in it, and it is the thing
// to build BEFORE any of the three above — not alongside.
function _normalisedTonAddress(address) {
  const raw = String(address == null ? '' : address).trim();
  // validAddress accepts raw `0:hex…` as readily as friendly `UQ…`, so this
  // refuses first and normalises second. Refusing anything that is not an
  // address at all is the point: a free-text column that anything can be
  // written into is a column an operator cannot read.
  if (!ton.validAddress(raw)) {
    const e = new Error('Некорректный TON-адрес');
    e.code = 'bad_address'; e.userMessage = e.message;
    throw e;
  }
  // FRIENDLY, always. A raw address in this column would be auto-filled into
  // the withdrawal form and shown on the wallet card, and a player comparing
  // `0:8fe52cb8…` against what their wallet app shows them concludes the game
  // linked somebody else's account. js/tonconnect.js tcFriendlyAddress is this
  // function's client twin and produces the same 48 characters.
  return ton.friendlyAddress(raw);
}

// NEWEST WINS, and the caller decides what counts as new — see the handler in
// server/app.js and _onTonConnectChange in js/ui.js. The rule the two halves
// implement together: a wallet the player just connected ON THIS DEVICE
// replaces whatever the account held; a session merely RESTORED from a
// browser's storage publishes itself only when the account holds nothing.
//
// Oldest-wins and refuse were both rejected for the same reason: a player whose
// old wallet is gone — phone lost, seed rotated, wallet app uninstalled — could
// then never change their payout address without an operator, and there is one
// operator. "Newest wins" is the only one of the three where the player can fix
// their own account.
//
// The cost of newest-wins is that a change must never be silent, and it is not:
// the previous address comes back from here, the handler writes it into a
// player_logs row, and the wallet card shows the address in full on every
// device rather than an elided "UQ6f…ab3f" nobody can check.
async function setTonAddress(db, playerId, address) {
  // Before the schema probe on purpose: an address that is not an address is
  // refused whether or not the migration has been applied, so the refusal a
  // player sees does not depend on the deploy window they hit.
  const addr = _normalisedTonAddress(address);
  if (!await _hasTonAddressCols(db)) return { stored: false, address: addr, previous: null, changed: false };
  const pid = Number(playerId);
  // FOR UPDATE, and `db` is a transaction client from session.act. The previous
  // address is what the log row and the ops trail are about, so reading it and
  // overwriting it have to be one indivisible step — otherwise the row says a
  // wallet was replaced by one that had already replaced it.
  const { rows } = await query(db,
    'SELECT ton_address FROM players WHERE id = $1 FOR UPDATE', [pid]);
  const previous = rows.length ? (rows[0].ton_address || null) : null;
  // Nothing changed: no write, and `changed:false` so the caller logs nothing.
  // A player opening the wallet panel on the same device every day would
  // otherwise write a row and an UPDATE per launch, and player_logs is where
  // the answer to "when did this address change" has to stay findable.
  if (previous === addr) return { stored: true, address: addr, previous, changed: false };
  await query(db, `
    UPDATE players
       SET ton_address    = $2,
           ton_address_at = now(),
           updated_at     = now()
     WHERE id = $1`, [pid, addr]);
  return { stored: true, address: addr, previous, changed: true };
}

// «Отвязать» means the ACCOUNT, not the device — that is what the word means to
// the player who presses it, and a button that unlinks one browser while the
// other one still withdraws to the same wallet is the same lie in the opposite
// direction.
//
// ton_address_at is written, NOT cleared, and that is the whole point of the
// pair. It is what separates "unlinked on purpose" from "never linked", and the
// client reads exactly that difference to decide whether a device with a
// restored TON Connect session may publish it. Clearing it would let the player
// unlink on the desktop, open the phone, and have the phone link the wallet
// straight back — an unlink undone by opening an app.
//
// It is written even when nothing was linked. Pressing «Отвязать» with no
// server-side address is still the player saying "not this wallet", and the
// device that offered the button is a device whose restored session would
// otherwise publish itself on the next launch.
async function clearTonAddress(db, playerId) {
  if (!await _hasTonAddressCols(db)) return { stored: false, previous: null };
  const pid = Number(playerId);
  const { rows } = await query(db,
    'SELECT ton_address FROM players WHERE id = $1 FOR UPDATE', [pid]);
  const previous = rows.length ? (rows[0].ton_address || null) : null;
  await query(db, `
    UPDATE players
       SET ton_address    = NULL,
           ton_address_at = now(),
           updated_at     = now()
     WHERE id = $1`, [pid]);
  return { stored: true, previous };
}

// ── who invited this player ─────────────────────────────────────────────────
// The only writer of players.referred_by, and until it existed there was NONE.
// Three finished features read that column and all three paid nobody: the 5%
// commission on an invited friend's deposit (repos/gram.js), the season points
// when they reach level 20 (repos/progression.js payReferralOnLevel) and the
// invited-friends list the client shows (repos/shop.js referralsOf). Each of
// them joins on a column that was empty for every account in the database, so
// each was a query returning zero rows rather than anything that looked broken.
//
// referred_by holds a TELEGRAM ID and its type is text (migrations/001_core.sql)
// — not a players.id, and not a number. Comparing it against an integer matches
// nothing and raises nothing, which is the failure mode this whole file exists
// to make impossible, so the id goes in as a string and is checked as one.
//
// ONE statement decides, rather than a read followed by a write. Two logins for
// the same account arriving together — a refresh, a second device, the client
// retrying a lost connect — both read "not referred yet", and the second then
// overwrites the first referrer. `referred_by IS NULL` inside the UPDATE means
// the loser writes nothing at all and is told `already`, which is also what a
// player gets for opening a second person's link a week later: the first
// referrer keeps the friend, forever, because the payouts above are once-only
// and there is no way to take one back.
//
// Returns { ok } plus a reason the caller can put in the log. Four refusals,
// each of them a thing somebody has asked an operator about:
//
//   malformed    a start_param that is not a telegram id at all
//   self         the player's own link — the first thing anyone tries
//   already      invited by somebody else, whether a second ago or last month
//   no_referrer  a link built from an id that has no account here
async function registerReferral(db, playerId, referrerTelegramId) {
  const ref = String(referrerTelegramId == null ? '' : referrerTelegramId).trim();
  // start_param is attacker-controlled text: it arrives in a URL a player
  // composes themselves and, if it were stored, would be shown back to whoever
  // opens the invited-friends panel. A telegram id is digits, so anything else
  // never reaches the database at all.
  if (!/^\d{1,20}$/.test(ref)) {
    return { ok: false, reason: 'malformed', msg: 'Некорректная ссылка-приглашение', refId: ref.slice(0, 64) };
  }

  const { rows } = await query(db, `
    UPDATE players p
       SET referred_by = r.telegram_id, updated_at = now()
      FROM players r
     WHERE p.id = $1
       AND r.telegram_id = $2
       AND p.referred_by IS NULL
       AND r.id <> p.id
    RETURNING r.id AS referrer_id, r.username AS referrer_username`, [playerId, ref]);
  if (rows.length) {
    return {
      ok: true, refId: ref,
      referrerId: Number(rows[0].referrer_id),
      referrerUsername: rows[0].referrer_username,
    };
  }

  // Nothing was written, and WHICH of the four it was cannot be read off a row
  // count of zero. One extra read, on a path that only runs when a referral was
  // already refused, is what turns the log line from "не зарегистрировалось"
  // into something an operator can answer a player with.
  const { rows: why } = await query(db, `
    SELECT p.telegram_id, p.referred_by,
           EXISTS (SELECT 1 FROM players r WHERE r.telegram_id = $2) AS referrer_exists
      FROM players p WHERE p.id = $1`, [playerId, ref]);
  if (!why.length) return { ok: false, reason: 'no_player', msg: 'Игрок не найден', refId: ref };
  // Self before already: an account that referred itself would otherwise be
  // reported as "invited by someone else" and the someone else would be them.
  if (why[0].telegram_id === ref) return { ok: false, reason: 'self', msg: 'Нельзя пригласить самого себя', refId: ref };
  if (why[0].referred_by) {
    return { ok: false, reason: 'already', msg: 'Игрок уже приглашён', refId: ref, referredBy: why[0].referred_by };
  }
  if (!why[0].referrer_exists) return { ok: false, reason: 'no_referrer', msg: 'Пригласивший не найден', refId: ref };
  // Every condition the UPDATE tests has just been shown to hold, so reaching
  // here means the row moved between the two statements. Named rather than
  // folded into one of the four above, because a reason that cannot happen and
  // then does is the one worth seeing in the log verbatim.
  return { ok: false, reason: 'raced', msg: 'Приглашение не записано', refId: ref };
}

// ── progression reads ───────────────────────────────────────────────────────

// Seven columns as the ONE map shape shared/definitions.js reads: the keys are
// UPGRADE_KEYS, and spentSkillPoints/availableSkillPoints/skillPointCeiling are
// all written against them. Named rather than inlined because spendUpgrade
// below now feeds the same shape to the same shared function the client's panel
// calls — two hand-rolled copies of this literal are two chances to leave a
// column out of one of them, and a column left out of the SUM is a point the
// server hands out for free.
function _upgradesOf(r) {
  return {
    atk: r.upg_atk, def: r.upg_def, hp: r.upg_hp,
    critChance: r.upg_crit_chance, critPower: r.upg_crit_power,
    atkSpeed: r.upg_atk_speed, hpRegen: r.upg_hp_regen,
  };
}

function _progress(r) {
  return {
    charClass: r.char_class,
    lvl: r.lvl, xp: Number(r.xp), xpNext: xpToNext(r.lvl),
    kills: Number(r.kills), hp: r.hp,
    bonusSP: r.bonus_sp, keptSP: r.kept_sp, empowers: r.empowers,
    upgrades: _upgradesOf(r),
    floor: r.floor, x: r.pos_x, y: r.pos_y,
    questIdx: r.quest_idx, questKills: r.quest_kills,
    buffs: r.buffs, potionBag: r.potion_bag, codex: r.codex,
    starterBonusClaimed: r.starter_bonus_claimed,
  };
}

async function progressOf(db, playerId) {
  const { rows } = await query(db, 'SELECT * FROM player_progress WHERE player_id = $1', [playerId]);
  if (rows.length) return _progress(rows[0]);
  // ── строки нет, а игрок есть ─────────────────────────────────────────────
  //   [act:killReward] TypeError: Cannot read properties of null (reading 'lvl')
  //
  // Убитый монстр, «Ошибка сервера» игроку, алерт операторам — и ни слова о
  // том, ЧЕЙ аккаунт сломан. Возвращать null было честно ровно для тех
  // вызывающих, кто это проверяет; из шестнадцати проверяют не все, и каждый
  // непроверивший падает вот так.
  //
  // Аккаунт без player_progress — это поломка, а не состояние: строку заводит
  // ensure на первом же входе. Она восстанавливается тем же способом и по той
  // же причине, по которой ensure зовёт свои INSERT ... ON CONFLICT DO NOTHING
  // на каждом входе, — и об этом остаётся след с номером игрока, потому что
  // тихое восстановление скрыло бы того, кто её удалил.
  console.error(`[players] нет player_progress у игрока ${playerId} — восстанавливаю`);
  await query(db, 'INSERT INTO player_progress (player_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [playerId]);
  const again = await query(db, 'SELECT * FROM player_progress WHERE player_id = $1', [playerId]);
  return again.rows.length ? _progress(again.rows[0]) : null;
}

async function prefsOf(db, playerId) {
  const { rows } = await query(db, 'SELECT * FROM player_prefs WHERE player_id = $1', [playerId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    lang: r.lang, hudPotion: r.hud_potion, autoHpPct: r.auto_hp_pct,
    autoSkillsOn: r.auto_skills_on, autoSkillOff: r.auto_skill_off,
    autoBuffTypes: r.auto_buff_types,
  };
}

// Studied skills and passives, in the shape the client already expects.
async function skillsOf(db, playerId) {
  const { rows } = await query(db,
    'SELECT kind, key, level FROM player_skills WHERE player_id = $1', [playerId]);
  const out = { skillLevels: {}, passiveLevels: {}, advSkillLearned: {}, advSkillActive: {} };
  for (const r of rows) {
    if (r.kind === 'skill') out.skillLevels[r.key] = r.level;
    else if (r.kind === 'passive') out.passiveLevels[r.key] = r.level;
    else if (r.kind === 'adv_learned') out.advSkillLearned[r.key] = r.level > 0;
    else if (r.kind === 'adv_active') out.advSkillActive[r.key] = r.level > 0;
  }
  return out;
}

// ── THE allow-list ──────────────────────────────────────────────────────────
// The only place a client-supplied value reaches the database.
//
// Six fields, each with its own validator. A key that is not in this table is
// not written — not because it is filtered out somewhere, but because nothing
// here would write it. There is no `{...raw}` and no dot-path.
//
// Unknown keys are counted and reported rather than throwing: a client running
// yesterday's bundle after a deploy will legitimately send a field this build
// has retired, and refusing its entire save over that would lose real
// settings. The count is what makes the difference between "expected drift"
// and "something is sending us junk" visible instead of guessed at.
const PREF_FIELDS = {
  lang:          { col: 'lang',            ok: v => ['ru','en','uk','es','tr','pt'].includes(v) },
  hudPotion:     { col: 'hud_potion',      ok: v => v === null || (typeof v === 'string' && v.length <= 32) },
  autoHpPct:     { col: 'auto_hp_pct',     ok: v => Number.isFinite(v) && v >= 0 && v <= 1 },
  autoSkillsOn:  { col: 'auto_skills_on',  ok: v => typeof v === 'boolean' },
  autoSkillOff:  { col: 'auto_skill_off',  ok: v => _smallMap(v, k => ['Q','W','E','R'].includes(k)) },
  autoBuffTypes: { col: 'auto_buff_types', ok: v => _smallMap(v, k => k.length <= 32) },
};

// A plain object, small, with keys the caller vouches for and boolean values.
// The size bound matches the column's CHECK so a payload that would be
// rejected by the database is rejected here first, with a message that says
// which field.
function _smallMap(v, keyOk) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > 16) return false;
  if (!keys.every(k => typeof k === 'string' && keyOk(k))) return false;
  return JSON.stringify(v).length < 512;
}

async function savePrefs(db, playerId, raw) {
  if (!raw || typeof raw !== 'object') return { written: 0, ignored: 0, rejected: [] };

  const sets = [], vals = [playerId];
  const rejected = [];
  let ignored = 0;

  for (const [key, value] of Object.entries(raw)) {
    // Object.hasOwn, not `PREF_FIELDS[key]`. A plain object inherits from
    // Object.prototype, so a lookup by "__proto__", "constructor", "toString"
    // or "valueOf" returns something TRUTHY that is not a field descriptor at
    // all — and JSON.parse produces "__proto__" as an own key, so a client can
    // send exactly that. The direct lookup crashed on `field.ok is not a
    // function`, which a caught-and-logged handler would have turned into a
    // save that silently never happened.
    //
    // This is the same class of mistake as the blob it replaces: treating
    // attacker-controlled strings as safe to index a structure with.
    const field = Object.hasOwn(PREF_FIELDS, key) ? PREF_FIELDS[key] : null;
    if (!field) { ignored++; continue; }            // not ours — see above
    if (!field.ok(value)) { rejected.push(key); continue; }
    vals.push(field.col === 'auto_skill_off' || field.col === 'auto_buff_types'
      ? JSON.stringify(value) : value);
    sets.push(`${field.col} = $${vals.length}`);
  }

  if (sets.length) {
    await query(db,
      `UPDATE player_prefs SET ${sets.join(', ')}, updated_at = now() WHERE player_id = $1`, vals);
  }
  return { written: sets.length, ignored, rejected };
}

// ── server-owned writes ─────────────────────────────────────────────────────
// Each of these exists because the server owns that rule. They take arguments,
// not a payload, so there is no shape for an extra field to arrive in.

// Position. Stored, never trusted: the floor is re-checked against level gates
// on the way back in (_restoreFloorFor), because the world can have moved on
// while the player was away.
async function savePosition(db, playerId, floor, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  await query(db, `
    UPDATE player_progress SET floor = $2, pos_x = $3, pos_y = $4, updated_at = now()
     WHERE player_id = $1`, [playerId, Math.trunc(floor) || 1, x, y]);
  return true;
}

async function setHp(db, playerId, hp) {
  await query(db, 'UPDATE player_progress SET hp = $2 WHERE player_id = $1',
    [playerId, Math.max(0, Math.trunc(hp) || 0)]);
}

async function setClass(db, playerId, charClass) {
  if (!CHAR_DEF[charClass]) throw new Error(`players: unknown class ${charClass}`);
  await query(db, `
    UPDATE player_progress SET char_class = $2, updated_at = now()
     WHERE player_id = $1 AND char_class IS NULL`, [playerId, charClass]);
}

// ── смена класса ────────────────────────────────────────────────────────────
// Всё, что зависит от класса, должно перестать зависеть от старого — и ничего
// сверх этого.
//
// Три вещи, и порядок между ними важен:
//
//   1. СНАРЯЖЕНИЕ ЧУЖОГО КЛАССА снимается в инвентарь. Не удаляется: человек
//      его добыл, и смена класса — не повод отнимать. Если места в инвентаре
//      нет, отказ приходит ДО списания денег: снять вещь некуда, а оставить
//      её надетой значит дать чужому классу чужие статы.
//   2. ИЗУЧЕННЫЕ НАВЫКИ стираются. Очки при этом возвращаются сами: их число
//      считается от уровня (availableSkillPoints), а не хранится колонкой.
//   3. КЛАСС меняется, и пересчитывается боевая мощь — она сортирует рейтинг.
//
// Не трогается ничего больше: уровень, опыт, вещи, валюта, клан, сезон,
// улучшения характеристик. Класс — это набор умений и то, чем можно
// пользоваться, а не прожитая жизнь.
async function changeClass(db, playerId, newClass) {
  // По месту, как и у соседей в этом файле: items требует players обратно, и
  // верхний require замкнул бы круг.
  await require('./items').lockPlayer(db, playerId);
  if (!Object.hasOwn(CHAR_DEF, newClass)) return { ok: false, code: 'bad_class' };

  const { rows: cur } = await query(db,
    'SELECT char_class FROM player_progress WHERE player_id = $1 FOR UPDATE', [playerId]);
  if (!cur.length || !cur[0].char_class) return { ok: false, code: 'no_class' };
  if (cur[0].char_class === newClass) return { ok: false, code: 'same_class' };

  // ── снаряжение снимает ИГРОК, а не сервер ────────────────────────────────
  // Требование владельца, и оно правильнее прежнего поведения. Снимая вещи за
  // человека, сервер решал за него, что переживёт смену, — молча и в одной
  // транзакции с оплатой. Теперь выбор делается до того, как деньги ушли, и
  // делает его тот, чьи это вещи.
  //
  // Проверяется ВСЁ надетое, а не только классовое: правило «снимите всю
  // экипировку» должно читаться буквально, иначе кто-то останется с надетым
  // кольцом и не поймёт, почему ему отказывают.
  const { rows: worn } = await query(db,
    `SELECT count(*)::int n FROM player_items
      WHERE player_id = $1 AND container = 'equipment'`, [playerId]);
  if (worn[0].n > 0) return { ok: false, code: 'has_equipment', worn: worn[0].n };

  // ── навыки и улучшения ПЕРЕНОСЯТСЯ ───────────────────────────────────────
  // Тоже требование владельца. Прежняя версия стирала player_skills, и очки
  // возвращались — теперь не трогается ничего: изученные навыки, их уровни,
  // продвинутые книги и все семь колонок улучшений переезжают как есть.
  //
  // ── и ПАССИВКИ тоже, а они переносятся не сами ──────────────────────────
  // «Пассивки не переносятся при смене.»
  //
  // Уровни оставались в базе — но переставали что-либо значить. У каждого
  // класса своя ЭКСКЛЮЗИВНАЯ пара пассивок со своими именами: у танка
  // 'tankatk'/'deftank', у рыцаря смерти 'dkatk'/'dkdef' и так далее.
  // Подсчёт бонусов перебирает пассивки НОВОГО класса и старых имён там не
  // находит: вложенные уровни лежат мёртвым грузом.
  //
  // Пары устроены одинаково у всех пяти классов — первая это +3% атаки за
  // уровень, вторая +3% защиты, — поэтому перенос честный: та же позиция, тот
  // же уровень, тот же эффект. Меняется только имя.
  //
  // Общие пассивки ('all*') ни к какому классу не привязаны и переносятся
  // сами; их эта правка не касается.
  {
    const from = PASSIVE_CLASS_DEF[cur[0].char_class] || [];
    const to = PASSIVE_CLASS_DEF[newClass] || [];
    for (let i = 0; i < Math.min(from.length, to.length); i++) {
      if (from[i].id === to[i].id) continue;
      // ON CONFLICT: у игрока может уже лежать строка пассивки нового класса —
      // например, он когда-то этим классом играл. Берётся БОЛЬШИЙ уровень:
      // отобрать вложенное у человека при переносе нельзя.
      await query(db, `
        INSERT INTO player_skills (player_id, kind, key, level)
        SELECT player_id, 'passive', $3, level FROM player_skills
         WHERE player_id = $1 AND kind = 'passive' AND key = $2
        ON CONFLICT (player_id, kind, key)
        DO UPDATE SET level = GREATEST(player_skills.level, EXCLUDED.level)`,
        [playerId, from[i].id, to[i].id]);
      await query(db, `
        DELETE FROM player_skills
         WHERE player_id = $1 AND kind = 'passive' AND key = $2`, [playerId, from[i].id]);
    }
  }
  await query(db, `
    UPDATE player_progress SET char_class = $2, updated_at = now()
     WHERE player_id = $1`, [playerId, newClass]);

  await require('./stats').refreshBm(db, playerId);
  return { ok: true, from: cur[0].char_class, to: newClass, unequipped: 0 };
}

// ── grantXp ─────────────────────────────────────────────────────────────────
// The server applies XP and runs the level curve. The client is told the
// result; it never proposes one.
//
// The whole loop happens inside ONE statement so that a level-up cannot be
// split across two writes — the old version's "xp saved, level not yet" window
// is what let a reconnect land between them and lose the level. plpgsql rather
// than a JS loop for the same reason: a round trip per level is a round trip
// per level, and a big quest reward can cross several at once.
async function grantXp(db, playerId, amount) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (!amt) return null;

  // The curve is xpToNext(lvl) from shared/definitions.js. It is evaluated in
  // JS and passed in as a lookup table rather than reimplemented in SQL: two
  // implementations of a level curve WILL drift, and the client already uses
  // this one.
  const { rows: cur } = await query(db,
    'SELECT lvl, xp, buffs FROM player_progress WHERE player_id = $1 FOR UPDATE', [playerId]);
  if (!cur.length) return null;

  // ── штраф за смерть ─────────────────────────────────────────────────────
  // «−50% опыта на 5 минут» — надпись на экране смерти, которая до сих пор не
  // значила ничего. Теперь значит. Срок лежит в player_progress.buffs, рядом
  // со сроками зелий, потому что вопрос к нему тот же: «до какой миллисекунды»
  // — и он так же обязан пережить перезаход.
  //
  // Считается ЗДЕСЬ, а не у четырёх вызывающих (убийство, доля группы, квест,
  // особый квест): четыре места — это четыре способа забыть. Возвращается и
  // то, сколько дошло на самом деле, иначе игроку в пакете уехало бы число до
  // штрафа — то есть ровно та ложь, которую здесь и убирают.
  const _until = Number((cur[0].buffs || {})[DEATH_XP_PENALTY_KEY] || 0);
  const granted = xpAfterDeathPenalty(amt, _until, Date.now());
  const penalty = granted < amt;

  let lvl = cur[0].lvl;
  let xp = Number(cur[0].xp) + granted;
  let gained = 0;
  // Bounded: the lvl column's CHECK stops at 1000, and a reward large enough
  // to cross a thousand levels is a bug worth capping rather than honouring.
  while (lvl < 1000 && xp >= xpToNext(lvl)) { xp -= xpToNext(lvl); lvl++; gained++; }

  await query(db, `
    UPDATE player_progress SET lvl = $2, xp = $3, updated_at = now()
     WHERE player_id = $1`, [playerId, lvl, xp]);

  // Battle Power is STORED (players.bm) and the rating board sorts on it, so
  // it has to be rewritten wherever one of its inputs moves — and level is its
  // largest single term. Here rather than at the call sites: four paths raise a
  // level (a kill, a party share, claimQuest, completeSpecialQuest) and only
  // the first ever refreshed, so levelling in a group or off a quest left the
  // board sorting the player at the rating they had before.
  //
  // Gated on an actual level-up, which is what keeps it off the per-kill path:
  // ordinary xp changes nothing battlePower() reads.
  if (gained > 0) await require('./stats').refreshBm(db, playerId);

  return { lvl, xp, xpNext: xpToNext(lvl), levelsGained: gained,
           granted, penalty, penaltyUntil: penalty ? _until : 0 };
}

// ── spendUpgrade ────────────────────────────────────────────────────────────
// Buys one point of a stat. The budget check and the increment are one
// statement under the row lock taken by the SELECT, so two clicks arriving
// together cannot both pass a check against the same remaining point.
//
// The point count comes from availableSkillPoints (shared/definitions.js) —
// THE function the client's own panel greys the button with. It used to be
// `skillPointBudget(lvl) + bonus_sp` written out here, with a comment claiming
// that was the same thing. It was not: the shared function also takes keptSP
// off BOTH sides of the sum, and this copy ignored the field entirely. For a
// legacy Перерождение record (kept_sp > 0) the panel therefore offered points
// the server then refused with «Мало очков навыка!», and the player's only
// evidence was a counter that said the points were there.
const UPG_COL = {
  atk: 'upg_atk', def: 'upg_def', hp: 'upg_hp', atkSpeed: 'upg_atk_speed',
  critChance: 'upg_crit_chance', critPower: 'upg_crit_power', hpRegen: 'upg_hp_regen',
};

async function spendUpgrade(db, playerId, key) {
  // Object.hasOwn for the same reason as PREF_FIELDS above: `UPG_COL['constructor']`
  // is truthy and would be interpolated straight into the UPDATE below.
  const col = Object.hasOwn(UPG_COL, key) ? UPG_COL[key] : null;
  if (!col) throw new Error(`players: unknown upgrade ${key}`);
  if (!UPGRADE_KEYS.includes(key)) throw new Error(`players: ${key} is not in UPGRADE_KEYS`);

  // The players row, before player_progress. This function now ends by writing
  // players.bm, and the kill path takes those two locks the other way round
  // (lockPlayer, then grantXp's FOR UPDATE) — buying a stat point while a kill
  // is in flight would be a lock cycle, which is the exact thing lockPlayer's
  // "FIRST statement" rule exists to make impossible. empower below already
  // opens this way.
  await require('./items').lockPlayer(db, playerId);

  // Every column the point count is derived from, plus upg_epoch, in ONE read
  // under ONE lock. The seven upgrade columns used to be summed by the database
  // and the stat's own level fetched by a second SELECT; both are here now
  // because availableSkillPoints wants the map rather than the sum, and the
  // second round trip was reading the same row inside the same transaction.
  const { rows } = await query(db, `
    SELECT lvl, bonus_sp, kept_sp, upg_epoch,
           upg_atk, upg_def, upg_hp, upg_atk_speed,
           upg_crit_chance, upg_crit_power, upg_hp_regen
      FROM player_progress WHERE player_id = $1 FOR UPDATE`, [playerId]);
  if (!rows.length) return null;
  const r = rows[0];
  const avail = availableSkillPoints({
    lvl: r.lvl, bonusSP: r.bonus_sp, keptSP: r.kept_sp, upgrades: _upgradesOf(r),
  });
  if (avail <= 0) return null;                         // no points left

  // The gold. money.spend fuses affordability and deduction into one
  // statement, so an unaffordable upgrade cannot half-apply.
  //
  // ── the idem key, and why it carries the epoch ───────────────────────────
  // It used to be `upg:<pid>:<stat>:<current level>` and nothing else, which
  // made it REPLAYABLE: resetUpgrades puts every upg_* column back to 0, the
  // ledger is append-only, so buying atk after a reset produced `upg:<pid>:
  // atk:0` — a key that was already there. money.spend then takes its `replay`
  // branch and returns { balance, replayed: true }, which is TRUTHY, so the
  // `if (!paid)` below waved it through and the point was granted for nothing.
  // Measured on the live schema: 3 points cost 1800 gold, and 3 more after a
  // reset cost 0. money.reconcile() cannot see it either — the replay branch
  // writes NOTHING, so balance and ledger stay in perfect agreement.
  //
  // Two components, and both are needed:
  //
  //   e<upg_epoch>  which reset generation this is. Bumped by resetUpgrades in
  //                 the same UPDATE that zeroes the columns, so a level of 0
  //                 seen after a reset is never the same key as the 0 before
  //                 it. resetUpgrades is the ONLY writer that lowers an upg_*
  //                 column, which is what makes one counter enough.
  //   <level>       which point WITHIN this generation. Without it the second
  //                 purchase of the same stat in one generation would reuse
  //                 the first one's key and be free — the same bug one step
  //                 down.
  //
  // Both are read under the FOR UPDATE above, from the row this transaction
  // holds. That is what makes the key deterministic across a txRetry attempt
  // (the retry runs after a rollback, re-reads the same two values, composes
  // the same string) while still differing between two real purchases. A
  // random or time-based key would have the opposite pair of properties — see
  // the "bad" example in repos/money.js.
  const cur = Number(r[col]) || 0;
  const cost = upgradeCost(cur);
  const money = require('./money');
  let goldLeft = null;
  if (cost > 0) {
    const paid = await money.spend(db, playerId, 'gold', cost, {
      reason: 'upgrade', refType: 'upgrade', refId: key,
      idemKey: `upg:${playerId}:${key}:e${r.upg_epoch}:${cur}`,
    });
    // spend() returns null when the balance could not cover it — that is the
    // whole affordability check, fused into the UPDATE so two purchases in the
    // same instant cannot both pass against the same gold.
    if (!paid) return null;
    goldLeft = paid.balance;
  }

  const { rows: out } = await query(db, `
    UPDATE player_progress SET ${col} = ${col} + 1, updated_at = now()
     WHERE player_id = $1 RETURNING ${col} AS v`, [playerId]);
  // All seven upgrade columns are battlePower() inputs — four through atk/def/
  // maxHp and the other four as its `extras` term — so a point bought here is
  // rating the board has to see. Only on the success path: the three returns
  // above moved nothing.
  await require('./stats').refreshBm(db, playerId);
  return { key, level: out[0].v, remaining: avail - 1, cost, gold: goldLeft };
}

// ── skills ──────────────────────────────────────────────────────────────────
// Levels are bounded by the database (player_skills CHECK level 0..99) and by
// the game's own maxima here. The old model stored these in a client-written
// map, so "my passive rolled back" was a whole class of report; a row the
// client cannot address has nothing to roll back.
async function setSkillLevel(db, playerId, kind, key, level) {
  const max = kind === 'passive' ? PASSIVE_MAX_LEVEL
            : kind === 'skill'   ? SKILL_MAX_LEVEL : 1;
  const lv = Math.max(0, Math.min(max, Math.floor(Number(level) || 0)));
  await query(db, `
    INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1, $2, $3, $4)
    ON CONFLICT (player_id, kind, key) DO UPDATE SET level = EXCLUDED.level`,
    [playerId, kind, key, lv]);
  return lv;
}

// Raises a skill by one, never past its maximum, and reports whether it moved.
// Returning the fact rather than throwing lets the caller answer "already at
// max" without treating it as an error.
async function bumpSkill(db, playerId, kind, key) {
  const max = kind === 'passive' ? PASSIVE_MAX_LEVEL
            : kind === 'skill'   ? SKILL_MAX_LEVEL : 1;
  const { rows } = await query(db, `
    INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1, $2, $3, 1)
    ON CONFLICT (player_id, kind, key) DO UPDATE
      SET level = player_skills.level + 1
      WHERE player_skills.level < $4
    RETURNING level`, [playerId, kind, key, max]);
  if (!rows.length) return { level: max, changed: false };
  // A PASSIVE is a battlePower() input and an active skill is not: passives
  // multiply atk, def and maxHp (passiveBonusTotal, repos/stats.js), while a
  // Q/W/E/R level only decides a damage coefficient in combat. Studying
  // "Кровавая ярость" to 10 really does raise a character's rating, and
  // without this it raised it only on paper.
  if (kind === 'passive') await require('./stats').refreshBm(db, playerId);
  return { level: rows[0].level, changed: true };
}

// Кто привёл этого игрока — ник, а не id: сообщение операторам читает человек,
// и @ник в нём кликабелен, а число нет. referred_by хранит telegram_id, так что
// это соединение с той же таблицей по нему.
//
// Возвращает null, когда пригласившего нет (органика) ИЛИ когда его аккаунт
// удалён: и то и другое честно означает «сказать некого».
async function referrerOf(db, playerId) {
  const { rows } = await query(db, `
    SELECT r.username, r.telegram_id
      FROM players p
      JOIN players r ON r.telegram_id = p.referred_by
     WHERE p.id = $1`, [playerId]);
  return rows.length ? { username: rows[0].username, telegramId: rows[0].telegram_id } : null;
}

// ── empower (Усиление) ──────────────────────────────────────────────────────
// Grants permanent bonus skill points for a materials cost that grows with how
// many empowerments have already happened. Everything in one transaction: the
// materials must not leave the bag unless the points land, and the counter must
// not advance unless both did — otherwise the price ladder steps forward for an
// empowerment the player never got.
//
// Nothing is reset. This replaced Перерождение, which dropped the character to
// level 1 and moved the committed upgrade spend into kept_sp; an empowerment
// leaves level, XP, stats and upgrades exactly as they are, so kept_sp is not
// written here at all. It stays a read-only field carrying the records of
// players who really did rebirth — see the note in shared/definitions.js.
//
// TWO ceilings are checked under the same row lock that charges: the level
// floor and `maxCount`. The count check has to be here rather than in the
// handler, because the handler reads the count outside the transaction: two
// clicks racing on empowerment 30 would both pass a check made up there and
// both charge.
async function empower(db, playerId, cost, { minLevel, bonusSp, maxCount }) {
  const items = require('./items');
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT lvl, empowers, bonus_sp, kept_sp
      FROM player_progress WHERE player_id = $1 FOR UPDATE`, [playerId]);
  if (!rows.length) throw Object.assign(new Error('Игрок не найден'), { code: 'no_player' });
  const st = rows[0];
  if (st.lvl < minLevel) {
    throw Object.assign(new Error(`Нужен ${minLevel} уровень`), { code: 'low_level', userMessage: `Нужен ${minLevel} уровень` });
  }
  if (maxCount != null && st.empowers >= maxCount) {
    throw Object.assign(new Error('Достигнут предел усилений'),
      { code: 'max_empowers', userMessage: `Больше ${maxCount} усилений не бывает` });
  }

  for (const [itemId, need] of Object.entries(cost)) {
    if (!await items.removeQty(db, playerId, itemId, need)) {
      throw Object.assign(new Error(`Не хватает: ${itemId}`), { code: 'no_mats', userMessage: `Не хватает материалов: ${itemId}` });
    }
  }

  const { rows: out } = await query(db, `
    UPDATE player_progress
       SET empowers = empowers + 1,
           bonus_sp = bonus_sp + $2,
           updated_at = now()
     WHERE player_id = $1
    RETURNING lvl, empowers, bonus_sp, kept_sp`, [playerId, bonusSp]);

  // Боевая мощь не меняется — усиление не трогает ни уровень, ни улучшения, а
  // только выдаёт нераспределённые очки. refreshBm сработает сам, когда игрок
  // эти очки вложит: там же, где и любая другая покупка улучшения.

  return {
    empowers: out[0].empowers, bonusSP: out[0].bonus_sp, keptSP: out[0].kept_sp,
    lvl: out[0].lvl,
  };
}

// ── resetUpgrades ───────────────────────────────────────────────────────────
// Refunds every spent point for a Nexum fee. `spent > 0` is checked inside the
// same transaction as the charge, so a double-click cannot pay twice for one
// reset — the second finds nothing spent.
async function resetUpgrades(db, playerId, cost) {
  const money = require('./money');
  // Same reason as spendUpgrade: this ends by writing players.bm, so the
  // players row is taken before player_progress and the lock order stays the
  // one every other path uses.
  await require('./items').lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT lvl, bonus_sp, kept_sp, upg_epoch,
           upg_atk + upg_def + upg_hp + upg_atk_speed
         + upg_crit_chance + upg_crit_power + upg_hp_regen AS spent
      FROM player_progress WHERE player_id = $1 FOR UPDATE`, [playerId]);
  if (!rows.length) throw Object.assign(new Error('Игрок не найден'), { code: 'no_player' });
  if (Number(rows[0].spent) <= 0) {
    throw Object.assign(new Error('Улучшений нет'), { code: 'nothing', userMessage: 'Улучшений нет — сбрасывать нечего' });
  }

  const paid = await money.spend(db, playerId, 'nexum', cost, {
    reason: 'upgrade_reset', refType: 'player', refId: String(playerId),
    // The epoch BEFORE the bump below, and it replaced a randomUUID() whose
    // comment read "Random per attempt: resetting twice on purpose is two
    // legitimate resets". The goal was right and the means were exactly
    // backwards: a key that differs per ATTEMPT is a key that a txRetry retry
    // cannot recognise, which is the "bad" example in repos/money.js. What is
    // wanted is a key that differs per ACTION — and the epoch is that, because
    // the UPDATE below advances it, in this transaction, as part of the same
    // statement that spends it. Two deliberate resets read two different
    // epochs; two attempts at one reset read the same one, since the rollback
    // that precedes a retry takes the bump with it.
    idemKey: `upgrade_reset:${playerId}:e${rows[0].upg_epoch}`,
  });
  if (!paid) throw Object.assign(new Error('Недостаточно Liberty'), { code: 'no_nexum', userMessage: 'Недостаточно Liberty' });

  // ── kept_sp: закрыть обязательство, но не сжечь ёмкость ────────────────────
  // Прежний код ставил здесь kept_sp = 0 и объяснял это так: «kept_sp уходит
  // вместе с картой, которую он покрывал». Для ПОТОЛКА анти-чита
  // (skillPointCeiling) это верно и остаётся верным. Для того, сколько очков
  // игрок вообще может потратить, — нет, и разница стоила игрокам очков.
  //
  // Ёмкость до сброса — bonusSP + max(budget, kept), где budget =
  // skillPointBudget(lvl): kept вычитается из ОБЕИХ сторон суммы в
  // availableSkillPoints, то есть перенесённая трата не считается против
  // игрока, но и кривая уровня, которая её покрывает, тоже не считается за
  // него. После голого kept_sp = 0 ёмкость становится bonusSP + budget. Пока
  // kept ≤ budget это одно и то же число и терялось ровно ничего — но у
  // легась-записи «Перерождения», которая ещё не перелевелилась обратно,
  // kept > budget, и разница исчезала навсегда. Уровень 1, bonusSP 15,
  // keptSP 30, потрачено 30: было 45 очков ёмкости, стало 18. Двадцать семь
  // очков, за которые игрок заплатил 200 Liberty, чтобы их лишиться.
  //
  // Переносим НЕПОКРЫТЫЙ кривой остаток в bonus_sp. Это ровно та часть kept,
  // которая ещё давала ёмкость, поэтому сумма до и после совпадает, а поле
  // «Перерождения» на этом аккаунте закрывается навсегда — обязательства
  // больше нет, есть выданные очки.
  //
  // НЕ `bonus_sp + kept_sp` целиком, хотя так короче. Кривая уровня уже
  // оплатила min(budget, kept) из этой траты; выдав их ещё раз, сброс за
  // 200 Liberty ПЕЧАТАЛ БЫ очки — у записи 100-го уровня с kept 150 это 150
  // очков из воздуха. Это тот же класс ошибки, что и бесплатные улучшения
  // выше, только в другую сторону, и ночная сверка его тоже не увидит:
  // skill points в ledger не лежат.
  //
  // Кривая считается тем же skillPointBudget, что и у клиента, и в JS, а не в
  // SQL, — по той же причине, что и в grantXp: две реализации одной кривой
  // РАЗОЙДУТСЯ.
  const carried = Math.max(0, Number(rows[0].kept_sp) - skillPointBudget(rows[0].lvl));

  // Одним оператором: обнуление карты, перенос kept и шаг эпохи. Порознь они
  // были бы состоянием «улучшения обнулены, а эпоха ещё старая» — то есть
  // ровно тем окном, в котором ключ покупки повторяется, ради закрытия
  // которого всё это и написано.
  const { rows: out } = await query(db, `
    UPDATE player_progress
       SET upg_atk = 0, upg_def = 0, upg_hp = 0, upg_atk_speed = 0,
           upg_crit_chance = 0, upg_crit_power = 0, upg_hp_regen = 0,
           bonus_sp  = bonus_sp + $2,
           kept_sp   = 0,
           upg_epoch = upg_epoch + 1,
           updated_at = now()
     WHERE player_id = $1
    RETURNING bonus_sp`, [playerId, carried]);

  // Seven columns just went to zero. The refund buys the points back, but the
  // rating that was standing on them is gone until they are re-spent.
  await require('./stats').refreshBm(db, playerId);

  // Named as the client reads them. It destructures
  // { pointsReturned, keptSP, newNexumBalance } — `refunded`/`nexumLeft`
  // arrived as three undefineds, which set the on-screen Liberty balance to
  // undefined every time somebody reset their upgrades.
  //
  // bonusSP rides along because this call can now MOVE points into it, and the
  // caller is the only one who can see that it did. The client does not
  // destructure it and does not need to — progressSync, which the handler
  // pushes just before emitting this, already carries the new figure — but a
  // field that reports what a reset DID is what lets the regression check in
  // dev/consumables-check.js assert the carry directly instead of inferring it
  // from a second read.
  return {
    pointsReturned: Number(rows[0].spent),
    keptSP: 0,
    bonusSP: out[0].bonus_sp,
    newNexumBalance: paid.balance,
    refunded: Number(rows[0].spent),      // the old names, for the tests
    nexumLeft: paid.balance,
  };
}

// Telegram id -> internal player id.
//
// The shipped client names OTHER players by telegram id everywhere — clanKick,
// clanApprove, clanStorageGive, requestPlayerProfile. Internally nothing else
// does: every foreign key points at players.id, which is why the repositories
// take that. The translation belongs here, at the edge, done once against the
// database rather than by trusting a client-supplied mapping.
async function idByTelegram(db, telegramId) {
  const tg = String(telegramId == null ? '' : telegramId);
  if (!tg) return null;
  const { rows } = await query(db, 'SELECT id FROM players WHERE telegram_id = $1', [tg]);
  return rows.length ? Number(rows[0].id) : null;
}

module.exports = {
  realPlayerSql,
  idByTelegram,
  byTelegramId, ensure, setUsername, registerReferral, changeClass,
  canMessage, setWriteAccess,
  tonAddressOf, setTonAddress, clearTonAddress,
  progressOf, prefsOf, skillsOf,
  savePrefs, PREF_FIELDS,
  savePosition, setHp, setClass,
  grantXp, spendUpgrade,
  setSkillLevel, bumpSkill,
  referrerOf,
  empower, resetUpgrades,
};
