'use strict';
// ── Боевой пропуск ──────────────────────────────────────────────────────────
// Что за задания и что за них дают — shared/definitions.js
// (BATTLE_PASS_TASKS). Здесь — счётчики (bumpIn), покупка премиума (buy) и
// выдача наград (claim/claimAll). Всё — в транзакции вызывающего.
//
// Счётчики не заводят своих точек в коде игры: bumpIn зовут те же места,
// что двигают достижения (server/achievements.js) и сезонные задания
// (server/season-tasks.js), — там уже стоит вызов на каждое нужное событие.
// Метрики, которых нет ни в одном задании, не пишутся вовсе.

const crypto = require('crypto');
const { query, hasColumn } = require('./db');
const items = require('./db/repos/items');
const money = require('./db/repos/money');
const runes = require('./db/repos/runes');
const {
  BATTLE_PASS_SEASON, BATTLE_PASS_PRICE, BATTLE_PASS_TASKS, BP_USED_METRICS, bpTaskByN,
  HELPERS, SEASON_END_AT, seasonActive,
} = require('../shared/definitions');

class BattlePassError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new BattlePassError(code, msg); };

async function ready() { return hasColumn('player_battlepass', 'season'); }

// Задания, у которых этот счётчик только что дошёл до цели.
function _opened(metric, was, now) {
  return BATTLE_PASS_TASKS.filter(x => x.metric === metric && was < x.target && now >= x.target);
}

// +amount к метрике. s — сессия (нужен playerId; socket — чтобы сказать
// игроку «задание выполнено»). Тихо ничего не делает вне сезона, до миграции
// и для метрик, которых ни одно задание не ждёт.
async function bumpIn(t, s, metric, amount = 1) {
  const n = Math.floor(Number(amount) || 0);
  if (!(n > 0) || !BP_USED_METRICS.has(metric)) return null;
  if (!s || !s.playerId || !seasonActive()) return null;
  if (!await ready()) return null;
  const { rows } = await query(t, `
    INSERT INTO player_battlepass (player_id, season, progress)
    VALUES ($1, $2, jsonb_build_object($3::text, $4::bigint))
    ON CONFLICT (player_id, season) DO UPDATE
      SET progress = jsonb_set(player_battlepass.progress, ARRAY[$3::text],
            to_jsonb(COALESCE((player_battlepass.progress->>$3)::bigint, 0) + $4::bigint)),
          updated_at = now()
    RETURNING (progress->>$3)::bigint AS now`, [s.playerId, BATTLE_PASS_SEASON, metric, n]);
  const now = Number(rows[0].now), was = now - n;
  const opened = _opened(metric, was, now);
  if (opened.length && s.socket) s.socket.emit('bpTaskDone', { tasks: opened.map(x => x.n) });
  return { metric, was, now };
}

async function _row(db, playerId, { lock = false } = {}) {
  const { rows } = await query(db, `
    SELECT premium, progress, claimed_free, claimed_prem FROM player_battlepass
     WHERE player_id = $1 AND season = $2${lock ? ' FOR UPDATE' : ''}`, [playerId, BATTLE_PASS_SEASON]);
  if (!rows.length) return { premium: false, progress: {}, claimedFree: [], claimedPrem: [] };
  const r = rows[0];
  return {
    premium: !!r.premium, progress: r.progress || {},
    claimedFree: (r.claimed_free || []).map(Number), claimedPrem: (r.claimed_prem || []).map(Number),
  };
}

async function stateOf(db, playerId) {
  const base = { season: BATTLE_PASS_SEASON, price: BATTLE_PASS_PRICE, endAt: SEASON_END_AT, active: seasonActive() };
  if (!await ready()) return { ...base, ready: false, premium: false, progress: {}, claimedFree: [], claimedPrem: [] };
  return { ...base, ready: true, ...(await _row(db, playerId)) };
}

// Покупка премиума: 7 GRAM, один раз за сезон. Строка берётся FOR UPDATE —
// два нажатия подряд не спишут дважды; idemKey у money.spend — вторая защита.
async function buy(db, playerId) {
  if (!await ready()) err('off', 'Боевой пропуск ещё не включён на сервере');
  if (!seasonActive()) err('season_over', 'Сезон завершён — пропуск больше не продаётся');
  await query(db, `
    INSERT INTO player_battlepass (player_id, season) VALUES ($1, $2)
    ON CONFLICT (player_id, season) DO NOTHING`, [playerId, BATTLE_PASS_SEASON]);
  const cur = await _row(db, playerId, { lock: true });
  if (cur.premium) err('have_pass', 'Боевой пропуск уже куплен');
  const paid = await money.spend(db, playerId, 'gram', BATTLE_PASS_PRICE, {
    reason: 'battle_pass', refType: 'battle_pass', refId: String(BATTLE_PASS_SEASON),
    idemKey: `battle_pass:${BATTLE_PASS_SEASON}:${playerId}`,
  });
  if (!paid) err('no_gram', `Нужно ${BATTLE_PASS_PRICE} GRAM`);
  await query(db, `
    UPDATE player_battlepass SET premium = true, premium_at = now(), updated_at = now()
     WHERE player_id = $1 AND season = $2`, [playerId, BATTLE_PASS_SEASON]);
  return { premium: true };
}

