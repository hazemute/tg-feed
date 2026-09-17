import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { isValidChannelUsername } from '@/lib/server'

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
 *  - settings    {channelId, teaserMode, teaserLimit, categorySlug?} — настройки
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
    categorySlug: z.string().trim().max(40).optional(),
  }),
])

function normalizeUsername(raw: string): string {
  return raw
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//, '')
    .replace(/\/+$/, '')
    .trim()
}

/** Код-слово владения каналом: детерминированный, без хранения в БД */
function claimCodeFor(channelId: string): string {
  const h = createHash('sha256')
    .update(`${channelId}:${process.env.AUTH_SECRET ?? 'tgswipe'}`)
    .digest('hex')
  return `swipe-${h.slice(0, 6)}`
}

/** GET — мои привязанные каналы со статистикой и кампаниями */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'mychannel' })
  if (!g.ok) return g.res

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60_000)
    const channels = await db.channel.findMany({
      where: { claimedById: g.uid },
      include: { category: true },
      orderBy: { createdAt: 'asc' },
    })

    const result = await Promise.all(
      channels.map(async (c) => {
        const [posts, views24h, likes, bookmarks, lastPost, campaigns] = await Promise.all([
          db.post.count({ where: { channelId: c.id } }),
          db.postView.count({ where: { post: { channelId: c.id }, createdAt: { gte: since24h } } }),
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
          avatarUrl: c.photoFileId ? `/api/avatar/c_${c.id}` : null,
          subscribersCount: c.membersCount ?? c.subscribersCount,
          status: c.status,
          categorySlug: c.category.slug,
          categoryTitle: c.category.title,
          teaserMode: c.teaserMode,
          teaserLimit: c.teaserLimit,
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

    const account = await db.advertiserAccount.findUnique({ where: { userId: g.uid } })
    return NextResponse.json({
      channels: result,
      advertiser: {
        balanceKop: account?.balanceKop ?? 0,
        topupsTotalKop: account?.topupsTotalKop ?? 0,
        spentTotalKop: account?.spentTotalKop ?? 0,
      },
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
        const fallback =
          (await db.category.findFirst({ orderBy: { order: 'asc' } })) ??
          (await db.category.create({ data: { slug: 'other', title: 'Другое', emoji: '', order: 99 } }))
        channel = await db.channel.create({
          data: {
            tgId: `claim_${uname}`,
            title,
            username: uname,
            avatarColor: '#3390ec',
            categoryId: fallback.id,
            status: 'active',
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
        data: { claimedById: g.uid, claimedAt: new Date() },
      })
      return NextResponse.json({ ok: true, channelId: channel.id })
    }

    // settings
    const channel = await db.channel.findUnique({ where: { id: d.channelId } })
    if (!channel || channel.claimedById !== g.uid) return err('Канал не привязан к вам', 403)

    const data: Record<string, unknown> = { teaserMode: d.teaserMode }
    if (d.teaserLimit != null) data.teaserLimit = d.teaserLimit
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
