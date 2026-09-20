import { db } from '@/lib/db'
import { botSendRich } from '@/lib/tg-emoji'
import { escapeHtml } from '@/lib/tg-bot'

/**
 * УВЕДОМЛЕНИЯ В ЛС ОТ БОТА (v5.45).
 *
 * Когда пользователю создаётся активность в инбоксе миниаппа (ответ на его
 * комментарий, лайк, новый комментарий под постом его канала) — бот ДОПОЛНИТЕЛЬНО
 * пишет в личку: короткое HTML-сообщение + ссылка на приложение в тексте и
 * инлайн-кнопка «Перейти к уведомлению».
 *
 * Кнопка — URL на миниапп с параметром startapp: t.me/tgswipe_bot/tgswipe?startapp=
 * n_<postId>[_<commentId>]. Миниапп разбирает start_param (page.tsx) и открывает
 * комментарии прямо на этом комментарии (ветка раскрывается, строка подсвечивается).
 *
 * Правила надёжности/вежливости:
 *  • пишем только проверенным пользователям (userId = tg_<num> — вход через бот,
 *    значит ЛС с ботом разрешено; guest_* молча пропускаем);
 *  • botSendRich сам уважает флуд-бан Bot API (429) и делает фолбэк клавиатур;
 *  • отправки выстраиваются в очередь с интервалом — не даём burst при волне
 *    лайков (лимит Bot API 30 msg/s);
 *  • антиспам: лайки не чаще одного ЛС на пользователя в 10 секунд (в инбоксе
 *    миниаппа события всё равно появляются все);
 *  • ошибки только в лог — уведомление в инбоксе уже создано, ЛС не критично.
 */

/** Ссылка на миниапп (deep-link) — та же, что в webhook-приветствии бота */
const TME_APP_URL =
  process.env.NEXT_PUBLIC_TME_APP_URL?.trim() || 'https://t.me/tgswipe_bot/tgswipe'

/** Интервал между отправками в очереди (20 msg/s — ниже лимита Bot API) */
const SEND_INTERVAL_MS = 60
/** Минимальная пауза между ЛС-«лайк» одному пользователю (антиспам) */
const LIKE_DM_GAP_MS = 10_000

type BotNotifyData = {
  userId: string
  type: 'comment' | 'reply' | 'comment_like' | 'system'
  title: string
  body: string
  postId?: string | null
  commentId?: string | null
}

/* ---------------- Очередь отправок (последовательная, с паузой) ---------------- */

let queueTail: Promise<void> = Promise.resolve()

function enqueueSend(task: () => Promise<void>): void {
  queueTail = queueTail
    .then(task)
    .then(() => new Promise<void>((r) => setTimeout(r, SEND_INTERVAL_MS)))
    .catch((e) => console.error('[bot-notify] queue', e))
}

/* ------------------------------ Антиспам лайков ------------------------------ */

const lastLikeDmAt = new Map<string, number>()

function likeDmAllowed(userId: string): boolean {
  const now = Date.now()
  const last = lastLikeDmAt.get(userId) ?? 0
  if (now - last < LIKE_DM_GAP_MS) return false
  lastLikeDmAt.set(userId, now)
  // Не даём карте расти бесконечно
  if (lastLikeDmAt.size > 5000) {
    for (const [k, ts] of lastLikeDmAt) {
      if (now - ts > LIKE_DM_GAP_MS) lastLikeDmAt.delete(k)
    }
  }
  return true
}

/* --------------------------------- Тексты --------------------------------- */

/** payload для startapp: n_<postId>[_<commentId>] (cuid не содержит «_») */
function startParamOf(postId?: string | null, commentId?: string | null): string {
  const p = (postId ?? '').trim()
  const c = (commentId ?? '').trim()
  if (!p) return ''
  return c ? `n_${p}_${c}` : `n_${p}`
}

function deepLinkOf(startParam: string): string {
  return startParam ? `${TME_APP_URL}?startapp=${encodeURIComponent(startParam)}` : TME_APP_URL
}

function htmlOf(data: BotNotifyData, link: string): string {
  const title = escapeHtml(data.title.slice(0, 64))
  const text = escapeHtml(data.body.slice(0, 180)) + (data.body.length > 180 ? '…' : '')
  switch (data.type) {
    case 'comment':
      return `💬 <b>Новый комментарий на канале «${title}»</b>\n\n${text}\n\n🔗 <a href="${link}">Открыть в приложении</a>`
    case 'reply':
      return `↩️ <b>${title} ответил(а) на ваш комментарий</b>\n\n${text}\n\n🔗 <a href="${link}">Открыть в приложении</a>`
    case 'comment_like':
      return `❤️ <b>${title} оценил(а) ваш комментарий</b>\n\n${text}\n\n🔗 <a href="${link}">Открыть в приложении</a>`
    case 'system':
      return `🔔 <b>${title}</b>\n\n${text}\n\n🔗 <a href="${link}">Открыть в приложении</a>`
  }
}

/* ------------------------------- Публичный API ------------------------------- */

/**
 * ЛС от бота об активности (fire-and-forget). Вызывается из notifyUser
 * (comments-server.ts) ПОСЛЕ создания записи в инбоксе — ЛС не блокирует ответ
 * API и не роняет его. Никогда не бросает.
 */
export function sendBotNotification(data: BotNotifyData): void {
  try {
    // Только проверенные пользователи (вход через бот) — остальным писать нельзя
    if (!data.userId.startsWith('tg_')) return
    const chatId = Number(data.userId.slice('tg_'.length))
    if (!Number.isInteger(chatId) || chatId <= 0) return

    // Антиспам: волна лайков → одно ЛС, остальные события живут в инбоксе миниаппа
    if (data.type === 'comment_like' && !likeDmAllowed(data.userId)) return

    const startParam = startParamOf(data.postId, data.commentId)
    const link = deepLinkOf(startParam)
    const html = htmlOf(data, link)
    // Глубокая ссылка на конкретное уведомление, либо просто кнопка запуска приложения
    const keyboard = startParam
      ? [[{ label: 'Перейти к уведомлению 🚀', url: link, style: 'primary' as const }]]
      : [[{ label: 'Открыть Tg Swipe', url: TME_APP_URL, style: 'primary' as const }]]

    enqueueSend(async () => {
      const r = await botSendRich(chatId, html, {
        keyboard,
        // Текст уже с эмодзи и экранированием — premiumText не нужен
        skipPremiumWrap: true,
      })
      if (!r.ok) {
        console.warn('[bot-notify] DM failed', data.type, data.userId, r.error ?? r.via)
      }
    })
  } catch (e) {
    console.error('[bot-notify] sendBotNotification', e)
  }
}

/**
 * Проверка «бот вообще может писать этому пользователю» — для будущего
 * использования (панель, розыгрыши). Сейчас внутренняя, экспорт на всякий случай.
 */
export async function botChatIdOfUser(userId: string): Promise<number | null> {
  if (!userId.startsWith('tg_')) return null
  const n = Number(userId.slice('tg_'.length))
  if (!Number.isInteger(n) || n <= 0) return null
  // Пользователь существует и не гость — ЛС разрешено (все tg_ входят через бота)
  const u = await db.user.findUnique({ where: { id: userId }, select: { isGuest: true } })
  return u && !u.isGuest ? n : null
}
