'use strict';
// ── FAQ-бот в чате сообщества ────────────────────────────────────────────────
// Без ИИ: обычное сопоставление вопроса по ключевым словам с готовым ответом.
// Источник ответов — guide.html (то же самое, что уже объясняется игрокам на
// сайте), а где ответ — конкретное число (цена, диапазон, потолок заточки),
// оно ИМПОРТИРУЕТСЯ прямо из shared/definitions.js, а не переписано вручную:
// следующий патч баланса поменяет число там — и этот файл ответит новым
// значением сам, без отдельного шага «не забыть обновить FAQ».
//
// Деньги здесь не двигаются — это read-only ответ текстом в чат, поэтому нет ни
// транзакции, ни s.act(): только подбор темы и один sendMessage.
//
// Активируется строго в одном сконфигурированном чате (TG_FAQ_GROUP_ID) — то
// же deny-by-default, что и у ops-фида (server/tg-ops.js): без заданной группы
// или вне продакшена сообщение только печатается в консоль, никуда не уходит.
// Группу узнать так же, как ops-топики — командой /topicid прямо в этом чате
// (server/tg-ops.js), она печатает chat.id в ответ.

const {
  ENHANCE_MAX, TELEPORT_STONE_PRICE, DISASSEMBLE_LIBERTY,
  BUFF_POTION_CRAFT_RECIPES, CLASS_CHANGE_FIRST_NEXUM, CLASS_CHANGE_GRAM,
} = require('../shared/definitions');

const TOKEN = process.env.TG_BOT_TOKEN || '';
const GROUP_ID = process.env.TG_FAQ_GROUP_ID || '';
const COOLDOWN_MS = Number(process.env.TG_FAQ_COOLDOWN_MS || 600000); // 10 мин

// Read at call time, not at module load — same reasoning as tg-ops.isLive():
// a constant computed on require() would depend on env-var ordering nobody
// controls, and every boot-check-style test would trip it once by accident.
function isLive() {
  const on = process.env.TG_FAQ_LIVE === '1'
    || (process.env.TG_FAQ_LIVE !== '0' && process.env.NODE_ENV === 'production');
  return on && !!TOKEN && !!GROUP_ID;
}

async function _api(method, body) {
  if (!TOKEN) return { ok: false, description: 'no token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    // Never throw out of the poll loop over a missed FAQ reply — see
    // server/workers.js's own per-update try/catch for why one bad send must
    // not stop everything after it.
    console.error('[tg-faq]', method, err.message);
    return { ok: false, description: err.message };
  }
}

// A question, not a statement mentioning a game word in passing — "крафт
// сегодня лутовый" should not trigger a reply, "как крафтить эпик?" should.
// Not perfect (a rare false positive/negative either way), but the per-topic
// cooldown below is what actually keeps a miss from becoming spam.
const QUESTION_RE = /\?|(?:^|[^a-zа-яё])(как|что|где|сколько|почему|зачем|когда|какой|какая|какие|каким|какое|можно ли|подскажите|подскажи|объясните|объясни)(?:[^a-zа-яё]|$)/i;

function looksLikeQuestion(text) {
  return QUESTION_RE.test(text);
}

