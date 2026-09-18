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

-- =====================================================================
-- v4.10: rich-посты (mediaMeta/viewsTg/translations), «Мой канал» (claim +
-- тизер-настройки), CPA-реклама (AdCampaign + эскроу AdvertiserAccount,
-- анти-накрутка CampaignClick, дневная CampaignStat), журнал переводов
-- =====================================================================

ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "mediaMeta" text;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "viewsTg" integer;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "translations" text;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "ttsAudio" text;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "ttsAt" timestamptz;

ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "claimedById" text;
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "claimedAt" timestamptz;
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "teaserMode" text NOT NULL DEFAULT 'none';
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "teaserLimit" integer NOT NULL DEFAULT 160;

CREATE TABLE IF NOT EXISTS "AdCampaign" (
    "id"              text        NOT NULL DEFAULT gen_random_uuid()::text,
    "ownerId"         text        NOT NULL,
    "channelId"       text,
    "title"           text        NOT NULL,
    "body"            text        NOT NULL,
    "ctaLabel"        text        NOT NULL DEFAULT 'Подписаться',
    "link"            text        NOT NULL,
    "imageUrl"        text,
    "costPerClickKop" integer     NOT NULL DEFAULT 300,
    "budgetKop"       integer     NOT NULL DEFAULT 0,
    "spentKop"        integer     NOT NULL DEFAULT 0,
    "impressions"     integer     NOT NULL DEFAULT 0,
    "clicks"          integer     NOT NULL DEFAULT 0,
    "rawClicks"       integer     NOT NULL DEFAULT 0,
    "status"          text        NOT NULL DEFAULT 'moderation',
    "note"            text,
    "createdAt"       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"       timestamptz,
    "completedAt"     timestamptz,
    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdvertiserAccount" (
    "userId"         text        NOT NULL,
    "balanceKop"     integer     NOT NULL DEFAULT 0,
    "topupsTotalKop" integer     NOT NULL DEFAULT 0,
    "spentTotalKop"  integer     NOT NULL DEFAULT 0,
    "updatedAt"      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdvertiserAccount_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE IF NOT EXISTS "CampaignClick" (
    "id"           text        NOT NULL DEFAULT gen_random_uuid()::text,
    "campaignId"   text        NOT NULL,
    "userId"       text        NOT NULL,
    "lastBilledAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billedCount"  integer     NOT NULL DEFAULT 1,
    CONSTRAINT "CampaignClick_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CampaignStat" (
    "id"         text   NOT NULL DEFAULT gen_random_uuid()::text,
    "campaignId" text   NOT NULL,
    "day"        text   NOT NULL,
    "impressions" integer NOT NULL DEFAULT 0,
    "clicks"     integer NOT NULL DEFAULT 0,
    "spentKop"   integer NOT NULL DEFAULT 0,
    CONSTRAINT "CampaignStat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TranslationLog" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    text,
    "postId"    text        NOT NULL,
    "srcLang"   text        NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TranslationLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdvertiserAccount_userId_key"    ON "AdvertiserAccount" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignClick_campaignId_userId_key" ON "CampaignClick" ("campaignId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignStat_campaignId_day_key" ON "CampaignStat" ("campaignId", "day");
CREATE INDEX IF NOT EXISTS "AdCampaign_status_idx"     ON "AdCampaign" ("status");
CREATE INDEX IF NOT EXISTS "AdCampaign_ownerId_idx"    ON "AdCampaign" ("ownerId");
CREATE INDEX IF NOT EXISTS "AdCampaign_channelId_idx"  ON "AdCampaign" ("channelId");
CREATE INDEX IF NOT EXISTS "CampaignStat_day_idx"      ON "CampaignStat" ("day");
CREATE INDEX IF NOT EXISTS "TranslationLog_postId_idx" ON "TranslationLog" ("postId");

-- v4.10.1: озвучка постов (TTS-кэш) + бэкфилл медиа + индексы производительности
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "ttsAudio" text;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "ttsAt" timestamptz;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "embedTried" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Post_channelId_publishedAt_idx" ON "Post" ("channelId", "publishedAt");
CREATE INDEX IF NOT EXISTS "Like_userId_idx"     ON "Like" ("userId");
CREATE INDEX IF NOT EXISTS "Bookmark_userId_idx" ON "Bookmark" ("userId");
CREATE INDEX IF NOT EXISTS "Channel_status_idx"  ON "Channel" ("status");

-- v4.12: реакции исходного поста (сумма всех реакций) + резолвер премиум-эмодзи
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "reactionsTg" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "CustomEmoji" (
  "id"        TEXT PRIMARY KEY,
  "kind"      TEXT NOT NULL DEFAULT 'static',
  "fileId"    TEXT,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Заготовка эквайринга ЮKassa
CREATE TABLE IF NOT EXISTS "PendingPayment" (
  "id"                TEXT PRIMARY KEY,
  "userId"            TEXT NOT NULL,
  "amountKop"         INTEGER NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "provider"          TEXT NOT NULL DEFAULT 'yookassa',
  "providerPaymentId" TEXT,
  "confirmationUrl"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "PendingPayment_userId_createdAt_idx" ON "PendingPayment"("userId", "createdAt" DESC);

-- v5.3: комментарии под постами (только привязанные к Telegram пользователи)
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "commentsCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "Comment" (
  "id"        TEXT PRIMARY KEY,
  "postId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "text"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Comment_postId_createdAt_idx" ON "Comment"("postId", "createdAt");
CREATE INDEX IF NOT EXISTS "Comment_userId_idx" ON "Comment"("userId");

-- v5.5: Lottie-премиум-эмодзи (.tgs) + галочка верификации каналов
ALTER TABLE "CustomEmoji" ADD COLUMN IF NOT EXISTS "animated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "verified" BOOLEAN NOT NULL DEFAULT false;

-- v5.8: инбокс уведомлений-активности (ответы поддержки, комментарии под
-- постами привязанного канала, статусы кампаний, системные)
CREATE TABLE IF NOT EXISTS "Notification" (
  "id"              TEXT PRIMARY KEY,
  "userId"          TEXT NOT NULL,
  "type"            TEXT NOT NULL DEFAULT 'system',
  "title"           TEXT NOT NULL,
  "body"            TEXT,
  "postId"          TEXT,
  "channelUsername" TEXT,
  "readAt"          TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt" DESC);

-- «Не интересно» на уровне канала (v5.10): кнопка EyeOff у поста скрывает
-- ВЕСЬ канал из персональной ленты (редкие детерминированные возвращения ~4%/день)
CREATE TABLE IF NOT EXISTS "ChannelMute" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    text        NOT NULL,
    "channelId" text        NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelMute_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChannelMute_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChannelMute_channelId_fkey" FOREIGN KEY ("channelId")
        REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelMute_userId_channelId_key" ON "ChannelMute"("userId", "channelId");

-- v5.11: баны пользователей, предложка (kind/topic), картинки в чатах, аплоады
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannedAt" timestamptz;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "banReason" text;
ALTER TABLE "SupportThread" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'support';
ALTER TABLE "SupportThread" ADD COLUMN IF NOT EXISTS "topic" text;
ALTER TABLE "SupportMessage" ADD COLUMN IF NOT EXISTS "images" text;

CREATE TABLE IF NOT EXISTS "Upload" (
    "id"        text        NOT NULL DEFAULT gen_random_uuid()::text,
    "ownerId"   text        NOT NULL,
    "mime"      text        NOT NULL,
    "data"      text        NOT NULL,
    "bytes"     integer     NOT NULL DEFAULT 0,
    "width"     integer     NOT NULL DEFAULT 0,
    "height"    integer     NOT NULL DEFAULT 0,
    "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Upload_ownerId_fkey" FOREIGN KEY ("ownerId")
        REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Upload_ownerId_createdAt_idx" ON "Upload"("ownerId", "createdAt");
