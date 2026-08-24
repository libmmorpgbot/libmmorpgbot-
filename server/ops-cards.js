'use strict';
// ── The messages admins actually act on ─────────────────────────────────────
// Deposit notices, withdrawal request cards, and the button handling behind
// them. All admin-facing text is Russian.
//
// One rule shapes everything here: a card must be readable AFTER it has been
// decided. The old flow sent a request, an admin pressed a button, and the
// message was left exactly as it was — so scrolling back through the group told
// you a request existed but not what happened to it, who decided, or when. Here
// every decision REWRITES the card in place: the buttons go, the outcome and
// the admin's name go in, and nothing that was there before is dropped.
//
// The second rule: a button press must be safe to repeat. Telegram will deliver
// the same callback twice on a flaky connection, and two admins can press
// different buttons within the same second. Every handler below funnels into a
// repository call whose WHERE clause includes the current status, so the second
// press changes nothing and says so.

const ops = require('./tg-ops');
const gram = require('./db/repos/gram');
const ton = require('./ton');
const { query, tx } = require('./db');

const esc = ops.esc;

// UTC everywhere, and stated as UTC. Admins are in different time zones and a
// bare "12:40" in a payout record is worse than no time at all.
function when(d) {
  if (!d) return '—';
  return new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

const STATUS = {
  pending:   '⏳ <b>Исполняется</b>',
  confirmed: '✅ <b>ИСПОЛНЕНО</b>',
  rejected:  '↩️ <b>ОТМЕНЕНО — средства возвращены</b>',
  forfeited: '🚫 <b>ОТМЕНЕНО — средства удержаны</b>',
  expired:   '⌛ <b>Истекла</b>',
};

// ── deposits ────────────────────────────────────────────────────────────────
// Fire-and-forget: a credited deposit is already committed, and a Telegram
// failure must not look like a failed deposit.
async function postDepositCredited(c) {
  const link = ton.explorerLink(c.txId);
  const lines = [
    '💰 <b>Депозит зачислен</b>',
    '',
    `👤 Игрок: <b>${esc(c.username || '?')}</b> · <code>${esc(c.telegramId || '')}</code>`,
    `💎 Сумма: <b>+${c.amount} GRAM</b>`,
    `💼 Баланс: <b>${c.balance} GRAM</b>`,
    `🏷 Мемо: <code>${esc(c.memo)}</code>`,
  ];
  // UQ…, not 0:755933… — an operator has to be able to match this against
  // what their own wallet shows and paste it into Tonviewer.
  if (c.sender) lines.push(`📬 Отправитель: <code>${esc(ton.friendlyAddress(c.sender))}</code>`);
  if (c.referral) lines.push(`🎁 Рефереру: <b>+${c.referral.amount} GRAM</b>`);
  lines.push(`🕐 ${when(Date.now())}`);
  if (link) lines.push(`\n🔗 <a href="${link}">Транзакция в Tonviewer</a>`);

  // The explorer link is the whole point of the message — an admin has to be
  // able to check it against the chain — so previews stay off but the link
  // itself must survive, which is why this is not sent as plain text.
  return ops.send('deposits', lines.join('\n'), { disablePreview: true });
}

// Money that arrived and could not be credited. Goes to the deposits topic
// too, not alerts: it is a money event that needs a decision, not a fault.
async function postUnmatched(u) {
  const REASONS = {
    no_comment:      'без комментария — непонятно, чей платёж',
    unknown_comment: 'комментарий не найден среди заявок',
    comment_reused:  'мемо уже использовано (повторная отправка)',
    below_min:       'сумма ниже минимальной',
  };
  const link = ton.explorerLink(u.txId);
  const lines = [
    '⚠️ <b>Платёж не зачислен — нужен разбор</b>',
    '',
    `💎 Сумма: <b>${u.amount} TON</b>`,
    `❓ Причина: ${esc(REASONS[u.reason] || u.reason)}`,
    // Verbatim on-chain text, therefore attacker-controlled: escaped, and
    // truncated so a wall of text cannot push the rest of the card out.
    `🏷 Комментарий: <code>${esc(String(u.comment || '—').slice(0, 80))}</code>`,
  ];
  if (u.sender) lines.push(`📬 Отправитель: <code>${esc(ton.friendlyAddress(u.sender))}</code>`);
  lines.push(`🕐 ${when(Date.now())}`);
  if (link) lines.push(`\n🔗 <a href="${link}">Транзакция в Tonviewer</a>`);
  return ops.send('deposits', lines.join('\n'));
}

// ── withdrawals ─────────────────────────────────────────────────────────────

function withdrawCard(w, { decided = false } = {}) {
  const lines = [
    `📤 <b>Заявка на вывод №${w.id}</b>`,
    STATUS[w.status] || esc(w.status),
    '',
    `👤 Игрок: <b>${esc(w.username || '?')}</b> · <code>${esc(w.telegramId || '')}</code>`,
    `💎 Списано с баланса: <b>${w.amount} GRAM</b>`,
    `💸 К отправке: <b>${w.payout} GRAM</b> <i>(комиссия ${w.fee})</i>`,
    `📬 Адрес: <code>${esc(w.address)}</code>`,
    `💼 Баланс после списания: <b>${w.balanceAfter ?? '—'} GRAM</b>`,
    `🕐 Создана: ${when(w.createdAt)}`,
  ];

  if (decided) {
    // Everything above stays. The decision is added, never substituted — the
    // whole reason to rewrite the card is that scrolling back must show what
    // happened, not just that something did.
    lines.push('', '━━━━━━━━━━━━━━━');
    lines.push(`🕐 Решение: ${when(w.decidedAt)}`);
    lines.push(`👮 Админ: <code>${esc(w.decidedBy || '?')}</code>`);
    if (w.status === 'confirmed') {
      lines.push('💸 Средства отправлены игроку');
      if (w.paidTxHash) {
        const l = ton.explorerLink(w.paidTxHash);
        lines.push(l ? `🔗 <a href="${l}">Транзакция выплаты</a>` : `🔗 <code>${esc(w.paidTxHash)}</code>`);
      }
    } else if (w.status === 'rejected') {
      lines.push(`↩️ <b>${w.amount} GRAM</b> возвращены на баланс игрока`);
    } else if (w.status === 'forfeited') {
      lines.push(`🚫 <b>${w.amount} GRAM</b> НЕ возвращены — удержаны`);
    }
    if (w.adminNote) lines.push(`📝 ${esc(w.adminNote)}`);
  }
  return lines.join('\n');
}

// Three buttons, and the split between the last two is the point. The GRAM
// left the player's balance when they submitted, so cancelling has to say
// explicitly where it goes — returning it and keeping it are different
// decisions, and a single "Отклонить" would hide that behind whoever pressed.
function withdrawButtons(id) {
  return [
    [{ text: '✅ Исполнено', callback_data: `w:ok:${id}` }],
    [{ text: '↩️ Отменить (вернуть)', callback_data: `w:back:${id}` }],
    [{ text: '🚫 Отменить (забрать)', callback_data: `w:keep:${id}` }],
  ];
}

// Posts a new request and records which message carries it, so a decision made
// anywhere else can rewrite this exact card instead of leaving a live one.
async function postWithdrawRequest(w) {
  const msg = await ops.send('withdrawals', withdrawCard(w), { buttons: withdrawButtons(w.id) });
  if (msg) {
    await query(null, 'UPDATE gram_tx SET admin_msg_id = $2, ops_chat_id = $3 WHERE id = $1',
      [w.id, msg.message_id, String(msg.chat.id)]).catch(() => {});
  }
  return msg;
}

// Everything the card needs, in one read.
async function loadWithdraw(id, feePct) {
  const { rows } = await query(null, `
    SELECT g.id, g.player_id, g.amount, g.status, g.address, g.created_at, g.decided_at,
           g.decided_by, g.paid_tx_hash, g.admin_note, g.admin_msg_id,
           p.username, p.telegram_id,
           COALESCE((SELECT b.amount FROM balances b
                      WHERE b.player_id = g.player_id AND b.currency = 'gram'), 0) AS bal
      FROM gram_tx g JOIN players p ON p.id = g.player_id
     WHERE g.id = $1 AND g.type = 'withdraw'`, [id]);
  if (!rows.length) return null;
  const r = rows[0];
  const amount = Number(r.amount);
  const fee = Math.round(amount * feePct * 100) / 100;
  return {
    id: Number(r.id), playerId: Number(r.player_id), amount,
    fee, payout: Math.round((amount - fee) * 100) / 100,
    status: r.status, address: r.address, createdAt: r.created_at,
    decidedAt: r.decided_at, decidedBy: r.decided_by, paidTxHash: r.paid_tx_hash,
    adminNote: r.admin_note, msgId: r.admin_msg_id,
    username: r.username, telegramId: r.telegram_id, balanceAfter: Number(r.bal),
  };
}

// ── the button press ────────────────────────────────────────────────────────
// Returns a short string for answerCallbackQuery, which is what the admin sees
// as a toast. Every path is safe to repeat.
async function handleWithdrawCallback(cq, { feePct, notifyPlayer }) {
  const data = String(cq.data || '');
  const m = /^w:(ok|back|keep):(\d+)$/.exec(data);
  if (!m) return null;

  const [, action, idStr] = m;
  const id = Number(idStr);
  const adminId = String(cq.from && cq.from.id || '');

  // Checked here rather than trusted from the group's membership: the message
  // lives in an admin group today, but nothing else in this function would
  // notice if that stopped being true, and these buttons move real money.
  if (!ops.isAdmin(adminId)) {
    await ops.answerCallback(cq.id, 'Недостаточно прав', true);
    return 'denied';
  }

  let result = null, toast = '';
  try {
    if (action === 'ok') {
      result = await tx(t => gram.markWithdrawPaid(t, id, adminId));
      toast = result ? '✅ Отмечено как исполненное' : 'Заявка уже обработана';
    } else if (action === 'back') {
      result = await tx(t => gram.rejectWithdraw(t, id, adminId));
      toast = result ? `↩️ Отменено, ${result.amount} GRAM возвращены` : 'Заявка уже обработана';
    } else {
      result = await tx(t => gram.forfeitWithdraw(t, id, adminId));
      toast = result ? `🚫 Отменено, ${result.amount} GRAM удержаны` : 'Заявка уже обработана';
    }
  } catch (err) {
    await ops.alertError('withdraw.decide', 'Ошибка при обработке вывода', err, { id, admin: adminId });
    await ops.answerCallback(cq.id, 'Ошибка — смотрите топик алертов', true);
    return 'error';
  }

  await ops.answerCallback(cq.id, toast);

  // Rewrite the card whether or not this press was the one that decided it: if
  // it lost the race, the card still needs to stop showing live buttons.
  const w = await loadWithdraw(id, feePct);
  if (w && w.msgId) {
    await ops.editMessage(w.msgId, withdrawCard(w, { decided: w.status !== 'pending' }),
      { buttons: w.status === 'pending' ? withdrawButtons(id) : null });
  }

  if (result && typeof notifyPlayer === 'function') {
    // Telling the player is best-effort and deliberately last: a blocked DM
    // must not undo a payout that already happened.
    try { await notifyPlayer(w, action); } catch { /* not fatal */ }
  }
  return result ? 'done' : 'noop';
}

// What the player is told. Kept in Russian for now to match the rest of the
// game's player-facing text.
function playerWithdrawText(w, action) {
  if (action === 'ok') {
    return `✅ <b>Вывод выполнен</b>\n${w.payout} GRAM отправлены на\n<code>${esc(w.address)}</code>`;
  }
  if (action === 'back') {
    return `↩️ <b>Заявка на вывод отменена</b>\n${w.amount} GRAM возвращены на ваш баланс.`;
  }
  return `🚫 <b>Заявка на вывод отклонена</b>\nСредства не возвращены. По вопросам — в поддержку.`;
}

module.exports = {
  postDepositCredited, postUnmatched,
  postWithdrawRequest, withdrawCard, withdrawButtons,
  loadWithdraw, handleWithdrawCallback, playerWithdrawText,
  STATUS, when,
};
