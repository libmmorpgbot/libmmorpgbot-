'use strict';
// ── /admin — an admin panel in Telegram ─────────────────────────────────────
//
// One command opens a panel; everything after that is buttons. Nobody has to
// remember an argument order, and there is no way to grant 30 GRAM when you
// meant 30 levels because you typed the words in the wrong order.
//
// ── how a screen works ──────────────────────────────────────────────────────
// Every button carries a `callback_data` that names the screen to draw and
// what to draw it about — `a:p:1307` is "the card for player 1307". Pressing
// one EDITS the message in place rather than sending a new one, so the panel
// is a single message that changes, and ⬅️ is just another screen name.
//
// Telegram caps callback_data at 64 bytes, which is the reason ids travel
// rather than names, and the reason there is no server-side "where is this
// admin right now" state to leak or expire.
//
// ── typing a number ─────────────────────────────────────────────────────────
// Buttons cannot carry arbitrary input, so the two places that need one
// (a search, a custom amount) send a force_reply prompt. What that prompt is
// FOR is encoded in its own text as ⟨lvl:1307⟩ and read back off
// reply_to_message — so there is still no state held here. A prompt answered
// an hour later still works, and a restart in between changes nothing.
//
// ── what it is allowed to do ────────────────────────────────────────────────
// Currency moves through money.credit/spend, so a grant lands in the ledger
// like every other coin: a panel that wrote the balance column directly would
// be money created outside money.js, which is the one thing reconcile() exists
// to catch. Every action is written to admin_actions with who did it and to
// whom — levels and balances appearing from nowhere is the shape of a
// compromised account, and that log is what tells the two apart.

const { tx, query } = require('./db');
const money = require('./db/repos/money');
const stats = require('./db/repos/stats');
const progression = require('./db/repos/progression');
const ops = require('./tg-ops');
const { execFile } = require('child_process');
const fs = require('fs');

const PAGE = 8;                      // players per page — fits without scrolling
const CURRENCY = { gold: 'Золото', gram: 'GRAM', nexum: 'Liberty' };
const AMOUNTS = {
  gold:  [100, 1000, 10000, 100000],
  gram:  [1, 10, 100, 1000],
  nexum: [10, 100, 1000, 10000],
};

// ── the marker a force_reply prompt carries ────────────────────────────────
const MARK = /⟨([a-z]+):([0-9]*)⟩/;
const mark = (what, id = '') => `⟨${what}:${id}⟩`;

const esc = (v) => ops.esc(String(v == null ? '' : v));
const btn = (text, data) => ({ text, callback_data: data });

// ── reading a player ────────────────────────────────────────────────────────
async function load(id) {
  const { rows } = await query(null, `
    SELECT p.id, p.username, p.telegram_id, p.banned, p.bm,
           g.lvl, g.xp, g.char_class, g.empowers, g.floor
      FROM players p LEFT JOIN player_progress g ON g.player_id = p.id
     WHERE p.id = $1`, [id]);
  return rows[0] || null;
}

async function search(needle) {
  const { rows } = await query(null, `
    SELECT p.id, p.username, p.telegram_id, g.lvl
      FROM players p LEFT JOIN player_progress g ON g.player_id = p.id
     WHERE p.telegram_id = $1 OR p.username ILIKE '%' || $1 || '%'
     ORDER BY (p.telegram_id = $1) DESC, p.bm DESC NULLS LAST
     LIMIT 12`, [String(needle)]);
  return rows;
}

// Ordered by battle rating: the people worth looking at are the people
// actually playing, and a list ordered by id is a list of test fixtures.
async function recent(offset) {
  const { rows } = await query(null, `
    SELECT p.id, p.username, p.telegram_id, g.lvl
      FROM players p LEFT JOIN player_progress g ON g.player_id = p.id
     WHERE p.telegram_id ~ '^[0-9]+$'
     ORDER BY p.bm DESC NULLS LAST, p.id
     LIMIT $1 OFFSET $2`, [PAGE + 1, offset]);
  return rows;
}

async function record(adminTgId, action, p, meta) {
  await query(null, `
    INSERT INTO admin_actions (admin_tg_id, action, ref_type, ref_id, meta)
    VALUES ($1, $2, 'player', $3, $4)`,
    [String(adminTgId), action, String(p.id),
     JSON.stringify({ username: p.username, telegramId: p.telegram_id, ...meta })]);
}

// ── screens ─────────────────────────────────────────────────────────────────

