'use client'

import { motion } from 'framer-motion'

/**
 * Загрузочный экран: фирменный самолётик Telegram без подложки,
 * «полёт на месте» (покачивание с креном) и пунктирная трасса,
 * точки которой утекают за самолётик. Цвет — активная тема.
 */

// Классический контур самолётика Telegram (24×24, заливка)
const PLANE_PATH =
  'M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.55 0-.46-.21-.65-.66L6.6 14.04l-5.45-1.7c-1.18-.36-1.19-1.18.25-1.75l21.26-8.2c.97-.43 1.9.24 1.25 1.4z'

export function Splash() {
  return (
    <div className="flex h-dvh justify-center bg-tg-bg" role="status" aria-label="Загрузка приложения">
      <div className="flex h-full w-full max-w-[430px] flex-col items-center justify-center bg-tg-bg md:border-x md:border-tg-sep">
        {/* Сцена полёта */}
        <div className="relative flex h-40 w-60 items-center justify-center">
          {/* Трасса: точки утекают вдоль дуги к самолётику */}
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 240 160" fill="none" aria-hidden>
            <motion.path
              d="M20 136 C 62 126, 102 100, 126 80 C 146 64, 162 52, 180 40"
              stroke="currentColor"
              className="text-tg-link"
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray="0.1 11"
              initial={{ strokeDashoffset: 60, opacity: 0 }}
              animate={{ strokeDashoffset: [60, -30], opacity: [0, 0.9, 0.9, 0] }}
              transition={{
                duration: 2.6,
                repeat: Infinity,
                ease: 'easeOut',
                times: [0, 0.2, 0.75, 1],
              }}
            />
          </svg>

          {/* Самолётик: влёт по дуге, затем полёт на месте */}
          <motion.div
            initial={{ x: -64, y: 52, scale: 0.55, opacity: 0, rotate: 8 }}
            animate={{ x: 0, y: 0, scale: 1, opacity: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 110, damping: 13 }}
          >
            <motion.div
              animate={{ y: [0, -10, 0, -5, 0], rotate: [-7, -12, -7, -9, -7] }}
              transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
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
          transition={{ delay: 0.4, duration: 0.55, ease: 'easeOut' }}
          className="mt-3 flex flex-col items-center gap-1"
        >
          <span className="text-[26px] font-bold tracking-tight text-tg-text">TG-Feed</span>
          <span className="text-[14.5px] text-tg-hint">Собираем свежие посты…</span>
        </motion.div>
      </div>
    </div>
  )
}
