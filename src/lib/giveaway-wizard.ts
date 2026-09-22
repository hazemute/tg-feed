import { db } from '@/lib/db'
import { escapeHtml } from '@/lib/tg-bot'
import { botSendRich } from '@/lib/tg-emoji'
import type { BotButton } from '@/lib/tg-buttons'
import { getBotUsername } from '@/lib/tg-bot'
import {
  DEFAULT_BOOST_CHANNEL,
  DEFAULT_REFERRAL_GOAL,
  DEFAULT_SWIPE_GOAL,
  parseTasks,
  serializeTasks,
  taskTitle,
  type GiveawayTask,
  type GiveawayTaskKind,
} from '@/lib/giveaway-tickets'
import {
  DEFAULT_GIVEAWAY_CHANNEL,
  prizeAutoLabel,
  publishGiveawayPost,
  totalWinners,
  type Prize,
} from '@/lib/giveaways'

/**
 * МАСТЕР СОЗДАНИЯ РОЗЫГРЫША В ЛС БОТА (v5.46) + карточки заданий для юзеров.
 *
 * Админ пишет боту /newgw — бот шаг за шагом собирает розыгрыш ПРЯМО В ДИАЛОГЕ
 * (не в панели): название → описание → фото → призы → билетные задания
 * (сколько билетов за какое задание) → утешительные свайпы проигравшим →
 * длительность → обязательные каналы → подтверждение → публикация поста в канал.
 *
 * Состояние диалога живёт в BotSetting (key gwwizard:<chatId>) — переживает
 * рестарты инстансов; протухает через 2 часа бездействия.
 *
 * Для участников: /mygw — карточка розыгрыша с заданиями, прогрессом, билетами
 * и реферальной ссылкой; промокод принимается просто текстом в чат бота.
 */

const WIZARD_KEY_PREFIX = 'gwwizard:'
const WIZARD_TTL_MS = 2 * 60 * 60 * 1000

/** Канал публикации розыгрышей (тот же, что панельный) */
async function publishChannel(): Promise<string> {
  const row = await db.botSetting
    .findUnique({ where: { key: 'giveaway_channel' } })
    .catch(() => null)
  return row?.value?.trim() || DEFAULT_GIVEAWAY_CHANNEL
}

/* ------------------------------- состояние ------------------------------- */

type WizardStep =
  | 'title'
  | 'text'
  | 'photo'
  | 'prizes_kind'
  | 'prizes_amount'
  | 'prizes_winners'
  | 'prizes_more'
  | 'tasks'
  | 'task_tickets'
  | 'task_param'
  | 'losers'
  | 'duration'
  | 'channels'
  | 'confirm'

type WizardState = {
  step: WizardStep
  title?: string
  text?: string
  photoFileId?: string
  prizes: Prize[]
  /** черновик текущего приза (kind выбран → ждём amount → winners) */
  prizeDraft?: { kind: Prize['kind'] }
  tasks: GiveawayTask[]
  /** очередь включённых заданий, ждущих настройки (tickets → параметр) */
  taskQueue: GiveawayTaskKind[]
  losers: number
  hours: number
  channels: string[]
  updatedAt: number
}

function newWizard(): WizardState {
  return { step: 'title', prizes: [], tasks: [], taskQueue: [], losers: 500, hours: 48, channels: [], updatedAt: Date.now() }
}

async function loadWizard(chatId: number): Promise<WizardState | null> {
  const row = await db.botSetting
    .findUnique({ where: { key: `${WIZARD_KEY_PREFIX}${chatId}` } })
    .catch(() => null)
  if (!row?.value) return null
  try {
    const st = JSON.parse(row.value) as WizardState
    if (!st || typeof st.step !== 'string' || Date.now() - (st.updatedAt ?? 0) > WIZARD_TTL_MS) return null
    return st
  } catch {
    return null
  }
}

async function saveWizard(chatId: number, st: WizardState | null): Promise<void> {
  const key = `${WIZARD_KEY_PREFIX}${chatId}`
  if (!st) {
    await db.botSetting.deleteMany({ where: { key } }).catch(() => {})
    return
  }
  st.updatedAt = Date.now()
  await db.botSetting
    .upsert({
      where: { key },
      create: { key, value: JSON.stringify(st) },
      update: { value: JSON.stringify(st) },
    })
    .catch(() => {})
}

/* -------------------------------- утилиты -------------------------------- */

const fmtNum = (n: number) => n.toLocaleString('ru-RU')

function prizesSummary(prizes: Prize[]): string {
  if (prizes.length === 0) return '— ещё не заданы —'
  return prizes
    .map((p, i) => `${i + 1}. ${p.label} · мест: ${p.winners}`)
    .join('\n')
}

function tasksSummary(tasks: GiveawayTask[]): string {
  const enabled = tasks.filter((t) => t.enabled)
  if (enabled.length === 0) return '— не заданы (розыгрыш без билетов, равный шанс) —'
  return enabled.map((t) => `• ${taskTitle(t)} — +${t.tickets} 🎫`).join('\n')
}

