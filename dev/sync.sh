#!/usr/bin/env bash
# Push the working copy to the droplet's test directory and run something there.
#
#   dev/sync.sh                       just sync
#   dev/sync.sh node dev/craft-check.js
#
# The database is inside DigitalOcean's VPC and reachable only from the droplet,
# so every check runs there. Before this script that meant copying files over
# the old checkout in /srv/liberty/app, which left the running server's own
# directory holding a half-applied version of code that was not deployed — a
# state nobody could describe. /srv/liberty/pgtest only ever holds what git has.
#
# tar over ssh rather than rsync: the developer machine is Windows, and Git Bash
# ships tar but not rsync. `git ls-files` picks the payload, so a file that is
# not committed (or at least not staged) is not tested — which matters more here
# than speed does.
set -euo pipefail
HOST="${LIBERTY_HOST:-root@178.128.136.68}"
KEY="${LIBERTY_KEY:-$HOME/.ssh/liberty_do}"
DEST=/srv/liberty/pgtest

FILES=$(git ls-files --cached --others --exclude-standard \
        | grep -vE '^(images/|audio/|node_modules/|android/)' || true)
[ -n "$FILES" ] || { echo "sync: nothing to send" >&2; exit 1; }

echo "$FILES" | tar -czf - -T - \
  | ssh -i "$KEY" -o BatchMode=yes "$HOST" "mkdir -p $DEST && tar -xzf - -C $DEST"

if [ $# -gt 0 ]; then
  # printf %q, not "$*": the arguments carry parentheses, quotes and $ signs,
  # and pasting them raw into a remote shell string gets them reparsed there.
  CMD=$(printf '%q ' "$@")
  ssh -i "$KEY" -o BatchMode=yes "$HOST" \
    "cd $DEST && set -a && . /srv/liberty/env && set +a && $CMD"
fi
