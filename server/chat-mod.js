'use strict';
// ── Модерация общего чата ───────────────────────────────────────────────────
// Одна роль над обычным игроком — admin: те же TG_ADMIN_IDS, что у опс-бота
// (server/tg-ops.js). Роль показывается рядом с ником в чате (клиент красит
// её сам), и только админ может выдавать санкции.
//
// Санкции две, обе на время:
//   * mute — не может писать в общий чат;
//   * ban  — не может писать и не получает общий чат вовсе (история пустая,
//            живые сообщения клиент отбрасывает по флагу chatSanction).
//
// Хранятся в памяти и дублируются в таблицу chat_sanctions (миграция 032).
// Таблицы может не быть — между выкладкой и migrate-now.sh, — тогда санкции
// просто живут до перезапуска; запись в базу никогда не ломает сам чат.

const ops = require('./tg-ops');
const { query } = require('./db');

function roleOf(tgId) {
  const id = String(tgId || '');
  if (!id) return null;
  if (ops.isAdmin(id)) return 'admin';
  return null;
}

// telegramId -> { type: 'mute'|'ban', until: ms, by: username }
const sanctions = new Map();

function active(tgId) {
  const id = String(tgId || '');
  const s = sanctions.get(id);
  if (!s) return null;
  if (s.until <= Date.now()) { sanctions.delete(id); return null; }
  return s;
}

let dbWarned = false;
function dbFail(e) {
  if (dbWarned) return;
  dbWarned = true;
  console.warn('[chat-mod] chat_sanctions недоступна, санкции только в памяти:', e.message);
}

async function load() {
  try {
    const { rows } = await query(null, `
      SELECT telegram_id, kind, until, by_username FROM chat_sanctions
       WHERE until > now()`);
    for (const r of rows) {
      sanctions.set(String(r.telegram_id), {
        type: r.kind, until: new Date(r.until).getTime(), by: r.by_username || '',
      });
    }
  } catch (e) { dbFail(e); }
}

async function persist(tgId) {
  const s = sanctions.get(String(tgId));
  try {
    if (!s) {
      await query(null, `DELETE FROM chat_sanctions WHERE telegram_id = $1`, [String(tgId)]);
    } else {
      await query(null, `
        INSERT INTO chat_sanctions (telegram_id, kind, until, by_username)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (telegram_id) DO UPDATE
          SET kind = EXCLUDED.kind, until = EXCLUDED.until,
              by_username = EXCLUDED.by_username, created_at = now()`,
        [String(tgId), s.type, new Date(s.until), s.by]);
    }
  } catch (e) { dbFail(e); }
}

// «30», «30m», «2h», «1d» → миллисекунды. Голое число — минуты.
// Потолок — год: «навсегда» выражается большим сроком, а не отдельным видом.
const MAX_MS = 365 * 24 * 3600e3;
function parseDuration(raw) {
  const m = String(raw || '').trim().toLowerCase().match(/^(\d{1,6})\s*(m|min|м|мин|h|ч|d|д)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  const unit = m[2] || 'm';
  const mult = /^[hч]/.test(unit) ? 3600e3 : /^[dд]/.test(unit) ? 86400e3 : 60e3;
  return Math.min(MAX_MS, n * mult);
}

function fmtDuration(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 60) return `${min} мин`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ч`;
  return `${Math.round(h / 24)} дн`;
}

function fmtLeft(s) { return fmtDuration(Math.max(60e3, s.until - Date.now())); }

// Что видит сам игрок, пытаясь писать. null — писать можно.
function writeBlock(tgId) {
  const s = active(tgId);
  if (!s) return null;
  return s.type === 'ban'
    ? `Вы забанены в чате ещё на ${fmtLeft(s)}`
    : `У вас мут в чате ещё на ${fmtLeft(s)}`;
}

function isBanned(tgId) {
  const s = active(tgId);
  return !!(s && s.type === 'ban');
}

// Состояние для клиента: { type, until } или null.
function stateFor(tgId) {
  const s = active(tgId);
  return s ? { type: s.type, until: s.until } : null;
}

const HELP = 'Команды: /mute Ник 30 | /ban Ник 2h | /unmute Ник | /unban Ник '
  + '(срок: число минут или 30m, 2h, 1d)';

// Команда админа. Возвращает { reply } для отправителя и, если санкция
// изменилась, { announce, target: { telegramId }, state } для всех.
// lookup(username) → { telegramId, username } | null.
async function command(actorTg, actorName, text, lookup) {
  const parts = String(text).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (!['/mute', '/ban', '/unmute', '/unban', '/modhelp'].includes(cmd)) return null;
  if (!roleOf(actorTg)) return { reply: 'Недостаточно прав' };
  if (cmd === '/modhelp') return { reply: HELP };

  const name = (parts[1] || '').replace(/^@/, '');
  if (!name) return { reply: HELP };
  const target = await lookup(name);
  if (!target) return { reply: `Игрок «${name}» не найден` };
  const tgt = String(target.telegramId);
  if (tgt === String(actorTg)) return { reply: 'Нельзя наказать самого себя' };
  if (roleOf(tgt)) return { reply: 'Нельзя наказать администратора' };

  if (cmd === '/unmute' || cmd === '/unban') {
    const s = active(tgt);
    const want = cmd === '/unban' ? 'ban' : 'mute';
    if (!s || s.type !== want) return { reply: `У ${target.username} нет ${want === 'ban' ? 'бана' : 'мута'}` };
    sanctions.delete(tgt);
    await persist(tgt);
    return {
      announce: `${target.username}: ${want === 'ban' ? 'бан' : 'мут'} снят (${actorName})`,
      target: { telegramId: tgt }, state: null,
    };
  }

  const ms = parseDuration(parts[2]);
  if (!ms) return { reply: `Укажите срок: ${cmd} ${target.username} 30 (минуты) или 2h, 1d` };
  const type = cmd === '/ban' ? 'ban' : 'mute';
  sanctions.set(tgt, { type, until: Date.now() + ms, by: actorName });
  await persist(tgt);
  return {
    announce: `${target.username} получает ${type === 'ban' ? 'бан' : 'мут'} в чате на ${fmtDuration(ms)} (${actorName})`,
    target: { telegramId: tgt }, state: stateFor(tgt),
  };
}

module.exports = { roleOf, command, writeBlock, isBanned, stateFor, load, parseDuration };
