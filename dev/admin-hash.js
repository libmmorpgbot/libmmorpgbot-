#!/usr/bin/env node
'use strict';
// ── Generates the admin secrets ─────────────────────────────────────────────
//
//   node dev/admin-hash.js "ваш-пароль"
//
// Prints the two env values the new auth needs, and nothing else — so the
// output can be pasted straight into /srv/liberty/env.
//
// The password is read from argv rather than prompted because this runs over
// SSH in a non-interactive shell. It WILL land in the shell history; the whole
// point of the hash is that it stops mattering, but clear the history anyway if
// the machine is shared:  history -d $((HISTCMD-1))

const crypto = require('crypto');
const { hashPassword } = require('../server/admin-auth');

const password = process.argv[2];
if (!password) {
  console.error('Використання: node dev/admin-hash.js "ваш-пароль"');
  process.exit(1);
}
if (password.length < 12) {
  // Not a hard refusal — it is their password. But scrypt makes an offline
  // attack expensive per guess, not impossible, and a short password is still
  // reachable no matter how good the KDF is.
  console.error('⚠️  Пароль коротший за 12 символів. scrypt робить перебір дорогим, але не неможливим.\n');
}

console.log('# ── адмінка: нові секрети ─────────────────────────────────────');
console.log('# ADMIN_PASSWORD більше НЕ потрібен — приберіть його зі змінних.');
console.log('# Пароль тепер не зберігається у відкритому вигляді ніде.');
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
console.log('');
console.log('# Ключ підпису токенів. НЕ пароль — саме в цьому суть зміни:');
console.log('# зі старою схемою будь-який токен дозволяв перебирати пароль офлайн.');
console.log(`ADMIN_TOKEN_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
