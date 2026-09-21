/**
 * Одноразовый E2E-скрипт (стерилизуется после): тестовые каналы RU/EN + посты +
 * юзер + подписанный токен сессии для agent-browser.
 */
import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const db = new PrismaClient()

function getSecret(): string {
  const explicit = process.env.AUTH_SECRET?.trim()
  if (explicit) return explicit
  const parts = [process.env.TELEGRAM_BOT_TOKEN ?? '', process.env.CRON_SECRET ?? '']
    .filter(Boolean)
    .join('|')
  return crypto.createHash('sha256').update(`tgfeed-session|${parts}`).digest('hex')
}
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function signSession(uid: string, guest: boolean, ttlSec = 30 * 24 * 3600): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ uid, guest, iat: now, exp: now + ttlSec }))
  const sig = b64url(crypto.createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${sig}`
}

const MARK = 'langE2E'

async function main() {
  const cat = await db.category.findFirst({ orderBy: { order: 'asc' } })
  if (!cat) throw new Error('нет категорий')

  const [ru, en] = await Promise.all([
    db.channel.upsert({
      where: { username: `e2e_ru_${MARK}` },
      create: {
        tgId: `e2e_ru_${MARK}`, username: `e2e_ru_${MARK}`, title: 'E2E Русский канал',
        description: 'тест', categoryId: cat.id, status: 'active',
      },
      update: { status: 'active' },
    }),
    db.channel.upsert({
      where: { username: `e2e_en_${MARK}` },
      create: {
        tgId: `e2e_en_${MARK}`, username: `e2e_en_${MARK}`, title: 'E2E English channel',
        description: 'test', categoryId: cat.id, status: 'active',
      },
      update: { status: 'active' },
    }),
  ])

  const posts = [
    ['ru1', ru.id, 'Привет! Это русский пост про технологии и нейросети 🚀'],
    ['ru2', ru.id, 'Второй русский пост — лента должна показывать его в фильтре «Русский»'],
    ['en1', en.id, 'Hello world! This post is written in English for the language filter test'],
    ['en2', en.id, 'Another English post about design and product development'],
  ]
  for (const [k, channelId, text] of posts) {
    await db.post.upsert({
      where: { tgKey: `e2e_${MARK}:${k}` },
      create: {
        tgKey: `e2e_${MARK}:${k}`, channelId, text,
        mediaType: 'none', publishedAt: new Date(Date.now() - 3_600_000),
      },
      update: { text },
    })
  }

  const uid = 'tg_990000001'
  await db.user.upsert({
    where: { id: uid },
    create: { id: uid, username: `e2e_${MARK}`, firstName: 'E2E', isGuest: false, categories: '[]' },
    update: { isGuest: false },
  })

  const token = signSession(uid, false)
  console.log('TOKEN=' + token)
}

main().finally(() => db.$disconnect())
