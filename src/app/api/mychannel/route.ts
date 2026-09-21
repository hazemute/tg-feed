import { NextResponse } from 'next/server'
import { channelAvatarUrl } from '@/lib/media'
import { z } from 'zod'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { isValidChannelUsername } from '@/lib/server'
import { ogAvatarOf, syncChannelAvatar } from '@/lib/avatar-store'
import { getChatPhotoFileId } from '@/lib/tg-bot'
import {
  PRO_PROMOTE_HOT_BOOST,
  PRO_PROMOTE_MONTHLY_LIMIT,
  PROMOTE_PACK,
  nextMonthStart,
  tierAtLeast,
  tierOfUser,
  utcMonthKey,
} from '@/lib/tiers'
import { sweepScheduledPostsThrottled } from '@/lib/scheduled-posts'
import { normalizeTeaserApplyTo } from '@/lib/teaser'

export const dynamic = 'force-dynamic'

/**
 * «Мой канал» — управление своим каналом в Tg Swipe.
 *
 * ПРИВЯЗКА (claim) без ручной модерации: пользователь публикует код-слово
 * постом в своём канале, мы проверяем его на веб-превью t.me/s — постить
 * в канал может только владелец, значит канал действительно его.
 * Код детерминированный (hash от id канала + секрета приложения) —
 * хранить его не нужно, и он одинаков при повторных проверках.
 *
 * ДЕЙСТВИЯ POST:
 *  - claimStart  {username}      → {code} — показать код-слово с инструкцией
 *  - claimVerify {username,code} → {ok} — проверка поста с кодом на t.me/s
 *  - settings    {channelId, teaserMode, teaserLimit, teaserApplyTo?, categorySlug?} — настройки
 *                 (v5.70: teaserApplyTo — каким постам применять тизер: all|long|text)
 *  - cta         {channelId, ctaLabel, ctaUrl} — CTA-кнопка в постах (Snap Pro)
 *  - promote     {channelId, postId} — протолкнуть пост в ленту (Snap Pro:
 *                 1 бесплатно в месяц, сверх — купленные кредиты пакета)
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claimStart'), username: z.string().trim().min(2).max(64) }),
  z.object({
    action: z.literal('claimVerify'),
    username: z.string().trim().min(2).max(64),
    code: z.string().trim().min(6).max(24),
  }),
  z.object({
    action: z.literal('settings'),
    channelId: z.string().min(1),
    teaserMode: z.enum(['none', 'cut', 'blur']),
    teaserLimit: z.number().int().min(60).max(600).optional(),
    // v5.70: гибкий показ в ленте — всем постам / только лонгридам / только текстовым без медиа
    teaserApplyTo: z.enum(['all', 'long', 'text']).optional(),
    categorySlug: z.string().trim().max(40).optional(),
  }),
  z.object({
    action: z.literal('cta'),
    channelId: z.string().min(1),
    ctaLabel: z.string().trim().min(2).max(30),
    ctaUrl: z.string().trim().url().max(300),
  }),
  z.object({
    action: z.literal('promote'),
    channelId: z.string().min(1),
    postId: z.string().min(1),
  }),
])

function normalizeUsername(raw: string): string {
  return raw
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase() // в БД username хранится в lowercase (Telegram-имена регистронезависимы)
}

/**
 * Ленивое лечение аватарки claimed-канала (v5.71).
 *
 * Канал, привязанный через «Мой канал», создаётся БЕЗ аватарки, а парсер
 * t.me/s такие каналы (особенно в статусе moderation) не обходит — аватар
 * не появлялся НИКОГДА (серые инициалы в «Мой канал», ленте, поиске —
 * баг «аватарки не отображаются»). Хилим: og:image из HTML t.me/s +
 * Bot API getChat (photoFileId, вечный) фолбэком. Троттлинг в памяти
 * 10 мин на канал, fire-and-forget — GET кабинета не ждёт сеть.
 */
const UA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
} as const
const avatarHealAt = new Map<string, number>()

