'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import { RotateCcw, Send, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import { api, getSessionToken, prefetchIdle, setSessionToken } from '@/lib/api'
import { hideBootShell } from '@/lib/boot-shell'
import { useApp } from '@/lib/store'
import type { Lang } from '@/lib/i18n'
import { tr } from '@/lib/i18n'
import { applyTgFrame, haptic, initTelegram, syncTelegramThemeVars, tg } from '@/lib/tg'
import { isInTelegram } from '@/lib/platform'
import { THEME_BY_ID, isDarkPalette } from '@/lib/themes'
import {
  applyCustomVars,
  customThemeIsDark,
  CUSTOM_THEME_EVENT,
  loadCustomTheme,
  removeCustomVars,
  type CustomTheme,
} from '@/lib/custom-theme'
import type { CategoryDTO, FontScale, Tab, ThemeMode, UserDTO } from '@/lib/types'
import { BottomNav } from '@/components/tg/BottomNav'
import { Sidebar } from '@/components/tg/Sidebar'
import { Splash } from '@/components/tg/Splash'
import { MaintenanceScreen } from '@/components/tg/MaintenanceScreen'
import { PreReleaseScreen } from '@/components/tg/PreReleaseScreen'
import { WelcomeGuide, useWelcomeGuide } from '@/components/tg/WelcomeGuide'
import { TutorialCoach } from '@/components/tg/TutorialCoach'
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
const QuestsTab = dynamic(() => import('@/components/tabs/QuestsTab').then((m) => m.QuestsTab), { ssr: false })
const SearchTab = dynamic(() => import('@/components/tabs/SearchTab').then((m) => m.SearchTab), { ssr: false })
const ChannelTab = dynamic(() => import('@/components/tabs/ChannelTab').then((m) => m.ChannelTab), { ssr: false })
const ProfileTab = dynamic(() => import('@/components/tabs/ProfileTab').then((m) => m.ProfileTab), { ssr: false })
const AuthGateSheet = dynamic(() => import('@/components/tg/AuthGateSheet').then((m) => m.AuthGateSheet), { ssr: false })
const LoginByTelegram = dynamic(() => import('@/components/tg/LoginByTelegram').then((m) => m.LoginByTelegram), { ssr: false })

const TABS: Tab[] = ['feed', 'quests', 'channel', 'search', 'profile']

/*
 * v5.70 ЖЕСТ-ФИЛЬТР свайпа вкладок: раньше решение принималось только по
 * конечным точкам (dx>64, dy<48) — вертикальный скролл ленты с дрейфом
 * пальца и горизонтальные жесты внутри каруселей/пилюл ошибочно
 * переключали вкладку. Теперь жест отслеживается по ВСЕЙ траектории
 * (onTouchMove): как только вертикальное смещение превысило 24px ДО того,
 * как горизонтальное достигло 64px — жест помечен вертикальным (скролл)
 * и вкладка не переключается. Быстрый флик (<220мс) проходит с укороченным
 * порогом 48px, но всё так же требует чисто горизонтального характера.
 */
