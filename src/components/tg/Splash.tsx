'use client'

import { motion } from 'framer-motion'

/**
 * Загрузочный экран: крупный самолётик Telegram без подложки и без
 * дополнительных деталей — только самолётик и подпись. Влёт по дуге,
 * затем «полёт на месте» (плавное покачивание с креном). Цвет — тема.
 */

// Классический контур самолётика Telegram (24×24, заливка)
const PLANE_PATH =
  'M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.55 0-.46-.21-.65-.66L6.6 14.04l-5.45-1.7c-1.18-.36-1.19-1.18.25-1.75l21.26-8.2c.97-.43 1.9.24 1.25 1.4z'

export function Splash() {
  return (
    <div className="flex h-dvh justify-center bg-tg-bg" role="status" aria-label="Загрузка приложения">
      <div className="flex h-full w-full max-w-[430px] flex-col items-center justify-center bg-tg-bg md:border-x md:border-tg-sep">
        {/* Самолётик: мягкий влёт по дуге → полёт на месте (стыка нет:
            покачивание стартует ровно из конечной позы влёта) */}
        <div className="flex h-44 w-64 items-center justify-center">
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