async function ask(chatId: number, st: WizardState): Promise<void> {
  const esc = escapeHtml
  switch (st.step) {
    case 'title':
      await botSendRich(
        chatId,
        [
          '🎫 <b>Создание розыгрыша — шаг 1/7</b>',
          '',
          'Пришли <b>название</b> розыгрыша (для поста в канале).',
          '',
          'Например: <i>«Раздача 10 000 свайпов»</i>',
          '',
          '❌ Отмена в любой момент: /cancel',
        ].join('\n'),
      )
      break
    case 'text':
      await botSendRich(
        chatId,
        [
          '📝 <b>Шаг 2/7 — описание</b>',
          '',
          'Пришли описание (условия, что разыгрываем). Поддерживается:',
          '<b>**жирный**</b> и <i>__курсив__</i>.',
          '',
          '<i>/skip — без описания</i>',
        ].join('\n'),
      )
      break
    case 'photo':
      await botSendRich(
        chatId,
        [
          '🖼 <b>Шаг 3/7 — картинка поста</b>',
          '',
          'Пришли <b>фото</b> для поста розыгрыша (кнопкой-скрепкой).',
          '',
          '<i>/skip — пост без картинки</i>',
        ].join('\n'),
      )
      break
    case 'prizes_kind':
      await botSendRich(
        chatId,
        [
          '🎁 <b>Шаг 4/7 — призы</b>',
          '',
          'Текущие призы:',
          esc(prizesSummary(st.prizes)),
          '',
          'Добавь приз — выбери тип:',
        ].join('\n'),
        {
          keyboard: [
            [
              { label: 'Свайпы', emoji: '🎫', callback_data: 'gww:k:swipes', style: 'primary' },
              { label: 'Рубли', emoji: '💰', callback_data: 'gww:k:rub', style: 'primary' },
            ],
            [
              { label: 'Тариф Snap', emoji: '👑', callback_data: 'gww:k:tier', style: 'primary' },
              { label: 'Сюрприз', emoji: '🎁', callback_data: 'gww:k:custom', style: 'primary' },
            ],
            ...(st.prizes.length > 0 ? ([[{ label: 'Дальше →', emoji: '➡️', callback_data: 'gww:next', style: 'success' }]] as BotButton[][]) : []),
          ],
        },
      )
      break
    case 'prizes_amount':
      await botSendRich(
        chatId,
        st.prizeDraft?.kind === 'swipes'
          ? '🎫 Сколько <b>свайпов</b> на этот приз? (числом, напр. <code>1000</code>)'
          : st.prizeDraft?.kind === 'rub'
            ? '💰 Сколько <b>рублей</b> на этот приз? (числом, напр. <code>500</code>)'
            : 'Сколько? (числом)',
        {
          keyboard:
            st.prizeDraft?.kind === 'swipes'
              ? [[
                  { label: '500', callback_data: 'gww:a:500' },
                  { label: '1 000', callback_data: 'gww:a:1000' },
                  { label: '5 000', callback_data: 'gww:a:5000' },
                  { label: '10 000', callback_data: 'gww:a:10000' },
                ]]
              : st.prizeDraft?.kind === 'rub'
                ? [[
                    { label: '100 ₽', callback_data: 'gww:a:100' },
                    { label: '500 ₽', callback_data: 'gww:a:500' },
                    { label: '1 000 ₽', callback_data: 'gww:a:1000' },
                  ]]
                : [],
        },
      )
      break
    case 'prizes_winners':
      await botSendRich(chatId, '🏆 Сколько <b>мест</b> (победителей) на этот приз?', {
        keyboard: [[
          { label: '1', callback_data: 'gww:w:1' },
          { label: '2', callback_data: 'gww:w:2' },
          { label: '3', callback_data: 'gww:w:3' },
          { label: '5', callback_data: 'gww:w:5' },
          { label: '10', callback_data: 'gww:w:10' },
        ]],
      })
      break
    case 'prizes_more':
      await botSendRich(
        chatId,
        ['✅ Приз добавлен.', '', 'Призы:', esc(prizesSummary(st.prizes))].join('\n'),
        {
          keyboard: [
            [{ label: 'Ещё приз', emoji: '➕', callback_data: 'gww:more', style: 'primary' }],
            [{ label: 'Дальше →', emoji: '➡️', callback_data: 'gww:next', style: 'success' }],
          ],
        },
      )
      break
    case 'tasks':
      await botSendRich(
        chatId,
        [
          '🎫 <b>Шаг 5/7 — билетные задания</b>',
          '',
          'Участник выполняет задания → получает билеты → чем больше билетов, тем выше шанс победы. У кого 0 билетов — тот не участвует в выборе.',
          '',
          'Текущие задания:',
          esc(tasksSummary(st.tasks)),
          '',
          'Тапай, чтобы включить/выключить:',
        ].join('\n'),
        {
          keyboard: [
            taskToggleRow(st, 'activity', '📱 Активность'),
            taskToggleRow(st, 'promo', '🔑 Промокод'),
            taskToggleRow(st, 'referral', '🤝 Рефералы'),
            taskToggleRow(st, 'boost', '🚀 Буст канала'),
            taskToggleRow(st, 'forward', '📬 Посты из любимых каналов'),
            [{ label: 'Дальше →', emoji: '➡️', callback_data: 'gww:next', style: 'success' }],
          ],
        },
      )
      break
    case 'task_tickets': {
      const kind = st.taskQueue[0]
      await botSendRich(
        chatId,
        `🎫 Сколько <b>билетов</b> давать за задание «${esc(taskTitle(taskOf(st, kind)))}»?`,
        { keyboard: [[
          { label: '1', callback_data: `gww:tk:${kind}:1` },
          { label: '2', callback_data: `gww:tk:${kind}:2` },
          { label: '3', callback_data: `gww:tk:${kind}:3` },
          { label: '5', callback_data: `gww:tk:${kind}:5` },
        ]] },
      )
      break
    }
    case 'task_param': {
      const kind = st.taskQueue[0]
      if (kind === 'activity') {
        await botSendRich(chatId, '📱 Сколько <b>постов</b> нужно пролистать в Mini App для билета?', {
          keyboard: [[
            { label: '10', callback_data: 'gww:sg:10' },
            { label: '25', callback_data: 'gww:sg:25' },
            { label: '50', callback_data: 'gww:sg:50' },
            { label: '100', callback_data: 'gww:sg:100' },
          ]],
        })
      } else if (kind === 'promo') {
        await botSendRich(
          chatId,
          [
            '🔑 Пришли <b>секретный промокод</b> (латиница/цифры, 4–32 символа).',
            'Участник введёт его боту или в Mini App и получит билет.',
            '',
            '<i>Или сгенерируй случайно:</i>',
          ].join('\n'),
          { keyboard: [[{ label: '🎲 Сгенерировать', callback_data: 'gww:gen', style: 'primary' }]] },
        )
      } else if (kind === 'referral') {
        await botSendRich(chatId, '🤝 Сколько <b>друзей</b> нужно пригласить (должны открыть Mini App)?', {
          keyboard: [[
            { label: '1', callback_data: 'gww:rg:1' },
            { label: '3', callback_data: 'gww:rg:3' },
            { label: '5', callback_data: 'gww:rg:5' },
            { label: '10', callback_data: 'gww:rg:10' },
          ]],
        })
      } else if (kind === 'forward') {
        // У задания «источники» нет параметров (порог 5 каналов фиксирован) —
        // сразу к следующему заданию
        await finishTaskParam(chatId, st)
      } else {
        await botSendRich(chatId, '🚀 За буст какого канала даём билет? Пришли @юзернейм или выбери наш:', {
          keyboard: [[{ label: `@${DEFAULT_BOOST_CHANNEL}`, callback_data: 'gww:bc:def', style: 'primary' }]],
        })
      }
      break
    }
    case 'losers':
      await botSendRich(
        chatId,
        [
          '💜 <b>Шаг 6/7 — утешительный приз</b>',
          '',
          'Сколько <b>свайпов</b> начислить каждому, кто участвовал (набрал билеты), но не победил?',
          '',
          'Свайпы = валюта нейросетей и тарифов в Mini App.',
        ].join('\n'),
        { keyboard: [[
          { label: '500', callback_data: 'gww:ls:500', style: 'primary' },
          { label: '250', callback_data: 'gww:ls:250' },
          { label: '1 000', callback_data: 'gww:ls:1000' },
          { label: 'Выключить', callback_data: 'gww:ls:0' },
        ]] },
      )
      break
    case 'duration':
      await botSendRich(chatId, '⏰ <b>Шаг 7/7</b> — сколько дней принимать заявки?', {
        keyboard: [[
          { label: '1 день', callback_data: 'gww:dur:24' },
          { label: '2 дня', callback_data: 'gww:dur:48' },
          { label: '3 дня', callback_data: 'gww:dur:72' },
          { label: '7 дней', callback_data: 'gww:dur:168' },
        ]],
      })
      break
    case 'channels':
      await botSendRich(
        chatId,
        [
          '✅ <b>Обязательные подписки</b> (проверяются перед участием).',
          '',
          'Пришли @юзернеймы через пробел, напр.: <code>@SnapTeamDev @sponsor</code>',
          '',
          '<i>/skip — без обязательных подписок</i>',
        ].join('\n'),
      )
      break
    case 'confirm':
      await botSendRich(chatId, confirmText(st), {
        keyboard: [
          [{ label: '🚀 Опубликовать розыгрыш', callback_data: 'gww:pub', style: 'success' }],
          [{ label: 'Отмена', emoji: '❌', callback_data: 'gww:cancel', style: 'danger' }],
        ],
      })
      break
  }
}

