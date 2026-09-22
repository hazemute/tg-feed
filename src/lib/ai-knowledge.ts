import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { APP_VERSION } from '@/lib/version'
import { TIER_PRICES, AI_SEARCH_DAILY_LIMIT, PRO_PROMOTE_MONTHLY_LIMIT, PROMOTE_PACK } from '@/lib/tiers'
import { SWP_PER_RUB, AI_MTOK_IN_SWP, AI_MTOK_OUT_SWP, AI_FREE_MULT, AI_PRO_MULT } from '@/lib/wallet'
import { parsePrizes, prizesLabel } from '@/lib/giveaways'
import { parseTasks, taskTitle } from '@/lib/giveaway-tickets'

/**
 * ЖИВАЯ БАЗА ЗНАНИЙ ИИ (v5.47) — единый источник фактов для ВСЕХ нейросетей
 * сервиса: Snap Search (ИИ-поиск), Snap Ассистент (контентщик), нейросотрудник
 * поддержки. Больше нигде факты руками не дублируются: цены тарифов берутся
 * из TIER_PRICES, курс — из SWP_PER_RUB, лимиты — из tiers.ts, розыгрыши —
 * из БД. Поменял цену в коде → ИИ узнает сам, без правки промптов.
 *
 * КАК РАБОТАЕТ АВТООБНОВЛЕНИЕ:
 *  1. buildKnowledge() собирает статические факты (из кода) и живые (из БД:
 *     активные розыгрыши, категории, счётчики сервиса).
 *  2. Считается хэш источников. Снапшот базы знаний хранится в
 *     SystemSetting(key='ai_knowledge') — база знаний ЖИВЁТ В БД.
 *  3. Хэш источников совпал → отдаём снапшот из БД (пересборки нет).
 *     Не совпал (изменилась цена/версия/розыгрыш) → пересборка + запись.
 *  4. In-memory кэш 45с экономит чтения; invalidateAiKnowledge() сбрасывает
 *     кэш мгновенно (хуки: панель розыгрышей, смена тарифов/настроек).
 */

const KB_KEY = 'ai_knowledge'
const MEM_TTL_MS = 45_000
const SNAP_FRESH_MS = 5 * 60_000 // точные счётчики в снапшоте живут до 5 минут

export type AiKnowledge = {
  /** Хэш источников, на которых собрана база */
  hash: string
  builtAt: string
  version: string
  /** Полный блок для поддержки и ассистента */
  full: string
  /** Компактный блок для Snap Search (промпт короче — дешевле токены) */
  compact: string
  /** Живая статистика сервиса отдельной строкой (для get_service_facts) */
  live: string
}

/* ========================= статические факты (из кода) ========================= */

type SourceDigest = {
  version: string
  released: unknown
  prices: string
  giveaways: string
}

