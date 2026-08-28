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
    # ── чому не розпаковуємо просто в next ──────────────────────────────────
    # Перший каталог із новим підкаталогом (images/hud/) не поїхав узагалі:
    #
    #   tar: images/hud/A1_stat_panel.webp: Cannot open: Invalid cross-device link
    #
    # Повідомлення виглядає локальним, а приходить з ДРОПЛЕТА — локальний
    # stderr при цьому порожній. next/images — симлінк на /srv/liberty/app,
    # і GNU tar 1.35 відмовляється створювати файл, шлях до якого йде крізь
    # символьне посилання, повертаючи саме EXDEV. Обидва боки на одній
    # файловій системі; «cross-device» тут ні до чого.
    #
    # Тому розпаковка йде у ТИМЧАСОВИЙ каталог, а на місце кладе cp -a: він
    # симлінк проходить спокійно і кладе файли в спільне сховище, куди воно
    # й має лягти. Жорстко прописувати /srv/liberty/app не став — тоді
    # розкладка сховища була б записана у двох місцях.
    LIST=$(mktemp)
    trap 'rm -f "$LIST"' EXIT
    printf '%s\n' "$MISSING" > "$LIST"
    tar -czf - -T "$LIST" \
      | "${SSH[@]}" 'set -e; T=$(mktemp -d); trap "rm -rf $T" EXIT
                     tar -xzf - -C "$T"
                     # По ВМІСТУ кожного каталогу, а не каталогом цілком:
                     # `cp -a "$T"/. next/` бачить next/images як звичайний
                     # файл і відмовляється «overwrite non-directory with
                     # directory». Зі скісною рискою в кінці призначення cp
                     # проходить симлінк і кладе файли у сховище за ним.
                     for d in "$T"/*/; do
                       n=$(basename "$d")
                       mkdir -p "/srv/liberty/next/$n"
                       cp -a "$d". "/srv/liberty/next/$n/"
                     done'
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