function taskToggleRow(st: WizardState, kind: GiveawayTaskKind, label: string): BotButton[] {
  const on = st.tasks.some((t) => t.kind === kind && t.enabled)
  return [{ label: `${on ? '✅' : '⬜️'} ${label}`, callback_data: `gww:t:${kind}` }]
}

function taskOf(st: WizardState, kind: GiveawayTaskKind): GiveawayTask {
  const found = st.tasks.find((t) => t.kind === kind)
  if (found) return found
  // дефолты при первом включении
  switch (kind) {
    case 'activity':
      return { kind, enabled: true, tickets: 1, swipeGoal: DEFAULT_SWIPE_GOAL }
    case 'promo':
      return { kind, enabled: true, tickets: 1 }
    case 'referral':
      return { kind, enabled: true, tickets: 1, referralGoal: DEFAULT_REFERRAL_GOAL }
    case 'boost':
      return { kind, enabled: true, tickets: 1, boostChannel: DEFAULT_BOOST_CHANNEL }
    case 'forward':
      // v5.50: системное задание «источники рекомендаций» — порог фиксирован (5
      // каналов), организатор настраивает только количество билетов
      return { kind, enabled: true, tickets: 1 }
    case 'sponsor':
      // v5.98: системное задание «спонсоры» — список спонсоров живёт в Sponsor,
      // организатор настраивает только количество билетов
      return { kind, enabled: true, tickets: 1 }
  }
}

