import { db } from '@/lib/db'
import { discoverSingleChannel, CATALOG } from '@/lib/autodiscover'
import { bumpCache } from '@/lib/redis'

/**
 * v5.77: КОНТЕНТ-КАТАЛОГ v2 — ПОЛНАЯ ПЕРЕЗАГРУЗКА КОНТЕНТА (приказ владельца).
 *
 * «В конце задачи удалить абсолютно все каналы и все посты, и сделать парсинг
 * автоматическим и ЕЩЁ умнее, чтобы парсились пока что только ИГРОВЫЕ КАНАЛЫ
 * и посты (русские)».
 *
 * Фазы (BotSetting 'content-catalog:state', шаг ≤ ~8с, троттлинг ≥90с):
 *  1. 'purge_user'   — пользовательские следы контента: Notification(type=comment),
 *                      HashtagClick (тренды пересчитаются).
 *  2. 'purge_posts'  — ПОСТЫ ВСЕ (Post.deleteMany) — каскадом снесутся лайки,
 *                      просмотры, закладки, скрытия, жалобы, комментарии
 *                      (+лайки/жалобы комментариев) — каскады в схеме.
 *  3. 'purge_channels' — КАНАЛЫ ВСЕ (Channel.deleteMany) + ScheduledPost
 *                      (каскад), UserSource («источники» юзеров).
 *  4. 'purge_meta'   — реестр CustomEmoji (наполнится заново backfill'ом),
 *                      сброс состояний парсера (parse:pointer) и content-catalog,
 *                      включение GAMES-ONLY автосбора (autodiscover:only_slug
 *                      = 'games'), инвалидация кэшей.
 *  5. 'discover'     — живое добавление игрового каталога (autodiscover.
 *                      discoverSingleChannel: проверка t.me/s + ≥100 подписчиков,
 *                      фиксированная категория games, сразу ~60 постов).
 *  6. 'done'         — состояние остаётся для аудита.
 *
 * Пользовательские данные НЕ трогаются: юзеры, кошельки, XP, розыгрыши,
 * промокоды, задания, AI-чаты/память, поддержка, payments.
 *
 * Вызовы: /api/health (через after()) и /api/parse/tick — троттлинг ≥90с.
 * SQLite-песочница пропускается (локальный QA не должен ходить в t.me).
 */

const FLAG_KEY = 'content-catalog:v2'
const STATE_KEY = 'content-catalog:state'
const THROTTLE_KEY = 'content-catalog:laststep'
const MIN_STEP_INTERVAL_MS = 90_000

/** Новые категории v5.76 (сохраняем: слаги/эмодзи уже могут быть в БД) */
const NEW_CATEGORIES = [
  { slug: 'games', title: 'Игры', emoji: '🎮', order: 1 },
  { slug: 'cinema', title: 'Кино', emoji: '🎬', order: 10 },
  { slug: 'anime', title: 'Аниме', emoji: '🌸', order: 11 },
  { slug: 'music', title: 'Музыка', emoji: '🎧', order: 12 },
]

/** Кураторский список v5.77: только игровые русские каналы (CATALOG = один games) */
const CURATED: Array<{ username: string; slug: string }> = CATALOG.flatMap((g) =>
  g.usernames.map((username) => ({ username, slug: g.slug })),
)

type CatalogState = {
  phase: 'purge_user' | 'purge_posts' | 'purge_channels' | 'purge_meta' | 'discover' | 'done'
  /** очередь кураторских username */
  queue: string[]
  /** username → число попыток (сетевые сбои даём второй шанс) */
  attempts: Record<string, number>
  done: Array<{ username: string; title: string; posts: number }>
  failed: Array<{ username: string; reason: string }>
  log: string[]
}

function log(s: CatalogState, msg: string) {
  s.log.push(`${new Date().toISOString().slice(5, 16).replace('T', ' ')} ${msg}`)
  if (s.log.length > 60) s.log.splice(0, s.log.length - 60)
}

