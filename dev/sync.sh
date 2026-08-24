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
  # The env file is the PRODUCTION one — it is where the database URL and the
  # pinned CA live, and there is deliberately no second copy to drift from it.
  # But it also says NODE_ENV=production and OPS_LIVE=1, and a test inheriting
  # those talks to the real operators' bot: every run announced itself in the
  # channel and started a second getUpdates poll, which takes the withdrawal
  # buttons away from the live server for as long as it lasts.
  #
  # So the two variables that decide "may this process reach outside itself"
  # are overridden after sourcing. Loading production config and then declaring
  # this is not production is the honest shape of it: the test needs the same
  # database, and must not have the same reach.
  ssh -i "$KEY" -o BatchMode=yes "$HOST" \
    "cd $DEST && set -a && . /srv/liberty/env && set +a \
     && export NODE_ENV=test OPS_LIVE=0 \
     && $CMD"
fi