function confirmText(st: WizardState): string {
  const esc = escapeHtml
  const taskLines = st.tasks.filter((t) => t.enabled).map((t) => `  • ${esc(taskTitle(t))} — +${t.tickets} 🎫`)
  return [
    `📋 <b>Проверь розыгрыш</b>`,
    '',
    `📣 Название: <b>${esc(st.title ?? '—')}</b>`,
    st.text ? `📝 Описание: <i>${esc(st.text.slice(0, 140))}${st.text.length > 140 ? '…' : ''}</i>` : null,
    `🖼 Картинка: ${st.photoFileId ? 'есть' : 'нет'}`,
    '',
    `🎁 Призы:`,
    esc(prizesSummary(st.prizes)),
    '',
    `🎫 Задания (шанс = билеты):`,
    ...(taskLines.length > 0 ? taskLines : ['  — без заданий, равный шанс для всех'] ),
    '',
    `💜 Утешительные свайпы проигравшим: <b>${st.losers > 0 ? fmtNum(st.losers) : 'выключено'}</b>`,
    `⏰ Приём заявок: <b>${st.hours >= 24 ? `${Math.round(st.hours / 24)} дн.` : `${st.hours} ч`}</b>`,
    st.channels.length > 0 ? `✅ Обяз. подписки: ${st.channels.map((c) => `@${esc(c)}`).join(' ')}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/* ------------------------------ вход/команды ------------------------------ */

/** Точка входа: /newgw (только владелец бота) */
export async function startGiveawayWizard(chatId: number, isAdmin: boolean): Promise<void> {
  if (!isAdmin) {
    await botSendRich(
      chatId,
      '🚫 Создание розыгрышей доступно только владельцу бота.',
    )
    return
  }
  const st = newWizard()
  await saveWizard(chatId, st)
  await ask(chatId, st)
}

/** /mygw — карточка розыгрыша с заданиями для участника */
export async function sendMyGiveawayCard(chatId: number, userId: string): Promise<void> {
  const g = await db.giveaway.findFirst({
    where: { status: 'active', startAt: { lte: new Date() }, endAt: { gt: new Date() } },
    orderBy: { endAt: 'desc' },
  })
  if (!g) {
    await botSendRich(chatId, [
      '🎈 Сейчас активных розыгрышей нет.',
      '',
      'Подпишись на канал — как только объявим новый, ты увидишь пост с кнопкой «Участвовать».',
    ].join('\n'))
    return
  }

  const tasks = parseTasks(g.tasks).filter((t) => t.enabled)
  const entry = await db.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: g.id, userId } },
  })
  const tickets = entry?.ticketsCount ?? 0
  const done = new Set(
    (entry ? JSON.parse(entry.tasksDone || '[]') as Array<{ task: string }> : []).map((d) => d.task),
  )
  const tgId = Number(userId.slice('tg_'.length))

  // Прогресс заданий
  const progressLines: string[] = []
  for (const t of tasks) {
    const icon = done.has(t.kind) ? '✅' : '⬜️'
    let progress = ''
    if (!done.has(t.kind)) {
      if (t.kind === 'activity' && t.swipeGoal) {
        const n = await db.postView.count({ where: { userId, createdAt: { gte: g.startAt } } })
        progress = ` — ${Math.min(n, t.swipeGoal)}/${t.swipeGoal}`
      } else if (t.kind === 'referral' && t.referralGoal) {
        const n = await db.giveawayReferral.count({
          where: { referrerUserId: userId, activatedAt: { not: null } },
        })
        progress = ` — ${Math.min(n, t.referralGoal)}/${t.referralGoal}`
      }
    }
    progressLines.push(`${icon} ${escapeHtml(taskTitle(t))}${progress} — <b>+${t.tickets} 🎫</b>`)
  }

  const hoursLeft = Math.max(0, Math.floor((g.endAt.getTime() - Date.now()) / 3600_000))
  const referralLink = Number.isInteger(tgId) && tgId > 0 ? await referralLinkOf(tgId) : null

  const lines = [
    `🎫 <b>${escapeHtml(g.title)}</b>`,
    '',
    `⏰ Итоги через <b>${hoursLeft >= 24 ? `${Math.floor(hoursLeft / 24)} дн. ${hoursLeft % 24} ч` : `${hoursLeft} ч`}</b>`,
    `🎟 Твои билеты: <b>${tickets}</b> — это твой вес в розыгрыше`,
    '',
    ...(progressLines.length > 0 ? ['<b>Задания:</b>', ...progressLines, ''] : []),
    ...(referralLink ? [`🤝 <b>Твоя ссылка для друзей:</b>`, `${referralLink}`, ''] : []),
    ...(g.promoCode && tasks.some((t) => t.kind === 'promo') ? ['🔑 Промокод есть — просто пришли его сюда текстом!', ''] : []),
    'Шанс победы = количество билетов. Удачи! 🍀',
  ]

  const keyboard: BotButton[][] = []
  if (tasks.some((t) => t.kind === 'boost')) {
    keyboard.push([{ label: '🚀 Проверить буст', callback_data: `gwb:${g.id}`, style: 'primary' }])
  }
  if (referralLink) {
    keyboard.push([{ label: '🤝 Открыть ссылку-приглашение', url: referralLink }])
  }
  keyboard.push([{ label: '📖 Открыть Tg Swipe', emoji: '📱', url: 'https://t.me/tgswipe_bot/tgswipe', style: 'primary' }])

  await botSendRich(chatId, lines.join('\n'), { keyboard })
}

async function referralLinkOf(tgId: number): Promise<string | null> {
  const username = await getBotUsername()
  return username ? `https://t.me/${username}?start=ref_${tgId}` : null
}

/* ------------------------- текстовые ответы мастера ------------------------- */

/**
 * Текстовое сообщение юзера, пока активен мастер. Возвращает true — сообщение
 * поглощено мастером (дальше по цепочке вебхука не идёт).
 */
export async function handleWizardText(
  chatId: number,
  fromId: number,
  text: string,
  isAdmin: boolean,
): Promise<boolean> {
  const st = await loadWizard(chatId)
  if (!st) return false
  const msg = text.trim()
  const isCommand = msg.startsWith('/')

  if (isCommand && /^\/cancel(@\w+)?$/i.test(msg)) {
    await saveWizard(chatId, null)
    await botSendRich(chatId, '❌ Создание розыгрыша отменено.')
    return true
  }

  switch (st.step) {
    case 'title': {
      if (isCommand) return true // игнорируем команды, ждём название
      if (msg.length < 3 || msg.length > 120) {
        await botSendRich(chatId, '⚠️ Название должно быть 3–120 символов. Попробуй ещё раз:')
        return true
      }
      st.title = msg
      st.step = 'text'
      await saveWizard(chatId, st)
      await ask(chatId, st)
      return true
    }
    case 'text': {
      if (msg === '/skip') st.text = ''
      else if (isCommand) return true
      else st.text = msg.slice(0, 3500)
      st.step = 'photo'
      await saveWizard(chatId, st)
      await ask(chatId, st)
      return true
    }
    case 'photo': {
      // фото приходит отдельным апдейтом (message.photo) — текст тут только /skip
      if (msg === '/skip') {
        st.photoFileId = undefined
        st.step = 'prizes_kind'
        await saveWizard(chatId, st)
        await ask(chatId, st)
        return true
      }
      await botSendRich(chatId, '🖼 Жду фото (скрепка → Галерея) или /skip — без картинки.')
      return true
    }
    case 'prizes_amount': {
      const n = Number(msg.replace(/[^\d]/g, ''))
      if (!isCommand && Number.isFinite(n) && n > 0) {
        await acceptPrizeAmount(chatId, st, n)
        return true
      }
      await botSendRich(chatId, '⚠️ Жду число больше 0 (или тапни кнопку-пресет).')
      return true
    }
    case 'prizes_winners': {
      const n = Number(msg.replace(/[^\d]/g, ''))
      if (!isCommand && Number.isFinite(n) && n >= 1 && n <= 1000) {
        await acceptPrizeWinners(chatId, st, Math.round(n))
        return true
      }
      await botSendRich(chatId, '⚠️ Жди число мест от 1 до 1000 (или тапни кнопку).')
      return true
    }
    case 'task_tickets': {
      const kind = st.taskQueue[0]
      const n = Number(msg.replace(/[^\d]/g, ''))
      if (!isCommand && kind && Number.isFinite(n) && n >= 1 && n <= 100) {
        await acceptTaskTickets(chatId, st, kind, Math.round(n))
        return true
      }
      await botSendRich(chatId, '⚠️ Жду число билетов 1–100 (или тапни кнопку).')
      return true
    }
    case 'task_param': {
      const kind = st.taskQueue[0]
      if (!kind) {
        st.step = 'losers'
        await saveWizard(chatId, st)
        await ask(chatId, st)
        return true
      }
      if (kind === 'promo') {
        if (/^\/gen$/i.test(msg) || msg === '🎲 Сгенерировать') {
          await acceptPromoCode(chatId, st, genPromoCode())
          return true
        }
        if (isCommand) return true
        const code = msg.replace(/\s+/g, '')
        if (!/^[A-Za-z0-9@_-]{4,32}$/.test(code)) {
          await botSendRich(chatId, '⚠️ Промокод: 4–32 символа, латиница/цифры. Ещё раз (или /gen):')
          return true
        }
        await acceptPromoCode(chatId, st, code)
        return true
      }
      if (kind === 'boost') {
        if (isCommand) return true
        const ch = msg.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').replace(/\/+$/, '').trim()
        if (!/^[A-Za-z0-9_]{4,64}$/.test(ch)) {
          await botSendRich(chatId, '⚠️ Жду @юзернейм канала (латиница). Ещё раз:')
          return true
        }
        await acceptBoostChannel(chatId, st, ch)
        return true
      }
      // activity/referral ждут кнопки-пресеты, но и число примем
      const n = Number(msg.replace(/[^\d]/g, ''))
      if (!isCommand && Number.isFinite(n) && n >= 1 && n <= 100_000) {
        if (kind === 'activity') await acceptSwipeGoal(chatId, st, Math.round(n))
        else await acceptReferralGoal(chatId, st, Math.round(n))
        return true
      }
      await botSendRich(chatId, '⚠️ Жду число (или тапни кнопку-пресет).')
      return true
    }
    case 'losers': {
      const n = Number(msg.replace(/[^\d]/g, ''))
      if (!isCommand && Number.isFinite(n) && n >= 0 && n <= 1_000_000) {
        st.losers = Math.round(n)
        st.step = 'duration'
        await saveWizard(chatId, st)
        await ask(chatId, st)
        return true
      }
      await botSendRich(chatId, '⚠️ Жду число свайпов (или тапни кнопку-пресет).')
      return true
    }
    case 'duration': {
      const n = Number(msg.replace(/[^\d]/g, ''))
      if (!isCommand && Number.isFinite(n) && n >= 1 && n <= 365 * 24) {
        st.hours = Math.round(n)
        st.step = 'channels'
        await saveWizard(chatId, st)
        await ask(chatId, st)
        return true
      }
      await botSendRich(chatId, '⚠️ Жду число ЧАСОВ от 1 до 8760 (или тапни кнопку).')
      return true
    }
    case 'channels': {
      if (msg === '/skip') st.channels = []
      else if (isCommand) return true
      else {
        st.channels = msg
          .split(/[\s,]+/)
          .map((c) => c.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').replace(/\/+$/, '').trim())
          .filter((c) => /^[A-Za-z0-9_]{4,64}$/.test(c))
          .slice(0, 5)
        if (st.channels.length === 0) {
          await botSendRich(chatId, '⚠️ Не распознал ни одного юзернейма. Формат: <code>@chan1 @chan2</code>, или /skip')
          return true
        }
      }
      st.step = 'confirm'
      await saveWizard(chatId, st)
      await ask(chatId, st)
      return true
    }
    default:
      // На шагах с кнопками текст не ждём
      return isCommand ? false : true
  }
}

/** Фото из мастера (message.photo) — ловим на шаге photo */
export async function handleWizardPhoto(
  chatId: number,
  photos: Array<{ file_id?: string; width?: number; height?: number }>,
): Promise<boolean> {
  const st = await loadWizard(chatId)
  if (!st || st.step !== 'photo') return false
  const best = [...photos]
    .filter((p) => typeof p.file_id === 'string')
    .sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0))
    .pop()
  if (!best?.file_id) {
    await botSendRich(chatId, '⚠️ Не смог получить фото — пришли ещё раз или /skip.')
    return true
  }
  st.photoFileId = best.file_id
  st.step = 'prizes_kind'
  await saveWizard(chatId, st)
  await ask(chatId, st)
  return true
}

function genPromoCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = 'GW-'
  for (let i = 0; i < 8; i++) out += abc[Math.floor(Math.random() * abc.length)]
  return out
}

/* ------------------------------ колбэки gww:* ------------------------------ */

type CbReply = (text?: string, alert?: boolean) => Promise<void>

/**
 * Колбэки мастера gww:*. Возвращает true, если колбэк обработан здесь
 * (гарантия: from.id — админ).
 */
export async function handleWizardCallback(
  chatId: number,
  fromId: number,
  isAdmin: boolean,
  data: string,
  reply: CbReply,
): Promise<boolean> {
  if (!data.startsWith('gww:')) return false
  if (!isAdmin) {
    await reply('Создание розыгрышей доступно только владельцу бота.', true)
    return true
  }
  const st = await loadWizard(chatId)
  if (!st) {
    await reply('Мастер розыгрыша не активен — начни заново: /newgw', true)
    return true
  }
  const [, action, arg1, arg2] = data.split(':')

  switch (action) {
    case 'cancel':
      await saveWizard(chatId, null)
      await reply('❌ Отменено')
      await botSendRich(chatId, '❌ Создание розыгрыша отменено. Черновик не сохранён.')
      return true

    case 'k': {
      // выбор типа приза
      const kind = (arg1 ?? 'custom') as Prize['kind']
      st.prizeDraft = { kind }
      st.step = 'prizes_amount'
      await saveWizard(chatId, st)
      await reply()
      await ask(chatId, st)
      return true
    }
    case 'a': {
      const n = Number(arg1)
      if (Number.isFinite(n) && n > 0) await acceptPrizeAmount(chatId, st, n, reply)
      else await reply('Некорректное число', true)
      return true
    }
    case 'w': {
      const n = Number(arg1)
      if (Number.isFinite(n) && n >= 1 && n <= 1000) await acceptPrizeWinners(chatId, st, Math.round(n), reply)
      else await reply('Некорректное число', true)
      return true
    }
    case 'more':
      st.prizeDraft = undefined
      st.step = 'prizes_kind'
      await saveWizard(chatId, st)
      await reply()
      await ask(chatId, st)
      return true
    case 'next': {
      if (st.step === 'prizes_more' || st.step === 'prizes_kind') {
        if (st.prizes.length === 0) {
          await reply('Добавь хотя бы один приз', true)
          return true
        }
        st.prizeDraft = undefined
        st.step = 'tasks'
        await saveWizard(chatId, st)
        await reply()
        await ask(chatId, st)
        return true
      }
      if (st.step === 'tasks') {
        // собираем очередь настроек включённых заданий
        st.taskQueue = st.tasks.filter((t) => t.enabled).map((t) => t.kind)
        await nextTaskStep(chatId, st, reply)
        return true
      }
      await reply()
      return true
    }
    case 't': {
      // toggle задания
      const kind = (arg1 ?? '') as GiveawayTaskKind
      if (!['activity', 'promo', 'referral', 'boost', 'forward'].includes(kind)) {
        await reply('Неизвестное задание', true)
        return true
      }
      const existing = st.tasks.find((t) => t.kind === kind)
      if (existing) existing.enabled = !existing.enabled
      else st.tasks.push({ ...taskOf(st, kind), enabled: true })
      await saveWizard(chatId, st)
      await reply()
      await ask(chatId, st) // перерисовать экран тогглов
      return true
    }
    case 'tk': {
      const kind = (arg1 ?? '') as GiveawayTaskKind
      const n = Number(arg2)
      if (st.taskQueue[0] !== kind || !Number.isFinite(n)) {
        await reply('Ой, шаг уже не тот — жми кнопки текущего сообщения', true)
        return true
      }
      await acceptTaskTickets(chatId, st, kind, Math.max(1, Math.min(100, Math.round(n))), reply)
      return true
    }
    case 'sg': {
      await acceptSwipeGoal(chatId, st, Math.max(1, Math.min(100_000, Number(arg1) || DEFAULT_SWIPE_GOAL)), reply)
      return true
    }
    case 'rg': {
      await acceptReferralGoal(chatId, st, Math.max(1, Math.min(1000, Number(arg1) || DEFAULT_REFERRAL_GOAL)), reply)
      return true
    }
    case 'gen':
      await acceptPromoCode(chatId, st, genPromoCode(), reply)
      return true
    case 'bc':
      await acceptBoostChannel(chatId, st, DEFAULT_BOOST_CHANNEL, reply)
      return true
    case 'ls': {
      const n = Number(arg1)
      st.losers = Number.isFinite(n) && n >= 0 ? Math.min(1_000_000, Math.round(n)) : 0
      st.step = 'duration'
      await saveWizard(chatId, st)
      await reply()
      await ask(chatId, st)
      return true
    }
    case 'dur': {
      const n = Number(arg1)
      st.hours = Number.isFinite(n) && n >= 1 ? Math.min(365 * 24, Math.round(n)) : 48
      st.step = 'channels'
      await saveWizard(chatId, st)
      await reply()
      await ask(chatId, st)
      return true
    }
    case 'pub': {
      if (st.step !== 'confirm') {
        await reply('Сначала закончи настройку', true)
        return true
      }
      await reply('Публикую…')
      const r = await publishWizardGiveaway(st)
      await saveWizard(chatId, null)
      if (r.ok) {
        await botSendRich(
          chatId,
          [
            '🎉 <b>Розыгрыш опубликован!</b>',
            '',
            `📣 ${escapeHtml(st.title ?? '')}`,
            `🎯 Призовых мест: ${totalWinners(st.prizes)}`,
            `🎫 Заданий: ${st.tasks.filter((t) => t.enabled).length}`,
            `⏰ Итоги: через ${st.hours >= 24 ? `${Math.round(st.hours / 24)} дн.` : `${st.hours} ч`}`,
            '',
            r.scheduled
              ? '⚠️ Пост в канал уйдёт со следующего тика планировщика (ретрай включён).'
              : 'Пост уже в канале — кнопка «Участвовать» живёт, счётчик обновляется в реальном времени.',
            '',
            'Участников и их билеты смотри в панели → Розыгрыши → «Участники».',
          ].join('\n'),
        )
      } else {
        await botSendRich(chatId, `⚠️ ${escapeHtml(r.error ?? 'Не удалось опубликовать')}. Черновик сохранён — опубликуешь из панели или начни заново: /newgw`)
      }
      return true
    }
    default:
      await reply()
      return true
  }
}

