import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { err } from '@/lib/server'
import { guardAuth } from '@/lib/guard'
import { isValidChannelUsername } from '@/lib/server'
import { getBotChatRights } from '@/lib/tg-bot'
import { popPendingClaim, completeChannelClaim, normalizeChannelUsername } from '@/lib/channel-claim'

export const dynamic = 'force-dynamic'

/**
 * v5.80 — СТАТУС ПРИВЯЗКИ КАНАЛА (опрос из UI «Мой канал», шаг «добавьте бота»).
 *
 * GET /api/mychannel/claim-status?username=<uname>
 *
 * UI поллит раз в 5с, пока пользователь добавляет бота. Помимо чтения факта
 * привязки роут САМОПРОВЕРЯЕТ права бота (getBotChatRights fresh) — это
 * покрывает случай, когда бот был добавлен админом ДО заявки и апдейт
 * my_chat_member не придёт никогда. Вебхук завершает привязку мгновенно,
 * этот роут — страховка и путь для «бот уже был админом».
 *
 * Ответ: { claimed: boolean, botAdmin?: boolean, taken?: boolean, checkFailed?: boolean }
 * checkFailed=true — Bot API недоступен (флуд-бан/сеть): прав бота мы НЕ знаем,
 * клиент показывает «проверка не удалась», а не «бот не админ».
 */
export async function GET(request: Request) {
  const g = guardAuth(request, { limit: 60, windowMs: 60_000, bucket: 'mychannel' })
  if (!g.ok) return g.res

  const url = new URL(request.url)
  const uname = normalizeChannelUsername(url.searchParams.get('username') ?? '')
  if (!uname || !isValidChannelUsername(uname)) return err('Некорректный username')

  try {
    const channel = await db.channel.findUnique({
      where: { username: uname },
      select: { id: true, claimedById: true, title: true },
    })
    if (!channel) return NextResponse.json({ claimed: false })

    // Уже привязан этим юзером — успех (мгновенный финал после вебхука)
    if (channel.claimedById === g.uid) {
      return NextResponse.json({ claimed: true, channelId: channel.id })
    }
    // Занят другим
    if (channel.claimedById) {
      return NextResponse.json({ claimed: false, taken: true })
    }

    // Бот уже админ канала? (свежая проверка — мимо 15-минутного кэша прав)
    const rights = await getBotChatRights(uname, { fresh: true })
    if (!rights) {
      /* v5.92: Bot API недоступен (глобальный флуд-бан 429 / сеть / таймаут).
         Раньше это приравнивалось к «бот НЕ админ» — владелец канала, уже
         добавивший бота, получал ложное «добавьте его и нажмите проверить»
         и упирался в одно и то же место, пока не заканчивался бан. */
      return NextResponse.json({ claimed: false, checkFailed: true })
    }
    if (rights.isAdmin) {
      const pendingUserId = await popPendingClaim(uname)
      if (!pendingUserId) {
        // Права есть, заявки нет: пусть юзер нажмёт «Привязать» ещё раз —
        // claimStart увидит админ-права и завершит привязку на месте
        return NextResponse.json({ claimed: false, botAdmin: true })
      }
      const done = await completeChannelClaim(uname, pendingUserId, { title: channel.title })
      if (done.ok && pendingUserId === g.uid) {
        return NextResponse.json({ claimed: true, channelId: done.channelId })
      }
      // Заявка была чужой — канал уехал другому владельцу
      return NextResponse.json({ claimed: false, taken: true })
    }

    return NextResponse.json({ claimed: false, botAdmin: false })
  } catch (e) {
    console.error('[mychannel:claim-status]', e)
    return err('Ошибка', 500)
  }
}
