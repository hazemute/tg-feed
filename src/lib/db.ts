import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

/*
 * SQLite-песочница (локальная разработка): журнал WAL. Читатели (лента, тренды,
 * параллельные batch-запросы) больше не блокируют писателя (лайки/просмотры) —
 * параллельные запросы перестают ловить «database is locked» на холодном старте.
 * journal_mode хранится в файле БД: достаточно выполнить один раз при старте.
 */
if ((process.env.DATABASE_URL ?? '').startsWith('file:')) {
  // PRAGMA journal_mode ВОЗВРАЩАЕТ результат (новый режим) — только queryRaw,
  // executeRaw в SQLite-коннекторе Prisma на это падает
  void db
    .$queryRawUnsafe('PRAGMA journal_mode=WAL;')
    .catch(() => {}) // если уже WAL/файл занят — не роняем старт
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db