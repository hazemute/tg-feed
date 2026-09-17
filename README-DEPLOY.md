# TG-Feed — деплой на Supabase (Postgres) + Vercel

Пошаговая инструкция продакшн-деплоя. Локальная разработка остаётся на SQLite
(`prisma/schema.local.prisma`, `file:…/db/custom.db`) — ничего в ней не меняется.
Каноническая схема проекта — Postgres: `prisma/schema.prisma`.

Архитектура: **Vercel** (Next.js 16, serverless-функции + статика `public/`)
→ **Supabase Postgres** (через Transaction Pooler PgBouncer :6543)
← cron-триггеры парсера (**Vercel Cron** из `vercel.json` **или** `supabase/cron.sql` — выберите одно).

---

## Быстрый путь: скрипты автоматизации

Шаги 1–3 можно выполнить двумя командами (нужны только токены):

```bash
# 1) Supabase: создать проект, применить schema/policies/seed, вернуть строки подключения
SUPABASE_ACCESS_TOKEN=sbp_xxx bash scripts/deploy-supabase.sh
#    → пишет DATABASE_URL / DIRECT_URL в local-deploy-secrets.env (в git не попадает)

# 2) Vercel: проект + env + прод-деплой + health-check
VERCEL_TOKEN=vercel_xxx bash scripts/deploy-vercel.sh
#    → печатает прод-URL и ADMIN_KEY для входа в /admin
```

Скрипты идемпотентны (повторный запуск безопасен), секреты генерируются автоматически
и сохраняются в `local-deploy-secrets.env`. Ниже — ручной путь.

---

## Шаг 1. Supabase: база и схема

1. https://supabase.com → **New project** (регион ближе к аудитории; сохраните DB-пароль).
2. Откройте **SQL Editor** → New query и выполните три скрипта из `supabase/` **строго по порядку**:
   1. `supabase/schema.sql` — 10 таблиц (`User, Category, Channel, Post, Like, PostView, Subscription, Bookmark, Ad, HashtagClick`), FK, индексы. Это точное зеркало `prisma/schema.prisma` (Prisma-именование: quoted PascalCase-таблицы, camelCase-колонки) — поэтому `prisma db push` на этой базе **не нужен**.
   2. `supabase/policies.sql` — включает RLS на всех 10 таблицах; политик нет → анонимный доступ через публичный Supabase REST API (anon key) полностью закрыт. Приложение подключается прямым/pooler-подключением (владелец/`service_role`), RLS его не трогает.
   3. `supabase/seed.sql` — демо-данные (зеркало `prisma/seed.ts`): 9 категорий, 18 каналов, 58 постов, 3 рекламы.
3. Проверка (SQL Editor):
   ```sql
   SELECT 'categories' AS what, count(*) FROM "Category"
   UNION ALL SELECT 'channels', count(*) FROM "Channel"
   UNION ALL SELECT 'posts',    count(*) FROM "Post"
   UNION ALL SELECT 'ads',      count(*) FROM "Ad";   -- 9 / 18 / 58 / 3
   ```
   плюс `Table Editor` — таблицы видны в дашборде.
4. **ОПЦИОНАЛЬНО** — планировщик парсера силами Supabase (если не будете использовать Vercel Cron): `supabase/cron.sql` (pg_cron + pg_net, внутри — инструкция и готовая команда с плейсхолдерами `<APP_DOMAIN>` / `<CRON_SECRET>`).

## Шаг 2. Строки подключения

Supabase → **Project Settings → Database → Connection string** (или кнопка **Connect**):

| Назначение | Тип | Порт |
|---|---|---|
| Приложение на Vercel (serverless) | Transaction pooler + `?pgbouncer=true&connection_limit=1&sslmode=require` | **6543** |
| Миграции/`prisma db push` (через `directUrl`) | Session / Direct | **5432** |

Формат: `postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:<PORT>/postgres`
(спецсимволы пароля URL-кодируйте: `@`→`%40`, `#`→`%23`).

## Шаг 3. Vercel: деплой приложения

1. Push репозитория в GitHub → Vercel → **Add New… → Project** → Import.
2. Framework Preset: **Next.js** (по умолчанию). `output: "standalone"` уже включён в `next.config.ts` — Vercel его поддерживает нативно, дополнительных настроек не требует.
3. **Build Command** — переопределите, чтобы клиент сгенерировался из канонической Postgres-схемы:
   ```
   prisma generate && next build
   ```
   (дефолтная `prisma/schema.prisma` — уже PostgreSQL/Supabase, отдельного флага не нужно).