async function screenHome() {
  const { rows } = await query(null, `
    SELECT (SELECT count(*) FROM players WHERE telegram_id ~ '^[0-9]+$')::int AS players,
           (SELECT count(*) FROM market_listings WHERE status = 'active')::int AS lots,
           (SELECT count(*) FROM gram_tx WHERE status = 'pending' AND type = 'withdraw')::int AS payouts`);
  const st = rows[0] || {};
  return {
    text: [
      '⚙️ <b>Админ-панель</b>',
      '',
      `Игроков: <b>${st.players}</b>`,
      `Лотов на рынке: <b>${st.lots}</b>`,
      `Выводов в очереди: <b>${st.payouts}</b>`,
    ].join('\n'),
    buttons: [
      [btn('👥 Игроки', 'a:list:0'), btn('🔎 Поиск', 'a:find')],
      [btn('📊 Сервер', 'a:srv'), btn('🚀 Выкладка', 'a:dep')],
    ],
  };
}

async function screenList(offset) {
  const rows = await recent(offset);
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  const buttons = page.map(r => [btn(
    `${r.username}${r.lvl ? ` · ${r.lvl} ур.` : ''}`, `a:p:${r.id}`)]);
  const nav = [];
  if (offset > 0) nav.push(btn('◀️', `a:list:${Math.max(0, offset - PAGE)}`));
  if (more) nav.push(btn('▶️', `a:list:${offset + PAGE}`));
  if (nav.length) buttons.push(nav);
  buttons.push([btn('🔎 Поиск', 'a:find'), btn('⬅️ Назад', 'a:home')]);
  return {
    text: page.length
      ? `👥 <b>Игроки</b>  <i>(${offset + 1}–${offset + page.length})</i>\n\nВыбери, кого менять.`
      : '👥 <b>Игроки</b>\n\nПусто.',
    buttons,
  };
}

async function screenPlayer(id) {
  const p = await load(id);
  if (!p) return { text: 'Игрок не найден.', buttons: [[btn('⬅️ Назад', 'a:home')]] };
  const bal = await money.balancesOf(null, p.id);
  const vip = await progression.vipOf(null, p.id);
  const st = await stats.of(null, p.id);
  return {
    text: [
      `👤 <b>${esc(p.username)}</b>`,
      `<code>${esc(p.telegram_id)}</code>`,
      '',
      `Уровень <b>${p.lvl ?? '—'}</b> · ${esc(p.char_class || 'без класса')}`
        + (p.empowers ? ` · усилений ${p.empowers}` : ''),
      st ? `Атака ${st.atk} · Защита ${st.def} · HP ${st.maxHp}` : '',
      '',
      `💰 Золото <b>${bal.gold}</b>`,
      `💎 GRAM <b>${bal.gram}</b>`,
      `🔷 Liberty <b>${bal.nexum}</b>`,
      `⭐️ VIP <b>${vip.level}</b>`
        + (vip.pending && vip.pending.length ? `  <i>(не забрано: ${vip.pending.join(', ')})</i>` : ''),
      p.banned ? '\n🚫 <b>заблокирован</b>' : '',
    ].filter(Boolean).join('\n'),
    buttons: [
      [btn('📈 Уровень', `a:lvl:${p.id}`)],
      [btn('💰 Золото', `a:cur:${p.id}:gold`), btn('💎 GRAM', `a:cur:${p.id}:gram`)],
      [btn('🔷 Liberty', `a:cur:${p.id}:nexum`), btn('⭐️ VIP', `a:vip:${p.id}`)],
      [btn('🔄 Обновить', `a:p:${p.id}`), btn('⬅️ Назад', 'a:list:0')],
    ],
  };
}

async function screenLevel(id) {
  const p = await load(id);
  if (!p) return screenHome();
  const row = (ns) => ns.map(n => btn(String(n), `a:lvlset:${id}:${n}`));
  return {
    text: `📈 <b>${esc(p.username)}</b>\n\nСейчас: <b>${p.lvl ?? '—'}</b> ур.\n\nВыбери новый уровень.`,
    buttons: [
      row([1, 10, 20, 30]),
      row([40, 50, 70, 100]),
      [btn('✏️ Ввести', `a:ask:${id}:lvl`)],
      [btn('⬅️ Назад', `a:p:${id}`)],
    ],
  };
}

