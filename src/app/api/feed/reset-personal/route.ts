import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { invalidatePersonalSignals } from '@/lib/feed'
import { clearUserPages } from '@/lib/page-cache'

export const dynamic = 'force-dynamic'

/**
 * v6.2.0: ПОЛНЫЙ СБРОС ЛИЧНЫХ СКРЫТИЙ ЛЕНТЫ — однотаповое самолечение
 * «в ленте 0 из 0, хотя у всех всё есть».
 *
 * Жалоба владельца: пользователь, который в прошлом скрывал посты/каналы
 * («Не интересно», мьют, скрытая подписка), мог сам себя замьютить до
 * пустой ленты — и не было НИ ОДНОЙ кнопки, которая это чинит (локальный
 * «Сбросить фильтры» не трогает серверные скрытия).
 *
 * POST /api/feed/reset-personal — снимает РАЗОМ:
 *  • PostHide (скрытые «не интересно» посты);
 *  • ChannelMute (замьютнутые каналы);
 *  • Subscription.hidden (скрытые каналы подписок);
 *  • инвалидирует персональные сигналы и L0-кэш страниц.
 * Пользовательские лайки/подписки/закладки НЕ трогаются.
 */
export async function POST(request: Request) {
  const g = guardAuth(request, { limit: 10, windowMs: 60_000, bucket: 'feed-reset' })
  if (!g.ok) return g.res
  if (g.guest) return NextResponse.json({ error: 'login required', auth: true }, { status: 401 })

  try {
    const [hiddenPosts, mutes, hiddenSubs] = await Promise.all([
      db.postHide.deleteMany({ where: { userId: g.uid } }),
      db.channelMute.deleteMany({ where: { userId: g.uid } }),
      db.subscription.updateMany({ where: { userId: g.uid, hidden: true }, data: { hidden: false } }),
    ])
    invalidatePersonalSignals(g.uid)
    clearUserPages(g.uid)
    return NextResponse.json({
      ok: true,
      hiddenPosts: hiddenPosts.count,
      mutedChannels: mutes.count,
      hiddenSubscriptions: hiddenSubs.count,
    })
  } catch (e) {
    console.error('[feed/reset-personal]', e)
    return err('failed', 500)
  }
}
