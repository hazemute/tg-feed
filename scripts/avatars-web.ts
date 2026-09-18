/**
 * Бэкфилл аватарок ВСЕХ активных каналов через og:image со страниц t.me/s.
 *
 * Bot API для этого больше не нужен (и он душится флуд-банами) — каждая
 * веб-страница канала содержит <meta property="og:image"> с прямой ссылкой
 * на аватарку. Скачиваем байты → Supabase Storage (публичный бакет avatars) →
 * Channel.avatarUrl. Постоянные ссылки, долгий CDN-кэш, ноль Bot API.
 *
 * Запуск:  bun run scripts/avatars-web.ts [лимит] 
 * Лог:     scripts/avatars-web.log
 */

import { readFileSync } from 'node:fs'

// Явный override: песочница может подменять .env в shell — берём только файл
const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of envFile.split('\n')) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (!m) continue
  const value = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  process.env[m[1]] = value
}

import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'

const db = new PrismaClient()
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const BUCKET = 'avatars'

function storageHeaders(contentType?: string): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    ...(contentType ? { 'content-type': contentType } : {}),
  }
}

function ogAvatarOf(html: string): string | null {
  const m =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ??
    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/)
  if (!m) return null
  let url = m[1]
  if (url.startsWith('//')) url = `https:${url}`
  return url.startsWith('https://') ? url : null
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function syncOne(channelId: string, username: string): Promise<'ok' | 'same' | 'noimage' | string> {
  const res = await fetch(`https://t.me/s/${username}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return `HTTP ${res.status}`
  const html = await res.text()
  const imageUrl = ogAvatarOf(html)
  if (!imageUrl) return 'noimage'

  const img = await fetch(imageUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(12_000),
  })
  if (!img.ok) return `img HTTP ${img.status}`
  const buf = Buffer.from(await img.arrayBuffer())
  if (buf.length < 512 || buf.length > 400_000) return `size ${buf.length}`

  const hash = createHash('sha1').update(buf).digest('hex')
  const cur = await db.channel.findUnique({ where: { id: channelId }, select: { avatarHash: true } })
  if (cur?.avatarHash === hash) return 'same'

  const path = `c_${channelId}.jpg`
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      ...storageHeaders(img.headers.get('content-type') ?? 'image/jpeg'),
      'cache-control': 'public, max-age=604800, immutable',
      'x-upsert': 'true',
    },
    body: new Uint8Array(buf),
    signal: AbortSignal.timeout(15_000),
  })
  if (!up.ok) return `upload HTTP ${up.status}`

  await db.channel.update({
    where: { id: channelId },
    data: {
      avatarUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
      avatarHash: hash,
      avatarFetchedAt: new Date(),
    },
  })
  return 'ok'
}

async function main() {
  const limit = Number(process.argv[2] ?? '0') || Infinity
  const onlyMissing = process.argv.includes('--missing')

  const channels = await db.channel.findMany({
    where: { status: 'active', ...(onlyMissing ? { avatarUrl: null } : {}) },
    select: { id: true, username: true, avatarUrl: true },
    orderBy: { avatarUrl: 'asc' }, // сначала те, у кого аватарки нет
  })
  const targets = channels.slice(0, limit)
  console.log(`[avatars-web] цель: ${targets.length} каналов (из ${channels.length} активных)`)

  let ok = 0
  let same = 0
  let failed = 0
  const errors = new Map<string, number>()

  const CONCURRENCY = 3
  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      const ch = targets[cursor++]
      try {
        const r = await syncOne(ch.id, ch.username)
        if (r === 'ok') {
          ok++
          if (ok % 25 === 0) console.log(`[avatars-web] +${ok} загружено, ${same} без изменений, ${failed} ошибок (cursor ${cursor}/${targets.length})`)
        } else if (r === 'same') same++
        else if (r === 'noimage') {
          failed++
          errors.set('noimage', (errors.get('noimage') ?? 0) + 1)
        } else {
          failed++
          errors.set(r, (errors.get(r) ?? 0) + 1)
        }
      } catch (e) {
        failed++
        const key = String((e as Error)?.message ?? e).slice(0, 60)
        errors.set(key, (errors.get(key) ?? 0) + 1)
      }
      // вежливая пауза против rate-limit t.me
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  console.log(`[avatars-web] ГОТОВО: ${ok} загружено, ${same} уже были, ${failed} ошибок`)
  for (const [k, v] of [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`  - ${k}: ${v}`)
}

main()
  .catch((e) => {
    console.error('[avatars-web] фатально:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