async function healChannelAvatar(channelId: string, username: string): Promise<void> {
  const now = Date.now()
  if (now - (avatarHealAt.get(channelId) ?? 0) < 10 * 60_000) return
  avatarHealAt.set(channelId, now)
  try {
    const res = await fetch(`https://t.me/s/${username}`, {
      headers: UA_HEADERS,
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null)
    if (res?.ok) {
      const html = await res.text()
      await syncChannelAvatar(channelId, html).catch(() => {})
    }
    const fileId = await getChatPhotoFileId(username)
    if (fileId) {
      await db.channel
        .update({ where: { id: channelId }, data: { photoFileId: fileId, avatarFetchedAt: new Date() } })
        .catch(() => {})
    }
  } catch {
    // best-effort — в следующий GET попробуем снова (после троттлинга)
  }
}

/** Код-слово владения каналом: детерминированный, без хранения в БД */
function claimCodeFor(channelId: string): string {
  // v5.54: 'tgswipe'-фолбэк — только в dev; в проде константа позволяла
  // подобрать код владения чужого канала (перебор 16^6 всё равно проще, чем
  // надо, но зная секрет — мгновенно)
  const secret =
    process.env.AUTH_SECRET?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    (process.env.NODE_ENV === 'production' ? process.env.CRON_SECRET?.trim() || '' : 'tgswipe')
  const h = createHash('sha256')
    .update(`${channelId}:${secret}`)
    .digest('hex')
  return `swipe-${h.slice(0, 6)}`
}

/** GET — мои привязанные каналы со статистикой и кампаниями */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'mychannel' })
  if (!g.ok) return g.res

  try {
    // v5.64: владелец открыл кабинет — публикуем дозревшие отложенные посты (троттлинг 30с)
    sweepScheduledPostsThrottled()

    const since24h = new Date(Date.now() - 24 * 60 * 60_000)
    // egress (11-a): select вместо include — styleProfile и прочие тяжёлые
    // служебные колонки канала в кабинет не отдаются (форма ответа прежняя)
    //
    // СКОРОСТЬ (v5.69-perf): каналы, рекламный счёт, тариф и состояние
    // продвижения раньше шли ТРЕМЯ последовательными волнами
    // (channels → account → tier/promoState) — в проде это +3 RTT к каждому
    // открытию кабинета. Всё независимo → одна параллельная волна.
    const [channels, account, tier, promoState] = await Promise.all([
      db.channel.findMany({
        where: { claimedById: g.uid },
        select: {
          id: true,
          title: true,
          username: true,
          description: true,
          avatarColor: true,
          avatarUrl: true,
          photoFileId: true,
          membersCount: true,
          subscribersCount: true,
          status: true,
          teaserMode: true,
          teaserLimit: true,
          teaserApplyTo: true,
          ctaLabel: true,
          ctaUrl: true,
          styleAt: true,
          category: { select: { slug: true, title: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.advertiserAccount.findUnique({ where: { userId: g.uid } }),
      tierOfUser(g.uid),
      // Состояние продвижения: ключ месяца бесплатного слота + кредиты пакета
      db.user.findUnique({
        where: { id: g.uid },
        select: { promoteFreeMonth: true, promoteCredits: true },
      }),
    ])

    // v5.71: ленивая докачка аватарок — claimed-каналы исторически создавались
    // без avatarUrl/photoFileId (серые инициалы), а у легаси-каналов avatarUrl —
    // мёртвая ссылка Supabase (хост удалён, DTO рисует по ней null). Хилим в фоне.
    for (const c of channels) {
      const avatarDead =
        (!c.avatarUrl || c.avatarUrl.includes('.supabase.co/')) && !c.photoFileId
      if (avatarDead && c.username) {
        void healChannelAvatar(c.id, c.username)
      }
    }

    const result = await Promise.all(
      channels.map(async (c) => {
        const [posts, views24h, likes, bookmarks, lastPost, campaigns] = await Promise.all([
          db.post.count({ where: { channelId: c.id } }),
          // Инкогнито (Snap Plus/Pro): просмотры подписчиков с активным платным
          // тиром НЕ видны в детальной статистике админов — считаем только free
          // и истёкшие подписки (filter совпадает с lib/tiers effectiveTier)
          db.postView.count({
            where: {
              post: { channelId: c.id },
              createdAt: { gte: since24h },
              user: {
                OR: [{ tier: 'free' }, { tierUntil: { lte: new Date() } }],
              },
            },
          }),
          db.like.count({ where: { post: { channelId: c.id } } }),
          db.bookmark.count({ where: { post: { channelId: c.id } } }),
          db.post.findFirst({
            where: { channelId: c.id },
            orderBy: { publishedAt: 'desc' },
            select: { publishedAt: true },
          }),
          db.adCampaign.findMany({
            where: { ownerId: g.uid, channelId: c.id },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
        ])

        return {
          id: c.id,
          title: c.title,
          username: c.username,
          description: c.description,
          avatarColor: c.avatarColor,
          // v5.33: Storage-аватарка через /api/media (CDN-кэш, экономия egress Supabase)
          // v5.69: единый хелпер — вечный photoFileId (Bot API) приоритетнее сырой ссылки
          avatarUrl: channelAvatarUrl(c.avatarUrl, c.photoFileId, c.id),
          subscribersCount: c.membersCount ?? c.subscribersCount,
          status: c.status,
          categorySlug: c.category.slug,
          categoryTitle: c.category.title,
          teaserMode: c.teaserMode,
          teaserLimit: c.teaserLimit,
          // v5.70: гибкий тизер — нормализация на выдаче (неизвестное → all)
          teaserApplyTo: normalizeTeaserApplyTo(c.teaserApplyTo),
          ctaLabel: c.ctaLabel,
          ctaUrl: c.ctaUrl,
          styleAt: c.styleAt?.toISOString() ?? null,
          stats: {
            posts,
            views24h,
            likes,
            bookmarks,
            lastPostAt: lastPost?.publishedAt.toISOString() ?? null,
          },
          campaigns: campaigns.map((x) => ({
            id: x.id,
            title: x.title,
            body: x.body,
            ctaLabel: x.ctaLabel,
            link: x.link,
            imageUrl: x.imageUrl,
            costPerClickKop: x.costPerClickKop,
            budgetKop: x.budgetKop,
            spentKop: x.spentKop,
            impressions: x.impressions,
            clicks: x.clicks,
            rawClicks: x.rawClicks,
            status: x.status,
            note: x.note,
            createdAt: x.createdAt.toISOString(),
          })),
        }
      }),
    )

    // Продвижение (v5.69): 1 бесплатное продвижение в календарный месяц (UTC).
    // Использование — ключ месяца в User.promoteFreeMonth ('' / прошлый месяц →
    // слот свободен), кредиты пакета — в User.promoteCredits.
    // (v5.69-perf: account/tier/promoState читаются выше, одной волной с каналами)
    const monthKey = utcMonthKey()
    const monthlyUsed = promoState?.promoteFreeMonth === monthKey ? 1 : 0
    const promoteCredits = promoState?.promoteCredits ?? 0

    return NextResponse.json({
      channels: result,
      advertiser: {
        balanceKop: account?.balanceKop ?? 0,
        topupsTotalKop: account?.topupsTotalKop ?? 0,
        spentTotalKop: account?.spentTotalKop ?? 0,
      },
      tier,
      promotion: {
        used: monthlyUsed,
        limit: PRO_PROMOTE_MONTHLY_LIMIT,
        available: tierAtLeast(tier, 'pro'),
        credits: promoteCredits,
      },
      // v5.69: плоские поля для UI кабинета (остаток месяца, кредиты, цена пакета)
      promoteMonthlyUsed: monthlyUsed,
      promoteMonthlyLimit: PRO_PROMOTE_MONTHLY_LIMIT,
      promoteCredits,
      promotePackPrice: PROMOTE_PACK.priceKop,
      promotePackCount: PROMOTE_PACK.count,
      // Когда вернётся бесплатное продвижение (начало следующего месяца UTC)
      promoteResetAt: nextMonthStart().toISOString(),
    })
  } catch (e) {
    console.error('[mychannel:get]', e)
    return err('Ошибка', 500)
  }
}

/** POST — привязка канала и настройки показа */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 15, windowMs: 60_000, bucket: 'mychannel-post' })
  if (!g.ok) return g.res

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('Некорректные данные')
    const d = parsed.data

    if (d.action === 'claimStart') {
      const uname = normalizeUsername(d.username)
      if (!isValidChannelUsername(uname)) return err('Недопустимый username канала')

      // Канал должен существовать в базе: создаём черновик при первом claim
      let channel = await db.channel.findUnique({ where: { username: uname } })
      if (!channel) {
        // проверяем публичность через t.me/s (заодно получаем название)
        const res = await fetch(`https://t.me/s/${uname}`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(12_000),
        }).catch(() => null)
        if (!res || !res.ok) {
          return err('Канал не найден или недоступен — проверьте ссылку')
        }
        const html = await res.text()
        const title =
          html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ??
          uname
        // v5.71: аватарка СРАЗУ из og:image этого же HTML — до фикса канал
        // создавался без аватара и навсегда оставался с серыми инициалами
        const ogAvatar = ogAvatarOf(html)
        const fallback =
          (await db.category.findFirst({ orderBy: { order: 'asc' } })) ??
          (await db.category.create({ data: { slug: 'other', title: 'Другое', emoji: '', order: 99 } }))
        channel = await db.channel.create({
          data: {
            tgId: `claim_${uname}`,
            title,
            username: uname,
            avatarColor: '#3390ec',
            ...(ogAvatar ? { avatarUrl: ogAvatar, avatarFetchedAt: new Date() } : {}),
            categoryId: fallback.id,
            // v5.48: НЕ active — иначе новый канал попадает в каталог/ленту
            // до проверки владения (обход модерации). Активируем в claimVerify,
            // когда владелец докажет владение кодом-словом.
            status: 'moderation',
          },
        })
      }

      if (channel.claimedById && channel.claimedById !== g.uid) {
        return err('Этот канал уже привязан к другому аккаунту')
      }

      return NextResponse.json({
        ok: true,
        code: claimCodeFor(channel.id),
        title: channel.title,
        instructions:
          'Опубликуйте этот код отдельным постом в канале (можно сразу удалить после проверки). Код виден только администраторам канала.',
      })
    }

    if (d.action === 'claimVerify') {
      const uname = normalizeUsername(d.username)
      if (!isValidChannelUsername(uname)) return err('Недопустимый username канала')
      const channel = await db.channel.findUnique({ where: { username: uname } })
      if (!channel) return err('Сначала запросите код-слово')
      if (channel.claimedById && channel.claimedById !== g.uid) {
        return err('Канал уже привязан к другому аккаунту')
      }

      const expected = claimCodeFor(channel.id)
      if (d.code.trim().toLowerCase() !== expected) {
        return err('Код не совпадает — опубликуйте точный код из шага 1')
      }

      // Код совпал по форме — проверяем его публикацию в канале
      const res = await fetch(`https://t.me/s/${uname}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(12_000),
      }).catch(() => null)
      if (!res || !res.ok) return err('Не удалось прочитать канал, попробуйте ещё раз')
      const html = await res.text()
      if (!html.includes(expected)) {
        return err('Код не найден в последних постах канала — опубликуйте его и повторите')
      }

      await db.channel.update({
        where: { id: channel.id },
        // v5.48: владение доказано постом с кодом — канал активируется здесь
        // (и только здесь); вместе с правами владельца
        data: { claimedById: g.uid, claimedAt: new Date(), status: 'active' },
      })
      // v5.71: докачиваем вечную аватарку (photoFileId) в фоне — og:image
      // мог не найтись, а Bot API отдаёт файл, который не протухает
      void healChannelAvatar(channel.id, uname)
      return NextResponse.json({ ok: true, channelId: channel.id })
    }

    // settings
    const channel = await db.channel.findUnique({ where: { id: d.channelId } })
    if (!channel || channel.claimedById !== g.uid) return err('Канал не привязан к вам', 403)

    if (d.action === 'cta') {
      // CTA-кнопка — Snap Pro: текст + https-ссылка в раскрытом посте
      const tier = await tierOfUser(g.uid)
      if (!tierAtLeast(tier, 'pro')) {
        return NextResponse.json(
          { error: 'pro_required', message: 'CTA-кнопка доступна на тарифе Snap Pro' },
          { status: 402 },
        )
      }
      if (!/^https:\/\//i.test(d.ctaUrl)) return err('Ссылка должна начинаться с https://')
      await db.channel.update({
        where: { id: channel.id },
        data: { ctaLabel: d.ctaLabel, ctaUrl: d.ctaUrl },
      })
      return NextResponse.json({ ok: true })
    }

    if (d.action === 'promote') {
      // Протолкнуть пост в общую ленту: Snap Pro — 1 бесплатно в календарный
      // месяц (UTC), сверх лимита — купленные кредиты (User.promoteCredits).
      // Расход атомарен в одной транзакции: сначала бесплатный слот месяца
      // (условное владение ключом promoteFreeMonth), затем кредиты — параллельные
      // запросы не смогут списать дважды (updateMany с условием даёт count=0).
      const tier = await tierOfUser(g.uid)
      if (!tierAtLeast(tier, 'pro')) {
        return NextResponse.json(
          { error: 'pro_required', message: 'Продвижение доступно на тарифе Snap Pro' },
          { status: 402 },
        )
      }
      const post = await db.post.findFirst({
        where: { id: d.postId, channelId: channel.id },
        select: { id: true },
      })
      if (!post) return err('Пост не найден', 404)

      const monthKey = utcMonthKey()
      // Единая атомарная транзакция: расход (бесплатный слот → кредит) + сам
      // буст поста закоммичиваются вместе. Сбой на любом шаге откатывает всё —
      // не бывает «кредит списан, а пост не продвинут».
      const source = await db.$transaction(async (tx) => {
        // 1) Бесплатный слот месяца: NOT monthKey покрывает '' (никогда) и прошлые месяцы
        const claimed = await tx.user.updateMany({
          where: { id: g.uid, promoteFreeMonth: { not: monthKey } },
          data: { promoteFreeMonth: monthKey },
        })
        let spent: 'free' | 'credit'
        if (claimed.count === 1) {
          spent = 'free'
        } else {
          // 2) Слота нет — списываем купленный кредит (условный декремент ≥ 0)
          const dec = await tx.user.updateMany({
            where: { id: g.uid, promoteCredits: { gte: 1 } },
            data: { promoteCredits: { decrement: 1 } },
          })
          if (dec.count === 0) return null
          spent = 'credit'
        }
        await tx.post.update({
          where: { id: post.id },
          data: { promotedAt: new Date(), hotScore: { increment: PRO_PROMOTE_HOT_BOOST } },
        })
        return spent
      })
      if (!source) {
        return NextResponse.json(
          {
            error: 'promote_exhausted',
            message:
              'Бесплатное продвижение месяца уже использовано — купите пакет (5 продвижений за 199 ₽) или приходите в следующем месяце',
          },
          { status: 429 },
        )
      }

      const state = await db.user.findUnique({
        where: { id: g.uid },
        select: { promoteCredits: true, promoteFreeMonth: true },
      })
      return NextResponse.json({
        ok: true,
        source, // 'free' | 'credit'
        used: state?.promoteFreeMonth === monthKey ? 1 : 0,
        limit: PRO_PROMOTE_MONTHLY_LIMIT,
        credits: state?.promoteCredits ?? 0,
      })
    }

    const data: Record<string, unknown> = { teaserMode: d.teaserMode }
    if (d.teaserLimit != null) data.teaserLimit = d.teaserLimit
    if (d.teaserApplyTo != null) data.teaserApplyTo = d.teaserApplyTo
    if (d.categorySlug) {
      const cat = await db.category.findUnique({ where: { slug: d.categorySlug } })
      if (cat) data.categoryId = cat.id
    }
    await db.channel.update({ where: { id: channel.id }, data })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[mychannel:post]', e)
    return err('Ошибка', 500)
  }
}
