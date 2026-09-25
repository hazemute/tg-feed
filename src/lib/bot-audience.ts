import { db } from '@/lib/db'

/**
 * v6.6: ОБЪЕДИНЁННАЯ АУДИТОРИЯ ЛС-РАССЫЛОК.
 *
 * Кто получает рассылку (/send и вкладка «Рассылка» панели):
 *  1. Юзеры миниаппа (User.id = tg_<num>, не забанены) — initData прошёл
 *     HMAC-проверку, бот может писать им (все tg_ входят через бота).
 *  2. Бот-юзеры (BotUser) — каждый, кто ПИСАЛ боту в ЛС или жал кнопки
 *     (вебхук сохраняет chat_id с v6.6). Миниапп могли не открывать.
 *  3. Исторические botlang:<chatId> (BotSetting) — кто выбирал язык бота
 *     до появления BotUser; не теряем накопленное.
 *
 * Telegram физически не позволяет достучаться до остальных «пользователей
 * месяца» из BotFather — их chat_id боту не передаются, пока юзер сам
 * не напишет/не нажмёт кнопку.
 */

export type BotAudience = {
  /** Итоговый список chat_id (строки, отсортированы по возрастанию числа) */
  ids: string[]
  /** Из миниаппа (User tg_, не забанены) */
  appCount: number
  /** Добавились из бота (BotUser/botlang), миниапп не открывали */
  botOnlyCount: number
  /** Забаненные юзеры миниаппа — исключены из рассылки */
  bannedCount: number
}

const CHAT_ID_RE = /^\d{3,}$/

export async function botBroadcastAudience(): Promise<BotAudience> {
  const [users, botUsers, langRows] = await Promise.all([
    db.user.findMany({
      where: { id: { startsWith: 'tg_' } },
      select: { id: true, bannedAt: true },
    }),
    // catch: таблицы может не быть в первые секунды после деплоя (миграция
    // идёт на cold start) — рассылка просто не увидит бот-юзеров
    db.botUser.findMany({ select: { chatId: true } }).catch(() => [] as Array<{ chatId: string }>),
    db.botSetting
      .findMany({ where: { key: { startsWith: 'botlang:' } }, select: { key: true } })
      .catch(() => [] as Array<{ key: string }>),
  ])

  const set = new Set<string>()
  let banned = 0

  for (const u of users) {
    const n = Number(u.id.slice('tg_'.length))
    if (!Number.isInteger(n) || n <= 0) continue
    if (u.bannedAt) {
      banned++
      continue
    }
    set.add(String(n))
  }
  const appCount = set.size

  for (const b of botUsers) {
    if (CHAT_ID_RE.test(b.chatId)) set.add(b.chatId)
  }
  for (const r of langRows) {
    const chatId = r.key.slice('botlang:'.length)
    if (CHAT_ID_RE.test(chatId)) set.add(chatId)
  }

  const ids = [...set].sort((a, b) => Number(a) - Number(b))
  return { ids, appCount, botOnlyCount: ids.length - appCount, bannedCount: banned }
}