async function screenCurrency(id, cur) {
  const p = await load(id);
  if (!p || !CURRENCY[cur]) return screenHome();
  const bal = await money.balancesOf(null, p.id);
  const amts = AMOUNTS[cur];
  return {
    text: `${CURRENCY[cur]} — <b>${esc(p.username)}</b>\n\nСейчас: <b>${bal[cur]}</b>`
      + '\n\nПлюс начисляет, минус списывает.',
    buttons: [
      amts.map(n => btn(`+${n}`, `a:give:${id}:${cur}:${n}`)),
      amts.map(n => btn(`−${n}`, `a:give:${id}:${cur}:-${n}`)),
      [btn('✏️ Ввести', `a:ask:${id}:${cur}`)],
      [btn('⬅️ Назад', `a:p:${id}`)],
    ],
  };
}

async function screenVip(id) {
  const p = await load(id);
  if (!p) return screenHome();
  const vip = await progression.vipOf(null, p.id);
  const row = (ns) => ns.map(n => btn(n === vip.level ? `• ${n} •` : String(n), `a:vipset:${id}:${n}`));
  return {
    text: `⭐️ <b>${esc(p.username)}</b>\n\nVIP сейчас: <b>${vip.level}</b>`,
    buttons: [row([0, 1, 2, 3, 4]), row([5, 6, 7, 8, 9]), [btn('⬅️ Назад', `a:p:${id}`)]],
  };
}

// -- выкладка ---------------------------------------------------------------
// Кнопка, а не команда в консоли: выкладывать должно быть можно с телефона и
// не только тому, у кого настроен ssh.
//
// Чего она НЕ делает: не берёт код с чьей-то машины. Источник один - GitHub,
// и выложить можно ровно то, что там лежит.
const REPO_GIT = '/srv/liberty/repo.git';
const DEPLOY_BRANCH = process.env.LIBERTY_BRANCH || 'postgres-migration';
const NOTIFY_FILE = '/srv/liberty/.deploy-notify';

function git(args, ms = 25000) {
  return new Promise((resolve) => {
    execFile('git', ['--git-dir=' + REPO_GIT].concat(args), { timeout: ms },
      (err, out) => resolve(err ? null : String(out).trim()));
  });
}

// То же, но возвращает ПРИЧИНУ отказа, а не только его факт. fetch не проходит
// по десятку разных поводов — нет сети, протух ключ доступа, упёрлись в лимит,
// сменился адрес репозитория, — и все они выглядят одинаково, если причину
// выбросить: экран говорит «GitHub недоступен» и молчит о том, почему. Разница
// между «повторите через минуту» и «идите чинить ключ» — это ровно она.
function gitErr(args, ms = 25000) {
  return new Promise((resolve) => {
    execFile('git', ['--git-dir=' + REPO_GIT].concat(args), { timeout: ms },
      (err, out, errOut) => resolve(err ? String(errOut || err.message).trim() : null));
  });
}

