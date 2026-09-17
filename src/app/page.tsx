'use client'

import { useCallback, useEffect, useRef } from 'react'
import { Loader2, Send } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { api, setSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import { getDeviceId } from '@/lib/user-id'
import { applyTgFrame, haptic, initTelegram, syncTelegramThemeVars, tg } from '@/lib/tg'
import { THEME_BY_ID } from '@/lib/themes'
import type { CategoryDTO, FontScale, Tab, ThemeMode, UserDTO } from '@/lib/types'
import { BottomNav } from '@/components/tg/BottomNav'
import { FeedView } from '@/components/feed/FeedView'
import { ChannelSheet } from '@/components/feed/ChannelSheet'
import { PostOverlay } from '@/components/feed/PostOverlay'
import { TrendingTab } from '@/components/tabs/TrendingTab'
import { SearchTab } from '@/components/tabs/SearchTab'
import { ProfileTab } from '@/components/tabs/ProfileTab'

const TABS: Tab[] = ['feed', 'trending', 'search', 'profile']

// Анимация перехода между вкладками (направление зависит от порядка вкладок)
const tabVariants = {
  enter: (dir: number) => ({ x: dir * 64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -64, opacity: 0 }),
}

export default function Home() {
  const { user, authReady, tab, tabDir, theme, fontScale, setUser, setAuthReady, setCategories, setTheme, setFontScale, goToTab } =
    useApp()
  const touchRef = useRef<{ x: number; y: number; valid: boolean } | null>(null)

  // Восстановление настроек интерфейса (тема/шрифт)
  useEffect(() => {
    const savedTheme = (localStorage.getItem('tgfeed_theme') as ThemeMode | null) ?? null
    const savedFont = (localStorage.getItem('tgfeed_font') as FontScale | null) ?? null
    const inTg = !!tg()
    setTheme(savedTheme ?? (inTg ? 'auto' : 'light'))
    setFontScale(savedFont ?? 'md')

  }, [])

  // Применение темы к DOM
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  /*
   * Рамки миниаппы ВСЕГДА в цвет активной темы приложения: шапка Telegram,
   * фон под кнопками и нижняя панель красятся в hex активной палитры
   * (на старых клиентах — фолбэк на color_key). Плюс подкрашиваем
   * meta theme-color (браузерный chrome/Safari).
   */
  useEffect(() => {
    const apply = () => {
      const hex =
        theme === 'auto'
          ? (tg()?.themeParams?.bg_color ?? '#ffffff')
          : (THEME_BY_ID.get(theme)?.preview.bg ?? '#ffffff')
      applyTgFrame(hex)
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', hex)
    }
    // после установки data-theme нужен кадр на пересчёт CSS-переменных
    const raf = requestAnimationFrame(apply)
    // смена темы клиента Telegram/системы — актуально для auto-темы
    const onSys = () => {
      syncTelegramThemeVars()
      apply()
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener?.('change', onSys)
    const w = tg()
    w?.onEvent?.('themeChanged', onSys)
    return () => {
      cancelAnimationFrame(raf)
      mq.removeEventListener?.('change', onSys)
      w?.offEvent?.('themeChanged', onSys)
    }
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.fontscale = fontScale
  }, [fontScale])

  // Шаг 1 PRD: авторизация через initData без паролей и регистраций.
  // Сервер проверяет подпись Telegram и выдаёт JWT-сессию — дальше все запросы
  // идут с заголовком Authorization: Bearer (см. src/lib/api.ts).
  const authenticate = useCallback(async (): Promise<boolean> => {
    const w = initTelegram()
    try {
      const res = await api<{ user: UserDTO; token: string }>('/api/auth', {
        method: 'POST',
        body: JSON.stringify({
          initData: w?.initData ?? '',
          tgUser: w?.initDataUnsafe?.user,
          deviceId: getDeviceId(),
        }),
      })
      setSessionToken(res.token)
      setUser(res.user)
      const cats = await api<{ items: CategoryDTO[] }>('/api/categories')
      setCategories(cats.items)
      return true
    } catch {
      toast.error('Ошибка входа. Обновите страницу.')
      return false
    }
  }, [setUser, setCategories])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await authenticate()
      if (!cancelled) setAuthReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [authenticate, setAuthReady])

  // Re-auth: сессия протухла/отозвана (401 из api()) — тихо входим заново
  useEffect(() => {
    let running = false
    const onUnauthorized = () => {
      if (running) return
      running = true
      authenticate().finally(() => {
        running = false
      })
    }
    window.addEventListener('tgfeed:unauthorized', onUnauthorized)
    return () => window.removeEventListener('tgfeed:unauthorized', onUnauthorized)
  }, [authenticate])

  /** Смена вкладки с направлением анимации */
  const switchTo = (next: Tab) => {
    if (next !== tab) {
      haptic('light')
      goToTab(next)
    }
  }

  // Горизонтальный свайп между вкладками (нативный жест мобильных приложений)
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    const target = e.target as HTMLElement
    touchRef.current = {
      x: t.clientX,
      y: t.clientY,
      valid: !target.closest('[data-noswipe]'),
    }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const st = touchRef.current
    touchRef.current = null
    if (!st?.valid) return
    const t = e.changedTouches[0]
    const dx = t.clientX - st.x
    const dy = t.clientY - st.y
    if (Math.abs(dx) > 64 && Math.abs(dy) < 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const idx = TABS.indexOf(tab)
      const next = dx < 0 ? idx + 1 : idx - 1
      if (next >= 0 && next < TABS.length) switchTo(TABS[next])
    }
  }

  if (!authReady || !user) {
    return (
      <div className="flex h-dvh justify-center bg-tg-bg">
        <div className="flex h-full w-full max-w-[430px] flex-col items-center justify-center bg-tg-bg md:border-x md:border-tg-sep">
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-[18px] bg-tg-link shadow-lg">
              <Send className="h-7 w-7 -translate-x-px translate-y-px text-white" />
            </div>
            <div className="flex items-center gap-2 text-snippet text-tg-hint">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаем ленту…
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh justify-center bg-tg-bg">
      <div className="relative flex h-full w-full max-w-[430px] flex-col overflow-hidden bg-tg-bg md:border-x md:border-tg-sep md:shadow-xl">
        <AnimatePresence initial={false} custom={tabDir} mode="popLayout">
          <motion.main
            key={tab}
            custom={tabDir}
            variants={tabVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="min-h-0 flex-1"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            {tab === 'feed' && <FeedView />}
            {tab === 'trending' && <TrendingTab />}
            {tab === 'search' && <SearchTab />}
            {tab === 'profile' && <ProfileTab />}
          </motion.main>
        </AnimatePresence>
        <BottomNav />
        {/* Экран канала внутри приложения */}
        <ChannelSheet />
        {/* Полный экран поста (открывается из «...еще») */}
        <PostOverlay />
      </div>
    </div>
  )
}
