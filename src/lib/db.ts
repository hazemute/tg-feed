import { PrismaClient } from '@prisma/client'

/**
 * ПОДКЛЮЧЕНИЕ К БД (Task 8-b — устойчивость к пиковому трафику).
 *
 * Локальная песочница: SQLite (DATABASE_URL=file:…) — без изменений.
 * Прод (Vercel + Supabase Postgres): serverless-функции создают по контейнеру
 * каждая, и без настройки пул легко утыкается в лимит соединений Supabase.
 * Поэтому DATABASE_URL програмно ДОПОЛНЯЕТСЯ параметрами пула (секрет не
 * трогаем — хост/порт/юзер/пароль остаются как заданы в Vercel env):
 *   • pgbouncer=true        — режим transaction pooling Supavisor (порт 6543):
 *                             отключает prepared statements, несовместимые с
 *                             pgbouncer (P2024/"prepared statement s… already
 *                             exists" под нагрузкой);
 *   • connection_limit=8    — максимум соединений НА КОНТЕЙНЕР (супербезопасная
 *                             зона 5-10 для serverless: N контейнеров × 8
 *                             остаётся в пределах пула Supavisor). FLOOR:
 *                             заданное в env значение НИЖЕ 5 (например,
 *                             connection_limit=1 от deploy-скрипта) поднимается
 *                             до 8 — под бёрстом это очередь из одного
 *                             соединения на весь контейнер;
 *   • pool_timeout=15       — сек. ожидания свободного соединения, прежде чем
 *                             Prisma вернёт P2024 (запас к дефолтным 10с);
 *   • connect_timeout=10    — сек. на установку TCP/TLS (дефолт 5с мал для
 *                             холодных контейнеров Vercel);
 * Если параметр УЖЕ задан в Vercel env (и ≥ пола) — он НЕ переопределяется.
 *
 * ВАЖНО (transaction mode): транзакции обязаны быть короткими — соединение
 * закрепляется за транзакцией на всё её время. Все $transaction в проекте —
 * короткие batch-цепочки БД (внешние await — Telegram/OpenRouter fetch —
 * внутрь транзакций не заворачивались, проверено grep по src).
 *
 * statement_timeout на уровне Prisma-URL не поддерживается движком (проверено
 * по бинарнику query engine 6.19) — долгие запросы ограничивает клиентский
 * таймаут интерактивных транзакций (5-15с) и pool_timeout; строгий
 * statement_timeout при необходимости ставится ролью на стороне Supabase.
 */

const PG_POOL_DEFAULTS: Array<[string, string]> = [
  ['pgbouncer', 'true'],
  ['connection_limit', '8'],
  ['pool_timeout', '15'],
  ['connect_timeout', '10'],
]

/**
 * FLOOR на connection_limit (Task 8-b): deploy-supabase.sh исторически пишет
 * в Vercel env `connection_limit=1` (старая «максимально безопасная» практика).
 * Под пиковым трафиком это бутылочное горлышко: Node-контейнер обрабатывает
 * десятки параллельных запросов, и все они выстраиваются в ОДНУ очередь
 * соединения — p95 растёт линейно с числом параллельных запросов, хотя
 * Supavisor (transaction pooler) спокойно держит десятки клиентов.
 * Значения ниже пола поднимаем до 8 (зона 5-10 из рекомендаций Supabase для
 * serverless), явные значения ≥5 не трогаем (владелец осознанно настраивал).
 */
const CONNECTION_LIMIT_FLOOR = 8

/** Дополнить URL параметрами пула (секрет не меняем) */
function pooledDatasourceUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw

  /*
   * SQLite-песочница (Task 8-b): connection_limit=1 — официальная рекомендация
   * Prisma для SQLite. Один писатель в SQLite: несколько соединений пула
   * соревнуются за файл-лок, и без busy_timeout на КАЖДОМ соединении бёрст
   * параллельных /api/view-транзакций ловит «database is locked»/«Socket
   * timeout», а очередь пула намертво клинит (весь сервер стоит даже на
   * SELECT 1). С одним соединением Prisma сам честно ставит запросы в
   * in-process очередь — медленнее на бумаге, но без клинов; локальные
   * запросы занимают единицы мс, поэтому при 270 параллельных это ~1-2с.
   */
  if (/^file:/i.test(raw)) {
    if (/[?&]connection_limit=/.test(raw)) return raw
    return raw.includes('?') ? `${raw}&connection_limit=1` : `${raw}?connection_limit=1`
  }

  if (!/^postgres(ql)?:\/\//i.test(raw)) return raw // прочие схемы — как есть
  try {
    const u = new URL(raw)
    // connection_limit: отсутствует → дефолт; есть, но ниже пола → поднять
    const cl = Number(u.searchParams.get('connection_limit'))
    if (!Number.isFinite(cl) || cl < 5) u.searchParams.set('connection_limit', String(CONNECTION_LIMIT_FLOOR))
    for (const [name, value] of PG_POOL_DEFAULTS) {
      if (name === 'connection_limit') continue // уже разобрано выше
      if (u.searchParams.has(name)) continue
      u.searchParams.set(name, value)
    }
    return u.toString()
  } catch {
    return raw // неразбираемая строка — отдаём как есть (движок сам ругнётся)
  }
}

const datasourceUrl = pooledDatasourceUrl(process.env.DATABASE_URL)

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
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
  // Task 8-b: ожидание блокировки записи вместо мгновенного SQLITE_BUSY.
  // WAL решает «читатели блокируют писателя», но ПИСАТЕЛЬ по-прежнему один:
  // без busy_timeout параллельные /api/view-транзакции падают «database is
  // locked». Задержку выдерживают соединения пула, созданные после этого
  // вызова (SQLite-пул мал — покрывает практически все).
  void db
    .$queryRawUnsafe('PRAGMA busy_timeout=5000;')
    .catch(() => {}) // не критично: без неё — прежнее поведение
}

// Однократная диагностика конфигурации пула в проде (Vercel logs):
// видно, что параметры применились и к какому хосту идёт подключение.
if (process.env.NODE_ENV === 'production' && datasourceUrl && /^postgres/i.test(datasourceUrl)) {
  try {
    const u = new URL(datasourceUrl)
    const params = ['pgbouncer', 'connection_limit', 'pool_timeout', 'connect_timeout']
      .map((p) => `${p}=${u.searchParams.get(p) ?? '-'}`)
      .join(' ')
    console.log(`[db] pool: ${u.hostname}:${u.port || '5432'} ${params}`)
  } catch {
    /* диагностика не должна ломать старт */
  }
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
