# TG-Feed — Supabase (PostgreSQL)

SQL-скрипты для продакшн-базы проекта на Supabase. Локальная разработка в песочнице
продолжает использовать SQLite (`prisma/schema.local.prisma` + `file:…/db/custom.db`);
каноническая схема проекта — `prisma/schema.prisma` (PostgreSQL).

## Состав каталога

| Файл | Назначение |
|---|---|
| `schema.sql` | DDL: 10 таблиц, FK, уникальные и обычные индексы (в т.ч. FK-индексы). Зеркало `prisma/schema.prisma` (quoted PascalCase-таблицы, camelCase-колонки — как генерирует Prisma в Postgres). |
| `policies.sql` | RLS: включён на всех 10 таблицах, политик нет (всё закрыто для публичного anon-API Supabase). Внизу — закомментированные read-only примеры. |
| `seed.sql` | Демо-данные, бит-в-бит зеркало `prisma/seed.ts`: 9 категорий, 18 каналов, 58 постов, 3 рекламы. Идемпотентный. |
| `cron.sql` | ОПЦИОНАЛЬНО: pg_cron + pg_net — ежечасный вызов `/api/parse` из Supabase (альтернатива Vercel Cron; выберите одно). |

## Порядок выполнения

Supabase Dashboard → **SQL Editor** → New query → вставить содержимое файла → Run.
Строго в этом порядке:

1. **`schema.sql`** — создаст таблицы `User, Category, Channel, Post, Like, PostView, Subscription, Bookmark, Ad, HashtagClick`.
2. **`policies.sql`** — включит RLS (без политик = анонимный REST-API доступ закрыт; приложение ходит под владельцем/`service_role`, RLS его не касается).
3. **`seed.sql`** — наполнит каталог демо-данными.

Каждый файл идемпотентен (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING/UPDATE`) — повторный запуск безопасен.

Проверка после выполнения (SQL Editor):

```sql
SELECT 'categories' AS what, count(*) FROM "Category"
UNION ALL SELECT 'channels', count(*) FROM "Channel"
UNION ALL SELECT 'posts',    count(*) FROM "Post"
UNION ALL SELECT 'ads',      count(*) FROM "Ad";
-- Ожидается: 9 / 18 / 58 / 3

SELECT tablename, rowsecurity FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN ('User','Category','Channel','Post','Like','PostView',
                     'Subscription','Bookmark','Ad','HashtagClick');
-- Все 10 строк: rowsecurity = true
```

`Table Editor` в дашборде тоже покажет все 10 таблиц с данными.

## Где взять DATABASE_URL

Supabase Dashboard → **Project Settings → Database → Connection string** (или новый раздел
**Connect** на главной):

### Для приложения (Vercel, serverless) — Transaction Pooler, порт **6543**

```
postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres
```

Добавьте к строке параметры: `?pgbouncer=true&connection_limit=1&sslmode=require`.
Это значение идёт в `DATABASE_URL` на Vercel. Transaction-режим PgBouncer обязателен
для serverless (короткоживущие лямбды не держат постоянных соединений).

### Для миграций/схем (prisma db push) — Session/Direct, порт **5432**

```
postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres
```

(либо вкладка «Direct connection» с хостом `db.<PROJECT_REF>.supabase.co:5432`).
Это значение идёт в `DIRECT_URL` — его использует `prisma db push`/`migrate`
через `directUrl` в `prisma/schema.prisma`.

- `<PROJECT_REF>` — Settings → General → Reference ID.
- `<DB_PASSWORD>` — пароль базы, заданный при создании проекта (если забыли: Database → Reset database password).
- В пароле спецсимволы URL-кодируйте (`@` → `%40`, `#` → `%23`, и т.д.).

## Переменные окружения для Vercel

Project Settings → Environment Variables (можно для Production + Preview):

| Имя | Значение | Обязательна |
|---|---|---|
| `DATABASE_URL` | pooler-строка **:6543** + `?pgbouncer=true&connection_limit=1&sslmode=require` | да |
| `DIRECT_URL` | прямая/session-строка **:5432** (для `prisma db push`, локального прогонa `db:pg:*`) | да |
| `AUTH_SECRET` | длинная случайная строка (`openssl rand -hex 32`) — подпись JWT-сессий | да |
| `CRON_SECRET` | случайная строка — авторизация cron-вызовов `/api/parse` (Vercel Cron и `supabase/cron.sql` шлют `Authorization: Bearer <CRON_SECRET>`) | да |
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather — включает строгую проверку initData и push-уведомления | опционально |
| `ADMIN_KEY` | ключ админ-панели (`/admin`) | опционально |

## Схема Prisma для Postgres

Каноническая `prisma/schema.prisma` уже PostgreSQL: `url = env("DATABASE_URL")`,
`directUrl = env("DIRECT_URL")`. Скрипты:

```bash
bun run db:pg:generate   # prisma generate (клиент Postgres-схемы)
bun run db:pg:push       # prisma db push (использует DIRECT_URL)
```

Поскольку `supabase/schema.sql` уже создаёт структуру, `db push` после SQL-скриптов
**не требуется** — он оставлен для случаев, когда вы меняете модели и хотите
синхронизировать схему силами Prisma.

Нюанс: дефолтный маппинг DateTime у Prisma в Postgres — `timestamp(3)`, а в
`schema.sql` использован `timestamptz` (рекомендация Supabase). Рантайм-клиент
работает с обоими типами одинаково корректно; при желании полного паритета
выполните `bun run db:pg:push` (Prisma приведёт типы, данные не теряются) или
добавьте `@db.Timestamptz` к полям дат в `prisma/schema.prisma`.

## Ограничения и заметки

- Локально проект продолжает жить на SQLite: клиент рантайма генерится из
  `prisma/schema.local.prisma` (`bun run db:generate` / `db:push`), `.env`
  с `file:…/db/custom.db` актуален. Postgres-схема подключается только явно
  (`--schema prisma/schema.prisma`).
- После изменения моделей обновляйте ОБЕ схемы (каноническую и local) — модели
  в них должны оставаться идентичными, иначе типы клиента разъедутся.
- `public/media` (картинки/видео постов) уезжает вместе с деплоем на Vercel —
  отдельный CDN не нужен.
- SQLite-файл **не работает** на Vercel (read-only ФС в serverless) — потому и Supabase.
- In-memory rate-limit и SSE-шина приложений не шарятся между инстансами
  serverless — для MVP допустимо (клиент имеет фолбэк-поллинг).
- Если захотите читать каталог прямо из Supabase REST API (мимо Next.js) —
  раскомментируйте read-only политики в `policies.sql`.