/* ------------------------------ шаги-помощники ------------------------------ */

async function acceptPrizeAmount(chatId: number, st: WizardState, n: number, reply?: CbReply): Promise<void> {
  const kind = st.prizeDraft?.kind ?? 'custom'
  if (!st.prizeDraft) st.prizeDraft = { kind }
  ;(st.prizeDraft as { kind: Prize['kind']; amount?: number }).amount = Math.min(100_000_000, Math.round(n))
  st.step = 'prizes_winners'
  await saveWizard(chatId, st)
  if (reply) await reply()
  await ask(chatId, st)
}

async function acceptPrizeWinners(chatId: number, st: WizardState, n: number, reply?: CbReply): Promise<void> {
  const draft = st.prizeDraft as { kind: Prize['kind']; amount?: number } | undefined
  const kind = draft?.kind ?? 'custom'
  const amount = Math.max(0, Math.round(draft?.amount ?? 0))
  const prize: Prize = { kind, amount, winners: n, label: prizeAutoLabel({ kind, amount }) }
  st.prizes.push(prize)
  st.prizeDraft = undefined
  st.step = 'prizes_more'
  await saveWizard(chatId, st)
  if (reply) await reply()
  await ask(chatId, st)
}

async function acceptTaskTickets(
  chatId: number,
  st: WizardState,
  kind: GiveawayTaskKind,
  n: number,
  reply?: CbReply,
): Promise<void> {
  const t = st.tasks.find((x) => x.kind === kind)
  if (t) t.tickets = n
  if (kind === 'forward') {
    // у задания «источники» нет параметров — сразу дальше по очереди
    await finishTaskParam(chatId, st, reply)
    return
  }
  st.step = 'task_param'
  await saveWizard(chatId, st)
  if (reply) await reply()
  await ask(chatId, st)
}

