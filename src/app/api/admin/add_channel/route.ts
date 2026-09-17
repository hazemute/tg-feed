import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { err, readJson, normalizeChannelUsername, isValidChannelUsername } from '@/lib/server'
import { guardAuth } from '@/lib/guard'

export const dynamic = 'force-dynamic'

// userId из тела игнорируется — автор канала берётся из Bearer-сессии.
const bodySchema = z.object({
  username: z.string().max(200).catch(''),
})

/** Декодирование HTML-сущностей из og-метатегов Telegram */
function decodeOg(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * POST /api/admin/add_channel { username }
 * Вкладка «Для админов»: канал отправляется на модерацию.
 *
 * Защита от SSRF: username нормализуется и строго проверяется
 * (^[A-Za-z0-9_]{4,64}$) ДО любого fetch на t.me — в URL не может попасть
 * ничего, кроме букв/цифр/подчёркивания. Лимит 10 добавлений в минуту.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'adm-add' })
  if (!g.ok) return g.res
  const userId = g.uid

  try {
    const parsed = bodySchema.safeParse(await readJson(request))
    if (!parsed.success) return err('недопустимый username')
    const username = normalizeChannelUsername(parsed.data.username)

    // СТРОГАЯ проверка ДО fetch на t.me (SSRF: только [A-Za-z0-9_], 4–64 символа)
    if (!isValidChannelUsername(username)) {
      return err('недопустимый username')
    }

    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) return err('user not found', 404)

    const existing = await db.channel.findUnique({ where: { username } })
    if (existing) {
      return err(
        existing.status === 'moderation'
          ? 'Этот канал уже добавлен и ожидает модерации'
          : 'Этот канал уже в ленте Tg Swipe',
        409,
      )
    }

    const other =
      (await db.category.findUnique({ where: { slug: 'other' } })) ??
      (await db.category.findFirst({ orderBy: { order: 'asc' } }))
    if (!other) return err('no categories configured', 500)

    // Пытаемся подтянуть реальное название/описание с веб-превью Telegram,
    // иначе модератор увидит только @username
    let title = `@${username}`
    let description: string | null = null
    try {
      const res = await fetch(`https://t.me/${username}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const html = await res.text()
        const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)
        const ogDesc = html.match(/<meta property="og:description" content="([^"]+)"/)
        if (ogTitle?.[1]) title = decodeOg(ogTitle[1])
        if (ogDesc?.[1]) description = decodeOg(ogDesc[1]).slice(0, 300)
      }
    } catch {
      // без сети — оставляем @username
    }

    const channel = await db.channel.create({
      data: {
        tgId: `manual_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        title,
        description,
        username,
        categoryId: other.id,
        status: 'moderation',
        avatarColor: '#3390ec',
        addedById: userId,
      },
    })

    return NextResponse.json({
      ok: true,
      channel: { id: channel.id, username: channel.username, status: channel.status },
      message:
        'Канал отправлен на модерацию (обычно до 24 часов). Чтобы новые посты попадали в ленту автоматически, добавьте бота @tgfeed_bot администратором канала — права публиковать не нужны.',
    })
  } catch (e) {
    console.error('[admin/add_channel]', e)
    return err('failed', 500)
  }
}
