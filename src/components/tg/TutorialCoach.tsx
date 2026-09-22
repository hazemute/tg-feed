'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useApp } from '@/lib/store'
import { haptic } from '@/lib/tg'

/**
 * v5.76: ЖИВОЙ ТУТОРИАЛ — 4 шага, которые отслеживают действия в реальном
 * времени (не душно: ничего не блокирует интерфейс, каждый шаг — одна фраза).
 *
 *  1. «Листай ленту» — завершается, когда юзер реально проскроллил ленту
 *     (scroll-события через capture — работают для любого скролл-контейнера).
 *  2. «Реагируй» — про лайк/закладку/«не интересно» (инфо-шаг).
 *  3. «Вкладки внизу» — завершается, когда юзер переключил вкладку.
 *  4. «Готов!» — финал.
 *
 * Пропустить — всегда одной кнопкой. Показывается один раз
 * (localStorage), после закрытия WelcomeGuide. Гостям не показывается.
 */

/**
 * v5.78: СБРОС ТУТОРИАЛА ДЛЯ ВСЕХ (приказ владельца) — ключ завершения
 * версионирован. Было: 'tg_tutorial_v1' → '1' ставился навсегда, повторный
 * показ был невозможен. Теперь: ключ содержит TUTORIAL_VERSION, при бампе
 * версии (v2 → v3 → …) у всех пользователей — включая уже заходивших —
 * туториал показывается заново. Следующий сброс = TUTORIAL_VERSION 'v3'.
 */
const TUTORIAL_VERSION = 'v2'
const DONE_KEY = `tg_tutorial_done_${TUTORIAL_VERSION}`

type Step = {
  emoji: string
  title: string
  text: string
  /** что завершает шаг: скролл ленты / переключение вкладки / кнопка */
  doneOn: 'scroll' | 'tab' | 'next'
  /** порог скролла в px для doneOn: 'scroll' */
  scrollPx?: number
}

const STEPS: Step[] = [
  {
    emoji: '👆',
    title: 'Листай ленту',
    text: 'Свайп вверх — новый пост. Лента сама подстроится под то, что тебе интересно.',
    doneOn: 'scroll',
    scrollPx: 500,
  },
  {
    emoji: '⚡️',
    title: 'Реагируй',
    text: 'Лайк, закладка, «Не интересно» — алгоритм учится с каждого касания.',
    doneOn: 'scroll',
    scrollPx: 400,
  },
  {
    emoji: '🧭',
    title: 'Вкладки внизу',
    text: 'Задания — бесплатные свайпы · Каналы — свой кабинет · Поиск — новое · Профиль — уровень и XP.',
    doneOn: 'tab',
  },
  {
    emoji: '🎉',
    title: 'Ты готов!',
    text: 'Всё просто. Приятного свайпинга!',
    doneOn: 'next',
  },
]

export function TutorialCoach({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const scrollAccum = useRef(0)
  const advancing = useRef(false)
  const tab = useApp((s) => s.tab)

  // Старт: готовый вход, закрытый WelcomeGuide, не пройден ранее
  useEffect(() => {
    if (!active) return
    try {
      if (localStorage.getItem(DONE_KEY) === '1') return
    } catch {
      return
    }
    const t = setTimeout(() => setOpen(true), 1400)
    return () => clearTimeout(t)
  }, [active])

  const finish = useCallback(() => {
    try {
      localStorage.setItem(DONE_KEY, '1')
    } catch {
      /* приватный режим — просто закрываем */
    }
    setOpen(false)
  }, [])

  const advance = useCallback(() => {
    if (advancing.current) return
    advancing.current = true
    haptic('light')
    setStepIndex((i) => {
      const next = i + 1
      if (next >= STEPS.length) {
        finish()
        return i
      }
      scrollAccum.current = 0
      advancing.current = false
      return next
    })
    setTimeout(() => {
      advancing.current = false
    }, 350)
  }, [finish])

  const step = STEPS[Math.min(stepIndex, STEPS.length - 1)]

  /* Шаг со скроллом: копим вертикальный скролл ЛЮБОГО контейнера (capture) */
  useEffect(() => {
    if (!open || step.doneOn !== 'scroll') return
    scrollAccum.current = 0
    const onScroll = (e: Event) => {
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      // дельта по data-атрибуту: аккумулируем реальные вертикальные движения
      const prev = Number(target.dataset.tutPrev ?? 0)
      const delta = Math.abs(target.scrollTop - prev)
      target.dataset.tutPrev = String(target.scrollTop)
      scrollAccum.current += delta
      if (scrollAccum.current >= (step.scrollPx ?? 500)) advance()
    }
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [open, step, advance])

  /* Шаг с вкладкой: любое переключение вкладки завершает шаг */
  useEffect(() => {
    if (!open || step.doneOn !== 'tab') return
    if (tab !== 'feed') advance()
  }, [open, step, tab, advance])

  if (!open) return null

  return (
    <AnimatePresence>
      <motion.div
        key="tutorial"
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        className="pointer-events-none fixed inset-x-0 bottom-[76px] z-[70] flex justify-center px-4"
        role="dialog"
        aria-label="Короткий туториал по приложению"
      >
        <div className="pointer-events-auto w-full max-w-[360px] rounded-2xl border border-tg-sep bg-tg-bg/95 p-4 shadow-2xl backdrop-blur-md">
          {/* прогресс-точки */}
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex gap-1.5">
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  aria-hidden
                  className={
                    'h-1.5 rounded-full transition-all duration-300 ' +
                    (i === stepIndex ? 'w-5 bg-tg-link' : i < stepIndex ? 'w-1.5 bg-tg-link/60' : 'w-1.5 bg-tg-sep')
                  }
                />
              ))}
            </div>
            <button
              type="button"
              onClick={finish}
              className="rounded-full px-2 py-1 text-[13px] text-tg-hint transition active:scale-95"
            >
              Пропустить
            </button>
          </div>

          <div className="flex items-start gap-3">
            <span className="text-[28px] leading-none" aria-hidden>
              {step.emoji}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15.5px] font-bold text-tg-text">{step.title}</h2>
              <p className="mt-0.5 text-[13.5px] leading-snug text-tg-hint">{step.text}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={advance}
            className="mt-3 flex h-10 w-full items-center justify-center rounded-xl bg-tg-link text-[14.5px] font-semibold text-white transition active:scale-[0.98]"
          >
            {step.doneOn === 'next' ? 'Поехали 🚀' : 'Понятно, дальше'}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
