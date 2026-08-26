'use strict';
// ── Background work ─────────────────────────────────────────────────────────
// Four jobs that run on their own clock: reading the chain for deposits,
// reading Telegram for admin button presses, reconciling the ledger, and
// keeping the log partitions ahead of the calendar.
//
// One rule shapes all of them: a background job that fails must be LOUD. The
// failure mode that matters here is not a crash — it is a job that quietly
// stops doing anything. A deposit scanner that cannot reach the chain and a
// scanner with nothing to do look identical from the outside (both credit
// nothing, both raise nothing), and the difference is whether players' money
// is arriving and going nowhere.

const ops = require('./tg-ops');
const tgAdmin = require('./tg-admin');
const cards = require('./ops-cards');
const gram = require('./db/repos/gram');
const money = require('./db/repos/money');
const { query, stats: poolStats } = require('./db');
const { _GRAM_WITHDRAW_FEE_PCT } = require('./shop');

const DEPOSIT_EVERY_MS = Number(process.env.DEPOSIT_SCAN_MS || 15000);
const RECONCILE_EVERY_MS = Number(process.env.RECONCILE_MS || 6 * 3600 * 1000);
const TG_POLL_TIMEOUT_S = 25;

const timers = [];

// ── deposit scanner ─────────────────────────────────────────────────────────

let _scanning = false;
let _failStreak = 0;

async function scanDeposits({ notifyPlayer } = {}) {
  // Overlap guard. A single flag is enough while this is one process; it
  // becomes a Redis lock the day there are two, and the guard belongs here
  // either way because a slow scan overlapping the next tick would process the
  // same events twice — harmless (crediting is idempotent) but wasteful and
  // confusing in the logs.
  if (_scanning) return null;
  _scanning = true;
  try {
    const res = await gram.scanOnce();

    // A poll that could not reach the chain credits nothing and raises
    // nothing — the exact shape of a silent money outage. Scattered 5xx from
    // the public tier are normal, so the alarm is on CONSECUTIVE failures
    // rather than a count in a window, which would fire on ordinary noise.
    if (res.failed) {
      _failStreak++;
      // ~3 min, ~30 min, ~5 h at a 15s cadence. Escalating rather than
      // repeating, so a long outage stays visible without becoming noise
      // people mute.
      if (_failStreak === 12 || _failStreak === 120 || _failStreak === 1200) {
        const mins = Math.round(_failStreak * DEPOSIT_EVERY_MS / 60000);
        // ops.alert, not ops.send. An unreachable chain is a CONDITION that
        // persists for as long as it persists, and ops.send goes round the
        // throttle, round the burst ceiling and — the part that matters here —
        // round the alert accounting on /health. So the one number that answers
        // "поднимался ли вообще алерт" never counted the money outage, which is
        // the alert it most needed to count. The escalation steps are far
        // enough apart (~3 min, ~30 min, ~5 h) that the 5-minute window has
        // closed between them and each is still sent in full.
        await ops.alert('deposit.chain.unreachable',
          `Не читается блокчейн уже ~${mins} мин`,
          'Депозиты НЕ потеряны: метка сканирования держится, всё зачислится '
          + 'автоматически, как только TonAPI ответит.',
          { подряд_неудач: _failStreak });
      }
    } else if (_failStreak >= 12) {
      // Left on ops.send deliberately, unlike the outage above it. This fires
      // at most once per outage and it is the message that CANCELS an alarm —
      // if the burst ceiling held it back, everyone would go on believing the
      // deposits were still stuck. A recovery notice is worth more delivered
      // than accounted for.
      await ops.send('alerts',
        `✅ <b>Блокчейн снова читается</b> — сканирование возобновлено, ` +
        `переводы за время сбоя зачисляются сейчас.`);
      _failStreak = 0;
    } else {
      _failStreak = 0;
    }

    for (const c of res.credited) {
      await cards.postDepositCredited(c);
      if (typeof notifyPlayer === 'function') {
        try { await notifyPlayer(c); } catch { /* a blocked DM is not a failed deposit */ }
      }
    }
    for (const u of res.unmatched) await cards.postUnmatched(u);

    return res;
  } catch (err) {
    // The scanner must never die. A throw here would stop deposits for
    // everyone until someone noticed the process was quiet.
    console.error('[workers] deposit scan:', err);
    await ops.alertError('deposit.scan', 'Ошибка сканера депозитов', err);
    return null;
  } finally {
    _scanning = false;
  }
}

// ── Telegram polling for the ops bot ────────────────────────────────────────
// Long-poll getUpdates. Only the ops bot is polled here — the game bot is a
// different token and a different process concern, and Telegram allows
// getUpdates from exactly one place per token.

