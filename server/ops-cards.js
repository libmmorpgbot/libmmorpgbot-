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
const tgAdmin = require('./tg-admin');
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
  // The EVENT id, not the id the transfer is filed under — see server/ton.js.
  // A logical time is a name, not a URL, and this link is the only way an
  // operator checks a credit against the chain.
  const link = ton.explorerLink(c.eventId || c.txId);
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

// ── money that arrived and could not be credited ────────────────────────────
// Goes to the deposits topic, not alerts: it is a money event that needs a
// decision, not a fault.
//
// It now carries BUTTONS, which is the whole difference. This card used to be
// a notification about a row nobody could act on — `resolved_by` and
// `resolved_at` were written by no code at all — so the queue only ever grew,
// and 646 TON accumulated in it.
const REASONS = {
  no_comment:      'без комментария — непонятно, чей платёж',
  unknown_comment: 'комментарий не найден среди заявок',
  // Reworded, because what it means changed. Before the identity fix in
  // server/ton.js this was almost always ONE payment read twice: TonAPI
  // renamed a settling trace and the second reading looked like new money.
  // That shape is gone — a transfer is filed under the receiving account's
  // logical time now — so what reaches this reason is the genuine case.
  comment_reused:  'код уже был оплачен — похоже на повторный платёж тем же кодом',
  below_min:       'сумма ниже минимальной',
};

function unmatchedCard(u, { decided = false, noButtons = false } = {}) {
  const link = u.link || ton.explorerLink(u.eventId || u.txId);
  const lines = [
    `⚠️ <b>Платёж не зачислен — нужен разбор</b>${u.id ? ` №${u.id}` : ''}`,
    '',
    `💎 Сумма: <b>${u.amount} TON</b>`,
    `❓ Причина: ${esc(REASONS[u.reason] || u.reason)}`,
    // Verbatim on-chain text, therefore attacker-controlled: escaped, and
    // truncated so a wall of text cannot push the rest of the card out.
    `🏷 Комментарий: <code>${esc(String(u.comment || '—').slice(0, 80))}</code>`,
  ];
  if (u.sender) lines.push(`📬 Отправитель: <code>${esc(ton.friendlyAddress(u.sender))}</code>`);
  lines.push(`🕐 ${when(u.at || Date.now())}`);
  if (link) lines.push(`\n🔗 <a href="${link}">Транзакция в Tonviewer</a>`);

  // ── the one thing the server cannot decide for the operator ───────────────
  // Before the identity fix in server/ton.js, a `comment_reused` row was
  // almost always ONE payment read twice under two event ids — money that is
  // already on the player's balance. resolveUnmatched refuses when it can
  // PROVE that (the transfer's own id, or its event id, already sits on a
  // confirmed deposit), but the 25 August pair is precisely the case it
  // cannot: the two rows carry different event ids, which is the whole bug.
  //
  // So the question is handed to the person who can answer it, with the link
  // that answers it. Everything needed is on the card: open Tonviewer and see
  // whether this is a second transfer or the same one.
  if (!decided && u.reason === 'comment_reused') {
    lines.push('', '⚠️ <b>Сначала проверьте на Tonviewer.</b> По этому коду уже был '
      + 'зачислен платёж. Зачислять — только если это ОТДЕЛЬНЫЙ перевод, '
      + 'а не тот же самый, прочитанный дважды.');
  }

  if (decided) {
    // Everything above stays, exactly as on a withdrawal card: scrolling back
    // has to show what happened, not merely that something did.
    lines.push('', '━━━━━━━━━━━━━━━');
    lines.push(`🕐 Решение: ${when(u.resolvedAt)}`);
    lines.push(`👮 Админ: <code>${esc(u.resolvedBy || '?')}</code>`);
    if (u.resolvedPlayerId) {
      lines.push(`💳 Зачислено игроку <b>${esc(u.creditedTo || u.resolvedPlayerId)}</b>`);
    } else {
      lines.push('🚫 Не зачислять — средства никому не выданы');
    }
  } else if (noButtons) {
    // A card that cannot be acted on must say why, or it reads as the old
    // buttonless one and the operator concludes nothing can be done.
    lines.push('', '⚙️ <i>Кнопки появятся после миграции 014 — сейчас зачислить '
      + 'вручную нельзя.</i>');
  }
  return lines.join('\n');
}