// Тем меньше, чем разделов в guide.html — только то, о чём реально спрашивают
// новички: сама фича, а не полное содержание раздела. Каждый answer — то, что
// объясняется на сайте, коротко под чат.
const TOPICS = [
  {
    id: 'craft',
    keywords: ['крафт', 'кузниц', 'мастер-крафтер', 'мастера-крафтера'],
    answer: () =>
      '⚒ Крафт — у мастера-крафтера («Кузница»). Три вкладки: «Предметы» (снаряжение за золото/материалы, ' +
      'эпик и легендарка ещё и за Liberty), «Материалы» (апгрейд материалов, книги 2 профессии, боксы, ' +
      'питомцы, крылья, плащи и артефакты классов) и «Расходники» (банки баффов).',
  },
  {
    id: 'enhance',
    keywords: ['заточ', 'энхант', 'камень заточ', 'камни заточ'],
    answer: () =>
      `🔨 Заточка — вкладка «Персонаж → Улучшения», максимум +${ENHANCE_MAX}. Шанс успеха начинается с 80% ` +
      'на +0 и падает на 10% за каждый следующий уровень, но не ниже 10%. Обычный камень при провале ' +
      'уничтожает предмет, «безопасный» камень — нет.',
  },
  {
    id: 'disassemble',
    keywords: ['разбор', 'разобрать', 'разобра'],
    answer: () =>
      '♻️ Разбор — вкладка «Персонаж → Разбор»: необычные (Uncommon) предметы дают ' +
      `${DISASSEMBLE_LIBERTY.uncommon[0]}-${DISASSEMBLE_LIBERTY.uncommon[1]} Liberty, редкие (Rare) — ` +
      `${DISASSEMBLE_LIBERTY.rare[0]}-${DISASSEMBLE_LIBERTY.rare[1]}, эпические (Epic) — ` +
      `${DISASSEMBLE_LIBERTY.epic[0]}-${DISASSEMBLE_LIBERTY.epic[1]}. Обычные и легендарные предметы не разбираются.`,
  },
  {
    id: 'buffpotions',
    keywords: ['банк баф', 'банки баф', 'банку баф', 'банка баф', 'расходник'],
    answer: () => {
      const rec = BUFF_POTION_CRAFT_RECIPES[0];
      return `🧪 Банки баффов крафтятся у мастера-крафтера, вкладка «Расходники»: ${rec.nexumCost} Liberty ` +
        `за ${rec.qty} банок одного вида за раз — каждый вид баффа (здоровье, опыт, золото, реген, скорость, ` +
        'атака) крафтится отдельно.';
    },
  },
  {
    id: 'currency',
    keywords: ['золот', 'gram', 'грам', 'либерти', 'liberty', 'валют'],
    answer: () =>
      '💰 Три валюты. Золото — бесплатное, падает с монстров (30%, у боссов гарантированно), тратится на ' +
      'характеристики, зелья, крафт нижних тиров и создание клана. GRAM — премиум, привязан к TON 1:1, падает ' +
      'вне Фарм-зоны (7.5% шанс), выводится с комиссией 10% с VIP 3, тратится на Маркет/Магазин GRAM/VIP. ' +
      'Liberty — вторая премиум-валюта, только с сервера за достижения (крафт, разбор, квесты), не покупается напрямую.',
  },
  {
    id: 'vip',
    keywords: ['vip', 'вип'],
    answer: () =>
      '⭐ VIP растёт от суммарно потраченного GRAM (не от разового платежа) и даёт постоянные бонусы к опыту, ' +
      'золоту и шансу дропа. С VIP 2 открывается автокаст навыков (кроме рывков и телепортов), с VIP 3 — снят ' +
      'лимит активных лотов на Маркете и открыт вывод GRAM.',
  },
  {
    id: 'teleport',
    keywords: ['телепорт', 'камень телепорт'],
    answer: () =>
      `🌀 Камень телепортации — у торговца, ${TELEPORT_STONE_PRICE} Liberty за штуку. Использование ` +
      'возвращает в столицу через короткий канал заклинания.',
  },
  {
    id: 'classchange',
    keywords: ['смена класс', 'сменить класс', 'поменять класс', 'смена персонажа'],
    answer: () =>
      `🎭 Смена класса — первая смена ${CLASS_CHANGE_FIRST_NEXUM} Liberty ИЛИ ${CLASS_CHANGE_GRAM} GRAM ` +
      `(на выбор), каждая следующая — ${CLASS_CHANGE_GRAM} GRAM.`,
  },
  {
    id: 'clan',
    keywords: ['клан', 'гильди'],
    answer: () =>
      '🛡 Клан — до 30 участников, создание 100 золота. Уровни клана дают накопительные бонусы к золоту/опыту/' +
      'атаке за клановый опыт. Хранилище осколков открывает лидер за 1 000 000 золота (вкладывать/забирать — ' +
      'от 10 дней в клане). Война гильдий — ежедневно 22:00-22:15 МСК, открытый PvP за башню и осколки в час.',
  },
  {
    id: 'pvp',
    keywords: ['пк режим', 'открытый pvp', 'открытый мир pvp', 'асист'],
    answer: () =>
      '⚔️ Открытый PvP — тумблер боевого режима, драка с любым игроком в мире в любое время. В АВТО-режиме ' +
      'бот сам не возьмёт в цель соклановца или напарника по пати, пока не тапнешь по нему вручную.',
  },
  {
    id: 'farmzone',
    keywords: ['элитная фарм', 'фарм-зон', 'фарм зон', 'авто в фарм'],
    answer: () =>
      '🌾 В Элитной фарм-зоне АВТО-режим работает без ограничений — переключатель не блокируется во время забега.',
  },
  {
    id: 'itemcodex',
    keywords: ['кодекс наборов', 'кодекс сет', 'сет-бонус', 'сетовый бонус'],
    answer: () =>
      '📖 Кодекс наборов — постоянные бонусы за то, что предмет набора хотя бы раз побывал в инвентаре ' +
      '(навсегда, даже если потом продать/разобрать). Бонус растёт с редкостью предмета.',
  },
  {
    id: 'season',
    keywords: ['сезон', 'сезонный билет', 'квест'],
    answer: () =>
      '🏆 Сезон — очки за фарм/крафт/заточку/события, таблица рейтинга и призы по его завершении. Сезонный ' +
      'билет (за GRAM в Магазине) даёт x2 опыт и бонусы к дропу/Liberty на весь сезон.',
  },
];

