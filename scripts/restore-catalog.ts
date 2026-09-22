/**
 * ВОССТАНОВЛЕНИЕ КАТАЛОГА запаршенных каналов (Task 44-feed).
 *
 * Контекст: Supabase-БД пересоздавалась 2026-09-22 — кураторский каталог
 * (88 юзернеймов, 3 волны, категория games) исчез. В ленте остались только
 * сиды _feed (по 3-4 статичных поста) и ботовые каналы владельца —
 * владелец: «отпаршенные каналы не отображаются, только те, в которых есть бот».
 *
 * Скрипт идемпотентен: существующие каналы пропускаются, каждый кандидат
 * валидируется discoverSingleChannel (t.me/s живой + русский + ≥100 подписчиков).
 * После восстановления парсер-крон подхватит каналы ротацией сам.
 */
import { db } from '../src/lib/db'
import { CATALOG, discoverSingleChannel } from '../src/lib/autodiscover'
import { bumpCache } from '../src/lib/redis'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1) Категория games (в пересозданной БД её нет)
  const games = await db.category.upsert({
    where: { slug: 'games' },
    create: { slug: 'games', title: 'Игры', emoji: '🎮', order: 0 },
    update: {},
    select: { id: true, slug: true },
  })
  console.log(`Категория: ${games.slug} (${games.id})`)

  // 2) Уже существующие каналы — пропускаем
  const existing = new Set((await db.channel.findMany({ select: { username: true } })).map((c) => c.username))
  const usernames = CATALOG.flatMap((g) => g.usernames)
  console.log(`Каталог: ${usernames.length} юзернеймов; уже в БД: ${usernames.filter((u) => existing.has(u.toLowerCase())).length}`)

  let added = 0, failed = 0, skipped = 0
  const reasons = new Map<string, number>()
  for (const u of usernames) {
    const uname = u.toLowerCase()
    if (existing.has(uname)) { skipped++; continue }
    try {
      const res = await discoverSingleChannel(uname, 'games')
      if (res.ok) {
        added++
        console.log(`  + @${uname}: «${res.title}» постов=${res.posts} подписчиков=${res.members ?? '?'}`)
      } else {
        failed++
        reasons.set(res.reason, (reasons.get(res.reason) ?? 0) + 1)
        console.log(`  - @${uname}: ${res.reason}`)
      }
    } catch (e) {
      failed++
      console.log(`  ! @${uname}: exception ${e instanceof Error ? e.message.slice(0, 120) : e}`)
    }
    await sleep(250)
  }

  console.log(`\nИтог: добавлено=${added}, пропущено (уже есть)=${skipped}, отклонено=${failed}`)
  for (const [r, n] of reasons) console.log(`  причина ×${n}: ${r}`)

  // 3) Инвалидация кэшей ленты/каталога в проде
  try { await bumpCache(['feed', 'tr', 'ch', 'ct']); console.log('bumpCache: ok') } catch (e) { console.log('bumpCache: пропущен', e instanceof Error ? e.message : e) }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1) })
