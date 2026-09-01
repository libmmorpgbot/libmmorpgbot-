#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  status.sh — что живёт в игре, что лежит в GitHub, что у меня
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash dev/status.sh
#
# Один вопрос, на который до сих пор не было быстрого ответа: то ли сейчас
# крутится в игре, что лежит в репозитории? Полтора года ответ был «нет, и
# узнать негде» — живой код не выгружался вовсе.
#
# Ничего не меняет, ничего не выкладывает. Только смотрит.
set -uo pipefail

REMOTE="${LIBERTY_REMOTE:-libmmo}"
BRANCH="${LIBERTY_BRANCH:-postgres-migration}"
HEALTH="${LIBERTY_HEALTH:-https://libertymmorpg.online/health}"

# ── что живёт ──────────────────────────────────────────────────────────────
OUT=$(curl -s --max-time 8 "$HEALTH" || true)
LIVE=$(printf '%s' "$OUT" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')
SINCE=$(printf '%s' "$OUT" | sed -n 's/.*"since":"\([^"]*\)".*/\1/p')
case "$OUT" in
  *'"ok":true'*) STATE="отвечает" ;;
  '')            STATE="НЕ ОТВЕЧАЕТ" ;;
  *)             STATE="отвечает, но нездоров" ;;
esac

# ── что в GitHub ───────────────────────────────────────────────────────────
GH=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | cut -c1-7)
[ -n "$GH" ] || GH="недоступен"

# ── что у меня ─────────────────────────────────────────────────────────────
MINE=$(git rev-parse --short HEAD 2>/dev/null || echo '—')
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
AHEAD=$(git rev-list --count "$REMOTE/$BRANCH..HEAD" 2>/dev/null || echo '?')

echo
printf '  в игре    %-10s %s%s\n' "${LIVE:-—}" "$STATE" \
       "${SINCE:+, с $SINCE}"
printf '  в GitHub  %-10s ветка %s\n' "$GH" "$BRANCH"
printf '  у меня    %-10s %s\n' "$MINE" \
       "$([ "$DIRTY" = 0 ] && echo 'рабочая копия чистая' || echo "$DIRTY незакоммиченных файлов")"
echo

# ── и вывод одной строкой ──────────────────────────────────────────────────
if [ "$LIVE" = "$GH" ] && [ "$GH" = "$MINE" ] && [ "$DIRTY" = 0 ]; then
  echo "  ✓ игра, GitHub и рабочая копия — одно и то же"
elif [ -n "$LIVE" ] && [ "$LIVE" = "$GH" ]; then
  echo "  ✓ в игре ровно то, что в GitHub"
  [ "$AHEAD" != "0" ] && [ "$AHEAD" != "?" ] &&
    echo "  · у вас $AHEAD невыгруженных коммитов — их в игре нет"
elif [ -n "$LIVE" ] && [ -n "$GH" ] && [ "$GH" != "недоступен" ]; then
  echo "  ⚠ в игре $LIVE, а в GitHub $GH — расходятся."
  BEH=$(git rev-list --count "$LIVE..$REMOTE/$BRANCH" 2>/dev/null || echo '')
  [ -n "$BEH" ] && [ "$BEH" != "0" ] &&
    echo "    В GitHub на $BEH коммитов больше. Выложить: bash dev/deploy.sh"
fi
echo
