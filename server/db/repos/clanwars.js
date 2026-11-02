'use strict';
// ── Войны кланов ────────────────────────────────────────────────────────────
// Таблица clan_wars (миграция 051). Объявляет лидер клана CLAN_WAR_MIN_LEVEL+
// уровня; принимает или отклоняет лидер того, кому объявили; отозвать
// непринятое может объявивший; закончить идущую — любой из двух лидеров.
// Пока война 'active', убийство врага не даёт кармы (server/karma.js).

const { query, hasColumn } = require('../index');
const { CLAN_WAR_MIN_LEVEL } = require('../../../shared/definitions');
const { levelFor } = require('./clans');

class ClanWarError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new ClanWarError(code, msg); };

async function ready() { return hasColumn('clan_wars', 'status'); }

// ── идущие войны в памяти ───────────────────────────────────────────────────
// Каждый удар по игроку спрашивает «враги ли они по войне» — в базу на это
// не ходят. Набор пар загружается при старте (loadCache, server/app.js) и
// правится здесь же, когда война начинается или кончается.
const _pairs = new Set();
const _key = (a, b) => (Number(a) < Number(b) ? `${a}:${b}` : `${b}:${a}`);
async function loadCache(db = null) {
  if (!await ready()) return 0;
  const { rows } = await query(db, `SELECT from_clan, to_clan FROM clan_wars WHERE status = 'active'`);
  _pairs.clear();
  for (const r of rows) _pairs.add(_key(Number(r.from_clan), Number(r.to_clan)));
  return _pairs.size;
}
function atWarCached(clanA, clanB) {
  if (!clanA || !clanB || Number(clanA) === Number(clanB)) return false;
  return _pairs.has(_key(Number(clanA), Number(clanB)));
}

// Клан и роль игрока — или отказ, если он не лидер.
async function _leaderClan(db, playerId) {
  const { rows } = await query(db, `
    SELECT c.id, c.name, c.xp, m.role FROM clan_members m JOIN clans c ON c.id = m.clan_id
     WHERE m.player_id = $1`, [playerId]);
  if (!rows.length) err('no_clan', 'Вы не в клане');
  if (rows[0].role !== 'leader') err('not_leader', 'Только лидер клана');
  return { id: Number(rows[0].id), name: rows[0].name, level: levelFor(Number(rows[0].xp)) };
}