// Выдать одну награду. Нет места в сумке — бросок: транзакция откатит и
// отметку «забрано», и награду можно будет забрать снова.
async function _grant(db, playerId, r, ref, idem) {
  const noRoom = () => err('no_room', 'Инвентарь полон — освободите место и заберите награду снова');
  if (r.t === 'item') {
    const rowId = await items.add(db, playerId, r.id, { qty: r.qty || 1, source: 'battle_pass', sourceRef: ref });
    if (rowId === null) noRoom();
    return { t: 'item', id: r.id, qty: r.qty || 1 };
  }
  if (r.t === 'gold' || r.t === 'nexum') {
    await money.credit(db, playerId, r.t, r.n, { reason: 'battle_pass', refType: 'battle_pass', refId: ref, idemKey: idem });
    return { t: r.t, n: r.n };
  }
  if (r.t === 'rune') {
    const got = await runes.grantRune(db, playerId, r.kind, r.rarity, ref);
    if (!got) noRoom();
    return { t: 'rune', kind: r.kind, rarity: r.rarity, itemId: got.itemId };
  }
  if (r.t === 'helper') {
    const pool = HELPERS.filter(h => h.rarity === r.rarity);
    const pick = pool[crypto.randomInt(pool.length)];
    const rowId = await items.add(db, playerId, pick.id, { source: 'battle_pass', sourceRef: ref, helper: { level: 1, xp: 0 } });
    if (rowId === null) noRoom();
    return { t: 'helper', id: pick.id, rarity: r.rarity };
  }
  throw new Error(`battlepass: unknown reward ${JSON.stringify(r)}`);
}

// Забрать награду задания n на дорожке track ('free' | 'prem').
async function claim(db, playerId, n, track) {
  if (!await ready()) err('off', 'Боевой пропуск ещё не включён на сервере');
  const task = bpTaskByN(n);
  if (!task) err('no_task', 'Такого задания нет');
  if (track !== 'free' && track !== 'prem') err('bad_track', 'Неизвестная награда');
  await items.lockPlayer(db, playerId);
  await query(db, `
    INSERT INTO player_battlepass (player_id, season) VALUES ($1, $2)
    ON CONFLICT (player_id, season) DO NOTHING`, [playerId, BATTLE_PASS_SEASON]);
  const cur = await _row(db, playerId, { lock: true });
  if ((Number(cur.progress[task.metric]) || 0) < task.target) err('not_done', 'Задание ещё не выполнено');
  if (track === 'prem' && !cur.premium) err('no_pass', 'Премиальная награда — для владельцев боевого пропуска');
  const col = track === 'free' ? 'claimed_free' : 'claimed_prem';
  const { rowCount } = await query(db, `
    UPDATE player_battlepass SET ${col} = array_append(${col}, $3), updated_at = now()
     WHERE player_id = $1 AND season = $2 AND NOT ($3 = ANY(${col}))`, [playerId, BATTLE_PASS_SEASON, task.n]);
  if (!rowCount) err('already', 'Награда уже получена');
  const ref = `bp${BATTLE_PASS_SEASON}:${track}:${task.n}`;
  const list = track === 'free' ? task.free : task.prem;
  const granted = [];
  for (let i = 0; i < list.length; i++) {
    granted.push(await _grant(db, playerId, list[i], ref, `battle_pass:${BATTLE_PASS_SEASON}:${playerId}:${track}:${task.n}:${i}`));
  }
  return { n: task.n, track, granted };
}

// Всё, что можно забрать прямо сейчас, — по очереди тем же claim. Упёрлись в
// полную сумку — останавливаемся на том, что успели (всё выданное до этого
// остаётся: каждое задание — своя точка сохранения).
async function claimAll(db, playerId) {
  const cur = await _row(db, playerId);
  const out = [];
  for (const task of BATTLE_PASS_TASKS) {
    if ((Number(cur.progress[task.metric]) || 0) < task.target) continue;
    for (const track of cur.premium ? ['free', 'prem'] : ['free']) {
      const done = track === 'free' ? cur.claimedFree : cur.claimedPrem;
      if (done.includes(task.n)) continue;
      await query(db, `SAVEPOINT bp_claim`);
      try {
        out.push(await claim(db, playerId, task.n, track));
        await query(db, `RELEASE SAVEPOINT bp_claim`);
      } catch (e) {
        await query(db, `ROLLBACK TO SAVEPOINT bp_claim`);
        if (e.code === 'no_room') return { claimed: out, stopped: 'no_room' };
        throw e;
      }
    }
  }
  return { claimed: out };
}

module.exports = { ready, bumpIn, stateOf, buy, claim, claimAll, BattlePassError };
