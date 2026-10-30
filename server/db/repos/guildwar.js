'use strict';
// ── Война гильдий: кто владеет сторонами и выплата за сутки ─────────────────
// Две стороны поля — правая и левая (GUILD_WAR_SIDES, shared/definitions.js).
// Владелец каждой — строка guild_war_state с ключом 'right' / 'left'. Сюда же
// пишется paid_day: московские сутки последней выплаты. Решение «платить ли
// сегодня» и отметка «заплачено» — один UPDATE, поэтому повторная проверка,
// перезапуск в полночь или два процесса разом за один день дважды не платят.
//
// Деньги идут в казну клана (clans.treasuryCredit), а не игрокам: раздаёт их
// лидер. Вместе с ними — GUILD_WAR_SIDE_CLAN_XP опыта клану за сторону. До миграции 041 колонки paid_day нет — тогда ни выплат, ни сторон
// (ready() → false), и война просто идёт без наград.

const { query, tx, hasColumn } = require('../index');
const clans = require('./clans');
const { GUILD_WAR_SIDES, GUILD_WAR_SIDE_KEYS, GUILD_WAR_SIDE_CLAN_XP, MSK_OFFSET_H } = require('../../../shared/definitions');

async function ready() {
  return (await hasColumn('guild_war_state', 'paid_day')) && clans.nexumReady();
}

// Московские сутки, 'YYYY-MM-DD'. Строкой, а не датой: сравнивается только
// на равенство, и часовые пояса базы и процесса здесь ни при чём.
function mskDayKey(at = Date.now()) {
  return new Date(at + MSK_OFFSET_H * 3600 * 1000).toISOString().slice(0, 10);
}

// Имя и значок — клана, на момент чтения: переименованный клан не должен
// летать над вышками под старым флагом.
async function loadSides(db = null) {
  const out = { right: null, left: null };
  if (!await ready()) return out;
  const { rows } = await query(db, `
    SELECT g.key, g.owner_clan_id, g.captured_at, c.name, c.icon
      FROM guild_war_state g JOIN clans c ON c.id = g.owner_clan_id
     WHERE g.key = ANY($1::text[])`, [GUILD_WAR_SIDE_KEYS]);
  for (const r of rows) {
    out[r.key] = {
      clanId: Number(r.owner_clan_id), name: r.name, icon: r.icon,
      capturedAt: r.captured_at ? new Date(r.captured_at).getTime() : 0,
    };
  }
  return out;
}

// Новый владелец получает первую выплату в СЛЕДУЮЩИЕ сутки: paid_day ставится
// на сегодня. Тот же клан, удержавший сторону, свой paid_day не теряет —
// иначе сегодняшняя, ещё не выплаченная, сдвинулась бы на завтра.
async function saveSide(db, key, clanId, capturedAt = Date.now()) {
  if (!Object.hasOwn(GUILD_WAR_SIDES, key) || !await ready()) return;
  await query(db, `
    INSERT INTO guild_war_state (key, owner_clan_id, captured_at, paid_day)
    VALUES ($1, $2, to_timestamp($3 / 1000.0), $4)
    ON CONFLICT (key) DO UPDATE SET
      paid_day = CASE WHEN guild_war_state.owner_clan_id IS DISTINCT FROM EXCLUDED.owner_clan_id
                      THEN EXCLUDED.paid_day ELSE guild_war_state.paid_day END,
      owner_clan_id = EXCLUDED.owner_clan_id,
      captured_at = EXCLUDED.captured_at`,
    [key, clanId, capturedAt, mskDayKey(capturedAt)]);
}

// Выплата за сутки `day`. Возвращает, кому сколько ушло. Всё в одной
// транзакции: отметка «заплачено» и деньги в казне коммитятся вместе.
async function payDaily(day = mskDayKey()) {
  if (!await ready()) return [];
  return tx(async (t) => {
    const paid = [];
    for (const key of GUILD_WAR_SIDE_KEYS) {
      const { rows } = await query(t, `
        UPDATE guild_war_state SET paid_day = $2
         WHERE key = $1 AND owner_clan_id IS NOT NULL AND paid_day IS DISTINCT FROM $2
        RETURNING owner_clan_id`, [key, day]);
      if (!rows.length) continue;
      const clanId = Number(rows[0].owner_clan_id);
      const amount = GUILD_WAR_SIDES[key].liberty;
      const left = await clans.treasuryCredit(t, clanId, amount, 'guild_war_' + key, day);
      // И опыт клану за сторону — под той же отметкой paid_day, так что
      // дважды за сутки его тоже не будет.
      const xp = GUILD_WAR_SIDE_CLAN_XP > 0 ? await clans.addXp(t, clanId, GUILD_WAR_SIDE_CLAN_XP) : null;
      if (left != null) paid.push({ key, clanId, amount, treasury: left, clanXp: xp ? GUILD_WAR_SIDE_CLAN_XP : 0 });
    }
    return paid;
  });
}

module.exports = { ready, mskDayKey, loadSides, saveSide, payDaily };
