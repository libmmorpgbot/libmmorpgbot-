#!/usr/bin/env node
'use strict';
// ── Proof that money in and out cannot be created or lost ───────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... GRAM_WALLET=<any valid addr> node dev/gram-check.js
//
// classify() is tested as a pure function against every shape a real transfer
// arrives in; the credit and withdrawal paths are tested against the live
// database with synthetic transfers, so no chain access is needed. The two
// halves together cover what the scanner actually decides and does.

const fs = require('fs');
const path = require('path');
const { pool, tx, close } = require('../server/db');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const gram = require('../server/db/repos/gram');
const ton = require('../server/ton');

let pass = 0, fail = 0, skipped = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
// A check that could not RUN is not a check that passed. workers.js states the
// rule for the item reconciler — "no drift found" and "no check ran" must never
// print the same way — and it applies with more force here, because the block
// this guards is the one that hands out money. Counted and named in the
// summary, in its own colour, so a run against a pre-014 database cannot be
// mistaken for a green one.
function skip(name, why) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m  ${name} — ${why}`);
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'gr-' + String(process.pid).slice(-5);
const made = [], txIds = [];
async function mk(nick, refBy = null) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  if (refBy) await pool().query('UPDATE players SET referred_by = $2 WHERE id = $1', [id, refBy]);
  return id;
}
const bal = async id => (await money.balancesOf(null, id)).gram;
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

async function main() {
  console.log(`\ngram-check  (${TAG})\n`);

  // ── address validation: what may reach a URL path ────────────────────────
  console.log('  ── адреси ──');
  ok(ton.validAddress('UQAvDfWFG0oYX19GGujud_gjqBEHFa_G5Vwv2sIA6ArkAgnr'), 'валідна UQ-адреса приймається');
  ok(ton.validAddress('0:' + 'a'.repeat(64)), 'валідна raw-адреса приймається');
  ok(!ton.validAddress('../../v2/accounts/evil'), 'спроба вставити шлях у URL відхилена');
  ok(!ton.validAddress('UQ123?x=1'), 'адреса з query-параметром відхилена');
  ok(!ton.validAddress(''), 'порожня адреса відхилена');

  // ── parsing: direction, amount precision ─────────────────────────────────
  console.log('  ── розбір транзакцій ──');
  const OUR = '0:' + 'b'.repeat(64);
  const inTx = { status: 'ok', type: 'TonTransfer', TonTransfer: {
    recipient: { address: OUR.toUpperCase() }, sender: { address: '0:cc' },
    amount: '1500000000', comment: 'LBT-ABC' } };
  const parsed = ton.parseAction(inTx, OUR);
  eq(parsed && parsed.amount, '1.50000000', '1.5 TON розібрано точно, без float');
  eq(parsed && parsed.comment, 'LBT-ABC', 'коментар витягнутий');

  const outTx = JSON.parse(JSON.stringify(inTx));
  outTx.TonTransfer.recipient.address = '0:someone_else';
  ok(ton.parseAction(outTx, OUR) === null, 'ВИХІДНИЙ переказ не зараховується');

  const failedTx = JSON.parse(JSON.stringify(inTx)); failedTx.status = 'failed';
  ok(ton.parseAction(failedTx, OUR) === null, 'невдала транзакція не зараховується');

  const jetton = { status: 'ok', type: 'JettonTransfer', JettonTransfer: { recipient: { address: OUR } } };
  ok(ton.parseAction(jetton, OUR) === null, 'жетон (не TON) не зараховується');

  // One event, two transfers — they must get different ids or only one credits.
  const two = ton.incomingFrom([{ event_id: 'EV1', lt: 5, actions: [inTx, inTx] }], OUR);
  eq(two.length, 2, 'дві перекази в одній події отримали різні id');
  eq(two[0].txId, '5:0', 'id складається з ЛОГІЧНОГО ЧАСУ рахунку та індексу дії');

  transferIdentity(OUR, inTx);

  // ── the watermark must not step over a trace that has not landed ─────────
  // fetchSince() needs no network for this: it is given the pages directly.
  await watermarkHoldCheck();

  // ── classify(): every shape a transfer arrives in ────────────────────────
  console.log('  ── рішення сканера ──');
  const T = (over = {}) => ({ txId: 'T1', comment: 'LBT-X', amount: '1.0', ...over });
  const I = (over = {}) => ({ id: 1, status: 'pending', chain_tx_hash: null, ...over });

  eq(gram.classify(T(), I()).verdict, 'credit', 'живий інтент + сума понад мінімум → зарахувати');
  eq(gram.classify(T({ comment: '' }), null).reason, 'no_comment', 'без коментаря → на розгляд');
  eq(gram.classify(T(), null).reason, 'unknown_comment', 'невідомий коментар → на розгляд');
  eq(gram.classify(T({ amount: '0.000001' }), I()).reason, 'below_min', 'нижче мінімуму → на розгляд, memo не згорає');
  eq(gram.classify(T(), I({ status: 'confirmed', chain_tx_hash: 'T1' })).verdict, 'skip',
    'ПОВТОРНЕ читання вже зарахованої транзакції → тиша, а не фальшивий алерт');
  eq(gram.classify(T({ txId: 'T2' }), I({ status: 'confirmed', chain_tx_hash: 'T1' })).reason, 'comment_reused',
    'ІНША транзакція з витраченим memo → на розгляд');
  eq(gram.classify(T(), I({ status: 'rejected' })).reason, 'comment_reused', 'відхилений інтент не приймає оплату');

  // Runs before anything touches the database on purpose: it needs neither,
  // and it is the half that answers "чи побачить гравець НАШ код".
  depositCodeOwnership();

  // ── intents ──────────────────────────────────────────────────────────────
  console.log('  ── інтенти ──');
  const p = await mk('a');
  const i1 = await tx(t => gram.createIntent(t, p));
  const i2 = await tx(t => gram.createIntent(t, p));
  ok(/^LBT-[0-9A-F]{12}$/.test(i1.memo), `memo має очікуваний формат (${i1.memo})`);
  // The SAME code twice. The unique index is on the memo, not on the player,
  // so nothing in the database prevents a second open intent — and a player
  // who opens the panel twice and sees two different codes has no reason to
  // trust the one already pasted into their wallet.
  eq(i2.memo, i1.memo, 'друге відкриття панелі віддає ТОЙ САМИЙ код, а не карбує новий');
  eq(i1.reused, false, 'перший виклик карбує');
  eq(i2.reused, true, 'другий переюзує і каже про це');
  const { rows: openN } = await pool().query(
    `SELECT count(*)::int n FROM gram_tx
      WHERE player_id = $1 AND type = 'deposit' AND status = 'pending'`, [p]);
  eq(openN[0].n, 1, 'у гравця рівно один відкритий інтент, скільки б разів він не тиснув');

  // ── crediting ────────────────────────────────────────────────────────────
  console.log('  ── зарахування ──');
  const referrer = await mk('ref');
  const refTg = (await pool().query('SELECT telegram_id FROM players WHERE id=$1', [referrer])).rows[0].telegram_id;
  const child = await mk('child', refTg);
  const ci = await tx(t => gram.createIntent(t, child));
  txIds.push('EVX:0');

  const transfer = { txId: 'EVX:0', comment: ci.memo, amount: '10.00000000', sender: '0:aa' };
  const credited = await gram.creditOnce(transfer, ci.id);
  eq(credited && credited.amount, 10, 'депозит зараховано на суму З ЛАНЦЮГА, а не з запиту');
  eq(await bal(child), 10, 'баланс поповнено');
  eq(await bal(referrer), 0.5, 'рефереру нараховано 5%');

  // The same transfer arriving again — a re-scan, or a retried tick.
  const twice = await gram.creditOnce(transfer, ci.id);
  eq(twice, null, 'повторне зарахування того самого інтенту — відмова');
  eq(await bal(child), 10, 'баланс не подвоївся');
  eq(await bal(referrer), 0.5, 'реферальний бонус не подвоївся');

  // The dangerous half of reuse. Reuse is keyed on status='pending', and a
  // version keyed on anything looser would hand this player back the memo they
  // have just SPENT — their next transfer would classify as comment_reused and
  // land in unmatched_deposits while the panel told them it was fine.
  const ci2 = await tx(t => gram.createIntent(t, child));
  ok(ci2.memo !== ci.memo, 'після зарахування видається НОВИЙ код, а не витрачений');
  eq(ci2.reused, false, 'і він саме карбується, а не переюзується');
  txIds.push('EVY:0');

  // Two ticks racing on the same intent.
  const race = await Promise.all([
    gram.creditOnce({ txId: 'EVY:0', comment: ci2.memo, amount: '5.0', sender: '0:bb' }, ci2.id),
    gram.creditOnce({ txId: 'EVY:0', comment: ci2.memo, amount: '5.0', sender: '0:bb' }, ci2.id),
  ]);
  eq(race.filter(Boolean).length, 1, 'два одночасні тіки сканера зарахували РІВНО раз');
  eq(await bal(child), 15, 'баланс зріс рівно на 5');

  // ── unmatched ────────────────────────────────────────────────────────────
  console.log('  ── незіставлені ──');
  txIds.push('EVZ:0');
  const u = { txId: 'EVZ:0', comment: 'не наш коментар', amount: '3.0', sender: '0:dd' };
  eq(await gram.recordUnmatched(u, 'unknown_comment'), true, 'незіставлений переказ записано');
  eq(await gram.recordUnmatched(u, 'unknown_comment'), false,
    'повторне читання того самого переказу НЕ створює другий запис і другий алерт');

  txIds.push('EVL:0');
  const longComment = { txId: 'EVL:0', comment: 'x'.repeat(500), amount: '1.0', sender: 'y'.repeat(200) };
  eq(await gram.recordUnmatched(longComment, 'unknown_comment'), true,
    'надто довгий коментар обрізається, а не втрачає переказ мовчки');

  ok((await gram.openUnmatched(null)).some(x => x.txId === 'EVZ:0'), 'відкриті незіставлені видно адміну');

  // ── 25 серпня, від початку до кінця ──────────────────────────────────────
  // The whole incident against the live database: one payment, offered twice
  // under two event ids, must credit once and produce ONE operator-visible
  // event — not a credit plus "⚠️ Платёж не зачислен".
  console.log('  ── один платіж, два імені ──');
  const dbl = await mk('dbl');
  const di = await tx(t => gram.createIntent(t, dbl));
  const LT2 = 99405635000001;
  const PROV = 'f7f5e993c89c9df58f5f53e327436a0703f6c91c8b7a0e4f1523e836fd30119e';
  const FIN  = '1058d7086fa3ae5cd7a7bcf8f1335f7e964cad2490e957f1d70a8641c4e66547';
  const action = { status: 'ok', type: 'TonTransfer', TonTransfer: {
    recipient: { address: OUR }, sender: { address: '0:ee' },
    amount: '50000000', comment: di.memo } };

  // Read while the trace is in flight, then again once it has settled.
  const readA = ton.incomingFrom([{ event_id: PROV, lt: LT2, actions: [action] }], OUR)[0];
  const readB = ton.incomingFrom([{ event_id: FIN,  lt: LT2, actions: [action] }], OUR)[0];
  txIds.push(readA.txId, readB.txId);

  const c1 = await gram.creditOnce(readA, di.id);
  eq(c1 && c1.amount, 0.05, 'перше читання зарахувало 0.05');
  eq(await bal(dbl), 0.05, 'баланс поповнено один раз');

  // What the scanner sees on the next tick: the SAME row, and — because the
  // name no longer comes from the event id — the SAME name.
  const { rows: stored } = await pool().query(
    'SELECT status, chain_tx_hash FROM gram_tx WHERE id = $1', [di.id]);
  eq(stored[0].chain_tx_hash, readB.txId,
    'збережене ім\'я збігається з ДРУГИМ читанням — тому фільтр сканера його відкине');
  eq(gram.classify(readB, { id: di.id, status: stored[0].status, chain_tx_hash: stored[0].chain_tx_hash }).verdict,
    'skip', 'друге читання того самого платежу → тиша, а не «нужен разбор»');

  // And the belt underneath it: even if identity failed again, the memo-keyed
  // ledger entry refuses the second credit. This is the assertion that would
  // have caught the fix that made it worse.
  eq(await gram.creditOnce(readB, di.id), null, 'друге зарахування того ж інтенту — відмова');
  eq(await bal(dbl), 0.05, 'і 0.05 TON не перетворились на 0.10 GRAM');

  // ── placing a stranded transfer ──────────────────────────────────────────
  console.log('  ── ручне зарахування ──');
  if (!await gram.hasDepositOpsCols()) {
    skip('ручне зарахування незіставленого переказу',
      'міграція 014 не застосована; це НЕ означає, що перевірки пройшли');
  } else {
    const rcv = await mk('rcv');
    const strandedTx = `${TAG}-STRAND:0`;
    txIds.push(strandedTx);
    await gram.recordUnmatched(
      { txId: strandedTx, comment: 'чужий коментар', amount: '7.0', sender: '0:ff', eventId: FIN },
      'unknown_comment');
    const row = await gram.unmatchedByTx(null, strandedTx);
    ok(row && row.id > 0, 'у незіставленого переказу є короткий номер для кнопки');
    ok(row.link && row.link.includes(FIN), 'і посилання на Tonviewer — з event_id, а не з імені');

    const placed = await gram.resolveUnmatched(row.id, rcv, '1199957588');
    eq(placed && placed.amount, 7, 'оператор зарахував переказ названому гравцю');
    eq(await bal(rcv), 7, 'гроші на балансі');
    // Once. The claim on resolved_at is what refuses the second press.
    eq(await gram.resolveUnmatched(row.id, rcv, '1199957588'), null,
      'друге натискання нічого не робить');
    eq(await bal(rcv), 7, 'і баланс не подвоївся');
    ok(!(await gram.openUnmatched(null)).some(x => x.txId === strandedTx),
      'зниклий з черги — оператор більше його не побачить');

    // The player's own history has to explain the money, or the credit is a
    // number that appeared from nowhere.
    const hist = await gram.historyOf(null, rcv);
    ok(hist.some(h => h.type === 'deposit' && h.amount === 7),
      'у гравця в історії видно поповнення, а не тільки змінений баланс');

    // Who received it, and the difference between "credited" and "declined".
    const { rows: res } = await pool().query(
      'SELECT resolved_by, resolved_player_id FROM unmatched_deposits WHERE tx_id = $1', [strandedTx]);
    eq(Number(res[0].resolved_player_id), rcv, 'записано, КОМУ зарахували');
    eq(res[0].resolved_by, '1199957588', 'і хто це вирішив');

    // ── not ours ───────────────────────────────────────────────────────────
    const declineTx = `${TAG}-DECLINE:0`;
    txIds.push(declineTx);
    await gram.recordUnmatched(
      { txId: declineTx, comment: null, amount: '4.0', sender: '0:99' }, 'no_comment');
    const dRow = await gram.unmatchedByTx(null, declineTx);
    ok(await gram.declineUnmatched(dRow.id, '1199957588'), 'переказ можна позначити «не наш»');
    eq(await gram.declineUnmatched(dRow.id, '1199957588'), null, 'повторно — no-op');
    const { rows: dres } = await pool().query(
      'SELECT resolved_at, resolved_player_id FROM unmatched_deposits WHERE tx_id = $1', [declineTx]);
    ok(dres[0].resolved_at && dres[0].resolved_player_id === null,
      'вирішено, але нікому не зараховано — саме це і мала сказати пара колонок');

    // ── the row that would mint GRAM from nothing ──────────────────────────
    // A `comment_reused` row written BEFORE the identity fix is one payment
    // read twice: the money is already on somebody's balance. Placing it would
    // create GRAM. The 25 August row is exactly this shape, and it is still in
    // the table.
    const ghostTx = `${TAG}-GHOST:0`;
    txIds.push(ghostTx);
    await gram.recordUnmatched(
      { txId: ghostTx, comment: di.memo, amount: '0.05', sender: '0:ee', eventId: PROV },
      'comment_reused');
    const gRow = await gram.unmatchedByTx(null, ghostTx);
    const refused = await caught(() => gram.resolveUnmatched(gRow.id, rcv, '1199957588'));
    eq(refused, 'already_credited',
      'переказ, який уже зарахований, зарахувати вдруге НЕ можна — це створило б GRAM з повітря');
    eq(await bal(rcv), 7, 'баланс не змінився від відмови');
    const { rows: still } = await pool().query(
      'SELECT resolved_at FROM unmatched_deposits WHERE tx_id = $1', [ghostTx]);
    ok(still[0].resolved_at === null,
      'і рядок лишився ВІДКРИТИМ — відмова відкотилась разом із заявкою на нього');
  }

  // ── withdrawals ──────────────────────────────────────────────────────────
  console.log('  ── виведення ──');
  const w = await mk('w');
  await money.credit(null, w, 'gram', 100, { reason: 'seed', idemKey: `${TAG}:w` });
  const ADDR = 'UQAvDfWFG0oYX19GGujud_gjqBEHFa_G5Vwv2sIA6ArkAgnr';
  const opts = { minAmount: 10, feePct: 0.05 };

  eq(await caught(() => tx(t => gram.requestWithdraw(t, w, 5, ADDR, opts))), 'below_min', 'нижче мінімуму — відмова');
  eq(await caught(() => tx(t => gram.requestWithdraw(t, w, 20, 'не адреса', opts))), 'bad_address', 'кривий адрес — відмова');
  eq(await caught(() => tx(t => gram.requestWithdraw(t, w, 500, ADDR, opts))), 'no_funds', 'понад баланс — відмова');
  eq(await bal(w), 100, 'жодна невдала спроба не зачепила баланс');

  const req = await tx(t => gram.requestWithdraw(t, w, 40, ADDR, opts));
  eq(await bal(w), 60, 'кошти списані ПРИ СТВОРЕННІ заявки, не при виплаті');
  eq(req.payout, 38, 'до виплати 40 мінус 5% комісії');

  eq(await caught(() => tx(t => gram.requestWithdraw(t, w, 10, ADDR, opts))), 'already_pending',
    'друга заявка, поки перша на розгляді, — відмова');

  // Reject refunds exactly once, even pressed twice.
  const back = await tx(t => gram.rejectWithdraw(t, req.id, '999'));
  eq(await bal(w), 100, 'відхилення повернуло кошти');
  eq(await tx(t => gram.rejectWithdraw(t, req.id, '999')), null, 'повторне відхилення — no-op');
  eq(await bal(w), 100, 'кошти не повернулись двічі');
  ok(back && back.amount === 40, 'відхилення повідомило суму повернення');

  // Paying it out is also once-only.
  const req2 = await tx(t => gram.requestWithdraw(t, w, 30, ADDR, opts));
  const paid = await tx(t => gram.markWithdrawPaid(t, req2.id, '999', 'hash1'));
  ok(paid && paid.amount === 30, 'виплату зафіксовано');
  eq(await tx(t => gram.markWithdrawPaid(t, req2.id, '999', 'hash2')), null,
    'дві адміни натиснули «виплачено» — зараховується один раз');
  eq(await bal(w), 70, 'виплата не повертає і не списує повторно');

  // ── the three ways a withdrawal ends ─────────────────────────────────────
  console.log('  ── три кнопки адміна ──');
  const cards = require('../server/ops-cards');

  // «Отменить (забрать)» — the payout does not happen and the GRAM does NOT
  // come back. The whole reason it is a separate function from reject().
  const req3 = await tx(t => gram.requestWithdraw(t, w, 20, ADDR, opts));
  eq(await bal(w), 50, 'заявка списала кошти');
  const kept = await tx(t => gram.forfeitWithdraw(t, req3.id, '1199957588', 'фрод'));
  ok(kept && kept.refunded === false, 'відмова із утриманням повідомляє refunded=false');
  eq(await bal(w), 50, 'кошти НЕ повернулись — саме цього й хотіли');
  eq(await tx(t => gram.forfeitWithdraw(t, req3.id, '1199957588')), null, 'повторне натискання — no-op');
  eq(await bal(w), 50, 'і після повтору баланс не змінився');

  // A decided request cannot be decided again by a different button — two
  // admins pressing different things within the same second.
  const req4 = await tx(t => gram.requestWithdraw(t, w, 15, ADDR, opts));
  const [a, b] = await Promise.all([
    tx(t => gram.markWithdrawPaid(t, req4.id, '111')).catch(() => null),
    tx(t => gram.rejectWithdraw(t, req4.id, '222')).catch(() => null),
  ]);
  eq([a, b].filter(Boolean).length, 1, 'два адміни натиснули РІЗНІ кнопки — спрацювала одна');
  const { rows: st4 } = await pool().query('SELECT status FROM gram_tx WHERE id=$1', [req4.id]);
  ok(['confirmed', 'rejected'].includes(st4[0].status), `статус визначений однозначно (${st4[0].status})`);

  // The card must stay readable after the decision: the buttons go, the
  // outcome and the admin arrive, and nothing that was there before is lost.
  const w3 = await cards.loadWithdraw(req3.id, opts.feePct);
  const before = cards.withdrawCard({ ...w3, status: 'pending' });
  const after = cards.withdrawCard(w3, { decided: true });
  ok(before.includes('Исполняется'), 'до рішення картка каже «Исполняется»');
  ok(after.includes('удержаны'), 'після — каже, що кошти утримані');
  ok(after.includes(ADDR), 'адрес лишився в картці після рішення');
  ok(after.includes('1199957588'), 'у картці видно, ЯКИЙ адмін вирішив');
  ok(after.includes('Создана'), 'час створення лишився');
  eq(cards.withdrawButtons(req3.id).length, 3, 'кнопок рівно три');

  // ── the ledger still explains every balance ──────────────────────────────
  const mine = made.map(Number);
  const drift = (await money.reconcile(null)).filter(r => mine.includes(r.playerId));
  eq(drift.length, 0, 'звірка чиста після всіх депозитів і виведень');

  await addressCheck();
  await watermarkCheck();
}

// ── the name of a payment ───────────────────────────────────────────────────
// The case that actually happened, on 25 August, encoded with the real values.
//
// One 0.05 TON transfer produced a credit at 21:52 and "⚠️ Платёж не зачислен"
// at 21:53. Fetched back from TonAPI, both ids resolve to the SAME event with
// the SAME lt — the scanner had read the trace while it was still in flight,
// under a provisional event id, and TonAPI renamed it when it settled.
//
// Every assertion below fails against the old `${event_id}:${index}` key.
function transferIdentity(OUR, inTx) {
  console.log('  ── ім\'я переказу ──');
  const PROVISIONAL = 'f7f5e993c89c9df58f5f53e327436a0703f6c91c8b7a0e4f1523e836fd30119e';
  const SETTLED     = '1058d7086fa3ae5cd7a7bcf8f1335f7e964cad2490e957f1d70a8641c4e66547';
  const LT = 99405635000001;

  const first  = ton.incomingFrom([{ event_id: PROVISIONAL, lt: LT, actions: [inTx] }], OUR);
  const second = ton.incomingFrom([{ event_id: SETTLED,     lt: LT, actions: [inTx] }], OUR);
  eq(first[0].txId, second[0].txId,
    'ОДИН переказ, прочитаний під двома event_id, має ОДНЕ ім\'я — це і є баг 25 серпня');
  eq(first[0].txId, `${LT}:0`, 'ім\'я — логічний час рахунку, а не хеш трейсу');
  eq(first[0].eventId, PROVISIONAL, 'event_id збережено окремо — він потрібен для посилання');

  // The other half: a trace that has not settled has no name yet, so it is not
  // read at all. parseAction's `status === 'ok'` is a DIFFERENT field on a
  // different object and does not catch this — an action can be ok inside an
  // event still in flight, which is exactly what happened.
  eq(ton.incomingFrom([{ event_id: SETTLED, lt: LT, in_progress: true, actions: [inTx] }], OUR).length, 0,
    'незавершений трейс не читається взагалі');
  eq(ton.incomingFrom([{ event_id: SETTLED, actions: [inTx] }], OUR).length, 0,
    'подія без lt пропускається — інакше всі такі перекази злиплись би в один id');
  // The reverse priority: an id we cannot LINK to is still money.
  eq(ton.incomingFrom([{ lt: 7, actions: [inTx] }], OUR).length, 1,
    'подія без event_id усе одно зараховується — це коштує посилання, а не депозит');

  // A logical time is a name, not a URL. A link built from one opens on
  // "transaction not found", which reads as "цього переказу немає в мережі".
  ok(ton.explorerLink(SETTLED).endsWith(SETTLED), 'event_id дає посилання на Tonviewer');
  eq(ton.explorerLink(`${SETTLED}:0`), `https://tonviewer.com/transaction/${SETTLED}`,
    'старий формат id (до виправлення) теж дає робоче посилання');
  eq(ton.explorerLink(`${LT}:0`), null,
    'новий формат id НЕ вдає посилання, якого не існує');
}

