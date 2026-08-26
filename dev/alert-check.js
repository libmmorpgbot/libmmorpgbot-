#!/usr/bin/env node
'use strict';
// ── Does an alert actually arrive ───────────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/alert-check.js
//
// "А почему в баг-алерт не прилетает ничего?"
//
// There were three separate answers and they look identical from outside the
// process:
//
//   1. NOTHING WAS RAISED. A refused admin request, a 4xx, a client-side
//      failure — none of them called ops.alert at all. The panel's own errors
//      went to console.error and stopped there.
//
//   2. WHAT WAS RAISED WAS COLLAPSED AND THEN LOST. The throttle reported the
//      1st, 10th, 100th occurrence and silently dropped everything in between,
//      with no flush when the window closed. Four occurrences reported one.
//
//   3. WHAT WAS SENT MAY HAVE FAILED. One 429 from Telegram and the message
//      was gone, with a console line nobody reads as the only trace.
//
// This checks all three, and it checks them through the real transport: fetch
// is intercepted, so every layer below runs exactly as in production —
// isLive(), the topic routing, the redaction, the retry — and nothing leaves
// the process.
//
// It is deliberately the ONE test that runs with OPS_LIVE=1. The gate exists
// so a test cannot reach the operators' group; here the reach itself is what
// is being tested, so the group is replaced instead of the switch.

// Before requiring tg-ops: TOKEN and GROUP_ID are read at module load.
process.env.NODE_ENV = 'test';
process.env.OPS_LIVE = '1';
process.env.TG_OPS_BOT_TOKEN = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TG_OPS_GROUP_ID = '-1009999999999';
process.env.TG_TOPIC_ALERTS = '6';
process.env.TG_ALERT_WINDOW_MS = '2000';        // so the sweep is testable in seconds
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

// ── the interception ────────────────────────────────────────────────────────
// Telegram is answered here; everything else (the local server, the database)
// goes to the real fetch untouched.
const realFetch = globalThis.fetch;
const sent = [];
let nextFailures = 0;          // make the next N sends fail, for the retry test
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.startsWith('https://api.telegram.org/')) return realFetch(url, init);
  const method = u.split('/').pop();
  const body = init && init.body ? JSON.parse(init.body) : {};
  if (method === 'getUpdates') {
    return new Response(JSON.stringify({ ok: true, result: [] }), {
      headers: { 'content-type': 'application/json' } });
  }
  if (nextFailures > 0) {
    nextFailures--;
    return new Response(JSON.stringify({
      ok: false, error_code: 429, description: 'Too Many Requests',
      parameters: { retry_after: 0 },
    }), { headers: { 'content-type': 'application/json' } });
  }
  sent.push({ method, thread: body.message_thread_id, text: body.text || '' });
  return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
    headers: { 'content-type': 'application/json' } });
};

const ops = require('../server/tg-ops');
const plog = require('../server/db/repos/playerlog');
const { pool, close, tx } = require('../server/db');
const players = require('../server/db/repos/players');

const PORT = Number(process.env.ALERT_PORT || 3149);
process.env.PORT = String(PORT);

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const TAG = 'al-' + String(process.pid).slice(-5);
const made = [];
let httpServer = null;