async function _war(db, warId, { lock = false } = {}) {
  const id = Math.floor(Number(warId));
  if (!Number.isSafeInteger(id) || id <= 0) err('no_war', 'Война не найдена');
  const { rows } = await query(db, `
    SELECT id, from_clan, to_clan, status FROM clan_wars WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows.length) err('no_war', 'Война не найдена');
  const r = rows[0];
  return { id: Number(r.id), from: Number(r.from_clan), to: Number(r.to_clan), status: r.status };
}

// Объявить войну клану по имени.
async function declare(db, playerId, targetName) {
  if (!await ready()) err('off', 'Войны кланов ещё не включены на сервере');
  const me = await _leaderClan(db, playerId);
  if (me.level < CLAN_WAR_MIN_LEVEL) err('low_level', `Объявить войну может клан ${CLAN_WAR_MIN_LEVEL}+ уровня`);
  const name = String(targetName || '').trim();
  if (!name) err('no_target', 'Введите название клана');
  const { rows } = await query(db, 'SELECT id, name FROM clans WHERE name = $1', [name]);
  if (!rows.length) err('no_target', `Клан «${name}» не найден`);
  const target = { id: Number(rows[0].id), name: rows[0].name };
  if (target.id === me.id) err('self', 'Нельзя объявить войну своему клану');
  const { rows: open } = await query(db, `
    SELECT status FROM clan_wars
     WHERE LEAST(from_clan, to_clan) = LEAST($1::bigint, $2::bigint)
       AND GREATEST(from_clan, to_clan) = GREATEST($1::bigint, $2::bigint)
       AND status IN ('pending', 'active')`, [me.id, target.id]);
  if (open.length) err('exists', open[0].status === 'active' ? 'Война с этим кланом уже идёт' : 'Вызов этому клану уже отправлен');
  const { rows: ins } = await query(db, `
    INSERT INTO clan_wars (from_clan, to_clan) VALUES ($1, $2) RETURNING id`, [me.id, target.id]);
  return { id: Number(ins[0].id), from: me.id, to: target.id, fromName: me.name, toName: target.name };
}

async function accept(db, playerId, warId) {
  if (!await ready()) err('off', 'Войны кланов ещё не включены на сервере');
  const me = await _leaderClan(db, playerId);
  const w = await _war(db, warId, { lock: true });
  if (w.to !== me.id) err('not_yours', 'Этот вызов не вашему клану');
  if (w.status !== 'pending') err('closed', 'Вызов уже закрыт');
  await query(db, `UPDATE clan_wars SET status = 'active', accepted_at = now() WHERE id = $1`, [w.id]);
  _pairs.add(_key(w.from, w.to));
  return { ...w, status: 'active' };
}

async function decline(db, playerId, warId) {
  const me = await _leaderClan(db, playerId);
  const w = await _war(db, warId, { lock: true });
  if (w.status !== 'pending') err('closed', 'Вызов уже закрыт');
  if (w.to === me.id) {
    await query(db, `UPDATE clan_wars SET status = 'declined', ended_at = now() WHERE id = $1`, [w.id]);
    return { ...w, status: 'declined' };
  }
  if (w.from === me.id) {
    await query(db, `UPDATE clan_wars SET status = 'cancelled', ended_at = now() WHERE id = $1`, [w.id]);
    return { ...w, status: 'cancelled' };
  }
  err('not_yours', 'Этот вызов не вашего клана');
}

async function end(db, playerId, warId) {
  const me = await _leaderClan(db, playerId);
  const w = await _war(db, warId, { lock: true });
  if (w.from !== me.id && w.to !== me.id) err('not_yours', 'Это не война вашего клана');
  if (w.status !== 'active') err('closed', 'Война уже не идёт');
  await query(db, `UPDATE clan_wars SET status = 'ended', ended_at = now() WHERE id = $1`, [w.id]);
  _pairs.delete(_key(w.from, w.to));
  return { ...w, status: 'ended' };
}

// Открытые войны и вызовы клана — для окна и для мечей над врагами.
async function listFor(db, clanId) {
  if (!clanId || !await ready()) return { ready: false, wars: [], enemies: [] };
  const { rows } = await query(db, `
    SELECT w.id, w.from_clan, w.to_clan, w.status, w.created_at, w.accepted_at,
           cf.name AS from_name, ct.name AS to_name
      FROM clan_wars w
      JOIN clans cf ON cf.id = w.from_clan
      JOIN clans ct ON ct.id = w.to_clan
     WHERE (w.from_clan = $1 OR w.to_clan = $1) AND w.status IN ('pending', 'active')
     ORDER BY w.status = 'active' DESC, w.created_at DESC`, [clanId]);
  const wars = rows.map(r => {
    const mine = Number(r.from_clan) === Number(clanId);
    return {
      id: Number(r.id), status: r.status, outgoing: mine,
      enemyId: Number(mine ? r.to_clan : r.from_clan), enemyName: mine ? r.to_name : r.from_name,
      since: r.accepted_at || r.created_at,
    };
  });
  return { ready: true, wars, enemies: wars.filter(w => w.status === 'active').map(w => w.enemyName) };
}

async function atWar(db, clanA, clanB) {
  if (!clanA || !clanB || Number(clanA) === Number(clanB) || !await ready()) return false;
  const { rows } = await query(db, `
    SELECT 1 FROM clan_wars
     WHERE status = 'active'
       AND LEAST(from_clan, to_clan) = LEAST($1::bigint, $2::bigint)
       AND GREATEST(from_clan, to_clan) = GREATEST($1::bigint, $2::bigint)
     LIMIT 1`, [clanA, clanB]);
  return rows.length > 0;
}

module.exports = { ready, declare, accept, decline, end, listFor, atWar, loadCache, atWarCached, ClanWarError };
