'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import { CODE_WORD } from '@/components/legal/LegalShell'

/**
 * Экран «Приложение ещё разрабатывается» (v5.42, приказ владельца).
 *
 * Пока владелец НЕ нажал «Выпустить» в админ-панели, обычные пользователи
 * видят ЭТОТ экран — а НЕ «технические работы» (техработы — пост-релизный
 * режим). Админы (ADMIN_TG_IDS) и белый список допуска заходят свободно,
 * чтобы дорабатывать приложение до релиза.
 *
 * Полностью на токенах темы — одинаково уместен во всех палитрах.
 * Раз в 60с сам перепроверяет статус релиза; «Проверить снова» — вручную.
 */

const RETRY_SEC = 60

export function PreReleaseScreen({
  onRetry,
}: {
  /** пере-проверить статус; true — приложение выпущено (пользователя пропускаем) */
  onRetry: () => Promise<boolean>
}) {
  const [left, setLeft] = useState(RETRY_SEC)
  const [checking, setChecking] = useState(false)

  const check = async () => {
    if (checking) return
    setChecking(true)
    setLeft(RETRY_SEC)
    try {
      await onRetry()
    } finally {
      setChecking(false)
    }
  }

  // авто-перепроверка раз в минуту (вдруг релиз случился, пока экран открыт)
  useEffect(() => {
    const t = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          void check()
          return RETRY_SEC
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex h-dvh justify-center bg-tg-bg" role="status" aria-label="Приложение ещё разрабатывается">
      <div className="flex h-full w-full flex-col items-center justify-center bg-tg-bg px-8">
        {/* Ракета на взлёте в мягком кольце с орбитой */}
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 0.68, 0.3, 1] }}
          className="relative flex size-28 items-center justify-center"
        >
          <span className="absolute inset-0 rounded-full bg-tg-link/10" aria-hidden />
          {/* орбита с бегущей точкой — «разработка идёт» */}
          <motion.span
            aria-hidden
            className="absolute inset-1 rounded-full border border-dashed border-tg-sep"
            animate={{ rotate: 360 }}
            transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
          >
            <span className="absolute -top-[3px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-tg-link" />
          </motion.span>
          <motion.svg
            width="56"
            height="56"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
            className="text-tg-link"
            animate={{ y: [0, -5, 0], rotate: [-6, -10, -6] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          >
            <path d="M14.06 9.02l.92.92L5.92 19.5l-.92-.92 9.06-9.56zM17.66 3c-1.66 0-3.22.66-4.36 1.8-1.4 1.4-9.02 9.03-9.02 9.03l3.3 3.3s7.63-7.62 9.03-9.02A6.15 6.15 0 0 0 21 5.35S19.32 3 17.66 3zm-6.9 13.91l-1.13-1.13-1.13 1.13c-.35.35-.92.35-1.27 0l-1.3-1.3c.1.62.4 1.21.9 1.7l1.56 1.57c.6.6 1.57.6 2.17 0l1.13-1.13-1.13-1.13.2.29zm-4.24-.63l-.36-.35.36.35z" />
            <path d="M20.71 3.29A1.05 1.05 0 0 0 19.96 3c-1.34.05-2.62.6-3.56 1.54l-1.57 1.57 3.06 3.06 1.57-1.57A5.06 5.06 0 0 0 21 4.04c0-.28-.11-.55-.29-.75z" />
          </motion.svg>
          {/* огонёк двигателя — маленький бейдж у кольца */}
          <span
            className="absolute bottom-1 right-1 flex size-8 items-center justify-center rounded-full bg-tg-surface ring-1 ring-tg-sep"
            aria-hidden
          >
            <motion.span
              className="block size-2.5 rounded-full bg-tg-link"
              animate={{ scale: [1, 1.35, 1], opacity: [0.75, 1, 0.75] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            />
          </span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }}
          className="mt-6 flex flex-col items-center gap-2 text-center"
        >
          <h1 className="text-[22px] font-bold tracking-tight text-tg-text">
            Приложение ещё разрабатывается
          </h1>
          <p className="max-w-[310px] text-[14.5px] leading-relaxed text-tg-hint">
            Мы дорабатываем Tg Swipe и готовим к релизу. Оповестим, когда всё будет
            готово — оставайтесь на связи в нашем боте.
          </p>
        </motion.div>

        {/* Индикатор «статус разработки» */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="mt-5 flex items-center gap-2 rounded-full bg-tg-surface px-3.5 py-1.5 ring-1 ring-tg-sep"
        >
          <motion.span
            className="block size-1.5 rounded-full bg-amber-500"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            aria-hidden
          />
          <span className="text-[12.5px] font-medium text-tg-hint">Статус: закрытая разработка</span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45, duration: 0.5 }}
          className="mt-8 flex flex-col items-center gap-3"
        >
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking}
            className="flex min-h-[44px] items-center gap-2 rounded-full bg-tg-link px-6 text-[15px] font-semibold text-white shadow-sm transition-transform active:scale-95 disabled:opacity-60"
          >
            <RefreshCw className={checking ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
            {checking ? 'Проверяем…' : 'Проверить снова'}
          </button>
          <span className="text-xs tabular-nums text-tg-hint">
            Автопроверка через {left} с
          </span>
        </motion.div>

        {/* v5.43: документы сервиса — постоянные ссылки (требование платёжного
            провайдера: документация всегда доступна из бота/сайта) */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.55, duration: 0.5 }}
          className="mt-10 flex flex-col items-center gap-2"
        >
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 px-8">
            {[
              ['/terms', 'Соглашение'],
              ['/privacy', 'Конфиденциальность'],
              ['/pricing', 'Тарифы'],
              ['/contacts', 'Поддержка'],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-tg-hint underline-offset-2 transition-colors hover:text-tg-link hover:underline"
              >
                {label}
              </a>
            ))}
          </div>
          {/* ВРЕМЕННО (проверка владения проектом) — убрать после согласования */}
          <p className="text-[11.5px] text-tg-hint opacity-60">Кодовое слово проверки: {CODE_WORD}</p>
        </motion.div>
      </div>
    </div>
  )
}