// Последний раз, когда эта тема отвечала В ЭТОМ чате — чтобы не отвечать на
// один и тот же вопрос трижды за пять минут, если несколько человек спросили
// почти одновременно. В памяти процесса: переживать перезапуск сервера ей не
// нужно, а долгоживущий чат сам напомнит о себе новым вопросом.
const _lastAnswered = new Map(); // `${chatId}:${topicId}` -> timestamp

function matchTopic(text) {
  const low = text.toLowerCase();
  for (const topic of TOPICS) {
    if (topic.keywords.some(k => low.includes(k))) return topic;
  }
  return null;
}

// Вызывается из server/workers.js для КАЖДОГО сообщения, что не забрал ни
// tgAdmin.handle, ни ops.handleTopicIdCommand — то есть для обычной болтовни
// в чате. Возвращает true, если это сообщение было для этой темы (даже если
// подавлено кулдауном) — что чат отработан, а не проигнорирован по ошибке.
async function maybeAnswer(message) {
  const text = String((message && message.text) || '').trim();
  const chat = message && message.chat && message.chat.id;
  const from = message && message.from;
  if (!text || !chat || !from || from.is_bot) return false;
  if (!GROUP_ID || String(chat) !== String(GROUP_ID)) return false;

  if (!looksLikeQuestion(text)) return false;
  const topic = matchTopic(text);
  if (!topic) return false;

  const key = `${chat}:${topic.id}`;
  const last = _lastAnswered.get(key) || 0;
  if (Date.now() - last < COOLDOWN_MS) return true; // видели, недавно уже ответили

  _lastAnswered.set(key, Date.now());
  const answer = topic.answer();

  if (!isLive()) {
    console.log(`[tg-faq] (не отправлено, TG_FAQ_LIVE выключен) [${topic.id}] ${answer.slice(0, 160)}`);
    return true;
  }

  const body = {
    chat_id: chat,
    text: answer,
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true },
  };
  if (message.message_thread_id) body.message_thread_id = Number(message.message_thread_id);
  await _api('sendMessage', body);
  return true;
}

function status() {
  return { configured: !!(TOKEN && GROUP_ID), live: isLive(), group: GROUP_ID || null, topics: TOPICS.length };
}

module.exports = { maybeAnswer, status, TOPICS };
