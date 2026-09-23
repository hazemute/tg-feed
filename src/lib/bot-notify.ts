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
 *  • v6.1.1: ГЛОБАЛЬНЫЙ антиспам. Маркеры v5.55 жили в памяти инстанса
 *    (globalThis), а прод — serverless с множеством инстансов: дедуп работал
 *    только внутри одного инстанса, и волна лайков на популярном посте
 *    (лайки приходят на разные инстансы) присылала юзеру ЛС НА КАЖДЫЙ ЛАЙК —
 *    «бот спамит в ЛС». Теперь маркеры в БД (BotSetting) — атомарный
 *    create-lock: один инстанс на весь мир. Плюс: бюджет лайк-ЛС — не более
 *    5 за 6ч на пользователя (горячий пост с 50 комментами = ≤5 ЛС), и
 *    рубильник dm_notify_off (BotSetting) — мгновенно заглушить ВСЕ ЛС
 *    уведомления без деплоя (panel/bot action:'dm_notify').
 *  • v6.1.2: КРАСИВЫЕ КАРТОЧКИ. Цитата (<blockquote>) вместо голого текста,
 *    кнопки с премиум-иконками, премиум-эмодзи в тексте, «ты»-обращение.
 *  • ошибки только в лог — уведомление в инбоксе уже создано, ЛС не критично.
 */

/** Ссылка на миниапп (deep-link) — та же, что в webhook-приветствии бота */
const TME_APP_URL =
  process.env.NEXT_PUBLIC_TME_APP_URL?.trim() || 'https://t.me/tgswipe_bot/tgswipe'

/** Интервал между отправками в очереди (20 msg/s — ниже лимита Bot API) */
const SEND_INTERVAL_MS = 60

/* — Антиспам v6.1.1 (глобальный, в БД) — */
/** Лайки: 1 ЛС на (пользователь × комментарий) в 6 часов — «залетевший»
 *  комментарий с сотней лайков даёт ОДНО ЛС, а не сотню */
const LIKE_DM_PER_COMMENT_MS = 6 * 60 * 60_000
/** Лайки: бюджет на пользователя — не более 5 лайк-ЛС за скользящие 6ч
 *  (горячий пост с десятками комментов больше не «пулемётит» юзера) */
const LIKE_DM_BUDGET_WINDOW_MS = 6 * 60 * 60_000
const LIKE_DM_BUDGET_MAX = 5
/** Ответы/комменты: 1 ЛС на (пользователь × пост × тип) в 2 минуты —
 *  горячая ветка/пост не долбят ЛС на каждое событие */
const THREAD_DM_PER_POST_MS = 2 * 60_000
/** Жёсткий кап ЛС на пользователя в минуту (любые типы, последний рубеж) */
const USER_DM_CAP_PER_MIN = 4
/** Рубильник: задан в BotSetting — ВСЕ ЛС-уведомления молча пропускаются */
const DM_KILL_KEY = 'dm_notify_off'

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

/* ------------------------ Антиспам ЛС (v6.1.1, в БД) ------------------------
 *  Все маркеры — в BotSetting: serverless-инстансов много, память каждого
 *  своя, а BotSetting один на весь мир. Ключи:
 *    dm:like:<userId>:<commentId>   → ISO ts последнего лайк-ЛС (окно 6ч)
 *    dm:thread:<userId>:<postId>:<type> → ISO ts последнего ЛС ветки (2мин)
 *    dm:likecap:<userId>            → JSON ts[] (бюджет 5 лайк-ЛС/6ч)
 *    dm:cap:<userId>                → JSON ts[] (кап 4 ЛС/мин)
 *    dm_notify_off                  → любое значение = заглушить все ЛС
 */

/** Ленивая подрезка старых маркеров: каждый ~40-й claim чистит 7-дневные.
 *  value хранит ISO-строку — лексикографическое сравнение корректно.
 *  JSON-массивы (cap/likecap) начинаются с '[' и фильтром не задеваются —
 *  они и так перезаписываются по месту, не накапливаясь. */
const gPrune = globalThis as unknown as { __tgDmPruneCount?: number }

