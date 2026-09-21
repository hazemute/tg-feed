import { db } from '@/lib/db'
import { discoverSingleChannel, CATALOG } from '@/lib/autodiscover'
import { bumpCache } from '@/lib/redis'

/**
 * v5.76: КОНТЕНТ-КАТАЛОГ ПОДРОСТКОВОЙ ЛЕНТЫ (одноразовая миграция + очередь).
 *
 * Проблема: автосбор (v5.x) набрал в ленту 16 полит-новостных агентств против
 * пары развлекательных каналов — а первая аудитория приложения подростки.
 *
 * Решение (фазы в BotSetting 'content-catalog:state', шаг ≤ ~20с):
 *  1. 'news'    — новостные каналы (категория news, кроме mash/breakingmash/
 *                 baza — «срочное», которое читают все) → status 'moderation'
 *                 (вне ленты/каталога/парсера).
 *  2. 'cleanup' — удаление постов отключённых новостных каналов (партиями,
 *                 чтобы не убить функцию таймаутом).
 *  3. 'discover'— живое добавление кураторских каналов (autodiscover.
 *                 discoverSingleChannel: проверка t.me/s + ≥100 подписчиков,
 *                 фиксированная категория, сразу ~25 постов). Мёртвые
 *                 юзернеймы просто отбрасываются — каталог остаётся чистым.
 *  4. 'done'    — всё; состояние остаётся для аудита.
 *
 * Вызовы: /api/health (через after(), без блокировки ответа) и
 * /api/parse/tick — троттлинг ≥90с между шагами (BotSetting), SQLite-песочница
 * пропускается (локальный QA не должен ходить в t.me).
 */

const FLAG_KEY = 'content-catalog:v1'
const STATE_KEY = 'content-catalog:state'
const THROTTLE_KEY = 'content-catalog:laststep'
const MIN_STEP_INTERVAL_MS = 90_000

/** Новые подростковые категории (порядок — как в seed: games раньше news) */
const NEW_CATEGORIES = [
  { slug: 'games', title: 'Игры', emoji: '🎮', order: 1 },
  { slug: 'cinema', title: 'Кино', emoji: '🎬', order: 10 },
  { slug: 'anime', title: 'Аниме', emoji: '🌸', order: 11 },
  { slug: 'music', title: 'Музыка', emoji: '🎧', order: 12 },
]

/** Новостные каналы, которые ОСТАВЛЯЕМ (инциденты/срочное, не политика) */
const KEEP_NEWS = new Set(['mash', 'breakingmash', 'baza'])

/** Кураторский список без повторов: slug → usernames (из autodiscover.CATALOG) */
const CURATED: Array<{ username: string; slug: string }> = CATALOG.flatMap((g) =>
  g.usernames.map((username) => ({ username, slug: g.slug })),
)

type CatalogState = {
  phase: 'news' | 'cleanup' | 'discover' | 'done'
  /** id отключённых новостных каналов — для очистки постов */
  cleanupIds: string[]
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
  if (s.log.length > 40) s.log.splice(0, s.log.length - 40)
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
 * Быстрая (без сети) подготовка: создать недостающие категории, выставить
 * флаг и начальное состояние. Идемпотентно — вызывается из каждого health.
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
  await db.botSetting.upsert({
    where: { key: FLAG_KEY },
    create: { key: FLAG_KEY, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })
  const existing = await loadState()
  if (!existing) {
    const fresh: CatalogState = {
      phase: 'news',
      cleanupIds: [],
      queue: CURATED.map((c) => c.username),
      attempts: {},
      done: [],
      failed: [],
      log: ['миграция v5.76 инициализирована'],
    }
    await saveState(fresh)
  }
  console.log('[content-catalog] миграция запущена (фазы: news → cleanup → discover)')
  return { started: true }
}

/**
 * Один шаг машины состояний (≤ ~20с). Возвращает краткий статус для логов.
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
    if (s.phase === 'news') {
      const newsChannels = await db.channel.findMany({
        where: { status: 'active', category: { slug: 'news' } },
        select: { id: true, username: true },
      })
      const toDisable = newsChannels.filter((c) => !KEEP_NEWS.has(c.username.toLowerCase()))
      if (toDisable.length > 0) {
        await db.channel.updateMany({
          where: { id: { in: toDisable.map((c) => c.id) } },
          data: { status: 'moderation' },
        })
        s.cleanupIds = toDisable.map((c) => c.id)
        log(s, `отключено новостных каналов: ${toDisable.length} (оставлены: ${newsChannels.filter((c) => KEEP_NEWS.has(c.username.toLowerCase())).length})`)
      } else {
        log(s, 'новостных каналов к отключению нет')
      }
      s.phase = 'cleanup'
      await saveState(s)
      return `news: disabled ${s.cleanupIds.length}`
    }

    if (s.phase === 'cleanup') {
      // партиями по 200 постов, бюджет 6с — не ломаем функцию таймаутом
      const startedAt = Date.now()
      let removed = 0
      while (s.cleanupIds.length > 0 && Date.now() - startedAt < 6000) {
        const batch = await db.post.findMany({
          where: { channelId: { in: s.cleanupIds } },
          select: { id: true },
          take: 200,
        })
        if (batch.length === 0) break
        await db.post.deleteMany({ where: { id: { in: batch.map((p) => p.id) } } })
        removed += batch.length
      }
      if (removed === 0) {
        s.cleanupIds = []
        s.phase = 'discover'
        log(s, 'посты новостных каналов удалены')
        await bumpCache(['feed', 'ch', 'tr', 'ct']).catch(() => undefined)
      } else {
        log(s, `cleanup: −${removed} постов, осталось каналов ${s.cleanupIds.length}`)
      }
      await saveState(s)
      return `cleanup: -${removed}`
    }

    if (s.phase === 'discover') {
      // 3 канала за шаг (каждый: t.me/s fetch + Bot API + ~25 постов в БД)
      const batch = s.queue.slice(0, 3)
      if (batch.length === 0) {
        s.phase = 'done'
        log(s, `каталог готов: добавлено ${s.done.length}, отклонено ${s.failed.length}`)
        await saveState(s)
        return 'discover: done'
      }
      const slugs = new Map(CATALOG.flatMap((g) => g.usernames.map((u) => [u, g.slug] as const)))
      for (const username of batch) {
        const slug = slugs.get(username) ?? 'other'
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
