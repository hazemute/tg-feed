'use client'

import { motion } from 'framer-motion'

/**
 * Загрузочный экран: самолётик Telegram без подложки, «полёт на месте» —
 * плавное покачивание с креном. Пунктирная трасса тянется строго ПОЗАДИ:
 * точки рождаются у хвоста и утекают назад, растворяясь вдали — линия
 * никогда не заходит вперёд самолётика. Цвет — активная тема.
 */

// Классический контур самолётика Telegram (24×24, заливка)
const PLANE_PATH =
  'M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.55 0-.46-.21-.65-.66L6.6 14.04l-5.45-1.7c-1.18-.36-1.19-1.18.25-1.75l21.26-8.2c.97-.43 1.9.24 1.25 1.4z'

/*
 * Трасса: сцена 256×176 (1:1 с px), самолётик 104px в центре (128, 88).
 * Кривая заканчивается у хвоста (~76,104) — позади центра, а градиент
 * гасит точки до нуля ещё ДО конца пути: даже при покачивании с креном
 * ни одна точка не оказывается впереди или вплотную к самолётику.
 * Период пунктира 11.1, сдвиг за цикл 22.2 = ровно 2 периода —
 * поток точек бесшовный, без рывка на повторе.
 */
const TRAIL_PATH = 'M12 162 C 36 150, 58 130, 76 104'

export function Splash() {
  return (
    <div className="flex h-dvh justify-center bg-tg-bg" role="status" aria-label="Загрузка приложения">
      <div className="flex h-full w-full max-w-[430px] flex-col items-center justify-center bg-tg-bg md:border-x md:border-tg-sep">
        {/* Сцена полёта */}
        <div className="relative flex h-44 w-64 items-center justify-center">
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 256 176" fill="none" aria-hidden>
            <defs>
              <linearGradient
                id="splash-trail-fade"
                gradientUnits="userSpaceOnUse"
                x1="12"
                y1="162"
                x2="76"
                y2="104"
              >
                {/* дальний конец — точки растворяются; у хвоста — рождаются */}
                <stop offset="0" stopColor="currentColor" stopOpacity="0" />
                <stop offset="0.32" stopColor="currentColor" stopOpacity="0.85" />
                <stop offset="0.72" stopColor="currentColor" stopOpacity="0.5" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <motion.path
              d={TRAIL_PATH}
              stroke="url(#splash-trail-fade)"
              className="text-tg-link"
              strokeWidth={3.2}
              strokeLinecap="round"
              strokeDasharray="0.1 11"
              initial={{ opacity: 0, strokeDashoffset: 0 }}
              animate={{ opacity: 1, strokeDashoffset: 22.2 }}
              transition={{
                opacity: { duration: 0.7, delay: 0.55 },
                strokeDashoffset: { duration: 2.9, repeat: Infinity, ease: 'linear', delay: 0.55 },
              }}
            />
          </svg>

          {/* Самолётик: мягкий влёт по дуге → полёт на месте (стыка нет:
              покачивание стартует ровно из конечной позы влёта) */}
          <motion.div
            initial={{ x: -76, y: 64, scale: 0.5, opacity: 0, rotate: 6 }}
            animate={{ x: 0, y: 0, scale: 1, opacity: 1, rotate: -9 }}
            transition={{
              duration: 1.15,
              ease: [0.22, 0.68, 0.3, 1],
              opacity: { duration: 0.45, ease: 'easeOut' },
            }}
          >
            <motion.div
              animate={{ y: [0, -9, 0], rotate: [-9, -13, -9] }}
              transition={{ duration: 3.8, repeat: Infinity, ease: 'easeInOut' }}
              className="text-tg-link drop-shadow-sm"
            >
              <svg width="104" height="104" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d={PLANE_PATH} />
              </svg>
            </motion.div>
          </motion.div>
        </div>

        {/* Подпись */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6, ease: 'easeOut' }}
          className="mt-3 flex flex-col items-center gap-1"
        >
          <span className="text-[27px] font-bold tracking-tight text-tg-text">Tg Swipe</span>
          <span className="text-[14.5px] text-tg-hint">Собираем свежие посты…</span>
        </motion.div>
      </div>
    </div>
  )
}
