#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  all-checks.sh — прогнать ВЕСЬ набор проверок и не дать ни одной промолчать
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash /srv/liberty/pgtest/dev/all-checks.sh
#
# ── зачем этот файл появился ───────────────────────────────────────────────
# Проверок в dev/ полсотни, и запускались они поштучно, по памяти. За день
# нашлось ПЯТЬ, которые не работали вовсе:
#
#   fanout-check       просил карту по адресу, которого нет; падал на разборе
#                      HTML страницы 404 — и так с того дня, как поменяли
#                      маршрут;
#   netprobe           то же самое;
#   snapshot-check     координаты бегуна давно в стене, сервер отклонял каждый
#                      ход, и проверка печатала «repeatedPct: 100» — то есть
#                      обвиняла сервер в собственной поломке;
#   remote-motion      запускала сборку Chromium, которой нет ни на одной
#                      машине, и ждала аккаунт от dev/seed.js, который удалили;
#   (и она же)         вторая причина внутри той же проверки.
#
# Общее у всех одно: они падали ДО первой проверки, поэтому не печатали ни
# «пройшло», ни «впало». Молчание читалось как «не запускал», а не как
# «сломано», и никто не отличал одно от другого.
#
# Поэтому здесь главное правило: проверка, которая не напечатала подсказку,
# считается УПАВШЕЙ. Не «пропущенной», не «неизвестной» — упавшей. Иначе
# сломанная проверка снова тихо превратится в незапущенную.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

# ── три группы, потому что у них разные требования ─────────────────────────
#   PURE    ничего не нужно, кроме node
#   DB      нужен DATABASE_URL (внутри VPC — значит только с дроплета)
#   SERVER  нужен ЖИВОЙ сервер: поднимается здесь же, на свободном порту
#
# render-check и remote-motion в этот список не входят: им нужен браузер, а на
# дроплете его нет. Они запускаются с машины разработчика — см. хвост вывода.
PURE=(reachable bundle protocol request-shape bookpool prodfix heal)
DB=(admin adminapi aggro alert api bonuses boot clans consumables craft drops
    enemysync enhance etl events exploit gram guildwar health item-ledger items
    kill market market-fix modes money panel party players progression pvp-history quest relog-attack stacks party-clan-log season-enhance
    referral reply-shape skills sql stats tgadmin xss)
SERVER=(play walk stream fanout snapshot)

PORT="${ALLCHECK_PORT:-3178}"
TIMEOUT="${ALLCHECK_TIMEOUT:-400}"

pass=0; fail=0; failed=()