async function pruneDmMarkers(): Promise<void> {
  gPrune.__tgDmPruneCount = (gPrune.__tgDmPruneCount ?? 0) + 1
  if (gPrune.__tgDmPruneCount % 40 !== 0) return
  const cutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
  await db.botSetting
    .deleteMany({
      where: {
        OR: [{ key: { startsWith: 'dm:like:' } }, { key: { startsWith: 'dm:thread:' } }],
        value: { lt: cutoff },
      },
    })
    .catch(() => {})
}

/** Рубильник: все ЛС выключены? (панель → action:'dm_notify') */
async function dmKilled(): Promise<boolean> {
  const row = await db.botSetting
    .findUnique({ where: { key: DM_KILL_KEY }, select: { value: true } })
    .catch(() => null)
  return Boolean(row?.value)
}

/** Атомарное занятие окна: первый инстанс создаёт ключ, остальные читают его
 *  и отклоняются. Порядок «сначала тихое чтение, потом create» держит
 *  P2002 (шумный лог Prisma) только в редкой гонке двух инстансов. */
async function claimWindow(key: string, windowMs: number): Promise<boolean> {
  const now = new Date()
  const row = await db.botSetting
    .findUnique({ where: { key }, select: { value: true } })
    .catch(() => null)
  if (row) {
    const ts = Date.parse(row.value)
    if (Number.isFinite(ts) && now.getTime() - ts < windowMs) return false
    try {
      await db.botSetting.update({ where: { key }, data: { value: now.toISOString() } })
      return true
    } catch {
      return false
    }
  }
  try {
    await db.botSetting.create({ data: { key, value: now.toISOString() } })
    void pruneDmMarkers()
    return true
  } catch {
    // P2002 — ключ успел создать другой инстанс: окно занято
    return false
  }
}

/** Скользящее окно с лимитом (JSON-массив ts в одном ключе): лайк-бюджет 5/6ч
 *  и жёсткий кап 4/мин. Гонки двух инстансов дают кап +1..2 — это приемлемо. */
async function claimRolling(key: string, windowMs: number, max: number): Promise<boolean> {
  const now = Date.now()
  const row = await db.botSetting
    .findUnique({ where: { key }, select: { value: true } })
    .catch(() => null)
  let arr: number[] = []
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : []
    if (Array.isArray(parsed)) arr = parsed.filter((x): x is number => typeof x === 'number')
  } catch {
    arr = []
  }
  arr = arr.filter((ts) => now - ts < windowMs)
  if (arr.length >= max) return false
  arr.push(now)
  await db.botSetting
    .upsert({
      where: { key },
      create: { key, value: JSON.stringify(arr) },
      update: { value: JSON.stringify(arr) },
    })
    .catch(() => {})
  return true
}

