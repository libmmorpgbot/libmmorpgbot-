#!/usr/bin/env node
'use strict';
// ── Every SQL statement, checked against the real schema ────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/sql-check.js
//
// Three column mismatches have now been found by a player running into them:
//
//   pvp_history.won / .reward   the table was created without them; every
//                               write since raised 42703 into a catch, so the
//                               duel history was empty from the first day
//   market_listings FK          the wrong kind of reference, which turned a
//                               failed enhancement into a free one
//   gram_tx.kind = 'credited'   two errors in one line: the column is `type`,
//                               and there is no 'credited' in the enum. The
//                               referral panel could never render
//
// Each was invisible until somebody opened the right screen, because a query
// that names a column which does not exist is a RUNTIME error — it costs
// nothing until executed, and every one of these lives behind a handler most
// players never touch.
//
// PostgreSQL will check a statement without running it. PREPARE resolves every
// table, column, function and enum literal and infers the parameter types,
// then throws exactly what the query would have thrown. So this asks the
// database to read all ~250 statements in the codebase, and executes none of
// them: no rows written, no side effects, seconds to run.
//
// It is the check that would have caught all three, on the day each was
// written.

const fs = require('fs');
const path = require('path');
const { pool, close } = require('../server/db');

const ROOT = path.join(__dirname, '..');
const DIRS = ['server/db/repos', 'server/handlers2', 'server'];

let pass = 0, fail = 0; const failures = [];
const RED = '\x1b[31m', GRN = '\x1b[32m', DIM = '\x1b[2m', OFF = '\x1b[0m';

// Files that are not what runs — the retired Mongo build (see
// dev/reachable-check.js) — and this file's own subject matter.
const SKIP = /[\\/](handlers|models|migrations)[\\/]|[\\/]index\.js$/;

function files() {
  const out = [];
  const seen = new Set();
  for (const d of DIRS) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (SKIP.test(rel.replace(/\//g, path.sep))) continue;
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
      }
    };
    walk(d);
  }
  return out;
}

// Comments out first. This file's own subject is prose that looks like SQL:
// `// with no upper bound and no finiteness check, created a "request"` reads
// as a WITH clause to any regex, and three such lines were reported as syntax
// errors before this existed. Replaced with spaces rather than removed, so
// every line number in the report still points at the real line.
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

