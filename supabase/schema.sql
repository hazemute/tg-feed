-- TG-Feed · Supabase/PostgreSQL DDL — зеркало prisma/schema.prisma (Prisma-имена, quoted PascalCase)
-- Применение в SQL Editor по порядку: schema.sql → policies.sql → seed.sql. Все операции идемпотентны.

CREATE TABLE IF NOT EXISTS "User" (
    "id"                 text        NOT NULL DEFAULT gen_random_uuid()::text,
    "username"           text,
    "firstName"          text,
    "lastName"           text,
    "photoUrl"           text,
    "isDemo"             boolean     NOT NULL DEFAULT true,
    "isPremium"          boolean     NOT NULL DEFAULT false,
    "languageCode"       text,
    "categories"         text        NOT NULL DEFAULT '[]',
    "lastSeenNotifiedAt" timestamptz,
    "createdAt"          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Category" (
    "id"    text    NOT NULL DEFAULT gen_random_uuid()::text,
    "slug"  text    NOT NULL,
    "title" text    NOT NULL,
    "emoji" text    NOT NULL,
    "order" integer NOT NULL DEFAULT 0,
    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Channel" (
    "id"               text        NOT NULL DEFAULT gen_random_uuid()::text,
    "tgId"             text        NOT NULL,
    "title"            text        NOT NULL,
    "username"         text        NOT NULL,
    "description"      text,
    "avatarColor"      text        NOT NULL DEFAULT '#3390ec',
    "photoFileId"      text,
    "avatarFetchedAt"  timestamptz,
    "membersCount"     integer,
    "membersFetchedAt" timestamptz,
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

CREATE TABLE IF NOT EXISTS "Ad" (
    "id"          text        NOT NULL DEFAULT gen_random_uuid()::text,
    "title"       text        NOT NULL,
    "body"        text        NOT NULL,
    "ctaLabel"    text        NOT NULL DEFAULT 'Перейти',
    "link"        text        NOT NULL,
    "imageUrl"    text,
    "isActive"    boolean     NOT NULL DEFAULT true,
    "impressions" integer     NOT NULL DEFAULT 0,
    "clicks"      integer     NOT NULL DEFAULT 0,
    "createdAt"   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- Дневная аналитика рекламы (одна строка на рекламу в день)
CREATE TABLE IF NOT EXISTS "AdStat" (
    "id"          text        NOT NULL DEFAULT gen_random_uuid()::text,
    "adId"        text        NOT NULL,
    "day"         text        NOT NULL,
    "impressions" integer     NOT NULL DEFAULT 0,
    "clicks"      integer     NOT NULL DEFAULT 0,
    CONSTRAINT "AdStat_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdStat_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AdStat_adId_day_key" UNIQUE ("adId", "day")
);
CREATE INDEX IF NOT EXISTS "AdStat_day_idx" ON "AdStat"("day");

CREATE TABLE IF NOT EXISTS "HashtagClick" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "tag"       text        NOT NULL,
    "userId"    text,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HashtagClick_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Category_slug_key"              ON "Category" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "Channel_tgId_key"               ON "Channel" ("tgId");
CREATE UNIQUE INDEX IF NOT EXISTS "Channel_username_key"           ON "Channel" ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "Post_tgKey_key"                 ON "Post" ("tgKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_postId_key"         ON "Like" ("userId", "postId");
CREATE UNIQUE INDEX IF NOT EXISTS "PostView_userId_postId_key"     ON "PostView" ("userId", "postId");
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_userId_channelId_key" ON "Subscription" ("userId", "channelId");
CREATE UNIQUE INDEX IF NOT EXISTS "Bookmark_userId_postId_key"     ON "Bookmark" ("userId", "postId");

CREATE INDEX IF NOT EXISTS "HashtagClick_tag_createdAt_idx" ON "HashtagClick" ("tag", "createdAt");

-- FK-индексы: Postgres не строит их автоматически, а джойны/каскады без них медленные
CREATE INDEX IF NOT EXISTS "Channel_categoryId_idx"    ON "Channel" ("categoryId");
CREATE INDEX IF NOT EXISTS "Channel_addedById_idx"     ON "Channel" ("addedById");
CREATE INDEX IF NOT EXISTS "Post_channelId_idx"        ON "Post" ("channelId");
CREATE INDEX IF NOT EXISTS "Post_publishedAt_idx"      ON "Post" ("publishedAt");
CREATE INDEX IF NOT EXISTS "Like_postId_idx"           ON "Like" ("postId");
CREATE INDEX IF NOT EXISTS "PostView_postId_idx"       ON "PostView" ("postId");
CREATE INDEX IF NOT EXISTS "PostView_userId_idx"       ON "PostView" ("userId");
CREATE INDEX IF NOT EXISTS "Bookmark_postId_idx"       ON "Bookmark" ("postId");
CREATE INDEX IF NOT EXISTS "Subscription_channelId_idx" ON "Subscription" ("channelId");

-- v4.9: допуск пользователей при техработах + системные настройки (зеркало Redis)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bypassMaintenance" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "SystemSetting" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