async function screenDeploy() {
  const live = String(process.env.BUILD_COMMIT || '').trim();
  // fetch перед показом: без него "последнее на GitHub" - это то, что успели
  // забрать в прошлый раз, и кнопка предложила бы выложить вчерашнее.
  const fetchErr = await gitErr(['fetch', '--prune', '--quiet', 'origin']);
  const fetched = fetchErr === null;
  const head = await git(['rev-parse', '--short', 'origin/' + DEPLOY_BRANCH]);
  const subj = head ? await git(['log', '-1', '--format=%s', head]) : null;
  const behind = (live && head)
    ? await git(['rev-list', '--count', live + '..origin/' + DEPLOY_BRANCH])
    : null;

  const lines = ['\u{1F680} <b>Выкладка</b>', ''];
  lines.push('В игре: <code>' + esc(live || '-') + '</code>');
  lines.push('В GitHub: <code>' + esc(head || '-') + '</code>');
  if (!fetched) {
    lines.push('', '\u{26A0}\u{FE0F} <b>Не смог обновиться с GitHub.</b> Справа — не то, что там'
      + ' лежит сейчас, а слепок с прошлого удачного раза.');
    // Первая строка ошибки git: её достаточно, чтобы отличить сеть от ключа.
    const why = String(fetchErr || '').split('\n').find(l => l.trim()) || '';
    if (why) lines.push('<code>' + esc(why.slice(0, 160)) + '</code>');
  }
  lines.push('');

  let buttons;
  if (!head) {
    lines.push('Не удалось прочитать репозиторий.');
    buttons = [[btn('\u{1F504} Обновить', 'a:dep'), btn('\u{2B05}\u{FE0F} Назад', 'a:home')]];
  } else if (live === head && !fetched) {
    // Совпадение со СЛЕПКОМ не значит, что выкладывать нечего: на GitHub с тех
    // пор мог появиться десяток коммитов, и мы о них просто не знаем. Прежний
    // экран показывал здесь зелёную галочку и «выкладывать нечего» — прямо под
    // строкой о том, что до GitHub он не достучался. Две несовместимые вещи
    // подряд, и верили, естественно, галочке.
    lines.push('Совпадает со слепком — но что на GitHub сейчас, отсюда не видно.');
    lines.push('');
    lines.push('Обновите ещё раз; если не проходит, чинить надо связь сервера с');
    lines.push('GitHub — сама выкладка берёт код оттуда же.');
    buttons = [[btn('\u{1F504} Обновить', 'a:dep'), btn('\u{2B05}\u{FE0F} Назад', 'a:home')]];
  } else if (live === head) {
    lines.push('\u{2705} В игре ровно то, что в GitHub. Выкладывать нечего.');
    buttons = [[btn('\u{1F504} Обновить', 'a:dep'), btn('\u{2B05}\u{FE0F} Назад', 'a:home')]];
  } else {
    lines.push('Новых коммитов: <b>' + esc(behind || '?') + '</b>');
    if (subj) lines.push('Последний: ' + esc(subj.slice(0, 90)));
    lines.push('');
    lines.push('Выкладка перезапустит игру: кто сейчас играет - на несколько секунд вылетят.');
    buttons = [
      [btn('\u{1F680} Выложить ' + head, 'a:depgo:' + head)],
      [btn('\u{1F504} Обновить', 'a:dep'), btn('\u{2B05}\u{FE0F} Назад', 'a:home')],
    ];
  }
  return { text: lines.join('\n'), buttons };
}

// Запуск - отдельным процессом ВНЕ этой службы, потому что выкладка её
// перезапускает, то есть убивает то, что её вызвало. systemd-run уводит её в
// собственный юнит, который переживёт перезапуск; о результате скрипт
// отчитается сам, сообщением в этот же чат.
function startDeploy(chatId) {
  return new Promise((resolve) => {
    try { fs.writeFileSync(NOTIFY_FILE, String(chatId), { mode: 0o600 }); }
    catch { /* не смогли - просто не будет отчёта */ }
    execFile('sudo', ['-n', '/srv/liberty/deploy-button.sh'], { timeout: 15000 },
      (err, out, errOut) => {
        if (!err) return resolve(null);
        resolve(String(errOut || err.message).split('\n')[0].slice(0, 120));
      });
  });
}

async function screenServer() {
  const { rows } = await query(null, `
    SELECT (SELECT count(*) FROM players WHERE telegram_id ~ '^[0-9]+$')::int AS players,
           (SELECT count(*) FROM market_listings WHERE status = 'active')::int AS lots,
           (SELECT count(*) FROM gram_tx WHERE status = 'pending')::int AS pending,
           (SELECT COALESCE(sum(amount), 0) FROM balances WHERE currency = 'gram')::numeric AS gram,
           (SELECT count(*) FROM chat_messages)::int AS msgs`);
  const s = rows[0] || {};
  const drift = await query(null, `
    SELECT count(*)::int n FROM (
      SELECT b.amount, COALESCE((SELECT sum(l.delta) FROM ledger l
        WHERE l.player_id = b.player_id AND l.currency = b.currency), 0) AS led
        FROM balances b) x WHERE x.amount <> x.led`);
  const bad = drift.rows[0].n;
  return {
    text: [
      '📊 <b>Сервер</b>',
      '',
      `Игроков: <b>${s.players}</b>`,
      `Активных лотов: <b>${s.lots}</b>`,
      `GRAM у всех на руках: <b>${s.gram}</b>`,
      `Сообщений в чате: <b>${s.msgs}</b>`,
      '',
      bad === 0
        ? '✅ Баланс сходится с леджером'
        : `🚨 <b>Расхождений баланс/леджер: ${bad}</b>`,
    ].join('\n'),
    buttons: [[btn('🔄 Обновить', 'a:srv'), btn('⬅️ Назад', 'a:home')]],
  };
}

// ── actions ─────────────────────────────────────────────────────────────────
// Each returns the toast for the button press; the screen is redrawn after.

