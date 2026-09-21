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
 * Экономика (500 свайпов = 1 ₽): лёгкие одноразовые ≈ 150+100+150+50+75+120+100
 * = 745 свайпов (~1,5 ₽) — «не легко больше ~800»; TikTok (+300) и буст (+250)
 * требуют реальных действий; ежедневный вход — 15/день (+100 за каждые 7 дней).
 */
export const DEFAULT_QUESTS: SeedQuest[] = [
  {
    id: 'q_daily_checkin',
    title: 'Ежедневный вход',
    description: 'Заходи в приложение каждый день — за каждые 7 дней подряд бонус +100',
    kind: 'daily_checkin',
    target: 'none',
    rewardSwp: 15,
    sort: 5,
  },
  {
    id: 'q_official_channel',
    title: 'Подпишись на официальный канал',
    description: 'Канал команды Snap: новости, обновления и розыгрыши',
    kind: 'subscribe',
    target: 'snapteamdev',
    rewardSwp: 150,
    sort: 10,
  },
  {
    id: 'q_profile_setup',
    title: 'Заполни профиль',
    description: 'Установи аватар и имя во вкладке «Профиль»',
    kind: 'profile_setup',
    target: 'none',
    rewardSwp: 50,
    sort: 15,
  },
  {
    id: 'q_liveMiniTim',
    title: 'Подпишись на @liveMiniTim',
    description: 'Авторские миниаппы и подборки от партнёров',
    kind: 'subscribe',
    target: 'liveminitim',
    rewardSwp: 100,
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
    rewardSwp: 300,
    sort: 40,
  },
  {
    id: 'q_boost',
    title: 'Буст нашего канала',
    description: 'Отдай любой буст каналу @SnapTeamDev и нажми «Получить»',
    kind: 'boost',
    target: 'snapteamdev',
    rewardSwp: 250,
    sort: 50,
  },
  {
    id: 'q_read10',
    title: 'Прочитай 10 постов',
    description: 'Открой 10 постов в ленте — счётчик растёт сам',
    kind: 'activity_milestone',
    target: 'posts:10',
    rewardSwp: 75,
    sort: 60,
  },
  {
    id: 'q_read50',
    title: 'Прочитай 50 постов',
    description: 'Открой 50 постов в ленте — для тех, кто листает всерьёз',
    kind: 'activity_milestone',
    target: 'posts:50',
    rewardSwp: 120,
    sort: 70,
  },
  {
    id: 'q_referral',
    title: 'Пригласи друга',
    description: 'Друг зайдёт в миниапп по твоей ссылке — награда твоя',
    kind: 'referral',
    target: '1',
    rewardSwp: 100,
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
