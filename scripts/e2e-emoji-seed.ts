/**
 * Одноразовый E2E-скрипт (стерилизуется после): канал + пост со всеми тремя
 * типами маркеров премиум-эмодзи (e:/ev:/el:) + юзер + токен сессии.
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

const MARK = 'emojiE2E'

async function main() {
  const cat = await db.category.findFirst({ orderBy: { order: 'asc' } })
  if (!cat) throw new Error('нет категорий')

  const ch = await db.channel.upsert({
    where: { username: `e2e_${MARK}` },
    create: {
      tgId: `e2e_${MARK}`, username: `e2e_${MARK}`, title: 'E2E Эмодзи канал',
      description: 'тест', categoryId: cat.id, status: 'active',
    },
    update: { status: 'active' },
  })

  // Реальные ID из t.me/s/durov + статичные thumb-картинки telegram.org
  const text = [
    'Пост со всеми типами премиум-эмодзи:',
    '',
    '1. Статичный с ID: ![e:5260293700088511294](https://telegram.org/img/emoji/40/E29B94.png)',
    '2. Видео-стикер: ![ev:5240241223632954241](https://telegram.org/img/emoji/40/F09F9AAB.png)',
    '3. Lottie: ![el:5460865451586250451](https://telegram.org/img/emoji/40/F09FA9B5.png)',
    '4. Обычный юникод: 🔥🚀💯',
    '',
    'Конец поста — проверяем, что маркеры не ломают текст.',
  ].join('\n')

  await db.post.upsert({
    where: { tgKey: `e2e_${MARK}:1` },
    create: {
      tgKey: `e2e_${MARK}:1`, channelId: ch.id, text,
      mediaType: 'none', publishedAt: new Date(Date.now() - 1_800_000),
    },
    update: { text },
  })

  const uid = 'tg_990000002'
  await db.user.upsert({
    where: { id: uid },
    create: { id: uid, username: `e2e_${MARK}`, firstName: 'E2E', isGuest: false, categories: '[]' },
    update: { isGuest: false },
  })

  console.log('TOKEN=' + signSession(uid, false))
}

main().finally(() => db.$disconnect())
