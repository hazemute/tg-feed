import { db } from '@/lib/db'
import { normalizeQuestTargetForKind } from '@/lib/quests'

/**
 * СИД ЗАДАНИЙ ПО УМОЛЧАНИЮ (v5.70).
 *
 * Идемпотентный create-only сид: квесты создаются по стабильным id ТОЛЬКО если
 * их ещё нет (P2002/exists → пропускаем). Награды/тексты существующих заданий
 * никогда не перетираются — правки админа из панели святы. Вызывается из
 * instrumentation (старт сервера — и в проде, и локально) и fire-and-forget
 * из GET /api/quests (самолечение, если БД моргнула на старте).
 */

export type SeedQuest = {
  id: string
  title: string
  description: string
  kind: Parameters<typeof normalizeQuestTargetForKind>[1]
  target: string
  link?: string
  rewardSwp: number
  sort: number
}

/**
 * Экономика v5.74 (rebalance ×4; 500 свайпов = 1 ₽): цены ИИ выросли в 4 раза
 * (AI_MTOK_*_SWP), поэтому и задания дают в 4 раза больше — «на один запрос
 * стало хватать еле-еле» больше не звучит. Лёгкие одноразовые ≈
 * 600+400+600+200+300+480+400 = 2980 свайпов (~6 ₽); TikTok (+1200) и буст
 * (+1000) требуют реальных действий; ежедневный вход — 60/день
 * (+400 за каждые 7 дней, DAILY_STREAK_BONUS тоже ×4).
 */

/**
 * ПОВЫШЕНИЕ НАГРАД v5.74: старое значение → новое. Применяется идемпотентно:
 * квест апгрейдится ТОЛЬКО если его текущая награда равна старой дефолтной
 * (админскую правку из панели не трогаем — святое).
 */
/** v5.74: заодно правим устаревшие суммы в описаниях (только нетронутые дефолты) */
export const REWARD_DESC_FIXES: Array<{ id: string; from: string; to: string }> = [
  {
    id: 'q_daily_checkin',
    from: 'Заходи в приложение каждый день — за каждые 7 дней подряд бонус +100',
    to: 'Заходи в приложение каждый день — за каждые 7 дней подряд бонус +400',
  },
]

export const REWARD_BUMPS: Record<string, { from: number; to: number }> = {
  q_daily_checkin: { from: 15, to: 60 },
  q_official_channel: { from: 150, to: 600 },
  q_profile_setup: { from: 50, to: 200 },
  q_liveMiniTim: { from: 100, to: 400 },
  q_join_chat: { from: 150, to: 600 },
  q_tiktok: { from: 300, to: 1200 },
  q_boost: { from: 250, to: 1000 },
  q_read10: { from: 75, to: 300 },
  q_read50: { from: 120, to: 480 },
  q_referral: { from: 100, to: 400 },
}
export const DEFAULT_QUESTS: SeedQuest[] = [
  {
    id: 'q_daily_checkin',
    title: 'Ежедневный вход',
    description: 'Заходи в приложение каждый день — за каждые 7 дней подряд бонус +400',
    kind: 'daily_checkin',
    target: 'none',
    rewardSwp: 60,
    sort: 5,
  },
  {
    id: 'q_official_channel',
    title: 'Подпишись на официальный канал',
    description: 'Канал команды Snap: новости, обновления и розыгрыши',
    kind: 'subscribe',
    target: 'snapteamdev',
    rewardSwp: 600,
    sort: 10,
  },
  {
    id: 'q_profile_setup',
    title: 'Заполни профиль',
    description: 'Установи аватар и имя во вкладке «Профиль»',
    kind: 'profile_setup',
    target: 'none',
    rewardSwp: 200,
    sort: 15,
  },
  {
    id: 'q_liveMiniTim',
    title: 'Подпишись на @liveMiniTim',
    description: 'Авторские миниаппы и подборки от партнёров',
    kind: 'subscribe',
    target: 'liveminitim',
    rewardSwp: 400,
    sort: 20,
  },
  {
    id: 'q_join_chat',
    title: 'Вступай в наш чат',
    description: 'Живое комьюнити: обсуждения, помощь и анонсы первыми',
    kind: 'join_chat',
    target: 'https://t.me/+0_4es_TTNkBkNGNi',
    rewardSwp: 150,
    sort: 30,
  },
  {
    id: 'q_tiktok',
    title: 'Подпишись на наш TikTok',
    description:
      '1) Подпишись на @snapteamdev в TikTok → 2) сделай скриншот профиля с кнопкой «Вы подписаны» → 3) нажми «Проверить» и загрузи скриншот',
    kind: 'tiktok_follow',
    target: 'snapteamdev',
    link: 'https://tiktok.com/@snapteamdev',
    rewardSwp: 1200,
    sort: 40,
  },
  {
    id: 'q_boost',
    title: 'Буст нашего канала',
    description: 'Отдай любой буст каналу @SnapTeamDev и нажми «Получить»',
    kind: 'boost',
    target: 'snapteamdev',
    rewardSwp: 1000,
    sort: 50,
  },
  {
    id: 'q_read10',
    title: 'Прочитай 10 постов',
    description: 'Открой 10 постов в ленте — счётчик растёт сам',
    kind: 'activity_milestone',
    target: 'posts:10',
    rewardSwp: 300,
    sort: 60,
  },
  {
    id: 'q_read50',
    title: 'Прочитай 50 постов',
    description: 'Открой 50 постов в ленте — для тех, кто листает всерьёз',
    kind: 'activity_milestone',
    target: 'posts:50',
    rewardSwp: 480,
    sort: 70,
  },
  {
    id: 'q_referral',
    title: 'Пригласи друга',
    description: 'Друг зайдёт в миниапп по твоей ссылке — награда твоя',
    kind: 'referral',
    target: '1',
    rewardSwp: 400,
    sort: 80,
  },
]

