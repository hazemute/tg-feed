'use client'

import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check, ChevronDown, ListChecks, Loader2, Megaphone, Search, Sparkles, UserRound, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { markOnboardedServer } from '@/lib/onboarding'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'
import { SwipeIcon } from '@/components/tg/SwipeIcon'
import type { Tab } from '@/lib/types'

/**
 * WELCOME-ГАЙД (v5.58, редизайн v5.66):
 *
 *  • 4 слайда: что за сервис → свайпы/задания → пульт каналов → ВЫБОР ИНТЕРЕСОВ;
 *  • слайд 4: категории — лента «Всё» сразу подстраивается под выбор
 *    (POST /api/user/categories), а фильтр языка по умолчанию становится «ru»
 *    (меньше нерусских постов, v5.66 — по запросу владельца);
 *  • подсказки-пилюли В ПОТОКЕ (не absolute) — ничего не наезжает на текст
 *    на низких экранах (фикс вёрстки v5.66);
 *  • «Пропустить» доступен всегда; показывается один раз (tgfeed_welcome_v1).
 */

const DONE_KEY = 'tgfeed_welcome_v1'
const POSTLANG_KEY = 'tgfeed_postlang'
/** Событие для FeedView: перечитать фильтр языка из localStorage */
export const LANGPREF_EVENT = 'tgfeed:langpref'

export function welcomeDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1'
  } catch {
    return true // приватный режим — не показываем
  }
}

function markWelcomeDone(): void {
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {
    /* приватный режим — гайд просто покажется снова при следующем входе */
  }
  // v5.85: дублируем отметку на сервере — localStorage в Telegram-клиентах
  // чистится между сессиями, из-за чего гайд вылезал при каждом заходе
  markOnboardedServer()
}

/* ---------------- Мини-макет нижней навигации (подсказки) ---------------- */

const NAV_MOCK: { id: Tab; icon: typeof Zap; label: string }[] = [
  { id: 'feed', icon: Zap, label: 'Лента' },
  { id: 'quests', icon: ListChecks, label: 'Задания' },
  { id: 'channel', icon: Megaphone, label: 'Канал' },
  { id: 'search', icon: Search, label: 'Поиск' },
  { id: 'profile', icon: UserRound, label: 'Профиль' },
]

