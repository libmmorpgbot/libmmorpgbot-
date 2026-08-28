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

# ── картинки й звук їдуть окремо, і тільки ті, яких там немає ──────────────
# images/ і audio/ виключені з sync.sh навмисно: 19 МБ на кожен тестовий
# прогін — це хвилини, а міняються вони раз на місяць. На дроплеті це СИМЛІНКИ
# на /srv/liberty/app, тобто спільне сховище, яке переживає деплой.
#
# Через це новий файл не доїжджав узагалі. images/airdrop.png лежав у git,
# показувався в інтерфейсі й віддавав 404 у проді — мовчки, бо ніщо не
# перевіряло, що ассет, на який посилається код, там є.
#
# Порівнюються ім'я та розмір: цього досить, щоб зловити «файла немає» і
# «файл замінили», і на два порядки дешевше за передачу всіх 19 МБ.
ASSETS=$(git -c core.quotepath=false ls-files images audio || true)
if [ -n "$ASSETS" ]; then
  LOCAL=$(echo "$ASSETS" | while IFS= read -r f; do
            [ -f "$f" ] && printf '%s %s\n' "$(wc -c <"$f" | tr -d ' ')" "$f"; done | sort)
  REMOTE=$("${SSH[@]}" "cd /srv/liberty/next && find -L images audio -type f -printf '%s %p\n' 2>/dev/null | sort" || true)
  MISSING=$(comm -23 <(echo "$LOCAL") <(echo "$REMOTE") | sed 's/^[0-9]* //')
  if [ -n "$MISSING" ]; then
    echo "  надсилаю $(echo "$MISSING" | wc -l | tr -d ' ') нових/змінених ассетів ..."
    # Перелік — через ФАЙЛ, а не через stdin. `tar -T -` читає список з того
    # самого потоку, у який далі йде архів до ssh, і на Git Bash це рветься:
    # 38 нових файлів поїхали, а на семи tar сказав «Cannot open: Invalid
    # cross-device link» і вийшов з помилкою. Щоразу на тих самих семи —
    # тобто це не блокування файлу й не антивірус, а спільний потік.
    #
    # trap, а не rm наприкінці: скрипт під `set -e`, і падіння tar інакше
    # лишало б список у /tmp назавжди.
    LIST=$(mktemp)
    trap 'rm -f "$LIST"' EXIT
    printf '%s\n' "$MISSING" > "$LIST"
    tar -czf - -T "$LIST" \
      | "${SSH[@]}" "tar -xzf - -C /srv/liberty/next"
  fi
fi

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
