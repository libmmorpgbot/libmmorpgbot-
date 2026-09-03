#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  server-deploy.sh — выложить игру из репозитория. Живёт на сервере.
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash /srv/liberty/deploy.sh                 последний коммит ветки
#   bash /srv/liberty/deploy.sh --dry-run       проверить, не трогая игру
#   bash /srv/liberty/deploy.sh 4ec695a         откатиться на коммит
#
# Если в выкладке есть НЕнакатанные миграции, обычный запуск откажется: код,
# которому не хватает колонок, показывает игрокам «Ошибка сервера» вместо новой
# возможности. Тогда выкладка запускается с паролем doadmin, и миграции она
# накатывает сама — ТЕМ migrate.sh, который приехал в этой же выкладке, а не
# тем, что лежит на сервере с прошлого раза. Это важно: старый migrate.sh —
# ровно то, из-за чего отказ и случился.
#
#   HOST=private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com
#   read -rsp 'Пароль doadmin: ' P; echo
#   ENC=$(printf %s "$P" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g')
#   ADMIN_URL="postgresql://doadmin:$ENC@$HOST:25060/liberty?sslmode=require" \
#     bash /srv/liberty/deploy.sh
#   unset P ENC ADMIN_URL
#
# Пароль вводится, а не пишется в команду: `read -s` не показывает его на
# экране и не кладёт в ~/.bash_history, где строка подключения осталась бы
# навсегда. od/sed — это urlencode: сгенерированный пароль законно содержит
# @ / : # ?, и каждый из них иначе прочитался бы как часть самого URL.
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

# ── отчёт в телеграм ───────────────────────────────────────────────────────
# Выкладку можно запустить кнопкой из админки. Кнопка живёт в том же процессе,
# который выкладка перезапускает, — то есть сказать «готово» ей нечем: её к
# тому моменту уже нет. Поэтому о результате отчитывается сам скрипт.
#
# Кому писать — в /srv/liberty/.deploy-notify (id чата), его кладёт админка
# перед запуском. Нет файла — никому не пишем, это обычный запуск из консоли.
NOTIFY_FILE=/srv/liberty/.deploy-notify
say() {
  local chat token
  [ -f "$NOTIFY_FILE" ] || return 0
  chat=$(cat "$NOTIFY_FILE" 2>/dev/null | tr -dc '0-9-')
  [ -n "$chat" ] || return 0
  token=$(sed -n 's/^TG_BOT_TOKEN=//p' /srv/liberty/env | tail -1)
  [ -n "$token" ] || return 0
  curl -s --max-time 10 -o /dev/null     "https://api.telegram.org/bot$token/sendMessage"     --data-urlencode "chat_id=$chat"     --data-urlencode "parse_mode=HTML"     --data-urlencode "text=$1" || true
}

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

