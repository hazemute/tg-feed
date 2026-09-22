import { db } from '@/lib/db'
import { botSendRich } from '@/lib/tg-emoji'
import { escapeHtml } from '@/lib/tg-bot'
import { dayKeyUtc } from '@/lib/reading'

/**
 * v5.93 — КРОН УДЕРЖАНИЯ: реактивационный пуш + недельный дайджест.
 *
 * Вызывается из /api/parse/tick (крутит каждую минуту) — обе задачи
 * спроектированы порциями, чтобы тик не тяжелел:
 *
 *  1) РЕАКТИВАЦИЯ. Юзер не читал 3–30 дней (ReadingStreak.lastDate) →
 *     раз в 72 часа бот присылает ОДИН самый залайканный пост последних
 *     10 дней из его ПОДПИСОК. Никакого спама: маркер retention_push:<uid>
 *     страхует частоту, mail_optout:<uid> — добровольный отказ (кнопка
 *     «Не писать мне» в самом сообщении, обработка в webhook).
 *     Порция ≤15 кандидатов и ≤5 отправок за тик.
 *
 *  2) ДАЙДЖЕСТ (только понедельник MSK). Топ-5 постов недели из подписок
 *     + один канал-рекомендация из «своей» категории. Курсор по userId —
 *     обрабатываем 40 юзеров за тик до конца недели; маркер
 *     digest:<uid>:<weekKey> делает отправку строго раз в неделю.
 *
 *  Всё fire-and-forget по духу lb-payouts: ошибки — в лог, тик не роняем.
 */

const TME_APP_URL =
  process.env.NEXT_PUBLIC_TME_APP_URL?.trim() || 'https://t.me/tgswipe_bot/tgswipe'

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

/** Реактивация: окно неактивности (дней) и минимальный интервал между пушами */
const REACT_MIN_DAYS = 3
const REACT_MAX_DAYS = 30
const REACT_INTERVAL_MS = 72 * 3_600_000
const REACT_SCAN = 15
const REACT_SENDS_PER_TICK = 5

/** Дайджест: сколько юзеров за тик */
const DIGEST_BATCH = 40

function mskDayKey(now: Date): string {
  return dayKeyUtc(new Date(now.getTime() + MSK_OFFSET_MS))
}

function dayStringShifted(days: number, now: Date): string {
  return dayKeyUtc(new Date(now.getTime() - days * 24 * 3_600_000))
}

async function getSetting(key: string): Promise<string | null> {
  const row = await db.botSetting.findUnique({ where: { key } }).catch(() => null)
  return row?.value ?? null
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.botSetting
    .upsert({ where: { key }, create: { key, value }, update: { value } })
    .catch(() => {})
}