async function main() {
  console.log(`\nalert-check  (${TAG})\n`);

  // ── it is switched on at all ─────────────────────────────────────────────
  console.log('  ── канал ──');
  ok(ops.isLive(), 'ops.isLive() — інакше жоден алерт нікуди не йде, і це перша причина «нічого не прилітає»');
  const st = ops.status();
  eq(st.topics.alerts, 6, 'топік алертів налаштований');
  ok(st.configured, 'бот і група налаштовані');

  // ── one alert reaches the alerts topic ───────────────────────────────────
  console.log('\n  ── один алерт ──');
  sent.length = 0;
  await ops.alert(`${TAG}.one`, 'Проба пера', 'подробиці', { поле: 'значення' });
  eq(sent.length, 1, 'повідомлення пішло');
  eq(sent[0].thread, 6, 'саме в топік алертів, а не в General');
  ok(/Проба пера/.test(sent[0].text), 'із заголовком');
  ok(/подробиці/.test(sent[0].text), 'із подробицями');
  ok(/значення/.test(sent[0].text), 'із доданими полями');

  // ── a bot token never leaves the process ─────────────────────────────────
  console.log('\n  ── редакція ──');
  sent.length = 0;
  await ops.alert(`${TAG}.secret`, 'Помилка з токеном',
    'fetch https://api.telegram.org/bot7654321:AAHfakefakefakefakefakefakefake1234/sendMessage failed');
  ok(!/AAHfake/.test(sent[0].text),
    'токен у тексті помилки вирізано — інакше алерт про збій віддає бота');
  ok(/скрыто/.test(sent[0].text), 'і на його місці стоїть позначка');

  // ── text that arrived broken must not leave broken ───────────────────
  // The first live test of the client-error path produced exactly this: curl
  // on Windows handed the body to a native binary in the system codepage,
  // express decoded it as UTF-8, and every Cyrillic character became U+FFFD.
  // What reached the group was a row of question marks — unreadable, and
  // impossible even to paste anywhere to ask about.
  //
  // The characters are built by code point rather than typed: a literal
  // replacement character in a source file is exactly the thing that does not
  // survive being copied around, which is half of why this was confusing.
  console.log('');
  console.log('  ── нечитабельний текст ──');
  const FFFD = String.fromCharCode(0xFFFD);
  sent.length = 0;
  await ops.alert(`${TAG}.mojibake`, 'Помилка',
    `Не${FFFD}${FFFD}${FFFD}удалось купить лот`);
  ok(sent[0].text.indexOf(FFFD) === -1,
    'символи-замінники прибрано з повідомлення');
  ok(/не удалось прочитать/.test(sent[0].text),
    'але сказано, що текст прийшов побитим — інакше обрізане виглядало б цілим');

  sent.length = 0;
  const NUL = String.fromCharCode(0), ESC = String.fromCharCode(27);
  await ops.alert(`${TAG}.ctrl`, 'Керуючі символи',
    `до${NUL}після${ESC}кінець`);
  ok(sent[0].text.indexOf(NUL) === -1 && sent[0].text.indexOf(ESC) === -1,
    'керуючі символи вирізано — з ними Telegram відхиляє все повідомлення');
  ok(/до/.test(sent[0].text) && /кінець/.test(sent[0].text),
    'а сам текст лишився');

  // ── a storm is collapsed, and then FLUSHED ───────────────────────────────
  // The half that did not exist: everything between the reporting steps used
  // to be counted and thrown away.
  console.log('\n  ── шторм ──');
  sent.length = 0;
  const key = `${TAG}.storm`;
  for (let i = 0; i < 4; i++) await ops.alert(key, 'Одне й те саме', `раз ${i}`);
  eq(sent.length, 3, 'чотири однакові — надіслано 3 (1-й, 2-й, 3-й), решта згорнута');
  ok(/повторилось 2/.test(sent[1].text) || /повторилось 3/.test(sent[1].text),
    'повтори рахуються');

  sent.length = 0;
  // The window closes. Whatever the throttle was still holding must be said.
  ops._alertState.get(key).at = Date.now() - (ops.ALERT_WINDOW_MS + 1000);
  await ops._sweepAlerts();
  eq(sent.length, 1, 'коли вікно закрилось — підсумок за нього');
  ok(/итог за окно: 4/.test(sent[0].text),
    `у підсумку справжня кількість (${(sent[0] || {}).text || ''})`);

  // Nothing to flush must send nothing — a summary for a single occurrence
  // would double every alert in the group.
  sent.length = 0;
  await ops.alert(`${TAG}.once`, 'Одноразове', null);
  ops._alertState.get(`${TAG}.once`).at = Date.now() - (ops.ALERT_WINDOW_MS + 1000);
  const before = sent.length;
  await ops._sweepAlerts();
  eq(sent.length, before, 'одноразовий алерт підсумку не отримує');

  // ── a refused send is retried, not dropped ───────────────────────────────
  console.log('\n  ── Telegram відмовив ──');
  sent.length = 0;
  nextFailures = 1;
  await ops.alert(`${TAG}.retry`, 'Після 429', 'мало дійти з другої спроби');
  eq(sent.length, 1, 'після 429 повторили — і дійшло');

  sent.length = 0;
  nextFailures = 5;
  const undeliveredBefore = ops.status().alerts.undelivered;
  await ops.alert(`${TAG}.dead`, 'Не дійде', 'обидві спроби відмовлено');
  eq(sent.length, 0, 'дві відмови поспіль — не дійшло');
  ok(ops.status().alerts.undelivered > undeliveredBefore,
    'і це порахували — /health скаже, що алерти НЕ доставляються');
  nextFailures = 0;

  // ── the channel as a whole cannot be flooded ─────────────────────────────
  // Fifty DIFFERENT faults at once is a bad deploy, and the per-key throttle
  // does nothing about it. A group that gets two hundred messages in a minute
  // gets muted, and muted alerting is worse than none.
  console.log('\n  ── стеля на канал ──');
  sent.length = 0;
  for (let i = 0; i < 40; i++) await ops.alert(`${TAG}.burst.${i}`, `Різне ${i}`, null);
  ok(sent.length <= 27,
    `40 різних алертів за хвилину — надіслано ${sent.length}, а не 40`);
  ok(sent.some(m => /Слишком много разных алертов/.test(m.text)),
    'і групі сказано, що решта лишилась у журналі сервера');
  // The ceiling is per minute and this just spent one. Cleared rather than
  // slept through, or every assertion after it would measure the ceiling.
  ops._resetBurst();

  // ── the client can report its own failures ───────────────────────────────
  // require() alone registers the routes; boot() is not called, so no workers,
  // no schedulers, no second getUpdates.
  console.log('\n  ── помилка в браузері ──');
  const appMod = require('../server/app');
  httpServer = appMod.server.listen(PORT);
  await new Promise(r => httpServer.once('listening', r));

  sent.length = 0;
  const r = await realFetch(`http://127.0.0.1:${PORT}/client-error`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ where: 'market', message: `${TAG}: не удалось купить лот 229`,
      stack: 'at openMarketBuyConfirm', url: '/index.html' }),
  });
  eq(r.status, 204, 'сторінка отримує відповідь одразу, ще до обробки');
  await wait(200);
  eq(sent.length, 1, 'і про це прилітає алерт — саме цього не було, коли лот не купувався');
  ok(new RegExp(TAG).test(sent[0].text), 'із текстом того, що зламалось');

  // The same message with a different number is the SAME problem: the key has
  // its digits normalised, so "лот 229" and "лот 471" collapse together. What
  // arrives is the one-line repeat notice, not a second full report — two
  // hundred players hitting one broken button must not be two hundred alerts.
  sent.length = 0;
  await realFetch(`http://127.0.0.1:${PORT}/client-error`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ where: 'market', message: `${TAG}: не удалось купить лот 471` }),
  });
  await wait(200);
  eq(sent.length, 1, 'той самий збій з іншим номером не заводить окремий алерт');
  ok(/повторилось 2/.test(sent[0].text),
    `а рахується як повтор першого (${(sent[0] || {}).text || ''})`);
  ok(!/471/.test(sent[0].text), 'у згорнутому рядку немає другого номера — це той самий ключ');

  // ── crawlers are not players ─────────────────────────────
  // The first live alert this path produced was a web crawler reporting that
  // it has no WebGL. Of course it does not — it is not a browser, and there is
  // no player behind it. Every indexer that loads the page would report the
  // same thing forever.
  console.log('');
  console.log('  ── краулери ──');
  sent.length = 0;
  await realFetch(`http://127.0.0.1:${PORT}/client-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; Dataprovider.com)' },
    body: JSON.stringify({ where: 'pixi-unsupported', message: `${TAG} нет WebGL` }),
  });
  await wait(200);
  eq(sent.length, 0, 'від краулера алерт не йде');

  sent.length = 0;
  await realFetch(`http://127.0.0.1:${PORT}/client-error`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    },
    body: JSON.stringify({ where: 'pixi-unsupported', message: `${TAG} нет WebGL у гравця` }),
  });
  await wait(200);
  eq(sent.length, 1, 'а від справжнього телефона — йде');

  // ── the process-level net ────────────────────────────────────────────────
  console.log('\n  ── падіння процесу ──');
  ok(process.listenerCount('unhandledRejection') > 0,
    'необроблена відмова promise має обробник — його не було зовсім');
  ok(process.listenerCount('uncaughtException') > 0,
    'і неперехоплений виняток теж');

  sent.length = 0;
  // Raised the way it really happens, through the handler that is registered.
  process.emit('unhandledRejection', new Error(`${TAG} впало десь у таймері`));
  await wait(300);
  eq(sent.length, 1, 'і про нього приходить повідомлення');
  ok(new RegExp(TAG).test(sent[0].text), 'з текстом помилки');

  // ── the player log ───────────────────────────────────────────────────────
  // The table has existed since migration 002 with nothing writing to it.
  console.log('\n  ── журнал гравця ──');
  const { id: pid } = await tx(t => players.ensure(t, `${TAG}-tg`, `${TAG}_p`));
  made.push(pid);
  plog.log(pid, 'refuse:marketBuy', { code: 'no_gold', msg: 'Недостаточно золота' });
  plog.log(pid, 'marketList', { itemId: 'sw1', price: 100 });
  const n = await plog.flush();
  eq(n, 2, 'записи справді пишуться в player_logs');
  const rows = await plog.recent(null, pid, 10);
  eq(rows.length, 2, 'і читаються назад');
  ok(rows.some(x => x.event === 'refuse:marketBuy' && x.meta.code === 'no_gold'),
    'відмова збережена разом із причиною — це і є відповідь на «почему не смог купить»');

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    if (made.length) {
      await pool().query('DELETE FROM player_logs WHERE player_id = ANY($1)', [made]).catch(() => {});
      await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
    }
    if (httpServer) httpServer.close();
    await close().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
