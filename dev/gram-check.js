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

const { pool, tx, close } = require('../server/db');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const gram = require('../server/db/repos/gram');
const ton = require('../server/ton');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
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
  eq(two[0].txId, 'EV1:0', 'id складається з події та індексу дії');

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

  // ── intents ──────────────────────────────────────────────────────────────
  console.log('  ── інтенти ──');
  const p = await mk('a');
  const i1 = await tx(t => gram.createIntent(t, p));
  const i2 = await tx(t => gram.createIntent(t, p));
  ok(/^LBT-[0-9A-F]{12}$/.test(i1.memo), `memo має очікуваний формат (${i1.memo})`);
  ok(i1.memo !== i2.memo, 'два інтенти отримали різні memo');

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

  // Two ticks racing on the same intent.
  const ci2 = await tx(t => gram.createIntent(t, child));
  txIds.push('EVY:0');
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

  // ── the ledger still explains every balance ──────────────────────────────
  const mine = made.map(Number);
  const drift = (await money.reconcile(null)).filter(r => mine.includes(r.playerId));
  eq(drift.length, 0, 'звірка чиста після всіх депозитів і виведень');
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
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
