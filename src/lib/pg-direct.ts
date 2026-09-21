import { Client } from 'pg'

/**
 * Прямой (не pooler) URL Supabase для операции над prod-БД.
 * Приоритет: DIRECT_URL, иначе DATABASE_URL c -pooler→'' и 6543→5432.
 *
 * Внимание: новые проекты Supabase отдают прямой хост только по IPv6 —
 * из VercelFunctions он недоступен; для новых проектов используйте
 * pooler-хост из строки «Session pooler».
 */
export function directConnectionString(): string | null {
  const direct = process.env.DIRECT_URL
  if (direct) return direct
  const raw = process.env.DATABASE_URL
  if (!raw) return null
  return raw.replace('-pooler.', '.').replace(':6543', ':5432')
}

/**
 * Client с ручным парсингом URL: sslmode из connectionString перекрывает
 * ssl-объект pg и ломает соединение («self-signed certificate in chain»).
 */
export function pgClientFromUrl(cs: string, statementTimeout = 25_000): Client {
  const u = new URL(cs)
  return new Client({
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeout,
  })
}
