#!/usr/bin/env node
'use strict';
// ── Can another player's text run as code in your browser? ──────────────────
//
//   node dev/xss-check.js
//
// The client builds most of its UI by assigning template literals to
// innerHTML. That is fine for the ninety percent of it that interpolates a
// translation string or an item name from the catalog — both come from the
// bundle, and a player cannot change either.
//
// It is not fine for the values another PLAYER controls. There are a handful,
// and every one is displayed to people other than its author:
//
//   username          Telegram's first_name, free text, no character rules
//   clan name         typed by the founder, and broadcast on capture
//   clan description  typed by the leader, 200 characters
//   chat text         seen by everyone on the server
//   private message   seen by the recipient
//   opponent          a username again, on the duel history card
//
// The server strips control characters and bounds the length, which stops a
// name from breaking the protocol. It does NOT make the name safe to paste
// into HTML, and it must not try to: escaping is a property of the PLACE a
// value is rendered, not of the value. The same string is correct in a text
// node, needs quote-escaping in an attribute, and can never be safe in a URL
// scheme position.
//
// So this checks the rendering side. It reads the source rather than running
// anything, so it works in CI with no browser and no database.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const FILES = fs.readdirSync(path.join(ROOT, 'js'))
  .filter(f => f.endsWith('.js') && !f.includes('.min.'))
  .map(f => `js/${f}`);

// Identifiers that carry another player's text. Matched as substrings of the
// interpolated EXPRESSION, so `m.username`, `data.fromName` and
// `_esc(c.description)` are all seen.
const UNTRUSTED = [
  'username', 'Username', 'fromName', 'byName', 'leftName', 'winnerName',
  'clanName', 'ClanName', 'description', 'opponent', 'senderName',
];
// `.text` alone is too broad — a tutorial step has one too — so the chat
// fields are named exactly.
const UNTRUSTED_EXACT = [
  'msg.text', 'm.text', 'message.text', 'chatMsg.text', 'last.text', 'pm.text',
];

const ESCAPERS = /\b(_esc|_escHtml|_escAttr|escapeHtml|encodeURIComponent)\b/;

// A translation lookup is bundle text: `t('clanNameLbl')` mentions "clanName"
// and is not a clan's name.
const TRANSLATION_ONLY = /\bt(Vars)?\s*\(\s*'[A-Za-z0-9_]+'/;

// Template literals that BUILD HTML, and the interpolations inside them.
//
// Restricting to literals whose static text contains a tag is what keeps this
// from crying wolf: `${m.username}` inside a prompt() message is a text
// context and needs no escaping, and a checker that flags it teaches the
// reader to skim past the ones that matter. A literal containing `<div` is
// being pasted into the DOM.
function htmlInterpolations(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`' || src[i - 1] === '\\') continue;
    let j = i + 1;
    let statics = '';
    const parts = [];
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') break;
      if (ch === '$' && src[j + 1] === '{') {
        let d = 0, k = j + 1;
        for (; k < src.length; k++) {
          if (src[k] === '{') d++;
          else if (src[k] === '}') { d--; if (!d) break; }
        }
        parts.push({ expr: src.slice(j + 2, k), at: j });
        j = k + 1;
        continue;
      }
      statics += ch;
      j++;
    }
    if (/<[a-zA-Z/]/.test(statics)) {
      for (const p of parts) out.push({ expr: p.expr, line: src.slice(0, p.at).split('\n').length });
    }
    i = j;
  }
  return out;
}

console.log('\nxss-check\n');

const findings = [];
let scanned = 0;
for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const { expr, line } of htmlInterpolations(src)) {
    scanned++;
    const hits = UNTRUSTED.filter(u => expr.includes(u))
      .concat(UNTRUSTED_EXACT.filter(u => expr.includes(u)));
    if (!hits.length) continue;
    if (ESCAPERS.test(expr)) continue;
    if (TRANSLATION_ONLY.test(expr)) continue;
    // A presence test, not a render: `${c.description ? '' : ' empty'}` picks
    // between two literals and never puts the value on screen.
    if (/^[^?]*\?[^'"]*'[^']*'[^'"]*:[^'"]*'[^']*'\s*$/.test(expr.trim())) continue;
    findings.push({ file: f, line, expr: expr.replace(/\s+/g, ' ').slice(0, 90), fields: hits });
  }
}

console.log(`  ── ${scanned} інтерполяцій усередині HTML-літералів, ${FILES.length} файлів ──`);
ok(findings.length === 0,
  'жоден текст, який пише інший гравець, не потрапляє в HTML без екранування',
  findings.length ? `\n${findings.map(x => `        ${x.file}:${x.line}  (${x.fields.join(',')})  ${x.expr}`).join('\n')}` : '');

// ── the helpers themselves ──────────────────────────────────────────────────
// An escaper that misses a character is worse than none, because everything
// downstream is written on the assumption that it did its job.
console.log('  ── самі екранувальники ──');
const bodyOf = (src, name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return '';
  const end = src.indexOf('\n}', i);
  return src.slice(i, end < 0 ? i : end);
};
const netSrc = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
const clanSrc = fs.readFileSync(path.join(ROOT, 'js/clans.js'), 'utf8');

// The base escaper is the only one that names characters. Everything else
// delegates to it, and that is checked separately below — asking a delegate
// whether it escapes `&` would fail it for doing the right thing.
{
  const body = bodyOf(netSrc, '_escHtml');
  ok(/&amp;/.test(body) && /&lt;/.test(body) && /&gt;/.test(body), '_escHtml екранує & < >');
  // Order matters: & has to go first or the escapes escape each other and
  // "&lt;" arrives on screen as literal text instead of a "<".
  const iAmp = body.indexOf('&amp;'), iLt = body.indexOf('&lt;');
  ok(iAmp >= 0 && iLt >= 0 && iAmp < iLt, '_escHtml екранує & ПЕРШИМ');
  ok(!/String\(s\)\.replace/.test(body) || /String\(/.test(body),
    '_escHtml приводить до рядка — number.replace кинув би виняток');
}

const attrBody = bodyOf(netSrc, '_escAttr');
ok(/&quot;/.test(attrBody) && /&#39;/.test(attrBody),
  '_escAttr екранує обидві лапки — без цього значення виходить за межі атрибута');
ok(/_escHtml/.test(attrBody), '_escAttr будується поверх _escHtml, а не дублює його');

// One escaper per job, not three near-copies. `_esc` in clans.js and
// `_escHtml` in network.js are the same four lines written twice, and the day
// one of them gains a rule the other will not.
ok(bodyOf(clanSrc, '_esc').includes('_escHtml'),
  '_esc у clans.js делегує в _escHtml, а не дублює його');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
