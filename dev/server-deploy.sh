#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  server-deploy.sh — выложить игру из репозитория. Живёт на сервере.
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash /srv/liberty/deploy.sh                 последний коммит ветки
#   bash /srv/liberty/deploy.sh --dry-run       проверить, не трогая игру
#   bash /srv/liberty/deploy.sh 4ec695a         откатиться на коммит
#
# Канонический экземпляр — в репозитории (dev/server-deploy.sh). На сервер его
# кладёт dev/deploy.sh при каждой выкладке: скрипт, который живёт только на
# сервере, — ровно та беда, от которой мы уходим.
#
# ── зачем ──────────────────────────────────────────────────────────────────
# Раньше выложить игру можно было с одного-единственного компьютера, и живой
# код существовал только на нём и на дроплете. Теперь источник один: выложить
# можно ТОЛЬКО то, что есть в репозитории. Поправить файл прямо на сервере
# по-прежнему технически возможно, но при следующей выкладке правка исчезнет —
# и это правильно, иначе живой код опять начнёт расходиться с репозиторием.
set -euo pipefail

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi

REPO=/srv/liberty/repo.git
BRANCH="${LIBERTY_BRANCH:-postgres-migration}"
NEXT=/srv/liberty/next
[ "$DRY" = 1 ] && NEXT=/srv/liberty/next.test
SHARED=/srv/liberty/app
HEALTH="${LIBERTY_HEALTH:-https://libertymmorpg.online/health}"

cd "$REPO"

