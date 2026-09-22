/**
 * ВРЕМЕННЫЙ E2E-СКРИПТ (Task 6-b) — удалить после проверки!
 *
 * Сквозной тест серверного хранения ИИ-картинок:
 *   generatePublicImage('cozy cat reading a book, warm light')
 *   → ожидаем via='upload', url='/api/upload/<id>', pending=false
 *   → GET http://localhost:3000/api/upload/<id> → 200, image/webp, ≤350КБ
 *   → скачиваем оригинал pollinations (тот же промпт+сид) для сравнения веса
 */
import { generatePublicImage, pollinationsImageUrl, enVisualPrompt, seedFromPrompt } from '@/lib/ai-image'
import { db } from '@/lib/db'

const PROMPT = 'cozy cat reading a book, warm light'
const OWNER = 'tg_777000' // qa_tester — реальная строка User (FK обязателен)

async function main() {
  const t0 = Date.now()

  // 1) Генерация (локально без OPENROUTER_API_KEY enVisualPrompt уйдёт в
  //    детерминированный фолбэк-промпт — путь хранения не меняется)
  const img = await generatePublicImage(PROMPT, { ownerId: OWNER })
  console.log('[1] generatePublicImage →', JSON.stringify(img), `(${Date.now() - t0}ms)`)

  if (img.via !== 'upload' || img.pending || !img.url) {
    console.error(`FAIL: ожидался via=upload, pending=false, url=/api/upload/<id>; получено via=${img.via} pending=${img.pending} url=${img.url}`)
    process.exit(1)
  }
  const m = img.url.match(/^\/api\/upload\/([a-zA-Z0-9_-]+)$/)
  if (!m) {
    console.error('FAIL: url не формы /api/upload/<id>:', img.url)
    process.exit(1)
  }
  console.log('[2] upload id:', m[1])

  // 2) Запись в БД
  const up = await db.upload.findUnique({ where: { id: m[1] }, select: { id: true, ownerId: true, mime: true, bytes: true, width: true, height: true, createdAt: true } })
  if (!up) {
    console.error('FAIL: записи Upload нет в БД')
    process.exit(1)
  }
  console.log('[3] Upload row:', JSON.stringify(up))

  // 3) HTTP через работающий dev-сервер (как его увидит миниаппа/TG)
  const res = await fetch(`http://localhost:3000${img.url}`)
  const ct = res.headers.get('content-type')
  const cc = res.headers.get('cache-control')
  const buf = Buffer.from(await res.arrayBuffer())
  console.log(`[4] GET ${img.url} → status=${res.status} content-type=${ct} bytes=${buf.length} (header content-length=${res.headers.get('content-length')}) cache-control=${cc}`)
  if (res.status !== 200 || ct !== 'image/webp' || buf.length > 350_000 || buf.length < 1024) {
    console.error('FAIL: http-проверка не прошла (200/image/webp/1КБ..350КБ)')
    process.exit(1)
  }

  // 4) Оригинал pollinations (тот же промпт+детерминированный сид) — вес до сжатия
  const en = await enVisualPrompt(PROMPT)
  const poll = pollinationsImageUrl(en, seedFromPrompt(en))
  console.log('[5] pollinations url:', poll)
  const t1 = Date.now()
  const pres = await fetch(poll, { signal: AbortSignal.timeout(120_000) })
  const pbuf = Buffer.from(await pres.arrayBuffer())
  console.log(`[6] оригинал pollinations → status=${pres.status} content-type=${pres.headers.get('content-type')} bytes=${pbuf.length} (${Date.now() - t1}ms)`)

  const saved = pbuf.length > 0 ? Math.round((1 - buf.length / pbuf.length) * 100) : 0
  console.log('=== SUMMARY ===')
  console.log(JSON.stringify({
    ok: true, id: up.id, url: img.url, ownerId: up.ownerId, mime: up.mime,
    webpBytes: buf.length, originalBytes: pbuf.length, savedPct: saved,
    width: up.width, height: up.height, cacheControl: cc, totalMs: Date.now() - t0,
  }, null, 2))
  await db.$disconnect()
  process.exit(0)
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e)
  process.exit(1)
})
