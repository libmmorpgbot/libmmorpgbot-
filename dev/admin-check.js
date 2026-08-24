#!/usr/bin/env node
'use strict';
// ── Proof that the admin credential is no longer a password oracle ──────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/admin-check.js
//
// The first block is the attack the old scheme allowed, run against both
// implementations. It passes only when the old one falls and the new one does
// not — a test that would still pass if the fix were removed is not a test of
// the fix.

const crypto = require('crypto');
process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET
  || crypto.randomBytes(32).toString('base64url');

const { pool, close } = require('../server/db');
const auth = require('../server/admin-auth');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const PASSWORD = 'correct-horse-battery-staple';

async function main() {
  console.log('\nadmin-check\n');

  // ── the old scheme, reproduced ───────────────────────────────────────────
  // token = base64url({ ts, sig }) where sig = HMAC-SHA256(PASSWORD, "adm:"+ts)
  console.log('  ── стара схема ──');
  const ts = Date.now();
  const oldSig = crypto.createHmac('sha256', PASSWORD).update(`adm:${ts}`).digest('hex');
  const oldToken = Buffer.from(JSON.stringify({ ts, sig: oldSig })).toString('base64url');

  // An attacker who holds ONE token has (message, MAC) and guesses offline.
  // The candidate list stands in for a wordlist; the point is the cost per
  // guess, which is a single SHA-256.
  const guesses = ['admin', 'password', '123456', PASSWORD, 'liberty'];
  const { ts: leakedTs } = JSON.parse(Buffer.from(oldToken, 'base64url').toString());
  const t0 = process.hrtime.bigint();
  let cracked = null;
  for (const g of guesses) {
    if (crypto.createHmac('sha256', g).update(`adm:${leakedTs}`).digest('hex') === oldSig) { cracked = g; break; }
  }
  const oldMs = Number(process.hrtime.bigint() - t0) / 1e6;
  eq(cracked, PASSWORD, `стара схема: пароль зламано офлайн за ${oldMs.toFixed(2)} мс з ${guesses.length} спроб`);
  ok(oldMs < 5, 'один здогад коштує менше мілісекунди — це швидкість GPU-перебору');

  // ── the new scheme, same attack ──────────────────────────────────────────
  console.log('  ── нова схема ──');
  const token = await auth.issue('admin');
  const [payloadB64, sig] = token.split('.');
  let broke = false;
  for (const g of [...guesses, process.env.ADMIN_TOKEN_SECRET.slice(0, 8)]) {
    if (crypto.createHmac('sha256', g).update(payloadB64).digest('base64url') === sig) { broke = true; break; }
  }
  ok(!broke, 'нова схема: токен НЕ підписаний паролем — перебирати нічого');

  const hash = auth.hashPassword(PASSWORD);
  ok(!hash.includes(PASSWORD), 'збережений хеш не містить пароля');
  ok(hash.startsWith('scrypt$16384$'), 'хеш зі scrypt і робочим параметром N=16384');

  const t1 = process.hrtime.bigint();
  ok(auth.verifyPassword(PASSWORD, hash), 'правильний пароль приймається');
  const scryptMs = Number(process.hrtime.bigint() - t1) / 1e6;
  ok(scryptMs > 20, `одна перевірка коштує ${scryptMs.toFixed(0)} мс — перебір хеша дорогий (було <1 мс)`);
  ok(!auth.verifyPassword('wrong', hash), 'неправильний пароль відхиляється');
  ok(!auth.verifyPassword(PASSWORD, 'сміття'), 'зіпсований хеш не проходить');

  // Two hashes of the same password differ — the salt is doing its job, so a
  // precomputed table is useless.
  ok(auth.hashPassword(PASSWORD) !== hash, 'два хеші того самого пароля різні (сіль)');

  // ── token integrity ──────────────────────────────────────────────────────
  console.log('  ── цілісність токена ──');
  ok(await auth.verify(token), 'свіжий токен валідний');
  ok(!await auth.verify(token.slice(0, -1)), 'зіпсований підпис відхилено');
  ok(!await auth.verify(`${payloadB64}.${'A'.repeat(sig.length)}`), 'підроблений підпис відхилено');
  ok(!await auth.verify(''), 'порожній токен відхилено');
  ok(!await auth.verify('не.токен'), 'сміття замість токена відхилено');

  // The payload rewritten to never expire — signed with nothing, so it fails.
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', v: 1, iat: 0, exp: 2e13 })).toString('base64url');
  ok(!await auth.verify(`${forged}.${sig}`), 'переписаний payload зі старим підписом відхилено');

  const expired = Buffer.from(JSON.stringify({ sub: 'a', v: 1, iat: 0, exp: Date.now() - 1 })).toString('base64url');
  ok(!await auth.verify(`${expired}.${crypto.createHmac('sha256', process.env.ADMIN_TOKEN_SECRET).update(expired).digest('base64url')}`),
    'прострочений токен відхилено навіть із ВАЛІДНИМ підписом');

  // ── revocation ───────────────────────────────────────────────────────────
  console.log('  ── відкликання ──');
  const before = await auth.issue('admin');
  ok(await auth.verify(before), 'токен до відкликання валідний');
  await auth.revokeAll();
  ok(!await auth.verify(before), 'після відкликання СТАРИЙ токен недійсний');
  ok(!await auth.verify(token), 'і всі інші видані раніше — теж');
  const after = await auth.issue('admin');
  ok(await auth.verify(after), 'новий токен після відкликання працює');

  // ── config guard ─────────────────────────────────────────────────────────
  console.log('  ── захист від кривої конфігурації ──');
  const saved = process.env.ADMIN_TOKEN_SECRET;
  process.env.ADMIN_TOKEN_SECRET = 'короткий';
  let refused = false;
  try { await auth.issue('x'); } catch { refused = true; }
  ok(refused, 'короткий ADMIN_TOKEN_SECRET — відмова стартувати, а не тихий дефолт');
  process.env.ADMIN_TOKEN_SECRET = saved;

  process.env.ADMIN_PASSWORD = 'ще-лишився';
  ok(auth.configProblems().some(p => /ADMIN_PASSWORD ще задано/.test(p)),
    'залишений ADMIN_PASSWORD у змінних помічений і названий');
  delete process.env.ADMIN_PASSWORD;

  // ── lockout ──────────────────────────────────────────────────────────────
  console.log('  ── блокування перебору ──');
  const ip = '203.0.113.9';
  eq(auth.lockedFor(ip), 0, 'спочатку IP не заблокований');
  for (let i = 0; i < 8; i++) auth.recordFail(ip);
  ok(auth.lockedFor(ip) > 0, 'після 8 невдач IP заблоковано');
  auth.clearFails(ip);
  eq(auth.lockedFor(ip), 0, 'успішний вхід знімає блокування');

  // ── audit ────────────────────────────────────────────────────────────────
  console.log('  ── журнал дій ──');
  await auth.audit('1199957588', 'withdraw_paid', { refType: 'gram_tx', refId: '999', meta: { amount: 40 } });
  const { rows } = await pool().query(
    `SELECT admin_tg_id, action, meta FROM admin_actions WHERE ref_id = '999' ORDER BY id DESC LIMIT 1`);
  eq(rows.length, 1, 'дія адміна записана в журнал');
  eq(rows[0].admin_tg_id, '1199957588', 'видно, ЯКИЙ адмін це зробив');
  eq(rows[0].meta.amount, 40, 'подробиці збережені');
  await pool().query(`DELETE FROM admin_actions WHERE ref_id = '999'`).catch(() => {});
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