let lastSeedCheckAt = 0
const SEED_CHECK_INTERVAL_MS = 10 * 60_000
let seedRunning: Promise<{ created: number; skipped: number }> | null = null

/**
 * Создать отсутствующие дефолтные задания. Повторные вызовы внутри 10 минут —
 * no-op (кроме force). Возвращает сколько создано/пропущено.
 */
export async function seedDefaultQuests(opts?: {
  force?: boolean
}): Promise<{ created: number; skipped: number }> {
  if (seedRunning) return seedRunning
  if (!opts?.force && Date.now() - lastSeedCheckAt < SEED_CHECK_INTERVAL_MS) {
    return { created: 0, skipped: 0 }
  }
  lastSeedCheckAt = Date.now()

  seedRunning = (async () => {
    let created = 0
    let skipped = 0
    // v5.74: поднятие наград существующих квестов (только нетронутые админом —
    // текущая награда равна старому дефолту). Один updateMany на бамп-пару.
    for (const [id, bump] of Object.entries(REWARD_BUMPS)) {
      try {
        await db.quest.updateMany({
          where: { id, rewardSwp: bump.from },
          data: { rewardSwp: bump.to },
        })
      } catch (e) {
        console.error('[quests-seed] reward bump failed', id, e)
      }
    }
    for (const d of REWARD_DESC_FIXES) {
      try {
        await db.quest.updateMany({ where: { id: d.id, description: d.from }, data: { description: d.to } })
      } catch {
        /* описание — не критично */
      }
    }
    for (const q of DEFAULT_QUESTS) {
      try {
        const exists = await db.quest.findUnique({ where: { id: q.id }, select: { id: true } })
        if (exists) {
          skipped++
          continue
        }
        const norm = normalizeQuestTargetForKind(q.target, q.kind) ?? { target: q.target, targetType: 'none' }
        await db.quest.create({
          data: {
            id: q.id,
            title: q.title,
            description: q.description,
            kind: q.kind,
            target: norm.target,
            targetType: norm.targetType,
            link: q.link ?? null,
            rewardSwp: q.rewardSwp,
            active: true,
            sort: q.sort,
          },
        })
        created++
        console.log(`[quests-seed] created ${q.id} (+${q.rewardSwp} swp, ${q.kind})`)
      } catch (e) {
        // P2002 — квест успел создаться параллельным инстансом: это ок
        if ((e as { code?: string })?.code === 'P2002') {
          skipped++
          continue
        }
        console.error('[quests-seed] failed', q.id, e)
      }
    }
    return { created, skipped }
  })()

  try {
    return await seedRunning
  } finally {
    seedRunning = null
  }
}
