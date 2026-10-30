'use strict';
// ── Рейтинг турнира ─────────────────────────────────────────────────────────
// Кто сколько набрал (tournament_rating) и журнал начислений
// (tournament_score_log, миграция 046). Очки: любая победа в матче —
// TOURNAMENT_POINTS_PER_WIN, победа в турнире — TOURNAMENT_POINTS_PER_TITLE
// сверху. Участие само очков не даёт, но заносит в рейтинг — «в рейтинг
// попадают все».
//
// Начисление идёт по telegram id: тот, кто перезагружался, пока решался его
// бой, всё равно получает очко. Ключ (турнир, игрок, ref) — повтор того же
// начисления ничего не меняет.

const { query, tx, hasColumn } = require('../index');
const { TOURNAMENT_POINTS_PER_WIN, TOURNAMENT_POINTS_PER_TITLE, TOURNAMENT_CLAN_XP_PER_WIN, TOURNAMENT_CLAN_XP_FINAL } = require('../../../shared/definitions');

async function ready() { return hasColumn('tournament_rating', 'points'); }

// delta: { played?, wins?, titles?, final? } — по единице каждого.
// Победа в бою ещё и двигает клан победителя: +TOURNAMENT_CLAN_XP_PER_WIN
// опыта (победа в гранд-финале, final, — TOURNAMENT_CLAN_XP_FINAL), в этой же транзакции — повтор того же начисления (строка журнала
// уже есть) не даст клану второй раз.
async function score(telegramId, runId, ref, delta = {}) {
  if (!await ready()) return null;
  const wins = delta.wins ? 1 : 0, titles = delta.titles ? 1 : 0, played = delta.played ? 1 : 0;
  const points = wins * TOURNAMENT_POINTS_PER_WIN + titles * TOURNAMENT_POINTS_PER_TITLE;
  const res = await tx(async (t) => {
    const { rows: p } = await query(t, 'SELECT id FROM players WHERE telegram_id = $1', [String(telegramId)]);
    if (!p.length) return null;
    const pid = Number(p[0].id);
    const { rowCount } = await query(t, `
      INSERT INTO tournament_score_log (run_id, player_id, ref, points) VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING`, [runId, pid, ref, points]);
    if (!rowCount) return null;
    const { rows } = await query(t, `
      INSERT INTO tournament_rating (player_id, points, wins, titles, played) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (player_id) DO UPDATE SET
        points = tournament_rating.points + EXCLUDED.points,
        wins = tournament_rating.wins + EXCLUDED.wins,
        titles = tournament_rating.titles + EXCLUDED.titles,
        played = tournament_rating.played + EXCLUDED.played,
        updated_at = now()
      RETURNING points`, [pid, points, wins, titles, played]);
    let clan = null;
    if (wins) {
      const clans = require('./clans');
      const m = await clans.clanOf(t, pid);
      const amount = delta.final ? TOURNAMENT_CLAN_XP_FINAL : TOURNAMENT_CLAN_XP_PER_WIN;
      const xp = m ? await clans.addBonusXp(t, m.clanId, pid, 'tournament', amount) : null;
      if (xp) clan = { clanId: m.clanId, ...xp };
    }
    return { playerId: pid, points: Number(rows[0].points), clan };
  });
  // Новый уровень клана — новый % атаки в БМ каждого участника.
  if (res && res.clan && res.clan.leveledUp) await require('./clans').refreshMembersBm(res.clan.clanId);
  return res;
}

// Таблица для окна: первые `limit` и место самого игрока, если он ниже.
// realPlayerSql — тот же фильтр тестовых аккаунтов, что у прочих рейтингов.
async function top(db, myPlayerId, limit = 100) {
  if (!await ready()) return { ready: false, rows: [], me: null };
  const real = require('./players').realPlayerSql('p');
  const { rows } = await query(db, `
    SELECT r.player_id, p.username, r.points, r.wins, r.titles, r.played, pp.char_class
      FROM tournament_rating r
      JOIN players p ON p.id = r.player_id AND ${real}
      LEFT JOIN player_progress pp ON pp.player_id = r.player_id
     ORDER BY r.points DESC, r.titles DESC, r.wins DESC, r.updated_at ASC
     LIMIT $1`, [limit]);
  const map = r => ({
    playerId: Number(r.player_id), username: r.username, points: Number(r.points),
    wins: Number(r.wins), titles: Number(r.titles), played: Number(r.played), charClass: r.char_class,
  });
  let me = null;
  if (myPlayerId) {
    const { rows: m } = await query(db, `
      SELECT r.points, r.wins, r.titles, r.played,
             (SELECT count(*)::int FROM tournament_rating q
               WHERE q.points > r.points
                  OR (q.points = r.points AND q.titles > r.titles)
                  OR (q.points = r.points AND q.titles = r.titles AND q.wins > r.wins)) + 1 AS rank
        FROM tournament_rating r WHERE r.player_id = $1`, [myPlayerId]);
    if (m.length) me = { rank: m[0].rank, points: Number(m[0].points), wins: Number(m[0].wins), titles: Number(m[0].titles), played: Number(m[0].played) };
  }
  return { ready: true, rows: rows.map(map), me };
}

module.exports = { ready, score, top };
