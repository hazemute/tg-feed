import { db } from '@/lib/db'

/**
 * Идемпотентные миграции прода — единый источник для:
 *  - автоприменения при старте сервера (src/instrumentation.ts),
 *  - панели (POST /api/panel/system {action:'applyMigration'}),
 *  - самопроверки и самолечения /api/health.
 *
 * ТОЛЬКО фиксированные строки SQL — никакой внешней интерполяции.
 * Каждый шаг защищён IF NOT EXISTS, повторный запуск безопасен.
 *
 * ВАЖНО: локальные таблицы не создаются — песочница на Supabase-схеме
 * (prisma/schema.prisma → Postgres). Ветка file: оставлена только как
 * dev-fallback песочницы, пока в .env не вставлен DATABASE_URL Supabase.
 */

export const MIGRATIONS: Record<string, string[]> = {
  'v5.15': [
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "aiFlag" text`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "aiFlagAt" timestamptz`,
    `CREATE INDEX IF NOT EXISTS "Post_aiFlag_idx" ON "Post" ("aiFlag")`,
  ],
  'v5.17': [
    // v5.17: тарифы Snap Plus/Pro + ИИ-поиск + ИИ-ассистент + CTA + продвижение
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tier" text NOT NULL DEFAULT 'free'`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tierUntil" timestamptz`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "ctaLabel" text`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "ctaUrl" text`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "styleProfile" text`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "styleAt" timestamptz`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "promotedAt" timestamptz`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "hotScore" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE "PendingPayment" ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'balance'`,
    `CREATE TABLE IF NOT EXISTS "AiSearchLog" ("id" text PRIMARY KEY, "userId" text NOT NULL, "query" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "AiSearchLog_userId_createdAt_idx" ON "AiSearchLog" ("userId", "createdAt" DESC)`,
  ],
  'v5.18': [
    // v5.18: аудит-журнал админ-панели (выдача подписок, баны, операции)
    `CREATE TABLE IF NOT EXISTS "AdminLog" ("id" text PRIMARY KEY, "action" text NOT NULL, "target" text NOT NULL, "meta" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "AdminLog_createdAt_idx" ON "AdminLog" ("createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "AdminLog_action_createdAt_idx" ON "AdminLog" ("action", "createdAt" DESC)`,
  ],
  'v5.19': [
    // v5.19: бейджи пользователей (developer/manager/moderator/sponsor/vip/early)
    // + индексы User: фильтры админки по тиру и сортировка по регистрации
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "badges" text NOT NULL DEFAULT '[]'`,
    `CREATE INDEX IF NOT EXISTS "User_tier_idx" ON "User" ("tier")`,
    `CREATE INDEX IF NOT EXISTS "User_createdAt_idx" ON "User" ("createdAt" DESC)`,
  ],
  'v5.21': [
    // v5.21: deep-link уведомлений — тап по уведомлению открывает комментарии
    // на конкретном комментарии (ветка раскрывается, экран скроллится к нему)
    `ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "commentId" text`,
    `CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx" ON "Notification" ("userId", "readAt")`,
  ],
  'v5.22': [
    // v5.22: премиум-эмодзи бота (слоты → custom_emoji_id) + настройки бота
    // (business_connection_id — премиум-аккаунт-посредник)
    `CREATE TABLE IF NOT EXISTS "BotEmoji" ("slot" text PRIMARY KEY, "emoji" text NOT NULL, "customEmojiId" text NOT NULL DEFAULT '', "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS "BotSetting" ("key" text PRIMARY KEY, "value" text NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ],
  'v5.27': [
    // v5.27: кастомизация профиля — палитра обложки, фон, рамка аватара
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profilePalette" text NOT NULL DEFAULT 'crimson'`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileBg" text NOT NULL DEFAULT 'none'`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profileFrame" text NOT NULL DEFAULT 'none'`,
  ],
  'v5.38': [
    // v5.38: кошелёк — единый баланс (рубли + свайпы, 100 свайпов = 1 ₽)
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "balanceKop" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "swipes" integer NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS "BalanceLog" ("id" text PRIMARY KEY, "userId" text NOT NULL, "kind" text NOT NULL, "currency" text NOT NULL DEFAULT 'rub', "amount" integer NOT NULL, "note" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "BalanceLog_userId_createdAt_idx" ON "BalanceLog" ("userId", "createdAt")`,
    `ALTER TABLE "BalanceLog" ADD CONSTRAINT "BalanceLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  ],
  'v5.40': [
    // v5.40: система розыгрышей — пост с кнопкой «Участвовать (N)», автопроверка
    // подписок, финализация с победителями (призы = свайпы/рубли/тариф/кастом)
    `CREATE TABLE IF NOT EXISTS "Giveaway" ("id" text PRIMARY KEY, "title" text NOT NULL, "text" text NOT NULL DEFAULT '', "prizes" text NOT NULL DEFAULT '[]', "channels" text NOT NULL DEFAULT '[]', "buttonStyle" text NOT NULL DEFAULT 'primary', "buttonEmoji" text NOT NULL DEFAULT '🎉', "buttonEmojiId" text NOT NULL DEFAULT '', "startAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, "endAt" timestamptz NOT NULL, "status" text NOT NULL DEFAULT 'draft', "chatId" text, "messageId" integer, "winners" text, "winnersMessageId" integer, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "Giveaway_status_endAt_idx" ON "Giveaway" ("status", "endAt")`,
    `CREATE TABLE IF NOT EXISTS "GiveawayEntry" ("id" text PRIMARY KEY, "giveawayId" text NOT NULL, "userId" text NOT NULL, "tgId" text, "username" text, "firstName" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "GiveawayEntry_giveawayId_createdAt_idx" ON "GiveawayEntry" ("giveawayId", "createdAt")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GiveawayEntry_giveawayId_userId_key" ON "GiveawayEntry" ("giveawayId", "userId")`,
    `ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  ],
  'v5.44': [
    // v5.44: СКОРОСТЬ — недостающие индексы горячих запросов.
    // Post.publishedAt: all-скоуп ленты (orderBy publishedAt take 400),
    //   «новое за сегодня» /api/categories, окна трендов, /api/feed/fresh.
    // Post.promotedAt: промо-посты на каждой странице 0 ленты.
    // Bookmark.postId: подзапрос COUNT bookmarksCount в SQL-странице ленты
    //   выполняется ПО КАЖДОМУ ПОСТУ каждой страницы (без индекса — скан).
    // Like.postId: симметричные счётчики/джойны по посту.
    // Like/PostView/HashtagClick.createdAt: «пульс» трендов (count за 24ч —
    //   раньше полный скан самых больших таблиц).
    // Notification(userId, readAt): бейдж непрочитанных поллится каждые 20-45с.
    `CREATE INDEX IF NOT EXISTS "Post_publishedAt_idx" ON "Post" ("publishedAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "Post_promotedAt_idx" ON "Post" ("promotedAt")`,
    `CREATE INDEX IF NOT EXISTS "Bookmark_postId_idx" ON "Bookmark" ("postId")`,
    `CREATE INDEX IF NOT EXISTS "Like_postId_idx" ON "Like" ("postId")`,
    `CREATE INDEX IF NOT EXISTS "Like_createdAt_idx" ON "Like" ("createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "PostView_createdAt_idx" ON "PostView" ("createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "HashtagClick_createdAt_idx" ON "HashtagClick" ("createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx" ON "Notification" ("userId", "readAt")`,
  ],
  'v5.46': [
    // v5.46: БИЛЕТНАЯ СИСТЕМА РОЗЫГРЫШЕЙ — задания (активность/промокод/рефералы/
    // буст), вес участника = билеты, утешительные свайпы проигравшим, фото-пост.
    `ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "tasks" text NOT NULL DEFAULT '[]'`,
    `ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "promoCode" text`,
    `ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "losersRewardSwipes" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "photoFileId" text`,
    `ALTER TABLE "GiveawayEntry" ADD COLUMN IF NOT EXISTS "ticketsCount" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "GiveawayEntry" ADD COLUMN IF NOT EXISTS "tasksDone" text NOT NULL DEFAULT '[]'`,
    `CREATE INDEX IF NOT EXISTS "GiveawayEntry_giveawayId_ticketsCount_idx" ON "GiveawayEntry" ("giveawayId", "ticketsCount")`,
    `CREATE TABLE IF NOT EXISTS "GiveawayTicket" ("id" text PRIMARY KEY, "giveawayId" text NOT NULL, "entryId" text, "userId" text NOT NULL, "task" text NOT NULL, "tickets" integer NOT NULL DEFAULT 1, "note" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GiveawayTicket_giveawayId_userId_task_key" ON "GiveawayTicket" ("giveawayId", "userId", "task")`,
    `CREATE INDEX IF NOT EXISTS "GiveawayTicket_userId_createdAt_idx" ON "GiveawayTicket" ("userId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "GiveawayTicket_giveawayId_idx" ON "GiveawayTicket" ("giveawayId")`,
    `ALTER TABLE "GiveawayTicket" ADD CONSTRAINT "GiveawayTicket_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "GiveawayTicket" ADD CONSTRAINT "GiveawayTicket_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "GiveawayEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    `CREATE TABLE IF NOT EXISTS "GiveawayReferral" ("id" text PRIMARY KEY, "referrerUserId" text NOT NULL, "invitedTgId" text NOT NULL, "invitedUserId" text, "activatedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "GiveawayReferral_referrerUserId_invitedTgId_key" ON "GiveawayReferral" ("referrerUserId", "invitedTgId")`,
    `CREATE INDEX IF NOT EXISTS "GiveawayReferral_referrerUserId_activatedAt_idx" ON "GiveawayReferral" ("referrerUserId", "activatedAt")`,
    // Прогресс задания «пролистай X свайпов» — count просмотров с начала розыгрыша
    `CREATE INDEX IF NOT EXISTS "PostView_userId_createdAt_idx" ON "PostView" ("userId", "createdAt")`,
  ],
  'v5.48': [
    // v5.48: СКОРОСТЬ-2 + архитектура — недостающие индексы горячих запросов.
    // GiveawayReferral(invitedTgId, activatedAt): activateReferrals ищет
    //   неактивированные приглашения на КАЖДЫЙ POST /api/auth — таблица
    //   растёт монотонно, без индекса это скан.
    // Subscription.channelId: рассылка новых постов подписчикам (каждый тик
    //   парсера), панели. Channel.categoryId: join категории в ленте/каталоге.
    // Bookmark(userId, createdAt): /api/bookmarks сортирует по createdAt —
    //   раньше in-memory sort по всей выборке пользователя.
    // PostView.postId: счётчики/джойны просмотров по посту.
    // TranslationLog/Notification.createdAt: retention-очистка — раньше полный
    //   скан самых больших таблиц раз в 19ч.
    // AdCampaign.ownerId / Channel.addedById: кабинеты рекламодателя/модератора.
    // Post partial (embedTried): бэкфилл медиа каждый тик парсера фильтрует
    //   «ещё не пробовали и без медиа» — частичный индекс почти пустой.
    `CREATE INDEX IF NOT EXISTS "GiveawayReferral_invitedTgId_activatedAt_idx" ON "GiveawayReferral" ("invitedTgId", "activatedAt")`,
    `CREATE INDEX IF NOT EXISTS "Subscription_channelId_idx" ON "Subscription" ("channelId")`,
    `CREATE INDEX IF NOT EXISTS "Channel_categoryId_idx" ON "Channel" ("categoryId")`,
    `CREATE INDEX IF NOT EXISTS "Channel_addedById_idx" ON "Channel" ("addedById")`,
    `CREATE INDEX IF NOT EXISTS "Bookmark_userId_createdAt_idx" ON "Bookmark" ("userId", "createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "PostView_postId_idx" ON "PostView" ("postId")`,
    `CREATE INDEX IF NOT EXISTS "TranslationLog_createdAt_idx" ON "TranslationLog" ("createdAt")`,
    `CREATE INDEX IF NOT EXISTS "Notification_createdAt_idx" ON "Notification" ("createdAt")`,
    `CREATE INDEX IF NOT EXISTS "AdCampaign_ownerId_idx" ON "AdCampaign" ("ownerId")`,
    `CREATE INDEX IF NOT EXISTS "Post_pending_media_idx" ON "Post" ("publishedAt" DESC) WHERE "embedTried" = false AND "mediaUrl" IS NULL`,
  ],
  'v5.50': [
    // v5.50: ИСТОЧНИКИ РЕКОМЕНДАЦИЙ («В один клик») — юзер пересылает боту посты
    // из 5 любимых каналов, бот извлекает каналы из forward_origin и складывает
    // профиль. Профиль = сильнейший сигнал персональной ленты + очередь парсинга.
    `CREATE TABLE IF NOT EXISTS "UserSource" ("id" text PRIMARY KEY, "userId" text NOT NULL, "tgId" text NOT NULL, "title" text NOT NULL DEFAULT '', "username" text, "channelId" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "UserSource_userId_tgId_key" ON "UserSource" ("userId", "tgId")`,
    `CREATE INDEX IF NOT EXISTS "UserSource_userId_createdAt_idx" ON "UserSource" ("userId", "createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "UserSource_channelId_idx" ON "UserSource" ("channelId")`,
  ],
  'v5.51': [
    // v5.51: ЗАДАНИЯ С НАГРАДОЙ (вкладка «Задания» вместо «Тренды») — подписка
    // на канал / вступление в чат за свайпы. Проверка getChatMember (бот-админ),
    // реверификация по расписанию: отписался → задание аннулировано + штраф ×2.
    `CREATE TABLE IF NOT EXISTS "Quest" ("id" text PRIMARY KEY, "title" text NOT NULL, "description" text, "kind" text NOT NULL DEFAULT 'subscribe', "target" text NOT NULL, "link" text, "rewardSwp" integer NOT NULL DEFAULT 100, "active" boolean NOT NULL DEFAULT true, "sort" integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS "QuestCompletion" ("id" text PRIMARY KEY, "questId" text NOT NULL, "userId" text NOT NULL, "status" text NOT NULL DEFAULT 'done', "rewardSwp" integer NOT NULL, "checks" integer NOT NULL DEFAULT 1, "lastCheck" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "QuestCompletion_questId_userId_key" ON "QuestCompletion" ("questId", "userId")`,
    `CREATE INDEX IF NOT EXISTS "Quest_active_sort_idx" ON "Quest" ("active", "sort")`,
    `CREATE INDEX IF NOT EXISTS "QuestCompletion_userId_status_idx" ON "QuestCompletion" ("userId", "status")`,
    `CREATE INDEX IF NOT EXISTS "QuestCompletion_status_lastCheck_idx" ON "QuestCompletion" ("status", "lastCheck")`,
    `CREATE INDEX IF NOT EXISTS "QuestCompletion_questId_idx" ON "QuestCompletion" ("questId")`,
  ],
  'v5.64': [
    // v5.64: ОТЛОЖЕННЫЕ ПОСТЫ (Snap Ассистент: «опубликуй завтра в 18:00») —
    // очередь ScheduledPost, публикуется свипом (mychannel/parse tick) через бота
    `CREATE TABLE IF NOT EXISTS "ScheduledPost" ("id" text PRIMARY KEY, "channelId" text NOT NULL, "text" text NOT NULL, "imageUrl" text, "scheduledAt" timestamptz NOT NULL, "publishedAt" timestamptz, "link" text, "error" text, "createdBy" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "ScheduledPost_scheduledAt_idx" ON "ScheduledPost" ("scheduledAt")`,
    `CREATE INDEX IF NOT EXISTS "ScheduledPost_channelId_publishedAt_idx" ON "ScheduledPost" ("channelId", "publishedAt")`,
    `ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  ],
  'v5.65': [
    // v5.65: ПРОМОКОДЫ (генератор в админ-панели, активация в миниаппе — кошелёк).
    // kind: swipes | rub | tier; одна активация на пользователя (уникальный индекс)
    `CREATE TABLE IF NOT EXISTS "PromoCode" ("id" text PRIMARY KEY, "code" text NOT NULL, "kind" text NOT NULL, "swipes" integer NOT NULL DEFAULT 0, "amountKop" integer NOT NULL DEFAULT 0, "tierPlan" text, "tierDays" integer NOT NULL DEFAULT 0, "maxUses" integer NOT NULL DEFAULT 1, "usedCount" integer NOT NULL DEFAULT 0, "active" boolean NOT NULL DEFAULT true, "note" text, "expiresAt" timestamptz, "createdById" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PromoCode_code_key" ON "PromoCode" ("code")`,
    `CREATE INDEX IF NOT EXISTS "PromoCode_createdAt_idx" ON "PromoCode" ("createdAt")`,
    `CREATE TABLE IF NOT EXISTS "PromoRedemption" ("id" text PRIMARY KEY, "promoId" text NOT NULL, "userId" text NOT NULL, "reward" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PromoRedemption_promoId_userId_key" ON "PromoRedemption" ("promoId", "userId")`,
    `CREATE INDEX IF NOT EXISTS "PromoRedemption_userId_createdAt_idx" ON "PromoRedemption" ("userId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "PromoRedemption_promoId_createdAt_idx" ON "PromoRedemption" ("promoId", "createdAt")`,
    `ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  ],
  'v5.68': [
    // v5.68: ЖАЛОБЫ И МОДЕРАЦИЯ БЕЗ ИИ. PostHide — «Не интересно» на конкретный
    // пост (канал НЕ удаляется, категория понижается в персональном ранжировании);
    // PostReport/CommentReport — жалобы (уникальные по юзеру); Comment.hidden/
    // adScore — антирекламный эвристический скрипт (lib/moderation.ts); авто-скрытие
    // комментария при 3+ уникальных жалобщиках.
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "reportsCount" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "hidden" boolean NOT NULL DEFAULT false`,
    `ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "adScore" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "reportsCount" integer NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS "PostHide" ("id" text PRIMARY KEY, "userId" text NOT NULL, "postId" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PostHide_userId_postId_key" ON "PostHide" ("userId", "postId")`,
    `CREATE INDEX IF NOT EXISTS "PostHide_userId_idx" ON "PostHide" ("userId")`,
    `CREATE TABLE IF NOT EXISTS "PostReport" ("id" text PRIMARY KEY, "postId" text NOT NULL, "userId" text NOT NULL, "reason" text NOT NULL DEFAULT 'other', "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PostReport_userId_postId_key" ON "PostReport" ("userId", "postId")`,
    `CREATE INDEX IF NOT EXISTS "PostReport_postId_idx" ON "PostReport" ("postId")`,
    `CREATE INDEX IF NOT EXISTS "PostReport_createdAt_idx" ON "PostReport" ("createdAt")`,
    `CREATE TABLE IF NOT EXISTS "CommentReport" ("id" text PRIMARY KEY, "commentId" text NOT NULL, "userId" text NOT NULL, "reason" text NOT NULL DEFAULT 'other', "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "CommentReport_userId_commentId_key" ON "CommentReport" ("userId", "commentId")`,
    `CREATE INDEX IF NOT EXISTS "CommentReport_commentId_idx" ON "CommentReport" ("commentId")`,
    `CREATE INDEX IF NOT EXISTS "Comment_hidden_postId_idx" ON "Comment" ("postId", "hidden")`,
    `ALTER TABLE "PostHide" ADD CONSTRAINT "PostHide_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "PostHide" ADD CONSTRAINT "PostHide_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "PostReport" ADD CONSTRAINT "PostReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "PostReport" ADD CONSTRAINT "PostReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    `ALTER TABLE "CommentReport" ADD CONSTRAINT "CommentReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  ],
  'v5.69': [
    // v5.69: ПРОДВИЖЕНИЕ С SNAP PRO — месячная модель. 1 бесплатное продвижение
    // в календарный месяц (UTC) вместо «7 раз в неделю»; сверх лимита — купленные
    // пакеты (PROMOTE_PACK: 5 продвижений за 199 ₽). promoteCredits — баланс
    // купленных продвижений; promoteFreeMonth — ключ месяца ('YYYY-MM' UTC),
    // в котором бесплатный слот уже использован (атомарное владение через
    // условный updateMany: NOT monthKey → пустая строка/прошлый месяц).
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "promoteCredits" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "promoteFreeMonth" text NOT NULL DEFAULT ''`,
  ],
  // КЛЮЧ 'v5.69-perf' (не v5.70): суффикс, чтобы не пересекаться с параллельным
  // агентом, занявшим v5.69 под продвижение. ALL применяет блоки независимо от имён.
  'v5.69-perf': [
    // v5.69 (перф): СКОРОСТЬ ПРОФИЛЕЙ/СТАТИСТИКИ.
    // Channel.claimedById: GET /api/mychannel ищет каналы владельца
    //   (where claimedById) и promotedUsed-джойны по нему — раньше полный скан.
    // Comment(userId) уже есть (v5.х), CommentLike(userId) покрывается
    //   unique(userId, commentId) — счётчики /api/user/[uid] и /api/profile
    //   теперь идут ОДНИМ SQL с подзапросами (1 RTT вместо 4-5).
    `CREATE INDEX IF NOT EXISTS "Channel_claimedById_idx" ON "Channel" ("claimedById")`,
  ],
  'v5.70-quests': [
    // v5.70: РАСШИРЕНИЕ ЗАДАНИЙ — новые виды (tiktok_follow/daily_checkin/
    // profile_setup/boost/activity_milestone/referral) + DailyCheckin (серия
    // ежедневного входа), QuestVerifyLog (аудит VLM-проверок TikTok),
    // BotChat (чаты, где бот админ — для приватных инвайт-чатов).
    `ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "targetType" text NOT NULL DEFAULT 'username'`,
    `CREATE TABLE IF NOT EXISTS "DailyCheckin" ("id" text PRIMARY KEY, "userId" text NOT NULL, "streak" integer NOT NULL DEFAULT 0, "bestStreak" integer NOT NULL DEFAULT 0, "lastDate" text NOT NULL DEFAULT '', "totalCheckins" integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "DailyCheckin_userId_key" ON "DailyCheckin" ("userId")`,
    `CREATE TABLE IF NOT EXISTS "QuestVerifyLog" ("id" text PRIMARY KEY, "questId" text NOT NULL, "userId" text NOT NULL, "ok" boolean NOT NULL DEFAULT false, "confidence" text NOT NULL DEFAULT '', "reason" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "QuestVerifyLog_userId_questId_createdAt_idx" ON "QuestVerifyLog" ("userId", "questId", "createdAt")`,
    `CREATE TABLE IF NOT EXISTS "BotChat" ("id" text PRIMARY KEY, "chatId" text NOT NULL, "title" text NOT NULL DEFAULT '', "type" text NOT NULL DEFAULT 'supergroup', "isAdmin" boolean NOT NULL DEFAULT false, "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "BotChat_chatId_key" ON "BotChat" ("chatId")`,
  ],
  // КЛЮЧ 'v5.70-promo' (Task 7-a): суффикс, чтобы не пересекаться с параллельным
  // агентом, занявшим 'v5.70-quests'. Гибкий показ в ленте: Channel.teaserApplyTo —
  // каким постам применять тизер (all | long — лонгриды 600+ симв. | text —
  // текстовые без медиа). Настройка живёт во вкладке «Промо».
  'v5.70-promo': [
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "teaserApplyTo" text NOT NULL DEFAULT 'all'`,
  ],
  // КЛЮЧ 'v5.73-ai': память ИИ (AiMemory) и постоянная история чатов (AiChatMessage)
  'v5.73-ai': [
    `CREATE TABLE IF NOT EXISTS "AiMemory" ("userId" TEXT NOT NULL PRIMARY KEY, "content" TEXT NOT NULL DEFAULT '', "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS "AiChatMessage" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "surface" TEXT NOT NULL, "channelId" TEXT, "role" TEXT NOT NULL, "content" TEXT NOT NULL, "meta" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "AiChatMessage_userId_surface_createdAt_idx" ON "AiChatMessage"("userId", "surface", "createdAt")`,
  ],
  // КЛЮЧ 'v5.74-ai-sessions': сессии ИИ-чатов («Новый чат»/история/удаление) +
  // колонка sessionId в сообщениях. Монетизация: Post.promoteSpent ('free' |
  // 'credit' | 'refund') — источник списанного продвижения, нужен для «Снять
  // с продвижения» и гарантии возврата (авто-рефанд за слабые показы).
  'v5.74-ai-sessions': [
    `CREATE TABLE IF NOT EXISTS "AiChatSession" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "surface" TEXT NOT NULL, "channelId" TEXT, "title" TEXT NOT NULL DEFAULT 'Новый чат', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "AiChatSession_userId_surface_updatedAt_idx" ON "AiChatSession"("userId", "surface", "updatedAt")`,
    `ALTER TABLE "AiChatMessage" ADD COLUMN IF NOT EXISTS "sessionId" TEXT`,
    `CREATE INDEX IF NOT EXISTS "AiChatMessage_sessionId_createdAt_idx" ON "AiChatMessage"("sessionId", "createdAt")`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "promoteSpent" TEXT`,
  ],
  // v5.75: СИСТЕМА УРОВНЕЙ — XP за активность (комментарии/лайки/задания/чек-ин),
  // штрафы за нарушения (скрытые жалобами/удалённые админом комментарии, бан),
  // награда свайпами за повышение уровня. XpLog — журнал + дневные лимиты анти-абуза.
  'v5.75-xp': [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "xp" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "level" integer NOT NULL DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS "XpLog" ("id" text PRIMARY KEY, "userId" text NOT NULL, "kind" text NOT NULL, "amount" integer NOT NULL, "note" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "XpLog_userId_createdAt_idx" ON "XpLog" ("userId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "XpLog_userId_kind_createdAt_idx" ON "XpLog" ("userId", "kind", "createdAt")`,
    `ALTER TABLE "XpLog" ADD CONSTRAINT "XpLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  ],
  // v5.77: КОШЕЛЁК v2 — адреса двух счетов + журнал переводов WalletTx
  'v5.77-wallet': [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "swipeAddress" text`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "rubAddress" text`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "referredById" text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "User_swipeAddress_key" ON "User" ("swipeAddress")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "User_rubAddress_key" ON "User" ("rubAddress")`,
    `CREATE TABLE IF NOT EXISTS "WalletTx" ("id" text PRIMARY KEY, "kind" text NOT NULL, "currency" text NOT NULL, "amount" integer NOT NULL, "fromAddr" text, "toAddr" text, "fromUserId" text, "toUserId" text, "note" text, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "WalletTx_fromUserId_createdAt_idx" ON "WalletTx" ("fromUserId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "WalletTx_toUserId_createdAt_idx" ON "WalletTx" ("toUserId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "WalletTx_fromAddr_idx" ON "WalletTx" ("fromAddr")`,
    `CREATE INDEX IF NOT EXISTS "WalletTx_toAddr_idx" ON "WalletTx" ("toAddr")`,
  ],
  // v5.85: серверная отметка «онбординг показан» — гайд/тутор больше не
  // повторяются, даже если Telegram-клиент чистит localStorage между сессиями.
  // Бэктест: все юзеры старше суток уже видели онбординг — помечаем сразу
  // (иначе после релиза каждый существующий юзер получил бы гайд ещё раз);
  // свежие аккаунты (<24ч) и будущие регистрации проходят онбординг честно.
  'v5.85-onboarded': [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "onboardedAt" timestamp(3)`,
    `UPDATE "User" SET "onboardedAt" = CURRENT_TIMESTAMP WHERE "onboardedAt" IS NULL AND "createdAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'`,
  ],
  // v5.88: награды лидербордов — журнал начислений топ-3 (неделя/месяц по XP).
  // Два unique-индекса: один пользователь в периоде и одно место в периоде
  // могут быть выплачены ровно один раз (страховка от рестарта крона).
  'v5.88-lbpayouts': [
    `CREATE TABLE IF NOT EXISTS "LeaderboardPayout" ("id" text PRIMARY KEY, "period" text NOT NULL, "periodKey" text NOT NULL, "userId" text NOT NULL, "place" integer NOT NULL, "xpGained" integer NOT NULL, "amount" integer NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "LeaderboardPayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardPayout_period_periodKey_userId_key" ON "LeaderboardPayout"("period", "periodKey", "userId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardPayout_period_periodKey_place_key" ON "LeaderboardPayout"("period", "periodKey", "place")`,
    `CREATE INDEX IF NOT EXISTS "LeaderboardPayout_period_periodKey_idx" ON "LeaderboardPayout"("period", "periodKey")`,
    `CREATE INDEX IF NOT EXISTS "LeaderboardPayout_userId_createdAt_idx" ON "LeaderboardPayout"("userId", "createdAt")`,
  ],
  // v5.90: система достижений — разблокировки ачивок (каталог живёт в коде,
  // lib/achievements.ts). Одна строка на (юзер, ачивка), tier — достигнутый
  // максимум (1..3); unlockedAt — первый зачёт, tierAt — последний апгрейд.
  'v5.90-achievements': [
    `CREATE TABLE IF NOT EXISTS "UserAchievement" ("id" text PRIMARY KEY, "userId" text NOT NULL, "achievementId" text NOT NULL, "tier" integer NOT NULL DEFAULT 1, "unlockedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "tierAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "UserAchievement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "UserAchievement_userId_achievementId_key" ON "UserAchievement"("userId", "achievementId")`,
    `CREATE INDEX IF NOT EXISTS "UserAchievement_achievementId_tier_idx" ON "UserAchievement"("achievementId", "tier")`,
    `CREATE INDEX IF NOT EXISTS "UserAchievement_userId_tierAt_idx" ON "UserAchievement"("userId", "tierAt")`,
  ],
  // v5.93: ЧТЕНИЕ И СТРИК — ReadingDay (дневные счётчики уникально прочитанных
  // постов) + ReadingStreak (серия дней чтения, заморозки, цель недели).
  // Стрик считается ЛЕНИВО при записи прочтения (POST /api/reads), крон не нужен.
  'v5.93-reading': [
    `CREATE TABLE IF NOT EXISTS "ReadingDay" ("id" text PRIMARY KEY, "userId" text NOT NULL, "day" text NOT NULL, "reads" integer NOT NULL DEFAULT 0, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ReadingDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReadingDay_userId_day_key" ON "ReadingDay"("userId", "day")`,
    `CREATE INDEX IF NOT EXISTS "ReadingDay_userId_day_idx" ON "ReadingDay"("userId", "day")`,
    `CREATE TABLE IF NOT EXISTS "ReadingStreak" ("id" text PRIMARY KEY, "userId" text NOT NULL, "streak" integer NOT NULL DEFAULT 0, "bestStreak" integer NOT NULL DEFAULT 0, "lastDate" text NOT NULL DEFAULT '', "freezes" integer NOT NULL DEFAULT 0, "totalReads" integer NOT NULL DEFAULT 0, "weekKey" text NOT NULL DEFAULT '', "weekReads" integer NOT NULL DEFAULT 0, "weekRewardKey" text NOT NULL DEFAULT '', "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ReadingStreak_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ReadingStreak_userId_key" ON "ReadingStreak"("userId")`,
    `CREATE INDEX IF NOT EXISTS "ReadingStreak_lastDate_idx" ON "ReadingStreak"("lastDate")`,
  ],
  // v5.94: серверный синк темы оформления — JSON {mode, custom:{bg,accent}} на User.
  // Устройство А меняет тему → PUT; устройство Б при входе тянет GET и применяет.
  'v5.94-theme': [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "themeSettings" text`,
  ],
  // v5.98: КОММЕРЦИЯ — Telegram Stars на балансе User + Sponsor (спонсоры розыгрыша,
  // 990₽ фикс) + AdSlot (рекламный календарь 12:00/18:00 МСК, максимум 2 поста в сутки)
  // + Blacklist (авто-модерация services/autoMod.ts).
  'v5.98-commerce': [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "balanceStars" integer NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS "Sponsor" ("id" text PRIMARY KEY, "userId" text NOT NULL, "username" text NOT NULL, "channelId" text, "title" text, "paidAmountKop" integer NOT NULL DEFAULT 99000, "currency" text NOT NULL DEFAULT 'RUB', "status" text NOT NULL DEFAULT 'PENDING', "giveawayId" text, "paymentId" text, "paidAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "Sponsor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS "Sponsor_status_idx" ON "Sponsor"("status")`,
    `CREATE INDEX IF NOT EXISTS "Sponsor_userId_createdAt_idx" ON "Sponsor"("userId", "createdAt")`,
    `CREATE TABLE IF NOT EXISTS "AdSlot" ("id" text PRIMARY KEY, "userId" text NOT NULL, "text" text NOT NULL, "imageUrl" text, "link" text, "targetDate" timestamp(3) NOT NULL, "slotTime" text NOT NULL, "runAt" timestamp(3) NOT NULL, "priceKop" integer NOT NULL DEFAULT 99000, "currency" text NOT NULL DEFAULT 'RUB', "status" text NOT NULL DEFAULT 'PENDING', "paymentId" text, "publishedMessageId" integer, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "AdSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS "AdSlot_status_runAt_idx" ON "AdSlot"("status", "runAt")`,
    `CREATE INDEX IF NOT EXISTS "AdSlot_userId_createdAt_idx" ON "AdSlot"("userId", "createdAt")`,
    `CREATE TABLE IF NOT EXISTS "Blacklist" ("id" text PRIMARY KEY, "tgId" text NOT NULL, "userId" text, "reason" text NOT NULL DEFAULT '', "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Blacklist_tgId_key" ON "Blacklist"("tgId")`,
  ],
  // v6.1: МОНЕТИЗАЦИЯ ВЛАДЕЛЬЦА — платная верификация (Channel.verifiedUntil), буст каталога
  // (Channel.boostUntil), платная подписка на автора 70/30 (Channel.membershipPriceKop /
  // Post.memberOnly / ChannelMembership), биржа взаимопиара (CrossPromo)
  'v6.1-monetize': [
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "verifiedUntil" timestamp(3)`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "boostUntil" timestamp(3)`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "membershipPriceKop" integer`,
    `ALTER TABLE "Channel" ADD COLUMN IF NOT EXISTS "memberBenefits" text`,
    `ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "memberOnly" boolean NOT NULL DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS "ChannelMembership" ("id" text PRIMARY KEY, "userId" text NOT NULL, "channelId" text NOT NULL, "priceKop" integer NOT NULL, "since" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "until" timestamp(3) NOT NULL, "incomeKop" integer NOT NULL DEFAULT 0, CONSTRAINT "ChannelMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "ChannelMembership_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ChannelMembership_userId_channelId_key" ON "ChannelMembership"("userId", "channelId")`,
    `CREATE INDEX IF NOT EXISTS "ChannelMembership_channelId_idx" ON "ChannelMembership"("channelId")`,
    `CREATE INDEX IF NOT EXISTS "ChannelMembership_until_idx" ON "ChannelMembership"("until")`,
    `CREATE TABLE IF NOT EXISTS "CrossPromo" ("id" text PRIMARY KEY, "fromChannelId" text NOT NULL, "toChannelId" text NOT NULL, "status" text NOT NULL DEFAULT 'PENDING', "message" text, "respondedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "CrossPromo_fromChannelId_fkey" FOREIGN KEY ("fromChannelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT "CrossPromo_toChannelId_fkey" FOREIGN KEY ("toChannelId") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS "CrossPromo_toChannelId_status_idx" ON "CrossPromo"("toChannelId", "status")`,
    `CREATE INDEX IF NOT EXISTS "CrossPromo_fromChannelId_status_idx" ON "CrossPromo"("fromChannelId", "status")`,
    `CREATE INDEX IF NOT EXISTS "Channel_boostUntil_idx" ON "Channel"("boostUntil")`,
  ],
  'v6.6-botuser': [
    // v6.6: ВСЯ аудитория бота в ЛС (каждый приватный апдейт вебхука сохраняет
    // chat_id) — рассылки /send и вкладки «Рассылка» доходят и до тех, кто
    // миниапп не открывал.
    `CREATE TABLE IF NOT EXISTS "BotUser" ("chatId" text PRIMARY KEY, "username" text, "firstName" text, "lastSeenAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  ],
}

const ALL: string[] = Object.values(MIGRATIONS).flat()

function isSqlite(): boolean {
  return (process.env.DATABASE_URL ?? '').startsWith('file:')
}

/** Критичные объекты схемы: [таблица, колонка] (колонка null → проверяется сама таблица) */
const CRITICAL: Array<[string, string | null]> = [
  ['BotUser', null],
  ['User', 'tier'],
  ['User', 'tierUntil'],
  ['Channel', 'ctaLabel'],
  ['Channel', 'styleProfile'],
  ['Post', 'hotScore'],
  ['Post', 'promotedAt'],
  ['Post', 'aiFlag'],
  ['PendingPayment', 'purpose'],
  ['AiSearchLog', null],
  ['AdminLog', null],
  ['User', 'badges'],
  ['User', 'profilePalette'],
  ['User', 'profileBg'],
  ['User', 'profileFrame'],
  ['Notification', 'commentId'],
  ['BotEmoji', null],
  ['BotSetting', null],
  ['Giveaway', null],
  ['GiveawayEntry', null],
  ['GiveawayTicket', null],
  ['GiveawayReferral', null],
  ['Giveaway', 'tasks'],
  ['GiveawayEntry', 'ticketsCount'],
  ['UserSource', null],
  ['Quest', null],
  ['QuestCompletion', null],
  ['User', 'swipeAddress'],
  ['User', 'referredById'],
  ['WalletTx', null],
  ['ScheduledPost', null],
  ['PromoCode', null],
  ['PromoRedemption', null],
  ['PostHide', null],
  ['PostReport', null],
  ['CommentReport', null],
  ['Comment', 'hidden'],
  ['Post', 'reportsCount'],
  ['User', 'promoteCredits'],
  ['User', 'promoteFreeMonth'],
  ['Quest', 'targetType'],
  ['DailyCheckin', null],
  ['QuestVerifyLog', null],
  ['BotChat', null],
  ['Channel', 'teaserApplyTo'],
  ['AiChatSession', null],
  ['AiChatMessage', 'sessionId'],
  ['Post', 'promoteSpent'],
  ['User', 'xp'],
  ['User', 'level'],
  ['User', 'themeSettings'],
  ['User', 'balanceStars'],
  ['Sponsor', null],
  ['AdSlot', null],
  ['Blacklist', null],
  ['XpLog', null],
  ['Channel', 'boostUntil'],
  ['Channel', 'verifiedUntil'],
  ['Channel', 'membershipPriceKop'],
  ['Post', 'memberOnly'],
  ['ChannelMembership', null],
  ['CrossPromo', null],
]

export type SchemaState = { ok: boolean; missing: string[] }

/*
 * v5.86 — МАРКЕР ВЕРСИИ СХЕМЫ (лечение холодного старта Vercel):
 * instrumentation раньше звал ensureAppSchema({force:true}) на КАЖДЫЙ cold
 * start — ~154 DDL-стейтмента по одному ($executeRawUnsafe, roundtrip к
 * Supabase каждый) занимали секунды до первого запроса; пользователь
 * ловил медленный вход и экран «Не удалось загрузиться».
 *
 * Теперь: после успешного ПОЛНОГО прогона ALL в SystemSetting пишется
 * маркер schema_version = <последняя версия MIGRATIONS>. На старте маркер
 * читается ОДНИМ SELECT'ом: совпал — схема гарантированно накатена целиком
 * (маркер ставит тот же прогон, что выполнил все стейтменты), DDL не
 * повторяем. Правило при добавлении миграции: новая версия в MIGRATIONS
 * автоматически становится «latest», маркер перестаёт совпадать, следующий
 * cold start честно накатывает всё (идемпотентно) и обновляет маркер.
 */
const SCHEMA_VERSION_KEY = 'schema_version'

/** Последняя версия миграций (ключи записаны по порядку выхода версий) */
export function latestMigrationVersion(): string | null {
  const keys = Object.keys(MIGRATIONS)
  return keys.length ? keys[keys.length - 1] : null
}

/** Маркер версии из БД; null — нет записи/БД недоступна (честный прогон) */
async function readStoredSchemaVersion(): Promise<string | null> {
  try {
    const row = await db.systemSetting.findUnique({ where: { key: SCHEMA_VERSION_KEY } })
    return row?.value ?? null
  } catch {
    return null
  }
}

/** Записать маркер после успешного полного прогона (сбой не критичен) */
async function writeSchemaVersion(v: string): Promise<void> {
  try {
    await db.systemSetting.upsert({
      where: { key: SCHEMA_VERSION_KEY },
      update: { value: v },
      create: { key: SCHEMA_VERSION_KEY, value: v },
    })
  } catch {
    /* следующий cold start просто повторит прогон */
  }
}

/*
 * Task 8-b: кэш проверки 30с. /api/health зовёт checkSchema на каждый запрос
 * (мониторы/cron долбят её и в спокойствии, и тем более под наплывом) —
 * information_schema-SELECT на каждый пинг не нужен: схема меняется только
 * миграциями/панелью, обе точки сбрасывают кэш (invalidateSchemaCheck).
 */
let checkCache: { state: SchemaState; exp: number } | null = null
const CHECK_TTL_MS = 30_000

/** Сбросить кэш проверки схемы (после миграций/ALTER'ов) */
export function invalidateSchemaCheck(): void {
  checkCache = null
}

/** Проверка критичных объектов схемы (Postgres; в SQLite-песочнице всегда ok) */
export async function checkSchema(): Promise<SchemaState> {
  if (isSqlite()) return { ok: true, missing: [] }
  if (checkCache && checkCache.exp > Date.now()) return checkCache.state
  try {
    type Row = { table_name: string; column_name: string }
    const rows = await db.$queryRawUnsafe<Row[]>(`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND (
        c.table_name = 'AiSearchLog' OR c.table_name = 'AdminLog' OR
        (c.table_name = 'User' AND c.column_name IN ('tier','tierUntil','badges','profilePalette','profileBg','profileFrame','promoteCredits','promoteFreeMonth','xp','level','themeSettings','swipeAddress','rubAddress','referredById','balanceStars')) OR
        (c.table_name = 'Channel' AND c.column_name IN ('ctaLabel','ctaUrl','styleProfile','styleAt','teaserApplyTo','verifiedUntil','boostUntil','membershipPriceKop')) OR
        (c.table_name = 'Post' AND c.column_name IN ('promotedAt','hotScore','aiFlag','memberOnly')) OR
        (c.table_name = 'PendingPayment' AND c.column_name = 'purpose') OR
        (c.table_name = 'Notification' AND c.column_name = 'commentId') OR
        (c.table_name = 'BotEmoji' OR c.table_name = 'BotSetting' OR c.table_name = 'Giveaway' OR c.table_name = 'GiveawayEntry' OR c.table_name = 'GiveawayTicket' OR c.table_name = 'GiveawayReferral' OR c.table_name = 'WalletTx' OR c.table_name = 'ChannelMembership' OR c.table_name = 'CrossPromo') OR
        (c.table_name = 'Giveaway' AND c.column_name IN ('tasks','promoCode','losersRewardSwipes','photoFileId')) OR
        (c.table_name = 'GiveawayEntry' AND c.column_name IN ('ticketsCount','tasksDone')) OR
        (c.table_name = 'UserSource' OR c.table_name = 'Quest' OR c.table_name = 'QuestCompletion' OR c.table_name = 'ScheduledPost' OR c.table_name = 'PromoCode' OR c.table_name = 'PromoRedemption' OR c.table_name = 'PostHide' OR c.table_name = 'PostReport' OR c.table_name = 'CommentReport' OR c.table_name = 'DailyCheckin' OR c.table_name = 'QuestVerifyLog' OR c.table_name = 'BotChat' OR c.table_name = 'AiChatSession' OR c.table_name = 'XpLog' OR c.table_name = 'Sponsor' OR c.table_name = 'AdSlot' OR c.table_name = 'Blacklist') OR
        (c.table_name = 'Quest' AND c.column_name = 'targetType') OR
        (c.table_name = 'Comment' AND c.column_name IN ('hidden','adScore','reportsCount')) OR
        (c.table_name = 'Post' AND c.column_name IN ('reportsCount','promoteSpent')) OR
        (c.table_name = 'AiChatMessage' AND c.column_name = 'sessionId')
      )`)
    const tables = new Set<string>()
    const cols = new Set<string>()
    for (const r of rows) {
      tables.add(r.table_name)
      cols.add(`${r.table_name}.${r.column_name}`)
    }
    const missing = CRITICAL.filter(([t, c]) => (c ? !cols.has(`${t}.${c}`) : !tables.has(t))).map(([t, c]) =>
      c ? `${t}.${c}` : t,
    )
    const state: SchemaState = { ok: missing.length === 0, missing }
    checkCache = { state, exp: Date.now() + CHECK_TTL_MS }
    return state
  } catch (e) {
    console.error('[schema/check]', e)
    return { ok: false, missing: ['<check failed>'] }
  }
}

let ensuredOk = false
let lastEnsureAt = 0

/**
 * Применить все миграции (идемпотентно). Вызывается при старте сервера и
 * самолечением из /api/health. Возвращает состояние схемы после прогона.
 */
export async function ensureAppSchema(opts?: {
  force?: boolean
  /** instrumentation: быстрый путь «маркер актуален → 1 SELECT вместо 154 DDL» */
  verifyFirst?: boolean
}): Promise<{ ok: boolean; applied: number; missing: string[] }> {
  if (isSqlite()) return { ok: true, applied: 0, missing: [] }
  if (ensuredOk && !opts?.force) return { ok: true, applied: 0, missing: [] }
  // повторные вызовы не чаще раза в 30с — просто ре-проверяем
  if (!opts?.force && Date.now() - lastEnsureAt < 30_000) {
    const st = await checkSchema()
    return { ok: st.ok, applied: 0, missing: st.missing }
  }

  // v5.86: холодный старт. Маркер версии совпал с последней миграцией →
  // схема уже накатена (тем же прогоном, что записал маркер): один SELECT
  // вместо ~154 roundtrip'ов DDL. Расхождение/сбой проверки — честный прогон ниже.
  if (opts?.verifyFirst) {
    const latest = latestMigrationVersion()
    if (latest) {
      const stored = await readStoredSchemaVersion()
      if (stored === latest) {
        ensuredOk = true
        lastEnsureAt = Date.now()
        const st = await checkSchema()
        if (st.ok) return { ok: true, applied: 0, missing: [] }
      }
    }
  }

  lastEnsureAt = Date.now()
  let applied = 0
  for (const sql of ALL) {
    try {
      await db.$executeRawUnsafe(sql)
      applied++
    } catch (e) {
      console.error('[ensure-schema]', (e as Error).message)
    }
  }
  invalidateSchemaCheck() // ALTER'ы выполнены — кэш проверки больше не актуален
  const st = await checkSchema()
  ensuredOk = st.ok
  if (st.ok) {
    const latest = latestMigrationVersion()
    if (latest) await writeSchemaVersion(latest)
  }
  return { ok: st.ok, applied, missing: st.missing }
}

/** Именованная миграция из панели (v5.15 | v5.17 | v5.18). Возвращает число применённых шагов. */
export async function applyNamedMigration(version: string): Promise<number> {
  const stmts = MIGRATIONS[version]
  if (!stmts) throw new Error('unknown migration')
  let applied = 0
  for (const sql of stmts) {
    await db.$executeRawUnsafe(sql)
    applied++
  }
  ensuredOk = false // схема изменилась — кэш проверки сбрасываем
  invalidateSchemaCheck()
  return applied
}