run_one() {
  local name="$1"; shift
  local out rc summary
  out=$(timeout "$TIMEOUT" node "dev/${name}-check.js" 2>&1); rc=$?
  # ANSI-раскраска снимается ДО поиска подсказки. Часть проверок печатает её
  # цветной, и коды разрывают строку ровно посередине: «124 збігається» на
  # экране — это «[32m124 збігається[0m» в тексте, и поиск по нему
  # не находит ничего. Первый заход из-за этого объявил рабочую проверку
  # сломанной.
  local clean_out
  clean_out=$(printf '%s' "$out" | sed 's/\[[0-9;]*m//g')
  # Подсказка ищется в обоих написаниях: часть файлов на украинском, часть на
  # русском, и часть печатает JSON с "ok": true вместо счётчика.
  summary=$(echo "$clean_out" | grep -oE '[0-9]+ (пройшло|прошло), [0-9]+ (впало|упало|УПАЛО)' | tail -1)
  if [ -z "$summary" ]; then
    summary=$(echo "$clean_out" | grep -oE '"ok": (true|false)' | tail -1)
  fi
  if [ -z "$summary" ]; then
    summary=$(echo "$clean_out" | grep -oE '[0-9]+ clean · [0-9]+ missing fields' | tail -1)
  fi
  if [ -z "$summary" ]; then
    summary=$(echo "$clean_out" | grep -oE '[0-9]+ запитів перевірено базою' | tail -1)
  fi
  if [ -z "$summary" ]; then
    summary=$(echo "$clean_out" | grep -oE '[0-9]+ збігається · [0-9]+ без поля' | tail -1)
  fi
  # snapshot-check печатает JSON без поля "ok": здоровье потока читается по
  # доле повторов и по тому, что сервер не отклонил ни одного хода.
  if [ -z "$summary" ]; then
    summary=$(echo "$clean_out" | grep -oE '"positionsRefused": [0-9]+' | tail -1)
  fi

  # Ни подсказки, ни нулевого кода возврата — значит проверка не дошла до
  # своих проверок. Печатаем ХВОСТ вывода: без него следующий человек будет
  # гадать так же, как гадали мы.
  if [ -z "$summary" ]; then
    printf '  \033[31mСЛОМАНА\033[0m  %-16s (код %s, подсказки нет)\n' "$name" "$rc"
    echo "$out" | tail -4 | sed 's/^/              /'
    fail=$((fail + 1)); failed+=("$name(сломана)")
    return
  fi
  if echo "$summary" | grep -qE ', 0 (впало|упало|УПАЛО)|"ok": true|0 missing fields|запитів перевірено базою|0 без поля|"positionsRefused": 0'; then
    printf '  \033[32mок\033[0m       %-16s %s\n' "$name" "$summary"
    pass=$((pass + 1))
  else
    printf '  \033[31mУПАЛА\033[0m    %-16s %s\n' "$name" "$summary"
    fail=$((fail + 1)); failed+=("$name")
  fi
}

echo
echo "  ── без базы и сервера ──"
for n in "${PURE[@]}"; do run_one "$n"; done

if [ -z "${DATABASE_URL:-}" ]; then
  echo
  echo "  DATABASE_URL не задан — группа с базой пропущена."
  echo "  На дроплете:  set -a; . /srv/liberty/env; set +a"
  echo "  (эта строка — НЕ успех: проверки просто не запускались)"
else
  echo
  echo "  ── с базой ──"
  for n in "${DB[@]}"; do run_one "$n"; done

  echo
  echo "  ── с живым сервером (порт $PORT) ──"
  # MOVE_GUARD=off: часть проверок расставляет ботов прыжками, которые бюджет
  # движения обязан отклонять. Они про зону видимости и про поток снимков, а
  # не про бюджет — у него свой сценарий в play-check.
  # DEV_LOCAL=1 монтирует /dev/init-data, без которого боты не войдут. Порт
  # закрыт ufw, наружу его не видно.
  ( set -a; NODE_ENV=test PORT="$PORT" OPS_LIVE=0 DEV_LOCAL=1 MOVE_GUARD=off; set +a
    nohup node server/app.js > /tmp/all-checks-srv.log 2>&1 & )
  for i in $(seq 1 30); do
    sleep 1
    curl -s --max-time 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true' && break
  done
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
    export URL="http://127.0.0.1:$PORT"
    for n in "${SERVER[@]}"; do run_one "$n"; done
  else
    echo "  \033[31mСЛОМАНА\033[0m  сервер не поднялся — см. /tmp/all-checks-srv.log"
    fail=$((fail + 1)); failed+=("тестовый сервер")
  fi
  fuser -k "$PORT/tcp" 2>/dev/null || true
fi

echo
echo "  ── с машины разработчика (нужен браузер) ──"
echo "     node dev/render-check.js --run"
echo "     URL=http://127.0.0.1:$PORT node dev/remote-motion-check.js   (через ssh-туннель)"
echo
if [ "$fail" -eq 0 ]; then
  printf '  \033[32m%d прошло, 0 упало\033[0m\n\n' "$pass"
else
  printf '  \033[31m%d прошло, %d упало\033[0m: %s\n\n' "$pass" "$fail" "${failed[*]}"
fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
