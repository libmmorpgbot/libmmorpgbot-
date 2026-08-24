#!/usr/bin/env node
'use strict';
// ── Finds the message_thread_id of every topic in the ops group ─────────────
//
//   TG_OPS_BOT_TOKEN=<token> TG_OPS_GROUP_ID=-1004216396316 node dev/tg-topics.js
//
// Telegram has no "list the topics in this forum" method — the Bot API simply
// does not expose one. A topic's id is the message_id of the service message
// that created it, so the only way to learn it is to OBSERVE it: either in the
// forum_topic_created update, or on any message sent inside the topic.
//
// This reads the pending update queue and reports everything it can see, then
// prints a ready-to-paste env block. If a topic has been quiet since before the
// bot joined, its id is not in the queue and it will not appear — the fix is to
// post one message in it and re-run, or to use /topicid (server/tg-ops.js).
//
// getUpdates with offset=-1 would consume the queue and hide the updates from
// the running bot, so this reads WITHOUT acknowledging: no offset is committed,
// and the same updates stay available to whatever polls next.

const TOKEN = process.env.TG_OPS_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
const GROUP = String(process.env.TG_OPS_GROUP_ID || '');

if (!TOKEN) {
  console.error('TG_OPS_BOT_TOKEN не задано — без токена бота ID топіків дізнатись неможливо');
  process.exit(1);
}

// Maps a topic NAME onto the env var it belongs in. Matched loosely because the
// names are typed by a human in Telegram and will not be exactly these.
const GUESS = [
  { env: 'TG_TOPIC_DEPOSITS',    re: /депоз|deposit|попол/i },
  { env: 'TG_TOPIC_WITHDRAWALS', re: /вывод|виве|withdraw|выплат/i },
  { env: 'TG_TOPIC_ALERTS',      re: /алерт|alert|ошиб|помил|error|проблем/i },
];

async function api(method, params = {}) {
  const url = new URL(`https://api.telegram.org/bot${TOKEN}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  return res.json();
}

(async () => {
  const me = await api('getMe');
  if (!me.ok) {
    console.error('Токен не працює:', me.description);
    process.exit(1);
  }
  console.log(`Бот: @${me.result.username} (${me.result.id})\n`);

  if (GROUP) {
    const chat = await api('getChat', { chat_id: GROUP });
    if (chat.ok) {
      console.log(`Група: ${chat.result.title}`);
      console.log(`Форум (топіки увімкнені): ${chat.result.is_forum ? 'так' : 'НІ — топіків не буде'}\n`);
    } else {
      console.log(`getChat не вдався: ${chat.description}`);
      console.log('(бот має бути учасником групи)\n');
    }
  }

  // Listed for CONVENIENCE, to find the ids once. The running server does NOT
  // read this — TG_ADMIN_IDS is a fixed list in the environment.
  //
  // An earlier version of this comment argued the opposite: that permission
  // should be read from the group, so nobody could forget to update a config
  // file. That was wrong, and the reason is worth stating. Being a Telegram
  // group administrator and being allowed to move other people's money are
  // different things. Deriving one from the other means adding a moderator to
  // the logs group silently grants them payout approval — an escalation nobody
  // performed deliberately and nobody would see.
  //
  // Bots are filtered out regardless: @Liblogsbot administrates this group
  // itself and must never appear among the humans.
  if (GROUP) {
    const admins = await api('getChatAdministrators', { chat_id: GROUP });
    if (admins.ok) {
      const humans = admins.result.filter(a => a.user && !a.user.is_bot);
      console.log('Адміністратори групи:\n');
      for (const a of humans) {
        const u = a.user;
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
        console.log(`  ${String(u.id).padStart(12)}  ${u.username ? '@' + u.username : '(без ніка)'}  ${name}  [${a.status}]`);
      }
      console.log(`\nTG_ADMIN_IDS=${humans.map(a => a.user.id).join(',')}\n`);
    } else {
      console.log(`getChatAdministrators не вдався: ${admins.description}\n`);
    }
  }

  // allowed_updates is left wide so a service message about a created topic is
  // not filtered out before we see it.
  const upd = await api('getUpdates', { limit: 100, timeout: 0 });
  if (!upd.ok) {
    console.error('getUpdates не вдався:', upd.description);
    if (/conflict/i.test(upd.description || '')) {
      console.error('\nІнший процес уже опитує цього бота (getUpdates можна лише з одного місця).');
      console.error('Зупиніть бойового бота на хвилину або створіть окремого бота для адмін-групи.');
    }
    process.exit(1);
  }

  const topics = new Map();   // thread_id -> name
  for (const u of upd.result) {
    const m = u.message || u.edited_message || u.channel_post;
    if (!m || !m.chat) continue;
    if (GROUP && String(m.chat.id) !== GROUP) continue;
    const tid = m.message_thread_id;
    if (!tid) continue;
    // Three sources, in descending order of reliability. forum_topic_created
    // carries the real name but only exists if the bot was in the group when
    // the topic was made — which is the common case for it NOT to be there,
    // since a bot is usually added afterwards.
    const created = m.forum_topic_created;
    if (created && created.name) { topics.set(tid, created.name); continue; }
    // Falling back to the message TEXT is what makes this work without that
    // service message: an admin posting the word "депозиты" in the deposits
    // topic identifies it just as well, and takes thirty seconds.
    const text = String(m.text || m.caption || '').trim();
    const prev = topics.get(tid);
    if (text && (!prev || prev.startsWith('('))) topics.set(tid, text.slice(0, 40));
    else if (!prev) topics.set(tid, '(порожнє повідомлення — назву не видно)');
  }

  if (!topics.size) {
    console.log('У черзі оновлень топіків не видно.\n');
    console.log('Що зробити:');
    console.log('  1) напишіть будь-яке повідомлення в КОЖНОМУ з трьох топіків');
    console.log('  2) запустіть цей скрипт знову');
    console.log('  або надішліть /topicid всередині топіка — бот відповість його ID');
    process.exit(0);
  }

  console.log('Знайдені топіки:\n');
  const guessed = {};
  for (const [tid, name] of topics) {
    const hit = GUESS.find(g => g.re.test(name));
    if (hit && !guessed[hit.env]) guessed[hit.env] = tid;
    console.log(`  ${String(tid).padStart(6)}  ${name}${hit ? `   → ${hit.env}` : ''}`);
  }

  console.log('\n─── у /srv/liberty/env ───');
  console.log(`TG_OPS_GROUP_ID=${GROUP || '<id групи>'}`);
  for (const g of GUESS) {
    console.log(`${g.env}=${guessed[g.env] ?? '<не визначено — впишіть вручну>'}`);
  }
})().catch(err => { console.error(err); process.exit(1); });