# ── миграции базы ──────────────────────────────────────────────────────────
# Выкладка возит код, а схему базы до сих пор двигали руками. Один раз этого не
# сделали — и «Письмо» ответило игроку «Ошибка сервера»: колонки
# mail_bonus_claimed в базе не было, запрос падал с 42703, и act() показывал
# общее сообщение, по которому причину не угадать. Код был выложен и исправен,
# не хватало одной команды, о которой никто не вспомнил.
#
# Поэтому migrate.sh запускается ЗДЕСЬ, и запускается ВСЕГДА, а не «если в этой
# выкладке есть новый файл». Он идемпотентен: применённое пропускает, печатая
# `ok`. Всегда — потому что «нового файла нет» значит только то, что нового
# файла нет в КОДЕ; применена ли уже прошлая миграция, знает база, и спрашивать
# надо её. Ровно этот случай сейчас и живой: 019 выложена, но не накатана, и
# проверка по файлам его бы не заметила.
#
# ДО подмены и перезапуска. Порядок тут не украшение:
#
#   не сработало  игра не тронута вовсе — она всё ещё на старом коде, который
#                 со старой схемой работает;
#   сработало     новый код поднимается на схеме, которая его уже ждёт, а не
#                 узнаёт о нехватке колонки от первого игрока.
#
# Отсюда правило, которое скрипт соблюсти не может, а человек обязан:
# МИГРАЦИЯ ОБЯЗАНА БЫТЬ ДОБАВЛЯЮЩЕЙ. Между migrate.sh и restart работает СТАРЫЙ
# код, и новая колонка ему не мешает — а переименованная ломает его сразу. В
# этом репозитории такое уже было: 016 переименовала rebirths в empowers. Такие
# правки катятся в два захода — сперва добавить, выложить, потом убрать
# лишнее, — и это решение автора миграции, а не скрипта.
MIGRATE=1
[ "$DRY" = 1 ] && MIGRATE=0
if [ "$MIGRATE" = 1 ] && [ -x "$T/server/db/migrate.sh" ]; then
  # Сначала то, что передали этому запуску, потом env. Порядок такой, потому
  # что пароль doadmin у нас намеренно нигде не лежит: разовая выкладка с
  # миграцией делается как `ADMIN_URL='...' bash deploy.sh`, и ничего на диске
  # после неё не остаётся.
  #
  # Значение из env бывает в кавычках (см. dev/env-quote.js) — снимаем.
  M_ADMIN="${ADMIN_URL:-$(sed -n 's/^ADMIN_URL=//p' /srv/liberty/env | tail -1 | sed 's/^["'"'"']//;s/["'"'"']$//')}"
  if [ -z "$M_ADMIN" ]; then
    # Молча выложить код, которому нужна схема, нельзя. Но и падать на каждой
    # выкладке, если миграций в ней нет, тоже незачем: сравниваем файлы нового
    # дерева с тем, что лежит в работающем, и решаем по этому.
    PENDING=$(cd "$T/server/db/migrations" 2>/dev/null && for f in *.sql; do
                [ -e "$NEXT/server/db/migrations/$f" ] || echo "$f"; done)
    if [ -n "$PENDING" ]; then
      # Файл «новый» относительно работающего дерева — но это ещё не значит,
      # что он не накатан: у нас миграции катаются руками (dev/migrate-now.sh),
      # и после этого файл всё равно новый. Спрашиваем БАЗУ, а не файлы.
      # Читать schema_migrations приложению разрешает не миграция, а сам
      # migrate.sh (GRANT SELECT в его хвосте): в миграции GRANT не держится —
      # `GRANT ... ON ALL TABLES` из того же хвоста перевыдаётся на каждом
      # прогоне и стирает его. Отсюда следствие, из-за которого это читается:
      # пока на сервере лежит migrate.sh БЕЗ этого GRANT, запрос ниже вернёт
      # пусто, и выкладка честно откажется. Круг разрывается запуском с
      # ADMIN_URL (см. шапку) — там миграции катаются напрямую, и спрашивать
      # базу от имени приложения не нужно вовсе.
      M_APP=$(sed -n 's/^DATABASE_URL=//p' /srv/liberty/env | tail -1 | sed 's/^["'"'"']//;s/["'"'"']$//')
      APPLIED=""
      if [ -n "$M_APP" ]; then
        APPLIED=$(PGCONNECT_TIMEOUT=10 psql "$M_APP" -tAc \
                    'SELECT version FROM schema_migrations' 2>/dev/null || true)
      fi
      MISSING=""
      for f in $PENDING; do
        grep -qxF "$f" <<<"$APPLIED" || MISSING="$MISSING $f"
      done
      if [ -n "$APPLIED" ] && [ -z "$MISSING" ]; then
        echo "  ✓ новые файлы миграций уже накатаны (спросил базу), выкладываюсь"
      else
        echo "  ✗ в выкладке есть НЕнакатанные миграции, а накатить нечем:" >&2
        printf '      %s\n' ${MISSING:-$PENDING} >&2
        echo "    Выложить код, которому не хватает колонок, значит показать" >&2
        echo "    игрокам «Ошибка сервера» вместо новой возможности." >&2
        echo "    Накатите их — bash dev/migrate-now.sh — и повторите," >&2
        echo "    либо запустите выкладку как ADMIN_URL='...' bash deploy.sh" >&2
        say "🚨 <b>Выкладка отменена</b>%0AЕсть ненакатанные миграции. Запустите dev/migrate-now.sh и повторите."
        rm -f "$NOTIFY_FILE"
        exit 1
      fi
    else
      echo "  ⚠ ADMIN_URL не задан — миграции не проверял (новых в этой выкладке нет)" >&2
    fi
  else
    echo "  накатываю миграции ..."
    if ! ADMIN_URL="$M_ADMIN" bash "$T/server/db/migrate.sh" >/tmp/deploy-migrate.log 2>&1; then
      echo "  ✗ миграция не прошла — выкладка отменена, игра не тронута" >&2
      tail -15 /tmp/deploy-migrate.log >&2
      say "🚨 <b>Выкладка отменена</b>%0AМиграция базы не прошла. Игра осталась на прежней сборке.%0A<code>$(tail -3 /tmp/deploy-migrate.log | tr -d '<>&' | tail -c 300)</code>"
      rm -f "$NOTIFY_FILE"
      exit 1
    fi
    APPLIED=$(grep -c '^  APPLY' /tmp/deploy-migrate.log || true)
    if [ "${APPLIED:-0}" -gt 0 ]; then
      echo "  ✓ применено миграций: $APPLIED"
      grep '^  APPLY' /tmp/deploy-migrate.log | sed 's/^/    /'
    else
      echo "  ✓ схема уже актуальна"
    fi
  fi
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
        *"$COMMIT"*)
          echo "  ✓ живёт $COMMIT"
          say "✅ <b>Выложено</b>
Сборка: <code>$COMMIT</code>
$(git -C "$REPO" log -1 --format=%s "$FULL" | cut -c1-80)"
          rm -f "$NOTIFY_FILE"
          exit 0 ;;
        *) echo "  ⚠ сервер жив, но собран не из $COMMIT" >&2 ;;
      esac ;;
  esac
done

echo "  ✗ сервер не ответил за 25с — откатываюсь" >&2
say "🚨 <b>Выкладка не удалась</b>
$COMMIT не поднялся за 25 секунд. Откатываюсь на предыдущую сборку —
игра останется на том, что работало. Смотри журнал: journalctl -u liberty-next"

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
rm -f "$NOTIFY_FILE"
exit 1
