'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { api, getSessionToken, setSessionToken } from '@/lib/api'
import { useApp } from '@/lib/store'
import type { Lang } from '@/lib/i18n'
import { applyTgFrame, haptic, initTelegram, syncTelegramThemeVars, tg } from '@/lib/tg'
import { isInTelegram } from '@/lib/platform'
import { THEME_BY_ID, isDarkPalette } from '@/lib/themes'
import {
  applyCustomVars,
  customThemeIsDark,
  loadCustomTheme,
  removeCustomVars,
  type CustomTheme,
} from '@/lib/custom-theme'
import type { CategoryDTO, FontScale, Tab, ThemeMode, UserDTO } from '@/lib/types'
import { BottomNav } from '@/components/tg/BottomNav'
import { Sidebar } from '@/components/tg/Sidebar'
import { Splash } from '@/components/tg/Splash'
import { MaintenanceScreen } from '@/components/tg/MaintenanceScreen'
import { FeedView } from '@/components/feed/FeedView'

/*
 * Тяжёлые экраны и шиты — ленивые чанки (next/dynamic): первый кадр
 * (сплэш + лента) не ждёт их JS. Всё, что открывается ТОЛЬКО по тапу,
 * грузится при первом открытии; прогрев вероятных — в idle-эффекте ниже.
 */
const CommentsSheet = dynamic(() => import('@/components/feed/CommentsSheet').then((m) => m.CommentsSheet), { ssr: false })
const UserProfileSheet = dynamic(() => import('@/components/profile/UserProfileSheet').then((m) => m.UserProfileSheet), { ssr: false })
const ChannelSheet = dynamic(() => import('@/components/feed/ChannelSheet').then((m) => m.ChannelSheet), { ssr: false })
const PostOverlay = dynamic(() => import('@/components/feed/PostOverlay').then((m) => m.PostOverlay), { ssr: false })
const ShareSheet = dynamic(() => import('@/components/feed/ShareSheet').then((m) => m.ShareSheet), { ssr: false })
const TrendingTab = dynamic(() => import('@/components/tabs/TrendingTab').then((m) => m.TrendingTab), { ssr: false })
const SearchTab = dynamic(() => import('@/components/tabs/SearchTab').then((m) => m.SearchTab), { ssr: false })
const MyChannelTab = dynamic(() => import('@/components/tabs/MyChannelTab').then((m) => m.MyChannelTab), { ssr: false })
const ProfileTab = dynamic(() => import('@/components/tabs/ProfileTab').then((m) => m.ProfileTab), { ssr: false })
const AuthGateSheet = dynamic(() => import('@/components/tg/AuthGateSheet').then((m) => m.AuthGateSheet), { ssr: false })
const LoginByTelegram = dynamic(() => import('@/components/tg/LoginByTelegram').then((m) => m.LoginByTelegram), { ssr: false })

const TABS: Tab[] = ['feed', 'trending', 'search', 'mychannel', 'profile']

/*
 * v5.28: фактическая «темнота» активной темы — нужна для синхрона класса
 * .dark на <html> (dark:-утилиты shadcn: свитчи, табы, outline-кнопки).
 * auto = как клиент Telegram (в миниаппе) или как система (в браузере);
 * custom = по яркости сохранённого кастомного фона.
 */
