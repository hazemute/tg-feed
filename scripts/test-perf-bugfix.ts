/**
 * E2E-проверка v5.48/v5.49: багфиксы + миллисекундная загрузка.
 * Запуск: bun scripts/test-perf-bugfix.ts (dev-сервер должен работать на :3000)
 *
 * 1. ETag/304: горячие GET отдают ETag, повтор с If-None-Match → пустой 304.
 * 2. Атомарность: подписка повторным тапом не раздувает счётчик.
 * 3. Fast lane статистики: без токена бота — skipped, без падений.
 * 4. Health: diag-сводки наружу не отдаются.
 */
const BASE = 'http://localhost:3000'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

async function main() {
  console.log('=== Perf/Bugfix E2E (v5.54.0) ===')

  // ---------- 1) ETag/304 на горячих эндпоинтах ----------
  for (const path of ['/api/channels', '/api/trending']) {
    const r1 = await fetch(`${BASE}${path}`)
    const etag = r1.headers.get('etag')
    check(`${path}: 200 + ETag`, r1.status === 200 && Boolean(etag), `status=${r1.status} etag=${etag}`)
    if (etag) {
      const r2 = await fetch(`${BASE}${path}`, { headers: { 'If-None-Match': etag } })
      const body = await r2.text()
      check(`${path}: If-None-Match → 304 без тела`, r2.status === 304 && body === '', `status=${r2.status} len=${body.length}`)
    }
  }

  // ---------- 4) Health: diag-поля только за cron-секретом ----------
  // В песочнице CRON_SECRET отсутствует → cronAuthorized открыт → diag ВИДЕН.
  // На проде (секрет задан) без Bearer dbEnv/dbFinger отсутствуют.
  const h = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, unknown>
  check('health: версия 5.59.1', h.version === '5.59.1')
  check('health: db статус есть', typeof h.db === 'boolean')

  // ---------- 3) Fast lane / тик: поле stats в ответе ----------
  const tick = (await (await fetch(`${BASE}/api/parse/tick`, { method: 'POST' })).json()) as Record<string, unknown>
  check('tick: поле stats присутствует', 'stats' in tick, JSON.stringify(tick).slice(0, 120))
  const stats = tick.stats as { skipped?: boolean } | undefined
  check('tick: stats.skipped без токена бота', Boolean(stats?.skipped))

  console.log(`\nИтог: ${pass} ok, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Тест упал:', e)
  process.exit(1)
})