4. **Environment Variables** (Production + Preview):
   | Имя | Значение |
   |---|---|
   | `DATABASE_URL` | pooler-строка :6543 + `?pgbouncer=true&connection_limit=1&sslmode=require` |
   | `DIRECT_URL` | прямая/session-строка :5432 (для `prisma db push`/migrate; в рантайме не используется) |
   | `AUTH_SECRET` | `openssl rand -hex 32` — подпись JWT-сессий |
   | `CRON_SECRET` | `openssl rand -hex 24` — авторизация вызовов `/api/parse` из cron |
   | `ADMIN_KEY` | (опц.) ключ админ-панели `/admin` |
   | `TELEGRAM_BOT_TOKEN` | (опц.) токен @BotFather: строгая проверка initData + push-уведомления |
5. **Deploy**. Домен вида `https://<project>.vercel.app` (или подключите кастомный).
6. **Telegram Mini App**: @BotFather → /mybots → бот → Bot Settings → Menu Button → вписать `https://<домен>` (Telegram требует https — у Vercel он есть). Там же в WebApp-домены можно добавить домен деплоя.

## Шаг 4. Cron: обновление ленты — выберите ОДИН вариант

- **Вариант A (рекомендуется): Vercel Cron.** В корне уже лежит `vercel.json`:
  ```json
  { "crons": [ { "path": "/api/parse", "schedule": "0 * * * *" } ] }
  ```
  Vercel ежечасно шлёт **GET** `/api/parse` с заголовком `Authorization: Bearer $CRON_SECRET` автоматически, если переменная `CRON_SECRET` задана в Vercel (GET-хэндлер у роута уже есть).
- **Вариант B: supabase/cron.sql.** pg_cron внутри Supabase дёргает POST `https://<домен>/api/parse` через pg_net (см. инструкции в файле; тогда удалите/игнорируйте `vercel.json`, чтобы не гонять парсер дважды).

## Шаг 5. Ограничения serverless (важно понимать)

- **SQLite на Vercel НЕ работает** (read-only ФС в лямбдах) — поэтому прод живёт на Supabase Postgres; локально SQLite продолжает работать через `prisma/schema.local.prisma`.
- **In-memory rate-limit не шарится** между инстансами serverless — лимиты (auth/мутации/парсер) считаются на каждый тёплый инстанс отдельно. Для MVP допустимо; при необходимости вынести в Upstash/Supabase.
- **SSE-шина (`/api/events`) не шарится** между инстансами — событие `posts:new` получат только клиенты, прицепившиеся к тому же инстансу, что и парсер. Фолбэк уже реализован: клиентский поллинг `/api/feed/fresh` + бейдж уведомлений (45 c) догоняет всё пропущенное.
- `public/media` уезжает вместе с деплоем (статика Vercel) — картинки/видео сид-постов доступны по `https://<домен>/media/...`, отдельный CDN не нужен.

## Шаг 6. Чек-лист после деплоя

- [ ] `curl https://<домен>/api/health` → `{"ok":true,"db":true,...}` (db:true = Postgres отвечает).
- [ ] Открыть ленту без Telegram: каталог категорий/каналов/постов из сид-данных (9/18/58/3), картинки грузятся.
- [ ] Мини-апп: открыть через Menu Button бота → логин проходит (JWT в localStorage), онбординг 3 категорий, лайк/подписка/закладка пишутся в Postgres (проверить в Table Editor).
- [ ] Парсер: `curl -X POST https://<домен>/api/parse -H "Authorization: Bearer $CRON_SECRET"` → ответ без 401 (в песочнице t.me может деградировать — важен код ответа, не число новых постов); cron-вариант — дождаться ежечасного запуска и посмотреть логи функции на Vercel.
- [ ] Админ-панель `https://<домен>/admin` с `ADMIN_KEY` (если ключ включён) — дашборд открывается.
- [ ] Supabase → Database → Connection pooling: убедиться, что соединения не растут (PgBouncer держит пул).

## Связанные файлы

- `supabase/README.md` — детали по скриптам и строкам подключения.
- `.env.example` — все переменные с комментариями.
- `prisma/schema.prisma` — каноническая Postgres-схема; скрипты `bun run db:pg:generate` / `bun run db:pg:push` — последующие изменения моделей. Локальная SQLite-схема — `prisma/schema.local.prisma` (модели держать идентичными).