function staticFacts(): string[] {
  const plus = TIER_PRICES.plus
  const pro = TIER_PRICES.pro
  const rub = (kop: number) => (kop / 100).toLocaleString('ru-RU')
  return [
    `Версия приложения: ${APP_VERSION}.`,
    `Валюта: свайпы. Курс: ${SWP_PER_RUB} свайпов = 1 ₽ (1 свайп = 0,2 копейки). Кошелёк в профиле: рубли и свайпы, конвертация в обе стороны (свайпы → рубли от ${SWP_PER_RUB}), журнал операций. Пополнение: карта / Telegram Stars / TON.`,
    `За что тратятся свайпы: только нейросети — Snap Search сверх бесплатной нормы и Snap Ассистент. Тарификация по токенам OpenRouter: ${AI_MTOK_IN_SWP} свайпов за 1 млн входных + ${AI_MTOK_OUT_SWP} за 1 млн выходных — ЭТО БАЗОВЫЕ ЦЕНЫ ПЛЮСА. Множитель тира: Free — ×${AI_FREE_MULT} (в 3 раза дороже: нейросети дороги, но подписка Plus/Pro их резко дешевит), Plus — ×1, Pro — ×${AI_PRO_MULT}. Генерация картинки — ${Math.ceil(250 * AI_FREE_MULT)} свайпов на Free, 250 на Plus, ${Math.ceil(250 * AI_PRO_MULT)} на Pro. Лайки, подписки, закладки, комментарии, лента, перевод, саммари, озвучка — бесплатны.`,
    `Тариф Free (бесплатно): ${AI_SEARCH_DAILY_LIMIT} ИИ-поиска (Snap Search) в сутки; лайк/комментарий/закладка — после входа в Telegram (ленивая регистрация).`,
    `Snap Plus: ${rub(plus.monthKop)} ₽/мес или ${rub(plus.yearKop)} ₽/год (${plus.monthStars} / ${plus.yearStars} Stars) — безлимитный ИИ-поиск, инкогнито (просмотры не видны в детальной статистике), приоритетная скорость медиа, анимированные премиум-эмодзи.`,
    `Snap Pro: ${rub(pro.monthKop)} ₽/мес или ${rub(pro.yearKop)} ₽/год (${pro.monthStars} / ${pro.yearStars} Stars) — всё из Plus + ИИ-контентщик для своего канала (анализ стиля → пост → картинка → публикация в TG), ${PRO_PROMOTE_MONTHLY_LIMIT} бесплатное продвижение постов в ленту в месяц, премиум-бейдж автора, CTA-кнопка. Дополнительные продвижения — пакетами: ${PROMOTE_PACK.count} за ${rub(PROMOTE_PACK.priceKop)} ₽ (не сгорают).`,
    'Оплата: карта / Telegram Stars / TON — через кошелёк или бота @tgswipe_bot.',
    'Документы: соглашение tg-swipe.vercel.app/terms · конфиденциальность /privacy · тарифы /pricing · контакты /contacts.',
    'Фичи ленты: категории-вкладки, фильтры «Медиа/24ч/Топ», «Не интересно», закладки, комментарии (сворачиваемые ветки ответов, лайки), подписки на каналы, «Краткое содержание» (ИИ), перевод, озвучка «Слушать», поиск по постам и каталогу каналов, тренды.',
    'Мой канал (авторам): привязка через бота @tgswipe_bot (в админы → авто-подтверждение), тизер-режимы (полностью/обрезка/блюр), статистика, реклама CPA (бюджет с эскроу), продвижение постов (Pro).',
    'Розыгрыши: пост в канале с кнопкой «Участвовать», билетные задания (активность/промокод/рефералы/буст), взвешенный по билетам рандом без повторных побед, утешительные свайпы проигравшим, призы автоматически.',
    'Задания (вкладка «Задания») — свайпы за: подписку на @SnapTeamDev (150) и @liveMiniTim (100), чат комьюнити (150), буст канала (250), TikTok @snapteamdev (300 — юзер присылает скриншот, подписку распознаёт ИИ), заполнение профиля (50), чтение постов в ленте (75 и 120), приглашение друга (100). Ежедневный вход: +15 за день, каждые 7 дней подряд — бонус +100. Если отписаться от цели после получения — задание аннулируется, награда списывается в двойном размере.',
    'Бот @tgswipe_bot: вход в приложение, язык (Ru/En), розыгрыши, оплата тарифов, уведомления в ЛС (ответ на комментарий, лайк, подписка, призы) с кнопкой «Перейти к уведомлению».',
  ]
}

/* ============================ живые факты (из БД) ============================ */

