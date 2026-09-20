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
}

const ALL: string[] = Object.values(MIGRATIONS).flat()

function isSqlite(): boolean {
  return (process.env.DATABASE_URL ?? '').startsWith('file:')
}

/** Критичные объекты схемы: [таблица, колонка] (колонка null → проверяется сама таблица) */
const CRITICAL: Array<[string, string | null]> = [
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
]

export type SchemaState = { ok: boolean; missing: string[] }

/** Проверка критичных объектов схемы (Postgres; в SQLite-песочнице всегда ok) */
export async function checkSchema(): Promise<SchemaState> {
  if (isSqlite()) return { ok: true, missing: [] }
  try {
    type Row = { table_name: string; column_name: string }
    const rows = await db.$queryRawUnsafe<Row[]>(`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND (
        c.table_name = 'AiSearchLog' OR c.table_name = 'AdminLog' OR
        (c.table_name = 'User' AND c.column_name IN ('tier','tierUntil','badges','profilePalette','profileBg','profileFrame')) OR
        (c.table_name = 'Channel' AND c.column_name IN ('ctaLabel','ctaUrl','styleProfile','styleAt')) OR
        (c.table_name = 'Post' AND c.column_name IN ('promotedAt','hotScore','aiFlag')) OR
        (c.table_name = 'PendingPayment' AND c.column_name = 'purpose') OR
        (c.table_name = 'Notification' AND c.column_name = 'commentId') OR
        (c.table_name = 'BotEmoji' OR c.table_name = 'BotSetting' OR c.table_name = 'Giveaway' OR c.table_name = 'GiveawayEntry' OR c.table_name = 'GiveawayTicket' OR c.table_name = 'GiveawayReferral') OR
        (c.table_name = 'Giveaway' AND c.column_name IN ('tasks','promoCode','losersRewardSwipes','photoFileId')) OR
        (c.table_name = 'GiveawayEntry' AND c.column_name IN ('ticketsCount','tasksDone'))
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
    return { ok: missing.length === 0, missing }
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
export async function ensureAppSchema(opts?: { force?: boolean }): Promise<{ ok: boolean; applied: number; missing: string[] }> {
  if (isSqlite()) return { ok: true, applied: 0, missing: [] }
  if (ensuredOk && !opts?.force) return { ok: true, applied: 0, missing: [] }
  // повторные вызовы не чаще раза в 30с — просто ре-проверяем
  if (!opts?.force && Date.now() - lastEnsureAt < 30_000) {
    const st = await checkSchema()
    return { ok: st.ok, applied: 0, missing: st.missing }
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
  const st = await checkSchema()
  ensuredOk = st.ok
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
  return applied
}