// ── the mark must not step over a trace that has not landed ─────────────────
// The refusal above is only safe if the watermark stays behind the event it
// refused: the mark advances to `highest` on a clean pass, and a mark that
// moved past an unread event is a deposit nobody ever sees again.
//
// No network. `fetch` is replaced with a function that returns canned pages
// and is put back afterwards — nothing here reaches TonAPI.
async function watermarkHoldCheck() {
  console.log('  ── метка і незавершені трейси ──');
  const realFetch = global.fetch;
  const page = evs => async () => ({ status: 200, json: async () => ({ events: evs }) });
  try {
    global.fetch = page([{ event_id: 'A', lt: 100, actions: [] }]);
    const settled = await ton.fetchSince(50, { pageSize: 50, maxPages: 1 });
    eq(settled.highest, 100, 'усе завершене — метка йде на найбільший lt');

    global.fetch = page([
      { event_id: 'A', lt: 100, actions: [] },
      { event_id: 'B', lt: 200, in_progress: true, actions: [] },
    ]);
    const held = await ton.fetchSince(50, { pageSize: 50, maxPages: 1 });
    eq(held.highest, 199,
      'незавершений трейс притримує метку ПІД собою — наступний тік прочитає його знову');
    ok(held.highest >= 50, 'і ніколи не тягне метку назад, у вже прочитану історію');

    // An old unsettled trace below the mark must not re-open the wallet's past.
    global.fetch = page([
      { event_id: 'A', lt: 100, actions: [] },
      { event_id: 'C', lt: 10, in_progress: true, actions: [] },
    ]);
    const behind = await ton.fetchSince(50, { pageSize: 50, maxPages: 1 });
    eq(behind.highest, 100,
      'давній незавершений трейс НИЖЧЕ метки її не зсуває — інакше історія гаманця перечитається');
  } finally {
    global.fetch = realFetch;
  }
}

