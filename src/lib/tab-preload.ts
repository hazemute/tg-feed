'use client'

import type { Tab } from '@/lib/types'

/**
 * v5.85 — предзагрузка чанков вкладок ДО клика.
 *
 * next/dynamic грузит чанк вкладки при первом рендере. Прогрев в idle
 * (page.tsx) обычно успевает, но на медленной сети первый тап всё ещё
 * ждал докачку с пустым экраном. Теперь BottomNav вызывает preloadTab()
 * на onPointerDown/onTouchStart — закачка стартует в момент касания,
 * за ~100-200мс до переключения: чанк уже в кэше браузера, вкладка
 * рисуется мгновенно (скелетон почти не виден).
 *
 * Пути СИНХРОННЫ с dynamic() в page.tsx (тот же модуль → тот же чанк,
 * повторный import() бесплатен).
 */
const LOADERS: Record<Tab, () => Promise<unknown>> = {
  feed: () => import('@/components/feed/FeedView'),
  quests: () => import('@/components/tabs/QuestsTab'),
  channel: () => import('@/components/tabs/ChannelTab'),
  search: () => import('@/components/tabs/SearchTab'),
  profile: () => import('@/components/tabs/ProfileTab'),
}

const started = new Set<Tab>()

export function preloadTab(tab: Tab): void {
  if (started.has(tab)) return
  started.add(tab)
  void LOADERS[tab]().catch(() => {
    // сеть моргнула — при следующем касании попробуем снова
    started.delete(tab)
  })
}