function NavMock({ highlight, hint }: { highlight: Tab; hint: string }) {
  const hi = NAV_MOCK.findIndex((n) => n.id === highlight)
  return (
    <div className="mx-auto mt-5 flex w-fit flex-col items-center" aria-hidden>
      {/* Пилюля-подсказка В ПОТОКЕ — v5.66: раньше absolute -top-11 наезжала на текст */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: [0, -3, 0] }}
        transition={{
          opacity: { delay: 0.4, duration: 0.3 },
          y: { delay: 0.4, duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
        }}
        className="flex flex-col items-center"
      >
        <span className="whitespace-nowrap rounded-full bg-tg-link px-3 py-1 text-[11.5px] font-bold text-white shadow-md shadow-tg-link/30">
          {hint}
        </span>
        <ChevronDown className="-mt-0.5 h-4 w-4 text-tg-link" strokeWidth={2.5} />
      </motion.div>
      {/* Капсула навигации как в приложении */}
      <div className="mt-0.5 flex items-center gap-0 rounded-[24px] border border-tg-sep/80 bg-tg-surface/85 p-1 shadow-[0_2px_8px_rgba(0,0,0,0.06),0_16px_40px_-8px_rgba(0,0,0,0.24)] backdrop-blur-xl dark:bg-tg-surface/80 dark:shadow-[0_2px_10px_rgba(0,0,0,0.35),0_16px_40px_-10px_rgba(0,0,0,0.5)]">
        {NAV_MOCK.map(({ id, icon: Icon, label }, i) => {
          const active = id === highlight
          return (
            <div
              key={id}
              className={cn(
                'relative flex h-[46px] w-[54px] flex-col items-center justify-center gap-[3px] rounded-[17px] transition-colors',
                active && 'bg-tg-link/12',
              )}
            >
              <motion.span
                animate={active ? { scale: [1, 1.12, 1] } : {}}
                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
              >
                <Icon
                  className={cn('h-[19px] w-[19px]', active ? 'text-tg-link' : 'text-tg-hint')}
                  strokeWidth={active ? 2.3 : 1.8}
                />
              </motion.span>
              <span
                className={cn(
                  'text-[9px] leading-none',
                  active ? 'font-semibold text-tg-link' : 'font-medium text-tg-hint',
                )}
              >
                {label}
              </span>
              {i < NAV_MOCK.length - 1 && <span className="absolute -right-px inset-y-4 w-px bg-tg-sep/40" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------- Визуалы слайдов ---------------- */

/** Слайд 1: карточка поста с жестом свайпа */
function SwipeVisual() {
  return (
    <div className="relative mx-auto mt-4 h-[150px] w-[220px]" aria-hidden>
      <div className="absolute inset-x-6 top-3 h-[128px] rotate-[6deg] rounded-2xl bg-tg-surface opacity-70 shadow-sm" />
      <div className="absolute inset-x-3 top-1.5 h-[134px] -rotate-[3deg] rounded-2xl bg-tg-surface opacity-85 shadow" />
      <motion.div
        animate={{ x: [-14, 14, -14], rotate: [-4, 4, -4] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute inset-0 rounded-2xl border border-tg-sep/60 bg-tg-surface p-3.5 shadow-lg"
      >
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-tg-link/25" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2 w-2/3 rounded bg-tg-sep" />
            <div className="h-1.5 w-1/3 rounded bg-tg-sep/70" />
          </div>
        </div>
        <div className="mt-2.5 space-y-1.5">
          <div className="h-1.5 w-full rounded bg-tg-sep/70" />
          <div className="h-1.5 w-5/6 rounded bg-tg-sep/70" />
          <div className="h-1.5 w-4/6 rounded bg-tg-sep/70" />
        </div>
        <div className="absolute bottom-3 left-3.5 flex items-center gap-1 rounded-full bg-tg-like/15 px-2 py-1">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-tg-like">
            <path d="M12 21s-7.5-4.7-10-9.3C.4 8.6 2.4 4.5 6.2 4.5c2.2 0 3.9 1.2 4.8 3 1-1.8 2.6-3 4.8-3 3.8 0 5.8 4.1 4.2 7.2C17.5 16.3 12 21 12 21z" />
          </svg>
          <span className="text-[10px] font-bold text-tg-like">128</span>
        </div>
      </motion.div>
      <motion.div
        animate={{ x: [-28, 28, -28] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute -bottom-2 left-1/2 -ml-3"
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-tg-link text-white shadow-lg shadow-tg-link/40">
          <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
            <path d="M9.5 3.5c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5V10h.8l4.9 1.5c.9.3 1.5 1.1 1.5 2v3.6c0 .6-.2 1.2-.6 1.7l-2.4 2.7c-.5.6-1.2.9-1.9.9H11c-.8 0-1.5-.3-2-.9l-3.6-4c-.5-.6-.5-1.5.1-2.1.6-.6 1.5-.6 2.1-.1l1.9 1.7V3.5z" />
          </svg>
        </div>
      </motion.div>
    </div>
  )
}

/** Слайд 2: свайпы — молния с искрами (v5.66: компактнее, чипы внутри контейнера) */
function SwipesVisual() {
  return (
    <div className="relative mx-auto mt-4 flex h-[132px] w-[240px] items-center justify-center" aria-hidden>
      <motion.div
        animate={{ scale: [1, 1.06, 1] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-tg-link/12"
      >
        <SwipeIcon size={44} className="text-tg-link" />
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute h-2 w-2 rounded-full bg-tg-link"
            animate={{ opacity: [0, 1, 0], scale: [0.4, 1, 0.4], y: [-6, -13, -6], x: [0, i === 1 ? -16 : i === 0 ? 16 : 0, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.45 }}
          />
        ))}
      </motion.div>
      {/* Чипы-подсказки — строго внутри контейнера, за границы не вылезают */}
      <motion.span
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, delay: 0.3 }}
        className="absolute left-0 top-1 flex items-center gap-1 rounded-full bg-tg-green/15 px-2.5 py-1 text-[11px] font-bold text-tg-green"
      >
        <SwipeIcon size={12} />+500
      </motion.span>
      <motion.span
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, delay: 1 }}
        className="absolute right-0 top-9 rounded-full bg-tg-star/15 px-2.5 py-1 text-[11px] font-bold text-tg-star"
      >
        Нейросети
      </motion.span>
      <motion.span
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, delay: 1.6 }}
        className="absolute bottom-0 right-1 rounded-full bg-tg-link/12 px-2.5 py-1 text-[11px] font-bold text-tg-link"
      >
        500 свайпов = 1 ₽
      </motion.span>
    </div>
  )
}

/* ---------------- Основной компонент ---------------- */

type Slide = {
  title: string
  text: React.ReactNode
  visual: React.ReactNode
  navHighlight?: Tab
  navHint?: string
  cta: string
}

export function WelcomeGuide({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const categories = useApp((s) => s.categories)
  const user = useApp((s) => s.user)
  const setUser = useApp((s) => s.setUser)
  const setInterests = useApp((s) => s.setInterests)
  const setCategory = useApp((s) => s.setCategory)
  // предвыбор: текущие интересы (обычно пусто — гайд на первом входе)
  const [picked, setPicked] = useState<string[]>(() => {
    const cats = useApp.getState().categories
    const pre = useApp.getState().user?.categories ?? []
    // предвыбор только по категориям, которые реально показаны (без «other»)
    const visible = new Set(cats.map((c) => c.slug))
    return pre.filter((s) => visible.has(s))
  })
  const [saving, setSaving] = useState(false)

  const toggle = (slug: string) => {
    haptic('light')
    setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]))
  }

  // Финал: сохраняем интересы (не гостям), фильтр языка ru по умолчанию, лента «Всё»
  const finishWithPrefs = async () => {
    setSaving(true)
    try {
      // 1) язык ленты: «ru» по умолчанию (меньше нерусских постов); явный выбор не трогаем
      try {
        const cur = localStorage.getItem(POSTLANG_KEY)
        if (!cur) localStorage.setItem(POSTLANG_KEY, 'ru')
      } catch { /* приватный режим */ }
      // 2) интересы → лента «Всё» фильтруется по выбранным категориям
      //    (гостям тоже сохраняем в их строку User — персонализация сессии)
      if (picked.length > 0) {
        await api('/api/user/categories', {
          method: 'POST',
          body: JSON.stringify({ categoryIds: picked }),
        }).catch(() => {})
        setInterests(picked)
        if (user) setUser({ ...user, categories: picked })
      }
      setCategory('all')
    } finally {
      setSaving(false)
    }
    window.dispatchEvent(new CustomEvent(LANGPREF_EVENT))
    haptic('success')
    markWelcomeDone()
    onDone()
  }

  // Быстрый выход «Пропустить» — без сохранения выбора, но язык по умолчанию ставим
  const skip = () => {
    try {
      if (!localStorage.getItem(POSTLANG_KEY)) localStorage.setItem(POSTLANG_KEY, 'ru')
    } catch { /* приватный режим */ }
    window.dispatchEvent(new CustomEvent(LANGPREF_EVENT))
    haptic('light')
    markWelcomeDone()
    onDone()
  }

  const slides: Slide[] = useMemo(
    () => [
      {
        title: 'Добро пожаловать в Tg Swipe',
        text: (
          <>
            Единая интерактивная лента ваших любимых Telegram-каналов: листайте посты свайпом,
            как в привычных приложениях — без переходов и лишних тапов.
          </>
        ),
        visual: <SwipeVisual />,
        cta: 'Дальше',
      },
      {
        title: 'Свайпы — валюта приложения',
        text: (
          <>
            Выполняйте простые задания и получайте свайпы. Ими оплачиваются запросы к нейросетям,
            а обменять можно в кошельке: <b>500 свайпов = 1 ₽</b>.
          </>
        ),
        visual: <SwipesVisual />,
        navHighlight: 'quests',
        navHint: 'Задания за свайпы',
        cta: 'Дальше',
      },
      {
        title: 'Владельцам каналов — полный пульт',
        text: (
          <>
            Привяжите канал во вкладке «Канал»: живая статистика, показ в ленте, продвижение
            и <b>ИИ-ассистент</b>, который напишет и опубликует пост — по одной фразе.
          </>
        ),
        visual: null,
        navHighlight: 'channel',
        navHint: 'Пульт вашего канала',
        cta: 'Дальше',
      },
      {
        title: 'Что вам интересно?',
        text: (
          <>
            Выберите темы — <b>лента подстроится под ваш выбор</b>. Изменить можно в любой
            момент в профиле.
          </>
        ),
        visual: null,
        cta: picked.length > 0 ? 'Начать читать' : 'Выберите хотя бы одну',
      },
    ],
    [picked.length],
  )

  const slide = slides[step]!
  const last = step === slides.length - 1
  const canNext = !last || picked.length > 0

  const next = () => {
    haptic('light')
    if (last) {
      if (!canNext) return
      void finishWithPrefs()
    } else {
      setStep((s) => s + 1)
    }
  }

  // Кнопка «Пропустить» всегда видна — гайд никогда не блокирует приложение
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[80] mx-auto flex w-full flex-col overflow-hidden bg-tg-bg lg:bottom-auto lg:top-[6vh] lg:h-[88vh] lg:max-w-[560px] lg:rounded-3xl lg:border lg:border-tg-sep lg:shadow-[0_24px_90px_rgba(0,0,0,0.30)]"
      role="dialog"
      aria-modal="true"
      aria-label="Знакомство с Tg Swipe"
    >
      {/* Верх: прогресс + пропуск */}
      <div className="flex shrink-0 items-center justify-between px-5 pt-4">
        <div className="flex items-center gap-1.5" aria-hidden>
          {slides.map((_, i) => (
            <span
              key={i}
              className={cn(
                'h-1.5 rounded-full transition-all duration-300',
                i === step ? 'w-6 bg-tg-link' : 'w-1.5 bg-tg-sep',
              )}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={skip}
          className="flex h-9 items-center rounded-full px-3.5 text-[13.5px] font-semibold text-tg-hint transition active:scale-95 motion-reduce:transition-none"
        >
          Пропустить
        </button>
      </div>

      {/* Контент слайда */}
      <div className="no-scrollbar flex flex-1 flex-col overflow-y-auto px-6 pb-2">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 32 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -32 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="flex flex-1 flex-col"
          >
            {slide.visual}
            <h1 className="mt-5 text-[23px] font-bold leading-tight tracking-tight text-tg-text">
              {slide.title}
            </h1>
            <p className="mt-2 text-[14.5px] leading-relaxed text-tg-hint [&_b]:font-semibold [&_b]:text-tg-text">
              {slide.text}
            </p>
            {slide.navHighlight ? (
              <NavMock highlight={slide.navHighlight} hint={slide.navHint ?? ''} />
            ) : null}
            {last && (
              <div className="mt-4 flex-1">
                {categories.length === 0 ? (
                  <div className="flex h-24 items-center justify-center gap-2 text-[13.5px] text-tg-hint">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Загружаем категории…
                  </div>
                ) : (
                  <div
                    className="flex flex-wrap content-start gap-2 pb-2"
                    role="group"
                    aria-label="Выберите интересующие категории"
                  >
                    {categories.map((c) => {
                      const on = picked.includes(c.slug)
                      return (
                        <button
                          key={c.slug}
                          type="button"
                          onClick={() => toggle(c.slug)}
                          aria-pressed={on}
                          className={cn(
                            'press flex h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium',
                            on
                              ? 'bg-tg-link text-white shadow-sm shadow-tg-link/30'
                              : 'bg-tg-surface text-tg-text',
                          )}
                        >
                          {on && <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />}
                          <span aria-hidden>{c.emoji}</span>
                          {c.title}
                        </button>
                      )
                    })}
                  </div>
                )}
                <p className="mt-2 text-[12px] text-tg-hint" aria-live="polite">
                  Выбрано: {picked.length} · в ленте будут приоритетны ваши темы
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Низ: CTA */}
      <div className="shrink-0 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
        <button
          type="button"
          onClick={next}
          disabled={!canNext || saving}
          className={cn(
            'press flex h-[54px] w-full items-center justify-center gap-2 rounded-full text-[16px] font-bold shadow-lg transition',
            canNext && !saving
              ? 'bg-tg-link text-white shadow-tg-link/25'
              : 'cursor-not-allowed bg-tg-surface text-tg-hint shadow-none',
          )}
        >
          {saving ? <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden /> : null}
          {saving ? 'Сохраняем…' : slide.cta}
          {!last && !saving && <ArrowRight className="h-[18px] w-[18px]" aria-hidden />}
          {last && canNext && !saving && <Sparkles className="h-[18px] w-[18px]" aria-hidden />}
        </button>
        <p className="mt-2.5 text-center text-[11px] leading-snug text-tg-hint">
          {last ? 'Лента уже ждёт — приятного чтения' : 'Гайд можно пропустить и вернуться позже'}
        </p>
      </div>
    </motion.div>
  )
}

/** Хук монтирования гайда: показать один раз после готовности приложения.
 * v5.85 ФИКС «ГАЙД ПРИ КАЖДОМ ЗАХОДЕ»:
 *  • отметка «показан» пишется В МОМЕНТ показа (а не только по «Готово»/«Пропустить»);
 *  • если сервер говорит user.onboarded — гайд не показываем вообще,
 *    даже если localStorage был почищен клиентом Telegram. */
export function useWelcomeGuide(ready: boolean): { open: boolean; close: () => void } {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(() => {
      if (useApp.getState().user?.onboarded) return // серверная отметка — главная
      if (welcomeDone()) return
      markWelcomeDone()
      setOpen(true)
    }, 900) // даём ленте первые кадры — гайд поверх готового приложения
    return () => window.clearTimeout(t)
  }, [ready])
  return { open, close: () => setOpen(false) }
}
