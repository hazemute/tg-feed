/**
 * v5.60 — ПРЕДЗАГРЕВ МЕДИА ВПЕРЁД (только браузер).
 *
 * Пока юзер читает текущий пост, в idle-время (requestIdleCallback, cap 3с)
 * по ОДНОМУ соединению тихо качаем медиа + аватарки СЛЕДУЮЩИХ постов ленты.
 * К моменту свайпа картинка уже в HTTP-кэше браузера и в edge-кэше Vercel —
 * появление мгновенное. На медленных каналах (главная жалоба «не грузится»)
 * именно скрытая предзагрузка превращает вечный shimmer в готовую картинку.
 *
 * Экономика: очередь последовательная — предзагрузка НЕ соревнуется с текущей
 * картинкой за канал; дедуп по Set — один URL качается один раз за сессию.
 */

import type { PostDTO } from '@/lib/types'
import { optimizedImgSrc } from '@/lib/media'

const warmed = new Set<string>()
const queue: string[] = []
let scheduled = false
let draining = false

function enqueue(url: string): void {
  if (warmed.has(url)) return
  // кап памяти набора: старые URL забываем (в HTTP-кэше браузера они и так есть)
  if (warmed.size > 400) {
    const first = warmed.values().next().value
    if (first !== undefined) warmed.delete(first)
  }
  warmed.add(url)
  queue.push(url)
}

function drain(): void {
  if (draining) return
  const next = queue.shift()
  if (!next) return
  draining = true
  const img = new Image()
  img.referrerPolicy = 'no-referrer'
  img.decoding = 'async'
  const done = () => {
    draining = false
    // пауза между предзагрузками — не забиваем канал очередью запросов
    window.setTimeout(drain, 150)
  }
  img.onload = done
  img.onerror = done
  img.src = next
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  const run = () => {
    scheduled = false
    drain()
  }
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback
  if (ric) ric(run, { timeout: 3_000 })
  else window.setTimeout(run, 1_200)
}

/**
 * Прогреть медиа/аватары постов, которые ПОКАЖЕМ ЧУТЬ ПОЗЖЕ (2-5-й в списке):
 * первый пост прогревать не надо — его LazyImage уже грузит.
 * Медиа греем в ОПТИМИЗИРОВАННОМ виде — ровно тот URL, который попросит лента.
 */
export function prewarmUpcoming(posts: PostDTO[], skipFirst = true, maxMedia = 3, maxAvatars = 8): void {
  if (typeof window === 'undefined' || typeof Image === 'undefined') return
  let media = 0
  let avatars = 0
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i]
    if (skipFirst && i === 0) {
      // нулевой пост уже на экране, но его АВАТАРку прогреть всё равно полезно
      const av0 = p.channel?.avatarUrl
      if (av0) enqueue(av0)
      continue
    }
    if (media < maxMedia) {
      const m = p.media?.url ?? p.gallery?.[0]?.url
      if (m) {
        media += 1
        enqueue(optimizedImgSrc(m))
      }
    }
    const av = p.channel?.avatarUrl
    if (av && avatars < maxAvatars) {
      avatars += 1
      enqueue(av)
    }
  }
  schedule()
}
