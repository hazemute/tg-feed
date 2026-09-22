/**
 * ВРЕМЕННЫЙ тест-скрипт (Task 6-b) — потом удалить.
 * Прогоняет generatePublicImage напрямую: pollinations → sharp → Upload.
 * Проверяем: вернулся /api/upload/<id>, размер ≤350КБ, mime webp.
 */
import { db } from '@/lib/db'
import { generatePublicImage, pollinationsImageUrl } from '@/lib/ai-image'

async function main() {
  const user = await db.user.findUnique({ where: { id: 'tg_777000' }, select: { id: true } })
  const ownerId = user?.id ?? (await db.user.findFirst({ select: { id: true } }))?.id
  if (!ownerId) throw new Error('нет юзера в БД')

  const prompt = 'a cozy coffee shop on a rainy evening, warm lights, cinematic photo'
  console.log('[1] generating for prompt:', prompt)
  const t0 = Date.now()
  const img = await generatePublicImage(prompt, { ownerId })
  console.log('[1] result:', img, `(${Date.now() - t0}ms)`)

  if (img.via === 'upload' && img.url) {
    const id = img.url.split('/').pop() as string
    const row = await db.upload.findUnique({ where: { id }, select: { mime: true, bytes: true, width: true, height: true } })
    console.log('[2] Upload row:', row)
    console.log('[2] size check ≤350КБ:', (row?.bytes ?? 0) <= 350 * 1024 ? 'OK' : 'FAIL')
  } else {
    console.log('[2] FALLBACK to pollinations (download/store failed):', img.url)
  }

  // Кэш: повторный вызов того же промпта — мгновенно и тот же URL
  const t1 = Date.now()
  const img2 = await generatePublicImage(prompt, { ownerId })
  console.log(`[3] cache hit: ${img2.url === img.url ? 'SAME URL' : 'DIFFERENT!'} (${Date.now() - t1}ms)`)

  // Оригинал pollinations для визуального сравнения (HEAD размер)
  const poll = pollinationsImageUrl(prompt, 1)
  const head = await fetch(poll, { method: 'HEAD', signal: AbortSignal.timeout(45_000) }).catch(() => null)
  console.log('[4] pollinations HEAD:', head?.status, head?.headers.get('content-length'), 'bytes (оригинал для сравнения)')
}

main()
  .catch((e) => {
    console.error('FAIL:', e)
    process.exit(1)
  })
  .finally(() => process.exit(0))
