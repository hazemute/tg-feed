/**
 * E2E-проверка v5.61 на локальном API: обмен 100 000 свайпов должен дать
 * 200,00 ₽ (balanceKop 20000), а не 2 ₽. И обратный обмен без потерь курса.
 * Запуск: bun scripts/test-wallet-e2e.ts  (dev-сервер должен быть на :3000)
 */
import crypto from 'crypto'

const BASE = 'http://127.0.0.1:3000'
const UID = 'tg_777000'

/** Тот же алгоритм, что src/lib/session.ts (dev-фолбэк секрета) */
function signSession(uid: string, guest: boolean): string {
  const secret = crypto.createHash('sha256').update('tgfeed-session|').digest('hex')
  const now = Math.floor(Date.now() / 1000)
  const payload = { uid, guest, iat: now, exp: now + 30 * 24 * 60 * 60 }
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(payload)
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${head}.${body}.${sig}`
}

async function api(path: string, opts: RequestInit = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
  })
  const j = (await res.json()) as Record<string, unknown>
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(j).slice(0, 200)}`)
  return j
}

const TOKEN = signSession(UID, false)

async function main(): Promise<void> {
  // 1. Пользователь с 100 000 свайпов и 0 рублей
  const set = await api('/api/panel/users', {
    method: 'PATCH',
    headers: { 'x-admin-key': 'dev-admin' },
    body: JSON.stringify({ userId: UID, action: 'swipes', swipes: 100000 }),
  }).catch(() => null)
  console.log('panel swipes:', set ? 'ok' : 'panel недоступен локально (ок)')

  const db = await import('../src/lib/db').then((m) => m.db)
  await db.user.upsert({
    where: { id: UID },
    update: { swipes: 100000, balanceKop: 0 },
    create: { id: UID, swipes: 100000, balanceKop: 0, categories: '[]' },
  })

  // 2. Обмен всех свайпов в рубли
  const before = await api('/api/wallet')
  console.log(`до: swipes=${before.swipes} balanceKop=${before.balanceKop}`)

  const conv = await api('/api/wallet', {
    method: 'POST',
    body: JSON.stringify({ action: 'swp2rub', amount: 100000 }),
  })
  console.log(`после обмена: balanceKop=${conv.balanceKop} swipes=${conv.swipes}`)

  const okKop = conv.balanceKop === 20000 // 200 ₽ = 20 000 копеек
  const okSwp = conv.swipes === 0
  console.log(`${okKop ? 'PASS' : 'FAIL'}  100 000 свайпов → ${conv.balanceKop} коп (ожидалось 20000 коп = 200 ₽)`)
  console.log(`${okSwp ? 'PASS' : 'FAIL'}  свайпы списаны полностью (${conv.swipes})`)

  // 3. Обратный обмен 2 ₽ → свайпы (1 копейка = 5 свайпов → 200 коп = 1000 свайпов)
  const back = await api('/api/wallet', {
    method: 'POST',
    body: JSON.stringify({ action: 'rub2swp', amount: 20000 }),
  })
  const okBack = back.swipes === 100000
  console.log(`${okBack ? 'PASS' : 'FAIL'}  20000 коп → ${back.swipes} свайпов (ожидалось 100000)`)

  // 4. История операций отражает обе конвертации
  const after = await api('/api/wallet')
  const hist = (after.history as Array<{ kind: string; currency: string; amount: number }>) ?? []
  const convLog = hist.filter((h) => h.kind === 'convert')
  console.log(`журнал: ${convLog.length} конвертаций в истории`)

  // уборка
  await db.user.update({ where: { id: UID }, data: { swipes: 0, balanceKop: 0 } })

  if (okKop && okSwp && okBack) {
    console.log('\nE2E: всё верно — курс 500 свайпов = 1 ₽ соблюдён в обе стороны')
  } else {
    console.error('\nE2E: ЕСТЬ ОШИБКИ')
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('E2E failed:', e.message)
  process.exit(1)
})
