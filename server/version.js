'use strict';
// ── Which build is this? ────────────────────────────────────────────────────
// There are two servers for this game right now — the old one on Railway and
// this one — and a bug report is worth very little without knowing which was
// being played. "Монстры багнутые" against a build that fixed the monsters an
// hour earlier sends everyone hunting a ghost.
//
// So the commit is readable three ways: in /health, in the boot log, and in
// authOk, which means it reaches the browser console of whoever is testing.
// Read once, at load: the process does not change commits while running.

const { execSync } = require('child_process');

function readCommit() {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT;
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname + '/..', stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch { return 'unknown'; }
}

const COMMIT = readCommit();
const STARTED_AT = new Date().toISOString();

module.exports = { COMMIT, STARTED_AT };