async function liveFacts(): Promise<{ lines: string[]; digest: string }> {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000)

  const [channels, posts24h, usersTotal, categories, giveaways] = await Promise.all([
    db.channel.count({ where: { status: 'active' } }),
    db.post.count({ where: { publishedAt: { gte: dayAgo } } }),
    db.user.count(),
    db.category.findMany({ orderBy: { order: 'asc' }, select: { title: true } }).catch(() => []),
    db.giveaway.findMany({
      where: { status: { in: ['active', 'scheduled'] }, endAt: { gt: now } },
      orderBy: { endAt: 'asc' },
      take: 3,
      select: {
        id: true,
        title: true,
        status: true,
        endAt: true,
        prizes: true,
        tasks: true,
        createdAt: true,
        _count: { select: { entries: true } },
      },
    }),
  ])

  const catLine =
    categories.length > 0 ? `Категории ленты: ${categories.map((c) => c.title).join(', ')}.` : ''

  const gwLines: string[] = []
  for (const g of giveaways) {
    const prizes = prizesLabel(parsePrizes(g.prizes))
    const tasks = parseTasks(g.tasks).filter((t) => t.enabled)
    const taskStr = tasks.length > 0 ? ` Задания: ${tasks.map(taskTitle).join(', ')}.` : ''
    const when = g.status === 'scheduled' ? 'стартует скоро' : `итоги ${g.endAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    gwLines.push(
      `• «${g.title}» — призы: ${prizes || 'не указаны'}; ${when}; участников: ${g._count.entries}.${taskStr}`,
    )
  }

  const lines = [
    `Сервис сейчас: ${channels} активных каналов, ${posts24h} постов за 24 часа, ${usersTotal} пользователей.`,
    catLine,
    gwLines.length > 0
      ? `Активные розыгрыши:\n${gwLines.join('\n')}`
      : 'Активных розыгрышей сейчас нет.',
  ].filter(Boolean)

  const digest = JSON.stringify([
    channels,
    Math.floor(posts24h / 50), // счётчики дрожат постоянно — грубое ведро, чтобы не пересобирать базу каждый просмотр
    usersTotal,
    // статус/структура розыгрышей — да; счётчик участников — НЕТ (иначе каждая
    // заявка дёргает пересборку; точные цифры обновляются по свежести снапшота)
    giveaways.map((g) => [g.id, g.status, g.createdAt.toISOString()]),
  ])

  return { lines, digest }
}

/* =============================== сборка =============================== */

function hashOf(s: SourceDigest): string {
  return createHash('sha1')
    .update(JSON.stringify([s.version, s.released, s.prices, s.giveaways]))
    .digest('hex')
}

function renderBlocks(facts: string[], liveLines: string[]): Pick<AiKnowledge, 'full' | 'compact' | 'live'> {
  const full = [
    '=== БАЗА ЗНАНИЙ СЕРВИСА (актуальные факты, автообновляется) ===',
    ...facts,
    ...liveLines,
    '=== конец базы знаний ===',
  ].join('\n')
  const compact = [
    '=== О СЕРВИСЕ (факты) ===',
    `Tg Swipe v${APP_VERSION} — лента открытых Telegram-каналов. Курс ${SWP_PER_RUB} свайпов = 1 ₽; Free: ${AI_SEARCH_DAILY_LIMIT} ИИ-поиска/сутки; Snap Plus ${TIER_PRICES.plus.monthKop / 100} ₽/мес — безлимитный поиск; Snap Pro ${TIER_PRICES.pro.monthKop / 100} ₽/мес — + ИИ-контентщик. Оплата: карта/Stars/TON.`,
    ...liveLines,
    '=== конец ===',
  ].join('\n')
  return { full, compact, live: liveLines.join('\n') }
}

async function buildKnowledge(): Promise<AiKnowledge> {
  const [released, prices] = await Promise.all([
    db.systemSetting.findUnique({ where: { key: 'released' }, select: { value: true } }).catch(() => null),
    Promise.resolve(JSON.stringify(TIER_PRICES)),
  ])
  const live = await liveFacts()

  const digest: SourceDigest = {
    version: APP_VERSION,
    released: released?.value ?? null,
    prices,
    giveaways: live.digest,
  }
  const hash = hashOf(digest)

  // Снапшот в БД свежий И источники не менялись → не пересобираем
  const row = await db.systemSetting.findUnique({ where: { key: KB_KEY } }).catch(() => null)
  if (row) {
    try {
      const snap = JSON.parse(row.value) as AiKnowledge
      const fresh = Date.now() - new Date(snap.builtAt).getTime() < SNAP_FRESH_MS
      if (snap.hash === hash && snap.version === APP_VERSION && fresh) return snap
    } catch {
      /* битый снапшот — пересоберём */
    }
  }

  const snapshot: AiKnowledge = {
    hash,
    builtAt: new Date().toISOString(),
    version: APP_VERSION,
    ...renderBlocks(staticFacts(), live.lines),
  }
  await db.systemSetting
    .upsert({
      where: { key: KB_KEY },
      create: { key: KB_KEY, value: JSON.stringify(snapshot) },
      update: { value: JSON.stringify(snapshot) },
    })
    .catch(() => {})
  return snapshot
}

/* ============================ публичный API ============================ */

let mem: { at: number; data: AiKnowledge } | null = null
/*
 * Task 8-b: single-flight сборки. Прежде при истечении 45с-кэша каждый
 * параллельный запрос запускал СВОЮ сборку (~8 SQL-запросов: count каналов/
 * постов/юзеров + розыгрыши) — под наплывом это серийный удар по пулу ровно
 * в момент пиковой нагрузки. Теперь бёрст ждёт одну сборку.
 */
let building: Promise<AiKnowledge> | null = null

/** База знаний с двухуровневым кэшем (память 45с → БД → пересборка) */
export async function getAiKnowledge(): Promise<AiKnowledge> {
  if (mem && Date.now() - mem.at < MEM_TTL_MS) return mem.data
  if (building) return building
  building = (async () => {
    const data = await buildKnowledge()
    mem = { at: Date.now(), data }
    return data
  })()
  try {
    return await building
  } finally {
    building = null
  }
}

/** Мгновенный сброс кэша — вызывать после изменения розыгрышей/тарифов/настроек */
export function invalidateAiKnowledge(): void {
  mem = null
}

/** Блок для системного промпта: mode='full' (поддержка/ассистент) | 'compact' (поиск) */
export async function knowledgeBlock(mode: 'full' | 'compact'): Promise<string> {
  const kb = await getAiKnowledge()
  return mode === 'full' ? kb.full : kb.compact
}