let _offset = 0;
let _polling = false;

// ── a restart is not a second poller ────────────────────────────────────────
// getUpdates holds a connection open for TG_POLL_TIMEOUT_S. On SIGTERM the
// loop's `while (_polling)` cannot notice anything until that request returns,
// so the old process kept Telegram's poll slot for up to 25 seconds after it
// was told to stop — and the NEW process, starting immediately, was told
// Conflict.
//
// The old handling of that made it far worse than the cause: it raised
// "Бот опрашивается из двух мест" and then slept SIXTY SECONDS. So every
// deploy cost a minute of a bot that answered nothing, plus an alarm about a
// second process that did not exist. That is the whole of "бот або дуже довго
// відповідає, або не відповідає".
//
// Three changes. The in-flight request is now abortable, so stop() ends it at
// once and the slot is released before the next process asks for it. A
// conflict backs off briefly and escalates instead of sleeping a flat minute.
// And it only alarms once the conflict has PERSISTED — a handful of seconds
// around a restart is expected and means nothing.
let _pollAbort = null;
const CONFLICT_ALERT_AFTER = 6;      // ~30s of genuine overlap before alarming

async function pollOps({ notifyPlayer } = {}) {
  const token = process.env.TG_OPS_BOT_TOKEN || '';
  if (!token || _polling) return;
  _polling = true;
  let conflicts = 0;

  const loop = async () => {
    while (_polling) {
      try {
        const url = `https://api.telegram.org/bot${token}/getUpdates` +
          `?offset=${_offset}&timeout=${TG_POLL_TIMEOUT_S}` +
          `&allowed_updates=${encodeURIComponent('["callback_query","message"]')}`;
        _pollAbort = new AbortController();
        const timer = setTimeout(() => _pollAbort && _pollAbort.abort(),
          (TG_POLL_TIMEOUT_S + 10) * 1000);
        let res;
        try { res = await fetch(url, { signal: _pollAbort.signal }); }
        finally { clearTimeout(timer); _pollAbort = null; }
        const data = await res.json();
        if (!data.ok) {
          if (/conflict/i.test(data.description || '')) {
            conflicts++;
            if (conflicts === CONFLICT_ALERT_AFTER) {
              await ops.alert('tg.conflict', 'Бот опрашивается из двух мест',
                'getUpdates возвращает Conflict дольше 30 секунд. Кнопки выводов и /admin работать не будут, пока второй процесс не остановлен.');
            }
            // 1s, 2s, 4s… to 10s. The overlap around a restart clears in one
            // or two of these.
            await new Promise(r => setTimeout(r, Math.min(10000, 1000 * 2 ** Math.min(conflicts - 1, 4))));
          } else {
            // Anything else — a bad token, Telegram having a moment. `continue`
            // on its own made this a tight loop hammering the API.
            console.error('[workers] getUpdates:', data.description);
            await new Promise(r => setTimeout(r, 3000));
          }
          continue;
        }
        conflicts = 0;
        for (const upd of data.result) {
          _offset = upd.update_id + 1;
          try {
            if (upd.callback_query) await _onCallback(upd.callback_query, { notifyPlayer });
            else if (upd.message) {
              // Each returns whether it took the message, so a command that
              // belongs to neither is simply ignored rather than answered
              // twice or answered wrongly.
              if (!await tgAdmin.handle(upd.message)) {
                await ops.handleTopicIdCommand(upd.message);
              }
            }
          } catch (err) {
            // One malformed update must not stop the loop, and the offset has
            // already advanced so it will not be retried forever.
            console.error('[workers] update:', err);
            await ops.alertError('tg.update', 'Ошибка обработки апдейта', err);
          }
        }
      } catch (err) {
        // Network errors are expected on a long poll; back off briefly rather
        // than hammering. An abort is not an error at all — it is stop() doing
        // exactly what it was asked, and the loop is about to end.
        if (!_polling) break;
        if (err.name !== 'TimeoutError' && err.name !== 'AbortError') {
          console.error('[workers] poll:', err.message);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  };
  loop();
}

async function _onCallback(cq, { notifyPlayer }) {
  // The admin panel first: its buttons all start `a:` and belong to nobody
  // else. A withdrawal card's do not, so the two cannot be confused.
  if (await tgAdmin.handleCallback(cq)) return;

  const handled = await cards.handleWithdrawCallback(cq, {
    feePct: _GRAM_WITHDRAW_FEE_PCT,
    notifyPlayer: async (w, action) => {
      if (typeof notifyPlayer !== 'function' || !w) return;
      await notifyPlayer(w, cards.playerWithdrawText(w, action));
    },
  });
  if (handled === null) {
    // Not one of ours. Answered anyway so the client's spinner stops.
    await ops.answerCallback(cq.id, '');
  }
}

// ── reconciliation ──────────────────────────────────────────────────────────
// The check that makes the ledger worth having: for every account, the sum of
// everything that ever moved must equal what the balance says. An empty result
// is the expected one, and the day it stops being empty is the day money moved
// outside repos/money.js — which is exactly the signal that did not exist
// before, when a balance was a number with no history to check it against.
async function reconcile() {
  try {
    const drift = await money.reconcile(null);
    if (!drift.length) return { ok: true, drift: 0 };

    const lines = drift.slice(0, 10).map(d =>
      `• игрок ${d.playerId} · ${d.currency}: баланс ${d.balance}, журнал ${d.ledgerTotal} (расхождение ${d.drift})`);
    // ── why this is an alert and not a send ─────────────────────────────────
    // Drift is PERSISTENT STATE. Once a balance and its ledger disagree they go
    // on disagreeing until somebody fixes the row, so ops.send here posted the
    // whole report again every reconcile cycle, for ever — past the per-key
    // throttle that exists to collapse exactly this, past the burst ceiling,
    // and past the alert counters /health reports. A report that arrives every
    // six hours unchanged is a report that gets muted, and a muted channel is
    // where the NEXT drift goes to die.
    //
    // Through ops.alert it is one message, then a count when it repeats, then a
    // summary when the window closes — and it shows up in ops.status().alerts,
    // which is how anyone finds out the ledger check is even running.
    await ops.alert('money.drift', 'Расхождение баланса и журнала',
      `Счетов с расхождением: ${drift.length}\n${lines.join('\n')}`
      + (drift.length > 10 ? `\n… и ещё ${drift.length - 10}` : '')
      + `\n\nЭто значит, что деньги двигались в обход repos/money.js.`,
      { счетов: drift.length });
    return { ok: false, drift: drift.length };
  } catch (err) {
    console.error('[workers] reconcile:', err);
    await ops.alertError('reconcile', 'Ошибка сверки баланса', err);
    return null;
  }
}

// ── maintenance ─────────────────────────────────────────────────────────────
// Log partitions must exist before the month they cover. A partitioned table
// with no partition for today rejects every insert, so this running late is a
// hard failure rather than a slow one.
async function maintain() {
  try {
    await query(null, 'SELECT ensure_log_partitions(2)');
    await query(null, 'SELECT drop_old_log_partitions(6)');
    await gram.expireStaleIntents(null);
  } catch (err) {
    console.error('[workers] maintain:', err);
    await ops.alertError('maintain', 'Ошибка обслуживания БД', err);
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function start(opts = {}) {
  // Run once at boot so a partition or an expiry gap is closed immediately
  // rather than at the first scheduled tick.
  maintain();

  // Reconciliation and partition maintenance are database-only and safe
  // anywhere. The other two reach OUTSIDE this process — the chain and the
  // operators' bot — and a test run must not do either: polling getUpdates a
  // second time takes the live server's withdrawal buttons away from it, and
  // scanning aims the deposit reader at a wallet holding real money.
  timers.push(setInterval(() => reconcile(), RECONCILE_EVERY_MS));
  timers.push(setInterval(() => maintain(), 6 * 3600 * 1000));

  const live = ops.isLive();
  if (live) {
    timers.push(setInterval(() => scanDeposits(opts), DEPOSIT_EVERY_MS));
    pollOps(opts);
  } else {
    console.log('[workers] OPS_LIVE выключен — сканирование депозитов и опрос бота не запущены');
  }

  // unref so these never hold the process open during a shutdown.
  for (const t of timers) t.unref();
  return { deposits: live ? DEPOSIT_EVERY_MS : 0, reconcile: RECONCILE_EVERY_MS, live };
}

function stop() {
  _polling = false;
  // Ends the long poll NOW rather than up to 25 seconds from now. Without
  // this the departing process holds Telegram's poll slot well past its own
  // shutdown, and the next one starts into a Conflict it did not cause.
  if (_pollAbort) { try { _pollAbort.abort(); } catch { /* already gone */ } _pollAbort = null; }
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

// Reported on /health so "is the scanner alive" has an answer that is not
// "check the logs".
function status() {
  return {
    // Whether this process is allowed to reach outside itself at all. On the
    // /health page it answers "is the deposit scanner actually running", which
    // used to be unanswerable without reading the logs.
    live: ops.isLive(),
    depositScanFailStreak: _failStreak,
    scanning: _scanning,
    opsPolling: _polling,
    pool: poolStats(),
  };
}

module.exports = { start, stop, status, scanDeposits, reconcile, maintain, pollOps };