/** Стриппер markdown-lite (жирный/курсив/код/ссылки) — для сниппетов в HTML-письме */
function snippetOf(text: string, max = 90): string {
  const plain = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\|\|(.+?)\|\|/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max).trimEnd()}…` : plain
}

/* ------------------------------ Реактивация ------------------------------ */

type ReactivationResult = { scanned: number; sent: number }

async function runReactivation(now: Date): Promise<ReactivationResult> {
  const from = dayStringShifted(REACT_MAX_DAYS, now)
  const to = dayStringShifted(REACT_MIN_DAYS, now)

  const candidates = await db.readingStreak
    .findMany({
      where: { lastDate: { gte: from, lte: to } },
      orderBy: { lastDate: 'asc' },
      take: REACT_SCAN,
      select: { userId: true, streak: true, freezes: true },
    })
    .catch(() => [])
  if (candidates.length === 0) return { scanned: 0, sent: 0 }

  const ids = candidates.map((c) => c.userId)
  const users = await db.user
    .findMany({
      where: { id: { in: ids }, isGuest: false, bannedAt: null },
      select: { id: true },
    })
    .catch(() => [])
  const valid = new Set(users.map((u) => u.id))

  let sent = 0
  let scanned = 0
  for (const c of candidates) {
    if (sent >= REACT_SENDS_PER_TICK) break
    if (!valid.has(c.userId)) continue
    scanned += 1

    // Отказ от рассылок и частота 1/72ч
    const [optout, lastPush] = await Promise.all([
      getSetting(`mail_optout:${c.userId}`),
      getSetting(`retention_push:${c.userId}`),
    ])
    if (optout) continue
    const lastTs = lastPush ? Date.parse(lastPush) : 0
    if (Number.isFinite(lastTs) && now.getTime() - lastTs < REACT_INTERVAL_MS) continue

    // Каналы подписок (верхние 50 — достаточно для выбора лучшего поста)
    const subs = await db.subscription
      .findMany({ where: { userId: c.userId }, select: { channelId: true }, take: 50 })
      .catch(() => [])
    if (subs.length === 0) continue

    const post = await db.post
      .findFirst({
        where: {
          channelId: { in: subs.map((s) => s.channelId) },
          publishedAt: { gte: new Date(now.getTime() - 10 * 24 * 3_600_000) },
          aiFlag: { notIn: ['junk', 'nsfw'] },
        },
        orderBy: [{ likesCount: 'desc' }, { viewsCount: 'desc' }],
        select: { id: true, text: true, channel: { select: { title: true } } },
      })
      .catch(() => null)
    if (!post) continue

    const chatId = Number(c.userId.slice('tg_'.length))
    if (!Number.isInteger(chatId) || chatId <= 0) continue

    const deepLink = `${TME_APP_URL}?startapp=${encodeURIComponent(`n_${post.id}`)}`
    const streakLine =
      c.streak > 0
        ? `\n\n🔥 Ваш стрик чтения: ${c.streak} дн.${c.freezes > 0 ? ` · ❄️ заморозок: ${c.freezes}` : ''}`
        : ''
    const html =
      `🔥 <b>Ваши каналы скучают</b>\n\n` +
      `Пока вас не было, в ваших подписках появился пост, который читателям особенно зашёл:\n\n` +
      `<b>${escapeHtml(post.channel.title)}</b>\n${escapeHtml(snippetOf(post.text))}\n` +
      `${streakLine}\n\n🔗 <a href="${deepLink}">Открыть и прочитать</a>`

    const r = await botSendRich(chatId, html, {
      skipPremiumWrap: true,
      keyboard: [
        [{ label: 'Читать пост 📖', url: deepLink, style: 'primary' as const }],
        [{ label: '🔕 Не писать мне', callback_data: 'mail:off' }],
      ],
    }).catch(() => ({ ok: false } as const))

    if (r.ok) {
      await setSetting(`retention_push:${c.userId}`, now.toISOString())
      sent += 1
    }
  }
  return { scanned, sent }
}

/* -------------------------------- Дайджест -------------------------------- */

type DigestResult = { processed: number; sent: number; done: boolean }

async function runDigest(now: Date): Promise<DigestResult> {
  const shifted = new Date(now.getTime() + MSK_OFFSET_MS)
  if (shifted.getUTCDay() !== 1) return { processed: 0, sent: 0, done: true } // только понедельник MSK

  const weekKey = `digest-week:${shifted.toISOString().slice(0, 10)}` // сама ISO-неделя ключом дня старта
  if (await getSetting(`retention_digest_done:${weekKey}`)) return { processed: 0, sent: 0, done: true }

  const cursor = (await getSetting(`retention_digest_cursor:${weekKey}`)) ?? ''
  const batch = await db.subscription
    .groupBy({
      by: ['userId'],
      where: { userId: { gt: cursor, startsWith: 'tg_' } },
      _count: { channelId: true },
      orderBy: { userId: 'asc' },
      take: DIGEST_BATCH,
    })
    .catch(() => [])

  if (batch.length === 0) {
    await setSetting(`retention_digest_done:${weekKey}`, now.toISOString())
    return { processed: 0, sent: 0, done: true }
  }

  let sent = 0
  for (const b of batch) {
    const uid = b.userId

    if (await getSetting(`mail_optout:${uid}`)) continue
    if (await getSetting(`digest:${uid}:${weekKey}`)) continue

    const subs = await db.subscription
      .findMany({ where: { userId: uid }, select: { channelId: true } })
      .catch(() => [])
    if (subs.length === 0) {
      await setSetting(`digest:${uid}:${weekKey}`, now.toISOString())
      continue
    }
    const channelIds = subs.map((s) => s.channelId)

    // Топ-5 постов недели из подписок (лайки → просмотры как тай-брейк)
    const posts = await db.post
      .findMany({
        where: {
          channelId: { in: channelIds },
          publishedAt: { gte: new Date(now.getTime() - 7 * 24 * 3_600_000) },
          aiFlag: { notIn: ['junk', 'nsfw'] },
        },
        orderBy: [{ likesCount: 'desc' }, { viewsCount: 'desc' }],
        take: 5,
        select: { id: true, text: true, link: true, channel: { select: { title: true } } },
      })
      .catch(() => [])
    if (posts.length === 0) {
      await setSetting(`digest:${uid}:${weekKey}`, now.toISOString())
      continue
    }

    // Рекомендация: категория, где у юзера больше всего подписок → живой канал,
    // которого нет в подписках, крупнейший по подписчикам
    const subChannels = await db.channel
      .findMany({ where: { id: { in: channelIds } }, select: { categoryId: true } })
      .catch(() => [])
    const catCount = new Map<string, number>()
    for (const ch of subChannels) catCount.set(ch.categoryId, (catCount.get(ch.categoryId) ?? 0) + 1)
    const topCat = [...catCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const rec = topCat
      ? await db.channel
          .findFirst({
            where: {
              categoryId: topCat,
              status: 'active',
              id: { notIn: channelIds },
              username: { not: '' },
            },
            orderBy: { subscribersCount: 'desc' },
            select: { title: true, username: true, subscribersCount: true },
          })
          .catch(() => null)
      : null

    const lines = posts
      .map((p) => {
        const href = p.link || deepLinkOfPost(p.id)
        return `• <a href="${href}"><b>${escapeHtml(p.channel.title)}</b>: ${escapeHtml(snippetOf(p.text, 70))}</a>`
      })
      .join('\n')
    const recLine = rec
      ? `\n\n🧲 <b>Канал недели: ${escapeHtml(rec.title)}</b> — ${rec.subscribersCount.toLocaleString('ru-RU')} подписчиков\n@${escapeHtml(rec.username)}`
      : ''
    const html =
      `📬 <b>Лучшее для вас за неделю</b>\n\n${lines}${recLine}\n\n🔗 <a href="${TME_APP_URL}">Открыть Tg Swipe</a>`

    const chatId = Number(uid.slice('tg_'.length))
    if (!Number.isInteger(chatId) || chatId <= 0) continue
    const r = await botSendRich(chatId, html, {
      skipPremiumWrap: true,
      keyboard: [
        [{ label: 'Открыть Tg Swipe 🚀', url: TME_APP_URL, style: 'primary' as const }],
        [{ label: '🔕 Не писать мне', callback_data: 'mail:off' }],
      ],
    }).catch(() => ({ ok: false } as const))

    if (r.ok) {
      await setSetting(`digest:${uid}:${weekKey}`, now.toISOString())
      sent += 1
    }
  }

  // Продвигаем курсор даже при неудачных отправках (следующая неделя повторит)
  await setSetting(`retention_digest_cursor:${weekKey}`, batch[batch.length - 1].userId)
  const done = batch.length < DIGEST_BATCH
  if (done) await setSetting(`retention_digest_done:${weekKey}`, now.toISOString())
  return { processed: batch.length, sent, done }
}

function deepLinkOfPost(postId: string): string {
  return `${TME_APP_URL}?startapp=${encodeURIComponent(`n_${postId}`)}`
}

/* --------------------------------- Публичное -------------------------------- */

export type RetentionCronResult = {
  reactivation: ReactivationResult
  digest: DigestResult
}

/**
 * Запуск из тика. Порции маленькие, каждая отправка и курсор защищены
 * маркерами — повторный вызов через минуту продолжает, а не дублирует.
 */
export async function runRetentionCron(now = new Date()): Promise<RetentionCronResult> {
  const reactivation = await runReactivation(now).catch((e) => {
    console.error('[retention] reactivation', e)
    return { scanned: 0, sent: 0 } as ReactivationResult
  })
  const digest = await runDigest(now).catch((e) => {
    console.error('[retention] digest', e)
    return { processed: 0, sent: 0, done: true } as DigestResult
  })
  if (reactivation.sent > 0 || digest.sent > 0) {
    console.log(`[retention] reactivation +${reactivation.sent}, digest +${digest.sent}`)
  }
  return { reactivation, digest }
}

/** Проверка отказа от рассылок (для будущих экранов настроек) */
export async function mailOptedOut(userId: string): Promise<boolean> {
  return Boolean(await getSetting(`mail_optout:${userId}`))
}

/** Установить/снять отказ (webhook «mail:off») */
export async function setMailOptout(userId: string, off: boolean): Promise<void> {
  if (off) await setSetting(`mail_optout:${userId}`, new Date().toISOString())
  else await db.botSetting.deleteMany({ where: { key: `mail_optout:${userId}` } }).catch(() => {})
}
