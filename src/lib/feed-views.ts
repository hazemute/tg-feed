'use client'

import { api } from '@/lib/api'

/**
 * БАТЧИНГ просмотров ленты (v5.95 — плавность).
 *
 * Раньше каждая карточка при показе (IntersectionObserver ≥70%) отправляла
 * СВОЙ POST /api/view { postIds:[id] } — страница ленты порождала 20-30
 * сетевых запросов, которые в мобильном WebView конкурировали с рендером
 * (дёрганый скролл) и создавали бёрст-нагрузку на API.
 *
 * Теперь: id копятся в очереди и уезжают ОДНИМ батчем (до 50 id — лимит
 * /api/view) через 900мс после первого показа или сразу при заполнении
 * очереди. Живой отклик «quests/activity» не ломается: обработка added
 * происходит на клиенте оптимистично, серверную аналитику батч не меняет
 * (тот же эндпоинт, тот же createManyAndReturn).
 */

const MAX_BATCH = 50
const FLUSH_DELAY_MS = 900

const queue = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  timer = null
  if (queue.size === 0) return
  const ids = [...queue].slice(0, MAX_BATCH)
  for (const id of ids) queue.delete(id)
  // хвост очереди (редко) — перевзводим таймер
  if (queue.size > 0 && timer === null) timer = setTimeout(flush, FLUSH_DELAY_MS)
  void api('/api/view', { method: 'POST', body: JSON.stringify({ postIds: ids }) }).catch(() => {
    /* аналитика просмотров не критична — молча */
  })
}

/** Карточка показалась на экране — поставить просмотр в очередь батча */
export function reportFeedView(postId: string): void {
  if (!postId || queue.has(postId)) return
  queue.add(postId)
  if (queue.size >= MAX_BATCH) {
    if (timer) clearTimeout(timer)
    flush()
    return
  }
  timer ??= setTimeout(flush, FLUSH_DELAY_MS)
}
