'use strict';
// ── /admin — granting things from Telegram ──────────────────────────────────
//
// A chat command for the two people who run this game, so a level or a balance
// can be handed out without an SSH session and a hand-written UPDATE.
//
// Every grant goes through the same repositories the game itself uses:
// players.grantXp is not reimplemented here, and a currency moves through
// money.credit so it lands in the ledger like every other coin. A grant that
// wrote the column directly would be money created outside money.js, which is
// the one thing reconcile() exists to catch — and it would catch this.
//
// ── who may use it ─────────────────────────────────────────────────────────
// ops.isAdmin, which reads TG_ADMIN_IDS, and nothing else. Not "an admin of
// the group", not "whoever is in the chat": the group has other people in it
// and being able to read the ops channel is not the same as being able to
// hand out GRAM. A non-admin gets no reply at all rather than a refusal —
// there is no reason to tell someone probing which commands exist.
//
// Every action is written to admin_actions with who did it and to whom. Levels
// and balances appearing out of nowhere is exactly the shape of a compromised
// account, and the log is what separates that from a legitimate grant.

const { tx, query } = require('./db');
const players = require('./db/repos/players');
const money = require('./db/repos/money');
const stats = require('./db/repos/stats');
const progression = require('./db/repos/progression');
const ops = require('./tg-ops');

const HELP = [
  '<b>Админ-команды</b>',
  '',
  '<code>/admin who ИМЯ</code> — найти игрока и показать его состояние',
  '<code>/admin lvl ИМЯ 30</code> — выставить уровень',
  '<code>/admin gold ИМЯ 5000</code> — начислить золото',
  '<code>/admin gram ИМЯ 100</code> — начислить GRAM',
  '<code>/admin nexum ИМЯ 500</code> — начислить Liberty',
  '<code>/admin vip ИМЯ 5</code> — выставить уровень VIP',
  '',
  'Имя — как в игре, регистр не важен; можно telegram id.',
  'Отрицательное число списывает: <code>/admin gram ИМЯ -50</code>',
].join('\n');

const CURRENCY = { gold: 'gold', gram: 'gram', nexum: 'nexum', liberty: 'nexum' };

// Name OR telegram id, because an admin has one or the other to hand and
// should not have to know which the database prefers.
async function findPlayer(needle) {
  const { rows } = await query(null, `
    SELECT p.id, p.username, p.telegram_id, p.banned, g.lvl, g.xp, g.char_class, g.rebirths
      FROM players p LEFT JOIN player_progress g ON g.player_id = p.id
     WHERE p.telegram_id = $1 OR lower(p.username) = lower($1)
     ORDER BY p.id LIMIT 2`, [String(needle)]);
  if (rows.length === 1) return { player: rows[0] };
  if (rows.length > 1) return { error: 'Найдено несколько — уточни telegram id' };

  // Nothing exact: offer the near misses rather than just saying no.
  const { rows: like } = await query(null,
    `SELECT username, telegram_id FROM players
      WHERE username ILIKE '%' || $1 || '%' ORDER BY id LIMIT 5`, [String(needle)]);
  if (!like.length) return { error: `Не найден: <code>${ops.esc(needle)}</code>` };
  return {
    error: `Не найден: <code>${ops.esc(needle)}</code>\n\nПохожие:\n`
      + like.map(l => `• <code>${ops.esc(l.username)}</code> (${l.telegram_id})`).join('\n'),
  };
}

async function record(adminTgId, action, player, meta) {
  await query(null, `
    INSERT INTO admin_actions (admin_tg_id, action, ref_type, ref_id, meta)
    VALUES ($1, $2, 'player', $3, $4)`,
    [String(adminTgId), action, String(player.id),
     JSON.stringify({ username: player.username, telegramId: player.telegram_id, ...meta })]);
}

async function describe(p) {
  const bal = await money.balancesOf(null, p.id);
  const vip = await progression.vipOf(null, p.id);
  const st = await stats.of(null, p.id);
  return [
    `<b>${ops.esc(p.username)}</b>  <code>${p.telegram_id}</code>`,
    `Уровень ${p.lvl ?? '—'} · ${p.char_class || 'без класса'}`
      + (p.rebirths ? ` · перерождений ${p.rebirths}` : ''),
    st ? `Атака ${st.atk} · Защита ${st.def} · HP ${st.maxHp}` : '',
    `Золото ${bal.gold} · GRAM ${bal.gram} · Liberty ${bal.nexum}`,
    `VIP ${vip.level}${vip.pending && vip.pending.length ? ` (не забрано: ${vip.pending.join(', ')})` : ''}`,
    p.banned ? '🚫 заблокирован' : '',
  ].filter(Boolean).join('\n');
}