/** Рубильник: включить/выключить ВСЕ ЛС-уведомления (панель, action:'dm_notify') */
export async function setDmNotifyOff(off: boolean): Promise<void> {
  try {
    if (off) {
      await db.botSetting.upsert({
        where: { key: DM_KILL_KEY },
        create: { key: DM_KILL_KEY, value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      })
    } else {
      await db.botSetting.deleteMany({ where: { key: DM_KILL_KEY } })
    }
  } catch (e) {
    console.error('[bot-notify] setDmNotifyOff', e)
  }
}

/** Текущее состояние рубильника (для панели) */
export async function dmNotifyOff(): Promise<boolean> {
  return dmKilled()
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
  const snippet = (s: string) => escapeHtml(s.slice(0, 180)) + (s.length > 180 ? '…' : '')
  switch (data.type) {
    case 'comment':
      return (
        `💬 <b>Новый комментарий</b> · «${title}»\n\n` +
        `<blockquote>${snippet(data.body)}</blockquote>\n\n` +
        `<a href="${link}">Ответить в приложении →</a>`
      )
    case 'reply':
      return (
        `↩️ <b>${title} ответил(а) тебе</b>\n\n` +
        `<blockquote>${snippet(data.body)}</blockquote>\n\n` +
        `<a href="${link}">Открыть диалог →</a>`
      )
    case 'comment_like':
      // title приходит уже готовым: «X оценил(а) ваш комментарий» или
      // агрегированное «У вашего комментария уже N лайков»;
      // body = «❤️ {текст комментария}» — ведущее сердечко убираем,
      // текст уходит в цитату (v6.1.2)
      return (
        `<b>${title}</b>\n\n` +
        `<blockquote>${snippet(data.body.replace(/^❤️\s*/, ''))}</blockquote>\n\n` +
        `<a href="${link}">Открыть в приложении →</a>`
      )
    case 'system':
      // Заголовок обычно уже с эмодзи («✅ Задание выполнено…») — 🔔 добавляем
      // только к «голому» тексту
      return (
        `<b>${title}</b>\n\n${snippet(data.body)}\n\n` +
        `<a href="${link}">Открыть в приложении →</a>`
      )
  }
}

/* ------------------------------- Публичный API ------------------------------- */

/**
 * ЛС от бота об активности (fire-and-forget). Вызывается из notifyUser
 * (comments-server.ts) ПОСЛЕ создания записи в инбоксе — ЛС не блокирует ответ
 * API и не роняет его. Никогда не бросает (вызовы без await безопасны).
 *
 * v6.1.1: гардды ГЛОБАЛЬНЫЕ (в BotSetting, см. блок выше) — дедуп работает
 * между всеми serverless-инстансами, а не только внутри одного.
 */
export async function sendBotNotification(data: BotNotifyData): Promise<void> {
  try {
    // Только проверенные пользователи (вход через бот) — остальным писать нельзя
    if (!data.userId.startsWith('tg_')) return
    const chatId = Number(data.userId.slice('tg_'.length))
    if (!Number.isInteger(chatId) || chatId <= 0) return

    // Рубильник: ЛС полностью заглушены владельцем — инбокс миниаппа живёт
    if (await dmKilled()) return

    // Антиспам v6.1.1 (глобально): коммент залетел → ЛС не чаще 1 на
    // комментарий в 6ч И не более 5 лайк-ЛС за 6ч на юзера; горячий пост →
    // ответы/комменты не чаще 1 в 2мин; кап 4 ЛС/мин на юзера.
    // Прошедшие фильтр события живут в инбоксе миниаппа в любом случае.
    if (data.type === 'comment_like') {
      if (!(await claimWindow(`dm:like:${data.userId}:${data.commentId ?? '_'}`, LIKE_DM_PER_COMMENT_MS))) return
      if (!(await claimRolling(`dm:likecap:${data.userId}`, LIKE_DM_BUDGET_WINDOW_MS, LIKE_DM_BUDGET_MAX))) return
    }
    if ((data.type === 'reply' || data.type === 'comment')) {
      if (!(await claimWindow(`dm:thread:${data.userId}:${data.postId ?? '_'}:${data.type}`, THREAD_DM_PER_POST_MS))) return
    }
    if (!(await claimRolling(`dm:cap:${data.userId}`, 60_000, USER_DM_CAP_PER_MIN))) return

    const startParam = startParamOf(data.postId, data.commentId)
    const link = deepLinkOf(startParam)
    // Глубокая ссылка на конкретное уведомление, либо просто кнопка запуска приложения
    // v6.1.2: иконки кнопок через слоты (премиум) + стили; эмоциональная иконка в plain-фолбэке
    const keyboard = startParam
      ? [[{ label: 'Перейти к уведомлению', emoji: '🚀', url: link, style: 'primary' as const }]]
      : [[{ label: 'Открыть Tg Swipe', emoji: '🚀', url: TME_APP_URL, style: 'primary' as const }]]

    enqueueSend(async () => {
      // Агрегация: к моменту отправки лайков может быть уже много — если ≥5,
      // шлём «У вашего комментария уже N лайков» вместо «X оценил(а)»
      let title = data.type === 'comment_like' ? `${data.title} оценил(а) твой комментарий` : data.title
      if (data.type === 'comment_like' && data.commentId) {
        try {
          const c = await db.comment.findUnique({
            where: { id: data.commentId },
            select: { likesCount: true },
          })
          const n = c?.likesCount ?? 0
          if (n >= 5) title = `🔥 У твоего комментария уже ${n} ${likesWord(n)}`
        } catch {
          /* не получили счётчик — шлём обычный текст */
        }
      }
      const html = htmlOf({ ...data, title }, link)
      const r = await botSendRich(chatId, html, {
        keyboard,
        // premiumText сам обернёт эмодзи в премиум (v6.1.2 — красивые карточки);
        // при недоступности премиума отправка сама уйдёт обычным текстом
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
