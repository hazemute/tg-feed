'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { api, getSessionToken, setSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import type { Lang } from '@/lib/i18n'
import { getDeviceId } from '@/lib/user-id'
import { applyTgFrame, haptic, initTelegram, syncTelegramThemeVars, tg } from '@/lib/tg'
import { isInTelegram } from '@/lib/platform'
import { THEME_BY_ID } from '@/lib/themes'
import type { CategoryDTO, FontScale, Tab, ThemeMode, UserDTO } from '@/lib/types'
import { BottomNav } from '@/components/tg/BottomNav'
import { Sidebar } from '@/components/tg/Sidebar'
import { Splash } from '@/components/tg/Splash'
import { MaintenanceScreen } from '@/components/tg/MaintenanceScreen'
import { AuthGateSheet } from '@/components/tg/AuthGateSheet'
import { CommentsSheet } from '@/components/feed/CommentsSheet'
import { LoginByTelegram } from '@/components/tg/LoginByTelegram'
import { FeedView } from '@/components/feed/FeedView'
import { ChannelSheet } from '@/components/feed/ChannelSheet'
import { PostOverlay } from '@/components/feed/PostOverlay'
import { ShareSheet } from '@/components/feed/ShareSheet'
import { TrendingTab } from '@/components/tabs/TrendingTab'
import { SearchTab } from '@/components/tabs/SearchTab'
import { MyChannelTab } from '@/components/tabs/MyChannelTab'
import { ProfileTab } from '@/components/tabs/ProfileTab'

const TABS: Tab[] = ['feed', 'trending', 'search', 'mychannel', 'profile']

// Анимация перехода между вкладками (направление зависит от порядка вкладок)
const tabVariants = {
  enter: (dir: number) => ({ x: dir * 64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -64, opacity: 0 }),
}