// ── whose code the player is shown ──────────────────────────────────────────
// A SOURCE check, not a database one, because this is the part of the deposit
// path where being wrong costs money in silence.
//
// What it is guarding against, exactly: js/ui.js used to compute its own memo
// in openGramDepositModal —
//
//     const memo = (player && player.telegramId) ? player.telegramId
//                  : (netUsername || String(Date.now()));
//
// — print it as the deposit comment, and hand it to the wallet button. Nothing
// in this bundle ever sets player.telegramId, so it was always the player's
// USERNAME, which is drawn above their head in the world. Meanwhile the server
// minted LBT-xxxxxxxxxxxx of its own and the scanner matched on THAT, so every
// real transfer arrived carrying a comment nothing could match and went to
// unmatched_deposits. Nothing threw, nothing was logged as an error, and the
// only evidence was TON sitting on the chain with no owner.
//
// Three properties keep it dead, and losing any one of them brings it back:
//   * the modal never invents a memo, not even as a fallback
//   * the request that asks for one carries no payload the server could read
//   * the handler that answers it takes no payload at all
//
// The first assertion is the only one that is not about the bug: it is about
// this check having stopped LOOKING. Rename any of the six places below and
// every assertion after it would search an empty string and report success —
// the exact shape of the detectors this project has already shipped twice. It
// is one line rather than one per group so that it cannot itself be half-true.
// The BODY, past the parameter list. Skipping the parameter list is the whole
// subtlety: `function onGramDepositIntent({ memo, address })` opens a brace
// before the body does, and a version of this that took the first `{` returned
// the destructure — so every check against that body searched four words and
// reported a failure that was not there.
function _fnBody(src, name) {
  for (const needle of [`function ${name}(`, `${name} = function(`]) {
    const at = src.indexOf(needle);
    if (at < 0) continue;
    let i = at + needle.length - 1, depth = 0;
    for (; i < src.length; i++) {                       // past the parameters
      if ('([{'.includes(src[i])) depth++;
      else if (')]}'.includes(src[i]) && --depth === 0) { i++; break; }
    }
    const open = src.indexOf('{', i);
    if (open < 0) continue;
    depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
    }
  }
  return null;
}