async function loadState(): Promise<CatalogState | null> {
  const row = await db.botSetting.findUnique({ where: { key: STATE_KEY } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as CatalogState
  } catch {
    return null
  }
}

async function saveState(s: CatalogState): Promise<void> {
  await db.botSetting.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, value: JSON.stringify(s) },
    update: { value: JSON.stringify(s) },
  })
}

/**
 * Быстрая (без сети) подготовка: категории, флаг v2, начальное состояние,
 * включение GAMES-ONLY автосбора. Идемпотентно — вызывается из каждого health.
 */
export async function ensureContentCatalog(): Promise<{ started: boolean }> {
  // SQLite-песочница (локальный QA): миграция контента — только для прода
  if ((process.env.DATABASE_URL ?? '').startsWith('file:')) return { started: false }
  const flag = await db.botSetting.findUnique({ where: { key: FLAG_KEY } })
  if (flag) return { started: false }

  for (const c of NEW_CATEGORIES) {
    await db.category.upsert({
      where: { slug: c.slug },
      create: c,
      update: { title: c.title, emoji: c.emoji, order: c.order },
    })
  }
  // GAMES-ONLY автосбор: пока флаг активен — только игровые каналы
  await db.systemSetting.upsert({
    where: { key: 'autodiscover:only_slug' },
    create: { key: 'autodiscover:only_slug', value: 'games' },
    update: { value: 'games' },
  })
  await db.botSetting.upsert({
    where: { key: FLAG_KEY },
    create: { key: FLAG_KEY, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })
  const existing = await loadState()
  if (!existing || existing.phase === 'done' || existing.phase?.startsWith('purge') === false) {
    // существующий state v1 (news/cleanup/discover/done) несовместим — перезапускаем с purge
    const fresh: CatalogState = {
      phase: 'purge_user',
      queue: CURATED.map((c) => c.username),
      attempts: {},
      done: [],
      failed: [],
      log: [`миграция v2 (полная перезагрузка контента) инициализирована ${new Date().toISOString().slice(0, 16)}`],
    }
    await saveState(fresh)
  }
  console.log('[content-catalog] v2 запущена (purge → games discover)')
  return { started: true }
}

/**
 * Один шаг машины состояний (≤ ~8с). Возвращает краткий статус для логов.
 * Вызывать повторно (health/tick) до фазы 'done'.
 */
export async function stepContentCatalog(): Promise<string> {
  if ((process.env.DATABASE_URL ?? '').startsWith('file:')) return 'skip: sqlite'

  // троттлинг между шагами (cross-instance через BotSetting)
  const now = Date.now()
  const throttle = await db.botSetting.findUnique({ where: { key: THROTTLE_KEY } })
  const last = throttle ? Number(throttle.value) || 0 : 0
  if (now - last < MIN_STEP_INTERVAL_MS) return 'skip: throttle'
  await db.botSetting.upsert({
    where: { key: THROTTLE_KEY },
    create: { key: THROTTLE_KEY, value: String(now) },
    update: { value: String(now) },
  })

  const s = await loadState()
  if (!s || s.phase === 'done') return s ? 'done' : 'skip: no-state'

  try {
    /* ---------- 1. пользовательские следы контента ---------- */
    if (s.phase === 'purge_user') {
      const n1 = await db.notification.deleteMany({ where: { type: 'comment' } })
      const n2 = await db.hashtagClick.deleteMany({})
      log(s, `purge_user: −${n1.count} уведомлений(комменты), −${n2.count} хештег-кликов`)
      s.phase = 'purge_posts'
      await saveState(s)
      return `purge_user: -${n1.count + n2.count}`
    }

    /* ---------- 2. ПОСТЫ ВСЕ (каскад: лайки/вью/комменты/жалобы) ----------
        v5.77.2: TRUNCATE одной командой — батчи по 400 при троттлинге 90с
        чистили десятки тысяч постов часами. Юзерские данные не трогаем. */
    if (s.phase === 'purge_posts') {
      await db.$executeRawUnsafe(
        `TRUNCATE TABLE "Post", "Like", "PostView", "Bookmark", "PostHide", "PostReport",
          "Comment", "CommentLike", "CommentReport", "HashtagClick", "TranslationLog" CASCADE`,
      )
      s.phase = 'purge_channels'
      log(s, 'purge_posts: посты и взаимодействия удалены (TRUNCATE)')
      await saveState(s)
      return 'purge_posts: done'
    }

    /* ---------- 3. КАНАЛЫ ВСЕ + хвосты ----------
        v5.77.2: НЕ TRUNCATE — на Channel ссылается AdCampaign (ON DELETE SET NULL):
        CASCADE снёс бы рекламные кампании с деньгами. deleteMany делает честный
        DELETE + SET NULL: кампании сохраняются, привязка канала обнуляется.
        Post к этому моменту пуст (TRUNCATE выше) — удаление быстрое. */
    if (s.phase === 'purge_channels') {
      await db.subscription.deleteMany({})
      await db.channelMute.deleteMany({})
      await db.scheduledPost.deleteMany({})
      await db.userSource.deleteMany({})
      const n = await db.channel.deleteMany({})
      log(s, `purge_channels: −${n.count} каналов`)
      s.phase = 'purge_meta'
      await saveState(s)
      return `purge_channels: -${n.count}`
    }

    /* ---------- 4. мета: эмодзи-реестр, состояния парсера, кэши ---------- */
    if (s.phase === 'purge_meta') {
      const n = await db.customEmoji.deleteMany({})
      // сброс состояний: ротация парсера, старые флаги каталога/эмодзи
      const resetKeys = ['parse:pointer', 'emoji_backfill_at', 'content-catalog:v1', 'content-catalog:laststep']
      for (const key of resetKeys) {
        await db.botSetting.deleteMany({ where: { key } })
        await db.systemSetting.deleteMany({ where: { key } }).catch(() => {})
      }
      await bumpCache(['feed', 'tr', 'ct', 'ch', 'sr']).catch(() => undefined)
      log(s, `purge_meta: −${n.count} custom-эмодзи, состояния сброшены, GAMES-ONLY включён`)
      s.phase = 'discover'
      await saveState(s)
      return `purge_meta: -${n.count}`
    }

    /* ---------- 5. наполнение: только игровые русские каналы ---------- */
    if (s.phase === 'discover') {
      // 4 канала за шаг (каждый: t.me/s fetch + Bot API + ~60 постов в БД)
      const batch = s.queue.slice(0, 4)
      if (batch.length === 0) {
        s.phase = 'done'
        log(s, `каталог готов: добавлено ${s.done.length}, отклонено ${s.failed.length}`)
        await saveState(s)
        await bumpCache(['feed', 'ch', 'tr', 'ct', 'sr']).catch(() => undefined)
        return 'discover: done'
      }
      const slugs = new Map(CATALOG.flatMap((g) => g.usernames.map((u) => [u, g.slug] as const)))
      for (const username of batch) {
        const slug = slugs.get(username) ?? 'games'
        try {
          const res = await discoverSingleChannel(username, slug)
          if (res.ok) {
            s.done.push({ username, title: res.title, posts: res.posts })
            log(s, `+ ${username} «${res.title}» — ${res.posts} постов`)
          } else {
            const tries = (s.attempts[username] ?? 0) + 1
            s.attempts[username] = tries
            const retryable = /таймаут|недоступен/.test(res.reason)
            if (retryable && tries < 2) {
              s.queue.push(username) // второй шанс в конце очереди
              log(s, `~ ${username}: ${res.reason} — повтор позже`)
            } else {
              s.failed.push({ username, reason: res.reason })
              log(s, `− ${username}: ${res.reason}`)
            }
          }
        } catch (e) {
          s.failed.push({ username, reason: e instanceof Error ? e.message.slice(0, 80) : 'error' })
          log(s, `− ${username}: исключение`)
        }
        s.queue = s.queue.filter((u) => u !== username)
      }
      await saveState(s)
      await bumpCache(['feed', 'ch', 'tr', 'ct', 'sr']).catch(() => undefined)
      return `discover: +${s.done.length} queued ${s.queue.length}`
    }
  } catch (e) {
    console.error('[content-catalog] шаг упал (повтор по троттлингу)', e)
    return 'error'
  }

  return 'skip'
}
