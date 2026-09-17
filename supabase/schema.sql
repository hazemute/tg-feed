-- ============================================================================
-- TG-Feed — PostgreSQL DDL для Supabase (зеркало prisma/schema.prisma)
-- ============================================================================
--
-- ЧТО ЭТО: полный Postgres-DDL, повторяющий Prisma-схему проекта
-- (prisma/schema.prisma). Prisma в PostgreSQL создаёт таблицы с QUOTED
-- PascalCase-именами ("User", "Category", ...) и QUOTED camelCase-колонками
-- ("tgId", "createdAt", "isPremium", ...) — здесь то же самое, байт-в-байт
-- по именам. После выполнения этого файла `prisma db push` на базе НЕ
-- требуется: клиент Prisma (schema.postgres.prisma) работает с этими
-- таблицами напрямую.
--
-- ПОРЯДОК ПРИМЕНЕНИЯ (Supabase Dashboard → SQL Editor, по очереди):
--   1) schema.sql    (этот файл — таблицы, констрейнты, индексы)
--   2) policies.sql  (RLS: всё закрыто по умолчанию)
--   3) seed.sql      (демо-данные: 9 категорий, 18 каналов, 58 постов, 3 рекламы)
--
-- СООТВЕТСТВИЕ ТИПОВ (Prisma → PostgreSQL):
--   String   → text
--   Boolean  → boolean
--   Int      → integer
--   DateTime → timestamptz
--     Нюанс: дефолтный маппинг Prisma для DateTime — timestamp(3).
--     Здесь timestamptz (рекомендация Supabase, хранит UTC). Рантайм
--     Prisma-клиента с timestamptz работает корректно; при желании строгого
--     паритета выполните `bun run db:pg:push` (приведёт типы к timestamp(3)
--     без потери данных) либо добавьте @db.Timestamptz в
--     prisma/schema.postgres.prisma.
--
-- ДЕФОЛТЫ PK: у всех моделей id — String @id @default(cuid()). Prisma ВСЕГДА
-- присылает сгенерированный cuid сам (на стороне клиента), поэтому дефолт
-- на стороне БД не конфликтует: DEFAULT gen_random_uuid()::text добавлен
-- как страховка (gen_random_uuid() входит в ядро PostgreSQL 13+; Supabase
-- работает на PG15+). Рекомендуемые идентификаторы сид-данных — в seed.sql.
--
-- ИМЕНА КОНСТРЕЙНТОВ/ИНДЕКСОВ — как генерирует Prisma:
--   PK:          "<Table>_pkey"
--   FK:          "<Table>_<column>_fkey"
--   UNIQUE:      "<Table>_<column>_key" / "<Table>_<col1>_<col2>_key"
--   @@index:     "<Table>_<col1>_<col2>_idx"
--
-- Все операции идемпотентны (IF NOT EXISTS) — файл можно запускать повторно.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. "User" — Telegram-пользователь (id "tg_<uid>") или демо ("demo_<deviceId>")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "User" (
    "id"                 text        NOT NULL DEFAULT gen_random_uuid()::text,
    "username"           text,
    "firstName"          text,
    "lastName"           text,
    "photoUrl"           text,
    "isDemo"             boolean     NOT NULL DEFAULT true,
    "categories"         text        NOT NULL DEFAULT '[]',
    "lastSeenNotifiedAt" timestamptz,
    "createdAt"          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 2. "Category" — категории ленты
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Category" (
    "id"    text    NOT NULL DEFAULT gen_random_uuid()::text,
    "slug"  text    NOT NULL,
    "title" text    NOT NULL,
    "emoji" text    NOT NULL,
    "order" integer NOT NULL DEFAULT 0,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. "Channel" — Telegram-каналы
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Channel" (
    "id"               text        NOT NULL DEFAULT gen_random_uuid()::text,
    "tgId"             text        NOT NULL,
    "title"            text        NOT NULL,
    "username"         text        NOT NULL,
    "description"      text,
    "avatarColor"      text        NOT NULL DEFAULT '#3390ec',
    "categoryId"       text        NOT NULL,
    "isPremium"        boolean     NOT NULL DEFAULT false,
    "premiumUntil"     timestamptz,
    "status"           text        NOT NULL DEFAULT 'active',
    "subscribersCount" integer     NOT NULL DEFAULT 0,
    "clicksCount"      integer     NOT NULL DEFAULT 0,
    "addedById"        text,
    "createdAt"        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Channel_categoryId_fkey" FOREIGN KEY ("categoryId")
        REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Channel_addedById_fkey" FOREIGN KEY ("addedById")
        REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 4. "Post" — посты каналов
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Post" (
    "id"          text        NOT NULL DEFAULT gen_random_uuid()::text,
    "tgKey"       text        NOT NULL,
    "channelId"   text        NOT NULL,
    "text"        text        NOT NULL DEFAULT '',
    "mediaUrl"    text,
    "mediaType"   text        NOT NULL DEFAULT 'image',
    "gallery"     text,
    "link"        text,
    "viewsCount"  integer     NOT NULL DEFAULT 0,
    "likesCount"  integer     NOT NULL DEFAULT 0,
    "aiSummary"   text,
    "publishedAt" timestamptz NOT NULL,
    "notifiedAt"  timestamptz,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Post_channelId_fkey" FOREIGN KEY ("channelId")
        REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 5. "Like" — лайки (unique: userId+postId)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Like" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    text        NOT NULL,
    "postId"    text        NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Like_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Like_postId_fkey" FOREIGN KEY ("postId")
        REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 6. "PostView" — просмотры (unique: userId+postId)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PostView" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    text        NOT NULL,
    "postId"    text        NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostView_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PostView_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PostView_postId_fkey" FOREIGN KEY ("postId")
        REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 7. "Subscription" — подписки (unique: userId+channelId)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Subscription" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    text        NOT NULL,
    "channelId" text        NOT NULL,
    "hidden"    boolean     NOT NULL DEFAULT false,
    "notify"    boolean     NOT NULL DEFAULT true,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Subscription_channelId_fkey" FOREIGN KEY ("channelId")
        REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 8. "Bookmark" — закладки (unique: userId+postId)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Bookmark" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    text        NOT NULL,
    "postId"    text        NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt"    timestamptz,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Bookmark_postId_fkey" FOREIGN KEY ("postId")
        REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 9. "Ad" — рекламные записи
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Ad" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "title"     text        NOT NULL,
    "body"      text        NOT NULL,
    "ctaLabel"  text        NOT NULL DEFAULT 'Перейти',
    "link"      text        NOT NULL,
    "imageUrl"  text,
    "isActive"  boolean     NOT NULL DEFAULT true,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 10. "HashtagClick" — клики по #хэштегам (тренды «Сейчас обсуждают»)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "HashtagClick" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "tag"       text        NOT NULL,
    "userId"    text,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HashtagClick_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- УНИКАЛЬНЫЕ ИНДЕКСЫ (@unique / @@unique → CREATE UNIQUE INDEX)
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS "Category_slug_key"
    ON "Category" ("slug");

CREATE UNIQUE INDEX IF NOT EXISTS "Channel_tgId_key"
    ON "Channel" ("tgId");

CREATE UNIQUE INDEX IF NOT EXISTS "Channel_username_key"
    ON "Channel" ("username");

CREATE UNIQUE INDEX IF NOT EXISTS "Post_tgKey_key"
    ON "Post" ("tgKey");

CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_postId_key"
    ON "Like" ("userId", "postId");

CREATE UNIQUE INDEX IF NOT EXISTS "PostView_userId_postId_key"
    ON "PostView" ("userId", "postId");

CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_userId_channelId_key"
    ON "Subscription" ("userId", "channelId");

CREATE UNIQUE INDEX IF NOT EXISTS "Bookmark_userId_postId_key"
    ON "Bookmark" ("userId", "postId");

-- ============================================================================
-- ОБЫЧНЫЕ ИНДЕКСЫ (@@index → CREATE INDEX)
-- ============================================================================
CREATE INDEX IF NOT EXISTS "HashtagClick_tag_createdAt_idx"
    ON "HashtagClick" ("tag", "createdAt");

-- ============================================================================
-- КОНТРОЛЬ: должно вернуть 10 таблиц
-- SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public'
--     AND tablename IN ('User','Category','Channel','Post','Like','PostView',
--                       'Subscription','Bookmark','Ad','HashtagClick');
-- ============================================================================