export default function Home() {
  const { user, authReady, tab, tabDir, theme, fontScale, maintenance, setUser, setAuthReady, setCategories, setTheme, setFontScale, setLang, setMaintenance, goToTab } =
    useApp()
  const touchRef = useRef<{ x: number; y: number; valid: boolean } | null>(null)
  // Сплэш живёт минимум 1.35с — влёт самолётика (1.15с) всегда доигрывает
  // до конца, даже когда API отвечает мгновенно. Иначе на проде анимацию
  // срезает на середине и загрузка выглядит дёргано.
  const [splashMinDone, setSplashMinDone] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setSplashMinDone(true), 1350)
    return () => clearTimeout(t)
  }, [])

  // Восстановление настроек интерфейса (тема/шрифт/язык)
  useEffect(() => {
    const savedTheme = (localStorage.getItem('tgfeed_theme') as ThemeMode | null) ?? null
    const savedFont = (localStorage.getItem('tgfeed_font') as FontScale | null) ?? null
    const savedLang = localStorage.getItem('tgfeed_lang') as Lang | null
    const inTg = isInTelegram()
    setTheme(savedTheme ?? (inTg ? 'auto' : 'light'))
    setFontScale(savedFont ?? 'md')
    if (savedLang === 'ru' || savedLang === 'en') setLang(savedLang)

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
    /*
     * САЙТ (не Mini App): если сессия уже есть — проверяем её лёгким GET /api/auth
     * и выходим. Иначе POST ниже сделал бы из вошедшего через бота tg-юзера
     * гостя заново при каждой перезагрузке страницы. Внутри Telegram — всегда
     * полный вход: initData заодно обновляет профиль/премиум/аватар.
     */
    const existing = getSessionToken()
    if (existing && !isInTelegram()) {
      try {
        const res = await fetch('/api/auth', {
          headers: { Authorization: `Bearer ${existing}` },
          cache: 'no-store',
        })
        if (res.ok) {
          const me = (await res.json()) as {
            user: UserDTO
            maintenance?: { active: boolean; canBypass: boolean }
          }
          setUser(me.user)
          const blocked = me.maintenance?.active === true && me.maintenance.canBypass !== true
          setMaintenance(blocked)
          if (!blocked) {
            const cats = await api<{ items: CategoryDTO[] }>('/api/categories')
            setCategories(cats.items)
          }
          return true
        }
        // протухла/отозвана — входим заново по обычному сценарию
        setSessionToken(null)
      } catch {
        /* сеть моргнула — обычный вход ниже */
      }
    }
    try {
      const res = await api<{
        user: UserDTO
        token: string
        maintenance?: { active: boolean; canBypass: boolean }
      }>('/api/auth', {
        method: 'POST',
        body: JSON.stringify({
          initData: w?.initData ?? '',
          tgUser: w?.initDataUnsafe?.user,
          deviceId: getDeviceId(),
        }),
      })
      setSessionToken(res.token)
      setUser(res.user)
      // Техработы: без допуска — переключаемся на экран техработ;
      // категории не запрашиваем (API закрыт middleware), чтобы не сыпать тостами
      const blocked = res.maintenance?.active === true && res.maintenance.canBypass !== true
      setMaintenance(blocked)
      if (blocked) return true
      const cats = await api<{ items: CategoryDTO[] }>('/api/categories')
      setCategories(cats.items)
      return true
    } catch {
      toast.error('Ошибка входа. Обновите страницу.')
      return false
    }
  }, [setUser, setCategories, setMaintenance])

  // Любой API вернул 503 {maintenance:true} — весь app на экран техработ
  useEffect(() => {
    const onMaintenance = () => setMaintenance(true)
    window.addEventListener('tgfeed:maintenance', onMaintenance)
    return () => window.removeEventListener('tgfeed:maintenance', onMaintenance)
  }, [setMaintenance])

  // Прогрев тяжёлых агрегатов ПОСЛЕ первого рендера ленты: к открытию вкладки
  // «Тренды» серверный кэш уже тёплый — вкладка открывается мгновенно
  useEffect(() => {
    if (!authReady || !user) return
    const t = window.setTimeout(() => {
      void api<{ pulse?: unknown }>('/api/trending').catch(() => {})
    }, 2_500)
    return () => window.clearTimeout(t)
  }, [authReady, user])

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

  if (!authReady || !user || !splashMinDone) {
    return <Splash />
  }

  if (maintenance) {
    return (
      <MaintenanceScreen
        onRetry={async () => {
          await authenticate()
          return !useApp.getState().maintenance
        }}
      />
    )
  }

  return (
    <div className="flex h-dvh justify-center bg-tg-bg">
      {/* Десктоп: сайдбар-навигация слева (lg+), мобильный — нижняя капсула.
          На самостоятельном сайте (html[data-platform='web']) CSS снимает
          max-w — интерфейс ПК растягивается на всю ширину экрана. */}
      <div className="app-shell flex h-full w-full max-w-[1120px]">
        <Sidebar />
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-tg-bg lg:rounded-l-2xl lg:border lg:border-tg-sep lg:shadow-xl">
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
              {tab === 'mychannel' && <MyChannelTab />}
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
      {/* Шит «Поделиться»: Telegram / В историю / Копировать ссылку —
          глобальный (лента, полный экран поста, экран канала) */}
      <ShareSheet />
      {/* Ленивая регистрация: шторка «привяжи Telegram» при лайке/закладке гостя
          и глобальный шит входа (открывается из любого места приложения) */}
      <AuthGateSheet />
      <GlobalLoginSheet />
      {/* Комментарии под постом (глобально: лента и полный экран поста) */}
      <CommentsSheet />
    </div>
  )
}

/** Шит входа с глобальным состоянием (zustand) — открывается из AuthGate и профиля */
function GlobalLoginSheet() {
  const loginOpen = useApp((s) => s.loginOpen)
  const setLoginOpen = useApp((s) => s.setLoginOpen)
  return <LoginByTelegram open={loginOpen} onClose={() => setLoginOpen(false)} />
}
