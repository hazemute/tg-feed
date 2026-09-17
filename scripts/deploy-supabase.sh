#!/usr/bin/env bash
# TG-Feed · подготовка Supabase-базы через Management API.
# Идемпотентен: повторный запуск безопасен (проект не пересоздаётся, SQL идемпотентен).
#
# Переменные окружения:
#   SUPABASE_ACCESS_TOKEN  — Personal Access Token (https://supabase.com/dashboard/account/tokens)
#   SUPABASE_DB_PASSWORD   — (опц.) пароль базы; не задан → генерируется и сохраняется в local-deploy-secrets.env
#   SUPABASE_REGION        — (опц.) регион, по умолчанию eu-central-1 (Франкфурт)
#   SUPABASE_PROJECT_NAME  — (опц.) имя проекта, по умолчанию tg-feed
#
# Результат: файл local-deploy-secrets.env с DATABASE_URL / DIRECT_URL и паролем базы.

set -euo pipefail

API="https://api.supabase.com"
TOKEN="${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN не задан}"
NAME="${SUPABASE_PROJECT_NAME:-tg-feed}"
REGION="${SUPABASE_REGION:-eu-central-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS="$ROOT/local-deploy-secrets.env"

api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

# 0. токен + организация
ME="$(api "$API/v1/projects")" || { echo "✗ токен недействителен / сеть недоступна"; exit 1; }
echo "$ME" | jq -e 'type=="array"' >/dev/null || { echo "✗ токен отклонён: $(echo "$ME" | jq -r '.message? // .error? // "unknown"')"; exit 1; }
echo "✓ токен действителен"

ORG="$(api "$API/v1/organizations" | jq -r '.[0].id')"
[ -n "$ORG" ] && [ "$ORG" != "null" ] || { echo "✗ не найдена организация Supabase"; exit 1; }
echo "✓ организация: $ORG"

# 1. проект (существующий не трогаем)
EXISTING="$(api "$API/v1/projects?name=$NAME" | jq -r '.[0].id // empty')"
if [ -n "$EXISTING" ]; then
  REF="$EXISTING"
  echo "✓ проект $NAME уже существует: $REF"
else
  [ -f "$SECRETS" ] && . "$SECRETS"
  DB_PASS="${SUPABASE_DB_PASSWORD:-${DB_PASSWORD:-$(openssl rand -hex 16)}}"
  CREATED="$(api -X POST "$API/v1/projects" -d "{\"org_id\":\"$ORG\",\"name\":\"$NAME\",\"db_pass\":\"$DB_PASS\",\"region\":\"$REGION\",\"plan\":\"free\",\"confirm_reset_image\":false}")"
  REF="$(echo "$CREATED" | jq -r '.id // empty')"
  [ -n "$REF" ] || { echo "✗ создание не удалось: $(echo "$CREATED" | jq -r '.message? // .error? // "unknown"')"; exit 1; }
  mkdir -p "$(dirname "$SECRETS")"; grep -q '^DB_PASSWORD=' "$SECRETS" 2>/dev/null || echo "DB_PASSWORD=$DB_PASS" >> "$SECRETS"
  echo "✓ проект создан: $REF (регион $REGION, пароль базы в $SECRETS)"
fi

# 2. ждать ACTIVE_HEALTHY (до 6 минут)
echo -n "⏳ ожидание provisioning"
for i in $(seq 1 60); do
  ST="$(api "$API/v1/projects/$REF" | jq -r '.status // "UNKNOWN"')"
  [ "$ST" = "ACTIVE_HEALTHY" ] && { echo " — готово"; break; }
  echo -n "."; sleep 6
  [ "$i" = 60 ] && { echo; echo "✗ проект так и не стал ACTIVE_HEALTHY (статус: $ST)"; exit 1; }
done

# 3. SQL-скрипты по порядку: schema → policies → seed
run_sql() {
  local file="$1" label="$2"
  local payload out
  payload="$(jq -Rs '{query: .}' < "$file")"
  out="$(api -X POST "$API/v1/projects/$REF/database/query" -d "$payload")"
  if echo "$out" | jq -e 'has("error")' >/dev/null 2>&1; then
    echo "✗ $label: $(echo "$out" | jq -r '.error')"; exit 1
  fi
  echo "✓ $label применён"
}
run_sql "$ROOT/supabase/schema.sql"   "schema.sql (таблицы+индексы)"
run_sql "$ROOT/supabase/policies.sql" "policies.sql (RLS)"
run_sql "$ROOT/supabase/seed.sql"     "seed.sql (демо-данные)"

# 4. контроль: 9/18/58/3 и RLS
CHECK="$(api -X POST "$API/v1/projects/$REF/database/query" \
  -d '{"query":"SELECT (SELECT count(*) FROM \"Category\") AS categories, (SELECT count(*) FROM \"Channel\") AS channels, (SELECT count(*) FROM \"Post\") AS posts, (SELECT count(*) FROM \"Ad\") AS ads"}')"
echo "$CHECK" | jq -r '.[0] | "✓ данные: категории \(.categories), каналы \(.channels), посты \(.posts), реклама \(.ads)"'

# 5. строки подключения (pooler: 6543 — рантайм, 5432 — миграции)
POOLERS="$(api "$API/v1/projects/$REF/database/poolers")"
HOST="$(echo "$POOLERS" | jq -r '[.[] | select(.database_port==6543)][0].hostname // "aws-0-'"$REGION"'.pooler.supabase.com"')"
[ -f "$SECRETS" ] && . "$SECRETS"
DB_PASS="${SUPABASE_DB_PASSWORD:-${DB_PASSWORD:-$(openssl rand -hex 16)}}"

RUNTIME="postgresql://postgres.$REF:$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$DB_PASS")@$HOST:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
DIRECT="postgresql://postgres.$REF:$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$DB_PASS")@$HOST:5432/postgres?sslmode=require"

{
  echo "DB_PASSWORD=$DB_PASS"
  echo "SUPABASE_REF=$REF"
  echo "DATABASE_URL=$RUNTIME"
  echo "DIRECT_URL=$DIRECT"
} > "$SECRETS"
chmod 600 "$SECRETS"

echo ""
echo "=== Готово. Секреты в $SECRETS (в git не попадают): ==="
echo "SUPABASE_REF=$REF"
echo "DATABASE_URL=<pooler :6543, см. файл>"
echo "DIRECT_URL=<direct :5432, см. файл>"
