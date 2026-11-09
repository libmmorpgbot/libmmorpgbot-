'use strict';
// ── Заявки на награды «Дружбы» — карточки для админов ───────────────────────
// Игрок жмёт «Забрать» → requestFriendTier (server/db/repos/friendship.js)
// записывает заявку, и сюда приходит карточка: кто, сколько друзей, что
// именно получит. Две кнопки — «Выдать» и «Отклонить», как у заявки на вывод
// (server/ops-cards.js), и тем же правилом: после решения карточка
// ПЕРЕПИСЫВАЕТСЯ — кнопки уходят, вписываются итог, админ и время.
//
// Повторное нажатие безопасно: approve/reject в репозитории снимают заявку
// условным запросом, второе нажатие ничего не находит.
//
// callback_data: fr:ok:<playerId>:<count>:<petIdx>  /  fr:no:<playerId>:<count>
// petIdx — номер питомца в friendEventPets(tier.pet), -1 если питомца нет;
// так в 64 байта Telegram влезает всё, и хранить заявку отдельно не нужно.

const ops = require('./tg-ops');
const { tx } = require('./db');
const friendship = require('./db/repos/friendship');
const { itemCatalogBase, friendEventTier, friendEventPets, FRIEND_EVENT_LEVEL } = require('../shared/definitions');

const esc = ops.esc;
const itemName = id => { const d = itemCatalogBase(id); return d ? d.name : id; };
const RARITY = { common: 'обычн.', uncommon: 'зелён.', rare: 'син.', epic: 'фиол.', legendary: 'легенд.' };
const itemLabel = id => {
  const d = itemCatalogBase(id);
  return d ? `${d.name}${RARITY[d.rarity] ? ` (${RARITY[d.rarity]})` : ''}` : id;
};

function when(d) { return new Date(d || Date.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }

function cardText(r) {
  const lines = [
    '🤝 <b>Заявка на награду «Дружба»</b>',
    '',
    `👤 Игрок: <b>${esc(r.username || '?')}</b> · id ${r.playerId} · tg <code>${esc(r.telegramId || '')}</code>`,
    `🎯 Тир: <b>${r.count} друзей</b>`,
    `👥 Друзей с ${FRIEND_EVENT_LEVEL} ур.: <b>${r.friends}</b>${r.invited != null ? ` (приглашено ${r.invited})` : ''}`,
    '',
    '🎁 <b>Награда:</b>',
  ];
  if (r.nexum) lines.push(`• ${r.nexum} Liberty`);
  if (r.gram) lines.push(`• ${r.gram} GRAM`);
  for (const id of r.items || []) lines.push(`• ${esc(itemLabel(id))}`);
  lines.push('', `🕐 Подана: ${when(r.createdAt)}`);
  return lines.join('\n');
}

function buttons(r) {
  const tier = friendEventTier(r.count);
  const petIdx = tier && tier.pet ? friendEventPets(tier.pet).indexOf(r.petId) : -1;
  return [
    [{ text: '✅ Выдать', callback_data: `fr:ok:${r.playerId}:${r.count}:${petIdx}` }],
    [{ text: '🚫 Отклонить', callback_data: `fr:no:${r.playerId}:${r.count}` }],
  ];
}

// Новая заявка. Ошибка Telegram не отменяет заявку — она остаётся ждать, а
// операторы узнают из алерта.
async function postRequest(r) {
  try {
    const msg = await ops.send('withdrawals', cardText({ ...r, createdAt: Date.now() }), { buttons: buttons(r) });
    if (!msg) {
      ops.alert('friendship.card', 'Заявка «Дружбы» не дошла до админов',
        `игрок ${r.playerId}, тир ${r.count}`).catch(() => {});
    }
    return msg;
  } catch (err) {
    console.error('[friend-cards] post:', err.message);
    return null;
  }
}

// Нажатие кнопки. null — не наша кнопка.
async function handleCallback(cq, { notify } = {}) {
  const m = /^fr:(ok|no):(\d+):(\d+)(?::(-?\d+))?$/.exec(String(cq.data || ''));
  if (!m) return null;
  const [, action, pidStr, countStr, petIdxStr] = m;
  const playerId = Number(pidStr), count = Number(countStr);
  const adminId = String(cq.from && cq.from.id || '');
  if (!ops.isAdmin(adminId)) {
    await ops.answerCallback(cq.id, 'Недостаточно прав', true);
    return 'denied';
  }
  const tier = friendEventTier(count);
  const petIdx = Number(petIdxStr);
  const petId = tier && tier.pet && petIdx >= 0 ? friendEventPets(tier.pet)[petIdx] || null : null;

  let result;
  try {
    result = action === 'ok'
      ? await tx(t => friendship.approveFriendTier(t, playerId, count, petId))
      : await tx(t => friendship.rejectFriendTier(t, playerId, count));
  } catch (err) {
    // Например, у игрока кончилось место: заявка остаётся ждать, карточка — с кнопками.
    await ops.answerCallback(cq.id, `Не выдано: ${err.userMessage || err.message}`.slice(0, 190), true);
    return 'error';
  }
  if (!result) {
    await ops.answerCallback(cq.id, 'Заявка уже обработана');
    if (cq.message) await ops.editMessage(cq.message.message_id, cq.message.text ? esc(cq.message.text) : '', { buttons: null }).catch(() => {});
    return 'noop';
  }
  await ops.answerCallback(cq.id, action === 'ok' ? '✅ Награда выдана' : '🚫 Заявка отклонена');

  // Карточку переписываем по данным заявки из её же текста не восстановить —
  // поэтому дописываем итог к исходному тексту сообщения.
  if (cq.message && cq.message.message_id) {
    const who = cq.from && (cq.from.username ? '@' + cq.from.username : cq.from.first_name) || adminId;
    const base = esc(String(cq.message.text || '🤝 Заявка на награду «Дружба»'));
    const tail = ['', '━━━━━━━━━━━━━━━',
      action === 'ok' ? '✅ <b>ВЫДАНО</b>' : '🚫 <b>ОТКЛОНЕНО</b>',
      `🕐 Решение: ${when()}`, `👮 Админ: <code>${esc(who)}</code>`].join('\n');
    await ops.editMessage(cq.message.message_id, base + '\n' + tail, { buttons: null }).catch(() => {});
  }
  if (typeof notify === 'function') {
    try { await notify(playerId, { count, approved: action === 'ok', nexum: result.nexum || 0, gram: result.gram || 0 }); }
    catch { /* уведомление игрока не обязательно */ }
  }
  return 'done';
}

module.exports = { cardText, buttons, postRequest, handleCallback, itemName };
