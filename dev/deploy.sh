#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  deploy.sh — put the working copy on the droplet and restart the service
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash dev/deploy.sh
#
# Written down because typing it by hand went wrong once, and the way it went
# wrong is worth stating: node_modules in /srv/liberty/next is a SYMLINK to
# /srv/liberty/app/node_modules, where the packages actually live. The copy
# step excluded it from the delete but not from the copy, so a symlink that had
# been created in the source directory was copied over the destination's — and
# pointed at itself. `Cannot find module 'express'`, and the service in a
# restart loop until the link was rebuilt.
#
# So: the destination's node_modules is never touched, in either direction, and
# the deploy checks the service answered before calling itself done.
set -euo pipefail

HOST="${LIBERTY_HOST:-root@178.128.136.68}"
KEY="${LIBERTY_KEY:-$HOME/.ssh/liberty_do}"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")

COMMIT=$(git rev-parse --short HEAD)
DIRTY=$(git status --porcelain | wc -l)
if [ "$DIRTY" -ne 0 ]; then
  echo "  ⚠  $DIRTY незакомічених файлів — деплоїться те, що в робочій копії," >&2
  echo "     а BUILD_COMMIT скаже $COMMIT. Закоміть спершу." >&2
  exit 1
fi

echo "  синхронізую $COMMIT ..."
bash "$(dirname "${BASH_SOURCE[0]}")/sync.sh" >/dev/null

echo "  викочую ..."
"${SSH[@]}" bash -s <<REMOTE
set -euo pipefail
cd /srv/liberty
rm -rf next.old
cp -a next next.old

# Everything except node_modules goes; node_modules stays exactly as it is.
find next -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
# ...and is excluded from the copy as well. This is the line that was missing.
(cd pgtest && tar -cf - --exclude=node_modules .) | (cd next && tar -xf -)

sed -i '/^BUILD_COMMIT=/d' env
echo BUILD_COMMIT=$COMMIT >> env
systemctl restart liberty-next
REMOTE

echo "  чекаю на відповідь ..."
for i in $(seq 1 20); do
  sleep 1
  OUT=$(curl -s --max-time 3 https://libertymmorpg.online/health || true)
  case "$OUT" in
    *'"ok":true'*)
      echo "  ✓ $OUT"
      case "$OUT" in
        *"$COMMIT"*) exit 0 ;;
        *) echo "  ⚠  збірка на сервері не $COMMIT" >&2; exit 1 ;;
      esac
      ;;
  esac
done

echo "  ✗ сервер не відповів за 20с — відкочуюсь" >&2
"${SSH[@]}" 'cd /srv/liberty && rm -rf next && cp -a next.old next && systemctl restart liberty-next'
sleep 6
curl -s https://libertymmorpg.online/health >&2
exit 1
