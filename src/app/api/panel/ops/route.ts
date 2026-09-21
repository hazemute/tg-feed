import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson } from '@/lib/server'
import { guardAdmin } from '@/lib/guard'
import { bumpCache } from '@/lib/redis'
import { clearPageCache } from '@/lib/page-cache'
import { clearFeedExtras } from '@/lib/feed-extras'
import { getChatCard } from '@/lib/tg-bot'
import { classifyChannelsBatch } from '@/lib/classify'
import { logAdmin } from '@/lib/admin-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/panel/ops — быстрые операции админа «в один клик».
 * Рождались из запросов поддержки: пользователь просит «скройте канал» /
 * «удалите пост» / жалуется на карточку — сотрудник жмёт кнопку, не лезя в БД.
 * Все операции честно инвалидируют кэши, чтобы эффект был мгновенным.
 */

const opsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hide_channel'), username: z.string().min(2).max(64) }),
  z.object({ action: z.literal('show_channel'), username: z.string().min(2).max(64) }),
  z.object({ action: z.literal('refresh_card'), username: z.string().min(2).max(64) }),
  z.object({ action: z.literal('reclassify'), username: z.string().min(2).max(64) }),
  z.object({ action: z.literal('delete_post'), target: z.string().min(3).max(200) }),
])

/** «t.me/foo/123», «@foo», «foo» → username без @ */
function cleanUsername(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .split(/[/?#\s]/)[0]
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase() // в БД username хранится в lowercase
}

/** «t.me/foo/12345» | «foo:12345» | «foo/12345» → tgKey «foo:12345» */
function toTgKey(raw: string): string | null {
  const s = raw.trim().replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '')
  const m = s.match(/^([A-Za-z0-9_]{3,64})[/:](\d{1,20})\/?$/)
  return m ? `${m[1]}:${m[2]}` : null
}

async function invalidateFeed(): Promise<void> {
  await bumpCache(['feed', 'tr', 'ch', 'ct', 'sr']).catch(() => {})
  clearPageCache()
  clearFeedExtras()
}

export async function POST(request: Request) {
  const g = guardAdmin(request, { limit: 60, windowMs: 60_000, bucket: 'panel-ops' })
  if (!g.ok) return g.res

  try {
    const parsed = opsSchema.safeParse(await readJson(request))
    if (!parsed.success) return err('invalid action')

    // Аудит: каждая успешная быстрая операция попадает в журнал
    const d = parsed.data as { action: string; username?: string; target?: string }
    const audit = async (message: string) =>
      logAdmin('ops', d.username ?? d.target ?? '-', { op: d.action, message })

    switch (parsed.data.action) {
      /* ---------- Скрыть/вернуть канал ---------- */
      case 'hide_channel':
      case 'show_channel': {
        const username = cleanUsername(parsed.data.username)
        const channel = await db.channel.findUnique({ where: { username }, select: { id: true, title: true } })
        if (!channel) return err(`канал @${username} не найден`, 404)
        await db.channel.update({
          where: { id: channel.id },
          data: { status: parsed.data.action === 'hide_channel' ? 'paused' : 'active' },
        })
        await invalidateFeed()
        await audit(`Канал «${channel.title}» скрыт из ленты и каталога`)
        return NextResponse.json({
          ok: true,
          message:
            parsed.data.action === 'hide_channel'
              ? `Канал «${channel.title}» скрыт из ленты и каталога`
              : `Канал «${channel.title}» снова в ленте`,
        })
      }

      /* ---------- Обновить карточку (аватар + подписчики) ---------- */
      case 'refresh_card': {
        const username = cleanUsername(parsed.data.username)
        const channel = await db.channel.findUnique({ where: { username }, select: { id: true } })
        if (!channel) return err(`канал @${username} не найден`, 404)
        const card = await getChatCard(username)
        if (card.rateLimited) return err('Bot API под флуд-баном — попробуйте позже', 429)
        if (!card.ok && !card.notFound) return err('Bot API недоступен', 502)
        if (card.notFound) return err('Канал не существует или приватен (данные не менялись)', 404)
        const now = new Date()
        await db.channel.update({
          where: { id: channel.id },
          data: {
            ...(card.photoFileId ? { photoFileId: card.photoFileId, avatarFetchedAt: now } : { avatarFetchedAt: now }),
            ...(card.members != null ? { membersCount: card.members, membersFetchedAt: now } : { membersFetchedAt: now }),
          },
        })
        await invalidateFeed()
        await audit('Карточка канала обновлена')
        return NextResponse.json({
          ok: true,
          message: `Карточка обновлена: ${card.members != null ? `${card.members} подписчиков` : 'подписчики недоступны'}, ${card.photoFileId ? 'аватар есть' : 'аватара нет'}`,
        })
      }

      /* ---------- Переклассифицировать канал (ИИ) ---------- */
      case 'reclassify': {
        const username = cleanUsername(parsed.data.username)
        const channel = await db.channel.findUnique({
          where: { username },
          select: {
            id: true,
            title: true,
            categoryId: true,
            posts: { orderBy: { publishedAt: 'desc' }, take: 3, select: { text: true } },
          },
        })
        if (!channel) return err(`канал @${username} не найден`, 404)
        const cats = await db.category.findMany({ select: { id: true, slug: true, title: true } })
        const map = await classifyChannelsBatch(
          [
            {
              id: channel.id,
              title: channel.title,
              username,
              description: null,
              sample: channel.posts.map((p) => p.text).join(' ').slice(0, 300),
            },
          ],
          cats,
        )
        const slug = map.get(channel.id)
        const target = cats.find((c) => c.slug === slug)
        if (!target) return err('ИИ не смог определить тему', 502)
        if (target.id === channel.categoryId) {
          return NextResponse.json({ ok: true, message: `ИИ подтверждает текущую тему: ${target.title}` })
        }
        await db.channel.update({ where: { id: channel.id }, data: { categoryId: target.id } })
        await invalidateFeed()
        await audit(`Тема канала изменена на «${target.title}»`)
        return NextResponse.json({ ok: true, message: `Тема канала изменена на «${target.title}»` })
      }

      /* ---------- Удалить пост по ссылке/ключу ---------- */
      case 'delete_post': {
        const key = toTgKey(parsed.data.target)
        if (!key) return err('не похоже на ссылку поста: нужен вид t.me/канал/12345', 400)
        const post = await db.post.findUnique({ where: { tgKey: key }, select: { id: true } })
        if (!post) return err(`пост ${key} в базе не найден`, 404)
        await db.post.delete({ where: { id: post.id } })
        await invalidateFeed()
        await audit(`Пост ${key} удалён из ленты`)
        return NextResponse.json({ ok: true, message: `Пост ${key} удалён из ленты` })
      }
    }
  } catch (e) {
    console.error('[panel/ops]', e)
    return err('ops failed', 500)
  }
}
