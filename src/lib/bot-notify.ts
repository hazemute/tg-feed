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
 *  • антиспам (v5.55, «коммент залетел»): ЛС-«лайк» — НЕ ЧАЩЕ 1 НА КОММЕНТАРИЙ
 *    В 6 ЧАСОВ; если лайков уже ≥5 — текст агрегируется («У вашего комментария
 *    уже N лайков»); ответы/комменты — не чаще 1 ЛС на пост в 2 минуты;
 *    поверх всего — жёсткий кап 4 ЛС в минуту на пользователя (любые типы);
 *    в инбоксе миниаппа события всё равно появляются все;
 *  • ошибки только в лог — уведомление в инбоксе уже создано, ЛС не критично.
 */

/** Ссылка на миниапп (deep-link) — та же, что в webhook-приветствии бота */
const TME_APP_URL =
  process.env.NEXT_PUBLIC_TME_APP_URL?.trim() || 'https://t.me/tgswipe_bot/tgswipe'

/** Интервал между отправками в очереди (20 msg/s — ниже лимита Bot API) */
const SEND_INTERVAL_MS = 60

/* — Антиспам v5.55 — */
/** Лайки: 1 ЛС на (пользователь × комментарий) в 6 часов — «залетевший»
 *  комментарий с сотней лайков даёт ОДНО ЛС, а не сотню */
const LIKE_DM_PER_COMMENT_MS = 6 * 60 * 60_000
/** Ответы/комменты: 1 ЛС на (пользователь × пост × тип) в 2 минуты —
 *  горячая ветка/пост не долбят ЛС на каждое событие */
const THREAD_DM_PER_POST_MS = 2 * 60_000
/** Жёсткий кап ЛС на пользователя в минуту (любые типы, последний рубеж) */
const USER_DM_CAP_PER_MIN = 4

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

/* ------------------------------ Антиспам ЛС (v5.55) ------------------------------
 *  Хранилища на globalThis: route-бандлы Next.js изолируют модули — без
 *  синглтона каждый роут держал бы СВОЮ копию карт и лимиты молча не работали
 *  (тот же баг, что был с page-cache/overrides).
 */
type DmGuard = {
  /** ключ "userId:commentId" → ts последней отправки ЛС-лайка */
  likeAt: Map<string, number>
  /** ключ "userId:postId:type" → ts последней ЛС ответа/коммента */
  threadAt: Map<string, number>
  /** userId → ts последних ЛС (окно 60с) */
  userDm: Map<string, number[]>
}
const gDm = globalThis as unknown as { __tgfeedDmGuard?: DmGuard }
const dm: DmGuard = (gDm.__tgfeedDmGuard ??= { likeAt: new Map(), threadAt: new Map(), userDm: new Map() })

/** Пишем ts и подрезаем карту, если разрослась */
function markAndCheck(map: Map<string, number>, key: string, windowMs: number): boolean {
  const now = Date.now()
  if (now - (map.get(key) ?? 0) < windowMs) return false
  map.set(key, now)
  if (map.size > 5000) {
    for (const [k, ts] of map) {
      if (now - ts > windowMs) map.delete(k)
    }
  }
  return true
}

/** ЛС-лайк по конкретному комментарию разрешён? (1 в 6ч) */
function likeDmAllowed(userId: string, commentId: string | null | undefined): boolean {
  // Без commentId — грубый пер-юзер лимит в 6ч (не должно случаться, но фолбэк)
  return markAndCheck(dm.likeAt, `${userId}:${commentId ?? '_'}`, LIKE_DM_PER_COMMENT_MS)
}

/** Ответ/коммент по посту разрешён? (1 в 2мин на тип) */
function threadDmAllowed(userId: string, postId: string | null | undefined, type: string): boolean {
  return markAndCheck(dm.threadAt, `${userId}:${postId ?? '_'}:${type}`, THREAD_DM_PER_POST_MS)
}

/** Кап 4 ЛС в минуту на пользователя — последний рубеж против любых волн */
function userDmAllowed(userId: string): boolean {
  const now = Date.now()
  const arr = (dm.userDm.get(userId) ?? []).filter((ts) => now - ts < 60_000)
  if (arr.length >= USER_DM_CAP_PER_MIN) {
    dm.userDm.set(userId, arr)
    return false
  }
  arr.push(now)
  dm.userDm.set(userId, arr)
  if (dm.userDm.size > 5000) {
    for (const [k, v] of dm.userDm) {
      if (!v.some((ts) => now - ts < 60_000)) dm.userDm.delete(k)
    }
  }
  return true
}

/** «лайк/лайка/лайков» для агрегированного текста */
function likesWord(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'лайк'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'лайка'
  return 'лайков'
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
      // title приходит уже готовым: «X оценил(а) ваш комментарий» или
      // агрегированное «У вашего комментария уже N лайков»
      return `❤️ <b>${title}</b>\n\n${text}\n\n🔗 <a href="${link}">Открыть в приложении</a>`
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

    // Антиспам v5.55: коммент залетел → ЛС не чаще 1 на комментарий в 6ч;
    // горячий пост → ответы/комменты не чаще 1 в 2мин; кап 4 ЛС/мин на юзера.
    // Прошедшие фильтр события живут в инбоксе миниаппа в любом случае.
    if (data.type === 'comment_like' && !likeDmAllowed(data.userId, data.commentId)) return
    if ((data.type === 'reply' || data.type === 'comment') && !threadDmAllowed(data.userId, data.postId, data.type)) return
    if (!userDmAllowed(data.userId)) return

    const startParam = startParamOf(data.postId, data.commentId)
    const link = deepLinkOf(startParam)
    // Глубокая ссылка на конкретное уведомление, либо просто кнопка запуска приложения
    const keyboard = startParam
      ? [[{ label: 'Перейти к уведомлению 🚀', url: link, style: 'primary' as const }]]
      : [[{ label: 'Открыть Tg Swipe', url: TME_APP_URL, style: 'primary' as const }]]

    enqueueSend(async () => {
      // Агрегация: к моменту отправки лайков может быть уже много — если ≥5,
      // шлём «У вашего комментария уже N лайков» вместо «X оценил(а)»
      let title = data.type === 'comment_like' ? `${data.title} оценил(а) ваш комментарий` : data.title
      if (data.type === 'comment_like' && data.commentId) {
        try {
          const c = await db.comment.findUnique({
            where: { id: data.commentId },
            select: { likesCount: true },
          })
          const n = c?.likesCount ?? 0
          if (n >= 5) title = `У вашего комментария уже ${n} ${likesWord(n)}`
        } catch {
          /* не получили счётчик — шлём обычный текст */
        }
      }
      const html = htmlOf({ ...data, title }, link)
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