// Every string literal whose first word is a statement keyword.
// Matching on the literal rather than on the call site means it does not
// matter whether it was passed to query(), t.query(), pool().query() or
// assembled in a variable first.
//
// ALL THREE QUOTE CHARACTERS, not just the backtick. The first version of this
// matched `` ` `` alone, on the assumption that a statement long enough to
// matter gets written as a template literal. Seventy-nine of them are not:
// every short one-liner in the repos — `query(db, 'SELECT id FROM players
// WHERE telegram_id = $1')` — is single-quoted, and those were neither checked
// nor counted as skipped. They simply did not exist as far as the report was
// concerned, so "178 запитів перевірено базою" described two thirds of them
// while reading as all of them. A short statement names columns exactly as a
// long one does, and pvp_history.won — the column that started this file — was
// missing from a one-liner.
function statements(src) {
  const out = [];
  // The quote character is captured and used as the terminator, so an
  // apostrophe inside a double-quoted statement (and a double quote inside a
  // single-quoted one) does not cut the literal short.
  const re = /(['"`])(\s*(?:WITH|SELECT|INSERT|UPDATE|DELETE)\b(?:\\.|[^\\])*?)\1/gi;
  let m;
  while ((m = re.exec(src))) {
    const quote = m[1];
    const sql = m[2];
    // A statement keyword alone is not enough. English prose begins with
    // "With" and "Select" too — one comment in server/ton.js starts "with
    // ok:true" and was reported as a syntax error. Real SQL of these five
    // kinds always carries one of these words as well.
    if (!/\b(FROM|INTO|SET|VALUES)\b/i.test(sql)) continue;
    // Only a template literal may span lines. A quoted match that does is the
    // regex having run past an unrelated closing quote on a later line, not a
    // statement — handing that to PREPARE would invent a syntax error.
    if (quote !== '`' && /\n/.test(sql)) continue;
    // Line number of the opening quote, for the report.
    const line = src.slice(0, m.index).split('\n').length;
    // A literal glued to a `+` is one PIECE of a statement. There are none
    // today; there is no reason for the day somebody adds one to be the day
    // this file starts reporting a syntax error that is not there.
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const partial = /\+\s*$/.test(before) || /^\s*\+/.test(after);
    out.push({ sql, line, partial });
  }
  return out;
}

async function main() {
  console.log('\nsql-check\n');
  const list = files();
  let total = 0, skipped = 0;
  const skippedList = [];

  const client = await pool().connect();
  try {
    for (const rel of list) {
      const src = strip(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const sts = statements(src);
      if (!sts.length) continue;

      for (const st of sts) {
        total++;
        // A statement built by interpolation, or glued together with `+`,
        // cannot be checked as written — the pieces are decided at runtime.
        // Counted and named rather than quietly dropped, because "checked
        // everything" has to be true.
        if (/\$\{/.test(st.sql) || st.partial) {
          skipped++; skippedList.push(`${rel}:${st.line}`); continue;
        }

        // A NAME PER STATEMENT, deallocated afterwards. PREPARE survives a
        // ROLLBACK, which the first version of this assumed it did not: one
        // name was reused, and every statement after the first reported
        // "prepared statement already exists". A hundred and fifty invented
        // failures, hiding however many real ones.
        const name = `_sqlchk_${total}`;
        await client.query('BEGIN');
        try {
          await client.query(`PREPARE ${name} AS ${st.sql}`);
          pass++;
        } catch (err) {
          fail++;
          const where = `${rel}:${st.line}`;
          failures.push(where);
          console.log(`${RED}FAIL${OFF}  ${where}`);
          console.log(`      ${RED}${err.message}${OFF}`);
          const first = st.sql.trim().split('\n').slice(0, 2).map(l => l.trim()).join(' ');
          console.log(`      ${DIM}${first.slice(0, 100)}${OFF}`);
        } finally {
          await client.query('ROLLBACK');
          await client.query(`DEALLOCATE ${name}`).catch(() => {});
        }
      }
    }
  } finally {
    client.release();
  }

  if (skipped) {
    console.log(`\n${DIM}${skipped} зібрані з частин під час роботи — статично не перевірити:${OFF}`);
    for (const s of skippedList) console.log(`${DIM}  ${s}${OFF}`);
    // Each of these builds its column list at runtime from an allow-list or a
    // schema probe, so there is no single text to hand the parser. All six are
    // EXECUTED by a suite that runs against this database, which is the other
    // way to find out a column is missing — later, but not never.
    console.log(`${DIM}  (кожен із них виконується в players-check, market-check`
      + ` або pvp-history-check)${OFF}`);
  }

  console.log(`\n  ${GRN}${pass} запитів перевірено базою${OFF}`
    + ` · ${fail ? RED : DIM}${fail} з помилками${OFF}`
    + ` · ${DIM}${skipped} динамічних${OFF}`
    + ` · ${DIM}${total} усього${OFF}`);

  // ── A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS ─────────────────────
  // This file had no assertion of its own at all: it counted failures and
  // exited 0 when there were none, which is also what it did when it read
  // zero statements. Every way of breaking the scan itself — a rename of
  // server/handlers2, a SKIP pattern that grew a `.*`, one wrong character in
  // the literal regex — came out as a green run against a database it never
  // asked a single question. The same hole dev/api-check.js closed after
  // walking sixty-two files, matching nothing, and printing a cheerful PASS.
  //
  // The floors are far below the real figures (61 files, ~250 statements), so
  // ordinary growth and ordinary deletion never trip them. Only a scan that
  // has stopped working can.
  const broken = [];
  if (list.length < 30) broken.push(`знайдено лише ${list.length} файлів`);
  if (total < 100) broken.push(`знайдено лише ${total} запитів`);
  if (broken.length) {
    console.log(`\n  ${RED}сканування нічого не знайшло — зламана сама перевірка${OFF}`
      + `\n  ${RED}${broken.join(' · ')}${OFF}`);
  }
  if (failures.length) console.log(`  ${RED}впали: ${failures.join(', ')}${OFF}`);
  console.log('');
  process.exitCode = (fail || broken.length) ? 1 : 0;
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => close());
