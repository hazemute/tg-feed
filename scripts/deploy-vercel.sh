#!/usr/bin/env bash
# TG-Feed · деплой на Vercel через REST API + CLI.
# Запускать ПОСЛЕ scripts/deploy-supabase.sh (нужны DATABASE_URL/DIRECT_URL).
#
# Переменные окружения:
#   VERCEL_TOKEN           — токен (https://vercel.com/account/tokens)
#   ВЛЕВО от secrets-файла: DATABASE_URL / DIRECT_URL (пишет deploy-supabase.sh)
#
# Генерирует и сохраняет AUTH_SECRET / CRON_SECRET / ADMIN_KEY в local-deploy-secrets.env.
# Результат: прод-URL проекта + проверка /api/health.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$ROOT/local-deploy-secrets.env"
TOKEN="${VERCEL_TOKEN:?VERCEL_TOKEN не задан}"
NAME="tg-feed"
API="https://api.vercel.com"

[ -f "$SECRETS" ] && . "$SECRETS"
: "${DATABASE_URL:?DATABASE_URL не найден — сначала запустите scripts/deploy-supabase.sh}"
: "${DIRECT_URL:?DIRECT_URL не найден — сначала запустите scripts/deploy-supabase.sh}"

AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -hex 32)}"
CRON_SECRET="${CRON_SECRET:-$(openssl rand -hex 24)}"
ADMIN_KEY="${ADMIN_KEY:-tgfeed_$(openssl rand -hex 8)}"

api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

# 0. токен
ME="$(api "$API/v2/user")"
echo "$ME" | jq -e '.user.username' >/dev/null || { echo "✗ токен Vercel отклонён"; exit 1; }
echo "✓ токен действителен (аккаунт: $(echo "$ME" | jq -r '.user.username'))"

# 1. проект (409 = уже есть)
CREATED="$(api -X POST "$API/v9/projects" -d "{\"name\":\"$NAME\",\"framework\":\"nextjs\"}")"
PID="$(echo "$CREATED" | jq -r '.id // empty')"
if [ -n "$PID" ]; then
  echo "✓ проект создан: $NAME"
else
  PID="$(api "$API/v9/projects/$NAME" | jq -r '.id')"
  [ -n "$PID" ] && [ "$PID" != "null" ] || { echo "✗ не удалось получить проект"; exit 1; }
  echo "✓ проект $NAME уже существует"
fi

# 2. настройки: build command (prisma generate) + регион функций fra1 (рядом с БД)
SET="$(api -X PATCH "$API/v9/projects/$PID" \
  -d '{"buildCommand":"prisma generate && next build","serverlessFunctionRegion":"fra1","installCommand":null,"devCommand":null}')"
echo "$SET" | jq -e '.buildCommand' >/dev/null && echo "✓ build: prisma generate && next build · регион функций: fra1" \
  || echo "⚠ настройки применены частично (регион fra1 может быть недоступен на текущем тарифе — продолжаем)"

# 3. env-переменные (upsert, production+preview)
set_env() {
  local key="$1" value="$2"
  local body targets
  targets='["production","preview"]'
  body="$(jq -n --arg k "$key" --arg v "$value" --argjson t "$targets" '[{key:$k,value:$v,type:"encrypted",target:$t}]')"
  local out
  out="$(api -X POST "$API/v9/projects/$PID/env" -d "$body")"
  if echo "$out" | jq -e '.error.code == "ENV_ALREADY_EXISTS"' >/dev/null 2>&1; then
    api -X PUT "$API/v9/projects/$PID/env/$key?upsert=true" \
      -d "$(jq -n --arg v "$value" '{value:$v,type:"encrypted",target:["production","preview"]}')" >/dev/null
  elif echo "$out" | jq -e '.error' >/dev/null 2>&1; then
    echo "✗ env $key: $(echo "$out" | jq -r '.error.message')"; exit 1
  fi
  echo "✓ env: $key"
}
set_env DATABASE_URL "$DATABASE_URL"
set_env DIRECT_URL   "$DIRECT_URL"
set_env AUTH_SECRET  "$AUTH_SECRET"
set_env CRON_SECRET  "$CRON_SECRET"
set_env ADMIN_KEY    "$ADMIN_KEY"

# 4. сохранить/обновить secrets-файл
# ВАЖНО: сначала во временный файл — редирект `> "$SECRETS"` обрезал бы его
# ДО того, как grep успеет прочитать прежнее содержимое.
# Значения пишем В КАВЫЧКАХ: URL содержат `&`, который без кавычек рвёт source.
TMP_SECRETS="$(mktemp)"
{
  grep -vE '^(AUTH_SECRET|CRON_SECRET|ADMIN_KEY)=' "$SECRETS" 2>/dev/null || true
  echo "AUTH_SECRET=\"$AUTH_SECRET\""
  echo "CRON_SECRET=\"$CRON_SECRET\""
  echo "ADMIN_KEY=\"$ADMIN_KEY\""
} > "$TMP_SECRETS"
mv "$TMP_SECRETS" "$SECRETS"
chmod 600 "$SECRETS"

# 5. деплой прод-версии (CLI из корня репо)
cd "$ROOT"
bunx vercel link --yes --project "$NAME" --token "$TOKEN" >/dev/null 2>&1
echo "⏳ деплой (несколько минут: prisma generate + next build)…"
DEPLOY_URL="$(bunx vercel deploy --prod --yes --token "$TOKEN" 2>/dev/null | tail -1)"
[ -n "$DEPLOY_URL" ] || { echo "✗ деплой не вернул URL"; exit 1; }
echo "✓ деплой: $DEPLOY_URL"

# 6. health-check (до 60с)
echo -n "⏳ health-check"
for i in $(seq 1 12); do
  H="$(curl -sS --max-time 8 "$DEPLOY_URL/api/health" 2>/dev/null || true)"
  if echo "$H" | jq -e '.ok == true' >/dev/null 2>&1; then
    echo ""; echo "✓ health: $H"
    echo ""
    echo "=== ДЕПЛОЙ ЗАВЕРШЁН ==="
    echo "URL: $DEPLOY_URL"
    echo "ADMIN_KEY (вход в /admin): $ADMIN_KEY"
    exit 0
  fi
  echo -n "."; sleep 5
done
echo ""
echo "⚠ health не ответил за 60с — проверьте логи: https://vercel.com/$NAME/_logs"
exit 1