function depositCodeOwnership() {
  console.log('  ── чий код пополнення ──');
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const ui = read('js/ui.js');
  const net = read('js/network.js');
  const eco = read('server/handlers2/economy.js');

  const modal = _fnBody(ui, 'openGramDepositModal');
  const fromServer = _fnBody(ui, 'onGramDepositIntent');
  const tc = _fnBody(ui, '_tcDepositSend');
  const section = _fnBody(ui, '_renderTonDepositSection');
  const emit = /_emitWhenAuthed\(\s*'gramDepositRequest'\s*,\s*([^)]*)\)/.exec(net);
  const on = /safeOn\(\s*'gramDepositRequest'\s*,\s*(\([^)]*\))\s*=>/.exec(eco);

  const gone = Object.entries({
    openGramDepositModal: modal, onGramDepositIntent: fromServer,
    _tcDepositSend: tc, _renderTonDepositSection: section,
    'емісія gramDepositRequest': emit, 'обробник gramDepositRequest': on,
  }).filter(([, v]) => !v).map(([k]) => k);
  ok(gone.length === 0, 'усі шість місць знайдено — є що перевіряти',
    `не знайдено: ${gone.join(', ')} — перевірки нижче шукали б у порожнечі`);
  if (gone.length) return;

  // ── the modal invents nothing ──
  const invented = ['telegramId', 'netUsername', 'Date.now()'].filter(s => modal.includes(s));
  eq(invented.length, 0, 'модалка не вигадує memo сама', `лишилось: ${invented.join(', ')}`);

  // ── the memo has exactly one source, and it is the server ──
  // Both halves in one assertion on purpose. "Рівно одне присвоєння" is true of
  // the version that invented the memo too — it invented it exactly once. What
  // makes it mean anything is WHERE that one write lives.
  const nonNull = [...ui.matchAll(/window\._gramDepositMemo\s*=\s*([^;\n]+)/g)]
    .map(m => m[1].trim()).filter(w => w !== 'null');
  ok(nonNull.length === 1 && /window\._gramDepositMemo\s*=\s*memo\b/.test(fromServer),
    'memo пишеться рівно з одного місця — з відповіді сервера (onGramDepositIntent)',
    `не-null присвоєнь: ${nonNull.length} (${nonNull.join(' | ')})`);

  // ── and both ways of paying read that one source ──
  // Reading it is not enough by itself: the old version read the same global,
  // it just held something the client had made up. Refusing to send while it is
  // empty is the half that has teeth — this function builds the on-chain
  // comment cell itself, so firing without one puts real TON on the chain with
  // nothing to tie it to an account.
  ok(tc.includes('window._gramDepositMemo') && /if\s*\(!memo/.test(tc),
    'кнопка гаманця бере той самий memo і не відправляє, поки його немає');
  ok(!/\bnet[A-Z][A-Za-z]*\(/.test(tc),
    'і нічого не емітить після відправки — інтент уже існує, другий викликав би другий код');
  ok(/!window\._gramDepositMemo/.test(section),
    'кнопка гаманця взагалі не малюється, поки коду немає');

  // ── the request carries nothing, and the handler reads nothing ──
  eq(emit[1].trim(), '{}', 'запит на код не несе жодного поля',
    'клієнт, який може назвати memo, може назвати чуже');
  eq(on[1], '()', 'обробник не приймає payload узагалі',
    'параметр тут — це місце, куди memo від клієнта колись повернеться');
}

// ── the address a person reads ──────────────────────────────────────────────
async function addressCheck() {
  console.log('  ── формат адрес ──');
  const ton = require('../server/ton');

  // The proof that the checksum is computed correctly: decode a known-good
  // wallet to its raw form, encode it back, and require the same 48
  // characters. A wrong CRC would still produce a plausible-looking string.
  const known = 'UQA7K4dy_mxGUBrEJgpMId7IJhiYNaUiNJyltJReZDuQY5YS';
  const buf = Buffer.from(known, 'base64url');
  const raw = (buf[1] === 0xff ? -1 : buf[1]) + ':' + buf.subarray(2, 34).toString('hex');
  eq(ton.friendlyAddress(raw), known, 'сирий вигляд → UQ і назад дає ту саму адресу');
  eq(buf.length, 36, 'адреса це 36 байтів: тег, воркчейн, 32 байти хешу, 2 байти суми');

  // TonAPI reports senders raw. Ten alerts full of 0:755933… is what an
  // operator cannot match against anything.
  const sender = '0:755933366ad067404be905daa2bcc002c2c2e9cbe0a0d551b3134ae5b179574c';
  ok(ton.friendlyAddress(sender).startsWith('UQ'),
    `адреса відправника показується як UQ (${ton.friendlyAddress(sender)})`);
  ok(ton.friendlyAddress(sender, { bounceable: true }).startsWith('EQ'),
    'bounceable-варіант дає EQ — це для контрактів');

  // Idempotent, and that matters: an address that arrived friendly must not be
  // rewritten. Turning someone's EQ into a UQ changes what it means.
  eq(ton.friendlyAddress(known), known, 'вже дружня адреса не переписується');
  const eq_addr = ton.friendlyAddress(sender, { bounceable: true });
  eq(ton.friendlyAddress(eq_addr), eq_addr, 'EQ не перетворюється на UQ');

  eq(ton.friendlyAddress('не-адреса'), 'не-адреса', 'не-адреса показується як є, а не як помилка');
  eq(ton.friendlyAddress(null), '', 'null не ламає картку');
  ok(/^UQ.{4}….{6}$/.test(ton.shortAddress(sender)), `скорочення читається (${ton.shortAddress(sender)})`);
}

// ── the scanner does not re-read a wallet's past ────────────────────────────
async function watermarkCheck() {
  console.log('  ── метка сканування ──');
  const KEY = 'deposit:last_lt';

  // The mark is a LOGICAL TIME — an ever-increasing number the chain assigns
  // to each transaction — not a timestamp. Getting that wrong is easy and
  // silent: a mark set to Date.now()/1000 is ~1.8e9 against real values around
  // 9.9e13, which is below everything and changes nothing while looking fixed.
  const saved = (await pool().query('SELECT value FROM kv WHERE key = $1', [KEY])).rows[0];
  ok(!saved || Number(saved.value) > 1e12,
    `метка це логічний час, а не секунди (${saved && saved.value})`);

  await pool().query('DELETE FROM kv WHERE key = $1', [KEY]);
  eq(await gram._watermark(), 0, 'відсутня метка читається як 0 — саме тому потрібен bootstrap');

  // The first scan must PLANT the mark and process nothing. Without it, an
  // empty mark means "read the whole history", and this wallet has months of
  // it: ten "платёж не зачислен" alerts in one second about payments credited
  // correctly a month ago. An operator who learns those are meaningless is an
  // operator who scrolls past the real one.
  const first = await gram.scanOnce();
  if (first.reason === 'bootstrap_unreadable') {
    ok(true, 'ланцюг недоступний — bootstrap відклався до наступного тіку, метка НЕ виставлена');
    const still = await pool().query('SELECT value FROM kv WHERE key = $1', [KEY]);
    eq(still.rows.length, 0, 'і не записана нулем, інакше історія прочиталась би вся');
  } else {
    ok(first.bootstrapped > 1e12, `перший прохід виставив метку (lt=${first.bootstrapped})`);
    eq(first.credited.length, 0, 'і не зарахував нічого з історії');
    eq(first.unmatched.length, 0, 'і не підняв жодного розбору по старих платежах');
    const now = await pool().query('SELECT value FROM kv WHERE key = $1', [KEY]);
    eq(Number(now.rows[0].value), first.bootstrapped, 'метка збережена саме на цьому lt');

    // The second pass is the ordinary one and must not repeat the bootstrap.
    const second = await gram.scanOnce();
    eq(second.bootstrapped, undefined, 'другий прохід уже звичайний, а не повторний bootstrap');
  }

  if (saved) {
    await pool().query(
      `INSERT INTO kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [KEY, saved.value]);
  }
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (txIds.length) await q('DELETE FROM unmatched_deposits WHERE tx_id = ANY($1)', [txIds]);
  if (!made.length) return;
  await q('DELETE FROM gram_tx WHERE player_id = ANY($1)', [made]);
  for (const t of ['player_vip', 'player_prefs', 'player_progress', 'ledger', 'balances']) {
    await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
  }
  await q('DELETE FROM players WHERE id = ANY($1)', [made]);
}


main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`
      + (skipped ? `, \x1b[33m${skipped} НЕ ЗАПУСКАЛОСЬ\x1b[0m` : ''));
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    if (skipped) {
      console.log('  \x1b[33mчастина перевірок не виконана — застосуйте міграцію 014'
        + ' і запустіть ще раз\x1b[0m');
    }
    process.exit(fail ? 1 : 0);
  });