// Two, and the split matters as much as it does on a withdrawal: emptying this
// queue must not require giving the money to somebody. Most of these transfers
// belong to the other build's players — the deposit wallet is shared — and
// "not ours" has to be a recordable outcome.
function unmatchedButtons(id) {
  return [
    [{ text: '💳 Зачислить игроку', callback_data: `u:who:${id}` }],
    [{ text: '🚫 Не зачислять', callback_data: `u:no:${id}` }],
  ];
}

async function postUnmatched(u) {
  // The scanner hands over the TRANSFER it just parsed; the button needs the
  // row's short handle, which only exists in the database.
  const row = await gram.unmatchedByTx(null, u.txId).catch(() => null);
  const card = { ...u, ...(row || {}) };
  const msg = await ops.send('deposits',
    unmatchedCard(card, { noButtons: !row }),
    { buttons: row ? unmatchedButtons(row.id) : null, disablePreview: true });
  // Which message carries this row, so the decision — taken in the operator's
  // DM two presses later — can rewrite THIS card instead of leaving live
  // buttons under money that has already been placed.
  if (msg && row) {
    await gram.noteUnmatchedCard(null, row.id, msg.message_id,
      msg.chat && msg.chat.id).catch(() => {});
  }
  return msg;
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
    `📬 Адрес: <code>${esc(ton.friendlyAddress(w.address))}</code>`,
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

  // No initialisers: every branch below assigns both, and the catch returns
  // without reaching the use. A default here could only hide a branch that
  // forgot to.
  let result, toast;
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

// ── placing a stranded transfer ─────────────────────────────────────────────
// Three presses across two chats, and the shape is deliberate:
//
//   u:who:<id>          in the ops group  → a force_reply prompt, in the
//                                           operator's DM
//   the reply           in the DM         → candidates, one button each
//   u:to:<id>:<pid>     in the DM         → the credit
//   u:no:<id>           either            → declined, nobody credited
//
// WHY THE DM. tg-admin.js already settled this for the /admin panel — "a panel
// that can hand out GRAM is not drawn in a group" — and it applies twice over
// here, because this keyboard hands out somebody else's 15 TON. A force_reply
// sent into a forum topic also lands in General, where it quotes a message
// nobody in that topic can see.
//
// WHY A CONFIRMATION STEP. The reply is free text typed by a human, and
// tgAdmin.search matches usernames with ILIKE '%needle%'. A typo that happens
// to match exactly one account would otherwise credit that account
// immediately. The operator names, then confirms what the name resolved to.
//
// ── the marker ──────────────────────────────────────────────────────────────
// UPPERCASE, and that is load-bearing. tg-admin's own prompt marker is
// /⟨([a-z]+):([0-9]*)⟩/, and a lowercase ⟨udep:7⟩ WOULD match it: it would fall
// through that file's `what` switch to "Неизвестное действие" and redraw the
// player card for player 7, having eaten the reply that says who should
// receive 15 TON. ⟨UDEP:7⟩ cannot match that pattern at all.
//
// workers.js also offers messages to this handler before tg-admin's, so the
// two guards are independent: the order can be changed back without breaking
// this, and the marker can be lower-cased without breaking it either. Neither
// is a good idea, and it takes both mistakes to cause the failure.
const UMARK = /⟨UDEP:(\d+)⟩/;
const umark = id => `⟨UDEP:${id}⟩`;

// A refusal has to leave a trace an operator can see, and a toast is gone the
// moment it is dismissed. Everything below that ends in "no" says so on the
// callback AND in the log, and anything unexpected additionally alerts —
// money paths do not get to fail quietly.
async function _udeny(cq, text) {
  console.warn(`[ops-cards] незачисленный перевод: ${text} (админ ${cq.from && cq.from.id})`);
  await ops.answerCallback(cq.id, text, true);
  return 'denied';
}

// Redraw the card in the group once a decision has been made anywhere.
async function _redrawUnmatched(id, creditedTo) {
  const u = await gram.unmatchedById(null, id);
  if (!u || !u.msgId) return u;
  await ops.editIn(u.chatId || ops.GROUP_ID, u.msgId,
    unmatchedCard({ ...u, creditedTo }, { decided: !!u.resolvedAt }),
    { buttons: u.resolvedAt ? null : unmatchedButtons(id) });
  return u;
}

// Returns a short string for answerCallbackQuery, or null when the press was
// not ours. Every path is safe to repeat.
async function handleUnmatchedCallback(cq, { notifyCredit } = {}) {
  const m = /^u:(who|no|to):(\d+)(?::(\d+))?$/.exec(String(cq.data || ''));
  if (!m) return null;
  const [, action, idStr, pidStr] = m;
  const id = Number(idStr);
  const adminId = String(cq.from && cq.from.id || '');

  // Checked here rather than trusted from the group's membership, exactly as
  // on the withdrawal card: these buttons move real money, and nothing else in
  // this function would notice if the card were forwarded somewhere else.
  if (!ops.isAdmin(adminId)) return _udeny(cq, 'Недостаточно прав');

  const u = await gram.unmatchedById(null, id);
  if (!u) return _udeny(cq, 'Перевод не найден — возможно, миграция 014 не применена');
  if (u.resolvedAt && action !== 'no') {
    // Not an error: another operator got there first. The card is redrawn so
    // it stops offering buttons for a decision already taken.
    await ops.answerCallback(cq.id, 'Уже обработан');
    await _redrawUnmatched(id, null);
    return 'noop';
  }

  try {
    if (action === 'who') {
      // A NEW message, because force_reply cannot be an edit — the client has
      // to have something to reply to.
      const asked = await ops.ask(adminId,
        `💳 Кому зачислить <b>${u.amount} TON</b>?\n`
        + `Комментарий перевода: <code>${esc(String(u.comment || '—').slice(0, 80))}</code>\n\n`
        + `Пришли ник или telegram id ${umark(id)}`);
      if (!asked) {
        return _udeny(cq, 'Открой личку с ботом и нажми Start — запрос придёт туда');
      }
      await ops.answerCallback(cq.id, 'Проверь личку с ботом');
      return 'asked';
    }

    if (action === 'no') {
      const done = await gram.declineUnmatched(id, adminId);
      await ops.answerCallback(cq.id, done ? '🚫 Отмечен как не наш' : 'Уже обработан');
      await _redrawUnmatched(id, null);
      return done ? 'done' : 'noop';
    }

    // action === 'to' — the confirmation press.
    const playerId = Number(pidStr);
    if (!playerId) return _udeny(cq, 'Игрок не указан');
    const res = await gram.resolveUnmatched(id, playerId, adminId);
    if (!res) {
      await ops.answerCallback(cq.id, 'Уже обработан');
      await _redrawUnmatched(id, null);
      return 'noop';
    }
    await ops.answerCallback(cq.id, `💳 ${res.amount} GRAM → ${res.username || playerId}`);
    await _redrawUnmatched(id, res.username);
    // Told last and best-effort: a player who is offline, or whose DM is
    // blocked, must not undo a credit that has already committed.
    if (typeof notifyCredit === 'function') {
      try { await notifyCredit(res); } catch { /* not fatal */ }
    }
    // Its own message rather than only a toast: a toast is seen by the person
    // who pressed and by nobody else, and a credit out of the shared wallet is
    // the whole group's business.
    await ops.send('deposits',
      `💳 <b>Перевод зачислен вручную</b>\n\n`
      + `👤 Игрок: <b>${esc(res.username || playerId)}</b> · <code>${esc(res.telegramId || '')}</code>\n`
      + `💎 Сумма: <b>+${res.amount} GRAM</b>\n`
      + (res.sender ? `📬 Отправитель: <code>${esc(ton.friendlyAddress(res.sender))}</code>\n` : '')
      + `💼 Баланс: <b>${res.balance} GRAM</b>\n`
      + `👮 Админ: <code>${esc(adminId)}</code>\n`
      + `🕐 ${when(Date.now())}`);
    return 'done';
  } catch (err) {
    // `already_credited` is a REFUSAL, not a fault: resolveUnmatched found the
    // transfer already on a confirmed deposit and rolled back rather than
    // minting GRAM. It gets the operator's own words and no alert storm.
    if (err.code === 'already_credited' || err.code === 'no_migration') {
      return _udeny(cq, err.userMessage);
    }
    await ops.alertError('unmatched.resolve', 'Ошибка при зачислении перевода', err,
      { id, admin: adminId });
    await ops.answerCallback(cq.id, 'Ошибка — смотрите топик алертов', true);
    return 'error';
  }
}

// The reply to the force_reply prompt above. Returns whether it took the
// message, so workers.js can offer it to the next handler if not.
async function handleUnmatchedReply(message) {
  const quoted = message && message.reply_to_message
    && String(message.reply_to_message.text || '');
  const m = quoted && UMARK.exec(quoted);
  if (!m) return false;
  const from = message.from && message.from.id;
  const chat = message.chat && message.chat.id;
  // Silence rather than a refusal, the way tg-admin answers a non-admin: the
  // prompt only ever went to an admin's DM, so anyone else replying to a
  // forward has no business being told what the buttons do.
  if (!ops.isAdmin(from)) return true;

  const id = Number(m[1]);
  const needle = String(message.text || '').trim();
  const u = await gram.unmatchedById(null, id);
  if (!u) {
    await ops.dm(chat, 'Перевод не найден.');
    return true;
  }
  if (u.resolvedAt) {
    await ops.dm(chat, 'Этот перевод уже обработан.');
    return true;
  }
  if (!needle) {
    await ops.dm(chat, 'Пустой запрос — пришли ник или telegram id.',
      { buttons: [[{ text: '🔁 Ещё раз', callback_data: `u:who:${id}` }]] });
    return true;
  }

  // The SAME search the /admin panel uses. A second implementation of "find me
  // this player" is a second set of rules for who a name resolves to, and this
  // one decides who receives money.
  const found = await tgAdmin.search(needle);
  if (!found.length) {
    await ops.dm(chat, `Не найден: <code>${esc(needle)}</code>`,
      { buttons: [[{ text: '🔁 Ещё раз', callback_data: `u:who:${id}` }]] });
    return true;
  }
  // Always a confirmation, even for a single hit — see the header above.
  await ops.dm(chat,
    `💳 Зачислить <b>${u.amount} TON</b> как <b>${u.amount} GRAM</b>?\n\n`
    + `Комментарий перевода: <code>${esc(String(u.comment || '—').slice(0, 80))}</code>\n`
    + (u.sender ? `📬 Отправитель: <code>${esc(ton.friendlyAddress(u.sender))}</code>\n` : '')
    + (u.link ? `🔗 <a href="${u.link}">Проверить на Tonviewer</a>\n` : '')
    // Repeated here and not only on the card: this is the message with the
    // button on it, and a warning the operator scrolled past two chats ago is
    // a warning that was not given.
    + (u.reason === 'comment_reused'
      ? '\n⚠️ По этому коду уже был зачислен платёж — убедитесь, что это ОТДЕЛЬНЫЙ '
        + 'перевод, а не тот же самый.\n' : '')
    + `\nВыбери, кому:`,
    {
      buttons: [
        ...found.slice(0, 8).map(r => [{
          text: `${r.username}${r.lvl ? ` · ${r.lvl} ур.` : ''}`,
          callback_data: `u:to:${id}:${r.id}`,
        }]),
        [{ text: '🚫 Не зачислять', callback_data: `u:no:${id}` }],
      ],
    });
  return true;
}

// What the player is told. Kept in Russian for now to match the rest of the
// game's player-facing text.
function playerWithdrawText(w, action) {
  if (action === 'ok') {
    return `✅ <b>Вывод выполнен</b>\n${w.payout} GRAM отправлены на\n<code>${esc(ton.friendlyAddress(w.address))}</code>`;
  }
  if (action === 'back') {
    return `↩️ <b>Заявка на вывод отменена</b>\n${w.amount} GRAM возвращены на ваш баланс.`;
  }
  return `🚫 <b>Заявка на вывод отклонена</b>\nСредства не возвращены. По вопросам — в поддержку.`;
}

module.exports = {
  postDepositCredited, postUnmatched, unmatchedCard, unmatchedButtons,
  handleUnmatchedCallback, handleUnmatchedReply,
  postWithdrawRequest, withdrawCard, withdrawButtons,
  loadWithdraw, handleWithdrawCallback, playerWithdrawText,
  STATUS, REASONS, when,
};
