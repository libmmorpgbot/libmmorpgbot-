'use strict';
// ── «Показать в чате» — свой лот в https://t.me/libbchat ────────────────────
// Продавец с VIP 5+ может три раза в сутки отправить карточку СВОЕГО активного
// лота в общий чат игры. Карточка — полная информация о предмете: имя, заточка,
// редкость, слот, все характеристики с учётом заточки, строки руны, уровень
// помощника, количество, цена и продавец.
//
// Отправляет ИГРОВОЙ бот (tg-game.send, TG_BOT_TOKEN) — он и должен быть
// участником чата с правом писать. Чат задаётся TG_MARKET_CHAT_ID, по
// умолчанию публичный @libbchat.
//
// Лимит — тот же player_daily, что у попыток режимов (progression.takeAttempt):
// атомарный upsert, двое одновременных нажатий не превратятся в четыре
// отправки. Попытка списывается в той же транзакции, что и отправка, и если
// Telegram отказал, throw откатывает её — неудачная отправка лимит не тратит.

const {
  CHAR_DEF, itemCatalogBase, enhanceBonus, helperBonusAt, petSkillOf,
  RUNE_STAT_NAME, runeStatPct,
} = require('../shared/definitions');
const { _tgEsc, miniAppLink } = require('./security');

const MARKET_SHARE_VIP = 5;
const MARKET_SHARE_PER_DAY = 3;
const MARKET_SHARE_MODE = 'mshare';

function chatId() { return process.env.TG_MARKET_CHAT_ID || '@libbchat'; }

const RARITY_NAME = {
  common: 'Обычный', uncommon: 'Необычный', rare: 'Редкий', epic: 'Эпический', legendary: 'Легендарный',
};
const RARITY_ICON = { common: '⚪', uncommon: '🟢', rare: '🔵', epic: '🟣', legendary: '🟠' };
const SLOT_NAME = {
  weapon: 'Оружие', helmet: 'Шлем', body: 'Броня', gloves: 'Перчатки', boots: 'Боты', ring: 'Кольцо',
  belt: 'Пояс', pet: 'Питомец', cloak: 'Плащ', artifact: 'Артефакт', wings: 'Крылья', helper: 'Помощник',
  use: 'Расходник', material: 'Материал', recipe: 'Рецепт', buff_potion: 'Зелье усиления', box: 'Бокс',
  rune: 'Руна',
};
const RUNE_Q_ICON = { grey: '⚪', green: '🟢', blue: '🔵', purple: '🟣', orange: '🟠' };

const pct = v => (Number(v) * 100).toFixed(0);

// Строки характеристик — тот же набор, что карточка предмета в клиенте
// (_itemStatRows, js/ui.js), только текстом для Telegram.
function statLines(stats, eb = {}) {
  const out = [];
  const flat = (label, base, add) => {
    const total = (Number(base) || 0) + (Number(add) || 0);
    if (!total) return;
    out.push(`${label} <b>+${total}</b>${add ? ` (заточка +${add})` : ''}`);
  };
  flat('⚔️ Атака', stats.atk, eb.atk);
  flat('🛡 Защита', stats.def, eb.def);
  flat('❤️ Здоровье', stats.hp, eb.hp);
  if (stats.critChance) out.push(`🎯 Шанс крита <b>${pct(stats.critChance)}%</b>`);
  if (stats.atkSpeed)   out.push(`⚡ Скорость атаки <b>${pct(stats.atkSpeed)}%</b>`);
  if (stats.hpPct)      out.push(`❤️ Здоровье <b>+${pct(stats.hpPct)}%</b>`);
  if (stats.skillPct)   out.push(`✨ Сила навыков <b>+${pct(stats.skillPct)}%</b>`);
  if (stats.speedPct)   out.push(`👟 Скорость бега <b>+${pct(stats.speedPct)}%</b>`);
  if (stats.atkPct)     out.push(`⚔️ Атака <b>+${pct(stats.atkPct)}%</b>`);
  if (stats.critPower)  out.push(`💥 Сила крита <b>+${pct(stats.critPower)}%</b>`);
  if (stats.xpPct)      out.push(`📘 Опыт <b>+${pct(stats.xpPct)}%</b>`);
  if (stats.dropPct)    out.push(`🍀 Шанс дропа <b>+${pct(stats.dropPct)}%</b>`);
  return out;
}

// Карточка лота. `lot` — то, что отдаёт market.byId() (_lot в repos/market.js).
// Всё, что пришло от игрока (ник, имя предмета из каталога), экранируется.
function buildCard(lot) {
  const it = lot.item || {};
  const def = itemCatalogBase(it.id) || {};
  const rarity = it.rarity || def.rarity;
  const slot = it.slot || def.slot;
  const enh = Number(it.enhance) || 0;
  const qty = Number(it.qty) || 1;

  const lines = [];
  lines.push('🛒 <b>Маркет Liberty — лот игрока</b>');
  lines.push('');
  lines.push(`${RARITY_ICON[rarity] || '▫️'} <b>${_tgEsc(it.name || def.name || it.id || '?')}`
    + `${enh ? ' +' + enh : ''}</b>${qty > 1 ? ' ×' + qty : ''}`);
  const meta = [RARITY_NAME[rarity] || rarity, SLOT_NAME[slot] || slot].filter(Boolean).map(_tgEsc);
  if (meta.length) lines.push(meta.join(' · '));
  if (Array.isArray(def.forClass) && def.forClass.length) {
    lines.push(`Класс: ${def.forClass.map(c => _tgEsc((CHAR_DEF[c] && CHAR_DEF[c].name) || c)).join(', ')}`);
  }

  let stats;
  if (slot === 'helper') {
    const lvl = Number(it.hlLevel) || 1;
    lines.push(`Уровень помощника: <b>${lvl}</b>`);
    stats = statLines(helperBonusAt(it.id, lvl) || {});
  } else if (slot === 'rune' && it.rune && Array.isArray(it.rune.stats)) {
    stats = it.rune.stats.map(st =>
      `${RUNE_Q_ICON[st.q] || '▫️'} ${_tgEsc(RUNE_STAT_NAME[st.stat] || st.stat)} <b>+${runeStatPct(rarity, st.q)}%</b>`);
  } else {
    stats = statLines(def, enhanceBonus(def, enh));
  }
  const psk = typeof petSkillOf === 'function' ? petSkillOf(it.id) : null;
  if (psk) stats.push(`🐾 Навык: <b>${_tgEsc(psk.name)}</b> — ${_tgEsc(psk.desc)}`);
  if (def.desc) stats.push(_tgEsc(def.desc));

  if (stats.length) {
    lines.push('');
    lines.push(...stats);
  }

  lines.push('');
  lines.push(`💰 Цена: <b>${Number(lot.price).toFixed(2)} GRAM</b>`);
  lines.push(`👤 Продавец: ${lot.sellerUsername ? '@' + _tgEsc(lot.sellerUsername) : '—'}`);
  lines.push(`🔖 Лот #${Number(lot.id)}`);
  return lines.join('\n');
}

function buttons() {
  return [[{ text: '🛒 Открыть маркет', url: miniAppLink() }]];
}

module.exports = {
  buildCard, buttons, chatId,
  MARKET_SHARE_VIP, MARKET_SHARE_PER_DAY, MARKET_SHARE_MODE,
};
