/** QA v5.93: машина состояний стрика/цели недели (временный скрипт — не коммитить в релизную ветку без нужды). */
import { db } from '../src/lib/db'
import { recordRead, readingWeekKey, dayKeyUtc, WEEK_GOAL } from '../src/lib/reading'

const UID = 'tg_777000'
let swipesBefore = 0

async function reset(): Promise<void> {
  await db.readingDay.deleteMany({ where: { userId: UID } })
  await db.readingStreak.deleteMany({ where: { userId: UID } })
  const u = await db.user.findUnique({ where: { id: UID }, select: { swipes: true } })
  swipesBefore = u?.swipes ?? 0
}

async function seed(data: { streak: number; lastDate: string; freezes: number; weekKey?: string; weekReads?: number; weekRewardKey?: string }): Promise<void> {
  await db.readingStreak.deleteMany({ where: { userId: UID } })
  await db.readingStreak.create({
    data: {
      userId: UID,
      streak: data.streak,
      bestStreak: Math.max(data.streak, 3),
      lastDate: data.lastDate,
      freezes: data.freezes,
      totalReads: 100,
      weekKey: data.weekKey ?? readingWeekKey(),
      weekReads: data.weekReads ?? 0,
      weekRewardKey: data.weekRewardKey ?? '',
    },
  })
}

async function swipesDelta(): Promise<number> {
  const u = await db.user.findUnique({ where: { id: UID }, select: { swipes: true } })
  return (u?.swipes ?? 0) - swipesBefore
}

function shift(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) failures += 1
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ` → ${extra}` : ''}`)
}

const now = new Date()

async function main(): Promise<void> {
  await reset()

  // 1) Первое прочтение — стрик 1
  const r1 = await recordRead(UID, 'qa_post_1', now)
  check('первое прочтение: streak=1', r1.streak === 1 && r1.counted)

  // 2) Дедуп того же поста в тот же день
  const r2 = await recordRead(UID, 'qa_post_1', now)
  check('дедуп того же поста: counted=false', r2.counted === false)

  // 3) Другой пост в тот же день — стрик не растёт, счётчик дня растёт
  const r3 = await recordRead(UID, 'qa_post_2', now)
  check('второй пост дня: streak остаётся 1', r3.streak === 1 && r3.counted)

  // 4) Продолжение: вчера streak=4 → сегодня 5
  await seed({ streak: 4, lastDate: dayKeyUtc(shift(1)) })
  const r4 = await recordRead(UID, 'qa_post_3', now)
  check('вчера 4 → сегодня 5', r4.streak === 5)

  // 5) Заморозка: позавчера, freezes=1, streak=9 → 10, заморозка списана
  await seed({ streak: 9, lastDate: dayKeyUtc(shift(2)), freezes: 1 })
  const r5 = await recordRead(UID, 'qa_post_4', now)
  const row5 = await db.readingStreak.findUnique({ where: { userId: UID } })
  check('заморозка покрыла день: streak 9→10', r5.streak === 10)
  check('заморозка списана: freezes=0', row5?.freezes === 0)

  // 6) Сброс: 5 дней тишины → streak=1, заморозки НЕ тратятся
  await seed({ streak: 8, lastDate: dayKeyUtc(shift(5)), freezes: 2 })
  const r6 = await recordRead(UID, 'qa_post_5', now)
  const row6 = await db.readingStreak.findUnique({ where: { userId: UID } })
  check('длинная пауза: streak сброшен в 1', r6.streak === 1)
  check('заморозки сохранены (2)', row6?.freezes === 2)

  // 7) Веха 7: вчера 6 → сегодня 7 = +500 свайпов и +1 заморозка
  await seed({ streak: 6, lastDate: dayKeyUtc(shift(1)), freezes: 0 })
  const deltaBefore = await swipesDelta()
  const r7 = await recordRead(UID, 'qa_post_6', now)
  const deltaAfter = await swipesDelta()
  const row7 = await db.readingStreak.findUnique({ where: { userId: UID } })
  check('веха 7 дней: streak=7', r7.streak === 7)
  check('веха 7 дней: +500 свайпов', deltaAfter - deltaBefore === 500, `delta=${deltaAfter - deltaBefore}`)
  check('веха 7 дней: +1 заморозка', row7?.freezes === 1)

  // 8) Цель недели: 29/30 в текущей неделе → прочтение = 30 → +300, флаг недели
  await seed({ streak: 2, lastDate: dayKeyUtc(shift(1)), freezes: 0, weekKey: readingWeekKey(now), weekReads: WEEK_GOAL - 1 })
  const d8a = await swipesDelta()
  const r8 = await recordRead(UID, 'qa_post_7', now)
  const d8b = await swipesDelta()
  const row8 = await db.readingStreak.findUnique({ where: { userId: UID } })
  check('цель недели: weekReads=30', r8.counted && row8?.weekReads === WEEK_GOAL)
  check('цель недели: +300 свайпов', d8b - d8a === 300, `delta=${d8b - d8a}`)
  check('цель недели: weekRewardKey выставлен', row8?.weekRewardKey === readingWeekKey(now))

  // 9) Повторного приза за ту же неделю нет: seed weekReads=29 заново, но rewardKey уже стоит
  await db.readingStreak.update({ where: { userId: UID }, data: { weekReads: WEEK_GOAL - 1 } })
  const d9a = await swipesDelta()
  await recordRead(UID, 'qa_post_8', now)
  const d9b = await swipesDelta()
  check('повторной награды за неделю нет', d9b - d9a === 0, `delta=${d9b - d9a}`)

  // 10) Новая неделя: weekKey сменился → weekReads перезапустился с 1
  await seed({ streak: 1, lastDate: '', freezes: 0, weekKey: '2020-W01', weekReads: 25 })
  await recordRead(UID, 'qa_post_9', now)
  const row10 = await db.readingStreak.findUnique({ where: { userId: UID } })
  check('новая неделя: weekReads=1', row10?.weekReads === 1 && row10?.weekKey === readingWeekKey(now))

  await reset()
  console.log(failures === 0 ? '\n🎉 ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\n⚠ ПРОВАЛОВ: ${failures}`)
  if (failures > 0) process.exit(1)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