# ── недоступный GitHub значит разное в двух случаях ────────────────────────
# Просят «последнее» — молчать нельзя: без обновления «последнее» это то, что
# успели забрать в прошлый раз, и выкладка тихо вернула бы игру назад во
# времени. Просят конкретный коммит — он уже здесь, и падать из-за сети
# незачем: откат нужен как раз тогда, когда всё плохо.
FETCHED=1
echo "  забираю с GitHub ..."
if ! git fetch --prune --quiet origin 2>/tmp/deploy-fetch.log; then
  FETCHED=0
  if [ $# -eq 0 ]; then
    echo "  ✗ GitHub недоступен, а просят последний коммит ветки." >&2
    echo "    Без обновления «последний» — это устаревшая копия, и выкладка" >&2
    echo "    откатила бы игру назад молча. Назовите коммит явно для отката." >&2
    sed 's/^/    /' /tmp/deploy-fetch.log >&2
    exit 1
  fi
  echo "  ⚠ GitHub недоступен — беру $1 из того, что уже лежит здесь" >&2
fi

TARGET="${1:-origin/$BRANCH}"
git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null || {
  echo "  ✗ не знаю такого коммита: $TARGET" >&2; exit 1; }
FULL=$(git rev-parse "$TARGET^{commit}")
COMMIT=$(git rev-parse --short "$FULL")

# ── коммит обязан быть на GitHub ───────────────────────────────────────────
# Весь смысл в том, что живой код и репозиторий — одно и то же. Коммит, которого
# на GitHub нет, ломает это молча.
if [ "$FETCHED" = 1 ]; then
  if ! git branch -r --contains "$FULL" 2>/dev/null | grep -q .; then
    echo "  ✗ $COMMIT нет ни в одной ветке на GitHub — выкладывать нечего" >&2
    exit 1
  fi
else
  echo "  ⚠ проверить, что $COMMIT есть на GitHub, сейчас нечем" >&2
fi
echo "  выкладываю $COMMIT — $(git log -1 --format=%s "$FULL" | cut -c1-58)"

# ── дерево собирается в стороне ────────────────────────────────────────────
# Не в next: пока проверки не прошли, работающую игру трогать незачем.
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# mktemp создаёт каталог с правами drwx------, и `cp -a "$T/." "$NEXT/"`
# переносит их НА САМ $NEXT. Служба работает от пользователя liberty, войти в
# каталог 0700 root:root он не может — systemd отвечает «Changing to the
# requested working directory failed: Permission denied», сервер не стартует
# вовсе, проверка здоровья не дожидается ответа, и всё откатывается. Выглядит
# как «новый код не работает», хотя его никто даже не запускал.
chmod 755 "$T"
git archive "$FULL" | tar -xf - -C "$T"

# ── проверка, которая ловит худшее ─────────────────────────────────────────
# Клиент склеивается из 25 файлов в ОДНУ область видимости. Повторно
# объявленный const — это SyntaxError и чёрный экран у всех до единого.
# Стоит секунду, ловит единственную поломку, при которой игра не работает вовсе.
if [ -f "$T/dev/bundle-check.js" ]; then
  ln -sfn "$SHARED/node_modules" "$T/node_modules"
  if ! (cd "$T" && node dev/bundle-check.js >/tmp/deploy-bundle.log 2>&1); then
    echo "  ✗ клиент не собирается — выкладка отменена, игра не тронута" >&2
    tail -12 /tmp/deploy-bundle.log >&2
    exit 1
  fi
  echo "  ✓ клиент собирается"
  rm -f "$T/node_modules"
fi

# ── картинки и звук живут в общем хранилище ────────────────────────────────
# next/images и next/audio — СИМЛИНКИ на /srv/liberty/app: они переживают
# выкладку. Поэтому файлы кладутся в хранилище, а в next восстанавливается
# ссылка. Копировать их внутрь next значило бы 19 МБ на каждую выкладку и два
# расходящихся набора картинок.
for d in images audio; do
  [ -d "$T/$d" ] || continue
  if [ "$DRY" = 1 ]; then
    NEW=$(cd "$T/$d" && find . -type f | while IFS= read -r f; do
            [ -e "$SHARED/$d/$f" ] || echo "$f"; done | wc -l)
    echo "  $d: новых файлов $NEW"
  else
    mkdir -p "$SHARED/$d"
    cp -a "$T/$d/." "$SHARED/$d/"
  fi
  rm -rf "$T/$d"
done
rm -rf "$T/android"

# ── подмена ────────────────────────────────────────────────────────────────
# node_modules в next — симлинк на общее хранилище пакетов. Его не трогает ни
# удаление, ни копирование: однажды скопированный сам поверх себя, он стал
# указывать на себя же, и служба ушла в цикл перезапусков с «Cannot find
# module 'express'».
echo "  подменяю ..."
if [ "$DRY" = 1 ]; then
  rm -rf "$NEXT"; mkdir -p "$NEXT"
  ln -sfn "$SHARED/node_modules" "$NEXT/node_modules"
else
  rm -rf /srv/liberty/next.old
  cp -a "$NEXT" /srv/liberty/next.old
fi
find "$NEXT" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
cp -a "$T/." "$NEXT/"
ln -sfn "$SHARED/images" "$NEXT/images"
ln -sfn "$SHARED/audio"  "$NEXT/audio"

# Права на сам каталог — отдельной строкой, а не в надежде на cp. И проверить
# тем пользователем, от которого работает служба: дешевле, чем узнать это из
# неудавшегося перезапуска.
chmod 755 "$NEXT"
SVC_USER=$(systemctl show liberty-next -p User --value 2>/dev/null || echo liberty)
if [ -n "$SVC_USER" ] && ! sudo -u "$SVC_USER" test -x "$NEXT"; then
  echo "  ОТКАЗ: $SVC_USER не может войти в $NEXT — служба не поднимется" >&2
  stat -c '    %A %U:%G %n' "$NEXT" >&2
  exit 1
fi

if [ "$DRY" = 1 ]; then
  echo "  ── холостой прогон: игру не трогал ──"
  for l in node_modules images audio; do
    printf '  %-13s -> %s\n' "$l" "$(readlink "$NEXT/$l" || echo 'НЕ ССЫЛКА')"
  done
  echo "  файлов разложено: $(find "$NEXT" -type f -not -path '*/node_modules/*' | wc -l)"
  rm -rf "$NEXT"
  echo "  ✓ $COMMIT выкладывается — можно катить без --dry-run"
  exit 0
fi

PREV_COMMIT=$(sed -n 's/^BUILD_COMMIT=//p' /srv/liberty/env | tail -1)
sed -i '/^BUILD_COMMIT=/d' /srv/liberty/env
echo "BUILD_COMMIT=$COMMIT" >> /srv/liberty/env
systemctl restart liberty-next

# ── и убедиться, что игра ответила ─────────────────────────────────────────
# Выкладка не считается удачной, пока сервер не сказал «жив» и не назвал ТОТ
# САМЫЙ коммит. Иначе можно радоваться выкладке, которой не было.
echo "  жду ответа ..."
for _ in $(seq 1 25); do
  sleep 1
  OUT=$(curl -s --max-time 3 "$HEALTH" || true)
  case "$OUT" in
    *'"ok":true'*)
      case "$OUT" in
        *"$COMMIT"*) echo "  ✓ живёт $COMMIT"; exit 0 ;;
        *) echo "  ⚠ сервер жив, но собран не из $COMMIT" >&2 ;;
      esac ;;
  esac
done

echo "  ✗ сервер не ответил за 25с — откатываюсь" >&2
rm -rf "$NEXT"
cp -a /srv/liberty/next.old "$NEXT"
chmod 755 "$NEXT"
# И BUILD_COMMIT — тоже назад. Без этого откат возвращает файлы, но оставляет
# в env новый номер: игроки на старом коде, а /health называет новый. Ровно так
# и вышло в первый раз, и по /health выкладка выглядела удавшейся.
sed -i '/^BUILD_COMMIT=/d' /srv/liberty/env
[ -n "$PREV_COMMIT" ] && echo "BUILD_COMMIT=$PREV_COMMIT" >> /srv/liberty/env
systemctl restart liberty-next
sleep 6
curl -s --max-time 5 "$HEALTH" >&2 || true
exit 1