async function doLevel(adminTg, id, n) {
  const p = await load(id);
  if (!p) return 'Игрок не найден';
  const lvl = Math.max(1, Math.min(1000, Math.floor(Number(n))));
  if (!Number.isFinite(lvl)) return 'Не число';
  await tx(async (t) => {
    await t.query(
      'UPDATE player_progress SET lvl = $2, xp = 0, updated_at = now() WHERE player_id = $1',
      [id, lvl]);
    // Level feeds the stat block, and the battle rating is stored rather than
    // derived — both have to be recomputed or the rating table disagrees with
    // the character.
    await stats.refreshBm(t, id);
  });
  await record(adminTg, 'set_level', p, { lvl, was: p.lvl });
  return `${p.username}: уровень ${p.lvl ?? '?'} → ${lvl}`;
}

async function doGive(adminTg, id, cur, amount) {
  const p = await load(id);
  if (!p) return 'Игрок не найден';
  if (!CURRENCY[cur]) return 'Неизвестная валюта';
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) return 'Не число';
  // A unique key per press: two identical grants on purpose are two grants.
  const idem = `admin:${cur}:${id}:${require('crypto').randomUUID()}`;
  const res = await tx(t => (amt > 0
    ? money.credit(t, id, cur, amt, { reason: 'admin_grant', refType: 'admin', refId: String(adminTg), idemKey: idem })
    : money.spend(t, id, cur, -amt, { reason: 'admin_take', refType: 'admin', refId: String(adminTg), idemKey: idem })));
  if (!res) return `Недостаточно ${CURRENCY[cur]} у ${p.username}`;
  await record(adminTg, amt > 0 ? 'grant' : 'take', p, { currency: cur, amount: amt, balance: res.balance });
  return `${p.username}: ${CURRENCY[cur]} ${amt > 0 ? '+' : ''}${amt} → ${res.balance}`;
}

async function doVip(adminTg, id, n) {
  const p = await load(id);
  if (!p) return 'Игрок не найден';
  const lvl = Math.max(0, Math.min(10, Math.floor(Number(n))));
  await query(null, 'UPDATE player_vip SET level = $2, updated_at = now() WHERE player_id = $1', [id, lvl]);
  await record(adminTg, 'set_vip', p, { vip: lvl });
  return `${p.username}: VIP → ${lvl}`;
}

// ── routing ─────────────────────────────────────────────────────────────────

async function draw(name, arg1, arg2) {
  switch (name) {
    case 'home': return screenHome();
    case 'list': return screenList(Math.max(0, Number(arg1) || 0));
    case 'p':    return screenPlayer(Number(arg1));
    case 'lvl':  return screenLevel(Number(arg1));
    case 'cur':  return screenCurrency(Number(arg1), arg2);
    case 'vip':  return screenVip(Number(arg1));
    case 'srv':  return screenServer();
    case 'dep':  return screenDeploy();
    default:     return screenHome();
  }
}

// A message. Either the command itself, or a reply to one of our prompts.
async function handle(message) {
  const text = String((message && message.text) || '').trim();
  const from = message && message.from && message.from.id;
  const chat = message && message.chat && message.chat.id;
  if (!from || !chat) return false;

  // A reply to a force_reply prompt — the prompt says what it was for.
  const quoted = message.reply_to_message && String(message.reply_to_message.text || '');
  const m = quoted && MARK.exec(quoted);
  if (m) {
    if (!ops.isAdmin(from)) return true;
    const [, what, idStr] = m;
    if (what === 'find') {
      const found = await search(text);
      if (!found.length) {
        await ops.dm(chat, `Не найден: <code>${esc(text)}</code>`, {
          buttons: [[btn('🔎 Ещё раз', 'a:find'), btn('⬅️ Назад', 'a:home')]],
        });
        return true;
      }
      if (found.length === 1) {
        const sc = await screenPlayer(found[0].id);
        await ops.dm(chat, sc.text, { buttons: sc.buttons });
        return true;
      }
      await ops.dm(chat, `🔎 Нашлось ${found.length}:`, {
        buttons: [
          ...found.map(r => [btn(`${r.username}${r.lvl ? ` · ${r.lvl} ур.` : ''}`, `a:p:${r.id}`)]),
          [btn('⬅️ Назад', 'a:home')],
        ],
      });
      return true;
    }
    const id = Number(idStr);
    const n = Number(String(text).replace(/\s+/g, '').replace(',', '.'));
    let toast;
    if (!Number.isFinite(n)) toast = 'Это не число';
    else if (what === 'lvl') toast = await doLevel(from, id, n);
    else if (CURRENCY[what]) toast = await doGive(from, id, what, n);
    else toast = 'Неизвестное действие';
    const sc = await screenPlayer(id);
    await ops.dm(chat, `${toast}\n\n${sc.text}`, { buttons: sc.buttons });
    return true;
  }

  if (!/^\/admin\b/i.test(text)) return false;
  // Silence, not a refusal: the ops group has other people in it, and there is
  // no reason to tell someone probing which commands exist.
  if (!ops.isAdmin(from)) return true;

  const sc = await screenHome();
  // Into the private chat, so a panel that can hand out GRAM is not drawn in
  // a group. If the bot has never been messaged privately Telegram refuses,
  // and saying so is more use than silence.
  const dm = await ops.dm(from, sc.text, { buttons: sc.buttons });
  if (!dm && String(chat) !== String(from)) {
    await ops.dm(chat, 'Открой личку с ботом и нажми Start — панель придёт туда.')
      .catch(() => {});
  }
  return true;
}

