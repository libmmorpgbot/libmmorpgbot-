#!/usr/bin/env node
'use strict';
// ── Quotes env values that a shell would mangle ─────────────────────────────
//
//   node dev/env-quote.js /srv/liberty/env
//
// Found by a test that should have passed and did not: the scrypt hash is
// `scrypt$16384$8$1$<salt>$<hash>`, and sourcing the env file in a shell
// (`. /srv/liberty/env`) expands $16384, $8, $1 and the rest as variables that
// do not exist. A 127-character hash became 10 characters — `scrypt6384` — and
// the only symptom was a correct password being refused.
//
// systemd's EnvironmentFile does NOT expand, so production would have been
// fine; the trap is for every human who sources the file to run a script by
// hand. Single quotes fix both readers: the shell stops expanding, and systemd
// strips surrounding quotes itself.
//
// Idempotent — a value already quoted is left alone.

const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('Використання: node dev/env-quote.js <файл>'); process.exit(1); }

const lines = fs.readFileSync(file, 'utf8').split('\n');
const changed = [];

const out = lines.map((ln) => {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(ln);
  if (!m) return ln;
  const [, key, value] = m;
  if (value.startsWith("'") || value.startsWith('"')) return ln;   // already quoted
  // A dollar sign is the dangerous one; a space breaks a different way (the
  // shell splits it), and both are fixed by the same quoting.
  if (!/[$ ]/.test(value)) return ln;
  changed.push(key);
  // A single quote inside the value would end the quoting early. None of these
  // values can contain one today, but refusing loudly beats writing a file
  // that parses as something else.
  if (value.includes("'")) {
    console.error(`ПРОПУЩЕНО ${key}: значення містить одинарну лапку, візьміть у лапки вручну`);
    return ln;
  }
  return `${key}='${value}'`;
});

fs.writeFileSync(file, out.join('\n'), { encoding: 'utf8' });
console.log(changed.length ? `взято в лапки: ${changed.join(', ')}` : 'нічого квотувати не довелось');