const SWIPE_DIST = 64 // порог горизонтали для обычного свайпа
const FLICK_DIST = 48 // порог для быстрого флика
const FLICK_MS = 220 // быстрее этого — флик
const VERTICAL_LIMIT = 24 // дрейф по вертикали до победы горизонтали — это скролл

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
  const { user, authReady, tab, tabDir, theme, fontScale, maintenance, prerelease, setUser, setAuthReady, setCategories, setTheme, setFontScale, setLang, setMaintenance, setPrerelease, goToTab, setLoginOpen, openCommentsById } =
    useApp()
  /*
   * Приложение закрыто (техработы или ещё не выпущено) — префетчи не нужны:
   * API всё равно отвечает 503, не тратим запросы и не сыпем ошибками.
   */
  const appOpen = !maintenance && !prerelease
  /* Траектория жеста: x/y — точка старта, t — время старта, maxDx/maxDy —
   * накопленные экстремумы смещения, dirty — жест испорчен (вёл себя как
   * вертикальный скролл), valid — старт не в data-noswipe-зоне. */
  const touchRef = useRef<{
    x: number
    y: number
    t: number
    valid: boolean
    maxDx: number
    maxDy: number
    dirty: boolean
  } | null>(null)
  // Сплэш живёт минимум 0.7с (v5.52, было 1.05с): влёт самолётика виден, но
  // лента начинается заметно раньше — каждые 100мс до первого кадра на счету.
  const [splashMinDone, setSplashMinDone] = useState(false)
  // Сайт без Telegram-сессии: вход только через бота (гостей с v5.20 больше нет)
  const [needLogin, setNeedLogin] = useState(false)
  /*
   * v5.52 ФИКС «БЕСКОНЕЧНОГО ПУСТОГО ЭКРАНА»: раньше сетевой сбой/таймаут
   * POST /api/auth (20с) или падение API оставляли user=null и приложение
   * НАВСЕГДА на сплэше — пользователь видел пустой экран без шанса повторить.
   * Теперь ошибка входа показывает экран с кнопкой «Повторить».
   */
  const [authError, setAuthError] = useState(false)
  /* v5.58: приветственный гайд при первом входе (один раз, «Пропустить» всегда
   * под рукой) — появляется поверх готовой ленты, через 0.9с после авторизации */
  const welcome = useWelcomeGuide(authReady && Boolean(user) && appOpen)

  useEffect(() => {
    // v5.84: React смонтировался — шторка boot-guard (layout.tsx) больше не
    // нужна: гасим и снимаем её ватчдоги (если JS чанков так и не доехали,
    // шторка сама покажет «Перезагрузить» — сюда мы бы не попали).
    hideBootShell()
    const t = setTimeout(() => setSplashMinDone(true), 700)
    return () => clearTimeout(t)
  }, [])

  /*
   * v5.82: возврат со страницы оплаты Platega (?topup=done / ?topup=failed).
   * Провайдер приводит пользователя по return/failedUrl на главную — показываем
   * честный тост и сразу чистим URL, чтобы перезагрузка не дублировала сообщение.
   * Само зачисление делает вебхук/статус-поллинг — здесь только уведомление.
   */
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      const res = q.get('topup')
      if (!res) return
      q.delete('topup')
      const rest = q.toString()
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''))
      if (res === 'done') toast.success(tr(useApp.getState().lang, 'topup.returnedDone'))
      else if (res === 'failed') toast.error(tr(useApp.getState().lang, 'topup.returnedFail'))
    } catch {
      /* не критично */
    }
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
    if (savedLang === 'ru' || savedLang === 'en') {
      setLang(savedLang)
    } else if (inTg) {
      /*
       * v5.33: язык интерфейса миниаппа = язык КЛИЕНТА Telegram.
       * Пока пользователь не выбрал язык вручную (нет сохранённого), интерфейс
       * сам запускается на языке клиента Telegram (language_code из initData):
       * ru-клиент — русская шапка, en-клиент — английская. Выбор в профиле
       * сохраняется и дальше главнее авто-детекта. В обычном браузере (не
       * миниаппа) оставляем русский по умолчанию — аудитория RU.
       */
      const tgLang = tg()?.initDataUnsafe?.user?.language_code ?? ''
      useApp.setState({ lang: /^ru/i.test(tgLang.trim()) ? 'ru' : 'en' })
    }
  }, [])

  /*
   * Применение темы к DOM: инлайн-vars кастомной палитры + data-theme + класс
   * .dark (v5.30 fix «кривой палитры»). Читает АКТУАЛЬНУЮ тему из стора
   * (getState), а не замыкание: на монтировании эффект восстановления (выше)
   * уже положил сохранённую тему в стор — zustand set синхронен, а эффекты
   * идут по порядку объявления. Раньше первый прогон применял промежуточный
   * 'light' из первичного рендера и ЗАТИРАЛ правильную палитру, выставленную
   * themeInit до гидрации (вспышка светлой темы на каждой перезагрузке).
   */
  const applyThemeDom = useCallback(() => {
    const t = useApp.getState().theme
    const html = document.documentElement
    const custom = t === 'custom' ? loadCustomTheme() : null
    if (t === 'custom' && custom) applyCustomVars(custom, html)
    else removeCustomVars(html)
    /*
     * auto вне Telegram: CSS-блок 'auto' построен на --tg-theme-*, которые
     * существуют только в миниаппе — в браузере он всегда падает в светлые
     * фолбэки, а .dark следует за prefers-color-scheme → «наполовину тёмный»
     * интерфейс (тёмные свитчи/табы на светлой палитре). Резолвим auto в
     * конкретную светлую/тёмную палитру — синхронно с resolveIsDark ниже.
     * Внутри Telegram data-theme остаётся 'auto' (--tg-theme-* актуальны).
     */
    if (t === 'auto' && !isInTelegram()) {
      const sysDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
      html.dataset.theme = sysDark ? 'dark' : 'light'
    } else {
      html.dataset.theme = t
    }
    html.classList.toggle('dark', resolveIsDark(t, custom))
  }, [])

  /*
   * Рамки миниаппы ВСЕГДА в цвет активной темы приложения: шапка Telegram,
   * фон под кнопками и нижняя панель красятся в hex активной палитры
   * (на старых клиентах — фолбэк на color_key). Плюс подкрашиваем
   * meta theme-color (браузерный chrome/Safari). Тема — из стора (см.
   * комментарий applyThemeDom: на монтировании там уже сохранённая).
   */
  const applyFrame = useCallback(() => {
    const t = useApp.getState().theme
    let hex: string
    if (t === 'custom') {
      hex = loadCustomTheme()?.bg ?? '#ffffff'
    } else if (t === 'auto') {
      const tgBg = tg()?.themeParams?.bg_color
      if (!tgBg && !isInTelegram()) {
        // браузер: авто-тема следует за системой — синхронно с applyThemeDom
        const sysDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
        hex = sysDark
          ? THEME_BY_ID.get('dark')?.preview.bg ?? '#0e141c'
          : THEME_BY_ID.get('light')?.preview.bg ?? '#ffffff'
      } else {
        hex = tgBg ?? '#ffffff'
      }
    } else {
      hex = THEME_BY_ID.get(t)?.preview.bg ?? '#ffffff'
    }
    applyTgFrame(hex)
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', hex)
  }, [])

  useEffect(() => {
    applyThemeDom()
  }, [theme, applyThemeDom])

  /*
   * Живая перекраска при правке кастомной палитры БЕЗ смены темы (v5.30):
   * ThemeGallery сохраняет {bg,accent} в localStorage, пока тема уже 'custom',
   * — эффект выше по [theme] не перезапускается (значение не менялось), и
   * приложение оставалось в старой/смешанной палитре до перезагрузки.
   */
  useEffect(() => {
    const onCustomTheme = () => {
      if (useApp.getState().theme !== 'custom') return
      applyThemeDom()
      applyFrame()
    }
    window.addEventListener(CUSTOM_THEME_EVENT, onCustomTheme)
    return () => window.removeEventListener(CUSTOM_THEME_EVENT, onCustomTheme)
  }, [applyThemeDom, applyFrame])

  useEffect(() => {
    applyFrame()
    // после установки data-theme нужен кадр на пересчёт CSS-переменных
    const raf = requestAnimationFrame(applyFrame)
    // смена темы клиента Telegram/системы — актуально для auto-темы
    const onSys = () => {
      syncTelegramThemeVars()
      applyThemeDom()
      applyFrame()
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
  }, [theme, applyFrame, applyThemeDom])

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
          // v5.80: у этого fetch НЕ БЫЛО таймаута — зависший TCP (мобильная сеть,
          // чёрная дыра прокси) оставлял сплэш навсегда: authenticate никогда
          // не возвращался, authReady не выставлялся. 20с — как в api().
          signal: AbortSignal.timeout(20_000),
        })
        if (res.ok) {
          const me = (await res.json()) as {
            user: UserDTO
            maintenance?: { active: boolean; canBypass: boolean }
            release?: { released: boolean; canBypass: boolean }
          }
          setUser(me.user)
          const blocked = me.maintenance?.active === true && me.maintenance.canBypass !== true
          setMaintenance(blocked)
          // До релиза («Выпустить» ещё не нажато) — экран разработки, НЕ техработы
          const pre =
            !blocked && me.release?.released === false && me.release?.canBypass !== true
          setPrerelease(pre)
          if (!blocked && !pre) {
            // v5.52: категории НЕ тормозят первый кадр — грузятся параллельно с
            // первой страницей ленты (чипы категорий подставятся, когда готовы)
            void api<{ items: CategoryDTO[] }>('/api/categories')
              .then((cats) => setCategories(cats.items))
              .catch(() => {})
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
        release?: { released: boolean; canBypass: boolean }
      }>('/api/auth', {
        method: 'POST',
        body: JSON.stringify({ initData: w?.initData ?? '' }),
      })
      setSessionToken(res.token)
      setUser(res.user)
      // Техработы: без допуска — экран техработ; категории не запрашиваем
      // (API закрыт middleware), чтобы не сыпать тостами
      const blocked = res.maintenance?.active === true && res.maintenance.canBypass !== true
      setMaintenance(blocked)
      // Релиз: пока владелец не нажал «Выпустить» — экран «ещё разрабатывается»
      const pre = !blocked && res.release?.released === false && res.release?.canBypass !== true
      setPrerelease(pre)
      if (blocked || pre) return true
      void api<{ items: CategoryDTO[] }>('/api/categories')
        .then((cats) => setCategories(cats.items))
        .catch(() => {})
      return true
    } catch (e) {
      // Не в Telegram (или бот-токен не настроен): предлагаем вход через бота
      if ((e as Error).message === 'telegram_required' || (e as Error).message === 'telegram_invalid') {
        setNeedLogin(true)
        return false
      }
      setAuthError(true)
      return false
    }
  }, [setUser, setCategories, setMaintenance, setPrerelease])

  // Любой API вернул 503 {maintenance:true} — весь app на экран техработ
  useEffect(() => {
    const onMaintenance = () => setMaintenance(true)
    window.addEventListener('tgfeed:maintenance', onMaintenance)
    return () => window.removeEventListener('tgfeed:maintenance', onMaintenance)
  }, [setMaintenance])

  // Любой API вернул 503 {prerelease:true} — весь app на экран «ещё разрабатываем»
  useEffect(() => {
    const onPrerelease = () => setPrerelease(true)
    window.addEventListener('tgfeed:prerelease', onPrerelease)
    return () => window.removeEventListener('tgfeed:prerelease', onPrerelease)
  }, [setPrerelease])

  // Прогрев ВСЕХ ключевых экранов ПОСЛЕ первого рендера ленты (v5.34): задания,
  // каталог каналов, тренды, кабинет — ложатся в клиентский кэш apiCached —
  // вкладки «Задания»/«Поиск»/«Каналы»/«Профиль» затем открываются МГНОВЕННО,
  // без сетевого раунд-трипа и пустого экрана.
  // v5.81: старт 800мс (было 2.5с), окно idle 20с (было 90с) + /api/mychannel —
  // жалобы «лента загрузилась, а другие вкладки пустые» закрыты префетчем заранее.
  useEffect(() => {
    if (!authReady || !user || !appOpen) return
    const t = window.setTimeout(() => {
      prefetchIdle(
        [
          '/api/quests',
          '/api/hashtags/trending',
          `/api/channels${user.id ? `?userId=${encodeURIComponent(user.id)}` : ''}`,
          '/api/mychannel',
        ],
        20_000,
      )
    }, 800)
    return () => window.clearTimeout(t)
  }, [authReady, user, appOpen])

  // Прогрев ленивых чанков в простое (после первых кадров ленты): первый тап
  // по посту/вкладке/профилю не ждёт докачку JS. Модули те же, что в dynamic —
  // повторный import() бесплатен, просто кладёт чанк в кэш браузера.
  // v5.81: 1.2с вместо 3.5с — ранние тапи не качают чанк на медленной сети.
  useEffect(() => {
    if (!authReady || !user || !appOpen) return
    const t = window.setTimeout(() => {
      void import('@/components/feed/PostOverlay')
      void import('@/components/feed/CommentsSheet')
      void import('@/components/profile/UserProfileSheet')
      void import('@/components/tabs/SearchTab')
      void import('@/components/tabs/QuestsTab')
      void import('@/components/tabs/ChannelTab')
      void import('@/components/tabs/ProfileTab')
    }, 1_200)
    return () => window.clearTimeout(t)
  }, [authReady, user, appOpen])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // v5.80: authenticate больше не может уронить этот эффект неожиданным
      // исключением — раньше любое необработанное исключение (глюк webview,
      // отсутствие AbortSignal.timeout в старых клиентах) оставлял authReady=false
      // НАВСЕГДА = бесконечный сплэш. Теперь готовность ставится всегда.
      try {
        await authenticate()
      } catch {
        setAuthError(true)
      }
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

  /*
   * v5.80 ВАТЧДОГ СПЛЭША — гарантия против «бесконечного загрузочного экрана».
   * Какой бы ни была причина зависания (чёрная дыра мобильной сети, глухой
   * прокси, необработанное исключение в старом webview, зависший запрос без
   * таймаута): если за 12с приложение так и не вышло из сплэша — принудительно
   * открываем экран «Повторить». Нормальный вход занимает 1-3с, поэтому ватчдог
   * вживую не срабатывает никогда; если поздний ответ всё же придёт — он
   * молча доведёт приложение до ленты поверх экрана ошибки (самоизлечение).
   */
  useEffect(() => {
    const stuckOnSplash = !needLogin && !authError && (!authReady || !user || !splashMinDone)
    if (!stuckOnSplash) return
    const t = setTimeout(() => {
      setAuthError(true)
      setAuthReady(true)
    }, 12_000)
    return () => clearTimeout(t)
  }, [needLogin, authError, authReady, user, splashMinDone])

  /*
   * v5.45 DEEP-LINK ИЗ УВЕДОМЛЕНИЯ БОТА: кнопка «Перейти к уведомлению»
   * открывает миниапп как t.me/tgswipe_bot/tgswipe?startapp=n_<postId>[_<commentId>].
   * Payload приходит в initDataUnsafe.start_param; cuid не содержит «_», поэтому
   * разбор надёжен: n_<postId> — пост, n_<postId>_<commentId> — комментарии
   * на этом комментарии (ветка раскроется, строка подсветится). Один раз за запуск.
   */
  const startParamHandled = useRef(false)
  useEffect(() => {
    if (!authReady || !user || !appOpen || startParamHandled.current) return
    const sp = tg()?.initDataUnsafe?.start_param?.trim() ?? ''
    if (!sp) return
    startParamHandled.current = true
    const m = /^n_([A-Za-z0-9]+)(?:_([A-Za-z0-9]+))?$/.exec(sp)
    if (!m) return
    const [, postId, commentId] = m
    // Даём ленте первые кадры, чтобы переход был не на пустом экране
    const timer = window.setTimeout(() => {
      openCommentsById(postId, 0, commentId ?? null)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [authReady, user, appOpen, openCommentsById])

  /** Смена вкладки с направлением анимации */
  const switchTo = (next: Tab) => {
    if (next !== tab) {
      haptic('light')
      goToTab(next)
    }
  }

  // Горизонтальный свайп между вкладками (нативный жест мобильных приложений).
  // v5.70: с фильтром траектории (см. комментарий у констант выше) — не
  // срабатывает на вертикальном скролле с дрейфом и на каруселях/пилюлах
  // (те дополнительно закрыты data-noswipe). Свои touch-жесты FeedView
  // (pull-to-refresh) и PostOverlay (листание постов) не трогаем: мы ничего
  // не preventDefault/stopPropagation — события доходят до них как раньше.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    const target = e.target as HTMLElement
    touchRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      valid: !target.closest('[data-noswipe]'),
      maxDx: 0,
      maxDy: 0,
      dirty: false,
    }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const st = touchRef.current
    if (!st || st.dirty) return
    const t = e.touches[0]
    // maxDx обновляем ПЕРВЫМ: если в одном кадре переехали и 64px по X,
    // и 24px по Y — горизонталь считается достигнутой первой (жест плоский)
    st.maxDx = Math.max(st.maxDx, Math.abs(t.clientX - st.x))
    st.maxDy = Math.max(st.maxDy, Math.abs(t.clientY - st.y))
    // Вертикаль «победила» первой — это скролл ленты/контента, не свайп вкладок
    if (st.maxDy >= VERTICAL_LIMIT && st.maxDx < SWIPE_DIST) st.dirty = true
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const st = touchRef.current
    touchRef.current = null
    if (!st?.valid || st.dirty) return
    const t = e.changedTouches[0]
    const dx = t.clientX - st.x
    const adx = Math.abs(dx)
    const ady = Math.abs(t.clientY - st.y)
    // Флик быстрее 220мс переключает с мягкого порога; обычный свайп — с 64px
    if (adx < (Date.now() - st.t < FLICK_MS ? FLICK_DIST : SWIPE_DIST)) return
    // Жест обязан быть чисто горизонтальным на финише: горизонталь ≥ 2× вертикали
    if (adx <= ady * 2) return
    const idx = TABS.indexOf(tab)
    const next = dx < 0 ? idx + 1 : idx - 1
    if (next >= 0 && next < TABS.length) switchTo(TABS[next])
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
    if (authReady && !user && authError) {
      return <AuthErrorScreen onRetry={() => { setAuthError(false); setAuthReady(false); void authenticate().catch(() => setAuthError(true)).finally(() => setAuthReady(true)) }} />
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

  // Не выпущено (владелец ещё не нажал «Выпустить») — экран разработки, НЕ техработы
  if (prerelease) {
    return (
      <PreReleaseScreen
        onRetry={async () => {
          await authenticate()
          return !useApp.getState().prerelease
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
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
            >
              {tab === 'feed' && <FeedView />}
              {tab === 'quests' && <QuestsTab />}
              {tab === 'search' && <SearchTab />}
              {tab === 'channel' && <ChannelTab />}
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
      {/* Приветственный гайд (v5.58): один раз, с «Пропустить» */}
      <AnimatePresence>{welcome.open && <WelcomeGuide onDone={welcome.close} />}</AnimatePresence>
      {/* v5.76: живой туториал — 4 шага в реальном времени, можно пропустить.
          Показывается после WelcomeGuide, только авторизованным, один раз */}
      <TutorialCoach active={appOpen && Boolean(user) && !welcome.open} />
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
 * Экран ошибки входа (v5.52): сеть моргнула/API упал/таймаут — понятный экран
 * с повтором вместо вечного пустого сплэша.
 */
function AuthErrorScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-tg-bg px-6">
      <div className="w-full max-w-sm rounded-3xl border border-tg-sep bg-tg-surface p-7 text-center shadow-xl">
        <div
          className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-tg-like/15 text-tg-like"
          aria-hidden
        >
          <WifiOff className="size-8" />
        </div>
        <h1 className="mt-4 text-xl font-bold text-tg-text">Не удалось загрузиться</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-tg-hint">
          Похоже, пропало соединение. Проверьте интернет и попробуйте ещё раз — обычно это
          занимает секунду.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-tg-link text-[15.5px] font-bold text-white transition active:scale-[0.98]"
        >
          <RotateCcw className="size-5" aria-hidden />
          Повторить
        </button>
      </div>
    </main>
  )
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