// A button. Returns whether it was ours.
async function handleCallback(cq) {
  const data = String((cq && cq.data) || '');
  if (!data.startsWith('a:')) return false;
  const from = cq.from && cq.from.id;
  if (!ops.isAdmin(from)) {
    await ops.answerCallback(cq.id, 'Нет доступа', true);
    return true;
  }
  const chat = cq.message && cq.message.chat && cq.message.chat.id;
  const msgId = cq.message && cq.message.message_id;
  const [, name, a1, a2, a3] = data.split(':');

  try {
    // The two that ask for typing send a NEW message — a force_reply cannot be
    // an edit, because the client has to have something to reply to.
    if (name === 'find') {
      await ops.answerCallback(cq.id, '');
      await ops.ask(chat, `🔎 Пришли имя или telegram id ${mark('find')}`);
      return true;
    }
    if (name === 'ask') {
      await ops.answerCallback(cq.id, '');
      const label = a2 === 'lvl' ? 'новый уровень' : `сколько ${CURRENCY[a2] || a2}`;
      await ops.ask(chat, `✏️ Пришли ${label} ${mark(a2, a1)}`);
      return true;
    }

    // Выкладка отвечает не как остальные: она перезапускает эту самую службу,
    // поэтому нарисовать "готово" уже некому. Говорим, что запустили, и уходим -
    // результат придёт отдельным сообщением от самого скрипта.
    if (name === 'depgo') {
      const failed = await startDeploy(chat);
      if (failed) {
        await ops.answerCallback(cq.id, 'Не запустилось: ' + failed, true);
        const scd = await screenDeploy();
        await ops.editIn(chat, msgId, scd.text, { buttons: scd.buttons });
        return true;
      }
      await ops.answerCallback(cq.id, 'Запустил');
      await ops.editIn(chat, msgId,
        '\u{1F680} <b>Выкладываю ' + esc(String(a1 || '')) + '</b>\n\n'
        + 'Игра перезапускается. Через полминуты придёт сообщение - получилось или нет.\n'
        + 'Если не поднимется, откатится сама.',
        { buttons: [[btn('\u{1F504} Проверить', 'a:dep')]] });
      return true;
    }

    let toast = '';
    let show = { name: 'home', a1: null, a2: null };

    if (name === 'lvlset')      { toast = await doLevel(from, Number(a1), a2); show = { name: 'p', a1 }; }
    else if (name === 'give')   { toast = await doGive(from, Number(a1), a2, a3); show = { name: 'cur', a1, a2 }; }
    else if (name === 'vipset') { toast = await doVip(from, Number(a1), a2); show = { name: 'vip', a1 }; }
    else                        { show = { name, a1, a2 }; }

    await ops.answerCallback(cq.id, toast);
    const sc = await draw(show.name, show.a1, show.a2);
    // Edited in place: the panel is one message that changes, which is what
    // makes ⬅️ mean anything.
    await ops.editIn(chat, msgId, sc.text, { buttons: sc.buttons });
  } catch (err) {
    console.error('[tg-admin]', err);
    await ops.answerCallback(cq.id, `Ошибка: ${err.userMessage || err.message}`, true);
  }
  return true;
}

module.exports = {
  handle, handleCallback,
  // for tests
  screenHome, screenPlayer, screenList, screenCurrency, screenVip, screenServer,
  screenDeploy,
  doLevel, doGive, doVip, search, MARK,
};
