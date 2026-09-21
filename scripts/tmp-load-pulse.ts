/**
 * ВРЕМЕННЫЙ скрипт Task 8-b — ЛОКАЛЬНЫЙ LOAD-ТЕСТ дев-сервера (удалить после замера!).
 *
 * Моделирует начальный бёрст розыгрыша: 200 параллельных /api/feed +
 * 50 /api/view + 20 /api/quests через ДЕВ-СЕРВЕР :3000.
 * Это НЕ прод-показатели (SQLite-песочница, localhost, один процесс):
 * цель — поймать ЯВНЫЕ serialized-бутылочные горлышки и ошибки под бёрстом.
 *
 * Запуск: bun scripts/tmp-load-pulse.ts
 */

import { config } from 'dotenv'
config({ override: true })

import { PrismaClient } from '@prisma/client'
import { signSession } from '../src/lib/session'

const BASE = 'http://localhost:3000'
// SCALE<1 — калибровочный прогон меньшего бёрста (dev-процесс упирается в очередь
// сокета при 270 параллельных, p95 становится артефактом клиентских абортов)
const SCALE = Number(process.argv[3] ?? 1)
const FEED_N = Math.round(200 * SCALE)
const VIEW_N = Math.round(50 * SCALE)
const QUESTS_N = Math.round(20 * SCALE)
const USERS = 8
// разных сидов ленты (разные снапшоты — реальная сборка, не page-cache);
// SEEDS=1 → «горячий» бёрст: те же снапшоты/page-cache, путь готового кэша
const SEEDS = Number(process.argv[2] ?? 10)

type Res = { group: string; ms: number; status: number }

async function main() {
  const db = new PrismaClient()
  const users = await db.user.findMany({
    select: { id: true },
    orderBy: { id: 'asc' },
    take: USERS,
  })
  if (users.length === 0) throw new Error('нет пользователей в БД')
  const posts = await db.post.findMany({
    select: { id: true },
    orderBy: { publishedAt: 'desc' },
    take: 10,
  })
  if (posts.length === 0) throw new Error('нет постов в БД')
  const tokens = users.map((u) => ({ uid: u.id, token: signSession(u.id, false) }))
  console.log(`users=${tokens.length} (${tokens.map((t) => t.uid).join(', ')}) posts=${posts.length}`)

  // Дождаться, пока дев-сервер ДОЕСТ предыдущий бёрст (аборт клиента не
  // отменяет работу на сервере): health должен отвечать быстрее 300мс.
  for (let i = 0; i < 120; i++) {
    const t = performance.now()
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10_000) })
      await res.arrayBuffer()
      if (res.status === 200 && performance.now() - t < 300) break
    } catch { /* ещё busy */ }
    await new Promise((r) => setTimeout(r, 1000))
  }

  const results: Res[] = []

  const hit = async (group: string, url: string, token: string, init?: RequestInit) => {
    const t0 = performance.now()
    let status = 0
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(45_000),
      })
      status = res.status
      await res.arrayBuffer() // Drain the body
    } catch {
      status = -1
    }
    results.push({ group, ms: Math.round(performance.now() - t0), status })
  }

  // Прогрев: по одной странице на юзера ПОСЛЕДОВАТЕЛЬНО (заполняет page-cache/
  // снапшоты/L1 строк), чтобы бёрст SEEDS=1 шёл по готовому кэшу
  for (const u of tokens) {
    await hit('warm', `${BASE}/api/feed?category=all&page=0&limit=6&sh=load0&lang=any`, u.token)
  }

  const t0 = performance.now()
  const jobs: Promise<void>[] = []

  // 200 /api/feed — разные сиды (новые снапшоты) + пара повторов (page-cache)
  for (let i = 0; i < FEED_N; i++) {
    const u = tokens[i % tokens.length]
    const seed = `load${i % SEEDS}`
    const cacheWarm = i >= FEED_N - 4 // последние 4 — те же ключи, что были в начале
    const s = cacheWarm ? 'load0' : seed
    jobs.push(
      hit('feed', `${BASE}/api/feed?category=all&page=0&limit=6&sh=${s}&lang=any`, u.token),
    )
  }

  // 50 /api/view — батчи по 3 поста (реальный клиент шлёт до 50)
  // FEEDONLY=1 — только /api/feed (чистый замер ленты без записи)
  const FEEDONLY = process.env.FEEDONLY === '1'
  for (let i = 0; !FEEDONLY && i < VIEW_N; i++) {
    const u = tokens[i % tokens.length]
    const ids = [posts[i % posts.length].id, posts[(i * 3) % posts.length].id]
    jobs.push(
      hit('view', `${BASE}/api/view`, u.token, {
        method: 'POST',
        body: JSON.stringify({ postIds: [...new Set(ids)] }),
      }),
    )
  }

  // 20 /api/quests
  for (let i = 0; !FEEDONLY && i < QUESTS_N; i++) {
    const u = tokens[i % tokens.length]
    jobs.push(hit('quests', `${BASE}/api/quests`, u.token))
  }

  await Promise.all(jobs)
  const totalMs = Math.round(performance.now() - t0)

  const pct = (arr: number[], p: number) => {
    if (arr.length === 0) return 0
    const sorted = [...arr].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  }

  console.log(`\n=== TOTAL: ${results.length} запросов за ${totalMs}мс ===`)
  for (const group of ['feed', 'view', 'quests']) {
    const rs = results.filter((r) => r.group === group)
    const ms = rs.map((r) => r.ms)
    const byStatus: Record<number, number> = {}
    for (const r of rs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    console.log(
      `[${group}] n=${rs.length} p50=${pct(ms, 50)}мс p95=${pct(ms, 95)}мс max=${Math.max(...ms)}мс ` +
        `statuses=${JSON.stringify(byStatus)}`,
    )
  }

  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