function resolveIsDark(theme: ThemeMode, custom: CustomTheme | null): boolean {
  if (theme === 'custom') return custom ? customThemeIsDark(custom) : false
  if (theme !== 'auto') return isDarkPalette(theme)
  if (isInTelegram()) return tg()?.colorScheme === 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

// Анимация перехода между вкладками (направление зависит от порядка вкладок)
const tabVariants = {
  enter: (dir: number) => ({ x: dir * 64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -64, opacity: 0 }),
}

export default function Home() {
  const { user, authReady, tab, tabDir, theme, fontScale, maintenance, setUser, setAuthReady, setCategories, setTheme, setFontScale, setLang, setMaintenance, goToTab, setLoginOpen } =
    useApp()
  const touchRef = useRef<{ x: number; y: number; valid: boolean } | null>(null)
  // Сплэш живёт минимум 1.05с — влёт самолётика (0.9с) и подпись (0.35+0.5с)
  // успевают доиграть, а старт ощущается заметно бодрее.
  const [splashMinDone, setSplashMinDone] = useState(false)
  // Сайт без Telegram-сессии: вход только через бота (гостей с v5.20 больше нет)
  const [needLogin, setNeedLogin] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setSplashMinDone(true), 1050)
    return () => clearTimeout(t)
  }, [])

  // Восстановление настроек интерфейса (тема/шрифт/язык)
  useEffect(() => {
    const savedTheme = (localStorage.getItem('tgfeed_theme') as ThemeMode | null) ?? null
    const savedFont = (localStorage.getItem('tgfeed_font') as FontScale | null) ?? null
    const savedLang = localStorage.getItem('tgfeed_lang') as Lang | null
    const inTg = isInTelegram()
    // custom без сохранённой палитры — откат на светлую (нечего показывать)
    const valid = savedTheme !== 'custom' || loadCustomTheme() !== null
    setTheme(savedTheme && valid ? savedTheme : inTg ? 'auto' : 'light')
    setFontScale(savedFont ?? 'md')
    if (savedLang === 'ru' || savedLang === 'en') setLang(savedLang)

  }, [])

  // Применение темы к DOM: data-theme + класс .dark + инлайн-vars кастомной
  // палитры (v5.28: theme='custom' перекрашивает --tg-* из localStorage)
  useEffect(() => {
    const html = document.documentElement
    const custom = theme === 'custom' ? loadCustomTheme() : null
    if (theme === 'custom' && custom) applyCustomVars(custom, html)
    else removeCustomVars(html)
    html.dataset.theme = theme
    html.classList.toggle('dark', resolveIsDark(theme, custom))
  }, [theme])

  /*
   * Рамки миниаппы ВСЕГДА в цвет активной темы приложения: шапка Telegram,
   * фон под кнопками и нижняя панель красятся в hex активной палитры
   * (на старых клиентах — фолбэк на color_key). Плюс подкрашиваем
   * meta theme-color (браузерный chrome/Safari).
   */
  useEffect(() => {
    const apply = () => {
      let hex: string
      if (theme === 'custom') {
        hex = loadCustomTheme()?.bg ?? '#ffffff'
      } else if (theme === 'auto') {
        hex = tg()?.themeParams?.bg_color ?? '#ffffff'
      } else {
        hex = THEME_BY_ID.get(theme)?.preview.bg ?? '#ffffff'
      }
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
      document.documentElement.classList.toggle('dark', resolveIsDark(theme, theme === 'custom' ? loadCustomTheme() : null))
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
  // v5.20: гостевого входа больше нет — без валидного initData сервер отвечает
  // telegram_required, и сайт показывает экран входа через бота.
  const authenticate = useCallback(async (): Promise<boolean> => {
    const w = initTelegram()
    /*
     * САЙТ (не Mini App): если сессия уже есть — проверяем её лёгким GET /api/auth
     * и выходим. Иначе POST ниже вернёт telegram_required. Внутри Telegram — всегда
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
        body: JSON.stringify({ initData: w?.initData ?? '' }),
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
    } catch (e) {
      // Не в Telegram (или бот-токен не настроен): предлагаем вход через бота
      if ((e as Error).message === 'telegram_required' || (e as Error).message === 'telegram_invalid') {
        setNeedLogin(true)
        return false
      }
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

  // Прогрев ленивых чанков в простое (после первых кадров ленты): первый тап
  // по посту/вкладке/профилю не ждёт докачку JS. Модули те же, что в dynamic —
  // повторный import() бесплатен, просто кладёт чанк в кэш браузера.
  useEffect(() => {
    if (!authReady || !user) return
    const t = window.setTimeout(() => {
      void import('@/components/feed/PostOverlay')
      void import('@/components/feed/CommentsSheet')
      void import('@/components/profile/UserProfileSheet')
      void import('@/components/tabs/SearchTab')
      void import('@/components/tabs/TrendingTab')
      void import('@/components/tabs/ProfileTab')
    }, 3_500)
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
    if (needLogin) {
      return (
        <>
          <LoginRequired onLogin={() => setLoginOpen(true)} />
          <GlobalLoginSheet />
        </>
      )
    }
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
      {/* Публичный профиль по тапу на автора комментария (ава/имя) */}
      <UserProfileSheet />
    </div>
  )
}

/** Шит входа с глобальным состоянием (zustand) — открывается из AuthGate и профиля */
function GlobalLoginSheet() {
  const loginOpen = useApp((s) => s.loginOpen)
  const setLoginOpen = useApp((s) => s.setLoginOpen)
  return <LoginByTelegram open={loginOpen} onClose={() => setLoginOpen(false)} />
}

/**
 * Экран входа для сайта (вне Telegram): гостей с v5.20 нет — только вход
 * через нашего бота (одноразовая ссылка, подтверждение в чате).
 */
function LoginRequired({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-tg-bg px-6">
      <div className="w-full max-w-sm rounded-3xl border border-tg-sep bg-tg-surface p-7 text-center shadow-xl">
        <div
          className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-tg-link text-white"
          aria-hidden
        >
          <Send className="size-8 -translate-x-0.5 translate-y-0.5" />
        </div>
        <h1 className="mt-4 text-xl font-bold text-tg-text">Tg Swipe</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-tg-hint">
          Вход — только через Telegram. Откройте мини-апп из Telegram или подтвердите вход
          в чате с нашим ботом: это безопасно и занимает пару секунд.
        </p>
        <button
          type="button"
          onClick={onLogin}
          className="mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15.5px] font-bold text-white transition active:scale-[0.98]"
        >
          <Send className="size-5" aria-hidden />
          Войти через Telegram
        </button>
        <p className="mt-3 text-[11.5px] leading-snug text-tg-hint">
          Мы получаем только публичный профиль: имя, @username и аватар.
        </p>
      </div>
    </main>
  )
}