// ── setting a level ─────────────────────────────────────────────────────────
// Written straight, not granted as experience: an admin asking for level 30
// means level 30, and computing the xp that reaches it would depend on the
// curve staying what it is today. The stat block is recomputed afterwards
// because level feeds it, and the battle rating because that is stored.
async function setLevel(playerId, lvl) {
  const n = Math.max(1, Math.min(1000, Math.floor(Number(lvl))));
  if (!Number.isFinite(n)) throw new Error('bad level');
  await tx(async (t) => {
    await t.query(
      'UPDATE player_progress SET lvl = $2, xp = 0, updated_at = now() WHERE player_id = $1',
      [playerId, n]);
    await stats.refreshBm(t, playerId);
  });
  return n;
}

async function handle(message) {
  const text = String((message && message.text) || '').trim();
  if (!/^\/admin\b/i.test(text)) return false;

  const from = message.from && message.from.id;
  // Silence, not a refusal. The ops group has other people in it.
  if (!ops.isAdmin(from)) return true;

  const reply = (html) => ops.dm(from, html).catch(() => {});
  const parts = text.split(/\s+/).slice(1);
  const cmd = (parts[0] || '').toLowerCase();
  if (!cmd || cmd === 'help') { await reply(HELP); return true; }

  const needle = parts[1];
  if (!needle) { await reply(HELP); return true; }

  const found = await findPlayer(needle);
  if (found.error) { await reply(found.error); return true; }
  const p = found.player;

  try {
    if (cmd === 'who') { await reply(await describe(p)); return true; }

    if (cmd === 'lvl' || cmd === 'level') {
      const n = await setLevel(p.id, parts[2]);
      await record(from, 'set_level', p, { lvl: n, was: p.lvl });
      await reply(`✅ <b>${ops.esc(p.username)}</b>: уровень ${p.lvl ?? '?'} → <b>${n}</b>\n\n`
        + `Пусть перезайдёт в игру.\n\n${await describe({ ...p, lvl: n })}`);
      return true;
    }

    if (CURRENCY[cmd]) {
      const cur = CURRENCY[cmd];
      const amt = Number(parts[2]);
      if (!Number.isFinite(amt) || amt === 0) { await reply('Сумма? Например: <code>/admin gram Ник 100</code>'); return true; }
      // Through money.js, both directions, so the ledger stays the whole
      // story of every coin. A unique key per grant: two identical grants on
      // purpose are two grants.
      const idem = `admin:${cmd}:${p.id}:${require('crypto').randomUUID()}`;
      const res = await tx(t => (amt > 0
        ? money.credit(t, p.id, cur, amt, { reason: 'admin_grant', refType: 'admin', refId: String(from), idemKey: idem })
        : money.spend(t, p.id, cur, -amt, { reason: 'admin_take', refType: 'admin', refId: String(from), idemKey: idem })));
      if (!res) { await reply(`❌ Недостаточно средств у <b>${ops.esc(p.username)}</b>`); return true; }
      await record(from, amt > 0 ? 'grant' : 'take', p, { currency: cur, amount: amt, balance: res.balance });
      await reply(`✅ <b>${ops.esc(p.username)}</b>: ${cmd} ${amt > 0 ? '+' : ''}${amt}\n`
        + `Теперь: <b>${res.balance}</b>\n\nПусть перезайдёт в игру.`);
      return true;
    }

    if (cmd === 'vip') {
      const lvl = Math.max(0, Math.min(10, Math.floor(Number(parts[2]))));
      if (!Number.isFinite(lvl)) { await reply('Уровень VIP? Например: <code>/admin vip Ник 5</code>'); return true; }
      await query(null, 'UPDATE player_vip SET level = $2, updated_at = now() WHERE player_id = $1', [p.id, lvl]);
      await record(from, 'set_vip', p, { vip: lvl });
      await reply(`✅ <b>${ops.esc(p.username)}</b>: VIP → <b>${lvl}</b>\n\nПусть перезайдёт в игру.`);
      return true;
    }

    await reply(HELP);
  } catch (err) {
    console.error('[tg-admin]', err);
    await reply(`❌ Не получилось: <code>${ops.esc(err.userMessage || err.message)}</code>`);
  }
  return true;
}

module.exports = { handle, findPlayer, setLevel, HELP };