async function acceptSwipeGoal(chatId: number, st: WizardState, n: number, reply?: CbReply): Promise<void> {
  const kind = st.taskQueue[0]
  const t = kind ? st.tasks.find((x) => x.kind === kind) : undefined
  if (t) t.swipeGoal = n
  await finishTaskParam(chatId, st, reply)
}

async function acceptReferralGoal(chatId: number, st: WizardState, n: number, reply?: CbReply): Promise<void> {
  const kind = st.taskQueue[0]
  const t = kind ? st.tasks.find((x) => x.kind === kind) : undefined
  if (t) t.referralGoal = n
  await finishTaskParam(chatId, st, reply)
}

async function acceptPromoCode(chatId: number, st: WizardState, code: string, reply?: CbReply): Promise<void> {
  const kind = st.taskQueue[0]
  const t = kind ? st.tasks.find((x) => x.kind === kind) : undefined
  if (t) t.label = undefined
  st.step = 'losers'
  // промокод кладём в state отдельно (сохранится при создании розыгрыша)
  ;(st as WizardState & { promoCode?: string }).promoCode = code
  st.taskQueue.shift()
  await saveWizard(chatId, st)
  if (reply) await reply('Промокод сохранён 🔑')
  await ask(chatId, st)
}

async function acceptBoostChannel(chatId: number, st: WizardState, ch: string, reply?: CbReply): Promise<void> {
  const kind = st.taskQueue[0]
  const t = kind ? st.tasks.find((x) => x.kind === kind) : undefined
  if (t) t.boostChannel = ch
  await finishTaskParam(chatId, st, reply)
}

/** Задание настроено — очередь дальше или переход к утешительным */
async function finishTaskParam(chatId: number, st: WizardState, reply?: CbReply): Promise<void> {
  st.taskQueue.shift()
  await saveWizard(chatId, st)
  if (reply) await reply()
  if (st.taskQueue.length > 0) {
    st.step = 'task_tickets'
    await saveWizard(chatId, st)
    await ask(chatId, st)
  } else {
    st.step = 'losers'
    await saveWizard(chatId, st)
    await ask(chatId, st)
  }
}

/** После «Дальше» на экране тогглов: очередь настроек или сразу к утешительным */
async function nextTaskStep(chatId: number, st: WizardState, reply?: CbReply): Promise<void> {
  st.taskQueue = st.tasks.filter((t) => t.enabled).map((t) => t.kind)
  if (st.taskQueue.length > 0) {
    st.step = 'task_tickets'
    await saveWizard(chatId, st)
    if (reply) await reply()
    await ask(chatId, st)
  } else {
    st.step = 'losers'
    await saveWizard(chatId, st)
    if (reply) await reply()
    await ask(chatId, st)
  }
}

/* ------------------------------- публикация ------------------------------- */

export type PublishResult = { ok: boolean; scheduled?: boolean; error?: string }

async function publishWizardGiveaway(st: WizardState): Promise<PublishResult> {
  if (!st.title || st.prizes.length === 0) return { ok: false, error: 'Не заполнены название или призы' }
  const now = Date.now()
  const g = await db.giveaway.create({
    data: {
      title: st.title.slice(0, 120),
      text: st.text ?? '',
      prizes: JSON.stringify(st.prizes),
      channels: JSON.stringify(st.channels),
      tasks: serializeTasks(st.tasks),
      promoCode: (st as WizardState & { promoCode?: string }).promoCode ?? null,
      losersRewardSwipes: st.losers,
      photoFileId: st.photoFileId ?? null,
      buttonStyle: 'primary',
      buttonEmoji: '🎉',
      buttonEmojiId: '',
      startAt: new Date(now - 1000),
      endAt: new Date(now + st.hours * 3600_000),
      status: 'scheduled',
    },
  })

  const channel = await publishChannel()
  const r = await publishGiveawayPost({
    id: g.id,
    title: g.title,
    text: g.text,
    prizes: g.prizes,
    channels: g.channels,
    buttonStyle: g.buttonStyle,
    buttonEmoji: g.buttonEmoji,
    buttonEmojiId: g.buttonEmojiId,
    endAt: g.endAt,
    tasks: g.tasks,
    losersRewardSwipes: g.losersRewardSwipes,
    photoFileId: g.photoFileId,
  })
  if (r.ok && r.chatId && r.messageId) {
    await db.giveaway.update({
      where: { id: g.id },
      data: { status: 'active', chatId: r.chatId, messageId: r.messageId },
    })
    const { invalidateActiveCache } = await import('@/lib/giveaway-tickets')
    invalidateActiveCache()
    // v5.47: база знаний ИИ должна сразу узнать о новом розыгрыше
    const { invalidateAiKnowledge } = await import('@/lib/ai-knowledge')
    invalidateAiKnowledge()
    return { ok: true }
  }
  // публикация не прошла — планировщик ретраит (checkDueGiveaways), юзеру warn
  console.error('[giveaway-wizard] publish failed', g.id, r.error)
  return { ok: true, scheduled: true }
}

/* --------------------------- DM после «Участвовать» --------------------------- */

/**
 * После успешной заявки на розыгрыш — приветственная карточка заданий в ЛС
 * (участник сразу видит, как заработать билеты).
 */
export async function sendJoinOnboarding(
  chatId: number,
  giveawayId: string,
  userId: string,
): Promise<void> {
  try {
    const g = await db.giveaway.findUnique({
      where: { id: giveawayId },
      select: { id: true, title: true, tasks: true, promoCode: true, startAt: true },
    })
    if (!g) return
    const tasks = parseTasks(g.tasks).filter((t) => t.enabled)
    if (tasks.length === 0) return

    const entry = await db.giveawayEntry.findUnique({
      where: { giveawayId_userId: { giveawayId, userId } },
      select: { ticketsCount: true },
    })
    const tgId = Number(userId.slice('tg_'.length))
    const referralLink = Number.isInteger(tgId) && tgId > 0 ? await referralLinkOf(tgId) : null

    const lines = [
      `🎉 Ты в игре — «${escapeHtml(g.title)}»!`,
      '',
      `🎫 Сейчас билетов: <b>${entry?.ticketsCount ?? 0}</b>. Выполни задания — шанс вырастет:`,
      '',
      ...tasks.map((t) => `• ${escapeHtml(taskTitle(t))} — <b>+${t.tickets} 🎫</b>`),
      '',
      'Смотри прогресс в любой момент: /mygw',
    ]

    const keyboard: BotButton[][] = []
    if (tasks.some((t) => t.kind === 'boost')) {
      keyboard.push([{ label: '🚀 Проверить буст', callback_data: `gwb:${g.id}`, style: 'primary' }])
    }
    if (referralLink) keyboard.push([{ label: '🤝 Пригласить друзей за билеты', url: referralLink!, style: 'primary' }])

    await botSendRich(chatId, lines.join('\n'), keyboard.length > 0 ? { keyboard } : {})
  } catch (e) {
    console.error('[giveaway-wizard] onboarding', e)
  }
}

/**
 * Текстовое сообщение от юзера: совпал с промокодом активного розыгрыша?
 * Вызывается ДО остальной обработки текстов (кроме мастера/команд).
 * Возвращает true — промокод был обработан (совпал или явно неверный формат).
 */
export async function tryRedeemPromoText(
  chatId: number,
  userId: string,
  username: string | undefined,
  firstName: string | undefined,
  tgId: number,
  text: string,
): Promise<boolean> {
  const clean = text.trim().replace(/^\/promo\s+/i, '')
  if (clean.length < 4 || clean.length > 40) return false
  // Промокоды задаются мастером (латиница/цифры, может начинаться с GW-)
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(clean)) return false
  const { activeGiveaways, redeemPromoCode } = await import('@/lib/giveaway-tickets')
  const gws = (await activeGiveaways()).filter((g) => g.promoCode)
  if (gws.length === 0) return false
  const hit = gws.some((g) => g.promoCode!.toLowerCase() === clean.toLowerCase())
  if (!hit) return false

  const r = await redeemPromoCode(
    { id: userId, tgId, username, firstName },
    clean,
  )
  await botSendRich(chatId, r.message)
  return true
}

/** callback gwb:<giveawayId> — «Проверить буст» */
export async function handleBoostCheck(
  cbId: string,
  giveawayId: string,
  from: { id: number; username?: string; first_name?: string } | undefined,
  chatId: number | undefined,
  reply: (text?: string, alert?: boolean) => Promise<void>,
): Promise<void> {
  if (!from || typeof from.id !== 'number' || from.id <= 0 || !chatId) {
    await reply()
    return
  }
  const r = await import('@/lib/giveaway-tickets').then((m) =>
    m.checkBoostTask(giveawayId, {
      id: `tg_${from.id}`,
      tgId: from.id,
      username: from.username,
      firstName: from.first_name,
    }),
  )
  await reply(r.ok && r.message.startsWith('✅') ? r.message : undefined, r.ok ? false : true)
  if (!r.ok && !r.message.startsWith('🚀')) return // служебная ошибка — только алерт
  await botSendRich(chatId, r.message)
}
